/**
 * 未了的事：把「明天告诉你结果」「回头聊这个」这类话单独拎出来。
 *
 * 为什么单独做：状态卡和画像记的是「已经知道的事」，回忆块负责把旧话找回来；
 * 但「约好之后再说」是一条有生命周期的线（说定 → 到期 → 了结），塞进常驻卡会越积越多，
 * 塞进回忆块又只在对方碰巧问到相关词时才出现。陪伴场景里「第二天主动接上一句」
 * 靠的正是这条线，所以给它一个独立入口。
 *
 * 依据：Generative Agents（Park 等，2023）用 reflection 把零散观察归纳成更高层的判断，
 * 而不是每轮从流水账里现翻；陪伴类产品的用户反馈里，「被记得」也一直比「答得全」更靠前。
 *
 * 不做的事：不调模型、不做语义合并、不猜「这事是不是已经办完了」。
 * 只认用户原话，正则抽取 + 确定性日期换算；结算只按两条硬规则：记录已作废、超过 maxAgeDays。
 */
import { parseEventTimestamp, userPartOf } from './text.js'
import { resolveRelativeDates } from './dates.js'

const DAY = 86400000
const HOUR = 3600000
const TZ_OFFSET_MS = 8 * HOUR

// 时间词后面要跟一个「之后会告诉你/给你看」的动作；不然「明天要下雨」也会被当成约定。
const ACTION_RE = /告诉|(?<![小听据])说|(?<!无)聊|给你|发你|答复|回你|回复|试试|看看/

// 没有具体日期，但话本身是往后拖的：这类给 dueAt 0，至少别丢。
// 「回头再说吧」是婉拒，不是约定；只有带具体话题的「回头聊这个」才留。
const DEFER_RE = /等我|回头(?!路|再说|再讲|再聊|吧)|晚点|改天|下次|过几天|过两天/

// 「我明天去医院，别告诉别人」：这句话里有日期也有「告诉」，但它要的是保密，不是提醒。
const SECRET_RE = /(?:别|不要|不用|甭)(?:告诉|跟.{0,6}说|说出去|外传)|保密|别声张|谁都别说/

// 「回头见」「回见」是纯告别，没有可接的话题；「回头聊」这种带动作的仍算未了。
const FAREWELL_RE = /^(?:回头见|回见|先这样)[啊呀吧哦。.!！~～\s]*$/

// dates.js 认「明天/后天/下周二」，这里补它不管的几种整体说法。
const MANUAL_DATES = [
  ['tonight', /今晚|今天晚上|今夜/],
  ['tomorrowNight', /明晚|明天晚上/],
  ['nextWeekend', /下个?周末/],
  ['weekend', /(?:这|本)?周末/],
  ['nextMonth', /下个?月|下一个月/],
  // 「下周二」交给 dates.js，这里只管不带星期几的「下周」。
  ['nextWeek', /下个?(?:周|星期|礼拜)(?![一二三四五六日天])/],
]

// dates.js 还会返回「今天/昨天」；它们多半是在叙述已经发生的事，不当成约定。
const RELATIVE_TERM_RE = /^(?:大后天|后天|明天|(?:(?:上|下){1,2}|这|本)?(?:周|星期)[一二三四五六日天])$/

const WEEKDAY = '日一二三四五六'

function localDayStart(ts) {
  const shifted = ts + TZ_OFFSET_MS
  return shifted - (shifted % DAY)
}

function localWeekday(ts) {
  return new Date(localDayStart(ts) + TZ_OFFSET_MS).getUTCDay()
}

function mondayStart(ts) {
  return localDayStart(ts) - ((localWeekday(ts) + 6) % 7) * DAY
}

function ymdToDayStart(ymd) {
  return Date.parse(`${ymd}T00:00:00+08:00`)
}

