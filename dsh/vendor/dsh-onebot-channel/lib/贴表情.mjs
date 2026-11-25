import { atomicWriteFileSync } from './atomic-fs.js'
/**
 * 贴表情.mjs —— QQ「表情回应」（reaction）的收发两侧。
 *
 * ── 为什么单独立一个模块 ───────────────────────────────────────────
 *
 * 贴表情**不是「说话的简化版」，是另一种动作**。这两件事的成本完全不同：
 *
 *   说话     —— 要组织语言、占带宽、可能打扰人、可能没人理。成本高。
 *   贴表情   —— 一秒、不打断、无风险、意图明确。成本低。
 *
 * 真实 QQ 里它们的分工是：
 *   贴表情 = 「我看到了，但我不需要说」
 *   说话   = 「我有话要说」
 *
 * 她原来只有两档：说话，或者消失。外群静默时基本等于不存在。
 * 贴表情补上了中间那一档 —— **在场，但不吵**。
 *
 * ── 三条硬规矩（改之前先想清楚为什么）──────────────────────────────
 *
 * 1. **被贴表情 ≠ 被叫。** 收到只更新认知，不触发回复轮次。
 *    否则每被人贴一下就回一句，群里会变吵 —— 那还不如不说话。
 *
 * 2. **她贴表情必须是她自己的选择。** 系统不代劳、不自动补。
 *    自动社交不是社交，是脚本。
 *
 * 3. **贴表情有上限。** 每条都贴就成了刷屏式在场，比不说话更烦人。
 *
 * ── 数据 ──────────────────────────────────────────────────────────
 *
 *   账本  记忆/表情回应.jsonl     （收 + 给她自己贴的都记这里）
 *   游标  记忆/表情回应游标.json  （{ lastAt }：她看到哪儿了）
 *   编号库 记忆/表情编号库.json    （真实发送验证过的 187 条 id↔名字）
 *   待补  记忆/表情编号-待补.json （认不出的 id，攒着等以后补表）
 *
 * ⚠️ 账本是**只追加**的。别在这里做「删旧行」的清理 ——
 *    游标是按 at 比大小的，删了中间的行不会出错，但会丢失历史。
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join } from 'node:path'
import { faceNameOfId, faceIdOf, extFaceIdOf, searchFaceNames } from './emoticons.js'
import { callOneBot } from './onebot.js'
import { note } from './env.js'

// LIKE_BASE 给测试指沙盒：测一次就往她真账本里塞一条假「被贴」，
// 会把「这七天被贴了几次」带偏，而且没法清理干净。
const BASE = process.env.LIKE_BASE || `${QQ_WS}/记忆`
const LEDGER = join(BASE, '表情回应.jsonl')
const CURSOR = join(BASE, '表情回应游标.json')
const LIB = join(BASE, '表情编号库.json')
const TODO = join(BASE, '表情编号-待补.json')

/** 一小时最多主动贴几次。超过就拦 —— 防「刷屏式在场」。 */
// UNCAP 2026-11-06：主人说「别设贴表情限制，让她自己能改」。
// 上限不再写死：读 参数.json 的 拟人.贴表情_每小时上限，默认 0 = 不限。
// 她自己想收紧就改那个数（她本来就改得动这个文件）。
function 每小时上限() {
  try {
    const j = JSON.parse(readFileSync(`${QQ_WS}/共享/工具/参数.json`, 'utf8'))
    const v = Number(j?.拟人?.贴表情_每小时上限)
    return Number.isFinite(v) && v > 0 ? v : 0
  } catch { return 0 }
}
// LIMIT_LIVE 2026-11-14（批次426）：这里原来是 `const MAX_PER_HOUR = 每小时上限()` ——
// 模块**第一次 import 时**求值一次，之后再改 参数.json 都不算数。
// 面板上那个输入框写着「立即生效」、卡片写着「改完她下一次贴表情就按新值判」，
// 实际上要重启 dsh-bot 才生效 —— 批次426 在浏览器里真点了一遍才发现（API 层看不出来）。
// 现在改成每次判的时候现读：贴表情是低频操作，多读一个 2KB 文件不心疼。


