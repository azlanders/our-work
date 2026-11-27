// 两块渲染：状态卡（常驻 system prompt）和回忆块（每轮最多一次注入）。
// 两者都有硬上限——记忆再大也不能把提示词撑爆。
// 时间统一按北京时间（UTC+8）渲染，避免 Linux UTC 宿主机把深夜记忆偏移到前一天。
import { clip } from './text.js'
import { inlineDateHints, resolveRelativeDates } from './dates.js'

const DAY = 86400000
const DEFAULT_TZ_OFFSET_MS = 8 * 3600000

// 裁剪时不让相对日期词被切成半截（「昨天」变成「昨」，括号就成了无主装饰）。
// 截断点落进词内就退到词首，宁可整词丢，也不留半截。
function clipKeepTerms(text, n, anchor, tzOffsetMs) {
  // 与 lib/text.js 的 clip 保持同一套空白规范化：自动归档是「你：…\n我：…」，
  // 不折行会把一条记忆渲染成两行、第二行还丢了编号。
  const src = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (n <= 0) return ''
  if (src.length <= n) return src
  let cut = Math.max(0, n - 1)
  for (const h of resolveRelativeDates(src, anchor, tzOffsetMs)) {
    const s = Number(h.index)
    const e = s + String(h.term || '').length
    if (Number.isFinite(s) && s >= 0 && cut > s && cut < e) { cut = s; break }
  }
  return `${src.slice(0, cut)}…`
}

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
 * 回忆纪律：常驻 system 段，不占每轮证据预算。
 * 2026-11-27：原来挂在回忆块尾部，1200 字预算里被吃掉约 300 字（25% 证据容量），
 * 而且块每次都是新消息、规则也跟着重发。搬到常量段后，规则走固定前缀缓存，块只放原文。
 * 训条取自 CMB 错题实测：183 道「未知当事实」里多数是答对了主点、又补了一句没被问到的细节。
 */
export const RECALL_RULES = `【记忆纪律】读到记忆摘录时按这些规则回答：
1. 只用摘录里的原话作答；摘录里没有的数字、日期、人名、地点一个字都不写，自己推算出来的日期也不写（摘录括号里给出的日期可以直接用）。
2. 只答被问到的点，每个问号一句结论；不解释原因、不叙述经过、不补充没被问到的细节，哪怕是真的。
3. 摘录里有就必须照原话说，措辞不同也算同一条（「做包装设计」=「做设计这一行」），不要用「没提过」否认。
4. 同一件事有多个版本时以最晚的为准；两种说法矛盾又看不出先后，就都列出来并说明无法确定。
5. 过去的状态、计划、猜测、假设不等于现在，别当成已经发生。
6. 摘录确实没有相关内容的，直说记不清，不猜不补。`

/**
 * 短尾注：回忆块插在用户提问之后，模型最后读到的是块本身，所以末位放一句最短的约束。
 * 完整纪律在 system 常驻段（RECALL_RULES），这里只做位置提示，控制在 80 字内。
 */
export const RECALL_TAIL = '（只答问到的点，一句结论；不补摘录里没有的数字、日期、人名，自己算出来的日期也不写；没有就说记不清。）'

/**
 * 回忆块：只放过去存档原文。
 * `tail` 默认是短尾注，传 '' 可完全留空（实验臂用）。
 * 先按整条预算装入，尽量不在句中腰斩。
 */
export function renderRecallBlock(hits, { maxChars = 900, itemChars = 200, now, tzOffsetMs = DEFAULT_TZ_OFFSET_MS, tail = RECALL_TAIL } = {}) {
  if (!hits?.length) return ''
  // 同一句话常被自动归档重复写入（同一轮存两遍、或邻轮扩展把已命中的又并进来一次）。
  // 重复行占满预算却不多给一条证据，先按正文去重，预算留给真正的新内容。
  const list = []
  const seenText = new Set()
  for (const h of hits) {
    const key = String(h?.rec?.text ?? '').replace(/\s+/g, '')
    if (key && seenText.has(key)) continue
    if (key) seenText.add(key)
    list.push(h)
  }
  const head = Number.isFinite(now) ? `【记忆·相关的存档原文｜现在 ${clockText(now, tzOffsetMs)}】` : '【记忆·相关的存档原文】'
  const reserve = head.length + tail.length + 4
  const bodyBudget = Math.max(0, maxChars - reserve)
  if (bodyBudget < 20) return ''

  const lines = []
  const lineKeys = []
  let used = 0
  const hitKey = (hit) => hit?.rec?.id ?? hit?.rec ?? hit
  for (const [i, hit] of list.entries()) {
    const when = ymd(hit.rec.eventAt || hit.rec.createdAt, tzOffsetMs)
    const prefix = `${i + 1}. (${when}) `
    const anchor = hit.rec.spokenAt ?? hit.rec.eventAt ?? hit.rec.createdAt
    // 就地标注：换算括号贴着「上周五」这类词，行尾括号模型会当装饰跳过。
    // 先裁原文（且不切断时间词）再插括号，反过来会把「昨天」和日期一起裁成半截。
    const body = inlineDateHints(clipKeepTerms(hit.rec.text, itemChars, anchor, tzOffsetMs), anchor, tzOffsetMs)
    const line = prefix + body
    const sep = lines.length ? 1 : 0
    if (used + sep + line.length <= bodyBudget) {
      lines.push(line)
      lineKeys.push(hitKey(hit))
      used += sep + line.length
      continue
    }
    const avail = bodyBudget - used - sep - prefix.length
    // 第一条一定要装下；后续条目只有剩余预算够放有效正文（>=40字）时才裁短塞入，否则宁可留完整条。
    if (!lines.length || avail >= 40) {
      const stubRaw = clipKeepTerms(hit.rec.text, Math.max(0, avail), anchor, tzOffsetMs)
      const stub = stubRaw ? inlineDateHints(stubRaw, anchor, tzOffsetMs) : ''
      // inline 会变长，塞不下就放弃，绝不让整块超预算。
      if (stub && used + sep + prefix.length + stub.length <= bodyBudget) {
        lines.push(prefix + stub)
        lineKeys.push(hitKey(hit))
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
  const countMissing = (keys) => {
    const seen = new Set(keys)
    let remaining = 0
    for (const hit of list) {
      const key = hitKey(hit)
      if (seen.has(key)) continue
      seen.add(key)
      remaining += 1
    }
    return remaining
  }
  const noticeText = (n) => `（另有 ${n} 条相关记录未显示）`
  const fits = (bodyLines, text) => blockText(bodyLines, text).length <= maxChars

  let notice = ''
  const missing = countMissing(lineKeys)
  // 少量遗漏值得提醒；漏得多时写成「另有 7 条」只会变成每题都有的噪音。
  if (missing > 0 && missing <= 3) {
    const text = noticeText(missing)
    if (fits(lines, text)) notice = text
    else if (lines.length > 1) {
      // 只有多行正文时才允许用最后一条换提示行；换完仍要少 1-3 条才生效。
      const shorter = lines.slice(0, -1)
      const shorterKeys = lineKeys.slice(0, -1)
      const rest = countMissing(shorterKeys)
      if (rest > 0 && rest <= 3) {
        const alt = noticeText(rest)
        if (fits(shorter, alt)) {
          lines.length = shorter.length
          lineKeys.length = shorterKeys.length
          notice = alt
        }
      }
    }
  }
  return blockText(lines, notice)
}
