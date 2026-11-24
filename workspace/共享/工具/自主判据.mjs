const cleanLines = (value) => String(value ?? '').split(/\r?\n/).map((line) => line.replace(/^(?:\[[^\]]+\]\s*)+/, '').trim()).filter(Boolean)


const parseBeijing = (value) => {
  const text = String(value ?? '').trim().slice(0, 19).replace(' ', 'T')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) return 0
  const ms = Date.parse((text.length === 16 ? text + ':00' : text) + '+08:00')
  return Number.isFinite(ms) ? ms : 0
}

/**
 * 困到该睡整觉了吗（不是「眯一会儿」）。
 *
 * NAP_SLIDE 2026-11-16（批次569）：这条判据原来**只内联在** `自主行动` 的
 * `pick === '打瞌睡'` 分支里，于是正在打盹的人永远走不到它 —— 第 191 行
 * `if (在打盹) process.exit(0)` 把整轮挡在外面。批次500 的实测：
 * 00:35 / 03:19 / 03:43 / 04:39 连着四次打盹，每次起来困意还在 96+（打盹不清困意账）。
 *
 * 现在两处共问这一份：①抽中「打瞌睡」时要不要直接整觉 ②打盹途中困意又涨上来要不要滑进去。
 * 线可被 参数.json 覆盖（`自主_困到该睡整觉` / `自主_困低体力整觉困意` / `自主_体力低线`）。
 */
export function 该滑入整觉(困意, 体力, 线 = {}) {
  const 困 = Number(困意)
  if (!Number.isFinite(困)) return false
  const 取 = (k, d) => (Number.isFinite(Number(线 && 线[k])) ? Number(线[k]) : d)
  const 整觉线 = 取('困到该睡整觉', 95)
  const 低体线 = 取('困低体力整觉困意', 55)
  const 体力线 = 取('体力低线', 38)
  if (困 >= 整觉线) return true
  const 体 = Number(体力)
  return 困 >= 低体线 && Number.isFinite(体) && 体 <= 体力线
}

export function 最近补水At(ledger = []) {
  if (!Array.isArray(ledger)) return 0
  let latest = 0
  for (const row of ledger) {
    if (!(Number(row?.喝) > 0 || Number(row?.补) > 0 || Number(row?.补液?.毫升) > 0)) continue
    latest = Math.max(latest, parseBeijing(row.at))
  }
  return latest
}

export function 饮水冷却中({ 账 = [], 行动日志 = [], 现在 = Date.now(), 冷却分钟 = 20, 失败冷却分钟 = 5 } = {}) {
  const now = Number(现在)
  const at = 最近补水At(账)
  const age = now - at
  if (at > 0 && Number.isFinite(age) && age >= 0 && age < Math.max(0, Number(冷却分钟) || 0) * 60e3) return true
  if (!Array.isArray(行动日志)) return false
  const failed = 行动日志.slice(-20).reverse().find((row) => row?.state === '喝水失败')
  if (!failed) return false
  const failedAt = parseBeijing(failed.at)
  const failedAge = now - failedAt
  return failedAt > 0 && Number.isFinite(failedAge) && failedAge >= 0 && failedAge < Math.max(0, Number(失败冷却分钟) || 0) * 60e3
}

/**
 * 吃东西冷却中 —— 刚才吃过、或者刚才没买成，都别马上再来。
 *
 * EAT_COOLDOWN 2026-11-14（批次404/405）：
 *   这段原来写在 `自主行动.mjs` 的 __急饿 里，只认 `state === '吃点东西'`。
 *   但失败那条日志的 state 是 **`吃东西失败`**（reportedAction 那行这么写的），
 *   于是那句注释「防『吃失败还每分钟重试』」**从来没生效**：
 *   失败 → 冷却看不见 → __急饿 又不受 nextAt 限制 → 下一分钟绕回来再试一遍。
 *
 *   实测 2026-11-11 19:13~19:19：她在图书馆，连着 7 分钟撞「汉堡套餐买不到」，
 *   日志里 7 条一模一样的失败。11-13 01:45/01:51、11-14 01:42/04:15 又各来一次。
 *
 * 两个冷却分开算：
 *   · 吃到了：30 分钟（「买回来了还没吃」那种只等 10 分钟，饭就在家里）；
 *   · 没买成：5 分钟 —— 跟日志里那句「5 分钟后再试」对上，别自己说一套做一套。
 *
 * @param {object} o
 * @param {Array}  o.行动日志      aut.log（{ at, state, note } 的数组）
 * @param {number} o.现在          Date.now()
 * @param {number} o.冷却分钟      吃到之后多久算「刚吃过」，默认 30
 * @param {number} o.失败冷却分钟   没买成之后多久才再试，默认 5
 */