// ── 白名单（批次425）────────────────────────────────────────────────
//
// 主人 2026-11-04 一条消息把 187 个表情全发了一遍建库，同一天还留了 `_白名单` /
// `_白名单编号` / `_避雷` 三段，最后一句是「只贴主人给的白名单，其余不碰」。
// **四十天里没有任何一行代码执行过这条** —— 库里有「微笑」「抠鼻」「悠闲」，
// 而她能随手贴出去（`emojiIdOf` 认全库），那三条避雷知识纯属摆设。
//
// 判据用 **编号**，不用名字：库里「476」这种名字和编号相同的条目被 lib() 有意排除在
// idToName 之外（见那段注释），拿名字反查会掉进 noteUnknown 污染「待补」账，还会漏判。
// 读不到就返回空集 = 不拦：文件坏了不该让她一句话都贴不了。
let 白名单cache = { at: -1, size: -1, ids: new Set(), names: [] }

function 白名单() {
  try {
    const st = statSync(LIB)
    if (st.mtimeMs === 白名单cache.at && st.size === 白名单cache.size) return 白名单cache
    const raw = JSON.parse(readFileSync(LIB, 'utf8'))
    const m = (raw && raw['_白名单编号']) || {}
    const ids = new Set()
    const names = []
    for (const [name, id] of Object.entries(m)) {
      const k = String(id ?? '').trim()
      if (k === '') continue
      ids.add(k)
      names.push(String(name))
    }
    白名单cache = { at: st.mtimeMs, size: st.size, ids, names }
    return 白名单cache
  } catch { return 白名单cache }
}
/** 同一人给同一条连贴多下，在这个时间窗内算一次。 */
const MERGE_WINDOW_MS = 90e3

// LIKE_HORMONE_OFF 2026-11-05：这里原来有个 feedHormone()，一收到贴表情就
// 自动喂「被贴表情」事件（催产素 +3）。
//
// 那是**系统替她判定「我被注意到了」** —— 和最初用正则判「滚=骂人」是同一个毛病。
// 贴表情的强度其实很低：可能是随手点的、是群里起哄、是敷衍，也可能真的有人在听。
// 系统分不出这些，她自己分得出。所以现在：
//
//   · 这个文件只负责**把事实记准**（谁、给哪条、贴了什么、几次）
//   · 加不加催产素，走 qq_feel 的「被注意到」—— 她自己记才作数
//
// 别再把 feedHormone 加回来。要「让她有感觉」，改 qq_feel 的描述，不是替她下判断。

// ── 编号库（真实发送验证过的 187 条）──────────────────────────────

let libCache = { at: -1, size: -1, idToName: new Map(), nameToId: new Map() }

function lib() {
  try {
    const st = statSync(LIB)
    if (st.mtimeMs === libCache.at && st.size === libCache.size) return libCache
    const raw = JSON.parse(readFileSync(LIB, 'utf8'))
    const idToName = new Map()
    const nameToId = new Map()
    for (const [id, name] of Object.entries(raw['编号到名字'] || {})) {
      // 建库时查不到名字的，会把 id 原样当名字存进去（476 → "476"）。
      // 那种等于没有名字，别当成有效条目 —— 否则显示出来是「贴了个 476」，
      // 跟不认识一模一样，还占掉一次查表。
      if (String(name) !== String(id)) idToName.set(String(id), String(name))
    }
    for (const [name, id] of Object.entries(raw['名字到编号'] || {})) {
      nameToId.set(String(name), String(id))
    }
    libCache = { at: st.mtimeMs, size: st.size, idToName, nameToId }
    return libCache
  } catch {
    // 库坏了/还没有：退回空表，交给内置表兜底。不要抛错 —— 贴表情不该把消息流程搞断。
    return libCache
  }
}

/**
 * 账本时间戳：**保证单调递增**。
 *
 * 为什么不能直接用 Date.now()：游标是按 `at > cursor` 判「有没有没看过的」，
 * 而同一毫秒里写两行会得到相同的 at —— 后一行永远比游标大不了，
 * 于是被静默吞掉。实测在测试里一秒内写四行，偶发丢一条「收回」事件
 * （同一毫秒的概率不低，因为都是同步 appendFileSync）。
 *
 * 生产里人也可能在同毫秒贴两个表情（客户端连点），一样的道理。
 * 所以每次取戳都跟上一次比一下，撞了就 +1。
 */
