export const MAX_HOPS = 8

/**
 * 顺着 supersededBy 找真正的当前值。
 * 断链、成环、跨 scope、超过跳数都返回 null：宁可说「不知道现在是什么」，
 * 也不能把半路旧值标成现状。
 */
export function resolveCurrent(byId, rec, { scope = null, maxHops = MAX_HOPS } = {}) {
  let cur = rec
  const seen = new Set()
  while (cur?.supersededBy) {
    if (seen.has(cur.id) || seen.size >= maxHops) return null
    seen.add(cur.id)
    const raw = byId.get(cur.supersededBy)
    if (!raw) return null
    // 渲染层传进来的字典装的是命中对象（{ rec, why, ... }），存储层装的是记录本身。
    const next = raw.rec && raw.rec.id ? raw.rec : raw
    // 只拒「有 scope 且不是本会话」的后继；无 scope 的全局记录读侧本来就对所有会话可见。
    if (scope && next.scope && next.scope !== scope) return null
    // 静音的是那条记忆，不是这条链：当前值被静音就等于「没有现在这种说法」。
    if (next.muted) return null
    cur = next
  }
  return cur && !cur.supersededBy ? cur : null
}
