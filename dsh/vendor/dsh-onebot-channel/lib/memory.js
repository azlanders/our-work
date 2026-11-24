/**
 * memory.js ——「对谁的认识」落盘（关系卡）。
 *
 * 原来是内存 Map：进程一重启就失忆 —— 昨天聊过的喜好、怎么称呼他、聊到哪儿，
 * 全没了。真人不会这样，第二天见面还记得你是谁。
 *
 * 所以把「这个 QQ 号 / 这个群在我心里是什么样」落到 ~/.dsh/qq-bridge-memory.json：
 *   nick      怎么称呼他 / 这个群（模型可改，入站昵称也会自动补）
 *   facts     关于他 / 它的事实（喜欢什么、做过什么、在意什么），最多 8 条
 *   count     说过多少句话（自动记）
 *   lastSeen  最后一次说话的时间（自动记）
 *
 * 设计红线（跟 closure.js 一致的三条）：
 *   1. 纯本地 I/O，不碰网络；读坏了**不静默清空**（保留原文件，人能捞回来）。
 *   2. 注入正文必须短：一张卡最多带 4 条、约 180 字 ——
 *      记忆卡是**常驻**的（不像收尾提示只带一次），放任它膨胀就是每回合烧 token。
 *   3. 模型能主动记（qq_remember），也能被自动记（入站昵称、说话次数）。
 */
import { randomUUID } from 'node:crypto'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { readFileSync, writeFileSync, appendFileSync, existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'

/** 关系卡文件。单独一个文件，不塞进 state（loadState 会重建整个对象）。 */
export const MEMORY_FILE = join(DATA_DIR, 'qq-bridge-memory.json')

/** 当前实际读写路径（测试可以临时改走，避免污染真实记忆）。 */
let memoryFile = MEMORY_FILE

/** 原子写：先写 .tmp 再 rename，读的一方永远看不到半截 JSON。 */
function 写原子(file, text) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, text, 'utf8')
  renameSync(tmp, file)
}

/** 测试用：把读写路径换到临时文件，并清掉内存缓存。传空 = 恢复默认。 */
export function useMemoryFile(path) {
  memoryFile = typeof path === 'string' && path !== '' ? path : MEMORY_FILE
  table = null
  __载入完成 = false
}

/** 一张卡最多留多少条事实（多了挤掉最老的）。 */
// PACK 2026-11-14（批次394）：原来「存 8 条、只注入 4 条、再一刀切到 180 字」——
// 实测卡里 8 条 609 字，注入出来只剩 196 字：最近记的两条（inm / sdy）根本没进上下文，
// 她自己写下「他不想我被人设几句话强制约束着」，这条又被自己的注入上限框死了。
// 现在存多少注多少：存 10 条、注 10 条、1000 字——装得下就一条不少地带给她。
const MAX_FACTS = 10
/** 单条事实最长多少字。 */
const MAX_FACT_LEN = 120
/** 私聊注入正文时最多带几条事实（= MAX_FACTS，不存在「存了却永远用不上」）。 */
const INJECT_FACTS = 10
/**
 * 群聊注入上限 —— 单独一个数，别拿 INJECT_FACTS 顶。
 * PRIVACY 2026-11-14（批次394）：这个常量原来同时管「私聊容量」和「群聊隐私」两件事。
 * 把私聊从 4 提到 10 时，群聊也跟着带 10 条 —— t353 的 D1 当场红了（群里不得超过四条关系事实）。
 * 群聊是隐私边界：他的私聊细节不该在群里铺开。所以分成两个常量，各管各的。
 */
const INJECT_FACTS_GROUP = 4
/** 注入正文时「记得」那一段的字数上限（10 条 × 均 80 字还留了余量）。 */
const INJECT_CHARS = 1000
/** 称呼最长多少字。 */
const MAX_NICK_LEN = 40

const MEMORY_KINDS = new Set(['event', 'semantic_fact', 'user_preference', 'program_skill', 'inference', 'model_expression', 'runtime_state'])

function 记忆类型(value) {
  const kind = String(value ?? '').trim()
  return MEMORY_KINDS.has(kind) ? kind : 'semantic_fact'
}