let lastStamp = 0
function nextStamp() {
  const now = Date.now()
  lastStamp = now > lastStamp ? now : lastStamp + 1
  return lastStamp
}

/** 本次进程里已经记过档的未知 id —— 别每次调用都写一遍文件。 */
const notedUnknown = new Set()

/**
 * 把一个认不出的 id 记进「待补」表。
 *
 * 为什么要记：QQ 隔一阵就加新表情。今天查不到不代表明天查不到，
 * 但**得先知道缺了哪些**才补得动。没有这张表，就永远是「表情#476」。
 */
function noteUnknown(id) {
  if (notedUnknown.has(id)) return
  notedUnknown.add(id)
  try {
    const now = Date.now()
    const db = existsSync(TODO) ? JSON.parse(readFileSync(TODO, 'utf8')) : {}
    const rec = db[id] || { first: now, n: 0 }
    rec.n = (Number(rec.n) || 0) + 1
    rec.last = now
    db[id] = rec
    atomicWriteFileSync(TODO, JSON.stringify(db, null, 1))
  } catch {
    /* 记档失败不影响主流程 */
  }
}

/**
 * 表情编号 → 中文名。查不到返回 null。
 *
 * 三级查找，顺序**不能换**：
 *   1. 表情编号库 —— 来自她真实发出去的消息（187 条），和客户端渲染完全一致
 *   2. 内置经典表（0~348）+ 扩展表（349~387 等）
 *   3. 都没有 → 记进待补，返回 null
 *
 * 为什么编号库优先：内置表是社区整理的，有 109 个幽灵 id（官方目录里根本没有）；
 * 而编号库是「按段顺序对齐真实发送结果」建的，错不了。
 */
export function emojiNameOf(id) {
  const raw = String(id ?? '').trim()
  if (raw === '') return null
  const fromLib = lib().idToName.get(raw)
  if (fromLib) return fromLib
  const fromTable = faceNameOfId(raw)
  if (fromTable) return fromTable
  noteUnknown(raw)
  return null
}

/**
 * 名字 → 编号（出站时把「敲打」翻成 38）。认不出返回 null。
 *
 * 三级，顺序不能换：
 *   1. 表情编号库 —— 真实发过，最可信
 *   2. 内置经典表（0~348）—— 社区整理，有幽灵 id，但出站贴表情不校验也不会连累消息
 *   3. 扩展表（349+）—— 只核对过渲染，发送没验证过
 *
 * 第 3 级敢接进来，是因为**贴表情失败的代价只有一个动作**：
 * id 不认时协议端返回错误，文字照发。而 face 段走错 id 会让整条消息消失，
 * 所以那边（faceIdOf）绝不能接扩展表。
 */
export function emojiIdOf(nameOrId) {
  const raw = String(nameOrId ?? '').trim()
  if (raw === '') return null
  // 纯数字直接当编号，交给协议端校验 —— 它认的 id 比我们表里的全。
  if (/^\d+$/.test(raw)) return raw
  const fromLib = lib().nameToId.get(raw)
  if (fromLib) return String(fromLib)
  const classic = faceIdOf(raw)
  if (classic !== null) return String(classic)
  return extFaceIdOf(raw)
}

/**
 * 按名字模糊搜她能贴的表情（编号库 + 内置表 + 扩展表）。
 *
 * 这是 qq_emoji_search 的本地兜底：协议端没有官方目录时，靠它给出候选。
 * 顺序 = 可信度：真实发过的编号库 > 内置表 > 扩展表；
 * 但**精确命中一律排最前** —— 她要「敲打」，第一个就该是 38。
 *
 * @param {string} query 关键词；空串表示列出前 limit 个
 * @param {number} limit
 * @returns {Array<{id: string, name: string}>}
 */
