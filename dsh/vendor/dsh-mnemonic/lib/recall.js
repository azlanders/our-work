// 检索：倒排索引（支持 O(1) 增量写入）+ BM25 + 关键词/标签 + 时间窗加权 + 重要度/新鲜度。
import { docExpand, expandLocal, extractTimeWindow, queryGrams } from './text.js'
import { NEG_REMENTION_MS } from './tone.js'

const K1 = 1.2
const B = 0.75
const DAY = 86400000
const STOP_CHARS = new Set('的了是在有和就都而及与着或一个我你他她它们这那什么怎么哪里为以对把被让给从到向上下里外前后中时'.split(''))
const CJK = /[\u4e00-\u9fff]/

function addPosting(map, key, idx) {
  const arr = map.get(key)
  if (arr) {
    if (arr[arr.length - 1] !== idx) arr.push(idx)
  } else {
    map.set(key, [idx])
  }
}

/** O(1) 增量向现有倒排索引追加单条记录，避免每轮 autoArchive 触发全库 O(N) 重建。 */
export function indexRecord(index, rec, idx) {
  const kwList = [...(rec.keywords || []), ...(rec.tags || [])]
    .map((k) => String(k || '').trim().toLowerCase())
    .filter(Boolean)
  // 两半都进索引：mem0 #4573 的病根是抽取时把 role 拍平，不是索引。只收用户半段会把
  // 她给过的建议、答应过的事变成检索盲区（Graphiti 的边也带两端）。归属由渲染层的
  // 「你：…（我当时回：…）」和回忆纪律第 5 条保证，不靠删索引来防。
  // 但包装词本身不能进索引：每条都带「你：／我当时回：」，会变成全库高频二元组，
  // IDF 被稀释，「你当时回我什么」还会命中每一条。
  const plain = String(rec.text || '')
    .replace(/（我当时回：/g, ' ')
    .replace(/(?:^|\n)(?:用户|你|我)：/g, '\n')
  const body = plain + ' ' + kwList.join(' ') + ' ' + docExpand(plain)
  const g = queryGrams(body)
  const kwSet = new Set(kwList)
  index.grams.set(rec.id, g)
  index.keywords.set(rec.id, kwSet)
  index.totalLen += g.size
  index.docCount += 1
  index.n = index.docCount || 1
  index.avgLen = index.totalLen / index.n || 1
  for (const t of g.keys()) {
    index.df.set(t, (index.df.get(t) || 0) + 1)
    addPosting(index.postings, t, idx)
  }
  for (const k of kwSet) {
    addPosting(index.kwPost, k, idx)
    if (k.length > 2) {
      for (const sub of queryGrams(k).keys()) addPosting(index.kwPost, sub, idx)
    }
  }
  return index
}

export function buildIndex(records) {
  const index = {
    df: new Map(),
    grams: new Map(),
    keywords: new Map(),
    postings: new Map(),
    kwPost: new Map(),
    totalLen: 0,
    docCount: 0,
    avgLen: 1,
    n: 1,
  }
  for (let i = 0; i < records.length; i += 1) {
    indexRecord(index, records[i], i)
  }
  return index
}

/**
 * 邻轮分组：命中卡后面那一轮常是同一件事的补充说明（问「冰袋咋存」→ 下一轮「多备两个轮着冻」）。
 * 只并同 scope、且时间差在 gapMs 内的下一条；最多 maxNeighbors 张，注入预算由渲染层截断，
 * 所以并进来的邻轮挤掉的是最末那张弱相关卡，不是白加 token。
 */
// 2026-11-26：基准库里同一件事的补充常常隔天才来，48 小时窗口 + 仍限 2 条，覆盖率 +8。
// 但那是做题口径：真实聊天里跨天硬扩会把不相干的话题粘上来，所以默认只并「接着说」的下一句（30 分钟）。
// 需要跑基准时由调用方显式传 gapMs，别把环境差异写死在默认值里。
export function groupAdjacent(hits, records, { gapMs = 30 * 60 * 1000, maxNeighbors = 2, skipIds = null } = {}) {
  if (!hits.length || !records.length) return hits
  const pos = new Map()
  for (let i = 0; i < records.length; i += 1) pos.set(records[i].id, i)
  const taken = new Set(hits.map((h) => h.rec.id))
  const out = []
  let added = 0
  for (const h of hits) {
    out.push(h)
    if (added >= maxNeighbors) continue
    const i = pos.get(h.rec.id)
    if (i === undefined) continue
    const next = records[i + 1]
    if (!next || taken.has(next.id) || skipIds?.has(next.id)) continue
    if ((next.scope || '') !== (h.rec.scope || '')) continue
    // 邻轮扩展也要看作废标记，否则被取代的旧值能借「下一条」的身份绕回块里。
    if (next.supersededBy) continue
    // 用「这句话什么时候说的」算间隔：导入/回填的记录 createdAt 是写库时间，会把几年前的事排成相邻。
    const nextAt = next.spokenAt || next.eventAt || next.createdAt
    const curAt = h.rec.spokenAt || h.rec.eventAt || h.rec.createdAt
    if (!nextAt || !curAt) continue
    if (Math.abs(nextAt - curAt) > gapMs) continue
    taken.add(next.id)
    added += 1
    out.push({ rec: next, score: h.score, hits: 0, why: ['adjacent'] })
  }
  return out
}

