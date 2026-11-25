// 检索：倒排索引取候选 + BM25（中文 bigram）+ 关键词/标签加分 + 重要度/新鲜度加权。
// 先按词项倒排查候选，再只给候选打分——1 万条库单次查询降到毫秒级。
import { expandLocal, queryGrams } from './text.js'

const K1 = 1.2
const B = 0.75
const DAY = 86400000
// 单字关键词只在这些“实词”上放行：茶/猫/胃/钱 这类；虚词放进来只会制造误召回。
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

export function buildIndex(records) {
  const df = new Map()
  const grams = new Map()
  const keywords = new Map()
  const postings = new Map()
  const kwPost = new Map()
  let totalLen = 0
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i]
    const kwList = [...(rec.keywords || []), ...(rec.tags || [])]
      .map((k) => String(k || '').trim().toLowerCase())
      .filter(Boolean)
    const body = rec.text + ' ' + kwList.join(' ')
    const g = queryGrams(body)
    grams.set(rec.id, g)
    keywords.set(rec.id, new Set(kwList))
    totalLen += g.size
    for (const t of g.keys()) {
      df.set(t, (df.get(t) || 0) + 1)
      addPosting(postings, t, i)
    }
    for (const k of keywords.get(rec.id)) {
      addPosting(kwPost, k, i)
      // 3 字以上长词（如「半坡酒馆」「桂花乌龙」）同时索引其二元组，保证局部词也能捞出候选。
      if (k.length > 2) {
        for (const sub of queryGrams(k).keys()) addPosting(kwPost, sub, i)
      }
    }
  }
  const n = records.length || 1
  return { df, grams, keywords, postings, kwPost, avgLen: totalLen / n || 1, n }
}

function idf(index, term) {
  const df = index.df.get(term) || 0
  // 小库（新 bot 头几天）里 df≈n，原始 idf 只有 0.3，够不到 minScore → 一条都不召回。
  // 给个下限，大库本来的 idf 都在 3 以上，不受影响。
  return Math.max(0.5, Math.log(1 + (index.n - df + 0.5) / (df + 0.5)))
}

/**
 * @returns {{rec, score, hits, why}[]} 按分数降序；分数没过闸门的直接不返回。
 */
export function search(index, records, query, { limit = 3, minScore = 2.4, minHits = 1, localExpand = true, now = Date.now() } = {}) {
  const baseQ = queryGrams(query)
  if (!baseQ.size) return []

  const q = new Map(baseQ)
  if (localExpand) {
    const extra = expandLocal(query)
    if (extra) {
      for (const [term] of queryGrams(extra)) {
        if (!q.has(term)) q.set(term, 0.55)
      }
    }
  }

  const candidates = new Set()
  // 双字以上：df 过一半的算通用词，不做候选入口，避免全库扫描。
  for (const [term] of q) {
    if (term.length < 2) continue
    const df = index.df.get(term) || 0
    if (df > 0 && df * 2 <= index.n) {
      const p = index.postings.get(term)
      if (p) for (const i of p) candidates.add(i)
    }
    const kp = index.kwPost.get(term)
    if (kp) for (const i of kp) candidates.add(i)
  }
  // 单字面：查询里的 CJK 实词单字（“茶”“猫”）走关键词倒排，命中才算候选。
  const lowerQuery = String(query || '').toLowerCase()
  for (const ch of lowerQuery) {
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
      for (const k of recKw) {
        const inQuery = k.length === 1
          ? !STOP_CHARS.has(k) && lowerQuery.includes(k)
          : (q.has(k) || lowerQuery.includes(k))
        if (!inQuery) continue
        // 显式存过的关键词是人工确认过的强信号：单字给够分量，多字/跨大小写同享加分。
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