function 记忆来源(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { kind: 'qq_remember' }
  const out = {}
  for (const key of ['kind', 'chatKind', 'chatId', 'sessionId', 'turnId', 'callId', 'tool', 'note']) {
    const text = String(value[key] ?? '').trim()
    if (text !== '') out[key] = text.slice(0, 160)
  }
  return Object.keys(out).length > 0 ? out : { kind: 'qq_remember' }
}

function 事实条(entry) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return null
  const text = String(entry.text ?? '').trim()
  if (text === '') return null
  return {
    ...entry,
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : '',
    kind: 记忆类型(entry.kind),
    status: entry.status === 'withdrawn' ? 'withdrawn' : 'active',
    text,
  }
}

function 活跃事实(list) {
  return (Array.isArray(list) ? list : []).map(事实条).filter((entry) => entry && entry.status === 'active')
}

// 推断只作为可审计的候选记录保存，不作为关系卡里的当前用户事实注入。
// 只有用户明确偏好、事件和语义事实等可消费类型进入常驻上下文，避免模型把旧推断当成用户自述。
function 可消费事实(list) {
  return 活跃事实(list).filter((entry) => !['inference', 'program_skill', 'model_expression', 'runtime_state'].includes(entry.kind))
}

let table = null
// PERSIST_GUARD 2026-11-17（批次 683）：679 那次事故的直接原因——
// `loadTable()` 还没把盘上的卡读进来（或 JSON 坏了），`table` 仍是 `{}`，
// 而重启时的 `flushMemoryPersist()` 照样把它写成 `{}`，10 条事实全没了。
// 现在只有「确实读到过一份合法表」或「文件本来就不存在 / 是空的」才允许落盘。
let __载入完成 = false
let __保护日志已记 = false

// FACT_MERGE 2026-11-17（批次637）：关系卡原来只按整句文本去重，措辞一变就算新事实。
// 线上实测两组同义重复各占一条配额：
//   ① 「不用解释表情包」vs「别描述/别配解说表情包」
//   ② 「自己找话题主动开口」vs「他没主动时自己去找他聊」
// 这两组只差措辞，却把 10 条上限和注入字数吃掉。这里用中文分词后的实词集合做近似判定：
// 短事实要求覆盖度高，长事实再看 Jaccard；数字保留，避免把「第1条/第2条」或「500/100」误并。
// 只用于关系卡，不碰 rofm/hippocampus 的长期库。
const 事实停用词 = new Set([
  '有时候', '不用', '什么', '自己', '这个', '那个', '一个', '就是', '还是', '可以', '已经',
  '然后', '因为', '所以', '但是', '如果', '不是', '没有', '时候', '现在', '之前', '以后',
  '我们', '你们', '他们', '她们', '我的', '你的', '他的', '她的', '别', '也', '都', '还',
  '就', '要', '说', '让', '给', '是', '在', '有', '这', '那', '个', '一', '上', '来', '去',
  '他', '她', '我', '你', '的', '了', '得', '地', '和', '跟', '把', '被', '到', '会', '能',
  '老是', '基本', '另外', '直接', '收到', '看到', '拿去', '想做',
])

let 事实分词器 = null
try {
  事实分词器 = new Intl.Segmenter('zh', { granularity: 'word' })
} catch {
  // 老 Node 没有 Segmenter：下面的字符二元组兜底仍然能用。
}

