/**
 * rhythm.js —— 给她「什么时候说话」的主动权。
 *
 * 原插件这条链路是死的：消息进来 → followup → 模型必须说点什么 → 回合结束转发回 QQ。
 * 模型哪怕觉得「这句话没什么可回的」也回不了嘴外的选择，所以永远只能像客服。
 *
 * 这个模块把三种**合法的沉默**变成可实现的操作：
 *   1. 等    —— waitQuiet：回复前先把静默补足，别对方刚发完就秒回
 *   2. 划走  —— suppress：这回合不转发任何东西（掠过就是掠过，不是失败）
 *   3. 收尾  —— 见 closure.js：这段聊到这儿了，不是消失，是记下来下次怎么接
 *
 * 为什么按 target key 而不是 sessionId 记账：
 *   工具被调用时手里有的是 QQ 号/群号，sessionId 要经过路由表反查，多一层就可能查歪；
 *   target key（`group:123` / `private:456`）是它在协议层的真实身份，天然唯一。
 */
import { getConfig } from './config.js'
import { note } from './env.js'

/** target → 最后一次「有人说话」的时间戳（墙钟毫秒）。 */
const lastIncoming = new Map()
/**
 * PRECHECK 2026-11-16（批次582）：target → 最近一次真正投给她的那批消息。
 *
 * 为什么要记：qq_send 发送前要拉一次增量对账，判据是「这条 id 她这一回合见过没有」。
 * 只记时间不够 —— 同一秒里她自己也可能发消息，靠时间会把两边混在一起。
 */
const deliveredBatch = new Map()
/**
 * STAGED_INBOX 2026-11-16（批次587）：QQ 消息 id → session inbox 里的 UserMessage.id。
 *
 * 为什么需要：precheck 拦下一批新消息时，它们可能已经通过 `agent.followup`
 * 排进 `next-turn`；`privateMerge.drop` 只删合并池，拦不住这一层，于是同一句
 * 话下一回合又开一轮（22:23 实测多烧 60.6k token）。
 */
const stagedInbox = new Map()
/** precheck 已并入当前回合的消息：deliver 晚到时据此跳过重复投递。 */
const consumedIncoming = new Map()
const STAGED_TTL_MS = 2 * 60 * 1000

function stagedKey(peerKey, qqId) {
  return `${String(peerKey ?? '')}\u0000${Number(qqId)}`
}

function pruneStaged(now) {
  for (const [key, entry] of stagedInbox) {
    if (now - entry.at > STAGED_TTL_MS) stagedInbox.delete(key)
  }
}

function pruneConsumed(now) {
  for (const [key, at] of consumedIncoming) {
    if (now - at > STAGED_TTL_MS) consumedIncoming.delete(key)
  }
}

/** inbox 按批收件时，同一 agentMsgId 需要知道对应哪些 QQ 消息。 */
export function rememberStagedInbox(peerKey, qqIds, agentMsgId) {
  const key = String(peerKey ?? '')
  const mid = String(agentMsgId ?? '')
  if (key === '' || mid === '') return
  const now = Date.now()
  const entries = []
  const batch = { agentMsgId: mid, at: now, entries, qqIds: new Set() }
  for (const id of Array.isArray(qqIds) ? qqIds : []) {
    const n = Number(id)
    if (!Number.isFinite(n) || n === 0) continue
    const entryKey = stagedKey(key, n)
    const entry = { agentMsgId: mid, at: now, batch }
    batch.qqIds.add(n)
    entries.push([entryKey, entry])
    stagedInbox.set(entryKey, entry)
  }
  pruneStaged(now)
}

/** 取出并忘掉一条 QQ 消息对应的 inbox id；过期/没记过返回 ''。 */
export function takeStagedInbox(peerKey, qqId) {
  const key = stagedKey(peerKey, qqId)
  const entry = stagedInbox.get(key)
  if (entry === undefined) return ''
  stagedInbox.delete(key)
  if (Date.now() - entry.at > STAGED_TTL_MS) return ''
  return entry.agentMsgId
}

export function peekStagedInboxBatch(peerKey, qqId) {
  const entry = stagedInbox.get(stagedKey(peerKey, qqId))
  if (!entry || Date.now() - entry.at > STAGED_TTL_MS) return null
  return entry.batch ?? { agentMsgId: entry.agentMsgId, at: entry.at, qqIds: new Set([Number(qqId)]), entries: [] }
}

