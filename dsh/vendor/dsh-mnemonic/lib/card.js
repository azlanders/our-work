// 两块渲染：状态卡（常驻 system prompt）和回忆块（每轮最多一次注入）。
// 两者都有硬上限——记忆再大也不能把提示词撑爆。
// 时间统一按北京时间（UTC+8）渲染，避免 Linux UTC 宿主机把深夜记忆偏移到前一天。
import { clip } from './text.js'

const DAY = 86400000
const DEFAULT_TZ_OFFSET_MS = 8 * 3600000

function shiftedDate(ts, tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  return new Date(Number(ts) + tzOffsetMs)
}

function mmdd(ts, tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  if (!Number.isFinite(ts)) return ''
  const d = shiftedDate(ts, tzOffsetMs)
  return String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0')
}

/** 统一输出 YYYY-MM-DD（默认北京时间），避免跨年或 UTC 宿主机偏移日期。 */
export function ymd(ts, tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  if (!Number.isFinite(ts)) return ''
  const d = shiftedDate(ts, tzOffsetMs)
  return d.getUTCFullYear() + '-' + mmdd(ts, tzOffsetMs)
}

/** 「现在」的文字形式：给模型锚点做相对日期换算（「上周三」「三天前」）。 */
export function clockText(now = Date.now(), tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  const d = shiftedDate(now, tzOffsetMs)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mi = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mmdd(now, tzOffsetMs)} ${hh}:${mi} 周${'日一二三四五六'[d.getUTCDay()]}`
}

export function renderClock(now = Date.now(), tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  return `【现在】${clockText(now, tzOffsetMs)}`
}

export function renderCard(records, { maxChars = 300, now = Date.now() } = {}) {
  if (!records.length) return ''
  const today = records.filter((r) => now - (r.createdAt || 0) < DAY).length
  const newest = [...records].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)).slice(0, 3)
  const titles = newest.map((r) => clip(r.text, 22)).join('｜')
  const head = `【记忆】存 ${records.length} 条 · 24h 内 +${today} · 最近：${titles}`
  return clip(head, maxChars)
}

/**
 * 回忆块：只放存档原文，明确写“不是推测”，并允许模型判断无关就不提。
 * 先按整条预算装入，尽量不在句中腰斩，保证尾注纪律不被裁掉。
 */
export function renderRecallBlock(hits, { maxChars = 900, itemChars = 200, now, tzOffsetMs = DEFAULT_TZ_OFFSET_MS } = {}) {
  if (!hits?.length) return ''
  const head = Number.isFinite(now) ? `【记忆·相关的存档原文｜现在 ${clockText(now, tzOffsetMs)}】` : '【记忆·相关的存档原文】'
  const tail = '（用法：只引用上面逐字出现过的事实，别补这里没有的日期、地点、现状或后续打算。同一件事出现两种矛盾说法就两个都列、并说明记录不足无法确定；过去状态别直接当成现在仍是这样。这里确实没有就说记不清，无关就忽略。）'
  const reserve = head.length + tail.length + 4
  const bodyBudget = Math.max(0, maxChars - reserve)
  if (bodyBudget < 20) return ''

  const lines = []
  let used = 0
  for (const [i, hit] of hits.entries()) {
    const when = ymd(hit.rec.eventAt || hit.rec.createdAt, tzOffsetMs)
    const prefix = `${i + 1}. (${when}) `
    const line = prefix + clip(hit.rec.text, itemChars)
    const sep = lines.length ? 1 : 0
    if (used + sep + line.length <= bodyBudget) {
      lines.push(line)
      used += sep + line.length
      continue
    }
    const avail = bodyBudget - used - sep - prefix.length
    // 第一条一定要装下；后续条目只有剩余预算够放有效正文（>=40字）时才裁短塞入，否则宁可留完整条。
    if (!lines.length || avail >= 40) {
      lines.push(prefix + clip(hit.rec.text, Math.max(12, avail)))
    }
    break
  }
  if (!lines.length) return ''
  return `${head}\n${lines.join('\n')}\n${tail}`
}