function 归一事实(text) {
  return String(text ?? '')
    .replace(/^\s*\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?\s*[:：]?\s*/, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase()
}

function 事实词集(text) {
  const 干净 = 归一事实(text)
  const out = new Set()
  if (事实分词器) {
    for (const 项 of 事实分词器.segment(干净)) {
      if (!项.isWordLike) continue
      const 词 = 项.segment
      if ((词.length < 2 && !/^\d+$/.test(词)) || 事实停用词.has(词)) continue
      out.add(词)
    }
  } else {
    for (let i = 0; i < 干净.length; i += 1) {
      const 词 = 干净.slice(i, i + 2)
      if (词.length === 2 && !事实停用词.has(词)) out.add(词)
    }
  }
  return out
}

/** 两条关系事实是不是同一件事的不同措辞。导出给测试和面板复用。 */
export function 事实相近(a, b) {
  const 甲 = 归一事实(a)
  const 乙 = 归一事实(b)
  if (甲 === '' || 乙 === '') return false
  if (甲 === 乙) return true
  const A = 事实词集(甲)
  const B = 事实词集(乙)
  if (A.size === 0 || B.size === 0) return false
  let 交 = 0
  for (const 词 of A) if (B.has(词)) 交 += 1
  if (交 < 3) return false
  const 短 = Math.min(A.size, B.size)
  const 含 = 交 / 短
  const 杰 = 交 / (A.size + B.size - 交)
  return 短 <= 5 ? 含 >= 0.6 : 含 >= 0.5 && 杰 >= 0.2
}

function 合并同义事实(列表) {
  const 留 = []
  for (const 条 of Array.isArray(列表) ? 列表 : []) {
    if (条 === null || typeof 条 !== 'object') continue
    const 文 = String(条.text ?? '').trim()
    if (文 === '') continue
    const 旧位 = 留.findIndex((x) => 事实相近(x.text, 文))
    if (旧位 >= 0) {
      // 最新措辞胜出；旧的交给调用方按需落日志（describeMemory 是纯读，不写）。
      留.splice(旧位, 1)
    }
    留.push({ ...条, text: 文 })
  }
  return 留
}

function 记同义合并(key, 旧条, 新文) {
  try {
    const 档 = join(process.env.QQ_MEM || `${QQ_WS}/记忆`, '关系卡同义合并.jsonl')
    appendFileSync(档, JSON.stringify({
      at: new Date().toISOString(),
      key,
      旧: String(旧条?.text ?? ''),
      记于: Number(旧条?.at) || 0,
      新: String(新文 ?? ''),
    }) + '\n', 'utf8')
  } catch { /* 记不上不影响合并后的关系卡 */ }
}

// TRUNC_LEAK 2026-11-14（批次439）：装不下时跳过几条，只在**变化时**记一次。
// -1 表示「还没记过」；0 是合法值（装得下），不能拿 `|| 默认` 判。
let __上次跳过 = -1

/**
 * 写节流：touchPeer 在每条消息投递成功后都调用，群消息密集时可能几秒内触发十几次，
 * 每次都 writeFileSync 是不必要的磁盘 I/O。30 秒内只写一次，脏数据攒在内存里。
 */
const PERSIST_INTERVAL_MS = 30_000
let persistTimer = null
let persistDirty = false

function loadTable() {
  if (table !== null) return table
  table = {}
  __载入完成 = false
  try {
    if (existsSync(memoryFile)) {
      const parsed = JSON.parse(readFileSync(memoryFile, 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        table = parsed
        __载入完成 = true
      }
    } else {
      // 全新安装：文件不存在是合法的空表。
      __载入完成 = true
    }
  } catch (error) {
    // 读坏了不静默当空：留一条日志，原文件不动，让人能自己修/捞
    note('memory', `关系卡读坏了（保留原文件）：${error instanceof Error ? error.message : error}`)
  }
  return table
}

/**
 * PERSIST_GUARD（批次 683）：这次落盘会不会把一份好好的关系卡写成空表？
 *   · 没载入完成 → 不写（读到一半就被退出信号打断的典型场景）
 *   · table 为空、但盘上原来是非空 → 不写（679 事故原样）
 * 显式清空走 `wipeMemory()`，不经过这里。
 */
function 可安全落盘() {
  if (!__载入完成) return false
  if (Object.keys(table).length > 0) return true
  try {
    if (!existsSync(memoryFile)) return true
    const 原 = JSON.parse(readFileSync(memoryFile, 'utf8'))
    return !原 || typeof 原 !== 'object' || Object.keys(原).length === 0
  } catch {
    // 原文件读不出来（坏的）→ 更不能拿空表覆盖它，留着让人能捞。
    return false
  }
}

function 落盘被拦(why) {
  if (__保护日志已记) return
  __保护日志已记 = true
  note('memory', `关系卡落盘被拦：${why}（批次 683 保护，不动原文件）`)
}

function persist() {
  persistDirty = true
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    if (!persistDirty) return
    persistDirty = false
    if (!可安全落盘()) { 落盘被拦('table 为空或载入未完成'); return }
    try {
      写原子(memoryFile, JSON.stringify(table, null, 2))
    } catch (error) {
      note('memory', `关系卡写失败：${error instanceof Error ? error.message : error}`)
    }
  }, PERSIST_INTERVAL_MS)
}