export function searchLocalEmoji(query, limit = 30) {
  const q = String(query ?? '').trim()
  const max = Math.max(1, Number(limit) || 30)
  const out = []
  const seen = new Set()
  const add = (id, name) => {
    const k = String(id ?? '')
    if (k === '' || seen.has(k)) return
    seen.add(k)
    out.push({ id: k, name: String(name ?? '') })
  }

  if (q === '') {
    for (const [id, name] of lib().idToName) add(id, name)
    for (const row of searchFaceNames('', max)) add(row.id, row.name)
    return out.slice(0, max)
  }

  // 精确命中先排最前
  const exact = emojiIdOf(q)
  if (exact !== null && !/^\d+$/.test(q)) add(exact, q)
  for (const [id, name] of lib().idToName) {
    if (String(name).includes(q)) add(id, name)
  }
  for (const row of searchFaceNames(q, max)) add(row.id, row.name)
  return out.slice(0, max)
}

// ── 入站记账 ──────────────────────────────────────────────────────

/**
 * 记一笔「有人贴了表情」。
 *
 * @param {object} input
 * @param {string} input.group      群号（私聊传空串）
 * @param {string} input.from       贴表情的人
 * @param {string} [input.fromName] 他的群名片/昵称（查不到就留空，读的时候再补）
 * @param {number} input.messageId  贴在**哪条消息**上
 * @param {string} [input.quote]    那条消息的一小段原文 —— 不然她不知道"哪条"
 * @param {string[]} input.emojiIds 表情编号
 * @param {boolean} [input.removed] 是不是「取消贴表情」
 */
export function recordLike({ group = '', from = '', fromName = '', messageId = 0, quote = '', emojiIds = [], removed = false } = {}) {
  const ids = (Array.isArray(emojiIds) ? emojiIds : [emojiIds])
    .map((x) => String(x ?? '').trim())
    .filter((x) => x !== '')
  if (ids.length === 0) return null
  const row = {
    at: nextStamp(),
    kind: '收',
    group: String(group ?? ''),
    from: String(from ?? ''),
    fromName: String(fromName ?? ''),
    message_id: Number(messageId) || 0,
    quote: String(quote ?? '').replace(/\s+/g, ' ').slice(0, 24),
    likes: ids.map((id) => ({ id, name: emojiNameOf(id) })),
    removed: removed === true
  }
  try {
    appendFileSync(LEDGER, JSON.stringify(row) + '\n')
  } catch (error) {
    note('emoji', '贴表情记账失败：' + (error instanceof Error ? error.message : error))
    return null
  }
  // 这里**不碰激素**。记完就完了 —— 她要不要为此觉得「被注意到」，是她的事。
  // （见本文件顶部 LIKE_HORMONE_OFF 那段：系统代判过一次，已经撤掉。）
  return row
}

/**
 * 读游标表。结构是 `{ "<群号>": at }`。
 *
 * 旧格式（2026-11-04）只有 `{ lastAt }` —— 那时只有一个群在用。
 * 这里把它当**所有群的默认起点**保留下来，不删：删了的话别的群会从 0 开始，
 * 把 11-04 那批旧账再播一遍。宁可多留一个字段。
 */
function cursorTable() {
  try {
    if (!existsSync(CURSOR)) return {}
    const raw = JSON.parse(readFileSync(CURSOR, 'utf8'))
    if (raw === null || typeof raw !== 'object') return {}
    return raw
  } catch {
    return {}
  }
}

/** 读这个群看到哪儿了。没单独记过就退回旧格式的全局起点。 */
export function readCursor(group = '') {
  const table = cursorTable()
  const own = Number(table[String(group ?? '')])
  if (Number.isFinite(own) && own > 0) return own
  const legacy = Number(table.lastAt)
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 0
}

/** 推进这个群的游标。只前进不后退 —— 时间倒流会让旧账重复播报。 */
export function writeCursor(at, group = '') {
  const value = Number(at) || 0
  if (value <= readCursor(group)) return
  try {
    const table = cursorTable()
    table[String(group ?? '')] = value
    atomicWriteFileSync(CURSOR, JSON.stringify(table))
  } catch {
    /* 游标写不进去最多是重复播报一次，不值得中断流程 */
  }
}

