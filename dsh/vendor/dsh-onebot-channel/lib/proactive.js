/**
 * proactive.js —— 主动驱动：没人叫她，她自己想起来找你。
 *
 * 原来整条链只有入站驱动：QQ 来消息 → followup → 回一句。她永远是被动的，
 * 这也是「AI 味」最重的地方之一 —— 真人会在隔了半天之后想起一件事，主动发一句。
 *
 * 这一层补的就是那一格：一个常驻的钟，按条件把「主动搭话」这件事**变成一次正常回合**。
 * 关键设计：不新开一条发送链，也不自己生成文案 —— 只是往同一个会话里投一条内部来信：
 *
 *   （主动搭话：距上次说话 7 小时；上次停在「…」…想说什么就说；没什么想说的就 qq_pass）
 *
 * 于是「说」还是「不说」仍然由模型判断，转发、分条、抑制标记全部复用原有链路。
 * 这条设计红线很重要：如果这里硬拼一句「在吗」发出去，就退化成定时问候机器人了。
 *
 * 主动闸门：总开关、最低间隔、未回应退避、睡眠、允许目标和回执唯一性。
 *
 * 状态落在 ~/.dsh/qq-bridge-proactive.json，重启不丢 —— 否则每次重启都会重新「攒够 6 小时」。
 */
import { readFileSync, existsSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { randomUUID } from 'node:crypto'
import { 原子写JSON, 备份坏档 } from './atomic.js'
// SLEEP_ONE 2026-11-07（批次168）：判睡眠只问这一处
import { 睡着 } from './sleepgate.js'
import { socialCoeff } from './性格系数.mjs'
import { join } from 'node:path'
import { DATA_DIR, note, bjDayKey, bjMinutesOfDay } from './env.js'
import { getConfig } from './config.js'
import { deliver, pickSessionId } from './deliver.js'
import { peekClosing } from './closure.js'
// HORMONE_RELATION 2026-11-05：主动搭话没人应 / 对方又回来了，喂给激素
// TOPIC 2026-11-12（主人：对话系统她还要会自己思考找话题）：话题材料池。
// 只读记忆里的真东西，一条也不生成 —— 说哪件仍然是她自己定。
import { 话题池, 挑新鲜, 记回执话题 } from './话题.mjs'
// LIVE_CHAT 2026-11-17（批次593）：主动搭话起的那一轮不许再排「12 分钟后补一句」，
// 否则一条搭话会变成两条，还能一轮接一轮串下去。
import { receiptStore } from './receipt-store.mjs'
import { sweepProactiveOutbound } from './outbound.js'

/** 主动搭话的状态文件。跟 state / memory / closure 分开，避免 loadState 重建时被吃掉。 */

// METER 2026-11-04：这里原来内联了一份性格系数（而且用的是 require，ESM 下一直抛错被吞），
// 已收拢到 性格系数.mjs 的 traitCoeff()。

export const PROACTIVE_FILE = join(DATA_DIR, 'qq-bridge-proactive.json')

/**
 * 待讲话题（批次302）：她自己翻到、还没跟谁说过的一件事。
 * 写入端是 记忆/回头说.json（批次302 起；原来的 待讲.json 已归档）。
 * 这里只负责把它送进 shouldNudge —— 有话题时空闲/退避让路。
 */
/**
 * 「回头说」到点项（批次302b）：她说过「回头再聊/等下说」的，到点由这里送进 shouldNudge。
 * 存储与消费原来就有（poll.js 临场提示读到点项），但没有任何写入工具，文件一直是空的。
 * 现在 qq_later 负责写，这里只读；只认未完成、到点 24 小时内的，过了就当这个念头淡了。
 */
export const LATER_FILE = process.env.DSH_LATER_FILE || `${QQ_WS}/记忆/回头说.json`
export function topicOf() {
  try {
    if (!existsSync(LATER_FILE)) return null
    const j = JSON.parse(readFileSync(LATER_FILE, 'utf8'))
    const now = Date.now()
    const due = (Array.isArray(j?.items) ? j.items : [])
      .filter((x) => x && !x.done && Number(x.due) > 0 && Number(x.due) <= now && now - Number(x.due) < 24 * 3600e3)
      .sort((a, b) => Number(a.due) - Number(b.due))
    const x = due[0]
    if (!x) return null
    const title = String(x.what ?? '').trim().slice(0, 60)
    return title !== '' ? { title, id: String(x.id ?? ''), at: Number(x.due), sticky: true } : null
  } catch { return null }
}

/** 钟的间隔（毫秒）。不是「每 60 秒就说一次」，是「每 60 秒看一眼该不该说」。 */
export const TICK_MS = 60 * 1000

let proactiveFile = PROACTIVE_FILE
let table = null

/**
 * 写节流：persist() 被频繁调用时（群消息频繁触发 notePeerActivity），
 * 不必每次都立刻写盘。30 秒内只写一次，脏数据攒在内存里。
 * 进程正常退出时 ctx.effect 会调 flushPersist() 兜底。
 */
const PERSIST_INTERVAL_MS = 30_000
let persistTimer = null
let persistDirty = false

/** 测试用：换读写路径并清内存缓存。传空 = 恢复默认。 */
export function useProactiveFile(path) {
  proactiveFile = typeof path === 'string' && path !== '' ? path : PROACTIVE_FILE
  table = null
}

/** 测试用：清空内存态（不删磁盘文件）。 */
export function clearProactiveState() {
  // 设 null 而不是 {}：loadTable 见到 null 会重新读盘。
  // 原来设成 {}，下一次 loadTable 直接返回空表，接着任何 persist 都会把磁盘上
  // 所有目标的记录覆盖成 {} —— 名字叫「清内存」，实际清的是磁盘。
  table = null
}

function loadTable() {
  if (table !== null) return table
  table = {}
  try {
    if (existsSync(proactiveFile)) {
      const parsed = JSON.parse(readFileSync(proactiveFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) table = parsed
    }
  } catch (error) {
    // 批次612：读坏了先改名留证，再让 table 空着重建；
    // 否则下一次 persist 会把坏文件直接覆盖成空表，连证据都没了。
    const 坏 = 备份坏档(proactiveFile, 'corrupt')
    note('proactive', `状态读坏了（${坏 ? '已备份到 ' + 坏 : '备份失败，原文件保留'}）：${error instanceof Error ? error.message : error}`)
  }
  return table
}

function persist() {
  // 写节流：30 秒内只写一次，脏数据攒在内存里。
  // notePeerActivity 在每条消息投递成功后都调用，群消息密集时可能几秒内触发十几次，
  // 每次都 writeFileSync 是不必要的磁盘 I/O。
  persistDirty = true
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!persistDirty) return
    persistDirty = false
    try {
      原子写JSON(proactiveFile, table)
    } catch (error) {
      note('proactive', `状态写失败：${error instanceof Error ? error.message : error}`)
    }
  }, PERSIST_INTERVAL_MS)
}

