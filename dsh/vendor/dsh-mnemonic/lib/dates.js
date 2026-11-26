// 相对日期锚定：存档原文里的「昨天/下周二」不换算，模型几乎不会自己按记录日期推，
// 要么答「没写具体日期」，要么把说话当天当成事件当天（基准里相对日期题只过一半）。
// 这里只做无歧义的换算，拿不准的（单说「周五」「那天」）一律不碰。

const DAY = 86400000
const DEFAULT_TZ_OFFSET_MS = 8 * 3600000
const WEEK_INDEX = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }

const OFFSET_TERMS = [
  ['大前天', -3],
  ['前天', -2],
  ['昨天', -1],
  ['今天', 0],
  ['明天', 1],
  ['后天', 2],
]

function localDayStart(ts, tzOffsetMs) {
  const shifted = Number(ts) + tzOffsetMs
  return shifted - (shifted % DAY)
}

function ymdOf(dayStart, tzOffsetMs) {
  const d = new Date(dayStart + tzOffsetMs)
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return `${d.getUTCFullYear()}-${mm}-${dd}`
}

/** 记录时刻的星期一零点（本地日界）。 */
function mondayStart(ts, tzOffsetMs) {
  const day = localDayStart(ts, tzOffsetMs)
  const weekday = new Date(day + tzOffsetMs).getUTCDay()
  return day - ((weekday + 6) % 7) * DAY
}

/**
 * 从原文里找出可确定的相对日期，返回 `{term, ymd}`，按出现顺序、同词只留第一个。
 * 认「昨天/前天/今天/明天/后天/大前天」、带周次的「上周三/这周五/下周二」，以及裸「周一/星期天」。
 */
export function resolveRelativeDates(text, atMs, tzOffsetMs = DEFAULT_TZ_OFFSET_MS, { bare = true } = {}) {
  const s = String(text || '')
  if (!s || !Number.isFinite(Number(atMs))) return []
  const out = []
  const seen = new Set()
  for (const [term, delta] of OFFSET_TERMS) {
    if (!s.includes(term)) continue
    seen.add(term)
    out.push({ term, ymd: ymdOf(localDayStart(atMs, tzOffsetMs) + delta * DAY, tzOffsetMs) })
  }
  const weekRe = /(上|这|本|下)(?:周|星期)([一二三四五六日天])/g
  const monday = mondayStart(atMs, tzOffsetMs)
  let m
  while ((m = weekRe.exec(s))) {
    const term = m[0]
    if (seen.has(term)) continue
    seen.add(term)
    const shift = m[1] === '上' ? -7 : m[1] === '下' ? 7 : 0
    out.push({ term, ymd: ymdOf(monday + (shift + WEEK_INDEX[m[2]]) * DAY, tzOffsetMs) })
  }
  // 裸「周一」没有上/下/这修饰，只能按说话时刻取最近的那一次同星期日期。
  // 两个真实对照都成立：周六说「周一把合影送去」= 两天后的周一；周四说「周一先交了稿」= 三天前的周一。
  // 前后天数之和恒为 7，不可能等距，所以不需要平局规则。
  if (bare) {
    const bareRe = /(?<![上这本下])(?:周|星期)([一二三四五六日天])/g
    const day = localDayStart(atMs, tzOffsetMs)
    const cur = (new Date(day + tzOffsetMs).getUTCDay() + 6) % 7
    const known = new Set(out.map((h) => h.ymd))
    while ((m = bareRe.exec(s))) {
      if (seen.has(m[0])) continue
      seen.add(m[0])
      const diff = WEEK_INDEX[m[1]] - cur
      const fwd = diff >= 0 ? diff : diff + 7
      const back = 7 - fwd
      const ymd = ymdOf(day + (fwd <= back ? fwd : -back) * DAY, tzOffsetMs)
      // 「今天周六」这种已经由今天/昨天算过的同一天不重复标注，免得注解占字数又没新信息。
      if (known.has(ymd)) continue
      known.add(ymd)
      out.push({ term: m[0], ymd })
    }
  }
  return out
}

/** 注入用的一行短注解，最多两条，超过就不加（宁可少一条也不让回忆块被日期撑爆）。 */
export function dateHints(text, atMs, tzOffsetMs = DEFAULT_TZ_OFFSET_MS, opts) {
  const hits = resolveRelativeDates(text, atMs, tzOffsetMs, opts).slice(0, 2)
  if (!hits.length) return ''
  return `（${hits.map((h) => `${h.term}=${h.ymd}`).join('，')}）`
}