function manualDueAt(kind, anchor) {
  // localDayStart 返回的是「北京日零点」的伪时间戳（按 UTC 记的年月日），要减掉偏移才是真实时刻；
  // 不减的话「今晚」会落到次日 04:00。dates.js 那条路用的是 Date.parse(+08:00)，本来就是真实时间。
  const day = localDayStart(anchor) - TZ_OFFSET_MS
  if (kind === 'tonight') return day + 20 * HOUR
  if (kind === 'tomorrowNight') return day + DAY + 20 * HOUR
  if (kind === 'weekend') {
    // 周一到周五说「周末」是接下来的周六；已经在周末里就是当天。
    const weekday = (localWeekday(anchor) + 6) % 7
    return (weekday >= 5 ? day : mondayStart(anchor) - TZ_OFFSET_MS + 5 * DAY) + 10 * HOUR
  }
  if (kind === 'nextWeekend') return mondayStart(anchor) - TZ_OFFSET_MS + 12 * DAY + 10 * HOUR
  if (kind === 'nextWeek') return mondayStart(anchor) - TZ_OFFSET_MS + 7 * DAY + 9 * HOUR
  const d = new Date(day + TZ_OFFSET_MS)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - TZ_OFFSET_MS + 9 * HOUR
}

function matchManual(text, anchor) {
  let best = null
  for (const [kind, re] of MANUAL_DATES) {
    const m = re.exec(text)
    if (!m) continue
    if (!best || m.index < best.index) best = { kind, term: m[0], index: m.index }
  }
  if (!best) return null
  return { term: best.term, index: best.index, dueAt: manualDueAt(best.kind, anchor) }
}

/** 取原文里最先出现的可解析日期；都解析不出来返回 null。 */
function dueOf(text, anchor) {
  const hits = []
  const manual = matchManual(text, anchor)
  if (manual) hits.push(manual)
  for (const h of resolveRelativeDates(text, anchor)) {
    if (!RELATIVE_TERM_RE.test(h.term)) continue
    hits.push({ term: h.term, index: h.index, dueAt: ymdToDayStart(h.ymd) + 9 * HOUR })
  }
  if (!hits.length) return null
  hits.sort((a, b) => a.index - b.index)
  // 「周一我去医院了，明天告诉你结果」：第一个日期是已发生的周一，真正的约定是明天。
  // 有未来日期就优先未来，全在过去才退回最早。
  const dayStart = localDayStart(anchor || Date.now())
  return hits.find((h) => h.dueAt >= dayStart) || hits[0]
}

function anchorOf(rec) {
  const ts = parseEventTimestamp(rec?.spokenAt ?? rec?.eventAt ?? rec?.createdAt)
  return Number.isFinite(ts) ? ts : null
}

function dayDiff(ts, now) {
  return Math.round((localDayStart(ts) - localDayStart(now)) / DAY)
}

function weekdayText(ts) {
  return `周${WEEKDAY[localWeekday(ts)]}`
}