/** 立刻把内存态写盘（插件卸载 / 进程退出前调用，防丢数据）。 */
export function flushPersist() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!persistDirty) return
  persistDirty = false
  try {
    原子写JSON(proactiveFile, table)
  } catch (error) {
    note('proactive', `状态 flush 失败：${error instanceof Error ? error.message : error}`)
  }
}

function entryOf(key) {
  const t = loadTable()
  const entry = t[key]
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    const fresh = {}
    t[key] = fresh
    return fresh
  }
  return entry
}

/** 只读取一条：不建空条目（否则判定时会把从没聊过的人写进状态文件）。 */
function peekEntry(key) {
  const entry = loadTable()[key]
  return entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry : {}
}

/** 本地日期（YYYY-MM-DD）—— 日配额按本地自然日算，不按 UTC。 */
export function dayKey(at) {
  // 2026-11-04 修：原来用 getFullYear/getMonth/getDate，取的是机器时区（UTC），
  // 所以「日配额」实际在**北京时间 08:00** 重置，不是零点。
  // 注释原本就写着「按本地自然日算，不按 UTC」——意图是对的，实现取错了本地。
  return bjDayKey(at)
}

/**
 * 对方说话了 —— 清退避、记最后互动时间。
 * 由 poll.js 在**投递成功**之后调用（跟 touchPeer 同一个位置）。
 */
export function notePeerActivity(key, at) {
  if (typeof key !== 'string' || key === '') return false
  const now = Number(at) || Date.now()
  const entry = entryOf(key)
  entry.lastIncomingAt = now
  entry.unanswered = 0
  entry.lastAckAt = now
  persist()
  return true
}

/**
 * 记一次主动搭话。
 * 上一句还没人回（lastProactiveAt > lastIncomingAt）→ unanswered 加一，下次要等更久。
 */
export function noteNudge(key, at) {
  if (typeof key !== 'string' || key === '') return false
  const now = Number(at) || Date.now()
  const entry = entryOf(key)
  updateNudgeEntry(entry, now)
  persist()
  return true
}

