/**
 * dsh-mnemonic — 自研长期记忆。
 *
 * 设计取舍：
 * - 静态成本压到最低：2 个工具（mem_save / mem_recall）+ 一张 ≤300 字状态卡。
 * - 增量倒排索引（O(1) 追加）+ BM25 + 关键词/标签 + 中文相对时间窗加权 + MMR 去冗余（复用已建 grams）。
 * - 防自我回声、防提示词注入污染、容量自动压实（maxRecords）、UTC+8 北京时间渲染、上游超时熔断。
 */
import { homedir } from 'node:os'
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Store, defaultStorePath } from './lib/store.js'
import { buildIndex, indexRecord, search, groupAdjacent } from './lib/recall.js'
import { diversify } from './lib/diversify.js'
import { loadAliasGroups, expandAliases } from './lib/aliases.js'
import { RECALL_RULES, renderCard, renderRecallBlock, renderClockDate, ymd } from './lib/card.js'
import { profileSlots, renderProfile, stableAttrOf } from './lib/profile.js'
import { toneOf } from './lib/tone.js'
import { openLoops, renderOpenLoops } from './lib/openloops.js'
import { boundaryOf, renderBoundaries } from './lib/boundary.js'
import { userSide, factSentences, factKeywords } from './lib/facts.js'
import { messageText, roleOf, clip, hash32, parseEventTimestamp, isLowValueOrInjection, isDegradedAssistantText, isMultiNeedQuery, isChitChat, isMetaRecall, isPlanStatement, attributeKeywords, sanitizeMemoryText, neutralizeRoleMarkers, tokenSet, userPartOf } from './lib/text.js'
import { resolveCurrent } from './lib/supersede.js'

export const name = 'dsh-mnemonic'
export const inject = ['tools']

const DAY = 86400000
const REWRITE_TTL_MS = 5 * 60 * 1000

// 检索命中不等于有证据：BM25 会靠标签、扩词或邻轮把一条正文里没有问句实词的记录带进来，
// 这种块喂给弱模型，它会拿旧事硬答（167 道「未知当事实」的主因）。这里用真正渲染进块的
// 正文算覆盖率，只数二元组，专门区分「命中了」和「答得上」。
function recallCoverage(query, text) {
  const q = tokenSet(query)
  const t = tokenSet(text)
  if (!q.size || !t.size) return 0
  let hit = 0
  for (const g of q) if (t.has(g)) hit += 1
  return hit / q.size
}

// 截断窗口只认实词：问句里的「什么/记得/上次」这些二元组几乎每段都有，拿它们定位会把窗口带到废话上。
const FOCUS_STOP = new Set([
  '什么', '怎么', '哪里', '哪个', '多少', '记得', '记不', '以前', '之前', '上次', '上回',
  '那个', '这个', '我们', '你的', '我的', '是不', '不是', '有没', '没有', '你还', '还记',
])

function focusTerms(query, expanded = '') {
  const out = new Set()
  for (const t of tokenSet(`${query || ''} ${expanded || ''}`)) {
    if (t.length >= 2 && !FOCUS_STOP.has(t)) out.add(t)
  }
  return out
}

const NON_USER_KINDS = new Set([
  'runtime-context',
  'compact-checkpoint',
  'spine-checkpoint',
  'repeat-tool-reminder',
  'time-context',
  'skill-catalog',
  'memory_revision',
  'nudge',
])

/** 只看「这是不是一个真人用户轮」，不看有没有文字：图片/语音轮也要当锚点，不能跨轮配对。 */
export function isHumanUserRole(msg) {
  if (roleOf(msg) !== 'user') return false
  // 宿主若把回忆块持久化成普通 user 消息，不能把它当成用户在提问。
  if (isMnemonicRecallMessage(msg)) return false
  const kind = msg?.source?.kind ?? msg?.message?.source?.kind
  if (kind) {
    if (String(kind).startsWith('plugin:')) return false
    if (NON_USER_KINDS.has(kind)) return false
    if (kind !== 'user') return false
  }
  return true
}

export function isHumanUserMessage(msg) {
  if (!isHumanUserRole(msg)) return false
  const txt = messageText(msg).trim()
  if (!txt) return false
  if (txt.startsWith('Current runtime context.')) return false
  return true
}

/** 回忆注入消息的判据只留一份：相邻消息检查和 120s 去重共用。 */
export function isMnemonicRecallMessage(msg) {
  const kind = msg?.source?.kind ?? msg?.message?.source?.kind
  if (kind === 'plugin:dsh-mnemonic') return true
  // 宿主可能把临时注入持久化成普通 user 消息并丢掉 source：再用内容指纹兜一层，
  // 否则旧回忆块会一轮叠一轮，长会话里堆十几份过期时间戳。
  const txt = messageText(msg).trim()
  return txt.startsWith('【以前聊过的·只当参考') && /\n\[M1\]/.test(txt)
}

/** 宿主不一定在下一轮替我们清掉旧回忆块；先把它们摘掉，避免过期时间戳和旧证据一起留在窗口里。 */
function dropRecallBlocks(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isMnemonicRecallMessage(messages[i])) messages.splice(i, 1)
  }
}

// 宿主的运行快照每步追加一份、旧副本永不回收，而快照正文里就写着「supersedes earlier」。
// 实测一条会话 surface 上堆了 106 份、20.3 万字符，占整轮输入 56%；对话快照由宿主在
// pre-step 之后提交，消息参数里看不到，只能在 surface 上做替换。旧快照不是记忆，是过期状态，
// 留着还会让模型把旧心情当现在。这里只保留最新一份，其余换成一行的墓碑。
// 墓碑仍用 runtime-context 这个 source.kind：宿主和 onebot 都靠它把「上下文快照」排除在
// 「用户真的说过的话」之外；换成新 kind 会被当成用户发言写进回合记忆。form 用 pruned 区分。
const PRUNED_CONTEXT_KIND = 'runtime-context'
const PRUNED_CONTEXT_FORM = 'pruned'
const PRUNED_CONTEXT_TEXT = '<system-reminder>\n更早的运行上下文快照已被替换，其中数值不再适用。\n</system-reminder>'

/** 返回 surface 上已被最新快照取代的旧运行上下文序号（不包含最新一份）。 */
export function supersededSnapshotSeqs(session) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes)) return []
  const kept = []
  for (const seq of nodes) {
    const event = session.eventAt?.(seq)
    if (event?.type !== 'user/message' || event.data?.source?.kind !== 'runtime-context') continue
    if (event.data.source.form !== 'snapshot') continue
    kept.push(seq)
  }
  return kept.slice(0, -1)
}

/** 用最小可见的墓碑节点替换旧快照；append 由调用方注入，便于单测。 */
export function pruneSupersededContext(session, append) {
  const seqs = supersededSnapshotSeqs(session)
  for (const seq of seqs) append(seq)
  return seqs.length
}

