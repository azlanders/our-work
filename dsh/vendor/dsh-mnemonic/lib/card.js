// 两块渲染：状态卡（常驻 system prompt）和回忆块（每轮最多一次注入）。
// 两者都有硬上限——记忆再大也不能把提示词撑爆。
import { clip } from './text.js'

const DAY = 86400000

function mmdd(ts) {
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 跨年时把年份带上，否则「去年 3 月」会被读成今年。 */
function ymd(ts, now) {
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  const sameYear = Number.isFinite(now) && new Date(now).getFullYear() === d.getFullYear()
  return sameYear ? mmdd(ts) : d.getFullYear() + '-' + mmdd(ts)
}

/** 「现在」的文字形式：给模型锚点做相对日期换算（「上周三」「三天前」）。 */
export function clockText(now = Date.now()) {
  const d = new Date(now)
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${d.getFullYear()}-${mmdd(now)} ${hh}:${mi} 周${'日一二三四五六'[d.getDay()]}`
}

export function renderClock(now = Date.now()) {
  return `【现在】${clockText(now)}`
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
 * 单条正文截到 itemChars，整块截到 maxChars。
 */
export function renderRecallBlock(hits, { maxChars = 600, itemChars = 120, now } = {}) {
  if (!hits?.length) return ''
  const lines = []
  for (const [i, hit] of hits.entries()) {
    const when = ymd(hit.rec.eventAt || hit.rec.createdAt, now)
    lines.push(`${i + 1}. (${when}) ${clip(hit.rec.text, itemChars)}`)
  }
  const head = Number.isFinite(now) ? `【记忆·相关的存档原文｜现在 ${clockText(now)}】` : '【记忆·相关的存档原文】'
  const body = `${head}\n${lines.join('\n')}\n（原文，不是推测。跟当下这轮无关就当没看见，别硬提。）`
  return clip(body, maxChars)
}