/** 立刻把内存态写盘（插件卸载 / 进程退出前调用，防丢数据）。 */
export function flushMemoryPersist() {
  if (persistTimer !== null) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
  if (!persistDirty) return
  persistDirty = false
  if (!可安全落盘()) { 落盘被拦('退出前 table 为空或载入未完成'); return }
  try {
    写原子(memoryFile, JSON.stringify(table, null, 2))
  } catch (error) {
    note('memory', `关系卡 flush 失败：${error instanceof Error ? error.message : error}`)
  }
}

function cardOf(key) {
  const card = loadTable()[key]
  return card !== null && typeof card === 'object' && !Array.isArray(card) ? card : null
}

/** 取一张卡（没有就 null）。 */
export function loadMemory(key) {
  if (typeof key !== 'string' || key === '') return null
  return cardOf(key)
}

/**
 * 记一条关于某人 / 某群的东西。
 * @param {string} key `private:123` / `group:456`
 * @param {{nick?: string, fact?: string}} patch
 * @returns {boolean} 有没有写进去
 */
export function remember(key, patch) {
  if (typeof key !== 'string' || key === '') return false
  const t = loadTable()
  const card = cardOf(key) ?? {}

  const nick = String(patch?.nick ?? '').trim().slice(0, MAX_NICK_LEN)
  if (nick !== '') { card.nick = nick; card.customNick = true }

  const fact = String(patch?.fact ?? '').trim().slice(0, MAX_FACT_LEN)
  if (fact !== '') {
    const now = Date.now()
    const kind = 记忆类型(patch?.kind)
    const source = 记忆来源(patch?.source)
    const facts = Array.isArray(card.facts) ? card.facts : []
    // 同一条事实不重复记；措辞变了但意思相同，也合并成最新那条。
    const supersedes = String(patch?.supersedes ?? '').trim()
    const 旧位 = facts.findIndex((item) => item?.status !== 'withdrawn' && (
      (supersedes !== '' && String(item?.id ?? '') === supersedes)
      || (supersedes === '' && 事实相近(item?.text, fact) && (item?.kind ?? 'semantic_fact') === kind)
    ))
    const 完全同文 = 旧位 >= 0 && String(facts[旧位]?.text ?? '') === fact
    if (旧位 >= 0 && !完全同文) {
      记同义合并(key, facts[旧位], fact)
      card.memoryHistory = [...(Array.isArray(card.memoryHistory) ? card.memoryHistory : []), {
        ...facts[旧位], status: 'superseded', supersededAt: now, supersededBy: patch?.id || undefined,
      }].slice(-50)
      facts.splice(旧位, 1)
    }
    if (!完全同文) {
      facts.push({
        id: String(patch?.id ?? '').trim() || randomUUID(),
        at: now,
        updatedAt: now,
        text: fact,
        kind,
        source,
        status: 'active',
        supersedes: supersedes || undefined,
      })
      // EVICT_LOG 2026-11-14（批次440）：挤掉最老的原来是**静默**的。
      // 实测发现这几条全都没了，而 记忆/ 和 SOUL.md 里也搜不到 —— 被 `slice(-10)` 吃掉了、
      // 没有任何地方留过名：「只有 1000000002 能调试我」「本群（冰屋）聊的不外传」
      // 「1000000001 有完全权限」「别用黄豆」。前两条是隐私/权限，丢了不是省字，是丢规矩。
      // 挤掉的写进 记忆/关系卡被挤掉.jsonl（永久；不跟着 load.log 轮转，
      // 否则 1.7 天就没了 —— 那正是当初「连败过两天没痕迹」的老病）。
      if (facts.length > MAX_FACTS) {
        const 丢 = facts.slice(0, facts.length - MAX_FACTS)
        try {
          const 档 = join(process.env.QQ_MEM || `${QQ_WS}/记忆`, '关系卡被挤掉.jsonl')
          const 行 = 丢.map((x) => JSON.stringify({
            at: new Date().toISOString(),
            key,
            记于: Number(x?.at) || 0,
            text: String(x?.text ?? ''),
          })).join('\n') + '\n'
          appendFileSync(档, 行, 'utf8')
        } catch { /* 记不上不能影响记住新的一条 */ }
      }
      card.facts = facts.slice(-MAX_FACTS)
    }
  }

  if (nick === '' && fact === '') return false
  card.updatedAt = Date.now()
  t[key] = card
  persist()
  return true
}

