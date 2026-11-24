/**
 * dsh-rofm engine — memory recency weight.
 *
 * Pure functions only: no I/O, no clock reads, no user-visible text.
 * Callers pass `now`; the same call therefore gives the same weight.
 *
 * 2026-11-17 批次679（审计 P1-6）：
 *   原来 α 只看评分，不比年龄。半年前的临时安排和昨天的临时安排同权，
 *   旧关系状态会一直压着新事实。这里只给 α 乘一个软衰减系数：
 *     weight = floor + (1 - floor) * 0.5 ^ (ageDays / halfLifeDays)
 *   衰减只影响召回权重/排序，不改记忆正文，也不生成任何台词。
 */

const DAY_MS = 86_400_000

export const DEFAULT_RECENCY = Object.freeze({
  enabled: true,
  halfLifeDays: 180,
  floor: 0.35,
  futureGraceDays: 7,
  recomputeMinutes: 60,
})

function numberOr(value, fallback) {
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : fallback
}

function clamp(value, min, max) {
  const numeric = numberOr(value, min)
  return numeric < min ? min : numeric > max ? max : numeric
}

/** Normalize `cfg.recall.recency` without requiring a validated config object. */
export function recencyConfig(cfg) {
  const raw = cfg && cfg.recall && cfg.recall.recency
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : DEFAULT_RECENCY
  return {
    enabled: source.enabled !== false,
    halfLifeDays: clamp(source.halfLifeDays, 1, 3650),
    floor: clamp(source.floor, 0, 0.99),
    futureGraceDays: clamp(source.futureGraceDays, 0, 3650),
    recomputeMinutes: clamp(source.recomputeMinutes, 1, 1440),
  }
}

/**
 * 一条记忆用来算年龄的时间点：事件结束时间优先，其次归档时间。
 * 0/非法值表示不知道时间，调用方应保持原权重。
 */
export function memoryTimestamp(createdAt, eventEnd) {
  const end = Number(eventEnd)
  if (Number.isFinite(end) && end > 0) return end
  const created = Number(createdAt)
  return Number.isFinite(created) && created > 0 ? created : 0
}

/**
 * 年龄衰减系数。未来时间（含 `futureGraceDays` 内）按 1 处理；
 * 没有时间、配置关闭或参数非法时也返回 1（绝不让缺时间变成降权）。
 */
export function recencyFactor(at, now, config = DEFAULT_RECENCY) {
  const cfg = config && typeof config === 'object' ? config : DEFAULT_RECENCY
  if (cfg.enabled === false) return 1
  const timestamp = Number(at)
  const current = Number(now)
  if (!Number.isFinite(timestamp) || !Number.isFinite(current) || timestamp <= 0) return 1
  const ageDays = (current - timestamp) / DAY_MS
  if (!Number.isFinite(ageDays)) return 1
  const grace = Math.max(0, numberOr(cfg.futureGraceDays, DEFAULT_RECENCY.futureGraceDays))
  if (ageDays <= grace) return 1
  const halfLife = Math.max(1, numberOr(cfg.halfLifeDays, DEFAULT_RECENCY.halfLifeDays))
  const floor = clamp(cfg.floor, 0, 0.99)
  const decay = 0.5 ** (ageDays / halfLife)
  return floor + (1 - floor) * decay
}

/** α × 年龄系数。返回值仍在 [0,1]，`alpha` 本身保持原样给展示/β 语义用。 */
export function recencyAdjustedAlpha(alpha, at, now, config = DEFAULT_RECENCY) {
  const value = Number(alpha)
  if (!Number.isFinite(value)) return 0
  return clamp(value, 0, 1) * recencyFactor(at, now, config)
}

/**
 * 索引缓存桶：索引里的 rankAlpha 是建索引时算的；桶过期后重建一次，
 * 避免一个进程跑几天还用着旧权重。关闭衰减时为 0（不触发重建）。
 */
export function recencyCacheBucket(now, config = DEFAULT_RECENCY) {
  const cfg = config && typeof config === 'object' ? config : DEFAULT_RECENCY
  if (cfg.enabled === false) return 0
  const current = Number(now)
  if (!Number.isFinite(current) || current <= 0) return 0
  const minutes = Math.max(1, numberOr(cfg.recomputeMinutes, DEFAULT_RECENCY.recomputeMinutes))
  return Math.floor(current / (minutes * 60_000))
}