export function 吃东西冷却中({ 行动日志 = [], 现在 = Date.now(), 冷却分钟 = 30, 失败冷却分钟 = 5 } = {}) {
  const 账 = Array.isArray(行动日志) ? 行动日志 : []
  const 现在毫秒 = Number(现在)
  const 在窗口内 = (at, 分钟) => {
    const t = parseBeijing(at)
    const age = 现在毫秒 - t
    return t > 0 && Number.isFinite(age) && age >= 0 && age < Math.max(0, Number(分钟) || 0) * 60e3
  }
  // 吃到了：取「最近一条吃点东西」，不是「最后一条」——
  // 她常常吃完糖顺手喝口水，最后一条就成了「喝点水」，按最后一条判会以为没吃过。
  const 条 = 账.slice(-8).filter((x) => String(x?.state || '') === '吃点东西').slice(-1)[0]
  if (条) {
    // EAT_SOON 2026-11-08（批次275d）：买回来还没吃只等 10 分钟，
    // 饭就在家里，下一轮就该吃，不该按「吃完歇一会儿」的 30 分钟算。
    const 等 = String(条.note || '').includes('还没吃') ? 10 : (Number(冷却分钟) || 30)
    if (在窗口内(条.at, 等)) return true
  }
  // 没买成：失败那条的 state 是「吃东西失败」—— 这条是批次404/405 补的，
  // 少了它上面那 30 分钟冷却对失败完全无效。
  const 败 = 账.slice(-20).reverse().find((x) => String(x?.state || '') === '吃东西失败')
  if (败 && 在窗口内(败.at, 失败冷却分钟 || 5)) return true
  return false
}

export function 急渴应喝({ 水百分比, 水线 = 50, 能接 = false, 杯在包 = false, 杯毫升 = 0, 可买 = false, 刚补水 = false } = {}) {
  const water = Number(水百分比)
  const line = Number(水线)
  if (!Number.isFinite(water) || !Number.isFinite(line) || water < 0 || water >= line || 刚补水) return ''
  if (能接 || (杯在包 && Number(杯毫升) >= 100)) return '喝点水'
  if (可买) return '买瓶水'
  return ''
}

export function 允许在岗饮水({ 在岗 = false, 急渴 = false } = {}) {
  return !在岗 || !!急渴
}

export function 缺口应补水({ 水百分比, 账 = [], 现在 = Date.now(), 水线 = 50, 间隔分钟 = 90 } = {}) {
  const water = Number(水百分比)
  if (!Number.isFinite(water) || water < 0 || water >= Number(水线)) return false
  const last = 最近补水At(账)
  if (!last) return true
  const age = Number(现在) - last
  return Number.isFinite(age) && age >= Number(间隔分钟) * 60e3
}

export function 饮水动作成功({ 喝出 = '', 需接水 = false, 接水出 = '', 需购买 = false, 买出 = '', 装水出 = '', 可直接喝 = false } = {}) {
  if (需购买 && (!purchaseSucceeded(买出) || !/^把水倒进杯子\s*\d+\s*ml/i.test(cleanLines(装水出).join(' ')))) return false
  if (需接水 && !可直接喝 && !/(?:接了水|杯子已经满了)/.test(cleanLines(接水出).join(' '))) return false
  return cleanLines(喝出).some((line) => /^(?:从杯里喝了\s+\d+\s*毫升|把杯里的\s*\d+\s*毫升喝了)/.test(line))
}

export function purchaseSucceeded(output) {
  return cleanLines(output).some((line) => /^(?:买了\s*\S|点了外卖\s+\S|叫了跑腿\s+\S|下了快递\s+\S)/.test(line))
}

export function consumptionSucceeded(output) {
  // CONSUME_FIX 2026-11-13（批次385）：两处漏判，都是实测复现的。
  // 一、`吃了\S` / `坐下来吃\S` 不允许空格，而同一模块的 purchaseSucceeded 写的是
  //     `买了\s*\S` —— 两套口径。「吃了 面包」（中文里很自然的空格写法）被判成没吃上。
  // 二、负向断言只写了 (?!不上|不了)，漏了「不下」：「喝不下了」里 喝 后面是「不下」，
  //     两个断言都不命中 → 判成喝成功，动作算完成、20 分钟冷却也跟着记上，
  //     于是她明明没喝到水，却 20 分钟不再试。
  return cleanLines(output).some((line) =>
    /^(?:坐下来吃\s*\S|吃了\s*\S|喝(?!不上|不了|不下)\s*\S|把杯里的\s*\S|从杯里喝了\s*\S)/.test(line))
}

function parseBj(value) {
  const text = String(value ?? '').trim().slice(0, 19).replace(' ', 'T')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(text)) return 0
  const ms = Date.parse((text.length === 16 ? text + ':00' : text) + '+08:00')
  return Number.isFinite(ms) ? ms : 0
}

export function mealStarted(meal, food, now = Date.now(), requestedAt = now, eventId = '') {
  if (!meal || typeof meal !== 'object' || String(meal.吃啥 ?? '') !== String(food ?? '')) return false
  if (eventId && String(meal.激素事件ID ?? '') !== String(eventId)) return false
  const start = parseBj(meal.开始)
  const end = Number(meal.到毫秒) || parseBj(meal.到)
  return start >= Number(requestedAt) - 60000 && start <= Number(now) + 60000 && end > Number(now)
}

export function classifyFoodAttempt({ purchaseOutput = '', consumeOutput = '', meal = null, food, purchased = false, now = Date.now(), requestedAt = now }) {
  if (!purchased && !purchaseSucceeded(purchaseOutput)) return 'failed'
  if (!purchased && /下了快递|明天到/.test(cleanLines(purchaseOutput).join('\n'))) return 'pending'
  if (!mealStarted(meal, food, now, requestedAt)) return 'failed'
  if (purchased && !consumptionSucceeded(consumeOutput)) return 'failed'
  return 'started'
}