/** 记录可追溯的更正，不删除旧证据；当前读取只返回新版本。 */
export function reviseMemory(key, patch = {}) {
  const fact = String(patch.fact ?? '').trim()
  if (fact === '') return false
  return remember(key, {
    ...patch,
    fact,
    supersedes: String(patch.supersedes ?? '').trim(),
    source: { ...(patch.source ?? {}), kind: patch.source?.kind ?? 'memory_revision' },
  })
}

/** 撤回只改变可消费状态，历史仍保留在关系卡里。 */
export function withdrawMemory(key, idOrText, reason = '') {
  if (typeof key !== 'string' || key === '') return false
  const wanted = String(idOrText ?? '').trim()
  if (wanted === '') return false
  const card = cardOf(key)
  if (!card || !Array.isArray(card.facts)) return false
  const now = Date.now()
  let changed = false
  card.facts = card.facts.map((entry) => {
    if (!entry || entry.status === 'withdrawn') return entry
    if (String(entry.id ?? '') !== wanted && String(entry.text ?? '') !== wanted) return entry
    changed = true
    card.memoryHistory = [...(Array.isArray(card.memoryHistory) ? card.memoryHistory : []), {
      ...entry, status: 'withdrawn', withdrawnAt: now, withdrawnReason: String(reason).slice(0, 200),
    }].slice(-50)
    return null
  })
  card.facts = card.facts.filter(Boolean)
  if (changed) { card.updatedAt = now; loadTable()[key] = card; persist() }
  return changed
}

/**
 * 入站时自动记：昵称、说话次数、最后说话时间。
 * 只在**真正投递**的消息上调用（不是每条群消息），写盘频率可控。
 */
export function touchPeer(key, info = {}) {
  if (typeof key !== 'string' || key === '') return false
  const t = loadTable()
  const card = cardOf(key) ?? {}
  const nick = String(info?.nick ?? '').trim().slice(0, MAX_NICK_LEN)
  if (nick !== '' && !card.customNick) card.nick = nick
  card.count = (Number(card.count) || 0) + 1
  card.lastSeen = Date.now()
  t[key] = card
  persist()
  return true
}

/**
 * 把一张卡压成给模型看的一两行（没有卡返回空串）。
 * 长度受 INJECT_FACTS / INJECT_CHARS 限制 —— 它会被拼进**每回合**的正文。
 */
