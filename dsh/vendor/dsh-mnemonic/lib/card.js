// 两块渲染：状态卡（常驻 system prompt）和回忆块（每轮最多一次注入）。
// 两者都有硬上限——记忆再大也不能把提示词撑爆。
// 时间统一按北京时间（UTC+8）渲染，避免 Linux UTC 宿主机把深夜记忆偏移到前一天。
import { clip } from './text.js'
import { inlineDateHints } from './dates.js'

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

export function ymdWeekday(ts = Date.now(), tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  if (!Number.isFinite(ts)) return ''
  const d = shiftedDate(ts, tzOffsetMs)
  return `${ymd(ts, tzOffsetMs)} 周${'日一二三四五六'[d.getUTCDay()]}`
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

/** 系统提示词只挂日期与星期（24h 不变），保住 Prompt Prefix KV Cache；分钟级时间由用户侧回忆块按需提供。 */
export function renderClockDate(now = Date.now(), tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  return `【今天】${ymdWeekday(now, tzOffsetMs)}`
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
 * 回忆块：只放过去存档原文，纪律尾注限制模型不补未问细节、不给名词加定性、不把过去状态/计划/假设当现状，
 * 同时保留无更正说明的矛盾并列规则（2026-11-25，对应 P16 cards12b 未知当事实 12 / 违反禁止 7）。
 * 先按整条预算装入，尽量不在句中腰斩，保证尾注纪律不被裁掉。
 */
export function renderRecallBlock(hits, { maxChars = 900, itemChars = 200, now, tzOffsetMs = DEFAULT_TZ_OFFSET_MS } = {}) {
  if (!hits?.length) return ''
  const head = Number.isFinite(now) ? `【记忆·相关的存档原文｜现在 ${clockText(now, tzOffsetMs)}】` : '【记忆·相关的存档原文】'
  // 2026-11-26：120 错题 A/B 显示，模型最常犯的不是「不知道」而是「明明有却说记不清」和
  // 「拿旧状态当现在」。尾注补两条：措辞不同算同一条；进度/现状/欠账以最晚一条为准。
  const tail = '（用法：摘录里问到的每个点都逐条找一遍；找到就照原文说，措辞不同也算同一条（「做包装设计」=「做设计这一行」），别用「没提过」否认。问进度、现状、还欠多少以最晚那条为准；过去状态、计划、猜测、假设别当成现在或已发生。只答问到的点，不补未问细节、不给名词加定性、不补这里没有的日期地点或后续，别带进没被问到的其它细节。两种矛盾说法都列并说明无法确定。确实没有就说记不清，无关就忽略。原句里紧跟「昨天」「下周二」这类词的括号日期就是那天的实际日期（如「下周二(2026-06-23)」），问哪天直接用括号里的，别回答成说话那天。）'
  const reserve = head.length + tail.length + 4
  const bodyBudget = Math.max(0, maxChars - reserve)
  if (bodyBudget < 20) return ''

  const lines = []
  const lineKeys = []
  let used = 0
  let rendered = 0
  const hitKey = (hit) => hit?.rec?.id ?? hit?.rec ?? hit
  for (const [i, hit] of hits.entries()) {
    const when = ymd(hit.rec.eventAt || hit.rec.createdAt, tzOffsetMs)
    const prefix = `${i + 1}. (${when}) `
    // 就地标注：换算括号贴着「上周五」这类词，行尾括号模型会当装饰跳过。
    // 先按预算裁原文再插括号——反过来会把「昨天」和日期一起裁成半截。
    const body = inlineDateHints(clip(hit.rec.text, itemChars), hit.rec.spokenAt ?? hit.rec.eventAt ?? hit.rec.createdAt, tzOffsetMs)
    const line = prefix + body
    const sep = lines.length ? 1 : 0
    if (used + sep + line.length <= bodyBudget) {
      lines.push(line)
      lineKeys.push(hitKey(hit))
      used += sep + line.length
      rendered = i + 1
      continue
    }
    const avail = bodyBudget - used - sep - prefix.length
    // 第一条一定要装下；后续条目只有剩余预算够放有效正文（>=40字）时才裁短塞入，否则宁可留完整条。
    if (!lines.length || avail >= 40) {
      const stub = clip(body, Math.max(0, avail))
      if (stub) {
        lines.push(prefix + stub)
        lineKeys.push(hitKey(hit))
        rendered = i + 1
      }
    }
    break
  }
  if (!lines.length) return ''

  const blockText = (bodyLines, notice = '') => [
    head,
    bodyLines.join('\n'),
    notice,
    tail,
  ].filter(Boolean).join('\n')
  const noticeFor = (bodyLines, keys) => {
    const seen = new Set(keys)
    let remaining = 0
    for (const hit of hits) {
      const key = hitKey(hit)
      if (seen.has(key)) continue
      seen.add(key)
      remaining += 1
    }
    // 少量遗漏值得提醒；漏得多时写成「另有 7 条」只会变成每题都有的噪音。
    if (remaining <= 0 || remaining > 3) return ''
    const notice = `（另有 ${remaining} 条相关记录未显示）`
    return blockText(bodyLines, notice).length <= maxChars ? notice : ''
  }

  let notice = rendered < hits.length ? noticeFor(lines, lineKeys) : ''
  // 第一条必须留下；只有多行正文时才允许用最后一条换提示行。
  if (!notice && rendered < hits.length && lines.length > 1) {
    const shorter = lines.slice(0, -1)
    const shorterKeys = lineKeys.slice(0, -1)
    const candidate = noticeFor(shorter, shorterKeys)
    if (candidate) {
      lines.pop()
      lineKeys.pop()
      notice = candidate
    }
  }
  return blockText(lines, notice)
}