export function dropStagedInboxBatch(peerKey, batch) {
  const key = String(peerKey ?? '')
  if (key === '' || !Array.isArray(batch?.entries)) return false
  for (const [entryKey, entry] of batch.entries) {
    if (stagedInbox.get(entryKey) === entry) stagedInbox.delete(entryKey)
  }
  return true
}

export function restoreStagedInboxBatch(batch) {
  if (!Array.isArray(batch?.entries)) return false
  for (const [key, entry] of batch.entries) stagedInbox.set(key, entry)
  return true
}

/** precheck 把这批消息并入当前回合了：短时标记，晚到的 deliver 不再重复投。 */
export function markConsumedIncoming(peerKey, ids) {
  const key = String(peerKey ?? '')
  if (key === '') return
  const now = Date.now()
  for (const id of Array.isArray(ids) ? ids : []) {
    const n = Number(id)
    if (Number.isFinite(n) && n !== 0) consumedIncoming.set(stagedKey(key, n), now)
  }
  pruneConsumed(now)
}

/** 这批消息是不是都已经由 precheck 并入当前回合（空列表返回 false）。 */
export function allConsumedIncoming(peerKey, ids) {
  const list = (Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((n) => Number.isFinite(n) && n !== 0)
  if (list.length === 0) return false
  const key = String(peerKey ?? '')
  const now = Date.now()
  pruneConsumed(now)
  return list.every((n) => {
    const at = consumedIncoming.get(stagedKey(key, n))
    return Number.isFinite(at) && now - at <= STAGED_TTL_MS
  })
}
export const DELIVERED_TTL_MS = 10 * 60 * 1000
/** 被要求「这回合别转发出去」的 target → 打标记的时间。 */
const suppressed = new Map()

/**
 * 抑制标记的有效期。
 *
 * ⚠️ 为什么必须有过期：qq_pass 之后如果这一回合没走到自动转发
 *   （模型说了话但被别的分支跳过、回合没跑起来、turn/end 丢了），
 *   标记就会一直留着，把**下一次本该正常发出的回复**吃掉 ——
 *   表现成「她突然再也不说话了」，而且日志里只有一句 suppressed，很难查。
 *   所以宁可让它自愈（10 分钟后当没说过），也不要留一个永久开关。
 */
export const SUPPRESS_TTL_MS = 10 * 60 * 1000

/** 把出站目标统一成 `group:123` / `private:456`。 */
export function targetKey(target) {
  const kind = String(target?.kind ?? '').trim()
  const id = String(target?.id ?? '').trim()
  if (kind === '') return ''
  return `${kind}:${id}`
}

/** 每次从 QQ 收到一条消息都打个点（决定补静默要不要续期）。 */
export function markIncoming(key, at) {
  if (key === '') return
  lastIncoming.set(key, Number(at) || Date.now())
}

/**
 * 记下「这一批已经投给她了」。投递路径在 markIncoming 之后调用。
 *
 * PRECHECK_TURN 2026-11-16（批次585）：按批次存数组，不再只留最新一批。
 * 原来第二个回合投递会覆盖第一个回合的游标，导致第一条回复发送前
 * 误以为「第二条已经见过」，发送前对账形同虚设。
 */
export function markDeliveredBatch(key, messages, at) {
  if (key === '') return
  const ids = new Set()
  // GROUP_PRECHECK 2026-11-17（批次667）：顺手记下这批是谁说的。
  // 群聊对账只认「同一个人接着补话」——别人在群里正常聊天不该打断她。
  // 私聊只有一个对端，这个集合恒为 1 个元素，不影响原行为。
  const users = new Set()
  for (const m of Array.isArray(messages) ? messages : []) {
    const id = Number(m?.message_id ?? m?.messageId)
    if (Number.isFinite(id) && id !== 0) ids.add(id)
    const uin = String(m?.sender?.user_id ?? m?.userId ?? '').trim()
    if (uin !== '') users.add(uin)
  }
  if (ids.size === 0) return
  const now = Number(at) || Date.now()
  const arr = deliveredBatch.get(key) ?? []
  const messageAt = Math.max(...(Array.isArray(messages) ? messages : [])
    .map((message) => Number(message?.time) * 1000)
    .filter((value) => Number.isFinite(value) && value > 0), 0)
  // 每次 followup 成功都是一个独立批次。相邻投递可能属于不同回合，
  // 合并它们会让后一批在前一回合的发送前对账里伪装成「已经看过」。
  arr.push({ ids, at: now, messageAt, users })
  const cutoff = now - DELIVERED_TTL_MS
  deliveredBatch.set(key, arr.filter((x) => x.at >= cutoff).slice(-12))
}

/**
 * 取「这一回合开始时她已经见过哪些消息」。
 *
 * @param {string} key
 * @param {number|null} [turnStartMs] 当前回合 turn/start 的时间；null = 退回最新一批
 * @param {number} [maxAgeMs]
 */
export function deliveredCursor(key, turnStartMs, maxAgeMs = DELIVERED_TTL_MS) {
  const k = String(key ?? '')
  const arr = deliveredBatch.get(k)
  if (arr === undefined || arr.length === 0) return null
  const cutoff = Date.now() - Number(maxAgeMs || DELIVERED_TTL_MS)
  const alive = arr.filter((x) => x.at >= cutoff)
  if (alive.length === 0) {
    deliveredBatch.delete(k)
    return null
  }
  const t = Number(turnStartMs)
  if (Number.isFinite(t) && t > 0) {
    // 只有回合开始前已经完成的投递批次才算她看到了；未来批次不能回退采用。
    let best = null
    for (const x of alive) if (x.at <= t) best = x
    return best
  }
  return alive[alive.length - 1]
}

/**
 * LISTEN_TURN 2026-11-16（批次586）：本回合 prompt 里已经有的消息 id。
 *
 * 为什么不能用 deliveredCursor 的单个批次：同一会话里，前一条消息属于回合 A、
 * 后一条属于回合 B 时，回合 B 的游标只含后一条；只听这一批会把 A 的话再端上来。
 * 这里把「本回合所选批次及其之前」的 id 全并起来 —— 回合 A 只排除 A 的，
 * 回合 B 会把 A、B 都排除。
 */
export function deliveredIdsUpTo(key, turnStartMs) {
  const k = String(key ?? '')
  const arr = deliveredBatch.get(k)
  if (arr === undefined || arr.length === 0) return new Set()
  const cur = deliveredCursor(k, turnStartMs)
  if (cur === null) return new Set()
  const ids = new Set()
  for (const x of arr) {
    if (x.at > cur.at) continue
    for (const id of x.ids) ids.add(id)
  }
  return ids
}

/** 发送前拦下的一批也要记成「已见」，否则下一次发送会同一批再拦一次。 */
export function rememberDeliveredIds(key, ids) {
  const arr = deliveredBatch.get(String(key ?? ''))
  if (arr === undefined || arr.length === 0) return
  const cur = arr[arr.length - 1]
  for (const id of Array.isArray(ids) ? ids : []) {
    const n = Number(id)
    if (Number.isFinite(n) && n !== 0) cur.ids.add(n)
  }
}

/**
 * LATENCY_COMP 2026-11-15（批次507）：这个会话最近一条来信是多少毫秒之前。
 *
 * 给「延迟补偿」用：拟人打字停顿要减掉这一轮已经卡掉的时间。
 * 没收到过消息（主动搭话、刚启动）返回 null —— 调用方据此保持原样，不要凭空补时间。
 */
export function incomingAgeMs(key) {
  if (key === '') return null
  const t = lastIncoming.get(key)
  if (!Number.isFinite(t) || t <= 0) return null
  const age = Date.now() - t
  return age >= 0 ? age : 0
}

/**
 * 最近一次投递的目标 —— 给「没给参数的 qq_pass / qq_close」兜底用。
 *
 * 为什么需要：多号并行时，`targetOf(args)` 留空以前一律退回 config.peerUin，
 * 于是在 B 的回合里 qq_pass 抑制的是 A —— B 照旧把话发出去、A 的下一条回复被吃掉。
 * 日志里只会看到「已抑制自动转发 key=private:A」，跟当前对话对不上，极难查。
 * 这里记住「刚投给谁」，把它当成默认值；超过 TTL 就当没有（宁可退回老行为）。
 */
let lastDelivery = null
export const DELIVERY_TTL_MS = 5 * 60 * 1000

export function rememberDelivery(target, at) {
  const key = targetKey(target)
  if (key === '') return
  lastDelivery = { target: { kind: String(target.kind), id: String(target.id) }, key, at: Number(at) || Date.now() }
}

export function recentDelivery(maxAgeMs) {
  if (lastDelivery === null) return null
  const age = Date.now() - lastDelivery.at
  if (age < 0 || age > Number(maxAgeMs || DELIVERY_TTL_MS)) return null
  return lastDelivery.target
}

/** 测试用：清掉「最近投递」（不碰抑制表）。 */
export function clearDelivery() {
  lastDelivery = null
}

/**
 * 这条正文是不是**只有动作描写**（没有一句真正的话）。
 *
 * 为什么需要：主动搭话投进去之后，模型有时会说「（尾巴摆了摆）」来表示「我在，但没话说」。
 * 转发链只认文字，于是 QQ 上真的收到一条「（尾巴摆了摆）」——
 * 用户看到的是莫名其妙的消息，看起来像功能坏了。
 * 判定故意保守：**整条去掉括号内容后什么都不剩**才算，正常聊天里的「（笑）好呀」不受影响。
 */
export function isStageOnly(text) {
  const raw = String(text ?? '').trim()
  if (raw === '') return true
  // 2026-11-04 修：原来只认圆括号，导致「[表情:猫猫]」这种纯方括号的动作描述直接走 false，
  // 后面那条专门剥 [表情:xx] 的正则永远够不着——整条会被原样发到 QQ。
  if (!/[（([[]/.test(raw)) return false
  const stripped = raw
    .replace(/[（(][^（()）]{0,200}[)）]/g, '')
    .replace(/\[[^\]]{0,40}\]/g, '') // [表情:xx] 之类
    .replace(/[\s\u3000。，、…~～！？!?.．·—\-*_`'"“”‘’]/g, '')
  return stripped === ''
}

/**
 * 回复前把静默补足 —— 从**最后一条来信**开始算，不是从现在。
 *
 * 关键细节（移植自 surfcore bridge.js 的 /socialV2/wait）：
 *   等待期间如果又来了新话，`lastIncoming` 会被刷新，剩余时间**从头重算**，
 *   否则「对方连发三条」会在说完第三段之前就抢答 —— 真人不会这么做。
 *   同时给一个总预算，防止有人在群里刷屏把她永久吊住。
 *
 * @param {string} key
 * @param {number} quietMs 需要补的静默（<=0 直接返回，等于关掉这个功能）
 * @param {number} [budgetMs] 最多等多久，超时就放行（默认 60s）
 */
export function waitQuiet(key, quietMs, budgetMs = 60000) {
  const need = Number(quietMs)
  if (!Number.isFinite(need) || need <= 0) return Promise.resolve({ waitedMs: 0, skipped: true })
  if (key === '') return Promise.resolve({ waitedMs: 0, skipped: true })

  const start = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      const last = lastIncoming.get(key) ?? start
      const remaining = need - (Date.now() - last)
      if (remaining <= 0) return resolve({ waitedMs: Date.now() - start })
      const spent = Date.now() - start
      if (spent >= budgetMs) {
        note('rhythm', `补静默超预算 ${spent}ms 后放行（key=${key}，还要 ${remaining}ms）`)
        return resolve({ waitedMs: spent, budgetExceeded: true })
      }
      const step = Math.max(50, Math.min(300, remaining))
      setTimeout(tick, step)
    }
    tick()
  })
}

/** 标记：下一个回合不要自动转发（她主动选择了不说话）。 */
export function suppress(key, why = '') {
  if (key === '') return
  suppressed.set(key, Date.now())
  note('rhythm', `已抑制自动转发 key=${key}${why === '' ? '' : `（${why}）`}`)
}

/**
 * 消费一次抑制标记：命中为真并清掉。
 * ⚠️ 必须一次性消费 —— 留着会把后面本该发出的回复也吃掉。
 * ⚠️ 过期的一律当没打过标记，并清掉，避免无声失。
 */
export function consumeSuppress(key) {
  if (key === '') return false
  const at = suppressed.get(key)
  if (at === undefined) return false
  const aged = Date.now() - Number(at)
  if (Number.isFinite(aged) && aged > SUPPRESS_TTL_MS) {
    suppressed.delete(key)
    note('rhythm', `抑制标记已过期（${Math.round(aged / 1000)}s），当作没划走过`)
    return false
  }
  suppressed.delete(key)
  return true
}

/** 当前有多少 target 被抑制（设置页/排障用）：只列还没过期的。 */
export function suppressedKeys() {
  const now = Date.now()
  const alive = []
  for (const [key, at] of suppressed) {
    if (now - Number(at) <= SUPPRESS_TTL_MS) alive.push(key)
    else suppressed.delete(key)
  }
  return alive
}

/**
 * 从配置取一个限额并夹到区间里，默认 0 = 关掉。
 * 这里统一处理「配置是坏值时怎么办」：坏值一律回默认，绝不让它变成「无限」。
 */
export function clampLimit(value, def, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

/** 读当前该补多少静默（毫秒）。配置关掉就返回 0。 */
export function quietMsFromConfig() {
  const cfg = getConfig()
  return clampLimit(cfg?.replyQuietMs, 0, 0, 60000)
}