export function describeMemory(key, { ownerKey = '' } = {}) {
  if (typeof key !== 'string' || key === '') return ''
  const card = cardOf(key)
  if (card === null) return ''

  const lines = []
  if (typeof card.nick === 'string' && card.nick !== '') lines.push(`称呼：${card.nick}`)

  const ownFacts = 合并同义事实(可消费事实(card.facts))
  const ownerCard = key.startsWith('group:') && typeof ownerKey === 'string' && ownerKey.startsWith('private:') && ownerKey !== key
    ? cardOf(ownerKey)
    : null
  const publicFacts = Array.isArray(ownerCard?.facts)
    ? 合并同义事实(可消费事实(ownerCard.facts).filter((item) => {
      const text = String(item?.text ?? '').trim()
      const relation = /外号|昵称|称呼|朋友|熟人|关系|指向|指的是|厨/.test(text) || /群里叫/.test(text)
      const privateDetail = /工资|收入|钱|住址|地址|电话|手机号|身份证|病情|疾病|抑郁|药物|治疗|医院|密码|私聊|家人|家庭|父母|孩子|婚姻|恋爱|单位|公司|工作/.test(text)
      return /群/.test(text) && relation && !privateDetail
    })).slice(-2)
    : []
  // 群聊走更紧的上限（隐私），私聊才用满
  const 上限 = key.startsWith('group:') ? INJECT_FACTS_GROUP : INJECT_FACTS
  const ownTail = ownFacts.slice(-Math.max(0, 上限 - publicFacts.length))
  const facts = [...publicFacts, ...ownTail]
  if (facts.length > 0) {
    // FACT_PACK 2026-11-14（批次394）：整条装填，不切半句。
    // 原来 join 完一刀切成 180 字，最后一条常常剩「——每晚那条别…」，语义残缺，
    // 而且被切断的那条下次还是记不住（她读到的是半句话）。
    // 现在从新到旧装：整条放得下就放，放不下就先跳过（后面更旧的也许更短）；
    // 只有「第一条就超上限」时才截它自己。
    const 装 = []
    let 用 = 0
    for (let i = facts.length - 1; i >= 0; i--) {
      const 句 = String(facts[i]?.text ?? '').trim()
      if (句 === '') continue
      if (用 + 句.length <= INJECT_CHARS) {
        装.push(句)
        用 += 句.length + 1
      } else if (装.length === 0) {
        装.push(`${句.slice(0, INJECT_CHARS)}…`)
        用 = INJECT_CHARS
      }
    }
    // TRUNC_LEAK 2026-11-14（批次439）：装不下就整条跳过是设计（整条比半句好），
    // 但「她记下来了、却读不到」这件事原来一声不响 —— 跟昵称缓存那次一个病：
    // 数据在、注入里没有、日志里也没痕迹，只能靠人偶然发现。
    // 只统计**非空**条目：空 text 被 continue 掉，不该算作「装不下」。
    const 有效条 = facts.filter((f) => String(f?.text ?? '').trim() !== '').length
    const 跳过数 = 有效条 - 装.length
    if (跳过数 > 0 && 跳过数 !== __上次跳过) {
      __上次跳过 = 跳过数
      note('memory', `关系卡装不下：${有效条} 条只进了 ${装.length} 条（上限 ${INJECT_CHARS} 字，用了 ${用}）`)
    }
    装.reverse()
    const text = 装.join('；')
    if (text !== '') lines.push(`记得：${text}`)
  }

  if (lines.length === 0) return ''
  const subject = key.startsWith('group:') ? '关于这个群' : '关于他'
  return `（${subject}：${lines.join('；')}）`
}

/** 清空内存态（测试用；不删磁盘文件）。 */
export function clearMemory() {
  table = {}
}

/**
 * 设置页用的摘要：有多少张卡、各自记了几条。
 * 只返回能给人看的字段 —— 不把整段事实吐到 /state 里，那会让设置页越来越慢。
 */
export function memorySummary() {
  const t = loadTable()
  const peers = []
  for (const [key, card] of Object.entries(t)) {
    if (card === null || typeof card !== 'object') continue
    const nick = typeof card.nick === 'string' ? card.nick : ''
    const facts = 活跃事实(card.facts).length
    peers.push({
      key,
      nick,
      facts,
      count: Number(card.count) || 0,
      lastSeen: Number(card.lastSeen) || 0
    })
  }
  // 最近说过的排前面（设置页只显示前几条，不铺满）
  peers.sort((a, b) => b.lastSeen - a.lastSeen)
  return { file: memoryFile, count: peers.length, peers: peers.slice(0, 20) }
}

/**
 * 「她把我忘了」：清空整表并删掉落盘文件。
 * 和 clearMemory 的区别是它**真的动磁盘**，所以只给设置页的显式确认按钮用。
 */
export function wipeMemory() {
  table = {}
  try {
    if (existsSync(memoryFile)) {
      写原子(memoryFile, '{}\n')
    }
    note('memory', '关系卡已被设置页清空')
    return true
  } catch (error) {
    note('memory', `关系卡清空失败：${error instanceof Error ? error.message : error}`)
    return false
  }
}
