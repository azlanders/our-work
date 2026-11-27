// 相对日期锚定：存档原文里的「昨天/下周二」不换算，模型几乎不会自己按记录日期推，
// 要么答「没写具体日期」，要么把说话当天当成事件当天（基准里相对日期题只过一半）。
// 这里只做无歧义的换算，拿不准的（单说「周五」「那天」）一律不碰。

const DAY = 86400000
const DEFAULT_TZ_OFFSET_MS = 8 * 3600000
const WEEK_INDEX = { 一: 0, 二: 1, 三: 2, 四: 3, 五: 4, 六: 5, 日: 6, 天: 6 }

// 顺序敏感：大后天/大前天 要先于 后天/前天 匹配，否则会被拆成「大＋后天」。
// 边界同样必要：「后天性免疫」不是日期，「大前天」里的「前天」也不是 -2。
const OFFSET_TERMS = [
  ['大后天', 3, /大后天/g],
  ['大前天', -3, /大前天/g],
  ['前天', -2, /(?<!大)前天/g],
  ['昨天', -1, /昨天/g],
  ['今天', 0, /今天/g],
  ['明天', 1, /明天/g],
  ['后天', 2, /(?<!大)后天(?!性)/g],
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
  const taken = new Set()
  const dayStart = localDayStart(atMs, tzOffsetMs)
  for (const [term, delta, re] of OFFSET_TERMS) {
    re.lastIndex = 0
    let m
    while ((m = re.exec(s))) {
      const at = m.index
      if (taken.has(at) || [...taken].some((x) => at < x && x < at + term.length)) continue
      for (let i = at; i < at + term.length; i += 1) taken.add(i)
      out.push({ term, ymd: ymdOf(dayStart + delta * DAY, tzOffsetMs), index: at })
    }
  }
  // 连用修饰（下下周二＝两周后、上上周五＝两周前）按次数累加。
  const weekRe = /((?:上|下){1,2}|这|本)(?:周|星期)([一二三四五六日天])/g
  const monday = mondayStart(atMs, tzOffsetMs)
  let m
  while ((m = weekRe.exec(s))) {
    const at = m.index
    if (taken.has(at)) continue
    for (let i = at; i < at + m[0].length; i += 1) taken.add(i)
    const mod = m[1]
    const weeks = mod.startsWith('上') ? -mod.length : mod.startsWith('下') ? mod.length : 0
    out.push({ term: m[0], ymd: ymdOf(monday + (weeks * 7 + WEEK_INDEX[m[2]]) * DAY, tzOffsetMs), index: at })
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
      const at = m.index
      if (taken.has(at)) continue
      const diff = WEEK_INDEX[m[1]] - cur
      const fwd = diff >= 0 ? diff : diff + 7
      const back = 7 - fwd
      const ymd = ymdOf(day + (fwd <= back ? fwd : -back) * DAY, tzOffsetMs)
      // 「今天周六」这种已经由今天/昨天算过的同一天不重复标注，免得注解占字数又没新信息。
      if (known.has(ymd)) continue
      known.add(ymd)
      for (let i = at; i < at + m[0].length; i += 1) taken.add(i)
      out.push({ term: m[0], ymd, index: at })
    }
  }
  return out.sort((a, b) => a.index - b.index)
}

/** 注入用的一行短注解，最多两条，超过就不加（宁可少一条也不让回忆块被日期撑爆）。 */
export function dateHints(text, atMs, tzOffsetMs = DEFAULT_TZ_OFFSET_MS, opts) {
  const hits = resolveRelativeDates(text, atMs, tzOffsetMs, opts).slice(0, 2)
  if (!hits.length) return ''
  return `（${hits.map((h) => `${h.term}=${h.ymd}`).join('，')}）`
}

/**
 * 把换算结果直接贴到词后面（「上周五(2026-06-05)是…」）。
 * 行尾括号容易被当成装饰跳过：75 道时间题 A/B，行尾括号 53/75，
 * 就地标注 62/72（+14/−3），所以渲染走这条。
 */
export function inlineDateHints(text, atMs, tzOffsetMs = DEFAULT_TZ_OFFSET_MS, opts) {
  const src = String(text || '')
  if (!src) return src
  const hits = resolveRelativeDates(src, atMs, tzOffsetMs, opts).slice(0, 2)
  if (!hits.length) return src
  // 从后往前插，前面命中的下标才不会被打乱。
  let out = src
  for (const h of [...hits].sort((a, b) => b.index - a.index)) {
    const i = h.index
    // 只跳过「本来就跟着日期」的括号；「昨天（其实没去成）」这种括注照样要补。
    if (/^\s*[(（]\s*\d{4}-\d{2}-\d{2}/.test(out.slice(i + h.term.length))) continue
    out = out.slice(0, i + h.term.length) + `(${h.ymd})` + out.slice(i + h.term.length)
  }
  return out
}