/** 只读最近 N 行账本。整份读会随历史变大，200 行足够覆盖「还没看过的」。 */
function tailRows(limit = 200) {
  if (!existsSync(LEDGER)) return []
  let lines = []
  try {
    lines = String(readFileSync(LEDGER, 'utf8')).split('\n').filter(Boolean).slice(-limit)
  } catch {
    return []
  }
  const rows = []
  for (const line of lines) {
    let row
    try {
      row = JSON.parse(line)
    } catch {
      continue
    }
    // 旧格式（2026-11-04 之前只存了 emoji: "38,182"）—— 读的时候升一下，
    // 不升的话历史那 10 条永远是「表情#」。
    if (!row.likes && row.emoji) {
      row.likes = String(row.emoji).split(',').filter(Boolean).map((id) => ({ id, name: emojiNameOf(id) }))
    }
    if (!Array.isArray(row.likes) || row.likes.length === 0) continue
    if (!row.kind) row.kind = '收'
    rows.push(row)
  }
  return rows
}

/**
 * 取「还没看过的」贴表情，并把同一波合并成一条。
 *
 * 为什么要合并：她贴一个表情，QQ 就推一个 notice。同一个人手快贴三个，
 * 她会在提示里看到三行 —— 读起来像刷屏，实际是同一个动作。
 *
 * @returns {{ rows: object[], nextCursor: number }}
 */
export function pendingLikes(cursorAt = 0, group = null) {
  const since = Number(cursorAt) || 0
  const want = group === null || group === undefined ? null : String(group)
  const fresh = []
  let nextCursor = since
  for (const row of tailRows()) {
    if (row.kind !== '收') continue
    // 按群过滤：提示是嵌在某个群的上下文里的，把 A 群的贴表情说进 B 群，
    // 她会以为是在 B 群跟她说 —— 这是会认错人的那种错。
    if (want !== null && String(row.group ?? '') !== want) continue
    const at = Number(row.at) || 0
    if (at > nextCursor) nextCursor = at
    if (at <= since) continue
    fresh.push(row)
  }
  const groups = new Map()
  for (const row of fresh) {
    const key = `${row.from}|${row.message_id}|${row.removed ? 'r' : 'a'}`
    const prev = groups.get(key)
    if (prev !== undefined && Math.abs(prev.at - (Number(row.at) || 0)) <= MERGE_WINDOW_MS) {
      prev.at = Math.min(prev.at, Number(row.at) || prev.at)
      prev.count += 1
      for (const like of row.likes) {
        if (!prev.likes.some((x) => String(x.id) === String(like.id))) prev.likes.push(like)
      }
      continue
    }
    groups.set(key, {
      ...row,
      at: Number(row.at) || 0,
      count: 1,
      likes: row.likes.map((x) => ({ ...x }))
    })
  }
  const rows = [...groups.values()].sort((a, b) => a.at - b.at)
  return { rows, nextCursor }
}

/** 「3 分钟前」这种相对时间。一分钟内不标 —— 标了反而碍眼。 */
function relTime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return ''
  const min = Math.round(ms / 60000)
  if (min < 1) return ''
  if (min < 60) return `${min} 分钟前`
  const hour = Math.round(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.round(hour / 24)} 天前`
}

/**
 * 生成「有人给你贴表情」的提示文本。
 *
 * 设计原则：**只给事实，不给指令。**
 * 旧文案写的是「要不要回一句随你，别硬接」—— 那等于把低成本信号硬逼成
 * 高成本的说话动作，她要么硬接一句（吵），要么无视（显得没反应）。
 * 现在只说谁、给哪条、贴了什么、多久之前。怎么处理是她的事。
 *
 * @param {object} options
 * @param {number} [options.cursorAt] 她看到哪儿了
 * @param {(uin: string) => string} [options.nameOf] QQ 号 → 人名（查不到就留空）
 * @param {number} [options.max] 最多说几条
 * @returns {{ text: string, nextCursor: number, count: number }}
 */
export function likeHintOf({ cursorAt = 0, group = null, nameOf = () => '', max = 3 } = {}) {
  const { rows, nextCursor } = pendingLikes(cursorAt, group)
  if (rows.length === 0) return { text: '', nextCursor, count: 0 }
  const now = Date.now()
  const shown = rows.slice(-max).map((row) => {
    const rawName = String(row.fromName || '').trim()
    const who = rawName || String(nameOf(row.from) || '').trim() || `群友${String(row.from).slice(-4)}`
    const names = row.likes.map((x) => x.name || `表情#${x.id}`).join('、')
    const where = row.quote ? `给你的「${row.quote}」` : '给你的一条消息'
    const when = relTime(now - row.at)
    const tail = when ? `（${when}）` : ''
    // 收回单独成句：「他贴了X，又收回去了」读起来像刚刚才贴。
    // 人说的是「我把刚才那个撤了」—— 两种动作，两种说法。
    if (row.removed) return `${who} 把${where}贴的「${names}」收回去了${tail}`
    const many = row.count > 1 ? `（连贴 ${row.count} 下）` : ''
    return `${who} ${where}贴了「${names}」${many}${tail}`
  })
  const more = rows.length > shown.length ? `；还有 ${rows.length - shown.length} 条更早的` : ''
  return {
    text: shown.join('；') + more,
    nextCursor,
    count: rows.length
  }
}