export function effectiveMinScore(recordCount, targetMinScore) {
  const low = Math.min(targetMinScore, 1.2)
  if (recordCount <= 30) return low
  if (recordCount >= 200) return targetMinScore
  const ratio = (recordCount - 30) / (200 - 30)
  return Math.round((low + (targetMinScore - low) * ratio) * 100) / 100
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  // 配置写成 "900px" 这种非数字时 Number() 会变 NaN，整套回忆会静默消失；宁可回退默认值。
  const num = (value, fallback) => {
    const n = Number(value)
    return Number.isFinite(n) ? n : fallback
  }
  const cfg = {
    storePath: config.storePath || defaultStorePath(home),
    maxRecords: num(config.maxRecords, 5000),
    injectChars: num(config.injectChars, 900),
    itemChars: num(config.itemChars, 200),
    // 第一名放宽倍数：1 表示关（默认），跑基准时用 1.6 之类的值做 A/B。
    firstItemBoost: num(config.firstItemBoost, 1),
    cardChars: num(config.cardChars, 300),
    profileChars: num(config.profileChars, 180),
    // 边界走常驻 system 段（固定前缀），默认 70 字够放三条，不占每轮证据预算。
    boundaryChars: num(config.boundaryChars, 70),
    boundaryLimit: num(config.boundaryLimit, 3),
    openLoopsChars: num(config.openLoopsChars, 90),
    openLoopsLines: num(config.openLoopsLines, 2),
    openLoopsMaxAgeDays: num(config.openLoopsMaxAgeDays, 14),
    // 主动提起旧事的日配额。ComPeer（UIST'24，QQ 场景，N=24）实测：2.4 条/天满意度 5.19/7，
    // 6.6 条/天被抱怨「像定时器」；Nomi 的 Normal 档约 1 条/天，Pi 上限 3 条/天。取 2。
    proactiveDailyLimit: num(config.proactiveDailyLimit, 2),
    limit: num(config.limit, 4),
    // 多要点问句的放大档：只在 isMultiNeedQuery 命中时用，普通闲聊仍走上面的小预算。
    multiInjectChars: num(config.multiInjectChars, 1800),
    multiItemChars: num(config.multiItemChars, 260),
    multiLimit: num(config.multiLimit, 8),
    // 普通聊天用软预算，明确回溯（记得/上次/生日）才放到满档：日常轮次占满 1200 字纯属浪费。
    softInjectChars: num(config.softInjectChars, 600),
    softItemChars: num(config.softItemChars, 180),
    softLimit: num(config.softLimit, 3),
    minScore: num(config.minScore, 2.4),
    minHits: num(config.minHits, 1),
    injectCooldownMs: num(config.injectCooldownMs, 0),
    autoArchive: config.autoArchive ?? true,
    archiveChars: num(config.archiveChars, 400),
    // 助手那半段只留一小截：她是「说过什么」的记录，不是要背下来的正文；留太长会让她越聊越像复读自己。
    archiveAsstChars: num(config.archiveAsstChars, 160),
    rerank: config.rerank ?? false,
    // 候选池放宽到 30：多打分几十条几乎不花时间，MMR 才有东西可挑。
    rerankPool: num(config.rerankPool, 30),
    queryRewrite: config.queryRewrite ?? true,
    rewriteTimeoutMs: num(config.rewriteTimeoutMs, 4000),
    rerankTimeoutMs: num(config.rerankTimeoutMs, 5000),
  }

  const store = new Store(cfg.storePath, { maxRecords: cfg.maxRecords }).load()
  // mem_save 的 flush 会真实写盘：磁盘满或权限错时不能把整次工具调用打崩，更不能让模型以为存进去了。
  const flushSafe = () => {
    try {
      store.flush()
      return true
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 写盘失败: ${error?.message || error}`) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      return false
    }
  }
  const aliasGroups = loadAliasGroups(cfg.storePath, config.aliases)
  let index = buildIndex(store.records)
  let indexedCount = store.records.length
  let indexedGen = store.generation
  const lastInjectByScope = new Map()
  let queryCount = 0
  let totalQueryMs = 0
  // 每天只看五个数里的两个：被纠正了几次、注入了多少字。逐轮一行，面板和复盘都用得上。
  const statsPath = join(dirname(cfg.storePath), 'inject-log.jsonl')
  // 逐轮一行且永不清理的话，一年就是几十万行；超过 2MB 整体轮转成 .1，够复盘又不撑爆磁盘。
  const appendStats = (entry) => {
    mkdirSync(dirname(statsPath), { recursive: true })
    try {
      if (statSync(statsPath).size > 2 * 1024 * 1024) renameSync(statsPath, `${statsPath}.1`)
    } catch { /* 首次写入时文件还不存在，statSync 必失败，这里没有别的分支可走 */ }
    appendFileSync(statsPath, JSON.stringify(entry) + '\n')
  }
  // 注入日志此前没人读：健康检查里给个今日汇总，面板和复盘才有入口；按 mtime+size 缓存，别每次健康检查都整文件解析。
  let injectStatsCache = { key: '', at: 0, value: null }
  const injectStatsToday = (ts) => {
    let key = ''
    try {
      const st = statSync(statsPath)
      key = `${st.size}:${Math.round(st.mtimeMs)}`
    } catch { return null }
    if (injectStatsCache.key === key && ts - injectStatsCache.at < 30000) return injectStatsCache.value
    const dayStart = Math.floor((ts + 8 * 3600000) / DAY) * DAY - 8 * 3600000
    let turns = 0
    let chars = 0
    let caveat = 0
    let unrendered = 0
    try {
      let text = readFileSync(statsPath, 'utf8')
      // 今日条目一定在尾部；日志上限 2MB，只解析最后 512KB，剩下的不 split。
      if (text.length > 512 * 1024) {
        const cut = text.indexOf('\n', text.length - 512 * 1024)
        if (cut > 0) text = text.slice(cut + 1)
      }
      for (const line of text.split('\n')) {
        if (!line) continue
        let e
        try { e = JSON.parse(line) } catch { continue }
        if (!(e.at >= dayStart)) continue
        turns += 1
        chars += Number(e.chars) || 0
        if (e.caveat) caveat += 1
        unrendered += Array.isArray(e.unrendered) ? e.unrendered.length : 0
      }
    } catch { return null }
    const value = { turns, chars, avgChars: turns ? Math.round(chars / turns) : 0, caveat, unrendered }
    injectStatsCache = { key, at: ts, value }
    return value
  }
  // 纠正次数落盘：只放内存的话，重启后面板上的「被纠正几次」会归零，看着像从没被纠过。
  const countersPath = join(dirname(cfg.storePath), 'counters.json')
  let corrections = 0
  // 运行上下文去重的现场计数：pre-step 拿到的 messages 到底有没有这些旧快照，只有数出来才知道。
let ctxPrunedTotal = 0
  try {
    corrections = Number(JSON.parse(readFileSync(countersPath, 'utf8')).corrections) || 0
  } catch { /* 文件不存在或坏了就当 0，不用为计数器起一个错误分支 */ }
  const bumpCorrections = () => {
    corrections += 1
    try {
      mkdirSync(dirname(countersPath), { recursive: true })
      writeFileSync(countersPath, JSON.stringify({ corrections }))
    } catch (error) {
      ctx.logger?.warn?.(`dsh-mnemonic: 纠正计数写盘失败: ${error?.message || error}`)
    }
  }
  const lastInjectMeta = new Map()
  // 主动提起旧事的日配额：人类对话里自然引用旧事实只占 7.9%（MemUse 2026），每轮都翻等于话痨。
  const proactiveCount = new Map()
const archivedMsgIds = new Map()
  const rewriteCache = new Map()

  /** 增量同步索引：仅追加新记录时 O(1) 增量更新，删除/压实/改写元数据时才全量重建。 */
  const ensureIndex = () => {
    if (store.dirty || indexedGen !== store.generation || indexedCount > store.records.length) {
      index = buildIndex(store.records)
      indexedCount = store.records.length
      indexedGen = store.generation
      store.dirty = false
      return index
    }
    while (indexedCount < store.records.length) {
      indexRecord(index, store.records[indexedCount], indexedCount)
      indexedCount += 1
    }
    return index
  }

  const recall = (query, limit = cfg.limit, pool = limit, { expandedTerms = '', excludeIds = null, scope = '', nowTs = Date.now(), allowSuperseded = false, allowRepeat = false } = {}) => {
    const t0 = performance.now()
    // 一条几万字的粘贴会把查询二元组堆到几万个，乘上候选集就是上亿次查找，整进程卡死。
    const q = clip(String(query || ''), 400)
    // 阈值按活跃记录放宽：库里堆满作废/静音记录时，小库的宽松档不该被全量条数吃掉。
    const liveCount = store.records.reduce((n, r) => n + (r.muted || r.supersededBy ? 0 : 1), 0)
    const minScore = effectiveMinScore(liveCount, cfg.minScore)
    const idx = ensureIndex()
    const aliasTerms = expandAliases(q, aliasGroups)
    const res = search(idx, store.records, q, {
      limit: pool,
      minScore,
      minHits: cfg.minHits,
      expandedTerms,
      aliasTerms,
      excludeIds,
      scope,
      now: nowTs,
      allowSuperseded,
      allowRepeat,
    })
    queryCount += 1
    totalQueryMs += performance.now() - t0
    return res
  }

  const REWRITE_SYS = `把用户的这句话转成往旧聊天记录里检索用的词。只输出词，空格分隔，8-12 个。
要写人名、物件、动作，以及同义词和上位词；问类别时写这一类里常见的具体东西。
不要解释，不要句子。`

  const llmAndModel = () => {
    try {
      const llm = ctx.get('llm')
      const sel = ctx.get('defaultModel')?.currentSelection?.()
      if (!llm || typeof llm.stream !== 'function' || !sel?.provider || !sel?.model) return null
      return { llm, sel }
    } catch {
      return null
    }
  }

  const streamText = async (llm, sel, system, user, maxTokens, timeoutMs) => {
    let timer = null
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const run = async () => {
      let out = ''
      const stream = llm.stream({
        provider: sel.provider,
        model: sel.model,
        system,
        messages: [{ role: 'user', content: user }],
        temperature: 0,
        maxTokens,
        ...(ac ? { signal: ac.signal } : {}),
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') out += chunk.text
      }
      return out.trim()
    }
    if (!timeoutMs || timeoutMs <= 0) return run()
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            ac?.abort()
            reject(new Error(`timeout after ${timeoutMs}ms`))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function rewriteQueryTerms(query) {
    if (!cfg.queryRewrite) return ''
    const clipped = clip(query, 300)
    if (!clipped) return ''
    const cached = rewriteCache.get(clipped)
    const ts = Date.now()
    if (cached && ts - cached.at < REWRITE_TTL_MS) return cached.words
    const svc = llmAndModel()
    if (!svc) return ''
    try {
      const words = (await streamText(svc.llm, svc.sel, REWRITE_SYS, clipped, 120, cfg.rewriteTimeoutMs)).replace(/\n+/g, ' ').trim()
      if (words) {
        if (rewriteCache.size >= 64) {
          const firstKey = rewriteCache.keys().next().value
          if (firstKey !== undefined) rewriteCache.delete(firstKey)
        }
        rewriteCache.set(clipped, { words, at: ts })
      }
      return words
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 查询改写失败，用原句: ${error?.message || error}`) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      return ''
    }
  }

  const rerankSys = (cap) => `你是记忆检索排序器。给定查询和编号候选记忆，选出与查询真正相关的最多 ${cap} 条，按相关度从高到低。只输出 JSON：{"picks":[序号,...]}。完全不相关的不要选，不要解释。`
  async function rerank(query, hits, cap = cfg.limit) {
    if (!cfg.rerank || hits.length <= cap) return hits.slice(0, cap)
    const svc = llmAndModel()
    if (!svc) return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
    try {
      const lines = hits
        .slice(0, Math.max(cfg.rerankPool, cap * 3))
        .map((h, i) => `${i + 1}. ${String(h.rec.text).slice(0, 140).replace(/\s+/g, ' ')}`)
        .join('\n')
      const out = await streamText(svc.llm, svc.sel, rerankSys(cap), `查询: ${query}\n候选:\n${lines}`, 200, cfg.rerankTimeoutMs)
      const m = out.match(/\{[\s\S]*\}/)
      if (!m) return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
      const picks = JSON.parse(m[0]).picks
      if (!Array.isArray(picks)) return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
      const out2 = []
      const seen = new Set()
      for (const p of picks) {
        const i = Number(p) - 1
        if (!Number.isInteger(i) || i < 0 || i >= hits.length || seen.has(i)) continue
        seen.add(i)
        out2.push(hits[i])
        if (out2.length >= cap) break
      }
      return out2.length ? out2 : diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 重排失败，回退去重顺序: ${error?.message || error}`) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
    }
  }

  // 作用域取会话 id（private:/group:）。拿不到就留空，退化成不隔离，避免把老记录全屏蔽。
  const sessionScope = (agent) => {
    const id = agent?.session?.id
    return id ? String(id) : ''
  }

  // pre-step 时当前这条用户消息还没得到回复，配上一轮的助手回复会张冠李戴。
  // 存「上一轮完整的一问一答」：先找最近的助手回复，再找它前面那条真人用户消息。
  const archiveTurn = (messages, lastUserIndex, scope = '') => {
    // 没有 session 就没有隔离域：写全局会把这条记忆暴露给所有会话。
    if (!scope) return null
    let asstIndex = -1
    for (let i = lastUserIndex - 1; i >= 0; i -= 1) {
      if (roleOf(messages[i]) === 'assistant') { asstIndex = i; break }
    }
    if (asstIndex < 0) return null
    let userIndex = -1
    for (let i = asstIndex - 1; i >= 0; i -= 1) {
      // 锚点按角色取，不跳过图片/语音轮：否则会拿「图片那轮的回复」配「更早的文字提问」。
      if (isHumanUserRole(messages[i])) { userIndex = i; break }
    }
    if (userIndex < 0) return null
    const userMsg = messages[userIndex]
    const user = messageText(userMsg) || ''
    if (!user.trim()) return null
    const cleanUser = neutralizeRoleMarkers(sanitizeMemoryText(clip(user, cfg.archiveChars)))
    if (isLowValueOrInjection(cleanUser)) return null
    const asstMsg = messages[asstIndex]
    const prevAssistant = messageText(asstMsg) || ''
    // 助手那边的「早呀老大」「嗯嗯」不值得存档：检索命中后她会把自己的寒暄当旧事念一遍。
    const usableAsst = isDegradedAssistantText(prevAssistant) || isChitChat(prevAssistant) ? '' : prevAssistant
    const cleanAsst = usableAsst ? neutralizeRoleMarkers(sanitizeMemoryText(clip(usableAsst, cfg.archiveAsstChars))) : ''
    const text = cleanAsst ? `用户：${cleanUser}\n我：${cleanAsst}` : `用户：${cleanUser}`

    const msgTs = parseEventTimestamp(asstMsg?.createdAt ?? asstMsg?.timestamp ?? userMsg?.createdAt ?? userMsg?.timestamp) || Date.now()
    const asstId = asstMsg?.id || hash32(prevAssistant)
    // 没有消息 id 时内容哈希必须带日期：同一问一答隔天再说，是新的时间证据，不能被当成已归档。
    const dayTag = new Date(msgTs + 8 * 3600000).toISOString().slice(0, 10)
    const msgKey = `${scope || '__global__'}|${userMsg?.id ? `id:${userMsg.id}` : `txt:${hash32(user)}@${dayTag}`}|${asstId}`
    if (archivedMsgIds.has(msgKey)) {
      const known = archivedMsgIds.get(msgKey)
      if (known && store.byId.has(known)) return known
      // 容量压实可能已经把那条淘汰了：删掉死 id，让这一轮重新归档。
      archivedMsgIds.delete(msgKey)
    }
    if (archivedMsgIds.size >= 128) {
      const oldest = archivedMsgIds.keys().next().value
      if (oldest !== undefined) archivedMsgIds.delete(oldest)
    }

    // 事实句只进索引和画像，正文照旧保留：改写成事实会丢语气和上下文（LongMemEval 的 document expansion 也是扩索引）。
    const facts = factSentences(text)
    const rec = store.add({ text, keywords: [...new Set([...attributeKeywords(text), ...factKeywords(facts)])], tags: [], importance: 0.35, eventAt: msgTs, spokenAt: msgTs, source: { kind: 'auto' }, scope })
    if (rec) archivedMsgIds.set(msgKey, rec.id)
    if (rec && facts.length && !rec.facts?.length) {
      rec.facts = facts
      store.touched = true
    }
    // 近似重复只做「指向」不做删除：换了个说法的同一件事留原文，渲染时按 canonical 折叠。
    // 宁可不合并，也不能让任何一句原话查不回来（调研-20261128-近似重复 的红线）。
    if (rec) {
      const mine = tokenSet(userSide(text))
      if (mine.size >= 3) {
        const start = Math.max(0, store.records.length - 50)
        for (let i = store.records.length - 1; i >= start; i -= 1) {
          const other = store.records[i]
          if (other === rec || (other.scope || '') !== (scope || '') || !other.text) continue
          // 只往「更早的记录」上链：否则重复说同一句时，新记录会指回自己，或指到比它更新的记录上，折叠时把新说法吞掉。
          if ((other.createdAt || 0) > (rec.createdAt || 0)) continue
          if (other.id === rec.id || other.canonicalId === rec.id) continue
          const theirs = tokenSet(userSide(other.text))
          if (theirs.size < 3) continue
          let shared = 0
          for (const g of mine) if (theirs.has(g)) shared += 1
          // 折叠只是展示层，但折错会把一条真事从块里藏掉；调研里自动合并的 precision 目标
          // 是 ≥0.98，文本近重复到不了这个量级，所以把阈值从 0.65 提到 0.75，宁漏不合。
          if (shared / (mine.size + theirs.size - shared) >= 0.75) {
            rec.canonicalId = other.canonicalId || other.id
            store.touched = true
            break
          }
        }
      }
    }
    // 负面事件单独标记：记是要记的，但 48 小时内不主动重提第二次（见 lib/tone.js）。
    if (rec && !rec.tone) {
      const tone = toneOf(text)
      if (tone) {
        rec.tone = tone
        store.touched = true
      }
    }
    // 边界（「别叫我宝贝」）：靠检索命中等于不存在，所以单独存一份，走常驻 system 段。
    if (rec && !rec.boundary) {
      const boundary = boundaryOf(userSide(text))
      if (boundary) {
        rec.boundary = boundary
        rec.importance = Math.max(Number(rec.importance) || 0.35, 0.7)
        store.touched = true
      }
    }
    // 画像槽位（称呼/住处/生日…）只留最新一条：库里同时躺着新旧值，模型最容易说错（学术侧 TASK 实测 53%）。
    // 只标不删，原文还在，只是检索和画像都优先用新的。
    // 覆盖判据用 stableAttrOf 而不是 slotOf：一句「今天上班好累」不该把真职业信息作废掉。
    const slot = stableAttrOf(rec)
    // 空 scope 说明宿主没给会话 id：这时所有记录共享一个作废域，一次误判会污染全部会话，宁可不作废。
    if (slot && scope) {
      // 又把旧说法说了一遍（小明→大明→小明）：这次说的就是最新值，先把自己头上的作废标记摘掉。
      if (rec.supersededBy) {
        delete rec.supersededBy
        // add() 命中已有记录时也会走这里；不显式置 touched，解禁只停在内存，重启后又变回旧说法。
        store.touched = true
      }
      const newText = userSide(text)
      // 多值线索（也/还/兼职/两只）说明是追加不是替换；「我在公司工作」这种泛述也不该顶掉主职。
      const multi = /也|还(?:在|有|养)|同时|另外|兼职|副业|第二份|两只|三个|之一|有时候|偶尔|以前|曾经/.test(newText)
      const explicit = /改成|改为|换成|换(?:了|个)工作|换到|转行|改行|搬到|调到|现在是|不再是|已经不在|离职|辞职|毕业|退休|改名|改叫|回到/.test(newText)
      const definitional = slot === '称呼' || slot === '住处' || slot === '生日'
      // 计划不是事实：「我下个月搬到徐汇」不能把现在的住址作废（Graphiti 的做法是计划类用说话时刻
      // 当 valid_at，等它真的发生）。只有带完成标记的才算改口，纯未来表述一律不覆盖。
      const planned = isPlanStatement(newText)
      const mayReplace = !multi && !planned && (definitional || explicit)
      for (const old of store.records) {
        if (!mayReplace) break
        if (old === rec || old.supersededBy) continue
        if ((old.scope || '') !== (scope || '')) continue
        // 隔天重复同一个值不该把昨天的同值记录作废，否则链越来越长，「以前叫什么」会变成「别猜」。
        if (userSide(old.text) === userSide(rec.text)) continue
        // 工具显式存下的记忆是人工确认过的，永远不自动作废。
        if (old.source?.kind === 'tool') continue
        if (stableAttrOf(old) !== slot) continue
        old.supersededBy = rec.id
        // 旧值不是删除，是「有效期到此为止」：问「以前叫什么」时还读得到。
        if (!old.validTo) old.validTo = rec.eventAt || rec.createdAt || Date.now()
        if (!old.basis) old.basis = 'explicit'
        store.touched = true
        // 作废不影响倒排索引（search 直接读 rec.supersededBy 过滤），所以不碰 dirty/generation；
        // 但必须单条落盘：新记录已经 appendLine，作废只写内存的话，30 秒内重启会让新旧两个名字都算「当前」。
        store.appendLine(old)
      }
    }
    return rec?.id || null
  }

  // ── 工具：写档（含纠错替代与事件日期） / 检索 ───────────────────────────
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => {
      const save = tctx.tools.register({
        name: 'mem_save',
        description: '把一件值得长期记住的事记下来：约定、喜好、身边的人、做过的事、结论。写清“谁、什么时候、什么事”，别写流水账；说错了要改，就传 supersedes 旧 ID。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', description: '一句话事实，带必要的时间/人物/数字' },
            keywords: { type: 'array', items: { type: 'string' }, description: '3-8 个检索词，覆盖人物/地点/事件/参数' },
            tags: { type: 'array', items: { type: 'string' }, description: '分类标签，如 偏好/约定/人物/项目；对方说「别对我……」时打 边界' },
            importance: { type: 'number', description: '0.05-1，越重要越高；日常寒暄给 0.2' },
            eventAt: { type: 'string', description: '可选：事件发生日期，如 2026-11-24' },
            supersedes: { type: 'string', description: '可选：要覆盖/作废的旧记忆 ID（来自 mem_recall）' },
            pinned: { type: 'boolean', description: '可选：这条要一直记得、优先想起来（用户说「记住这个」时用）' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, id: { type: 'string' }, total: { type: 'number' }, text: { type: 'string' } },
          },
          render(_args, value) {
            return [{ type: 'text', text: value.text }]
          },
        },
        async execute(args, exec) {
          if (!sanitizeMemoryText(args?.text)) {
            return { ok: false, id: '', total: store.records.length, text: '没写进去：正文是空的。' }
          }
          const scope = sessionScope(exec?.agent)
          // 没有 session 就没有隔离域：写全局会让这条记忆出现在所有会话里。
          if (!scope) return { ok: false, id: '', total: store.records.length, text: '没有会话标识，没写记忆（避免串会话）。' }
          // 工具正文没有归档那层 400 字上限，模型写超长会把索引撑爆。
          const rawText = String(args?.text ?? '').slice(0, 2000)
          const tags = Array.isArray(args?.tags) ? args.tags : (args?.tags ? [String(args.tags)] : [])
          let rec
          try {
            rec = store.add({
              text: rawText,
              keywords: [...new Set([...(Array.isArray(args?.keywords) ? args.keywords : []), ...attributeKeywords(rawText)])],
              tags,
              importance: args?.importance ?? 0.5,
              eventAt: args?.eventAt ?? null,
              spokenAt: Date.now(),
              source: { kind: 'tool' },
              scope,
            })
          } catch (error) {
            return { ok: false, id: '', total: store.records.length, text: `本地写盘失败：${error?.message || error}` }
          }
          if (!rec) return { ok: false, id: '', total: store.records.length, text: '没写进去：正文是空的。' }
          if (args?.pinned === true && !rec.pinned) {
            rec.pinned = true
            rec.pinnedAt = Date.now()
            store.touched = true
          }
          // 先写新条再作废旧条：新记录要先拿到自己的 id，旧条才能被标成「被它取代」。
          const wanted = typeof args?.supersedes === 'string' ? args.supersedes.trim() : ''
          let replaced = false
          if (wanted && rec.id === wanted) {
            // 正文一字不差时 add() 会把旧条原样返回，没有可替换的对象；如实说，别让模型以为改成功了。
            if (!flushSafe()) return { ok: false, id: rec.id, total: store.records.length, text: '本地没写进去，稍后再试。' }
            return { ok: true, id: rec.id, total: store.records.length, text: `这条和库里那条一字不差，没重复存（${rec.id}）。` }
          }
          if (wanted) {
            replaced = store.supersede(wanted, rec)
          }
          if (wanted && !replaced) return { ok: false, id: rec.id, total: store.records.length, text: '旧条不在同一会话，或改回旧值会成环，没替换。要改现在的说法，请新建一条并说明。' }
          if (replaced && !flushSafe()) return { ok: false, id: rec.id, total: store.records.length, text: '本地没写进去，稍后再试。' }
          const extra = replaced ? `（已替换旧条 ${wanted}）` : ''
          return { ok: true, id: rec.id, total: store.records.length, text: `记住了 ${rec.id}${extra}（一共 ${store.records.length} 件）。` }
        },
      })

      const recallTool = tctx.tools.register({
        name: 'mem_recall',
        description: '想起以前说过的事。只有需要过去的经历/约定/细节时才用；没想起来就如实说没记到，不要编。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: '要查的事，用名词和关键细节' },
            limit: { type: 'number', description: '最多几条，默认 5，上限 10' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { hits: { type: 'number' }, text: { type: 'string' } },
          },
          render(_args, value) {
            return [{ type: 'text', text: value.text }]
          },
        },
        async execute(args, exec) {
          const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5))
          // 这是模型主动翻记忆，不是主动想起，不该被「今天已经提过」挡掉。
          // 模型主动翻记忆时旧值也要给：问「我以前叫什么」正是它该去翻旧记录的时候。
          const pool = recall(String(args?.query || ''), limit, Math.max(limit * 2, cfg.rerankPool), { scope: sessionScope(exec?.agent), allowRepeat: true, allowSuperseded: true })
          const hits = diversify(pool, { limit, gramsIndex: ensureIndex().grams })
          if (!hits.length) return { hits: 0, text: '这事我没记到。' }
          const body = hits.map((h, i) => {
            const when = ymd(h.rec.eventAt || h.rec.createdAt)
            // 旧值必须自己说明是旧的，否则模型会把两个名字都当现在的。
            // 新值不一定在这批命中里，所以直接把「现在是什么」带上，别让她只说「改过了」。
            // 顺着作废链找到真正的当前值：A→B→C 时别把中间值 B 当成现状。
            const succ = h.rec.supersededBy
              ? resolveCurrent(store.byId, h.rec, { scope: sessionScope(exec?.agent) })
              : null
            const nowTxt = succ ? `；现在：${clip(userPartOf(succ.text) || succ.text, 40)}` : ''
            const oldMark = h.rec.supersededBy ? `（旧说法，已经改了${nowTxt}）` : ''
            return `${i + 1}. [${h.rec.id}] (${when}) ${oldMark}${clip(h.rec.text, 200)}`
          }).join('\n')
          for (const h of hits) store.touch(h.rec.id)
          return { hits: hits.length, text: body }
        },
      })

      return () => { save(); recallTool() }
    }, 'dsh-mnemonic: tools')
  })

  // ── 常驻状态卡 ────────────────────────────────────────────────────────
  ctx.inject(['systemPrompt'], (sctx) => {
    // 边界排在最前：它在语义上是「限制怎么跟她说话」，优先于下面所有内容。
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:boundaries',
      order: 57,
      interpolate: false,
      text: () => renderBoundaries(store.records, { maxChars: cfg.boundaryChars, limit: cfg.boundaryLimit }),
    }), 'dsh-mnemonic: boundaries')
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:clock',
      order: 59,
      interpolate: false,
      text: () => renderClockDate(),
    }), 'dsh-mnemonic: clock')
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:card',
      order: 60,
      interpolate: false,
      text: () => renderCard(store.records.filter((r) => !r.scope), { maxChars: cfg.cardChars }),
    }), 'dsh-mnemonic: card')
    // 纪律常驻段：固定文本不占每轮的证据预算（原本尾注要吃掉一大截）。
    // order 必须在 card 之前：card 随新记忆变化，前缀缓存在 card 处断开，
    // 排在 card 后面的固定段永远拿不到缓存命中，只能全价重发。
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:rules',
      order: 58,
      interpolate: false,
      text: () => RECALL_RULES,
    }), 'dsh-mnemonic: recall rules')
  })

  // ── 每轮自动回忆 ──────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const messages = decision.messages
      const session = payload?.agent?.session
      if (typeof session?.append === 'function') {
        ctxPrunedTotal += pruneSupersededContext(session, (seq) => {
          session.append('user/message', {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: PRUNED_CONTEXT_TEXT }],
            source: { kind: PRUNED_CONTEXT_KIND, form: PRUNED_CONTEXT_FORM },
          }, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
        })
      }
      const scope = sessionScope(payload?.agent)
      const lastUserIndex = messages.reduce((found, m, i) => (isHumanUserRole(m) ? i : found), -1)
      if (lastUserIndex < 0) return decision
      // 同一轮工具调用续步（最后一条真人消息后已有助手消息）不再重跑改写与回忆插队，保住历史与 KV cache
      if (messages.slice(lastUserIndex + 1).some((m) => roleOf(m) === 'assistant')) return decision
      const query = clip(messageText(messages[lastUserIndex]), 400)
      if (!query.trim()) return decision
      const currentTurnId = cfg.autoArchive ? archiveTurn(messages, lastUserIndex, scope) : null
      if (isMnemonicRecallMessage(messages[lastUserIndex - 1])) return decision
      const qTrim = query.trim()
      // 纯寒暄先判掉：放在查询改写之前，否则一句「在吗」也要白付一次上游 LLM 调用。
      // 但「在吗」恰恰是最该接一句「你昨天说的那事怎么样了」的时机，所以这里不直接返回，只关掉旧事检索。
      const lowValue = qTrim.length < 3 || isLowValueOrInjection(qTrim, { minLen: 3 })
      const chitChat = lowValue || isChitChat(qTrim)
      // 「别老提以前那些事」这句话本身就是检索词，正好把她最不该提的旧账捞回来。
      // 这一轮干脆什么都不翻，只静音。
      const stopRecall = /别老提|别(?:再)?(?:说|提)(?:这个|那个|这事|那事|以前)|不想听(?:这个|那个|以前)|别提(?:以前|从前)/.test(query)
      const ts = Date.now()
      const scopeKey = scope || '__global__'
      // 「不对，我什么时候说过这个」是最有用的负反馈：只要上一条注入还在半小时内，就记一次纠正。
      const prevMeta = lastInjectMeta.get(scopeKey)
      // 判据只留「明确说记忆错了」的几种说法：光一个「不对」在一句话里太常见，拿它降分等于随机惩罚。
      const CORRECTION_RE = /你记错|记错了|记错了吧|我没说过|我什么时候说过|我不记得说过|你搞混|你搞错了|我说的是/
      if (prevMeta && ts - prevMeta.at < 30 * 60 * 1000 && CORRECTION_RE.test(query)) {
        bumpCorrections()
        // 只打标记降温，不删也不改原文；三天内这些记忆排到后面，让用户接着说出来的新事实接管。
        for (const id of prevMeta.ids) {
          const rec = store.byId.get(id)
          if (rec) rec.disputedAt = ts
        }
      }
      // 「别老提这个」是产品里最有效的表达闸门：不删，只静音刚才那几条。
      if (prevMeta && ts - prevMeta.at < 30 * 60 * 1000 && /别老提|别(?:再)?(?:说|提)(?:这个|那个|这事|那事)|不想听(?:这个|那个)/.test(query)) {
        for (const id of prevMeta.ids) {
          const rec = store.byId.get(id)
          if (rec && !rec.muted) {
            rec.muted = true
            rec.mutedAt = ts
            store.touched = true
          }
        }
      }
      // 「这个别记」只作用于这一轮刚归档的那条，别牵连更早的记忆。
      if (currentTurnId && /别记|不用记|别存(?:了|这个)?|忘掉这个/.test(query)) {
        const rec = store.byId.get(currentTurnId)
        if (rec && !rec.muted) {
          rec.muted = true
          rec.mutedAt = ts
          store.touched = true
        }
      }
      const lastInject = lastInjectByScope.get(scopeKey) || { at: 0, sig: '' }
      if (cfg.injectCooldownMs && ts - lastInject.at < cfg.injectCooldownMs) return decision
      // 强回溯才值得满档预算和一次查询改写；「我之前也不吃辣」这种陈述不该按查档案处理。
      const wantsRecall = /记得|记不记得|记住(?:什么|啥|哪些|没|了吗|过)|上次|上回|那天|那次|生日|叫什么|叫啥|啥名字|住哪|来着|多大|几岁|老家|哪人/.test(qTrim)
      // 「你还记得上次那件事吗」这种没点名的追问，关键词检索一条也召不回；按最近聊过的倒着数。
      const metaRecall = !chitChat && isMetaRecall(qTrim)
      // 查询改写是每条一次上游调用：日常闲聊改写收益很小，只在真要翻旧账时才付这笔钱。
      const multiNeed = isMultiNeedQuery(qTrim)
      const needsRewrite = wantsRecall || metaRecall || multiNeed
      const expandedTerms = chitChat || stopRecall || !needsRewrite ? '' : await rewriteQueryTerms(query)
      const excludeIds = currentTurnId ? new Set([currentTurnId]) : null
      const budget = multiNeed
        ? { limit: cfg.multiLimit, inject: cfg.multiInjectChars, item: cfg.multiItemChars }
        : wantsRecall
          ? { limit: cfg.limit, inject: cfg.injectChars, item: cfg.itemChars }
          : { limit: Math.min(cfg.softLimit, cfg.limit), inject: Math.min(cfg.softInjectChars, cfg.injectChars), item: Math.min(cfg.softItemChars, cfg.itemChars) }
      let recalled
      if (chitChat || stopRecall) {
        recalled = []
      } else if (metaRecall) {
        recalled = store.records
          .filter((r) => !r.supersededBy && !r.muted && (r.scope || '') === (scope || '') && r.id !== currentTurnId)
          // 寒暄和「今天好累」不占「最近聊过」的名额：她问的是「那个事」，不是随口一句。
          .filter((r) => !isChitChat(userPartOf(r.text)))
          .sort((a, b) => (b.eventAt || b.createdAt || 0) - (a.eventAt || a.createdAt || 0))
          .slice(0, Math.max(3, budget.limit))
          .map((r) => ({ rec: r, score: 1, hits: 1, why: ['recent'] }))
        // 倒着数不代表相关：对方问「那个事」，倒数的可能是「今天好累」。一条实词都不重叠就别硬塞。
        const qTokens = tokenSet(qTrim)
        recalled = recalled.filter((h) => {
          const t = tokenSet(userPartOf(h.rec.text))
          for (const g of qTokens) if (t.has(g)) return true
          return false
        })
      } else {
        // 「我以前叫什么」这种问旧值的，得把被取代的记录放回候选，否则历史被作废后永远查不到。
        // 「别老提以前的事」里的「以前」不是想查旧值：带否定词时一律按正常检索走。
        const wantsOld = !/别|不要|不想|甭/.test(query)
          && /以前|原来|之前(?:叫|住|说|是)|改过|换过|旧(?:的|名字|住处)/.test(query)
        // 主动想起（对方只是随口说一句）时，同一件事一天只提一次；对方明确在问，就不设限。
        // 明确回溯（含口语「叫啥来着」）必须放行，否则「刚告诉过你名字又问一遍」会答不上来。
        const allowRepeat = wantsRecall || /[?？]|吗|呢|什么|哪|几|多少/.test(query)
        const pool = recall(query, budget.limit, Math.max(cfg.rerankPool, budget.limit * 3), { expandedTerms, excludeIds, nowTs: ts, scope, allowSuperseded: wantsOld, allowRepeat })
        recalled = cfg.rerank
          ? await rerank(expandedTerms ? `${query} ${expandedTerms}` : query, pool, budget.limit)
          : diversify(pool, { limit: budget.limit, gramsIndex: ensureIndex().grams })
      }
      // 纯寒暄不翻旧账：真实聊天里「在吗」「困了」这种轮次注入旧事会显得刻意。
      // 主动提起（对方没在问旧事）一天最多 4 次，超了就当她这轮没想起来。
      const dayKey = `${scopeKey}|${new Date(ts + 8 * 3600000).toISOString().slice(0, 10)}`
      const proactive = !chitChat && !stopRecall && !wantsRecall && !metaRecall
      const proactiveBlocked = proactive && (proactiveCount.get(dayKey) || 0) >= cfg.proactiveDailyLimit
      const hits = chitChat || stopRecall || proactiveBlocked ? [] : recalled
      // 同一句原文已经在当前窗口里（用户刚复述、或上一轮回忆块还留着），再注一遍就是复读。
      const flatten = (s) => String(s || '').replace(/(?:用户|我|你)：/g, '').replace(/\s+/g, '')
      // 只比「这轮提问之前」的真实对话：把当前这句也算进去，用户复述自己的旧话时会把唯一证据过滤掉；
      // 把旧回忆块算进去，上一轮已经提过的证据下一轮会被误判成「已经在对话里」而丢掉。
      const windowText = messages
        .slice(0, lastUserIndex)
        .filter((m) => !isMnemonicRecallMessage(m))
        .map((m) => flatten(messageText(m)))
        .join('\n')
      const hasPrevInjectInWindow = messages.some(isMnemonicRecallMessage)
      const freshHits = hits.filter((h) => {
        // 只比用户那半段：记录里「我：嗯」这半截不会出现在窗口里，带着它永远匹配不上。
        const body = flatten(userPartOf(h.rec?.text))
        if (body.length < 8) return true
        return !windowText.includes(body.slice(0, Math.min(24, body.length)))
      })
      // 长期印象单独算：这一轮就算没有命中旧事，也该让她记得对面是谁。
      // 只取本会话：把全局记录并进来，等于一次拿不到 session 的写入会出现在所有人画像里。
      // 寒暄不塞画像：一句「晚安」后面挂着「长期印象」既刻意又占字；正经聊天时再带上。
      // 也不是每轮都带：只有命中旧事、或对方这轮说到自己（我/咱）时才铺画像，否则纯占字还容易被复读。
      // 宿主没给 session id 时没有「本会话」可言：这时候铺画像等于把别的会话的记录当她的自我介绍。
      const wantsProfile = !chitChat && !stopRecall && scope && (freshHits.length > 0 || /我|咱|俺/.test(query))
      // 画像行和本轮原话重复时只留原话：同一件事一轮里说两遍既费字又像查档案。
      const evidenceBlob = freshHits.map((h) => userPartOf(h.rec?.text)).join('\n')
      const slots = wantsProfile
        // 少于 3 个字的值（「24」「男」）容易在别的句子里撞上，不做折叠。
        ? profileSlots(store.records, [scope]).filter((s) => s.value.length < 3 || !evidenceBlob.includes(s.value))
        : []
      const profile = slots.length ? renderProfile(slots, { maxChars: cfg.profileChars }) : ''
      // 未了的事：到期的约定一定会提；没写日期的「回头聊」只在正经聊天时当引子，别在「晚安」后面追一句。
      // 提过一次就消停：到期的等一天，没日期的等三天，否则每轮都在念同一句。
      // 没有 session id 时没有「本会话」可言：scopes:[''] 会把所有空 scope 记录当成每个会话的未了事，
      // 私聊和群各写过一条「明天告诉你」，两边都会收到同一条提醒。
      const pending = (scope ? openLoops(store.records, { scopes: [scope], now: ts, maxAgeDays: cfg.openLoopsMaxAgeDays }) : [])
        // 未了事如果这一轮已经作为原话注入了，就不再单列一行。
        .filter((i) => !freshHits.some((h) => h.rec?.id === i.rec?.id))
        .filter((i) => {
          if (i.dueAt ? i.dueAt > ts : chitChat) return false
          // 约定过了两天还没下文，多半已经翻篇了；再翻出来只会像催账。
          if (i.dueAt && i.dueAt < ts - 2 * DAY) return false
          const gap = i.dueAt ? DAY : 3 * DAY
          return !i.rec.lastInjectedAt || ts - i.rec.lastInjectedAt > gap
        })
      const openShown = []
      const open = renderOpenLoops(pending, { maxLines: cfg.openLoopsLines, maxChars: cfg.openLoopsChars, now: ts, onRender: (item) => openShown.push(item) })
      // 只有「没说是哪件事」需要提示；按题型标「这道题问的是时间」是考试腔，聊天里像舞台提示。
      const hints = []
      // 模糊追问但一条相关的都没筛出来时，别再让她「按最近聊过的提一句」——那会变成硬扯无关旧事。
      if (metaRecall && !stopRecall && freshHits.length) hints.push('（对方没说是哪件事，按最近聊过的提一句，再问她是不是这件。）')
      // 空泛的「我懂你」在多轮里会被读成敷衍（N=82，附和密度 +98% 的实验）。
      // 不禁止共情，只要求带上具体内容：一件具体的事 + 一句开放的追问。
      if (!chitChat && !stopRecall && toneOf(qTrim) === 'neg' && (freshHits.length || pending.length)) hints.push('（对方在难受，别只说“我懂你”；提一句具体的事，再问一句现在怎么样。）')
      // 系统侧弃权：明确在问旧事、却一条原话都没翻到时，直接告诉模型「没翻到」。
      // 依据 arXiv 2608.22228：把弃权交给生成端不可靠，小模型尤其会拿最后一句当锚编出一段「我们聊过」。
      const explicitAsk = wantsRecall
        && /[?？]|吗|呢|什么|哪|谁|几|多少|多久|怎么|来着|是不是|有没有|哪的/.test(qTrim)
        // 「今天生日吃什么」「还要多久到家」是眼下的问题，不是查档案；带前瞻词就不当成回溯。
        && !/今天|明天|今年|还要|几点|等一下|马上/.test(qTrim)
      // 上一轮回忆块还在窗口里：原文就在眼前，不能反过来告诉模型「没翻到」。
      if (explicitAsk && !stopRecall && !chitChat && !freshHits.length && !hasPrevInjectInWindow
        && !/认识.*(?:多久|多长|几年|多少天)|多久了/.test(qTrim)) {
        hints.push('（这次没翻到相关原话，别编，直说记不清，再顺口问一句。）')
      }
      // 「我们认识多久了」得有个起点：取本会话最早一条，别让她现场编。
      if (/认识.*(?:多久|多长|几年|多少天)|多久了/.test(qTrim)) {
        let first = Infinity
        for (const r of store.records) {
          if ((r.scope || '') !== (scope || '')) continue
          const at = r.spokenAt || r.eventAt || r.createdAt
          if (at && at < first) first = at
        }
        if (Number.isFinite(first)) hints.push(`（第一次聊天是 ${ymd(first)}，到今天 ${Math.max(1, Math.ceil((ts - first) / DAY))} 天。）`)
      }
      // 同一槽位两种现在说法：系统侧标冲突，别让模型默默挑一个（Memobase 的 ABORT / CoMMA 的 conflict cluster）。
      if (freshHits.length) {
        const slotVals = new Map()
        for (const h of freshHits) {
          // 已被显式作废的旧值是「历史」，不是并行说法；只有两条都还活着才算冲突。
          if (h.rec.supersededBy) continue
          const slot = stableAttrOf(h.rec)
          if (!slot) continue
          const val = userSide(h.rec.text).replace(/\s+/g, '')
          if (!val) continue
          const prev = slotVals.get(slot)
          if (prev && prev !== val) {
            hints.push('（同一件事有两种说法，按最近那条；分不清就说记不清。）')
            break
          }
          slotVals.set(slot, val)
        }
      }
      const hint = hints.join('')
      if (!freshHits.length && !profile && !open && !hint) {
        dropRecallBlocks(messages)
        return decision
      }
      // 邻轮分组：把命中卡的下一轮并进同一条证据链（预算不变，渲染层截断）。
      // 当前这句刚归档就在数组末尾；不排除的话，「正在问的这句话」会被当成上一轮的补充证据注回去。
      const grouped = groupAdjacent(freshHits, store.records, { skipIds: excludeIds })
      const sig = `${grouped.map((h) => h.rec.id).join(',')}|${hash32(profile)}|${hash32(open)}|${hash32(hint)}`
      // 2026-11-25：原来只看 120s + sig，宿主不持久化临时注入消息或上下文裁剪后，连续追问会被静默吞掉回忆；
      // 仅当当前 messages 窗口内仍保留上次注入消息时才跳过。
      if (hasPrevInjectInWindow && sig === lastInject.sig && ts - lastInject.at < 120000) {
        dropRecallBlocks(messages)
        return decision
      }
      const renderedIds = new Set()
      // 只落在她那一半的命中要自报归属，否则会被当对方的设定。
      const asstOnly = new Set()
      {
        const q = `${qTrim} ${expandedTerms}`
        for (const h of grouped) {
          const u = userPartOf(h.rec.text)
          if (!u) { asstOnly.add(h.rec.id); continue }
          const rest = String(h.rec.text || '').replace(u, ' ')
          if (recallCoverage(q, u) < 0.1 && recallCoverage(q, rest) >= 0.1) asstOnly.add(h.rec.id)
        }
      }
      const renderOpts = {
        itemChars: budget.item,
        firstItemChars: cfg.firstItemBoost > 1 ? Math.round(budget.item * cfg.firstItemBoost) : 0,
        now: ts,
        profile,
        asstOnly,
        terms: focusTerms(qTrim, expandedTerms),
        byId: store.byId,
        scope,
        onRender: (id) => renderedIds.add(id),
      }
      let recallBlock = renderRecallBlock(grouped, { ...renderOpts, maxChars: budget.inject, hint })
      // 覆盖率闸门：只做软提示，不整块抹证据——误杀一次就再也答不上，这个代价比多给一句限定大。
      // 依据 arXiv 2608.22228：弃权判断要放系统侧；但阈值必须先量后调（714 题上按 risk–coverage 反解），
      // 所以这里只记录 cov、加一句限定。metaRecall（「上次那件事」）按最近倒着数，无词面重叠，不判。
      let cov = 1
      let covSamples = 0
      // 「相关但不足」要答部分，不是二选一（ConvoMem 的弃权题就是给 1–4 条相关但答不了的消息）。
      const CAVEAT = '（下面这些是顺带想起的旧事：对得上的部分可以答，对不上的就说没提过。）\n'
      if (explicitAsk && !metaRecall && renderedIds.size && tokenSet(qTrim).size >= 8) {
        // 每条单独算、取最大：整块并集会把条数和预算算进分子，覆盖率永远偏乐观。
        cov = 0
        for (const id of renderedIds) {
          const r = store.byId.get(id)
          if (!r) continue
          covSamples += 1
          // 两个分母分开算：把扩词塞进同一个分母，会把对得上的记录压到阈值以下；
          // 只算原问句，又会把「我平时爱喝啥 vs 喜欢冰美式」这种同义改写判死。
          const text = String(r.text || '')
          cov = Math.max(cov, recallCoverage(qTrim, text))
          if (expandedTerms) cov = Math.max(cov, recallCoverage(expandedTerms, text))
        }
        if (covSamples && cov < 0.3) {
          renderedIds.clear()
          recallBlock = CAVEAT + renderRecallBlock(grouped, { ...renderOpts, maxChars: budget.inject - CAVEAT.length, hint })
        }
      }
      let block = [open, recallBlock].filter(Boolean).join('\n')
      // 只有一句提示（比如「认识多久」的起点）时也得让她看到，别被空命中吞掉。
      // 只有「这次没翻到」的提示时不能套「这些事我记得」的标题，否则空结果被包装成有内容。
      if (!block && hint) block = /没翻到相关原话/.test(hint) ? hint : `【这些事我记得】\n${hint}`
      if (!block) {
        dropRecallBlocks(messages)
        return decision
      }
      if (proactive && freshHits.length) {
        while (proactiveCount.size >= 128) {
          const oldest = proactiveCount.keys().next().value
          if (oldest === undefined || oldest === dayKey) break
          proactiveCount.delete(oldest)
        }
        proactiveCount.set(dayKey, (proactiveCount.get(dayKey) || 0) + 1)
      }
      const message = await memoryMessage(block)
      if (!message) return decision
      // 真进了提示词才算「说过」：没渲染出来的条目不标，免得负面记忆和未了事被静默压制。
      for (const item of openShown) {
        item.rec.lastInjectedAt = ts
        item.rec.lastInjectedScope = scope || ''
        store.touched = true
      }
      for (const id of renderedIds) {
        store.touch(id)
        const rec = store.byId.get(id)
        if (rec) {
          rec.lastInjectedAt = ts
          rec.lastInjectedScope = scope || ''
        }
      }
      // 先腾位置再写：写完之后再判 has(scopeKey) 永远为真，清理会变成死代码。
      while (lastInjectMeta.size >= 256) {
        const oldestMeta = lastInjectMeta.keys().next().value
        if (oldestMeta === undefined || oldestMeta === scopeKey) break
        lastInjectMeta.delete(oldestMeta)
      }
      lastInjectMeta.set(scopeKey, { at: ts, ids: [...renderedIds] })
      try {
        appendStats({
          at: ts,
          sc: hash32(scopeKey),
          hits: renderedIds.size,
          open: openShown.length,
          chars: block.length,
          ctx: ctxDropped,
          soft: budget.inject <= cfg.softInjectChars,
          // 被预算挤掉的条目不等于没召回：静默失败排查时要知道是「没命中」还是「命中但没装下」。
          unrendered: [...new Set(grouped
            .filter((h) => !renderedIds.has(h.rec.id))
            .filter((h) => !(h.why || []).includes('adjacent'))
            .map((h) => h.rec.id))].slice(0, 10),
          // 覆盖率只在明确问旧事时算；null 表示这轮没判。攒够样本后按 risk–coverage 反解阈值。
          cov: covSamples ? Number(cov.toFixed(3)) : null,
          caveat: covSamples > 0 && cov < 0.3 ? 1 : 0,
        })
      } catch (error) {
        ctx.logger?.warn?.(`dsh-mnemonic: 注入日志写入失败: ${error?.message || error}`)
      }
      // 2026-11-27：插在提问**之后**时模型要先读完问题再看记忆，最后一屏是记忆而不是问题。
      // 120 题配对实测（块尾纪律、同预算、同模型）：提问后 94/118，提问前 99/119（system 角色 101/119），
      // 位置本身值 4-5pp。插在提问前等于「先看记忆再读问题」，和常识的 RAG 顺序一致。
      // 插之前先清掉窗口里旧的回忆块：宿主不清理，一个长会话能攒十几份，纯烧 token 还稀释注意力。
      const anchor = messages[lastUserIndex]
      dropRecallBlocks(messages)
      // anchor 是同一数组里的对象引用，正常情况下 indexOf 一定命中；宿主换了数组时退回「最后一条真人消息之前」，
      // 不能退回删除前的 lastUserIndex——删掉 k 个旧块后那个下标已经偏了，会插到问题后面。
      let at = messages.indexOf(anchor)
      if (at < 0) {
        for (let i = messages.length - 1; i >= 0; i -= 1) {
          if (isHumanUserMessage(messages[i])) { at = i; break }
        }
      }
      messages.splice(at >= 0 ? at : messages.length, 0, message)
      if (lastInjectByScope.size >= 256 && !lastInjectByScope.has(scopeKey)) {
        const oldest = lastInjectByScope.keys().next().value
        if (oldest !== undefined) lastInjectByScope.delete(oldest)
      }
      lastInjectByScope.set(scopeKey, { at: ts, sig })
      return { ...decision, messages }
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 自动回忆失败: ${error?.message || error}`) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      return decision
    }
  }, { prepend: true })

  // ── 只读自检（含性能与分层统计，不暴露宿主机完整绝对路径） ───────────
  ctx.inject(['webServer'], (wctx) => {
    const route = {
      kind: 'prefix',
      path: '/mnemonic',
      handler: async (req, res) => {
        if (req.url?.startsWith('/mnemonic/health')) {
          const toolCount = store.records.filter((r) => r.source?.kind === 'tool').length
          const body = JSON.stringify({
            total: store.records.length,
            toolCount,
            autoCount: store.records.length - toolCount,
            pinnedCount: store.records.filter((r) => r.pinned).length,
            mutedCount: store.records.filter((r) => r.muted).length,
            supersededCount: store.records.filter((r) => r.supersededBy).length,
            disputedCount: store.records.filter((r) => r.disputedAt).length,
            indexedCount,
            maxRecords: cfg.maxRecords,
            avgQueryMs: queryCount ? Math.round((totalQueryMs / queryCount) * 100) / 100 : 0,
            corrections,
            ctxPrunedTotal,
            newest: store.records.at(-1)?.createdAt || null,
            todayAdded: store.records.filter((r) => now() - (r.createdAt || 0) < DAY).length,
            injectToday: injectStatsToday(now()),
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
          return true
        }
        return false
      },
    }
    wctx.effect(() => wctx.webServer.register(route), 'dsh-mnemonic: health route')
  })

  const flushTimer = setInterval(() => { try { store.flush() } catch (_err) { console.error('[mnemonic]', _err?.message || _err) } }, 30000)
  flushTimer.unref?.()

  return () => {
    try { clearInterval(flushTimer); store.flush() } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
    ctx.logger?.info?.('dsh-mnemonic unloaded')
  }
}

function now() {
  return Date.now()
}

let createUserMessage = null
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch {
  createUserMessage = null
}

async function memoryMessage(text) {
  if (createUserMessage) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-mnemonic', form: 'recall' },
    })
  }
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-mnemonic', form: 'recall' },
  }
}
