/**
 * outbound.js —— 回复发回 QQ（自动转发）。
 *
 * 出站队列：会话 id → 待转发队列 [{ agent, cursor, target }]。
 *
 * 必须是队列而不是单条覆盖：同一个会话短时间内被连续投递两条消息时，
 * 后一次 set 会把前一次的 cursor 直接盖掉 —— 前一回合的 turn/end 从此落在游标之前，
 * 它的回复就永远不转发了（低概率但真实：群聊连 @ 两条、或上一回合刚好在
 * flushOutbound 两次扫描的间隙里结束）。另外两个 QQ 号绑同一个会话时，
 * target 也会被后投递的一方盖掉，回复发错人。队列逐条消化，两个问题一起没了。
 *
 * ⚠️ 队列条目**不能只靠 cursor 定位回合**（2026-10-28 修的大坑）：
 *   cursor 是「投递那一刻的 session.seq」，而 agent 跑回合期间 session.seq **不推进**。
 *   所以「没等她发完就发下一条」时，两条消息拿到的 cursor **完全相同**：
 *     条目A(cursor=10) 找到 turn/end(13) → 发出去，cursor 推到 13
 *     条目B(cursor=10) cursor 没动 → 下一轮又找到 turn/end(13) → **同一条回复再发一遍**
 *   连发 N 条 = 同一条回复发 N 遍（实测「连续发了好几遍」）。
 *
 *   修法：条目记住**自己那条 user/message 的 seq**（`userSeq`），
 *   靠「我这条用户消息之后、下一个 turn/end」来定位属于我的回合。
 *   两条消息合进同一回合时，两条 user/message 都在那个回合之前 →
 *   认到同一个 turn/end → 用 `sentTurnEnds` 集合保证那个回合只发一次。

 * ── 段落索引（找哪段直接搜函数名）──
 *
 * 出站主链路
 *   sendToQQ()          总入口：去重、审计、静默判定、追问武装都在这里
 *   sendOneToQQ()       真正发一条出去（分段、表情段拼接）
 *   splitAtMarkers()    按标记把一条回复切成多条
 *
 * 队列（回复 → 待转发）
 *   enqueueOutbound()   入队
 *   flushOutbound()     每秒扫一次，等 turn/end；超时日志就是这里打的
 *   maxEventSeq()       取游标
 *   clearOutbound()     卸载时清队列，返回丢弃了几个会话
 *
 * 「这句不该发出去」的判据
 *   isStageDirection()  整条是圆括号包起来的舞台说明
 *   isSilenceStub()     只有一两个字、内容等于「我不说话」
 *   dropAsSilence()     静默处理（抽成函数是为了测试能直接盯这条）
 *   scrubLocalPaths()   抹本机路径（不拒发，替换成占位符）
 *
 * 取消窗口
 *   markCancelled() / clearCancelled() / hasPendingAllowOne() / isCancelled()
 *
 * 其他
 *   targetKeyOf()       目标 → key（群和私聊分开算）

 */
import { getConfig } from './config.js'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { armFollowup } from './followup.js'
import { isMuted } from './mute.js'
import { noteSaid } from './recent-say.js'
import { reviewEvidenceOf } from './review-evidence.mjs'
import { note } from './env.js'
import { consumeSuppress, targetKey, isStageOnly, incomingAgeMs } from './rhythm.js'
import { DeadLetterBox, dequeueOnce, newDequeueState, personKeyOf, resolveSendTarget } from './target.js'
import { 记录死信 } from './deadletter.js'
// REALTIME 2026-11-12：回合结束的挂点（实时模式下她自己接着做）
import { 回合结束 as 实时回合结束, 聊天续话仍有效 } from './实时续跑.js'
import { receiptStore } from './receipt-store.mjs'
import { isProactiveTurnClosed } from '../receipt-transaction.mjs'

/**
 * 这条回复该不该当成「她其实没开口」而不发出去。
 * 2026-11-04 加：整条只有旁白/动作（「（报了。）」「（本轮不发）」「（尾巴摆了摆）」）
 * 就没有信息量，发出去用户只会觉得莫名其妙。
 *
 * 但带媒体标记的不能丢——「[表情:猫猫]」应该由表情链变成真表情。
 * 抽成函数是为了让测试直接盯这条判据，别只靠发送路径里的内联条件。
 */
