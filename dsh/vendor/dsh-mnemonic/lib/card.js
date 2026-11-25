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

// 常驻卡只放「像事实」的条目：显式存下的、或重要度高的。
// 历史里混进来的提问、招呼、纯英文系统话，放上去既占字又误导。
function sourceKind(rec) {
  const s = rec.source
  if (!s) return ''
  if (typeof s === 'string') return s
  return s.kind || ''
}

function cardWorthy(rec) {
  const t = String(rec.text || '').trim()
  if (t.length < 6) return false
  if (!/[\u4e00-\u9fff]/.test(t)) return false          // 没有中文的多半是系统话/英文寒暄
  if (/[?？]\s*$/.test(t) || /(吗|呢|对吧|是不是)\s*$/.test(t)) return false // 提问不是事实
  if (/^(早安|早呀|早啊|晚安|在吗|在不在|哈喽|你好|hi\b|hello\b)/i.test(t)) return false
  return true
}

export function renderCard(records, { maxChars = 300, now = Date.now() } = {}) {
  if (!records.length) return ''
  const today = records.filter((r) => now - (r.createdAt || 0) < DAY).length
  const facts = records
    .filter((r) => cardWorthy(r) && (sourceKind(r).startsWith('tool') || (r.importance || 0) >= 0.65))
    .sort((a, b) => (b.importance || 0) - (a.importance || 0) || (b.createdAt || 0) - (a.createdAt || 0))
  const recent = records
    .filter(cardWorthy)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))

  const parts = [`【记忆】存 ${records.length} 条 · 24h 内 +${today}`]
  let used = parts[0].length
  const budget = Math.max(0, maxChars - used)

  if (facts.length) {
    let block = '\n记得的事：'
    for (const r of facts.slice(0, 6)) {
      const line = `\n· (${mmdd(r.eventAt || r.createdAt)}) ${clip(r.text, 48)}`
      if (block.length + line.length > budget * 0.75) break
      block += line
    }
    if (block.includes('\n·')) {
      parts.push(block)
      used += block.length
    }
  }

  if (recent.length) {
    const titles = recent.slice(0, 2).map((r) => clip(r.text, 18)).join('｜')
    const tail = `\n最近聊：${titles}`
    if (used + tail.length <= maxChars) {
      parts.push(tail)
    }
  }
  return clip(parts.join(''), maxChars)
}

/**
 * 回忆块：只放存档原文，明确写“不是推测”，并允许模型判断无关就不提。
 * 先按整条预算装入，尽量不在句中腰斩，保证尾注纪律不被裁掉。
 */
export function renderRecallBlock(hits, { maxChars = 900, itemChars = 200, now, tzOffsetMs = DEFAULT_TZ_OFFSET_MS } = {}) {
  if (!hits?.length) return ''
  const head = Number.isFinite(now) ? `【记忆·相关的存档原文｜现在 ${clockText(now, tzOffsetMs)}】` : '【记忆·相关的存档原文】'
  const tail = '（用法：只引用上面逐字出现过的事实，别补这里没有的日期、地点、形容词、现状或后续打算。同一件事有新旧版本或改口时以日期最新的说法为准，旧版细节别混进新版；没有作废说明的矛盾说法就两个都列、并说明记录不足无法确定。过去状态别直接当成现在仍是这样。这里确实没有就说记不清，无关就忽略。）'
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
