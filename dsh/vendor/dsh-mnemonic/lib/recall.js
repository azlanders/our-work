// 检索：倒排索引取候选 + BM25（中文 bigram）+ 关键词加分 + 重要度/新鲜度加权。
// 先按词项倒排查候选，再只给候选打分——1 万条库单次查询降到毫秒级。
import { queryGrams } from './text.js'

const K1 = 1.2
const B = 0.75
const DAY = 86400000
// 单字关键词只在这些“实词”上放行：茶/猫/胃/钱 这类；虚词放进来只会制造误召回。
const STOP_CHARS = new Set('的了是在有和就都而及与着或一个我你他她它们这那什么怎么哪里为以对把被让给从到向上下里外前后中时'.split(''))
const CJK = /[\u4e00-\u9fff]/

export function buildIndex(records) {
  const df = new Map()
  const grams = new Map()
  const keywords = new Map()
  const postings = new Map()
  const kwPost = new Map()
  let totalLen = 0
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]
    const body = rec.text + ' ' + (rec.keywords || []).join(' ')
    const g = queryGrams(body)
    grams.set(rec.id, g)
    keywords.set(rec.id, new Set(rec.keywords || []))
    totalLen += g.size
    for (const t of g.keys()) {
      df.set(t, (df.get(t) || 0) + 1)
      const p = postings.get(t)
      if (p) p.push(i)
      else postings.set(t, [i])
    }
    for (const k of keywords.get(rec.id)) {
      const p = kwPost.get(k)
      if (p) p.push(i)
      else kwPost.set(k, [i])
    }
  }
  const n = records.length || 1
  return { df, grams, keywords, postings, kwPost, avgLen: totalLen / n || 1, n }
}

function idf(index, term) {
  const df = index.df.get(term) || 0
  return Math.log(1 + (index.n - df + 0.5) / (df + 0.5))
}

/**
 * @returns {{rec, score, hits, why}[]} 按分数降序；分数没过闸门的直接不返回。
 */
export function search(index, records, query, { limit = 3, minScore = 2.4, minHits = 1, now = Date.now() } = {}) {
  const q = queryGrams(query)
  if (!q.size) return []
  const candidates = new Set()
  // 双字以上：df 过一半的算通用词，不做候选入口，避免全库扫描。
  for (const [term, qtf] of q) {
    if (term.length < 2) continue
    const df = index.df.get(term) || 0
    if (!df || df * 2 > index.n) continue
    for (const i of index.postings.get(term)) candidates.add(i)
    const p = index.kwPost.get(term)
    if (p) for (const i of p) candidates.add(i)
  }
  // 单字面：查询里的 CJK 实词单字（“茶”“猫”）走关键词倒排，命中才算候选。
  for (const ch of String(query).toLowerCase()) {
    if (!CJK.test(ch) || STOP_CHARS.has(ch)) continue
    const p = index.kwPost.get(ch)
    if (p) for (const i of p) candidates.add(i)
  }
  if (!candidates.size) return []

  const out = []
  for (const idx of candidates) {
    const rec = records[idx]
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
      const chars = String(query)
      for (const k of recKw) {
        const inQuery = k.length === 1 ? !STOP_CHARS.has(k) && chars.includes(k) : q.has(k)
        if (!inQuery) continue
        // 显式存过的关键词是人工确认过的强信号：单字给够分量，避免“茶”“猫”这类漏掉。
        score += k.length === 1 ? 2.2 : 1.4
        hits += 1
        why.push('kw:' + k)
      }
    }
    if (hits < minHits) continue
    const importance = Number(rec.importance) || 0.5
    const age = Math.max(0, now - (rec.eventAt || rec.createdAt || now)) / DAY
    const fresh = age <= 1 ? 1.12 : age <= 7 ? 1.06 : age <= 30 ? 1.0 : age <= 180 ? 0.94 : 0.88
    const used = 1 + Math.min(0.12, (rec.uses || 1) * 0.01)
    const final = score * (0.85 + 0.3 * importance) * fresh * used
    if (final < minScore) continue
    out.push({ rec, score: Math.round(final * 100) / 100, hits, why })
  }
  out.sort((a, b) => b.score - a.score || (b.rec.importance || 0) - (a.rec.importance || 0))
  return out.slice(0, Math.max(1, limit))
}