export function dropAsSilence(text) {
  const raw = String(text ?? '')
  if (!isStageOnly(raw)) return false
  if (/\[表情|\[CQ:|\[图片|\[file/.test(raw)) return false
  // 空串/纯空白仍然当沉默（round7 的边界用例）
  if (raw.trim().length === 0) return true
  // STAGE_ALL 2026-11-06（批次115）：回到一刀切 —— 整条只剩括号，就是舞台说明，不发。
  //
  // 2026-11-05 那次软化（改成只拦「自述沉默/不接话」那几个关键词）方向是错的。
  // 当时的顾虑是「她连（脸红）都说不出来」，但代价是任何新写法的旁白都能漏出去：
  // 11-05 16:44 她说「（贴了个爱心，这回不打字了）」——「不打字」不在词表里，
  // 整句原样发进群，主人当场回「又把心里话打出来了」。
  // 白名单永远追不上她的写法。括号里的话本来也不是说给人听的：
  // 想说脸红，她有一整句中文可以用；想贴表情，有 qq_face 工具。
  // 判据回到最干净的一条：strip 掉括号后一个字都不剩 = 不是话。
  return true
}

/**
 * 疑似思考泄漏 —— 模型把内心推演写成了正文发出来。
 *
 * LEAK_GUARD 2026-11-12（批次366）：上游中转站会**偶发**把思考文本同时写进
 * thinking 块和 text 块（实测同一段文字 119 字一字不差地出现在两个块里）。
 * 宿主据此把 text 块记成「她这一轮说的话」，自动转发就原样发到 QQ。
 * 2026-11-12 22:46–22:55 连发 4 条英文自言自语、最长 1488 字，就是这条路。
 *
 * 判据收得极窄，只认两条：足够长、几乎没有中文。
 * 她平时说中文口语，13 天 3007 条助手消息里同时满足这两条的只有 4 条，
 * 全是这次泄漏；中文夹大段代码那种（中文占比 12%）不会被误伤。
 * 窄判据的代价是「她真的用英文写长回复」会被拦 —— 那种情况她可以用 qq_send 发，
 * 而且会被日志记下来，不是静默丢。
 */
export function 疑似思考泄漏(text) {
  const t = String(text ?? '').trim()
  if (!t) return false
  const 中文字 = (t.match(/[\u4e00-\u9fff]/g) || []).length
  const 英文词 = (t.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length
  // 一、批次366 原判据：够长、几乎没有中文
  if (t.length >= 120 && 中文字 < 8) return true
  // 一之二、批次372b：30 字符以上的纯英文也拦。
  //     2026-11-13 20:14 她发了 "He wants another voice sample. Send a third one."（重复两遍，
  //     86 字符、0 中文），卡在 120 字符门槛下被放过去了。她对中文用户不会说这么长的纯英文。
  if (中文字 === 0 && t.length >= 30) return true
  // 二、批次372：英文动词直接跟工具名 —— "call qq_send"、"use qq_photo"。
  //     这是「我准备去调它」的独白。她向主人汇报时会写裸的 qq_xxx 或代码块，
  //     不会用英文动词去调（第一版只认「出现 qq_*」，把这类正常汇报误伤了）。
  if (/\b(?:call|use|invoke|run|send)\s+qq_[a-z_]+/i.test(t)) return true
  // 三、批次372：英文第一人称自言自语。
  //     2026-11-13 20:0x 三连发："I need to actually send now"、"Let me call…"、
  //     "My previous two turns produced nothing"；以及 19:5x "Nothing pending. Call qq_pass."
  if (英文词 >= 6 && /(?:\bI (?:need|should|have|will|'ll|'m|don[’']?t|can[’']?t)|\bLet me\b|\bMy previous\b|\bHe (?:said|says|is|'s)\b|\bNothing pending\b|\bKeep (?:it|under)\b)/i.test(t)) {
    return true
  }
  // 四、批次372：大段英文自言自语里夹中文台词（三连发就是这种：英文 60 词、中文 55 字，
  //     中文占比 20%，"几乎没有中文"不成立）。
  //     按「英文虚词」数而不是「英文词」数：文件路径会切出大量词，但里面没有 the/is/to/of，
  //     用它区分「英文句子」和「中文消息里嵌路径」。
  const 英文虚词 = (t.match(/\b(?:the|is|was|are|were|be|been|am|to|of|and|that|this|these|it|its|my|his|her|he|she|you|we|they|with|for|but|not|did|does|done|have|has|had|will|would|should|could|what|why|how|when)\b/gi) || []).length
  if (英文虚词 >= 8) return true
  return false
}
import { deliverOneBot, DELIVERY_REJECTED } from './onebot.js'
import { latencyAdjustedPartDelayMs, partDelayMs, splitMessage } from './split.js'
import { splitEmojiMarksAsync, attachFacesToParts } from './emoji-mark.js'
import { assertClean } from './sensitive.js'
import { existsSync, readFileSync } from 'node:fs'
import { traitCoeff } from './性格系数.mjs' // METER 2026-11-04：三份内联副本收拢到一处




// 批次610：删除 applySelfCorrection（2026-11-01 的「改口」）。
// 它从未被任何地方调用；而且是一套固定尾巴（「不对，」「说反了，」）加随机改数字，
// 既不会真的让话更可信，也违背拟人化红线（代码替她说话）。要改口让她自己改。

export const outbound = new Map()

export function typingDelayMs(body, random = Math.random) {
  const len = [...body].length
  const sentenceEnds = (body.match(/[。！？!?…]/g) || []).length
  const lineBreaks = body.split(String.fromCharCode(10)).length - 1
  const commas = (body.match(/[，,；;、]/g) || []).length
  let params = {}
  try {
    for (const path of [`${QQ_WS}/共享/工具/参数.json`, 'B:/肥鱼/工具/参数.json']) {
      if (!existsSync(path)) continue
      const parsed = JSON.parse(readFileSync(path, 'utf8'))
      params = { ...(parsed?.['阈值'] || {}), ...(parsed?.['拟人'] || {}) }
      break
    }
  } catch { /* 参数表读不到就用默认阈值 */ }
  const T = (key, fallback) => Number.isFinite(Number(params[key])) ? Number(params[key]) : fallback
  let cps = T('打字_cps基准', 8)
  if (len > 80) cps += 1.5
  cps = Math.max(T('打字_cps下限', 4.5), Math.min(T('打字_cps上限', 16), cps * traitCoeff('typingSpeed')))
  const think = 300 + random() * 260
  const typing = (len / cps) * 1000
  const nodePause = sentenceEnds * (260 + random() * 340)
    + lineBreaks * (140 + random() * 180)
    + commas * (50 + random() * 70)
  return Math.round(Math.max(T('打字_下限毫秒', 650), Math.min(T('打字_上限毫秒', 6500), think + typing + nodePause)))
}

export function 可发送续话(record) {
  if (!record.guardToken) return true
  const config = getConfig()
  const ttl = (Number(config.outboundEntryTtlMs) || 150000) + (Number(config.outboundEntryTtlGraceMs) || 60000)
  if (Date.now() >= record.stagedAt + ttl) return false
  const queue = outbound.get(record.sessionId) || []
  return 聊天续话仍有效({ sessionId: record.sessionId, target: record.target, guardToken: record.guardToken,
    receiptToken: record.token, queue, agent: queue[0]?.agent, sourceMessageId: record.sourceMessageId })
}

export function sweepProactiveOutbound(config = getConfig(), now = Date.now()) {
  const ttlMs = (Number(config.outboundEntryTtlMs) || 150000) + (Number(config.outboundEntryTtlGraceMs) || 60000)
  for (const [sessionId, queue] of outbound) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const entry = queue[index]
      if (!entry.proactiveReceiptToken) continue
      try {
        const record = receiptStore.record(entry.proactiveReceiptToken)
        if (record?.status === 'pending') {
          const closed = isProactiveTurnClosed(entry.agent?.session, record)
          if (!closed && !entry.dropped && now < record.stagedAt + ttlMs && 可发送续话(record)) continue
          // QUIET_BACKOFF 2026-11-24：她没开口就别每 15 分钟再来一次。
          // 连续空转的冷却 15 分钟 × 2^n，封顶 4 小时。
          const 空转次数 = typeof receiptStore.quietStreak === 'function' ? receiptStore.quietStreak(record.target, now, record.token) : 0
          const 冷却 = Math.min(4 * 3600e3, 15 * 60e3 * Math.pow(2, Math.min(空转次数, 5)))
          receiptStore.cancelNotSent({ ...record, now, cooldownMs: 冷却 })
          entry.agent?.inbox?.remove?.(record.sourceMessageId)
          // PROACTIVE_QUIET 2026-11-24: 她这一轮选择 qq_pass / 没开口，回执被取消时
          // lastProactiveAt 一直不推进 —— 冷却 15 分钟一到就再烧一整轮 28k 上下文，
          // 一晚上几十轮一句也没发出去。这里把「这次主动尝试」记上。
          if (closed && !entry.dropped && record.target) {
            const key = `${record.target.kind}:${record.target.id}`
            import('./proactive.js').then((m) => m.noteNudge(key, now)).catch(() => {})
          }
        }
        if (record?.guardToken && record.status === 'sending' && now < record.stagedAt + ttlMs) continue
        if (record && (record.status === 'not-sent' || entry.dropped || now >= record.stagedAt + ttlMs)) {
          try { entry.agent?.inbox?.remove?.(record.sourceMessageId) } catch { /* 账本已拒绝后续发送 */ }
        }
        queue.splice(index, 1)
      } catch (error) {
        note('out', `主动搭话回执收尾待重查：${error instanceof Error ? error.message : error}`)
      }
    }
    if (queue.length === 0) {
      outbound.delete(sessionId)
      sessionStates.delete(sessionId)
      sentTurnEnds.delete(sessionId)
    }
  }
}

/**
 * 出站死信（批次 602B）。
 *
 * 发送失败的消息原来只留一行日志，用户侧表现成「她突然不理我」。
 * 这里保留最近 50 条正文/目标/错误，面板或排障脚本可以补发；
 * 进程内存储，重启即清空 —— 先保证「看得到」，持久化等下一批。
 */
export const outboundDeadLetters = new DeadLetterBox(50)

/**
 * 已经转发过的回合（按 sessionId + turn/end 的 seq 记）。
 *
 * 同一个回合被两个条目认到时，只发一次 —— 第二个条目直接跳过，
 * 但**不能出队丢掉**：它那条消息的回复已经在第一个条目发出去了，
 * 丢掉只是不重复发；留着则下一轮还会再撞一次同一个回合。
 *
 * ⚠️ 生命周期必须跟着队列走（2026-10-28 修）：
 *   早先这个 Map 只增不减，长跑几天后每个会话攒下几千个 seq，纯内存泄漏。
 *   而且它记的是**某个 seq 空间里的位置** —— 会话重连 / 冷启动后 seq 空间会变，
 *   旧记录留着只会误判（把新回合当成「已发过」直接跳过，回复就悄悄没了）。
 *   现在队列清空时一起清掉：没人排队时，这份记录没有任何用处。
 */
const sentTurnEnds = new Map()

/** 单会话最多记多少个已发回合（队列长期不空时的兜底上限）。 */
const SENT_TURNS_LIMIT = 500

/** 某会话已经发过的 turn/end 集合（懒建）。 */
function sentTurnsOf(sessionId) {
  let set = sentTurnEnds.get(sessionId)
  if (set === undefined) {
    set = new Set()
    sentTurnEnds.set(sessionId, set)
  }
  return set
}

/** 记一个已发回合，并维持集合上限（Set 保插入序，超了就丢最早的）。 */
function markSentTurn(sessionId, endSeq) {
  const set = sentTurnsOf(sessionId)
  set.add(endSeq)
  while (set.size > SENT_TURNS_LIMIT) {
    const oldest = set.values().next().value
    if (oldest === undefined) break
    set.delete(oldest)
  }
}

/**
 * 某会话的「认领状态」：
 *   · matchCursor      —— 已经扫到哪了（用于增量收集 user/message）
 *   · pendingUserSeqs  —— 收集到但还没被队列条目认领的 user/message 的 seq
 *
 * 为什么要这个：队列条目要认领「属于自己的那条 user/message」，
 * 才能定位到真正回答它的那一回合（见 flushOutbound 的注释）。
 */
const sessionStates = new Map()

function sessionState(sessionId) {
  let state = sessionStates.get(sessionId)
  if (state === undefined) {
    // matchCursor 的初值在入队时按「第一个条目的 cursor」定（见 enqueueOutbound），
    // 这样收集范围刚好从本次投递开始，不会把更早的 user/message 也捞进来。
    state = { matchCursor: 0, pendingUserSeqs: [] }
    sessionStates.set(sessionId, state)
  }
  return state
}

/**
 * 往会话的待转发队列尾部追加一条。
 *
 * createdAt（2026-10-28）用于「回合超时」：见 flushOutbound 里的 stale 判断。
 * 没有它的话，turn/end 永远不来（DSH 崩了 / 会话被手动中断 / 回合被丢弃）时，
 * 这个条目会一辈子卡在队头，把后面所有转发全堵死 —— 表现是「她突然不回话了」，
 * 而且日志里一片安静，根本查不出来。
 */
export function enqueueOutbound(sessionId, agent, cursor, target, options) {
  const entry = {
    agent, cursor, target, userSeq: null, createdAt: Date.now(),
    // 上下文没就绪时用它把这条消息重新投给会话（见 deliver.js 里的 redeliver）
    redeliver: typeof options?.redeliver === 'function' ? options.redeliver : undefined,
    // 主动搭话投进去的回合：这类回合里「只回动作」要按沉默处理（见下面 flushOutbound）
    proactive: options?.proactive === true,
    proactiveReceiptToken: options?.proactiveReceiptToken,
  }
  const queue = outbound.get(sessionId)
  if (queue !== undefined) queue.push(entry)
  else {
    outbound.set(sessionId, [entry])
    // 队列刚建：把收集起点定在第一个条目的 cursor，
    // 免得把「本次投递之前」的老 user/message 也收集进来（那些对应更早的、已处理的消息）。
    const state = sessionState(sessionId)
    if (state.matchCursor === 0) state.matchCursor = Number(cursor) || 0
  }
}

/**
 * 丢掉某个会话队列里「还没发出去」的回复（2026-10-31，用户要「喊停就停」）。
 *
 * 为什么这么加：主人喊「别找了 / 算了 / 取消」时，正在跑的那一轮停不下来
 * （桥没有中止回合的口子），但它跑完的结果不该再发出来。
 * 做法：把队列里现有条目全标成丢弃，flushOutbound 看到就出队、不发。
 * 代价：那一轮白算——这是「立刻停」必须付的钱，写在日志里让人知道。
 */
export function dropPendingReplies(sessionId) {
  const queue = outbound.get(sessionId)
  if (queue === undefined || queue.length === 0) return 0
  const n = queue.length
  for (const entry of queue) entry.dropped = true
  note('out', `${sessionId} 收到「停」：队列里 ${n} 条回复标记为丢弃`)
  return n
}

/** 清空所有待发队列（测试用）。 */
/** 清空所有待发队列（测试用）。 */
/**
 * 卸载前取一份「还没等到回复的回合」快照。
 *
 * UNLOAD_TRACE 2026-11-16（批次526）：重启会掐断正在跑的回合，那条回复永远发不出去。
 * 以前日志里只有一句「已丢弃」，事后不知道丢的是谁、哪一刻 —— 05:04 那次（主人说
 * 「你不用搞了」、她正在跑 14 条 bash 被我重启掐断）就是靠翻会话才还原的。
 */
export function 取待发快照() {
  const 出 = []
  try {
    for (const [sessionId, queue] of outbound) {
      for (const e of Array.isArray(queue) ? queue : []) {
        出.push({
          sessionId: String(sessionId),
          kind: String(e?.target?.kind ?? ''),
          id: String(e?.target?.id ?? ''),
          投递于: Number(e?.createdAt) || 0,
          主动: e?.proactive === true,
        })
      }
    }
  } catch { /* 快照失败不影响卸载 */ }
  return 出
}

export function clearOutbound() {
  const dropped = outbound.size
  outbound.clear()
  sentTurnEnds.clear()
  sessionStates.clear()
  cancelWindows.clear()
  return dropped // 2026-11-05：返回丢弃了几个会话，卸载时记一笔，省得只剩一句「等 30s 没等到」
}

// ── 取消窗口（2026-10-31 肥鱼加）──────────────────────────────
// 为什么需要：用户喊「别找了/取消」时，机器人那一轮往往还在跑，新消息只能排队，
// 于是她照样把活干完、把图发出来。插件层没有掐回合的接口（宿主是打包的），
// 所以退一步用时间窗口兜：收到取消词立刻回一句「停了」，随后 60 秒内她发往
// 同一目标的出站内容全部丢弃。看着就是真停住了。
// 代价：窗口里的那几轮白算（token 照花）；窗口过期自动恢复，不会永久哑掉。
const cancelWindows = new Map()

/** 目标统一成 key：群和私聊分开算，免得取消一个群把私聊也静默了。 */
export function targetKeyOf(target) {
  if (target === null || target === undefined) return ''
  const kind = target.kind === 'group' ? 'group' : 'private'
  return `${kind}:${String(target.id ?? '')}`
}

/** 标记某个目标进入取消窗口（调用方负责先回一句「停了」）。 */
export function markCancelled(key) {
  const k = String(key ?? '')
  if (k === '') return
  // 2026-11-01 肥鱼：放行第一句话让模型自己收尾，之后的才丢
  cancelWindows.set(k, { until: Date.now() + 60000, allowOne: true })
  note('out', `取消窗口开启：${k}（放行一句收尾，其余丢弃）`)
}

/**
 * 解除取消窗口（2026-10-31 大肥鱼）。
 * 为什么要有：肥鱼问的那个真问题——喊完停立刻改口说「接着做」，
 * 60 秒窗口会把她自己的回复也静默掉。所以只要来了一条不是取消词的新消息，
 * 就把窗口撤掉，恢复正常出站。
 */
export function clearCancelled(key) {
  const k = String(key ?? '')
  if (k === '') return false
  const had = cancelWindows.delete(k)
  if (had) note('out', `取消窗口撤销：${k}（来了新消息，恢复正常）`)
  return had
}

/**
 * 取消窗口里还有没有「放行一句」没用掉（2026-11-04 加）。
 *
 * 为什么需要：喊停时会同时开 90 秒 mute 和 60 秒取消窗口，而 MUTE_GUARD 在 isCancelled 之前，
 * 于是那句「让她自己收尾」的放行在物理上永远发不出去，用户看到的是「喊停之后彻底没声」。
 * mute 拦之前先问一句：这一句是不是窗口答应放行的那一句？
 */
export function hasPendingAllowOne(key) {
  const entry = cancelWindows.get(String(key ?? ''))
  if (entry === undefined || typeof entry === 'number') return false
  return entry.allowOne === true && Date.now() <= Number(entry.until || 0)
}

/** 这个目标现在是不是在取消窗口里。 */
export function isCancelled(key) {
  const k = String(key ?? '')
  if (k === '') return false
  const entry = cancelWindows.get(k)
  if (entry === undefined) return false
  if (typeof entry === 'number') {
    if (Date.now() > entry) { cancelWindows.delete(k); return false }
    return true
  }
  if (Date.now() > entry.until) {
    cancelWindows.delete(k)
    note('out', `取消窗口已过期：${k}`)
    return false
  }
  if (entry.allowOne) {
    entry.allowOne = false
    note('out', `取消窗口放行一条（${k}）`)
    return false
  }
  return true
}


const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 把正文里的 [[at:QQ号]] 拆成 at 段（2026-10-31 肥鱼加）。
 *
 * 为什么这么加：qq_send 以前只能发纯文本，正文里写 [CQ:at,qq=x] 会被当成普通文字原样发出去，
 * 群里根本 @ 不到人。这里照 dsh-world 的约定用 [[at:QQ号]] 这种标记，
 * 发送前拆成 {type:'at',data:{qq}} 段，和文字混在同一条消息里发。
 * 没有标记时返回 null，走原来「整条当一个 text 段」的快路，不影响别的发送。
 */
export function splitAtMarkers(text) {
  const s = String(text ?? '')
  // 2026-11-04 修：只要出现 "[[at" 就往下走，让残缺标记也能被清掉。
  // 原来这里判 "[[at:"，写成全角冒号或漏个括号就直接当普通文本发，群里会露出标记语法。
  if (!/\[\[at/i.test(s)) return null
  const segments = []
  const re = /\[\[at:\s*([^\]\s]+)\s*\]\]/gi
  let last = 0
  let m
  let hits = 0
  while ((m = re.exec(s)) !== null) {
    hits += 1
    if (m.index > last) segments.push({ type: 'text', data: { text: s.slice(last, m.index) } })
    const qq = m[1].trim()
    if (qq !== '') segments.push({ type: 'at', data: { qq } })
    last = m.index + m[0].length
  }
  if (hits === 0) {
    // 一个合法标记都没有：把残渣抹掉，只发剩下的正文
    const cleaned = s.replace(/\[\[at[:：]?[^\]]*\]?\]?/gi, '').trim()
    return cleaned !== s.trim() ? [{ type: 'text', data: { text: cleaned } }] : null
  }
  if (last < s.length) segments.push({ type: 'text', data: { text: s.slice(last) } })
  return segments
}

/**
 * 发一条，不拆条。
 *
 * message 可以是字符串（内部包成单个 text 段），也可以是段数组 ——
 * 表情段就是靠后者跟文本拼在同一条消息里发出去的。
 */
export async function sendOneToQQ(target, message) {
  return sendMessageToTarget(resolveSendTarget(target, getConfig().peerUin), message)
}

async function sendMessageToTarget(target, message, options) {
  const segments = Array.isArray(message)
    ? message
    : [{ type: 'text', data: { text: String(message ?? '') } }]
  const payload = target.kind === 'group'
    ? { action: 'send_group_msg', params: { group_id: Number(target.id), message: segments } }
    : { action: 'send_private_msg', params: { user_id: Number(target.id), message: segments } }
  return deliverOneBot(payload, options)
}

async function sendFaceWithImageFallback(target, emojiId) {
  const { sendCustomFace, listCustomFaces, recordFaceUse } = await import('./custom-faces.js')
  try {
    return await sendCustomFace(target, emojiId)
  } catch (error) {
    if (error?.code !== DELIVERY_REJECTED) throw error
    const faces = await listCustomFaces(50)
    const face = faces.find((item) => String(item.emojiId ?? '') === emojiId)
    const localPath = String(face?.emoPath ?? '')
    const file = localPath !== '' && existsSync(localPath) ? 'file://' + localPath : face?.url
    if (!file) throw error
    const receipt = await sendMessageToTarget(target, [{ type: 'image', data: { file } }])
    recordFaceUse(emojiId)
    note('out', '收藏表情改走图片发送')
    return receipt
  }
}

/**
 * 发一段回复：按句末标点拆成多条，逐条发出并留出真人式的停顿。
 * 返回最后一条的结果（qq_send 的 message_id 取它）。
 *
 * @param {object} target 目标
 * @param {string} text 正文
 * @param {object} [options]
 * @param {object|null} [options.faceSegment] 经典表情段（face）——
 *   **附在最后一条消息末尾**，也就是「表情跟随前一句话」。
 *   face 段可以和文本拼在同一条消息里发出去。
 * @param {string|null} [options.customEmojiId] 收藏表情的 emoji_id ——
 *   协议端那边是独立 action，只能**单独发一条**，跟在文本之后。
 */

// 出站前把本机路径抹掉：不整条拒发，改成占位符继续发（凭据仍由 assertClean 拦截）
const PATH_SCRUB_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/)[^\s"'<>|]*/gi

/**
 * LATENCY_COMP 2026-11-15（批次507）：这次还要再等多少毫秒。
 *
 * @param {number} 目标Ms 这条回复「像打字」需要的总时长（think+typing+pause 算出来的）
 * @param {number|null} 已等Ms 从收到那条消息到现在已经过去多久；null = 没收到过消息
 * @returns {number} 还要补的毫秒；卡够了就是 0
 *
 * 只减不加：绝不会因为补偿让她比「纯打字」更慢。
 */
export function 补偿毫秒(目标Ms, 已等Ms) {
  const 目标 = Number(目标Ms)
  if (!Number.isFinite(目标) || 目标 <= 0) return 0
  if (已等Ms === null || 已等Ms === undefined) return Math.round(目标)
  const 已等 = Number(已等Ms)
  if (!Number.isFinite(已等) || 已等 <= 0) return Math.round(目标)
  return Math.round(Math.max(0, 目标 - 已等))
}

/**
 * LATENCY_COMP 2026-11-16（批次584）：多段回复的后续段间隔也要跟着「已等」压缩。
 *
 * 补偿毫秒() 只作用于第一段前的打字停顿；后续间隔可以压缩冗余等待，
 * 但仍保留 split.js 规定的 1.2 秒最低可见停顿。
 */
export function 段间隔系数(目标Ms, 已等Ms) {
  const 目标 = Number(目标Ms)
  const 已等 = Number(已等Ms)
  if (!Number.isFinite(目标) || 目标 <= 0) return 1
  if (!Number.isFinite(已等) || 已等 <= 0) return 1
  if (已等 <= 目标) return 1
  return Math.max(0.2, Math.min(1, 1 - (已等 - 目标) / 目标))
}

export function scrubLocalPaths(value) {
  const body = String(value ?? '')
  if (body === '') return body
  const cleaned = body.replace(PATH_SCRUB_RE, '（地址略）')
  if (cleaned !== body) note('out', '出站正文里的本机路径已抹成占位符')
  return cleaned
}


// 模型有时把「我不发」写成占位字符串发出来（例：（）本轮不发））。
// 这种整条正文没有实义内容的消息直接吞掉，不往群里发。
// TIGHTEN 2026-11-16（批次522）：原来的尾巴是 [\s\S]{0,12}?，什么都能跟 —— 实测会误吞真话
//   「不说了，睡了」「不回他了，随他」「不发朋友圈了，没意思」
// 这些是她要**告诉主人**的话，不是占位符。改成尾巴只许标点/省略号/右括号：
// 真正的占位符是「（本轮不发）」这种括号包裹的，尾巴里不会有实义词。
const STUB_ONLY_RE = /^[\s（(【\[]*(?:本轮|这轮|这次|这条)?\s*不(?:发|回|说|接|开口|吭声)[\s。！…]*[）)】\]]*\s*$/

// 整条消息是圆括号包起来的「舞台说明」（例：（没插话，只记下了…）），也是不该发出去的内心话。
const STAGE_DIRECTION_RE = /^[（(][\s\S]{2,80}[）)]$/
// TIGHTEN 2026-11-16（批次522）：原来含「看着」「等他」「记下」「不接」——
// 实测「（你看着办吧）」「（记下来了，明天弄）」「（等他回来再说）」全是真话，被当成舞台说明吞掉。
// 只留**只有舞台说明才会用**的强标记；「本轮/这轮/这条」交给 isSilenceStub 管，
// 「沉默」单独精确匹配（lone「（沉默）」要吞，「（沉默是金）」是真话不许吞）。
const STAGE_KEYWORDS = ['没插话', '不插话', '不说话', '不出声', '不吭声', '心里']
const STAGE_SHORT_RE = /^[（(]\s*沉默(了片刻|了一会儿|了几秒|了两秒|一会|一会子|片刻)?[。…\s]*[）)]$/

// EN_META 2026-11-15（批次510）：她会把**英文**状态说明当正文写出来。实测两条原话：
//   「Nothing to send this turn — just recorded the memory verdicts.」
//   「Done — nothing sent.」
// 中文那套闸门（isSilenceStub / isStageDirection）不认英文，哪次她忘了调 qq_pass 就原样发到他手机上。
// 判据刻意收窄：整条没有中文、长度 ≤120、且命中这几种固定说法 —— 不碰正常的英文回复。
const EN_META_RE = /^(?:nothing to send|nothing sent|nothing to say|no message|no reply|done\s*[—–-]|done\s*[,，]?\s*(?:nothing|no message))|recorded the memory/i

export function isEnglishMetaNote(value) {
  const s = String(value ?? '').trim()
  if (s === '' || s.length > 120) return false
  if (/[\u4e00-\u9fa5]/.test(s)) return false
  return EN_META_RE.test(s)
}

// META_SELF_TALK 2026-11-15（批次513）：她把**心里话当正文**写出来，实测原话：
//   「这一轮我不发消息，安静待着。」（开头「这一轮」不在 STUB_ONLY_RE 的白名单里，漏了）
//   「我这边没有新消息，就不打扰鱼片了。」
//   「（这轮到此）*（鱼片把同一张梗图又发了一遍…）*」
// 这几类都不是要对人说的话，出站前直接吞。判据要求**短**（≤80 字）且命中固定句式，
// 避免误吞正常短句（比如「不打扰你了，去忙吧」是真心话，不在此列）。
// TIGHTEN 2026-11-16（批次521e）：原来第 2、3 条没有结尾锚，会误吞真话。
// 实测被吞的两句（t521 S3/S4）：
//   「安静待着也挺好的，不用管我」       ← 第 3 条 ^(我)?(先)?安静(待着|收着) 抓的
//   「没有新消息，你不用管我，我先睡了」 ← 第 2 条的「不用」抓的
// 这两句都是她要**告诉对方**的话，吞掉就是「她以为说了、主人一个字没收到」——
// 比漏吞难受得多。所以：宁可漏吞（多发一句废话，看得见），不可误吞（丢一句真话，没人知道）。
const SELF_TALK_RES = [
  // 最强的一条：句式本身就是元话术，允许带尾巴（实测原话就带「，安静待着。」）
  /^(这一轮|这轮|本轮|这次|本次)\s*我?\s*不(发消息|说话|出声|打扰)/,
  // 「没有新消息 + 不说话」：只认元话术词（开口/回话/打扰…），不认泛泛的「不用」
  /^(我这边)?没有新消息[，,。]?\s*.{0,8}(不用|不必|就不|那我|也就)?\s*(开口|回话|说话|出声|吭声|打扰)[^，,。！？]{0,4}[。！]?$/,
  // 「没有新消息 + 安静待着」
  /^(我这边)?没有新消息[，,。]?\s*.{0,8}(安静|待着|不吭声)[^，,。！？]{0,4}[。！]?$/,
  // 整条就是「（我先）安静待着」—— 必须锚结尾，「安静待着也挺好的」不算
  /^(我)?(先)?安静(待着|收着)[。！]?$/,
  // 整条就是「这轮到此」
  /^(这轮|这一轮|本轮)?\s*到此[。！]?$/,
]

export function isSelfTalkNote(value) {
  const s = String(value ?? '').trim()
  if (s === '' || s.length > 80) return false
  return SELF_TALK_RES.some((re) => re.test(s))
}

export function isStageDirection(value) {
  const body = String(value ?? '').trim()
  if (body === '') return false
  if (!STAGE_DIRECTION_RE.test(body)) return false
  // GUARD 2026-11-16（批次522）：舞台说明不会在跟人说话。
  // 第二条里出现第二人称或问号 → 当它是真话，宁可漏吞（他看得见一句废话）也不误吞（他一个字收不到）。
  if (/[你您]/.test(body) || /[?？]/.test(body)) return false
  if (STAGE_SHORT_RE.test(body)) return true
  return STAGE_KEYWORDS.some((word) => body.includes(word))
}

export function isSilenceStub(value) {
  const body = String(value ?? '').trim()
  if (body === '') return false
  if (!body.includes('不')) return false
  return STUB_ONLY_RE.test(body)
}

// MOVE 2026-11-16（批次523）：这三道闸门原来写在 sendToQQ **函数体内**
// （所以永远没法 export、也永远测不到）。搬到顶层后才能被测试直接喂数据。
// 行为没变：函数体里本来就是函数声明，提升后照样能用。
/**
 * 「我决定不回」这种自我说明本身就是一条消息 —— 用户 2026-11-01 要求写死：
 * 不接的消息不要发。凡是这类元说明，出站前直接吞掉。
 */
const META_SKIP_RE = /^(这条|这条消息|这句)?\s*(我|我们)?\s*(不接|就不接|不回|就不回|不参与|跟我无关|不关我事|不是我该接)/
// 2026-11-01 肥鱼：模型会把「这轮要不要发」的决策过程当正文发出去（实例见群记录）。
// TIGHTEN 2026-11-16（批次523）：这条原来是一串**不分位置**的子串匹配，实测误吞过真话：
//   「@1000000001 定时我挂好了，每天八点一张，抓出来发黑就重试，三次还空当天就不发，只记一笔。」
//   —— 只因为它后半句有个「就不发」。她在汇报正经事，整条被吞。
// 改两处：①只留「只有元话术才会用」的词，去掉 就不发/就不说了/这次不发/这次不说/先不打扰/暂时不打扰
//（这些都可能是真话：「那就不说了，晚安」「那我先不打扰你了」）；
// ②只认**第一句**里的自述，元话术不会藏在第三个逗号后面。
const META_REASON_RE = /(不重复发|没有新内容|(?:这轮|本轮)就?不|我不插话|我先不说)/
export function isMetaReasoning(value) {
  const body = String(value ?? '').trim()
  if (body === '' || body.length > 120) return false
  // 先看第一句：真在说事的那句，元话术不会埋在从句里
  // 只认第一句：没有标点时首句就是整条，所以短句照样能判出来；
  // 原来还有个「body.length <= 20 时再看全文」的兜底，那个兜底会把从句里的「这轮不」捞回来，删掉。
  const 首句 = body.split(/[，,。.！!？?\n；;]/)[0] ?? ''
  return META_REASON_RE.test(首句)
}

// 2026-11-01 肥鱼：整条只是「我没说话」这类占位/舞台说明，一律不发。
const STUB_PLACEHOLDER_RE = /^[\s（(【\[]*(?:没有发言|无发言|不发言|没有回复|无回复|没有内容|无内容|沉默|略)[\s。，,！!…）)】\]]*$/
export function isStubPlaceholder(value) {
  const body = String(value ?? '').trim()
  if (body === '' || body.length > 20) return false
  return STUB_PLACEHOLDER_RE.test(body)
}

export function isMetaSkipNote(value) {
  const body = String(value ?? '').replace(/[\s。！!，,]/g, '')
  if (body === '' || body.length > 40) return false
  if (!META_SKIP_RE.test(body)) return false
  // GUARD 2026-11-16（批次523）：原来只要有「不回/不接」开头就整条吞 ——
  // 「不回了，睡了」「不接这活了」都是真话。分两种：
  // ①明说是「这条/这句」的（实测原话：「这条我不接，数据我先报过了。」）→ 允许带解释尾巴，
  //   这是主人 2026-11-01 明确要求不发的「我不接」通报；
  // ②没说「这条」的 → 必须整条就是这个短语，多一个字都不吞。
  if (/这[条句]|这条消息/.test(body)) return true
  return /^(?:我|我们)?(?:不接|就不接|不回|就不回|不参与|跟我无关|不关我事|不是我该接)$/.test(body)
}

/**
 * 七道出站闸门的统一入口：返回命中的闸门名，空数组表示「这不是元话术」。
 *
 * 抽出来的两个理由（批次523）：
 * ① 原来是一个 7 个 || 的大条件，日志里只有一句「吞掉」，**不记是哪道闸门、也不记内容**。
 *    批次513 查「她说了没发」时，就是因为这个翻了半小时会话才定位到。
 * ② 某道闸门抛错时，原来会直接把整个 sendToQQ 抛穿（消息丢失 + 报错），
 *    现在单道抛错只跳过它自己。
 */
export function 元话术命中(text) {
  const 闸门 = [
    ['isSilenceStub', isSilenceStub],
    ['isStageDirection', isStageDirection],
    ['isMetaSkipNote', isMetaSkipNote],
    ['isMetaReasoning', isMetaReasoning],
    ['isStubPlaceholder', isStubPlaceholder],
    ['isEnglishMetaNote', isEnglishMetaNote],
    ['isSelfTalkNote', isSelfTalkNote],
  ]
  const 出 = []
  for (const [名, 判] of 闸门) {
    try {
      if (判(text)) 出.push(名)
    } catch { /* 单道闸门抛错不影响其余，更不该把整条消息搞丢 */ }
  }
  return 出
}

export function 未发送原因(result) {
  return result?.muted === true ? '静默/取消窗口内，这条没有发出去' : result?.reason ?? ''
}

export async function sendToQQ(requestedTarget, text, options = {}) {
  const config = getConfig()
  const target = resolveSendTarget(requestedTarget, config.peerUin)
  const 收件键 = targetKey(target)
  const tracked = options?.proactiveReceiptText === true
  const afterCancel = () => {
    const window = cancelWindows.get(收件键)
    return Date.now() <= Number(typeof window === 'number' ? window : window?.until)
  }
  // 批次610：breathe.js（固定句抢答）整模块删除，这里不再需要 cancelFiller 收尾。

  // MUTE_GUARD 2026-11-03：被叫停后的静默窗口内，除了 force 的消息一律不发
  try {
    // 2026-11-04 修：放行额度还没用掉时别用 mute 把它挡死，否则「喊停后自己收尾」永远做不到
    if (options?.force !== true && isMuted(收件键) && !hasPendingAllowOne(收件键)) {
      note('outbound', '静默中，丢掉一条发往 ' + 收件键 + ' 的消息')
      return { muted: true }
    }
  } catch { /* 守卫失败不阻断发送 */ }

  let explicitSegments = Array.isArray(options?.segments)
    ? options.segments.map((item) => String(item ?? '')).filter((item) => item.trim() !== '')
    : []
  const useExplicit = explicitSegments.length > 0

  // 2026-11-01 肥鱼：拟人停顿（联动人格与状态）
  // 基准按字数；人格决定抖动幅度（strict=稳、lively=跳）；精力低/情绪闷 → 整体变慢。
  // 关法：config.humanTypingDelay === false；人格用 config.personaStyle。
  // 本次回复的补偿目标留给后面的分段循环用（未配 latencyTargetMs 时按字数算）。
  let 本次补偿目标Ms = 0
  try {
    if (config.humanTypingDelay !== false) {
// OCAI 2026-11-02：移除 try 块内未使用的重复局部变量 hasMedia（原意判断是否有媒体附件，下方 430 行已正式定义使用）
      const body = useExplicit ? explicitSegments[0] : String(text ?? '')
      // 按正文长度和标点模拟打字停顿；运行时拟人状态不改变发送节奏。
      // 上限 6.5 秒封顶：再长就不像打字，像掉线。
      const waitMs = typingDelayMs(body)
      // LATENCY_COMP 2026-11-15（批次507）：延迟补偿。
      // 这一段 wait 在分段循环之前，所以天然只作用于**这条回复的第一段** ——
      // 后面几段的间隔走 partDelayMs（从上一段发出去之后算），不受影响。
      const 目标Ms = (() => {
        const v = Number(config.latencyTargetMs)
        return Number.isFinite(v) && v > 0 ? v : waitMs
      })()
      本次补偿目标Ms = 目标Ms
      const 已等Ms = incomingAgeMs(收件键)
      const 实等Ms = 补偿毫秒(目标Ms, 已等Ms)
      if (已等Ms !== null && 实等Ms < 目标Ms) {
        note('out', `延迟补偿：已等 ${(已等Ms / 1000).toFixed(1)}s，打字目标 ${(目标Ms / 1000).toFixed(1)}s → 只补 ${(实等Ms / 1000).toFixed(1)}s`)
      }
      if (实等Ms > 0) await new Promise((resolve) => setTimeout(resolve, 实等Ms))
    }
  } catch {
    /* 停顿算错不影响发送 */
  }
  // 2026-10-31 肥鱼：取消窗口内，这个目标的所有出站都丢掉
  if (tracked ? afterCancel() : isCancelled(收件键)) {
    note('out', `取消窗口内，丢弃一条发往 ${收件键} 的内容`)
    return { muted: true }
  }
  const hasMedia = (Array.isArray(options?.images) && options.images.length > 0)
    || (Array.isArray(options?.files) && options.files.length > 0)


  if (!hasMedia) {
    const 命中 = 元话术命中(text)
    if (命中.length > 0) {
      // 必须把「哪道闸门 + 原文前 40 字」记下来：
      // 只写一句「吞掉」的话，事后查「她说了没发」根本不知道吞的是什么（批次513 的教训）。
      note('out', '吞掉一条整条都是元话术的正文[' + 命中.join('+') + ']：'
        + String(text ?? '').replace(/\s+/g, ' ').slice(0, 40))
      return { reason: '正文命中出站过滤，未发送' }
    }
  }
  // 调试群（auditDisabledGroups）：什么都能发 —— 连路径都不抹，也不做凭据拦截
  const bypassGroups = Array.isArray(config?.auditDisabledGroups)
    ? config.auditDisabledGroups.map((item) => String(item))
    : []
  const debugTarget = target?.kind === 'group' && bypassGroups.includes(String(target?.id ?? ''))
  if (!debugTarget) {
    text = scrubLocalPaths(text)
    explicitSegments = explicitSegments.map((item) => scrubLocalPaths(item))
  }
  const toolFaceSegment = options?.faceSegment ?? null
  const customEmojiId = String(options?.customEmojiId ?? '').trim()
  const files = Array.isArray(options?.files)
    ? options.files.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
    : []
  const images = Array.isArray(options?.images)
    ? options.images.map((item) => String(item ?? '').trim()).filter((item) => item !== '')
    : []

  // 模型经常把图片写成 markdown 或裸链接，这里自动抽出来当图片发，
  // 否则用户只看到一条网址字符串。
  let bodyText = String(text ?? '')
  const inlineImages = []
  const mdImage = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g
  bodyText = bodyText.replace(mdImage, (_m, url) => { inlineImages.push(url); return '' })
  const bareImage = /https?:\/\/[^\s"'）)]+\.(?:png|jpe?g|gif|webp)(?:\?[^\s"'）)]*)?/gi
  bodyText = bodyText.replace(bareImage, (url) => { inlineImages.push(url); return '' })
  if (tracked && (explicitSegments.length !== 1 || inlineImages.length > 0
    || /\[表情[:：]|\[\[at:|\[CQ:/i.test(explicitSegments[0]))) {
    return { reason: '主动搭话回执仅支持单段纯文字，不发送嵌入的图片、表情或提及' }
  }
  for (const url of inlineImages) {
    const clean = String(url ?? '').trim()
    if (clean !== '' && !images.includes(clean)) images.push(clean)
  }
  bodyText = bodyText.replace(/\n{3,}/g, '\n\n').trim()

  // ---- 分段由谁定 ----
  // 默认按换行切；模型给了 segments（qq_send 的 segments 参数）就按它发 ——
  // 真人会自己决定「这句分三条还是一条说完」，而不是被标点机械切开。

  // 出站内容审计（2026-10-28）：回复里出现本机路径 / 凭据特征就整条不发。
  // 挡在分条之前 —— 命中就整条拒绝，而不是只把其中一条打码发出去。
  // 这里抛错是故意的：上层会翻成工具错误给 agent 看，她会换个说法重讲；
  // 悄悄打码发送会让人误以为闸门没生效。
  // 显式分段时逐段拼起来审，保证每一段都过闸。
  // 例外：config.auditAllowGroups 里列出的群（调试群）放行 —— 用户 2026-10-31 要求
  // 「这个群是调试群，什么都能发」，仅限名单内，其余群照旧拦。
  const auditAllowGroups = Array.isArray(config.auditAllowGroups)
    ? config.auditAllowGroups.map((value) => String(value))
    : []
  const targetGroupId = target?.kind === 'group' ? String(target?.id ?? '') : ''
  const auditExempt = targetGroupId !== '' && auditAllowGroups.includes(targetGroupId)
  if (auditExempt) {
    note('out', `审计豁免：群 ${targetGroupId}（调试群）`)
  } else {
    const auditBypassGroups = Array.isArray(getConfig()?.auditDisabledGroups)
      ? getConfig().auditDisabledGroups.map((item) => String(item))
      : []
    const auditOff = target?.kind === 'group' && auditBypassGroups.includes(String(target?.id ?? ''))
    if (!auditOff) {
      assertClean(useExplicit ? explicitSegments.join('\n') : text, '回复')
    }
  }

  let markedParts
  if (useExplicit) {
    // 每段单独解析表情标记：表情跟着它所在的那一段走（段是模型定的边界）。
    // 用异步版：表情名反查先查 QQ 官方表情目录，查不到再落内置表。
    markedParts = []
    for (const segment of explicitSegments) {
      const marked = await splitEmojiMarksAsync(segment)
      if (marked.text === '' && marked.faces.length === 0) continue
      markedParts.push({ part: marked.text, faces: marked.faces.map((face) => face.id) })
    }
    if (markedParts.length > 1) {
      note('out', `按模型分段发 ${markedParts.length} 条，字数 ${markedParts.map((item) => item.part.length).join('/')}`)
    }
  } else {
    // 正文里的表情标记先摘出来 —— [表情:呲牙] 这种明文不该出现在 QQ 上
    const marked = await splitEmojiMarksAsync(bodyText)
    const body = marked.text
    const bodyFixed = body
    const dynMaxParts = Number(config.splitMaxParts) || 8
    const parts = bodyFixed === '' ? [] : config.splitReply === false
      ? [body]
      : splitMessage(bodyFixed, {
          // 默认按换行分条（她自己决定说几条）；sentence = 老行为，按句末标点切
          mode: config.splitMode === 'sentence' ? 'sentence' : 'paragraph',
          maxChars: Number(config.splitMaxChars) || 120,
          minChars: Number(config.splitMinChars) || 4,
          maxParts: dynMaxParts
        })
    if (parts.length > 1) {
      note('out', `分 ${parts.length} 条发送，字数 ${parts.map((item) => item.length).join('/')}`)
    }
    // 正文标记 → 按位置挂到各条消息末尾（「表情跟随前一句话」）
    markedParts = attachFacesToParts(parts, marked.faces)
  }

  if (markedParts.length === 0 && toolFaceSegment === null && customEmojiId === '' && images.length === 0 && files.length === 0) {
    throw new Error('要发送的内容是空的')
  }

  let result = null
  const 失败项 = []
  const 记失败 = (位置, error) => {
    失败项.push(error)
    note('out', `${位置}失败：${error instanceof Error ? error.message : error}`)
  }
  let 已发问句 = ''
  for (let i = 0; i < markedParts.length; i += 1) {
    const current = markedParts[i]
    if (i > 0) {
      const 基础间隔 = partDelayMs(current.part, {
        minDelayMs: config.splitDelayMinMs,
        maxDelayMs: config.splitDelayMaxMs,
        personKey: personKeyOf(target)
      })
      // LATENCY_COMP 2026-11-16（批次584）：已经等超过目标时，后续段别再按完整条间隔拖。
      let 间隔 = 基础间隔
      try {
        const 目标 = 本次补偿目标Ms || Number(config.latencyTargetMs) || 0
        if (目标 > 0) {
          const 已等 = incomingAgeMs(收件键)
          const 系数 = 段间隔系数(目标, 已等)
          if (系数 < 1) 间隔 = latencyAdjustedPartDelayMs(基础间隔, 系数)
        }
      } catch { /* 补偿算错按原节奏 */ }
      await sleep(间隔)
    }
    // 空文本段不塞进去（有些协议端对空 text 段不友好），只发它的表情
    const segments = []
    if (current.part !== '') {
      // 2026-10-31 肥鱼：正文里的 [[at:QQ号]] 拆成真 at 段，和文字混在同一条里发
      const atParts = splitAtMarkers(current.part)
      if (atParts) segments.push(...atParts)
      else segments.push({ type: 'text', data: { text: current.part } })
    }
    // 正文标记来的表情
    for (const id of current.faces) segments.push({ type: 'face', data: { id: String(id) } })
    // 工具参数来的表情：附在最后一条消息末尾
    if (toolFaceSegment !== null && i === markedParts.length - 1) segments.push(toolFaceSegment)

    // ⚠️ 带表情发送失败 → 去掉表情、把文字重发一遍。
    //   协议端遇到它不认的 face id（比如内置表记错编号）会报 OIDB 错误，
    //   **整条消息直接发不出去** —— 文字也跟着没了。
    //   实测她的两条回复就是这么被吞的（「[表情:晕]」→ 编号 17 → 幽灵 id）。
    //   所以这里兜一层：表情发不出去就只发文字，绝不让整条回复消失。
    try {
      try {
        const beforeSend = tracked ? () => !isMuted(收件键) && !afterCancel() && options?.beforeProactiveSend?.() === true : undefined
        if (beforeSend && !beforeSend()) throw Object.assign(new Error('主动搭话已取消，未调用协议端'), { proactiveNotSent: true })
        result = await sendMessageToTarget(target, segments, { beforeSend })
      } catch (error) {
        if (tracked || error?.code !== DELIVERY_REJECTED || current.part === '' || !segments.some((item) => item.type === 'face')) throw error
        note('out', '协议端明确拒绝带表情的文字，改发纯文字')
        result = await sendMessageToTarget(target, [{ type: 'text', data: { text: current.part } }])
      }
      if (options.reviewDisclosure !== true) {
        try { noteSaid(target, current.part) } catch (error) { note('out', '已发原文记账失败：' + error.message) }
        if (/[?？]|吗$|呢$|好不好|行不行/.test(current.part.trim())) 已发问句 = current.part
      }
    } catch (error) {
      记失败(`第 ${i + 1}/${markedParts.length} 段发送`, error)
    }
  }

  if (已发问句 !== '' && !tracked && options?.followup !== true && target.id !== '806972995') {
    try { armFollowup(target, 收件键, { asked: true, text: 已发问句 }) } catch (error) { note('out', '追问计时失败：' + error.message) }
  }

  // 图片：每张单独一条消息，跟在文字后面
  let imageResult = null
  for (const file of images) {
    try {
      // GIF_SUBTYPE 2026-11-03：gif 要标 sub_type=1，否则协议端按静态图处理
      const isGif = /\.gif(?:$|\?)/i.test(String(file))
      // GIF_LOCALIZE 2026-11-03：动图给 URL，协议端会下载后按静态图重压 → 先落到本地再发，动画才保得住
      let sendFile = file
      if (isGif && /^https?:\/\//i.test(String(file))) {
        try {
          const resp = await fetch(String(file), { signal: AbortSignal.timeout(20000) })
          if (resp.ok) {
            const buf = Buffer.from(await resp.arrayBuffer())
            const tmp = '/tmp/qq-out-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.gif'
            const { writeFileSync } = await import('node:fs')
            writeFileSync(tmp, buf)
            sendFile = 'file://' + tmp
            note('out', '动图已落地再发：' + tmp + '（' + buf.length + ' 字节）')
          }
        } catch (e) { note('out', '动图落地失败，退回 URL：' + (e?.message ?? e)) }
      }
      imageResult = await sendMessageToTarget(target, [{ type: 'image', data: isGif ? { file: sendFile, sub_type: 1 } : { file: sendFile } }])
      note('out', `发送图片 ${file}`)
    } catch (error) {
      记失败(`图片发送（${file}）`, error)
    }
  }

  // 收藏表情：协议端只能单独发一条，跟在文本后面
  if (customEmojiId !== '') {
    try {
      result = await sendFaceWithImageFallback(target, customEmojiId)
    } catch (error) {
      记失败('收藏表情发送', error)
    }
  }

  // 只有表情没有文本的情况
  if (markedParts.length === 0 && toolFaceSegment !== null) {
    try {
      result = await sendMessageToTarget(target, [toolFaceSegment])
    } catch (error) {
      记失败('纯表情发送', error)
    }
  }

  // 文件：走 OneBot 的文件上传接口，每个文件一条
  let fileResult = null
  for (const file of files) {
    try {
      const name = String(file).split('/').pop() || 'file'
      const payload = target.kind === 'group'
        ? { action: 'upload_group_file', params: { group_id: Number(target.id), file, name } }
        : { action: 'upload_private_file', params: { user_id: Number(target.id), file, name } }
      fileResult = await deliverOneBot(payload)
      note('out', `发送文件 ${file}`)
    } catch (error) {
      记失败(`文件上传（${file}）`, error)
    }
  }

  const 回执 = result ?? imageResult ?? fileResult
  if (!回执) throw 失败项.find((error) => error?.code !== DELIVERY_REJECTED) ?? 失败项[0] ?? new Error('没有完成的发送项')
  return 失败项.length === 0 ? 回执 : { ...回执, failedParts: 失败项.length }
}

// ---- 回合事件扫描 ----

/**
 * 取「上次看过的位置之后」的新事件。
 *
 * DSH 的 Session API 支持范围查询：snapshotEvents(fromSeq, toSeqExclusive)。
 * 早先调的是无参版本 —— 那是「从 0 取到当前」的全量快照，每秒扫一遍，
 * 长会话几千个事件时就是纯浪费。现在只取 [from, seq) 这一段。
 *
 * 边界做了两层保险：
 *   - from 可能落在「继承事件」区（seq < firstLiveSeq）之前 → 取 max(from, firstLiveSeq)；
 *   - 拿不准 from 是不是闭区间 → 下游一律用 seq > cursor 过滤，两种语义都对。
 */
function eventsSince(agent, fromSeq) {
  try {
    const session = agent?.session
    if (session === undefined || session === null) return []
    if (typeof session.snapshotEvents === 'function') {
      const first = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : 0
      const from = Math.max(Number(fromSeq) || 0, first)
      // 上界用 seq + 1：DSH 的签名是 toSeqExclusive（开区间），
      // 而 session.seq 到底是「最后一个已分配 seq」还是「下一个待分配」，
      // 两种解释差一个事件 —— 漏掉的正好可能是 turn/end（回复就转发不出去了）。
      // 多取一个不存在的 seq 无害（下面按 seq > cursor 过滤）。
      const to = typeof session.seq === 'number' ? session.seq + 1 : undefined
      const list = to !== undefined ? session.snapshotEvents(from, to) : session.snapshotEvents(from)
      return Array.isArray(list) ? list : []
    }
    if (Array.isArray(session.events)) {
      return session.events.filter((event) => Number(event?.seq) > Number(fromSeq))
    }
  } catch {
    /* 拿不到就算了，下一轮再试 */
  }
  return []
}

/** 当前会话最大的事件 seq。DSH 有 seq getter，直接读；没有才退回报数。 */
export function maxEventSeq(agent) {
  try {
    const session = agent?.session
    if (session !== undefined && session !== null && typeof session.seq === 'number') return session.seq
  } catch {
    /* 忽略 */
  }
  let max = 0
  for (const event of eventsSince(agent, -1)) {
    const seq = Number(event?.seq)
    if (Number.isFinite(seq) && seq > max) max = seq
  }
  return max
}

function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .join('')
    .trim()
}

/**
 * 每秒扫一遍：哪个会话的待转发队列头部的回合跑完了，就把这回合最后一条助手文本发回 QQ。
 *
 * 队列逐条消化：头部条目等到它的 turn/end 才转发（并按它自己的 target 发），
 * 转发完 shift，下一条成为新头部。回合失败 / 已用 qq_send 发过 / 空文本都算「消化完」。
 *
 * flushBusy 防重入：分条发送带真人停顿（最长几百 ms×N），一轮 flush 可能超过 1 秒，
 * 定时器又把第二轮拍进来 —— 两轮同时 shift 同一个队列会重发或跳发。
 */
let flushBusy = false

/**
 * flushOutbound 的新实现（临时脚本用，跑完即删）。
 *
 * 修复：连着发消息时同一条回复被发好几遍。
 *   cursor 是「投递那一刻的 session.seq」，agent 跑回合期间它不推进 →
 *   两条消息的 cursor 相同 → 两个队列条目认到同一个 turn/end → 同一条回复发两遍。
 *   改法：条目认领「属于自己的那条 user/message」，靠它定位回合；
 *        同一个 turn/end 用 sentTurns 去重，只发一次。
 */
export async function flushOutbound(ctx) {
  if (flushBusy) return
  flushBusy = true
  const config = getConfig()
  try {
    sweepProactiveOutbound(config)
    for (const [sessionId, queue] of outbound) {
      const state = sessionState(sessionId)
      const sentTurns = sentTurnsOf(sessionId)
      while (queue.length > 0) {
        const entry = queue[0]
        // 批次 602B：本条队列项只允许出队一次。
        // 旧代码在发送前 shift、发送异常时 catch 又 shift，
        // 第二次会把下一条尚未发送的消息一起丢掉。
        const 出队状态 = newDequeueState()
        const 出队本条 = () => dequeueOnce(queue, 出队状态)
        if (entry.proactiveReceiptToken) break
        // 2026-10-31：主人喊过「停」，这条回复直接扔掉不发（见 dropPendingReplies）。
        if (entry.dropped === true) {
          note('out', `${sessionId} 这条回复被「停」丢掉了，不出队会堵住后面`)
          markSentTurn(sessionId, Number(entry.cursor) || 0)
          出队本条()
          continue
        }
        try {
          // ---- 回合超时（2026-10-28）----
          // turn/end 可能永远不来：DSH 崩了、会话被手动中断、回合被 DSH 丢弃。
          // 那种情况下这个条目会永久卡在队头 —— 后面所有转发全堵死，
          // 表现成「她突然不理人了」，日志里却一片安静（因为根本没走到出错分支）。
          // 所以给每个条目一个寿命：超了就丢，记一条日志，让队列继续走。
          //
          // 为什么是「丢」不是「重试」：turn/end 都没来，说明这一回合没有可靠结果；
          // 重试只会把同一条队列反复卡住。宁可少发一条，也不能让管道死掉。
          const ttlMs = Number(config.outboundEntryTtlMs) || 150000
          const waited = Date.now() - (Number(entry.createdAt) || 0)
          const 到期 = Number(entry.createdAt) > 0 && waited > ttlMs
          // TTL_GRACE 2026-11-14（批次443）：翻三天日志，9 次「也没找到可发的回复，丢弃」里
          // **有 7 次，回复在丢后 0–28 秒就到了**（最近一次只差 1 秒，同一秒里丢完就来）。
          // 回合只是慢了一点点，条目却已经 shift 掉，那条回复永远发不出去 ——
          // 主人那边表现成「她没理我」，而日志只有一行「丢弃」，看不出差一点就成。
          //
          // 所以到点先宽限一次：**不丢**，继续往下走正常匹配；宽限内 turn/end 到了就正常发。
          // 宽限也不到才走下面那套「打捞/丢弃」—— 安全阀还在，只是不再卡在「差一秒」上。
          // 宽限时长可配（outboundEntryTtlGraceMs），默认 60s：实测最慢的那次差 28s。
          const 宽限Ms = Number(config.outboundEntryTtlGraceMs) || 60000
          if (到期 && entry.ttlGraced !== true && waited <= ttlMs + 宽限Ms) {
            entry.ttlGraced = true
            note(
              'out',
              `队列条目到 TTL（${Math.round(waited / 1000)}s）还没等到 turn/end，宽限 ${Math.round(宽限Ms / 1000)}s 再判（cursor=${entry.cursor}）`
            )
          } else if (到期 && waited > ttlMs + 宽限Ms) {
            // 2026-11-01 肥鱼：超时不再直接丢。先找这段时间最后一条助手消息：
            // 过程话（稍等/马上/我看看）过期不发、只记一笔；结论话照发。
            let salvaged = ''
            try {
              const from = Number(entry.cursor) || 0
              const evs = eventsSince(entry.agent, from) || []
              const replies = evs.filter((e) => e?.type === 'assistant/message' && Number(e.seq) > from)
              const last = replies[replies.length - 1]
              salvaged = blocksToText(last?.data?.message?.content) || ''
            } catch {
              // OCAI 2026-11-02：空 catch 补注释——打捞超时回复失败时退回空串
              salvaged = ''
            }
            if (salvaged.trim() !== '') {
              const PROCESS_WORDS = /稍等|马上|稍后|正在|我看看|等一下|待会儿|处理中|先弄|这就去/
              if (PROCESS_WORDS.test(salvaged) && salvaged.length < 40) {
                note('out', `队列条目超时（等了 ${Math.round(waited / 1000)}s），这条是过程话，过期不发`)
              } else {
                // AUTOFWD 2026-11-17（批次620）：超时只进死信，不再自动补发。
                // 回合超时不等于她选择了发送；补发由人工/显式 replay 决定。
                note('out', `队列条目超时（等了 ${Math.round(waited / 1000)}s），正文进死信，不自动补发`)
                try {
                  const 保留 = outboundDeadLetters.push({
                    at: Date.now(),
                    sessionId,
                    target: entry.target ?? null,
                    text: salvaged,
                    error: '回合超时，未自动补发（批次620）',
                  })
                  try { 记录死信({ sessionId, target: entry.target ?? null, text: salvaged, error: '回合超时，未自动补发（批次620）' }) } catch { /* 死信写盘失败不影响出站 */ }
                  note('out', `超时正文已进死信（${保留}/50）`)
                } catch (error) {
                  note('out', `超时正文进死信失败：${error instanceof Error ? error.message : error}`)
                }
              }
            } else {
              note('out', `队列条目超时（等了 ${Math.round(waited / 1000)}s），也没找到可发的回复，丢弃`)
            }
            出队本条()
            continue
          }
          // 收集 user/message 时要从 state.matchCursor 开始扫（可能比 entry.cursor 更早），
          // 否则认不准「属于我这条消息」的那条 user/message。
          const scanFrom = Math.min(Number(entry.cursor) || 0, state.matchCursor)
          const events = eventsSince(entry.agent, scanFrom)
          if (events.length === 0) break

          // ---- 收集还没认领的 user/message ----
          // 队列是 FIFO，用户消息事件也是顺序出现的：
          //   第一个条目认领最早的那条，第二个认领下一条，以此类推。
          // 靠这个顺序对应，才能在「两条消息合进同一回合」时把两个条目都对到那个回合上。
          //
          // ⚠️ 收集范围 = [state.matchCursor, 本轮扫到的最大 seq]。
          //   matchCursor 只前进不后退，所以同一批事件不会被重复收集。
          const scanMax = events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)
          for (const event of events) {
            const seq = Number(event?.seq)
            if (!Number.isFinite(seq)) continue
            if (seq < state.matchCursor || seq > scanMax) continue
            if (event?.type === 'user/message' && !event.data?.source?.qq?.proactiveReceiptToken
              && !receiptStore.recordsForSource(sessionId, event.data?.id).length && !state.pendingUserSeqs.includes(seq)) {
              state.pendingUserSeqs.push(seq)
            }
          }
          state.pendingUserSeqs.sort((a, b) => a - b)
          if (scanMax > state.matchCursor) state.matchCursor = scanMax

          // ---- 认领属于本条目的那条 user/message ----
          if (entry.userSeq === null) {
            // 用 >= 而不是 >：cursor 是「投递那一刻最后一个已分配的 seq」，
            // 而 followup 之后 user/message 会占用**新的** seq（cursor+1）；
            // 但边界情况下（事件正好落在 cursor 上）用 > 会认领不到 → 队列卡死。
            // 认领用「第一个还没被认走的、比 cursor 不早的 user/message」。
            const idx = state.pendingUserSeqs.findIndex((seq) => seq >= (Number(entry.cursor) || 0))
            if (idx >= 0) {
              entry.userSeq = state.pendingUserSeqs.splice(idx, 1)[0]
            } else {
              // 兜底：认不到 user/message（老会话格式、事件被裁剪等）。
              // 已经没有比 cursor 更晚的 turn/end → 回合还没跑完，等下一轮。
              const hasLaterEnd = events.some(
                (event) => event?.type === 'turn/end' && Number(event.seq) > (Number(entry.cursor) || 0)
              )
              if (!hasLaterEnd) break
              // 有 turn/end 但认不到用户消息 → 退回用 cursor 定位（老行为）。
              // 这种情况下无法区分「两条消息合进一个回合」，但至少不会卡死队列。
              entry.userSeq = Number(entry.cursor) || 0
            }
          }
          const myUserSeq = entry.userSeq

          // ---- 定位属于我的回合 ----
          // 用「我的 user/message 之后的第一个 turn/end」，而不是 cursor。
          // 原因：agent 跑回合期间 session.seq 不推进，连着发的两条消息 cursor 可能相同；
          // 用 cursor 会让两个条目认到同一个回合 → 同一条回复发两遍。
          const ends = events
            .filter((event) => event?.type === 'turn/end' && Number(event.seq) > myUserSeq)
            .sort((a, b) => Number(a.seq) - Number(b.seq))
          if (ends.length === 0) {
            // 队头的回合还没跑完，等下一秒。
            //
            // 这里是「她突然不回话」最关键的一个静默出口 —— 卡在这儿时不会有任何异常，
            // 日志一片安静。所以等太久就留一条诊断：通常意味着 turn/end 丢了
            // （DSH 崩过 / 会话被中断 / 事件被裁剪），而不是「模型还在想」。
            const stalled = Date.now() - (Number(entry.createdAt) || 0)
            if (stalled > 30000 && entry.stallWarned !== true) {
              entry.stallWarned = true
              note(
                'out',
                `队头条目已等 ${Math.round(stalled / 1000)}s 仍未等到 turn/end（cursor=${entry.cursor}，userSeq=${entry.userSeq ?? '未认领'}）—— 若持续如此，多半是这一回合丢了，等 TTL 到期会自动丢弃`
              )
            }
            break
          }
          const end = ends[0]
          const endSeq = Number(end.seq)

          // 同一个回合已经发过了 → 跳过（不重复发）。
          // ⚠️ 必须出队：它那条消息已经被这个回合一起回答过了，
          //   留在队头会一直卡住，把后面的条目全堵住。
          if (sentTurns.has(endSeq)) {
            note('out', `回合 seq=${endSeq} 已转发过，跳过重复发送`)
            entry.cursor = endSeq
            出队本条()
            continue
          }

          // 回复正文 = 这个回合里的最后一条助手消息
          // ⚠️ 下界取 min(cursor, myUserSeq)：
          //   两条消息合进同一回合时，我的 user/message 可能在 cursor 之后，
          //   但本回合的 assistant/message 可能排在我的 user/message **之前**
          //   （DSH 把两条消息都塞进一个回合时，助手只回一次，回复在两条之后）。
          //   取宽一点的下界，保证「这个回合里的最后一条助手消息」一定在范围内 ——
          //   最后一条必然属于本回合（回合刚结束），不会误取到上一回合的。
          const from = Math.min(Number(entry.cursor) || 0, myUserSeq)
          const replies = events.filter(
            (event) => event?.type === 'assistant/message' && Number(event.seq) > from && Number(event.seq) < endSeq
          )
          entry.cursor = endSeq
          const last = replies[replies.length - 1]
          const text = blocksToText(last?.data?.message?.content)
          const reviewDisclosure = events.some((event) => event.type === 'tool/call' && event.seq > from && event.seq < endSeq
            && event.data?.name === 'bili_humanism_lookup_review') && reviewEvidenceOf(entry.agent.session).turns.has(end.data?.turn)

          // 本回合如果已经用 qq_send 发过了，就别再自动转发 —— 否则工具发的是"给群里的正文"，
          // 自动转发又会把助手这一轮的完整正文再发一遍（实测：群里多收到 2 条本不该发的内容）。
          const sendCalls = events.filter(
            (event) =>
              event?.type === 'tool/call' &&
              Number(event.seq) > from &&
              Number(event.seq) < endSeq &&
              String(event?.data?.name ?? '') === 'qq_send'
          )
          if (sendCalls.length > 0) {
            const callIds = new Set(sendCalls.map((event) => String(event?.data?.callId ?? '')))
            const failed = events.some(
              (event) =>
                event?.type === 'tool/result' &&
                callIds.has(String(event?.data?.callId ?? event?.data?.message?.toolCallId ?? '')) &&
                event?.data?.message?.isError === true
            )
            // SEND_FAIL 2026-11-17（批次649）：**失败也不许自动转发。**
            // 原来只有「没失败」才跳过，失败就往下走到 sendToQQ(entry.target, text) ——
            // 发出去的是这一轮 assistant 的**完整正文**，不是她 qq_send 里挑的那段；
            // 正文里可能有她给自己看的解释、工具过程、另一版草稿。
            // 更糟的是日志写「被 qq_pass 拦下」：qq_pass 是沉默，qq_send 抛错是失败，两回事。
            // 现在一律不转发，失败只进死信，要补发走人工 replay。
            if (failed) note('out', `qq_send 调用失败（${sendCalls.length} 次），按红线不自动转发，正文进死信`)
            else note('out', `本回合已用 qq_send 发过（${sendCalls.length} 次），跳过自动转发`)
            if (failed && !reviewDisclosure) {
              const 原因 = 'qq_send 调用失败，按拟人化红线不自动转发'
              const 保留 = outboundDeadLetters.push({ at: Date.now(), sessionId, target: entry.target ?? null, text, error: 原因 })
              try { 记录死信({ sessionId, target: entry.target ?? null, text, error: 原因 }) } catch { /* 死信写盘失败不影响出站 */ }
              note('out', `${原因}（${text.length} 字，已进死信 ${保留}/50）`)
            }
            markSentTurn(sessionId, endSeq)
            出队本条()
            const accepted = !failed && callIds.size === sendCalls.length && !callIds.has('') && sendCalls.every(call => {
              let args = call.data.arguments
              if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return false } }
              if (!args || typeof args !== 'object' || entry.target?.kind !== 'private' || args.group_id
                || String(args.user_id ?? config.peerUin) !== String(entry.target.id)) return false
              const results = events.filter(event => event.type === 'tool/result' && event.seq > call.seq && event.seq < endSeq
                && String(event.data?.message?.toolCallId ?? event.data?.callId) === String(call.data.callId))
              const message = results[0]?.data?.message
              return results.length === 1 && message?.isError !== true && message?.content?.length === 1
                && /^已发到 QQ，message_id=[1-9]\d*$/.test(message.content[0]?.text ?? '')
            })
            try { 实时回合结束(ctx, sessionId, entry, events, from, endSeq, { accepted }) } catch (e) { note('out', '续跑钩子失败：' + (e instanceof Error ? e.message : e)) }
            continue
          }

          if (text === '') {
            const reason = end?.data?.reason
            const errText = String(reason?.error?.message ?? '')
            // ---- inactive context 自动重挂载（2026-10-31）----
            // 现象：followup 不报错，但会话上下文已被回收，回合建不起来，
            // 只留下「cannot create effect on inactive context」，消息静默丢失。
            // 做法：重新挂载该会话，把新 agent 换进队列条目，重试一次（只重试一次，防死循环）。
            if (reason?.kind === 'error' && errText.includes('inactive context') && entry.recoveredTried !== true) {
              entry.recoveredTried = true
              // 光换 agent 不够：那一回合根本没建起来，消息得重新投一次才会有人接。
              if (typeof entry.redeliver === 'function') {
                // 重投之前必须换掉那个死掉的 agent，否则重投还是投进死人身上
                if (ctx !== undefined) {
                  try {
                    const { forceResume } = await import('./sessions.js')
                    const fresh = await forceResume(ctx, sessionId)
                    const freshAgent = fresh?.agent ?? fresh
                    if (freshAgent !== undefined && freshAgent !== null && freshAgent !== entry.agent) {
                      entry.agent = freshAgent
                      note('out', `${sessionId} 已换成新 agent，重投`)
                    } else {
                      // 还是同一个死 agent（注册表里没摘掉）→ 重投没意义，放弃，走正常失败分支
                      note('out', `${sessionId} 重挂载没拿到新 agent，放弃重投`)
                      markSentTurn(sessionId, endSeq)
                      出队本条()
                      continue
                    }
                  } catch (error) {
                    note('out', `强制重新挂载失败：${error instanceof Error ? error.message : error}`)
                  }
                }
                note('out', `${sessionId} inactive context，2 秒后把这条消息重新投一次`)
                markSentTurn(sessionId, endSeq)
                出队本条()
                Promise.resolve()
                  .then(() => entry.redeliver(2000))
                  .catch((error) => note('out', `重投失败：${error instanceof Error ? error.message : error}`))
                continue
              }
              note('out', `${sessionId} inactive context，但没有重投回调，只能丢弃这一条`)
            }
            if (reason?.kind === 'error') {
              note('out', `回合失败，不转发：${errText || '未知错误'}`)
              note('diag', `fail session=${sessionId} queue=${queue.length} entry=${entry.recoveredTried === true ? 'retried' : 'first'} textLen=${text.length}`)
              if (typeof entry.redeliver === 'function') {
                note('out', `${sessionId} 回合失败，2 秒后重投（自动重试上限 2 次）`)
                出队本条()
                Promise.resolve()
                  .then(() => entry.redeliver(2000))
                  .catch((error) => note('out', `失败回合重投失败：${error instanceof Error ? error.message : error}`))
                continue
              }
            }
            markSentTurn(sessionId, endSeq)
            出队本条()
            continue
          }
          // ---- 她主动划走了（qq_pass）----
          // 这是「有意为之的沉默」：什么都别发出去，但这一回合要正常结账
          // （出队 + 标记已发），否则它会卡在队头把后面全堵住。
          const passKey = targetKey(entry.target)
          if (consumeSuppress(passKey)) {
            // PASS_IS_SILENT 2026-11-06（批次108）：划走就是划走，一个字都不发。
            //
            // 这里原来有个妥协（2026-11-04）：模型先写一句正文、又觉得「太催了」而调
            // qq_pass，用户会以为转发坏了，于是定成「正文里有真话就照发」。
            // 那个妥协在 00:28 兑现了代价 —— 她睡着，群里有人发图，她起了一轮、
            // 心里记下「这处没接话」、调 qq_pass 表示不回；这 6 个字被当成「真话」
            // 发进了群。用户看到的是「她睡梦中冒出一句莫名其妙的话」。
            // 而她的 qq_pass 理由写得清清楚楚：「这会儿按记录我正睡着，他没点我」。
            // 内心判断不是消息。qq_pass 的语义就是「这轮不出声」。
            note('out', `本回合已划走（qq_pass），不转发任何内容（正文 ${text.length} 字只留在会话里）key=${passKey}`)
            出队本条()
            markSentTurn(sessionId, endSeq)
            continue
          }

          // ---- 整条只有旁白 / 动作 = 她其实没开口 ----
          // 主动搭话投进去之后，模型有时会回「（尾巴摆了摆）」表示「我在，但没话说」；
          // 普通回合里也会漏出「（报了。）」「（本轮不发）」「（没有发言。）」这类内心旁白。
          // 转发链只认文字，这些就原样发到群里，用户看到的是一条莫名其妙的消息。
          //
          // 2026-11-04 收口：原来只拦主动搭话回合（注释担心误伤「（笑）好呀」），
          // 但 isStageOnly 对「（笑）好呀」「好呀（笑）」本来就返回 false——
          // 它只认「strip 掉括号后一个字都不剩」。所以那个顾虑不成立，改成任何回合都拦。
          // 实测她发出 2023 条里有 19 条属于这类（0.94%），最近的 11-03 还有一条「（报了。）」。
          //
          // 例外：带表情/图片标记的不拦（[表情:猫猫] 该由表情链变成真表情，不能当旁白丢掉）。
          // LEAK_GUARD 2026-11-12（批次366）：上游偶发把思考写进正文块，
          // 判据见 疑似思考泄漏()。拦下来按沉默处理 —— 宁可这一轮不说话，
          // 也不能把一大段英文内心独白发到 QQ 上（她本人看到都会说「泄漏了」）。
          if (疑似思考泄漏(text)) {
            const 中文数 = (text.match(/[\u4e00-\u9fff]/g) || []).length
            note('out', `疑似思考泄漏（${text.length} 字，中文 ${Math.round((中文数 / text.length) * 100)}%），按沉默处理不转发：${text.slice(0, 60)}`)
            出队本条()
            markSentTurn(sessionId, endSeq)
            continue
          }
          if (dropAsSilence(text)) {
            note('out', `整条只有旁白/动作（${text.length} 字，${entry.proactive === true ? '主动搭话' : '普通回复'}回合），按沉默处理不转发：${text.slice(0, 40)}`)
            出队本条()
            markSentTurn(sessionId, endSeq)
            continue
          }

          // AUTOFWD 2026-11-17（批次620）：这一回合没有 qq_send，就不替她按发送键。
          // 只把正文存进死信（可人工补发），不自动发到 QQ。
          // AUTOFWD_PRIVATE 2026-11-23：私聊例外，见下方同名注释。
          // qq_send 调用失败后的兜底仍保留在上面；qq_pass 已在上面按沉默处理。
          if (sendCalls.length === 0 && String(entry.target?.kind) !== 'private') {
            if (reviewDisclosure) {
              markSentTurn(sessionId, endSeq)
              出队本条()
              continue
            }
            const 原因 = '本回合没有调用 qq_send，按拟人化红线不自动转发'
            const 保留 = outboundDeadLetters.push({
              at: Date.now(),
              sessionId,
              target: entry.target ?? null,
              text,
              error: 原因,
            })
            try { 记录死信({ sessionId, target: entry.target ?? null, text, error: 原因 }) } catch { /* 死信写盘失败不影响出站 */ }
            note('out', `${原因}（${text.length} 字，已进死信 ${保留}/50）`)
            markSentTurn(sessionId, endSeq)
            出队本条()
            continue
          }
          // AUTOFWD_PRIVATE 2026-11-23：主人私聊里她写了正文却没调 qq_send（模型漏工具），
          // 原来一律进死信 —— 表现就是「她想了、面板里有字、QQ 一条没收到」。
          // 群聊维持原判（怕她在群里自言自语）；私聊已经过思考泄漏/旁白过滤，直接按回复发。
          if (sendCalls.length === 0) {
            note('out', `私聊回合没调 qq_send，按正文直接回（${text.length} 字）`)
          }

          // 批次 602B：先标记已发（防止同一回合重发），发送成功才出队。
          // 发送失败进死信、出队本条；绝不二次 shift，把下一条也误删。
          markSentTurn(sessionId, endSeq)
          try {
            const result = await sendToQQ(entry.target, text)
            const reason = 未发送原因(result)
            if (reason) {
              note('out', `未转发回复：${reason}`)
            } else {
              note('out', `已转发回复 ${text.length} 字 -> ${entry.target?.kind ?? '?'}`)
              try { 实时回合结束(ctx, sessionId, entry, events, from, endSeq) } catch (e) { note('out', '续跑钩子失败：' + (e instanceof Error ? e.message : e)) }
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error)
            const 保留 = outboundDeadLetters.push({
              at: Date.now(),
              sessionId,
              target: entry.target ?? null,
              text,
              error: msg,
            })
            // 批次611：同一份正文再落一份到磁盘（重启后还能查、还能补发）。
            try { 记录死信({ sessionId, target: entry.target ?? null, text, error: msg }) } catch { /* 死信写盘失败不影响出站 */ }
            note('out', `转发失败，已进死信（${保留}/50）：${msg}`)
          }
          出队本条()
        } catch (error) {
          note('out', `转发失败：${error instanceof Error ? error.message : error}`)
          出队本条() // 出错也出队：卡在队头会把后面所有待转发都堵死
        }
      }
      if (queue.length === 0) {
        outbound.delete(sessionId)
        // 队列空了 → 重置会话状态：下次的新消息重新从它自己的 cursor 开始认领。
        // 不重置的话，之前没认领走的 user/message 会被下一个条目错认。
        sessionStates.delete(sessionId)
        // 「已发回合」记录同样清掉：它记的是 seq 空间里的位置，
        // 会话重连 / 冷启动后这个空间会变，留着只会把新回合误判成「发过了」。
        // 而且没人排队时它本来就没用（见 SENT_TURNS_LIMIT 的注释）。
        sentTurnEnds.delete(sessionId)
      }
    }
  } finally {
    flushBusy = false
  }
}

export { eventsSince }