function idf(index, term) {
  const df = index.df.get(term) || 0
  return Math.max(0.5, Math.log(1 + (index.n - df + 0.5) / (df + 0.5)))
}

/**
 * @returns {{rec, score, hits, why}[]} 按分数降序；分数没过闸门的直接不返回。
 */
export function search(
  index,
  records,
  query,
  {
    limit = 3,
    minScore = 2.4,
    minHits = 1,
    localExpand = true,
    expandedTerms = '',
    aliasTerms = '',
    excludeIds = null,
    scope = '',
    now = Date.now(),
    // 问「我以前叫什么」时才把被取代的旧值放回来：平时旧值不该和现值抢位置，但历史不能彻底消失。
    allowSuperseded = false,
    // 同一件事刚讲过就隔一天再提；对方明确追问（记得/上次/那天）时不受这条限制。
    repeatWindowMs = 24 * 60 * 60 * 1000,
    allowRepeat = false,
  } = {},
) {
  const baseQ = queryGrams(query)
  const timeWin = extractTimeWindow(query, now)
  if (!baseQ.size && !String(expandedTerms || '').trim() && !String(aliasTerms || '').trim() && !timeWin) return []

  const q = new Map(baseQ)
  // 实体别名是高置信等价词，给 0.85 权重（高于泛化改写 0.65，略低于原词 1.0）
  if (aliasTerms) {
    for (const [term] of queryGrams(aliasTerms)) {
      if (!q.has(term)) q.set(term, 0.85)
    }
  }
  if (expandedTerms) {
    for (const [term] of queryGrams(expandedTerms)) {
      if (!q.has(term)) q.set(term, 0.65)
    }
  }
  if (localExpand) {
    const extra = expandLocal(query)
    if (extra) {
      for (const [term] of queryGrams(extra)) {
        if (!q.has(term)) q.set(term, 0.55)
      }
    }
  }

  const candidates = new Set()
  for (const [term] of q) {
    if (term.length < 2) continue
    const df = index.df.get(term) || 0
    // 小库（<8 条）不做 50% 通用词截断，避免 1 条记录时 df*2 <= n 恒为假导致无法召回
    if (df > 0 && (index.n < 8 || df * 2 <= index.n)) {
      const p = index.postings.get(term)
      if (p) for (const i of p) candidates.add(i)
    }
    const kp = index.kwPost.get(term)
    if (kp) for (const i of kp) candidates.add(i)
  }

  const lowerQuery = `${String(query || '')} ${String(aliasTerms || '')} ${String(expandedTerms || '')}`.toLowerCase()
  for (const ch of lowerQuery) {
    if (!CJK.test(ch) || STOP_CHARS.has(ch)) continue
    const p = index.kwPost.get(ch)
    if (p) for (const i of p) candidates.add(i)
  }

  // 若查询含明确时间表达（如「昨天聊了啥」「上周约定」），把时间窗内的近期记录也纳入候选
  if (timeWin) {
    let added = 0
    for (let i = records.length - 1; i >= 0 && added < 64; i -= 1) {
      const r = records[i]
      if (scope && r.scope && r.scope !== scope) continue
      const ts = r.eventAt || r.createdAt || 0
      if (ts >= timeWin.start && ts <= timeWin.end) {
        candidates.add(i)
        added += 1
      }
    }
  }

  if (!candidates.size) return []

  const byId = new Map(records.map((r) => [r.id, r]))
  const out = new Map()
  for (const idx of candidates) {
    const rec = records[idx]
    if (!rec || (excludeIds && excludeIds.has(rec.id))) continue
    // 静音是硬过滤：降权在强相关查询上压不住，而真正会触发这条的恰恰是强相关。
    if (rec.muted) continue
    // 「刚讲过」是按会话算的：同一个 bot 有私聊和好几个群，私聊刚提过的事不该在群里也哑火。
    // 老记录没有 lastInjectedScope，按同会话处理（宁可少复读，也别在两个群里各念一遍）。
    const sameConversation = !rec.lastInjectedScope || rec.lastInjectedScope === (scope || '')
    // 难受的事 48 小时内不主动重提第二次：第一次是「记得」，第二次就是揭伤疤。
    if (rec.tone === 'neg' && sameConversation && rec.lastInjectedAt && now - rec.lastInjectedAt < NEG_REMENTION_MS) continue
    if (!allowRepeat && sameConversation && rec.lastInjectedAt && now - rec.lastInjectedAt < repeatWindowMs) continue
    // 作用域隔离：带 scope 的记录只在本会话召回；旧记录没有 scope 时才全局可见。
    if (scope && rec.scope && rec.scope !== scope) continue
    const g = index.grams.get(rec.id)
    if (!g) continue
    const len = g.size || 1
    let score = 0
    let hits = 0
    const why = []
    for (const [term, qtf] of q) {
      const tf = g.get(term) || 0
      if (!tf) continue
      if (term.length === 1) { score += 0.15 * qtf; continue }
      hits += 1
      const part = idf(index, term) * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + B * (len / index.avgLen))))
      score += part * qtf
      why.push(term)
    }
    const recKw = index.keywords.get(rec.id)
    if (recKw) {
      for (const k of recKw) {
        const inQuery = k.length === 1
          ? !STOP_CHARS.has(k) && lowerQuery.includes(k)
          : (q.has(k) || lowerQuery.includes(k))
        if (!inQuery) continue
        score += k.length === 1 ? 2.2 : 1.4
        hits += 1
        why.push('kw:' + k)
      }
    }

    const recTs = rec.eventAt || rec.createdAt || now
    const inTimeWin = Boolean(timeWin && recTs >= timeWin.start && recTs <= timeWin.end)
    if (inTimeWin) {
      const hasRecallIntent = /聊|说|干|做|去|提|约|记得|发生|什么|啥|哪|谁/.test(String(query || ''))
      if (hits > 0) {
        score *= 1.35
        why.push('time:' + timeWin.label)
      } else if (hasRecallIntent && timeWin.label !== '今天') {
        score = Math.max(score, 1.8)
        hits = 1
        why.push('time:' + timeWin.label)
      }
    }

    if (hits < minHits) continue
    const importance = Number(rec.importance) || 0.5
    // 新鲜度按「这句话是什么时候说的」算，时间窗仍按「事情发生的那天」算。
    // 不用 lastUsed：注入时会 touch，所有被提过的记录都会变「今天」，新鲜度就没有区分度了。
    const freshTs = rec.spokenAt || recTs
    const age = Math.max(0, now - freshTs) / DAY
    const fresh = age <= 1 ? 1.12 : age <= 7 ? 1.06 : age <= 30 ? 1.0 : age <= 180 ? 0.94 : 0.88
    const used = 1 + Math.min(0.12, (rec.uses || 1) * 0.01)
    // 置顶的记忆优先想起来，但不该挤掉当前问题更相关的证据，所以只给有限加成。
    const final = score * (0.85 + 0.3 * importance) * fresh * used * (rec.pinned ? 1.15 : 1)
    if (final < minScore) continue
    // 问「现在」时旧值不能直接出现在块里，但它命中的是同一槽位，应该把查询导向最新后继。
    // 只替换返回对象，原文和作废链都不动；历史意图仍由 allowSuperseded 放回旧值。
    let hitRec = rec
    if (rec.supersededBy && !allowSuperseded) {
      for (let hop = 0; hitRec?.supersededBy && hop < 5; hop += 1) {
        const next = byId.get(hitRec.supersededBy)
        if (!next) break
        hitRec = next
      }
      if (hitRec === rec) continue
      if (hitRec.muted) continue
      if (scope && hitRec.scope && hitRec.scope !== scope) continue
      if (excludeIds?.has(hitRec.id)) continue
    }
    const key = hitRec.id
    const entry = {
      rec: hitRec,
      score: Math.round(final * 100) / 100,
      hits,
      why: hitRec === rec ? why : [...why, 'current'],
    }
    const prev = out.get(key)
    if (!prev || entry.score > prev.score) out.set(key, entry)
  }
  return [...out.values()]
    .sort((a, b) => b.score - a.score || (b.rec.importance || 0) - (a.rec.importance || 0))
    .slice(0, Math.max(1, limit))
}