function updateNudgeEntry(entry, now) {
  const lastIncoming = Number(entry.lastIncomingAt) || 0
  const lastProactive = Number(entry.lastProactiveAt) || 0
  // 上次主动之后有没有人说话？没有就累积「没被回应」次数
  if (now >= lastProactive && lastProactive > 0 && lastIncoming <= lastProactive) {
    entry.unanswered = (Number(entry.unanswered) || 0) + 1
  }
  entry.lastProactiveAt = Math.max(now, lastProactive)
  // 保留按日计数作为审计信息，不参与是否允许入队的判定。
  const __todayKey = dayKey(now)
  if (typeof entry.day !== 'string' || entry.day <= __todayKey) {
    const __sameDay = entry.day === __todayKey
    entry.day = __todayKey
    entry.countToday = (__sameDay ? (Number(entry.countToday) || 0) : 0) + 1
  }
}

export function noteNudgeOnce(key, at, token) {
  if (typeof key !== 'string' || key === '' || typeof token !== 'string' || token === '') return false
  const entry = peekEntry(key)
  const tokens = Array.isArray(entry.receiptTokens) ? entry.receiptTokens : []
  if (tokens.includes(token)) return true
  const updated = { ...entry, receiptTokens: [...tokens, token] }
  updateNudgeEntry(updated, Number(at) || Date.now())
  const next = { ...loadTable(), [key]: updated }
  原子写JSON(proactiveFile, next)
  table = next
  persistDirty = false
  if (persistTimer !== null) clearTimeout(persistTimer)
  persistTimer = null
  return true
}

export function reconcileProactiveReceipt(token) {
  const keyOf = ({ target }) => `${target.kind}:${target.id}`
  try {
    return receiptStore.reconcileAccepted(token, {
      noteNudge: (entry) => entry.chargeDailyQuota === false || noteNudgeOnce(keyOf(entry), entry.acceptedAt, entry.token),
      rememberTopicUse: (entry) => 记回执话题(keyOf(entry), entry.selectedMaterialIds.filter((id) => entry.materialIds.includes(id)), entry.acceptedAt),
      completeLater: (entry) => {
        if (!entry.laterId || !entry.selectedMaterialIds.includes(`later:${entry.laterId}`) || !existsSync(LATER_FILE)) return true
        const data = JSON.parse(readFileSync(LATER_FILE, 'utf8'))
        if (!Array.isArray(data?.items)) return false
        const match = data.items.find((item) => String(item?.id ?? '') === entry.laterId)
        if (!match || match.done) return true
        match.done = true
        match.doneAt = entry.acceptedAt
        原子写JSON(LATER_FILE, data)
        return true
      },
    })
  } catch (error) {
    note('proactive', `已接受回执的本地记账待重放：${error instanceof Error ? error.message : error}`)
    return { reconciled: false, reason: 'effect-persist-failed' }
  }
}

function maintainProactiveReceipts(config, now) {
  const ttlMs = (Number(config.outboundEntryTtlMs) || 150000) + (Number(config.outboundEntryTtlGraceMs) || 60000)
  sweepProactiveOutbound(config, now)
  receiptStore.expirePending(now, ttlMs)
  for (const entry of receiptStore.acceptedAwaitingEffects()) reconcileProactiveReceipt(entry.token)
}

/** 「HH:MM」→ 当日分钟数；格式不对回退到默认值。 */
export function minutesOf(hhmm, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim())
  if (m === null) return fallback
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(mi) || h > 24 || mi > 59) return fallback
  return (h % 24) * 60 + mi
}

/** 当前时刻是否落在静默时段（支持跨午夜，from === to 视为不静默）。 */
export function inQuietHours(minutes, from, to) {
  if (from === to) return false
  return from < to ? (minutes >= from && minutes < to) : (minutes >= from || minutes < to)
}

