// 检索：倒排索引（支持 O(1) 增量写入）+ BM25 + 关键词/标签 + 时间窗加权 + 重要度/新鲜度。
import { docExpand, expandLocal, extractTimeWindow, queryGrams } from './text.js'

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
  const body = rec.text + ' ' + kwList.join(' ') + ' ' + docExpand(rec.text)
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
// 2026-11-26：同一件事的补充说明常常隔天甚至隔两天才来（「师傅来量尺寸」→「师傅发来报价了」）。
// 10 分钟窗口只能并到「接着说」的下一句；48 小时 + 仍限 2 条，在 714 题上覆盖率 +8。
export function groupAdjacent(hits, records, { gapMs = 48 * 60 * 60 * 1000, maxNeighbors = 2 } = {}) {
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
    if (!next || taken.has(next.id)) continue
    if ((next.scope || '') !== (h.rec.scope || '')) continue
    if (!next.createdAt || !h.rec.createdAt) continue
    if (Math.abs(next.createdAt - h.rec.createdAt) > gapMs) continue
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

  const out = []
  for (const idx of candidates) {
    const rec = records[idx]
    if (!rec || (excludeIds && excludeIds.has(rec.id))) continue
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
    const age = Math.max(0, now - recTs) / DAY
    const fresh = age <= 1 ? 1.12 : age <= 7 ? 1.06 : age <= 30 ? 1.0 : age <= 180 ? 0.94 : 0.88
    const used = 1 + Math.min(0.12, (rec.uses || 1) * 0.01)
    const final = score * (0.85 + 0.3 * importance) * fresh * used
    if (final < minScore) continue
    out.push({ rec, score: Math.round(final * 100) / 100, hits, why })
  }
  out.sort((a, b) => b.score - a.score || (b.rec.importance || 0) - (a.rec.importance || 0))
  return out.slice(0, Math.max(1, limit))
}
