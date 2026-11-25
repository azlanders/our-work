// 两块渲染：状态卡（常驻 system prompt）和回忆块（每轮最多一次注入）。
// 两者都有硬上限——记忆再大也不能把提示词撑爆。
import { clip } from './text.js'

const DAY = 86400000

function mmdd(ts) {
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 统一输出 YYYY-MM-DD，避免跨年或相对日期换算时缺失年份。 */
function ymd(ts) {
  if (!Number.isFinite(ts)) return ''
  const d = new Date(ts)
  return d.getFullYear() + '-' + mmdd(ts)
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
 * 先按整条预算装入，尽量不在句中腰斩，保证尾注纪律不被裁掉。
 */
export function renderRecallBlock(hits, { maxChars = 900, itemChars = 200, now } = {}) {
  if (!hits?.length) return ''
  const head = Number.isFinite(now) ? `【记忆·相关的存档原文｜现在 ${clockText(now)}】` : '【记忆·相关的存档原文】'
  const tail = '（用法：只引用上面逐字出现过的事实，别补这里没有的日期、地点、现状或后续打算。同一件事出现两种矛盾说法就两个都列、并说明记录不足无法确定；过去状态别直接当成现在仍是这样。这里确实没有就说记不清，无关就忽略。）'
  const reserve = head.length + tail.length + 4
  const bodyBudget = Math.max(0, maxChars - reserve)
  if (bodyBudget < 20) return ''

  const lines = []
  let used = 0
  for (const [i, hit] of hits.entries()) {
    const when = ymd(hit.rec.eventAt || hit.rec.createdAt)
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