// ── 「刚收到的那条」─────────────────────────────────────────────────
//
// 她看不到 message_id：上下文里只有「群友「阿猫」：内容」，没有消息号。
// 但「贴给对方刚说的那句话」是最常见的场景 —— 不能因为拿不到 id 就用不了。
// 所以收到消息时在这里记一笔，qq_react 不传 message_id 就贴这一条。

let lastIn = { messageId: 0, group: '', from: '', text: '', at: 0 }

/**
 * 记下「刚收到的这条消息」。poll.js 每处理一条就调一次。
 * 只留最后一条，不落盘 —— 重启清空正好，跨重启的旧消息也不该被补贴表情。
 */
export function rememberIncoming({ messageId, group = '', from = '', text = '' } = {}) {
  const mid = Number(messageId) || 0
  if (mid === 0) return
  lastIn = {
    messageId: mid,
    group: String(group ?? ''),
    from: String(from ?? ''),
    text: String(text ?? '').replace(/\s+/g, ' ').slice(0, 40),
    at: Date.now()
  }
}

/** 取「刚收到的那条」。超过 10 分钟就不给了 —— 那是旧话题，贴上去很怪。 */
export function lastIncoming() {
  if (lastIn.messageId === 0) return null
  if (Date.now() - lastIn.at > 600e3) return null
  return { ...lastIn }
}

// ── 出站：她给别人贴 ──────────────────────────────────────────────

/** 最近一小时内她主动贴了几次、都是什么。给工具描述和配额判断用。 */
export function reactStats(now = Date.now()) {
  const rows = tailRows().filter((row) => row.kind === '给' && Number(row.at) >= now - 3600e3)
  return {
    used: rows.length,
    limit: 每小时上限(),
    recent: rows.map((row) => ({
      at: Number(row.at) || 0,
      messageId: Number(row.to) || 0,
      emoji: (row.likes || []).map((x) => x.name || `表情#${x.id}`).join('、')
    }))
  }
}

/** 这条消息是谁的、说的是什么（前 20 字）。拿不到就老实说拿不到。 */
async function 落点文案(mid, group, send = callOneBot) {
  const 截 = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 20)
  const 最近 = lastIncoming()
  if (最近 && Number(最近.messageId) === Number(mid) && 最近.text) {
    return { word: `贴在 ${最近.from || '这条'} 那条「${截(最近.text)}」上` }
  }
  try {
    const r = await send({ action: 'get_msg', params: { message_id: mid } })
    const msg = r?.data?.message
    const 文 = Array.isArray(msg) ? msg.filter((x) => x?.type === 'text').map((x) => x?.data?.text ?? '').join('') : String(msg ?? '')
    const 谁 = String(r?.data?.sender?.card || r?.data?.sender?.nickname || r?.data?.user_id || '')
    if (截(文)) return { word: `贴在 ${谁 || '这条'} 那条「${截(文)}」上` }
  } catch (_err) { console.error('[onebot:贴表情]', _err?.message || _err) }
  return { word: `贴在第 ${mid} 条消息上（原文这会儿取不到）` }
}
/**
 * 给别人贴一个表情。
 *
 * 三道闸：
 *   1. **同一条消息只贴一次** —— 这是她自己的规矩，不是协议端的。
 *      QQ 允许她再贴，但人不会对同一句话连贴两个表情。
 *   2. **一小时上限** —— 防「刷屏式在场」。贴表情的价值就在克制。
 *   3. **白名单（批次425）** —— 主人 2026-11-04 指定的 21 个，其余不碰。
 *      前两道是她自己的克制，这一道是别人的边界：库里有 187 个，能用的只有那些，
 *      「微笑」「抠鼻」「悠闲」都在外面。
 *
 * 为什么不拦「给自己贴」：要判这条是不是自己发的，得额外调一次 get_msg；
 * 而贴表情本来就该快。而且给自己贴表情是件挺怪但无害的事 ——
 * 与其加一道会误伤的硬闸，不如在工具描述里说清楚。
 *
 * @param {object} input
 * @param {number} input.messageId 贴在哪条消息上
 * @param {string} input.emoji     表情名（「敲打」）或编号（「38」）
 * @param {string} [input.group]   群号（仅用于记账）
 * @param {Function} [input.send]  发送函数，默认 callOneBot。
 *   留这个口子是为了**可测** —— 否则一测成功路径就得真往群里贴一个表情，
 *   贴上就撤不干净（撤回是另一套 API，而且会被人看见「她贴了又撤」）。
 * @returns {Promise<{ ok: boolean, emoji: string, message: string }>}
 */
