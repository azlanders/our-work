/**
 * deliver.js —— 消息投递进 DSH 会话 + 路由查询。
 */
import { randomUUID } from 'node:crypto'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { muteFor } from './mute.js'
import { getConfig } from './config.js'
import { bjDate, note, serviceOf } from './env.js'
import { enqueueOutbound, maxEventSeq, markCancelled, targetKeyOf } from './outbound.js'
// PEOPLE_KEY 2026-11-17（批次605）：别扭/怨按目标 QQ 取，禁止拿 people 的第一条顶替。
import { personRecordOf } from './target.js'
import { ensureAgent } from './sessions.js'
import { markVoiceTarget } from './stateVoice.js'
import { targetKey, waitQuiet, quietMsFromConfig, rememberDelivery, rememberStagedInbox, allConsumedIncoming } from './rhythm.js'
import { peekClosing, consumeClosing, describeClosingAge } from './closure.js'
import { 关系记忆条, 纪念日条, 记纪念日已提示 } from './记忆入口.mjs'
import { QQ记忆来源, 绑定QQ会话, 投递QQ记忆来源, 登记QQ来源投递, 主人专属会话 } from './记忆核心.mjs'
import { slotMemeCue } from './voiceSlots.js'
import { scopedFeelContext, rememberFeelDelivery } from './感受.mjs'
// OCAI 2026-11-02：将 execFileSync 提到模块顶层导入，避免在 deliver 的 candidates 循环内重复动态 import
import { execFileSync } from 'node:child_process'
// OCAI 2026-11-02：导入 node:fs 以支持在被打断（取消词）和投递前联动读写状态/别扭/怨/参数表
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { receiptStore } from './receipt-store.mjs'
// 0.15.2 移植 2026-11-24：已归档会话不投，别为一个注定不投的会话白拉 agent。
import { isArchived } from './archive.js'

/**
 * 查路由表：这个 QQ 号/群该投到哪个 DSH 会话。
 * 配置形如 routes.private["1000000001"] = { sessionId, prefix }。
 */
export function routeOf(cfg, kind, id) {
  const table = cfg !== null && cfg !== undefined ? cfg.routes?.[kind] : null
  if (table === null || typeof table !== 'object') return null
  const key = String(id ?? '')
  if (key === '') return null
  const route = table[key]
  return route !== null && typeof route === 'object' ? route : null
}

/**
 * 取这个 QQ 号/群对应的会话 id。
 * 没配置就返回空字符串 —— 调用方据此跳过投递（未配置的 peer 一律忽略，不再兜底到最近会话）。
 * （旧单路由字段在 config.js 的 loadConfig 里已一次性迁进 routes，这里只认 routes。）
 */
export function pickSessionId(cfg, kind, id) {
  const route = routeOf(cfg, kind, id)
  if (route !== null && typeof route.sessionId === 'string' && route.sessionId !== '') return route.sessionId
  return ''
}

/** 文本前缀：优先用路由里配的，其次按类型给默认值。 */
export function prefixOf(cfg, kind, id, fallback) {
  const route = routeOf(cfg, kind, id)
  if (route !== null && typeof route.prefix === 'string' && route.prefix !== '') return route.prefix
  return fallback
}

let lastNoAgentNote = 0
/** 私聊批次按原消息顺序交错正文与该消息的附件块。 */
export function 组装私聊内容块(items, leadingText = '') {
  const list = Array.isArray(items) ? items : []
  const leading = String(leadingText ?? '')
  const hasMedia = list.some((item) => (Array.isArray(item?.images) && item.images.length > 0) || (Array.isArray(item?.files) && item.files.length > 0))
  if (!hasMedia) {
    const text = leading + list.map((item) => String(item?.text ?? '')).join('\n')
    return text === '' ? [] : [{ type: 'text', text }]
  }
  const out = []
  let prefix = leading
  for (const item of list) {
    const text = String(item?.text ?? '')
    if (text !== '' || prefix !== '') {
      out.push({ type: 'text', text: prefix + text })
      prefix = ''
    }
    for (const block of Array.isArray(item?.images) ? item.images : []) out.push(block)
    for (const block of Array.isArray(item?.files) ? item.files : []) out.push(block)
  }
  if (prefix !== '') out.unshift({ type: 'text', text: prefix })
  return out
}
/** 从带有整批正文的 opener 中分离其前缀。 */
export function 取有序前缀(opener, originalText) {
  const full = String(opener ?? '')
  const body = String(originalText ?? '')
  if (body === '') return full
  return full.endsWith(body) ? full.slice(0, -body.length) : full
}