function saidLabelOf(anchor, now) {
  const diff = dayDiff(anchor, now)
  if (diff >= 0) return '今天'
  if (diff === -1) return '昨天'
  if (diff === -2) return '前天'
  if (diff >= -6) return '前几天'
  const d = new Date(anchor + TZ_OFFSET_MS)
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

function dueLabelOf(dueAt, now) {
  const diff = dayDiff(dueAt, now)
  const d = new Date(dueAt + TZ_OFFSET_MS)
  // 晚上八点这一档来自「今晚/明晚」；按小时还原，别把「今晚」说成「今天」。
  const evening = d.getUTCHours() >= 18
  if (diff === 0) return evening ? '今晚' : '今天'
  if (diff === 1) return evening ? '明晚' : '明天'
  if (diff === 2) return '后天'
  if (diff === 3) return '大后天'
  if (diff > 3 && diff <= 7) return weekdayText(dueAt)
  if (diff === -1) return evening ? '昨晚' : '昨天'
  if (diff === -2) return '前天'
  return `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
}

// 日期词在句首时，换成「今天/明天」后句子里的「我」就多余了；先去掉再拼。
// 亲属称谓前的「我」要留（「我妈」不能变成「妈」）。
function bodyOf(text, anchor) {
  const hit = dueOf(text, anchor)
  let body = hit ? text.slice(0, hit.index) + text.slice(hit.index + hit.term.length) : text
  body = body
    .replace(/^[\s，,。.、；;：:！!？?]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^(?:我|俺)(?![妈爸哥姐弟妹爷奶家老])/, '')
    .trim()
  return body || text
}

function renderLine(item, now) {
  const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const anchor = anchorOf(item?.rec)
  const said = anchor ? saidLabelOf(anchor, now) : '之前'
  const dueAt = Number(item?.dueAt) || 0
  const due = dueAt > 0 ? dueLabelOf(dueAt, now) : ''
  const body = bodyOf(text, anchor ?? now)
  const verb = /^(?:说|讲)/.test(body) ? '提过' : '说'
  return `你${said}${verb}${due}${body}`
}

/**
 * 从记录里抽「还没了结的约定」，最多 3 条，按 dueAt 升序。
 * 只做两条结算规则：supersededBy 跳过；比 maxAgeDays 老的跳过。
 */
export function openLoops(records, { scopes, now = Date.now(), maxAgeDays = 14 } = {}) {
  const allow = Array.isArray(scopes) ? new Set(scopes.map((s) => s || '')) : null
  const ageLimit = Number(maxAgeDays)
  const items = []

  for (const rec of records || []) {
    // 用户说过「别老提这个」的（muted）不再按周期翻出来催。
    if (!rec?.text || rec.supersededBy || rec.muted) continue
    if (allow && !allow.has(rec.scope || '')) continue
    const anchor = anchorOf(rec)
    const at = anchor ?? now
    const text = userPartOf(rec.text).replace(/\s+/g, ' ').trim()
    if (!text || FAREWELL_RE.test(text)) continue
    if (SECRET_RE.test(text)) continue
    const due = dueOf(text, at)
    if (due) {
      if (!ACTION_RE.test(text)) continue
    } else if (!DEFER_RE.test(text)) {
      continue
    }
    // 约定还没到期时，不能因为「说这句话」已经过去很多天就把它删掉。
    // 「下个月给你答复」可以说在二十天前，但 dueAt 仍在未来。
    const ageAnchor = due && due.dueAt >= now - 2 * DAY ? due.dueAt : at
    if (Number.isFinite(ageLimit) && now - ageAnchor > ageLimit * DAY) continue
    items.push({ rec, dueAt: due ? due.dueAt : 0, text, at })
  }

  // 同一句「回头聊这个」可能在多个 scope 各存了一份；留最新那份，别渲染两行一样的。
  items.sort((a, b) => b.at - a.at)
  const seen = new Set()
  const uniq = []
  for (const item of items) {
    if (seen.has(item.text)) continue
    seen.add(item.text)
    uniq.push(item)
  }

  // 有具体日期的排前面，没日期的「回头聊」垫底；否则 maxLines=2 时会挤掉真正到期的那条。
  return uniq
    .sort((a, b) => (a.dueAt || Infinity) - (b.dueAt || Infinity) || b.at - a.at)
    .slice(0, 3)
    .map(({ rec, dueAt, text }) => ({ rec, dueAt, text }))
}

/**
 * 渲染成一句聊天里能直接接上的话：
 *
 * 【还没聊完的】
 * · 你昨天说今天告诉我面试结果
 *
 * 预算按整块算（含标题），先保证标题和第一条，再决定第二条塞不塞得下。
 */
export function renderOpenLoops(items, { maxLines = 2, maxChars = 90, now = Date.now(), onRender = null } = {}) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) return ''
  const header = '【还没聊完的】'
  const capChars = Number(maxChars) || 0
  const capLines = Math.max(0, Math.floor(Number(maxLines) || 0))
  if (!capLines || capChars <= header.length + 3) return ''

  const lines = []
  const shown = []
  for (const item of list) {
    if (lines.length >= capLines) break
    const line = renderLine(item, now)
    if (line) {
      lines.push(line)
      shown.push(item)
    }
  }
  if (!lines.length) return ''

  let out = header
  const rendered = []
  for (const [i, line] of lines.entries()) {
    const room = capChars - out.length - 3 // 「\n· 」占 3 字
    if (room <= 0) break
    const body = line.length <= room ? line : line.slice(0, room - 1) + '…'
    out += `\n· ${body}`
    rendered.push(shown[i])
    if (body.length < line.length) break
  }
  if (onRender) for (const item of rendered) onRender(item)
  return out === header ? '' : out
}
