/**
 * 顺着 supersededBy 找真正的当前值。
 * 断链、成环、跨 scope、超过跳数都返回 null：宁可说「不知道现在是什么」，
 * 也不能把半路旧值标成现状。
 */
export function resolveCurrent(byId, rec, { scope = null, maxHops = 8 } = {}) {
  let cur = rec
  const seen = new Set()
  while (cur?.supersededBy) {
    if (seen.has(cur.id) || seen.size >= maxHops) return null
    seen.add(cur.id)
    const next = byId.get(cur.supersededBy)
    if (!next) return null
    if (scope && (next.scope || '') !== scope) return null
    cur = next
  }
  return cur && !cur.supersededBy ? cur : null
}