/** 有序媒体模式下只保留额外前缀，整批原话已按消息顺序单独组装。 */
export function 组装有序投递块(opener, originalText, orderedContent) {
  const full = String(opener ?? '')
  const body = String(originalText ?? '')
  const prefix = body !== '' && full.endsWith(body) ? full.slice(0, -body.length) : full
  const blocks = []
  if (prefix !== '') blocks.push({ type: 'text', text: prefix })
  for (const block of Array.isArray(orderedContent) ? orderedContent : []) blocks.push(block)
  return blocks
}

/** 确保消息对象带 id —— 缺 id 会被 DSH 判成 corrupt（"lacks an identified message"）。 */
function ensureId(message) {
  if (message !== null && typeof message === 'object' && typeof message.id === 'string' && message.id !== '') return message
  return { ...(message ?? {}), id: randomUUID() }
}

function deliveryTimeHint(now, priorMessageAt, firstMessageAt) {
  const stamp = (at) => bjDate(at).toISOString().slice(0, 16).replace('T', ' ')
  const current = stamp(now)
  let line = `本批投递时间 ${current}（北京时间）`
  const hasOriginalTime = Number.isFinite(firstMessageAt) && firstMessageAt > 0 && firstMessageAt <= now
  if (hasOriginalTime) {
    line += `，本批首句发于 ${stamp(firstMessageAt)}`
    const delayMinutes = Math.floor((now - firstMessageAt) / 60_000)
    if (delayMinutes >= 60) {
      const hours = Math.floor(delayMinutes / 60)
      const minutes = delayMinutes % 60
      line += `（从发言到投递 ${hours} 小时${minutes ? ` ${minutes} 分钟` : ''}）`
    }
  }
  if (Number.isFinite(priorMessageAt) && priorMessageAt > 0 && priorMessageAt <= now) {
    const previous = stamp(priorMessageAt)
    line += `，上一批来信 ${previous.slice(0, 10) === current.slice(0, 10) ? previous.slice(11) : previous}`
    if (hasOriginalTime && firstMessageAt >= priorMessageAt) {
      const gapMs = firstMessageAt - priorMessageAt
      const gap = gapMs < 60_000 ? `${Math.floor(gapMs / 1000)} 秒` : `${Math.floor(gapMs / 60_000)} 分钟`
      line += `（到本批首句间隔 ${gap}）`
    }
  }
  return `（可观测运行信息：${line}；这不是用户事实或内心状态。）\n`
}

function makeDeliveryMessage(ctx, content, source) {
  try {
    const llm = serviceOf(ctx, 'llm')
    if (typeof llm?.createUserMessage === 'function') {
      try {
        return ensureId(llm.createUserMessage({ content, source }))
      } catch (error) {
        if (!source.qq) throw error
        note('deliver', '宿主拒绝扩展的 QQ 来源字段，使用基础来源格式')
        return ensureId(llm.createUserMessage({ content, source: { kind: source.kind } }))
      }
    }
  } catch (error) {
    note('deliver', `消息工厂不可用，使用带 id 的本地消息：${error?.message ?? error}`)
  }
  return ensureId({ role: 'user', content, source })
}

/**
 * 取消词（2026-10-31 肥鱼加）：用户想「别找了 / 取消」时用的。
 * 只收明确的打断话术；「停」单字太容易误伤正常聊天，所以只认「停一下/停下来」。
 */
// 2026-11-01 肥鱼改：词表收窄成明确的指令式说法，去掉「够了/收手/停手/就停/别弄了/别搞了/别忙了」——
// 这些在日常句子里太常见，一撞就开窗口、吞正常回复。
const CANCEL_RE = /别找了|不用找了|取消了|取消掉|别再找|到此为止/