function clampNumber(value, def, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

/**
 * 该不该主动开口 —— 纯函数，不读盘不联网，方便单测。
 *
 * @param {object} input
 * @param {number} input.now
 * @param {boolean} input.enabled
 * @param {number} input.idleHours      距上次互动至少多久（小时，可小数）
 * @param {number} input.backoffMax     没被回应时最多放大几倍
 * @param {object} input.entry          状态文件里这一条（可空）
 * @returns {{ok:boolean, reason:string, eligibleAt:number}}
 */
export function shouldNudge(input) {
  const now = Number(input?.now) || Date.now()
  const idleHours = clampNumber(input?.idleHours, 6, 0.05, 720)
  const backoffMax = clampNumber(input?.backoffMax, 4, 1, 16)
  const entry = input?.entry !== null && typeof input?.entry === 'object' ? input.entry : {}

  // 新话题可以促成搭话，但不能绕过最低间隔或未回应退避。
  const topicTitle = String(input?.topicTitle ?? '').trim().slice(0, 60)
  const topicAt = Number(input?.topicAt) || 0
  // sticky：到点项（due 在过去）不受「6 小时内」限制 —— 它本来就是「到点了才提」。
  const topicSticky = input?.topicSticky === true
  const topicFresh = topicTitle !== '' && topicAt > 0 && (topicSticky || now - topicAt < 6 * 3600e3)

  if (input?.enabled !== true) return { ok: false, reason: 'off', eligibleAt: 0 }

  const lastIncoming = Number(entry.lastIncomingAt) || 0
  // 从没聊过的人不主动：没有上下文，开口就是陌生推销
  if (lastIncoming <= 0) return { ok: false, reason: 'never-talked', eligibleAt: 0 }
  // IDLE_FROM 2026-11-07（批次200）：空闲基准取「上次来信 / 上次主动」里较晚的。
  // 原来只看 lastIncomingAt：她主动开口、对方回一句之后，下一分钟的 tick
  // 还按旧来信算空闲 —— 门槛一过就一分钟一条，当日配额几分钟烧光（上游 11-02 同款修复）。
  const lastProactive = Number(entry.lastProactiveAt) || 0

  // LIVE_CHAT 2026-11-17（批次594）：退避原来晚一步。
  // noteNudge 是在「这次开口」之后才把 unanswered +1，所以上一条主动还没被回时，
  // 下一次判定读到的仍是 0 —— 实测 01:47 主动搭话没人回，02:00 就会按 1 倍再发一条，
  // 双倍要等到第三次才生效。这里把「上一条还没被回」当场算进去。
  const 上条没被回 = lastProactive > 0 && lastIncoming <= lastProactive
  const unanswered = Math.max(Number(entry.unanswered) || 0, 上条没被回 ? 1 : 0)
  const factor = Math.min(backoffMax, Math.pow(2, Math.max(0, unanswered)))
  // SOCIAL_IDLE 2026-11-03：天生爱热闹的人等不了那么久；系数 0.7~1.4，直接除空闲阈值
  let __social = 1
  try { __social = socialCoeff() } catch { __social = 1 }
  // SOCIAL_FLOOR 2026-11-03：再爱热闹也别低于 45 分钟，防止刷屏
  // LIVE_CHAT 2026-11-17（批次591）：实时对话。原来空闲阈值是死数字（配置 42 分钟），
  // 哪怕她手里刚攒下一件想说的、哪怕两个人十分钟前还在聊，也得干等 42 分钟 ——
  // 结果「自己找话题」只剩整点式的问候感。两个系数只作用在「等多久」上：
  //   · 热度：他两小时内还说过话 → 门槛减半（六小时内 → 0.75）
  //   · 话题：话题池里有还没喂过的新鲜材料 → 再打六折
  // 热度与材料只影响配置闲置门槛，最低间隔和未回应退避独立生效。
  const 热度 = (() => {
    const last = Number(entry.lastIncomingAt) || 0
    if (last <= 0) return 1
    const 小时 = (now - last) / 3600e3
    if (小时 <= 2) return 0.5
    if (小时 <= 6) return 0.75
    return 1
  })()
  const 有话题 = input?.topicReady === true
  const 话题系数 = 有话题 ? 0.6 : 1
  // 地板只在「手里真有材料」时放低；没材料时仍守 36 分钟，别退化成话痨。
  const 地板 = 有话题 ? 0.15 : 0.6
  const __idleBase = Math.max((idleHours / __social) * 热度 * 话题系数, 地板)
  const idleHoursForDecision = input?.force === true && unanswered === 0 ? 地板 : __idleBase
  const idleMs = idleHoursForDecision * 60 * 60 * 1000 * factor
  const eligibleAt = Math.max(lastIncoming, lastProactive) + idleMs
  if (now < eligibleAt) {
    return { ok: false, reason: unanswered > 0 ? 'backoff' : 'not-idle-enough', eligibleAt }
  }

  // 系数只用于观测：出问题时能一眼看出「这次为什么 12 分钟就开口了」。
  return {
    ok: true,
    reason: 'ok',
    eligibleAt,
    via: topicFresh ? 'topic' : 'idle',
    idleMs,
    系数: { 热度, 话题: 话题系数 },
  }
}

/** 把毫秒差写成人话（投进正文的那一行要短）。 */
export function formatGap(ms) {
  const minutes = Math.max(0, Math.round(Number(ms) / 60000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (hours < 24) return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
  const days = Math.floor(hours / 24)
  return `${days} 天`
}

/**
 * 组装投给模型的那条「内部来信」。
 *
 * ⚠️ 必须把「可以不说」写进去：不写的话模型会认为收到了指令，于是硬找一句话发出去，
 *   这一层就退化成定时问候。qq_pass 就是它的出口。
 */
/**
 * 当天手账里「最近 8 小时」的真实事件（最多 5 条）+ 那一觉。
 * 读不到、格式不对、一条都没有，就返回空数组 —— 宁可不说，也不编。
 */
function 今日素材(now) {
  const out = []
  const 窗 = 8 * 3600e3
  try {
    // 跨日也要有素材：0 点后 手账-今天.md 还没生成（15:35 才写），
    // 所以昨天和今天两份都看，按绝对时间取最近 8 小时。
    for (const day of [bjDayKey(now - 86400e3), bjDayKey(now)]) {
      const p = `${QQ_WS}/记忆/手账-${day}.md`
      if (!existsSync(p)) continue
      const text = readFileSync(p, 'utf8')
      for (const line of text.split('\n')) {
        const m = line.match(/^- (\d{2}):(\d{2}) · (.+)$/)
        if (!m) continue
        const at = Date.parse(`${day}T${m[1]}:${m[2]}:00+08:00`)
        if (!Number.isFinite(at)) continue
        if (at > now) continue
        if (now - at > 窗) continue
        out.push({ at, text: `${m[1]}:${m[2]} ${m[3].trim()}` })
      }
    }
    out.sort((a, b) => a.at - b.at)
    const rows = out.slice(-5).map((x) => x.text)
    // 这一觉只在「刚睡醒那几小时」有用，久了就不是今天的素材了
    const 觉源 = (() => {
      const p = `${QQ_WS}/记忆/手账-${bjDayKey(now)}.md`
      return existsSync(p) ? readFileSync(p, 'utf8') : ''
    })()
    const 觉 = 觉源.match(/^这一觉：(.+)$/m)
    if (觉 && rows.length < 5) {
      // 只在「醒来后 8 小时内」才算今天的素材，不然半夜还挂着 13 小时前的觉
      const 尾 = 觉[1].match(/→\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2}):(\d{2})/)
      const 醒 = 尾 ? Date.parse(`${尾[1]}T${尾[2]}:${尾[3]}:${尾[4]}+08:00`) : NaN
      if (Number.isFinite(醒) && now - 醒 >= 0 && now - 醒 <= 8 * 3600e3) rows.push('这一觉 ' + 觉[1].trim())
    }
    return rows
  } catch {
    return []
  }
}

export function composeNudge(key, entry, now, topic = null, 料 = []) {
  const lastIncoming = Number(entry?.lastIncomingAt) || now
  // NUDGE_CLOCK 2026-11-07（批次199）：11-07 她自然醒后主动搭话，手里只有「距上次说话 8 小时多」
  // 这一个数字，就把 8 小时脑补成了「一晚上没见」——实际上次说话是早上 6 点（她睡前），
  // 间隔全在大白天，而且她自己刚睡醒 8 小时。给时刻锚点（跨天带日期），她自己对得上；
  // 还是只递事实，怎么开口照旧归她。
  const bj = bjMinutesOfDay(lastIncoming)
  const 时刻 = String(Math.floor(bj / 60)).padStart(2, '0') + ':' + String(bj % 60).padStart(2, '0')
  const 同天 = bjDayKey(lastIncoming) === bjDayKey(now)
  const 上次 = 同天 ? 时刻 : 时刻 + '（' + bjDayKey(lastIncoming).slice(5) + '）'
  const lines = [`（主动搭话：距上次说话已经 ${formatGap(now - lastIncoming)}，上次是 ${上次}。`]
  if (topic && topic.title) lines.push(`你之前记着到点要跟他说：「${topic.title}」。${topic.id ? `（材料编号 later:${topic.id}）` : ''}`)
  const closing = peekClosing(key)
  if (closing !== null) {
    const parts = []
    if (closing.summary !== '') parts.push(`上次聊到「${closing.summary}」`)
    if (closing.next !== '') parts.push(`可以从「${closing.next}」接着聊`)
    if (parts.length > 0) lines.push(`${parts.join('，')}。`)
  }
  // DAY_MATERIAL 2026-11-08（批次295）：她今天真做过的事。只列事实，
  // 「提不提、提哪件」还是她自己定 —— 这一层从来只递材料，不替她开口。
  const 素材 = 今日素材(now)
  if (素材.length > 0) {
    lines.push('\n今天你做过这些（都是真的发生过的，提不提、提哪件你自己定）：')
    for (const row of 素材) lines.push('\n- ' + row)
    lines.push('\n')
  }
  // TOPIC 2026-11-12：原来只有「距上次说话 X 小时」和今天的流水账，她手里没有
  // 一件「想说的」，于是开口就容易变成报时间或「在干嘛」。这里把真材料摊开，
  // 再明确要求她自己挑 —— 仍然不替她写一句话。
  if (Array.isArray(料) && 料.length > 0) {
    lines.push('\n你手上这些是真的（提不提、提哪条、怎么讲都你定）：')
    for (const x of 料) lines.push('\n- [' + String(x.类 || '') + '] ' + String(x.文 || '') + '（材料编号 ' + x.id + '）')
    lines.push('\n')
    lines.push('这次是你先开口，不是接他的话 —— 说什么、从哪句起，你自己想。')
    lines.push('不一定要用上面这些，你脑子里这会儿冒出来的那件事可能更好。')
    lines.push('同一个话题别连着说两次，也别拿「在干嘛 / 吃了吗」这种空话开头。')
  }
  lines.push('这会儿是什么状态、想不想开口，你比我清楚：')
  lines.push('要是不想说话，qq_pass 就行——安静也是回应。')
  // 这条踩过：模型会回「（尾巴摆了摆）」表示「我在但没话说」，而正文会被原样发到 QQ，
  // 他收到一条莫名其妙的表情动作 —— 看起来像插件坏了。必须写清楚「动作不是回答」。
  lines.push('要开口：用一次 qq_send，明确本次对象，只发送纯文字；材料编号不写进正文。实际用了哪项才在 proactive_material_ids 选填，不确定就留空。想安静就 qq_pass，不要用动作描写代替。）')
  return lines.join('')
}

/**
 * 这个对象允不允许主动搭话。
 *
 * 设置页的白名单是**空的就全放开**（老行为，别让升级完突然谁都不理）；
 * 一旦填了人，就只对名单里的人生效。只认 `private:<数字>`：
 * 脏数据（手改错的、旧版本写进去的别的形态）会被忽略掉，
 * 否则一个笔误就能让整条功能静默失效，排查起来极其恶心。
 */
export function targetAllowed(config, key) {
  const raw = config?.proactiveTargets
  if (!Array.isArray(raw)) return true
  const clean = raw
    .map((v) => String(v ?? '').trim())
    .filter((v) => /^private:\d+$/.test(v))
  if (clean.length === 0) return true
  return clean.includes(String(key))
}

/** 有会话、可主动的对象（只做私聊：群里 @ 才投递，主动进群打扰不是这个功能的目的）。 */
export function candidates(config = getConfig()) {
  const table = config?.routes?.private
  if (table === null || typeof table !== 'object') return []
  const out = []
  for (const uin of Object.keys(table)) {
    const sessionId = pickSessionId(config, 'private', uin)
    if (sessionId === '') continue
    const key = `private:${uin}`
    // 白名单在这里就筛掉：名单外的人连「该不该开口」都不必算
    if (!targetAllowed(config, key)) continue
    const target = { kind: 'private', id: String(uin) }
    out.push({ key, uin: String(uin), target, sessionId })
  }
  return out
}

/**
 * 候选排序：最久没被主动过的排最前（从没主动过 = 0，直接顶到最前）。
 *
 * 为什么需要这个：手动「现在试一次」只打一个人，而 Object.keys 的顺序是固定的 ——
 * 连点三次会三次都发给同一个人，另一个人永远轮不到（0.9.1 之前就是这样）。
 * 按「谁最久没被找过」排，连点会自动轮转，也顺便让定时钟的先后更公平。
 */
export function orderByStalest(list) {
  return list.slice().sort((a, b) => {
    const ta = Number(peekEntry(a.key).lastProactiveAt) || 0
    const tb = Number(peekEntry(b.key).lastProactiveAt) || 0
    if (ta !== tb) return ta - tb
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
}

let running = false

/**
 * 跑一轮判定（tick 调它，设置页的「现在试一次」也调它）。
 *
 * @param {object} ctx
 * @param {{force?: boolean, only?: string}} [options]
 *   force = 只跳过配置的空闲时长；总开关、最低间隔、退避、睡眠、白名单和回执限制照常；
 *   only  = 只对这一个 key（`private:123`）动手 —— 设置页每行的「试一次」用它，
 *           顺便也支持「只给某个人手动开一次口」，不用临时改白名单。
 * @returns {Promise<{sent:number, skipped:{key:string, reason:string}[]}>}
 */
export async function runProactiveOnce(ctx, options = {}) {
  const force = options?.force === true
  const only = typeof options?.only === 'string' && options.only.trim() !== '' ? options.only.trim() : ''
  const result = { sent: 0, queued: 0, skipped: [] }
  if (running) {
    note('proactive', '上一轮还没跑完，跳过这一轮')
    return result
  }
  running = true
  try {
    const config = getConfig()
    const now = Date.now()
    maintainProactiveReceipts(config, now)
    // QUIET_HOURS 2026-11-24：配置里的 proactiveQuietFrom/To 一直被定义了却没有任何地方读。
    // 夜里 01:00~07:00 照样每 15 分钟爬起来发一轮主动搭话，上游一拒绝就再烧一整轮
    // 约 2.8 万上下文，一晚上几十轮一句没发出去。这里补上静默时段闸门；
    // 手动 force 触发（「现在就想让她说一句」）放行。
    if (!force) {
      const 起 = minutesOf(config?.proactiveQuietFrom, -1)
      const 止 = minutesOf(config?.proactiveQuietTo, -1)
      if (起 >= 0 && 止 >= 0 && inQuietHours(bjMinutesOfDay(now), 起, 止)) {
        result.skipped.push({ key: '*', reason: 'quiet-hours' })
        return result
      }
    }
    let list = orderByStalest(candidates(config))
    if (only !== '') {
      list = list.filter((item) => item.key === only)
      if (list.length === 0) {
        // 两种可能：没绑会话，或者不在白名单里。前端只显示一句话，就别细分了 —— 都是「这个对象现在不能主动」
        note('proactive', `${only} 不可主动（没绑会话或不在白名单）`)
        result.skipped.push({ key: only, reason: 'not-bound' })
        return result
      }
    }
    if (list.length === 0) {
      note('proactive', '没有可主动的对象（没有配好会话的私聊，或都不在主动名单里）')
      return result
    }
    const topic = topicOf()
    for (const item of list) {
      const entry = peekEntry(item.key)
      // LIVE_CHAT 2026-11-17（批次591）：话题池要在判定之前算 ——「手里有没有新鲜材料」
      // 现在参与空闲门槛，判定完再算就等于这条改动永远不生效。
      const 池 = 挑新鲜(话题池(now), item.key, now)
        .filter((x) => !(topic && topic.title && x.类 === '你记着回头要说的'))
        .slice(0, 5)
      const decision = shouldNudge({
        now,
        force,
        enabled: config?.proactiveEnabled === true,
        idleHours: config?.proactiveIdleHours,
        backoffMax: config?.proactiveBackoffMax,
        key: item.key,
        entry,
        topicTitle: topic?.title,
        topicAt: topic?.at,
        topicSticky: topic?.sticky,
        topicReady: 池.length > 0,
      })
      if (!decision.ok) {
        result.skipped.push({ key: item.key, reason: decision.reason })
        continue
      }
      // SLEEPING_GATE 2026-11-03：睡着的时候不该自己爬起来发消息
      // SLEEP_ONE 2026-11-07（批次168）：判据改问 sleepgate。
      // 原来读 睡眠.json 的 sleeping —— 睡眠阶段.mjs 自己写着「可能被别的路径先改掉，
      // 以 live 为准」，而 作息 --醒了 只改 睡醒.json、压根不动它。
      // 顺手修掉这里写死绝对路径、沙盒里测不了的问题。
      try {
        if (await 睡着()) { result.skipped.push({ key: item.key, reason: 'sleeping' }); continue }
      } catch (error) {
        if (force) {
          note('proactive', `手动主动无法确认睡眠状态，拒绝入队：${error instanceof Error ? error.message : error}`)
          result.skipped.push({ key: item.key, reason: 'sleep-state-unknown' })
          continue
        }
      }
      // QUIET_ENGINEER_PROACTIVE 2026-11-03：冰屋是工程群，她不主动冒泡（除非主人/肥鱼点名）
      if (String(item.key || '').indexOf('806972995') >= 0) {
        result.skipped.push({ key: item.key, reason: 'engineering-group' })
        continue
      }
      // COOLDOWN_SKIP 2026-11-23: the receipt store blocks the same target while the last
      // nudge is in flight or cooling down. Trying anyway just logs a false delivery
      // failure every minute; skip before composing until the cooldown ends.
      const 回执挡住 = typeof receiptStore.blockOf === 'function' ? receiptStore.blockOf(item.target) : null
      if (回执挡住) {
        result.skipped.push({ key: item.key, reason: 'cooldown', until: 回执挡住.until })
        continue
      }
      const text = composeNudge(item.key, entry, now, topic, 池)
      const proactiveReceiptToken = randomUUID()
      // NUDGE_STATE 2026-11-07（批次199）：撤掉 197c 的 voiceMute。197c 的理由「主动搭话没有
      // sender、群号会被当 peer」是错的 —— candidates() 只做私聊，target.id 就是对方 QQ 号。
      // 真正的问题是：主动开口恰恰是她最需要状态的一刻（刚醒/饿着/在店里），而这条路上
      // 从来没有任何状态。11-07 她自然醒后开口就说岔，就是因为在「一晚上没见」那句话之前，
      // 她不知道自己 14:00 才睡醒。现在状态走 systemPrompt.context()（批次197）：不进历史、
      // 每回合刷新，放行即生效，主动搭话不频繁，成本可忽略。
      // 批次240：主动搭话的 nudge 打 sourceKind='nudge' —— 她会看见，但不该被当成「主人说过的话」存进记忆。
      const used = await deliver(ctx, item.sessionId, text, item.target, undefined, {
        proactive: true,
        sourceKind: 'nudge',
        proactiveReceiptToken,
        proactiveMaterialIds: 池.map((material) => material?.id).filter(Boolean),
        proactiveLaterId: topic?.id,
      })
      if (used === '') {
        note('proactive', `${item.key} 投递失败（没有可用会话）`)
        result.skipped.push({ key: item.key, reason: 'deliver-failed' })
        continue
      }
      result.queued += 1
      const 账 = decision?.系数
        ? `；空闲 ${(Number(decision.idleMs) / 60000).toFixed(1)} 分钟 热度×${decision.系数.热度} 话题×${decision.系数.话题}`
        : ''
      note('proactive', `主动搭话已入队待平台确认 ${item.key} -> ${used}（${decision.reason}${force ? '/手动' : ''}${账}）`)
      // 手动触发只打一个人，别一次把所有人问候一遍
      if (force) break
    }
    return result
  } finally {
    running = false
  }
}

/**
 * 启动常驻的钟。返回停止函数（挂到 ctx.effect 的清理里）。
 * 第一次检查故意延后一个周期：开机就发消息最容易吓到人。
 */
export function startProactive(ctx) {
  let stopped = false
  let timer = null
  const tick = async () => {
    if (stopped) return
    try {
      const config = getConfig()
      if (config?.proactiveEnabled === true) await runProactiveOnce(ctx, { force: false })
      else maintainProactiveReceipts(config, Date.now())
    } catch (error) {
      note('proactive', `tick 抛错：${error instanceof Error ? error.message : error}`)
    } finally {
      if (!stopped) timer = setTimeout(() => { void tick() }, TICK_MS)
    }
  }
  timer = setTimeout(() => { void tick() }, TICK_MS)
  note('proactive', `主动搭话的钟已启动（每 ${Math.round(TICK_MS / 1000)} 秒看一次该不该开口）`)
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
}

/** 设置页用：每个人上次主动是什么时候、今天说过几次、还要等多久。 */
export function proactiveSummary() {
  const config = getConfig()
  const now = Date.now()
  const t = loadTable()
  const rows = []
  const seen = new Set()

  function decide(entry, key) {
    const t = topicOf()
    return shouldNudge({
      now,
      enabled: config?.proactiveEnabled === true,
      idleHours: config?.proactiveIdleHours,
      backoffMax: config?.proactiveBackoffMax,
      key,
      entry,
      topicTitle: t?.title,
      topicAt: t?.at,
      topicSticky: t?.sticky
    })
  }

  function row(key, entry, available) {
    const decision = decide(entry, key)
    return {
      key,
      uin: key.startsWith('private:') ? key.slice('private:'.length) : '',
      available,
      enabled: targetAllowed(config, key),
      lastProactiveAt: Number(entry.lastProactiveAt) || 0,
      lastIncomingAt: Number(entry.lastIncomingAt) || 0,
      countToday: entry.day === dayKey(now) ? Number(entry.countToday) || 0 : 0,
      unanswered: Number(entry.unanswered) || 0,
      reason: decision.reason,
      eligibleAt: decision.eligibleAt
    }
  }

  // 先列「绑了会话且在白名单里」的候选（含从没聊过的 —— 它们也该出现在勾选表里，否则没法勾回来）
  for (const item of candidates(config)) {
    seen.add(item.key)
    rows.push(row(item.key, peekEntry(item.key), true))
  }
  // 再补「有记录但当前不是候选」的（会话被删了 / 被白名单排掉了），给 UI 一个显示的地方，别让记录凭空消失
  for (const [key, entry] of Object.entries(t)) {
    if (seen.has(key)) continue
    if (entry === null || typeof entry !== 'object') continue
    rows.push(row(key, entry, false))
  }
  rows.sort((a, b) => b.lastProactiveAt - a.lastProactiveAt)
  // 「现在试一次」会打给谁 —— 前端要能提前显示，不然连点几次会以为坏了
  const queue = orderByStalest(candidates(config))
  const next = queue.length > 0 ? { key: queue[0].key, uin: queue[0].uin } : null
  return {
    file: proactiveFile,
    count: rows.length,
    // 白名单（清洗后）：空数组同时表示「全放开」，前端靠这个和勾选状态区分「全选」和「一个都没选」
    targets: Array.isArray(config?.proactiveTargets) ? config.proactiveTargets.slice() : [],
    next,
    peers: rows.slice(0, 40)
  }
}