export async function reactTo({ messageId, emoji, group = '', send = callOneBot } = {}) {
  const mid = Number(messageId) || 0
  if (mid === 0) throw new Error('要贴表情得先有那条消息的 message_id')

  const id = emojiIdOf(emoji)
  if (id === null) {
    throw new Error(
      `不认识这个表情：「${String(emoji ?? '')}」。`
      + '可以给中文名（敲打 / 赞 / 太好笑）或编号，先用 qq_emoji_search 查一下。'
    )
  }

  const rows = tailRows()
  // 闸 1：同一条消息只贴一次
  if (rows.some((row) => row.kind === '给' && Number(row.to) === mid)) {
    return { ok: false, emoji: emojiNameOf(id) || id, message: '这条消息我已经贴过了，一句一个就够了。' }
  }
  // 闸 2：一小时上限
  const stats = reactStats()
  const 上限 = 每小时上限()  // 现读，不缓存（见文件顶部 LIMIT_LIVE）
  if (上限 > 0 && stats.used >= 上限) {
    return {
      ok: false,
      emoji: emojiNameOf(id) || id,
      message: `这一小时已经贴了 ${stats.used} 下了，先歇会儿 —— 贴得太勤就不值钱了。`
    }
  }

  // 闸 3：主人给的那 20 个。放在 send 之前 —— 拦下来就不该有账本记录。
  const 允许 = 白名单()
  if (允许.ids.size > 0 && !允许.ids.has(String(id))) {
    // 不用 emojiNameOf：查不到时它会 noteUnknown 记一笔「她不认识」，而这里明明是
    // 「认识但不能贴」，记进去就把「待补」账带偏了。
    const 名 = lib().idToName.get(String(id)) || String(emoji) || String(id)
    return {
      ok: false,
      emoji: 名,
      message: `「${名}」贴不了 —— 主人只让贴这几个：` + 允许.names.join(' ') + '。'
    }
  }

  const result = await send({
    action: 'set_msg_emoji_like',
    params: { message_id: mid, emoji_id: String(id), set: true }
  })
  if (result?.retcode !== 0) {
    const why = String(result?.message ?? result?.wording ?? '协议端没说是为什么')
    throw new Error(`贴表情没成功（${result?.retcode ?? '?'}）：${why}`)
  }

  const name = emojiNameOf(id) || String(emoji)
  try {
    appendFileSync(LEDGER, JSON.stringify({
      at: nextStamp(),
      kind: '给',
      group: String(group ?? ''),
      to: mid,
      likes: [{ id: String(id), name }]
    }) + '\n')
  } catch {
    /* 记账失败但表情已经贴上去了 —— 不回头报错，那样她会以为没贴上 */
  }
  // RECEIPT 2026-11-06：她说「贴出去的那一下落在哪条上，我这边是看不见的」——
  // 原来只回一句「贴上了」，现在把落点也说出来：是谁的、哪句话（前 20 字）。
  const 落点 = await 落点文案(mid, String(group ?? ''), send)
  return { ok: true, emoji: name, message: `贴上「${name}」了，${落点.word}。` }
}