/**
 * 去掉「提到」只留「指令」。2026-11-04 加。
 *
 * 以前直接拿原文跑 CANCEL_RE，于是这些都会触发静默窗口：
 *   「以后你说「别找了」我就停」（在讨论这个词）
 *   「他说别找了 我当时没听见」（在转述）
 * 真实语料里 20 条命中里就有好几条是这种，白开一次静默、还扣了耐心。
 * 引号里的内容一律当成"提及"，不算指令。
 */
function stripMentions(text) {
  return String(text ?? '')
    .replace(/「[^」]{0,60}」/g, '')
    .replace(/『[^』]{0,60}』/g, '')
    .replace(/“[^”]{0,60}”/g, '')
    .replace(/‘[^’]{0,60}’/g, '')
    .replace(/"[^"]{0,60}"/g, '')
}

/** 这条是不是真的在喊停（而不是在讨论「别找了」这个词）。 */
export function isCancelText(text) {
  const body = String(text ?? '').split('[这段时间的群聊]')[0]
  return CANCEL_RE.test(stripMentions(body))
}

export async function deliver(ctx, preferredId, text, target, imageBlocks, options) {
  const config = getConfig()
  // 2026-10-31 肥鱼：用户喊停 —— 先回一句「停了」，再把她 60 秒内的出站静默掉。
  // ⚠️ 只看「这一条消息本身」：群聊正文后面会拼一段 [这段时间的群聊] 上下文，
  //    里头只要有人说过「别找了」，整条就会被误判成取消（踩过一次，连自己发的消息都被吞）。
  const cancelText = String(text ?? '').split('[这段时间的群聊]')[0]
  // OCAI 2026-11-02：读取参数表「拟人」与「阈值」段，供被打断扣耐心及投递静默/收尾联动使用
  let DPRM = {}
  try {
    for (const _pp of [`${QQ_WS}/共享/工具/参数.json`, 'B:/肥鱼/工具/参数.json']) {
      if (existsSync(_pp)) {
        const _pj = JSON.parse(readFileSync(_pp, 'utf8'))
        DPRM = { ...(_pj?.['阈值'] || {}), ...(_pj?.['拟人'] || {}) }
        break
      }
    }
  } catch { /* 用默认 */ }
  const T = (k, d) => (DPRM && Number.isFinite(Number(DPRM[k])) ? Number(DPRM[k]) : d)
  if (isCancelText(cancelText)) {
    // MUTE_ON_CANCEL 2026-11-03：喊停就开静默，正在跑的那轮也发不出去
    // 2026-11-04 修：90 秒比取消窗口（60 秒）长，窗口过期后她还被 mute 压着，
    // 表现是「喊停后 60~90 秒之间完全不理人」。压到 60 秒与窗口对齐。
    try { muteFor(targetKeyOf(target), 60000) } catch { /* 忽略 */ }

    // 2026-11-01 肥鱼：桥不再说「好，停了」（太机械）。只开窗口，放行第一句话让模型自己收尾。
    note('deliver', '收到取消词：开窗口（放行一句收尾，不再自动回「停了」）')
    markCancelled(targetKeyOf(target))
    // OCAI 2026-11-02：被打断（取消词）联动别扭.json与状态.json短期耐心——别扭期间被打断，短期耐心掉得更狠
    try {
      let sulking = false
      for (const bp of [`${QQ_WS}/记忆/别扭.json`, 'B:/肥鱼/记忆/别扭.json']) {
        if (existsSync(bp)) {
          const r = personRecordOf(JSON.parse(readFileSync(bp, 'utf8')), target, config.peerUin)
          sulking = Boolean(r && Number(r.until) > Date.now())
          break
        }
      }
      const drop = Math.round(T('打断_扣耐心', 5) * (sulking ? T('别扭_打断倍率', 2.0) : 1))
      for (const sp of [`${QQ_WS}/记忆/状态.json`, 'B:/肥鱼/记忆/状态.json']) {
        if (existsSync(sp)) {
          // P1 2026-11-16（批次576）：不再锁外整档覆盖状态.json，改走 耐心.mjs 的唯一判据。
          // ST_BASE 把目录传给子进程，Windows/沙盒也能落到同一个记忆目录。
          execFileSync('/usr/local/bin/node', [
            `${QQ_WS}/共享/工具/耐心.mjs`, '--扣', String(drop),
          ], {
            encoding: 'utf8', timeout: 5000,
            env: { ...process.env, ST_BASE: sp.replace(/[\\/][^\\/]+$/, ''), NODE_OPTIONS: '' },
          })
          break
        }
      }
    } catch { /* 扣耐心失败不影响取消窗口 */ }
  }
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    note('deliver', 'host has no agents service')
    return ''
  }

  // 2026-11-19：QQ 不能挪进别人的宿主上下文；记忆分库挡不住宿主自己的旧消息。
  const candidates = [preferredId]
  const trackedNudge = options?.proactive === true && options.sourceKind === 'nudge'
    && typeof options.proactiveReceiptToken === 'string' && options.proactiveReceiptToken !== ''
  for (const sessionId of candidates) {
    if (sessionId === '') continue
    if (isArchived(sessionId)) {
      note('deliver', `${sessionId} 已归档，跳过投递 target=${target?.kind ?? ''}:${target?.id ?? ''}`)
      continue
    }
    let agent = await ensureAgent(ctx, sessionId)
    // COLD_WAIT 2026-11-16（批次581）：冷启动竞态。
    // 实测 21:02:18 主人戳的那一下：17.2 开始冷启动，18.3 戳到，
    // ensureAgent 因为 10 秒防重入直接返回 undefined，deliver 静默把戳丢了；
    // 20.5 冷启动成功，但模型只看到 21:02:16 的「你」，根本没看到戳。
    // 这里最多等 6 秒（200ms 一次），等 agent 出来再投；等不到再按老行为放弃。
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
      const 等到 = Date.now() + 6000
      let 等过 = false
      while (Date.now() < 等到) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        agent = await ensureAgent(ctx, sessionId)
        if (agent !== undefined && agent !== null && typeof agent.followup === 'function') {
          等过 = true
          break
        }
      }
      if (等过) note('deliver', `冷启动等待后拿到 agent key=${sessionId}`)
    }
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') continue
    if (trackedNudge && String(agent.session?.id ?? '') !== String(sessionId)) return ''
    // STATE_TO_CONTEXT 2026-11-07（批次197）：投递前把「这批在跟谁说话」写给 context 注入用。
    // 私聊 peer=对方 QQ；群聊必须传 voicePeer=发言者（target.id 是群号，不是人）；
    // 工程模式经 voiceMute 不注入。这是唯一写点：所有投递（私聊/群聊/轮询/WS）都过 deliver。
    try {
      const __vp = options && options.voicePeer !== undefined ? options.voicePeer : String(target?.id ?? '')
      markVoiceTarget(agent, { peer: String(__vp ?? ''), isPrivate: String(target?.kind ?? '') === 'private', mute: Boolean(options?.voiceMute), lastText: String(options?.voiceText ?? text ?? '').split('[这段时间的群聊]')[0].slice(0, 120) })
    } catch { /* 写不进就当这轮没有状态提示 */ }

    // 只走宿主服务，绝不 import 官方包：插件装在 workspace 或 ~/.dsh/plugins 下时，
    // Node 从插件真实路径往上找 node_modules，碰不到 DSH 安装目录里的 @deepseek-ai/*，
    // 而 profile 的 node_modules/@deepseek-ai 里也只有 cosmokit / schemastery。
    // 不管走哪条路，最后都过一遍 ensureId：宁可多一层，也不要再写坏一条会话。
    // SRC_KIND 2026-11-08（批次240）：nudge 不是「用户发言」。
    // dsh-rofm 归档时按 source.kind 判断这段算不算对话（lib/surface.js 的
    // CONVERSATION_USER_SOURCE_KINDS），默认写 'user' 会把「（主动搭话：距上次说话…）」
    // 整段当成主人说的话存进记忆库 —— 实测 769 条记忆里 89.6% 是这类模板/nudge，
    // α 均值被稀释到 0.057，高 α 召回通道（thetaHigh=0.6）零命中。
    // 传 sourceKind='nudge' 让它照常进上下文（role 还是 user，她看得见），但不进记忆。
    const srcKind = (options && typeof options.sourceKind === 'string' && options.sourceKind !== '')
      ? options.sourceKind
      : 'user'
    const source = { kind: srcKind }
    const isQQ = target?.kind === 'private' || target?.kind === 'group'
    const proactiveReceiptToken = trackedNudge ? options.proactiveReceiptToken : ''
    if (trackedNudge) {
      source.qq = { proactiveReceiptToken, chatKind: String(target?.kind ?? ''), chatId: String(target?.id ?? '') }
    } else if (isQQ) {
      const qq = QQ记忆来源(
        target, options?.voicePeer, options?.memorySource?.queryText ?? options?.recallText,
      )
      if (qq) source.qq = qq
    }

    try {
      // ---- 回复前先把静默补足 ----
      // 为什么在这里而不是在下游：只有这一处拿得到「这次投递属于哪个 QQ 号/群」。
      // 关着的时候（replyQuietMs=0）waitQuiet 立刻返回，等于完全没有开销。
      const quietKey = targetKey(target)
      // 只让别扭/怨影响收尾续接；静默时长由显式配置决定。
      const _linkSt = (() => {
        let sulking = false, grudgeLv = 0
        try {
          for (const bp of [`${QQ_WS}/记忆/别扭.json`, 'B:/肥鱼/记忆/别扭.json']) {
            if (existsSync(bp)) {
              const r = personRecordOf(JSON.parse(readFileSync(bp, 'utf8')), target, config.peerUin)
              sulking = Boolean(r && Number(r.until) > Date.now())
              break
            }
          }
          for (const yp of [`${QQ_WS}/记忆/怨.json`, 'B:/肥鱼/记忆/怨.json']) {
            if (existsSync(yp)) {
              const r = personRecordOf(JSON.parse(readFileSync(yp, 'utf8')), target, config.peerUin)
              grudgeLv = Number(r?.level ?? 0)
              break
            }
          }
        } catch { /* 读不到按默认 */ }
        return { sulking, grudgeLv }
      })()
      const baseQuietMs = quietMsFromConfig()
      const quietMs = baseQuietMs
      if (quietKey !== '' && quietMs > 0) {
        const waited = await waitQuiet(quietKey, quietMs)
        if (waited.waitedMs > 0) {
          note('deliver', `补静默 ${waited.waitedMs}ms 后投递 key=${quietKey}${waited.budgetExceeded === true ? '（超预算放行）' : ''}`)
        }
      }

      // ---- 这次开口前，先告诉她上次聊到哪儿停的 ----
      // 收尾（qq_close）的意义全在这一步：记下来却不带给她，等于没记。
      // peekClosing 自带去重（一条收尾只带一次）和时效（超过 24 小时不再提），
      // 否则就重演「表情标记说明」那件事 —— 同一句凑在每轮正文里反复烧 token。
      let opener = text
      // 2026-11-04：收尾先只"看"，等 followup 真投出去了再标已告知（否则失败一次就白丢）
      let pendingClosing = null
      if (quietKey !== '') {
        const closing = peekClosing(quietKey)
        pendingClosing = closing
        if (closing !== null && (closing.summary !== '' || closing.next !== '')) {
          const lines = []
          // 2026-11-04：把「隔了多久」一起给她。只给内容不给时间，
          // 她会把 8 小时前的停顿当成刚聊完，一开口就"接着上次"。
          const age = describeClosingAge(Date.now() - Number(closing.at))
          const when = age.label !== '' ? `（${age.label}）` : ''
          if (closing.summary !== '') lines.push(`上次聊到${when}：${closing.summary}`)
          if (closing.next !== '' && !_linkSt.sulking && _linkSt.grudgeLv < T('怨_提门槛', 30)) {
            lines.push(age.resume
              ? `可以从这儿接着聊：${closing.next}`
              : `上次停在这儿：${closing.next}（这是${age.label || '一阵子前'}停的，别当成刚聊完，自然起头就行）`)
          }
          if (lines.length > 0) {
            opener = `（${lines.join('；')}）\n${text}`
            note('deliver', `带上上次收尾 key=${quietKey}`)
          }
        }

        // ---- 记忆卡：她对这个人的认识，常驻 ----
        // 跟收尾提示不同，这个**每回合都带**（所以才要严格控制长度，见 memory.js）。
        // 重启后她对某个人的称呼和几条事实还在 —— 这就是「关系持久化」的全部意义。
        const memory = 关系记忆条(quietKey, config)
        if (memory !== '') opener = `${memory}\n${opener}`
      }

      // 2026-11-19：用这次真实来信做查词，不从群聊引用、状态提示或主动搭话取查询词。
      if (config.memoryEnabled !== false && srcKind === 'user' && !options?.proactive && source.qq?.queryText) {
        const 梗 = slotMemeCue({ target, lastText: source.qq.queryText })
        if (梗) opener = `${梗}\n${opener}`
      }
      const 纪念日 = srcKind === 'user' && !options?.proactive && !options?.voiceMute
        ? 纪念日条(target, config, sessionId)
        : null
      if (纪念日) opener = `${纪念日.text}\n${opener}`
      if (isQQ) {
        const priorMessageAt = target.kind === 'private' ? options?.previousMessageAt : undefined
        const firstMessageAt = target.kind === 'private' && Array.isArray(options?.messageTimes)
          ? options.messageTimes[0]
          : undefined
        opener = deliveryTimeHint(Date.now(), priorMessageAt, firstMessageAt) + opener
      }
      const before = maxEventSeq(agent)
      let recalledIds = []
      let lifeRefs = []
      if (config.memoryEnabled !== false && !options?.voiceMute && 投递QQ记忆来源(agent.session, sessionId, target, options, config)) {
        if (options.lifeMemory && 主人专属会话(target, config) === sessionId) {
          opener = `${options.lifeMemory.text}\n${opener}`
          lifeRefs = options.lifeMemory.refs
          source.qq.lifeHit = true
        }
        const residue = scopedFeelContext(`${target.kind}-${target.id}`, Date.now(), source.qq.queryText)
        if (residue.text) opener = `${residue.text}\n${opener}`
        recalledIds = residue.ids
      }
      // 图片作为独立的 image 块跟在文本后面（会话格式：{type:'image', attachment: ImageAttachmentRef}）
      const blocks = Array.isArray(options?.orderedContent)
        ? 组装有序投递块(opener, text, options.orderedContent)
        : Array.isArray(imageBlocks) && imageBlocks.length > 0
          ? [{ type: 'text', text: opener }, ...imageBlocks]
          : [{ type: 'text', text: opener }]
      note('diag', `deliver session=${sessionId} agent=${agent === undefined || agent === null ? 'undefined' : 'ok'} ctx=${ctx === undefined ? 'undefined' : 'ok'}`)
      // PRECHECK_INBOX 2026-11-16（批次587）：precheck 刚把这条消息并进当前回合，
      // 这里就别再排下一回合了。否则同一句话会在 turn/end 后原样再投一次，
      // 白烧一整轮上下文（22:23 实测 60.6k token）。
      const 这批QQ = Array.isArray(options?.qqMessageIds) ? options.qqMessageIds : []
      if (这批QQ.length > 0 && allConsumedIncoming(targetKeyOf(target), 这批QQ)) {
        note('deliver', `precheck 已并入本回合，跳过重复投递 ${这批QQ.length} 条`)
        return sessionId
      }
      const userMessage = makeDeliveryMessage(ctx, blocks, source)
      if (proactiveReceiptToken !== '') {
        if (typeof options?.proactiveBeforeStage === 'function' && options.proactiveBeforeStage() !== true) return ''
        const qqSource = userMessage?.source?.qq
        if (agent.session?.id !== sessionId || userMessage?.role !== 'user' || userMessage?.source?.kind !== 'nudge'
          || String(qqSource?.proactiveReceiptToken ?? '') !== proactiveReceiptToken
          || String(qqSource?.chatKind ?? '') !== String(target?.kind ?? '')
          || String(qqSource?.chatId ?? '') !== String(target?.id ?? '')) {
          throw new Error('proactive receipt source metadata was not preserved; followup rejected')
        }
        const staged = receiptStore.stage({
          token: proactiveReceiptToken,
          sessionId,
          sourceMessageId: userMessage.id,
          target,
          materialIds: Array.isArray(options?.proactiveMaterialIds) ? options.proactiveMaterialIds : [],
          laterId: options?.proactiveLaterId,
          guardToken: options?.proactiveGuardToken,
          chargeDailyQuota: options?.proactiveChargeDailyQuota !== false,
          now: Date.now(),
        })
        if (staged.blocked || staged.duplicate || staged.token !== proactiveReceiptToken || staged.status !== 'pending') {
          note('deliver', `主动搭话被回执状态挡住（${staged.blocked ? 'blocked' : staged.duplicate ? 'duplicate' : 'status=' + staged.status}，cooldownUntil=${Number(staged.cooldownUntil) || 0}）`)
          return ''
        }
      }
      let bound = false
      let liveConfig
      if (isQQ) {
        liveConfig = getConfig()
        bound = agent.session?.id === sessionId && 绑定QQ会话(agent.session, target, liveConfig)
        if (!userMessage.source?.qq || !bound) {
          note('deliver', `拒绝 QQ 投递：宿主来源或会话独占绑定未通过（${sessionId}）`)
          return ''
        }
      }
      if (isQQ && liveConfig.enableKnowledgeReviewLookup === true && sessionId === preferredId) {
        const trusted = 投递QQ记忆来源(agent.session, sessionId, target, { ...options, lifeMemoryHit: lifeRefs.length > 0 }, liveConfig)
        if (trusted && userMessage.role === 'user' && userMessage.source?.kind === 'user'
          && Object.keys(trusted).every((key) => userMessage.source.qq?.[key] === trusted[key])) {
          登记QQ来源投递(agent.session, userMessage, { bound, incoming: options?.memorySource, config: liveConfig })
        }
      }
      agent.followup(userMessage)
      if (isQQ) rememberFeelDelivery(agent.session, userMessage.id, recalledIds, lifeRefs)
      记纪念日已提示(纪念日)
      try { rememberStagedInbox(targetKeyOf(target), 这批QQ, userMessage.id) } catch { /* 记不住不影响投递 */ }
      // 投递成功才消费这条收尾；失败/换候选时它仍留给下一次
      try { consumeClosing(quietKey, pendingClosing) } catch { /* 标记失败不影响投递 */ }
      // 记住「这一回合是投给谁的」：qq_pass / qq_close 不给号时靠它兜底（见 rhythm.js）
      rememberDelivery(target)
      if ((trackedNudge || config.autoForwardReply !== false) && target !== undefined) {
        // 入待转发队列（见 outbound.js 的注释）：覆盖会丢前一回合的回复 / 发错 target
        // ---- inactive context 重投回调（2026-10-31）----
        // 回合因冷启动/上下文回收失败时，光重挂 agent 不会让那一回合跑起来，
        // 必须把这条消息重新投一次。回调里带上重试计数，最多 2 次。
        const retryCount = Number(options?.retryCount ?? 0)
        const redeliver = !trackedNudge && retryCount < 2
          ? (delayMs) => new Promise((resolve) => {
              setTimeout(() => {
                resolve(deliver(ctx, sessionId, text, target, imageBlocks, { ...options, retryCount: retryCount + 1 }))
              }, Number(delayMs) || 0)
            })
          : undefined
        enqueueOutbound(sessionId, agent, before, target, { ...options, redeliver })
      }
      if (sessionId !== preferredId) note('deliver', `preferred ${preferredId} 没有活 agent，改投 ${sessionId}`)
      return sessionId
    } catch (error) {
      note('deliver', `${sessionId} followup threw ${error instanceof Error ? error.message : error}`)
    }
  }

  const now = Date.now()
  if (now - lastNoAgentNote > 15000) {
    lastNoAgentNote = now
    note('deliver', `没有可用 agent，候选=[${candidates.join(', ')}]`)
  }
  return ''
}
