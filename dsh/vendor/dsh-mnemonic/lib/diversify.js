// MMR 去冗余：优先复用倒排索引中已切好的 grams，避免每轮重复切词。
import { queryGrams } from './text.js'

function gramSetFrom(rec, gramsIndex) {
  const pre = gramsIndex?.get(rec.id)
  if (pre) return new Set(pre.keys())
  return new Set(queryGrams(`${rec.text} ${(rec.keywords || []).join(' ')}`).keys())
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  return inter / (a.size + b.size - inter)
}

export function diversify(hits, { limit = 4, lambda = 0.75, gramsIndex = null } = {}) {
  if (!hits?.length || limit <= 0) return []
  if (hits.length === 1) return hits.slice(0, limit)
  const maxScore = Math.max(1, ...hits.map((h) => Number(h.score) || 0))
  const grams = new Map(hits.map((h) => [h.rec.id, gramSetFrom(h.rec, gramsIndex)]))
  const selected = []
  const remaining = hits.slice()
  while (selected.length < limit && remaining.length) {
    let best = null
    let bestVal = -Infinity
    for (const h of remaining) {
      const g = grams.get(h.rec.id)
      let red = 0
      for (const s of selected) red = Math.max(red, jaccard(g, s.g))
      const val = lambda * ((Number(h.score) || 0) / maxScore) - (1 - lambda) * red
      if (val > bestVal) {
        bestVal = val
        best = h
      }
    }
    if (!best) break
    selected.push({ ...best, g: grams.get(best.rec.id) })
    remaining.splice(remaining.indexOf(best), 1)
  }
  return selected.map(({ g, ...rest }) => rest)
}
