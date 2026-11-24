/**
 * 路由.mjs —— 多把钥匙的顺序故障转移（批次324）
 *
 * 为什么要它：现在只有「主 key + 官方兜底」两级，而且判据只有 401/402/5xx。
 * 实际遇到的病不止这些：
 *   - 中转站余额用完 → 402，她下一句开始全哑，只能等主人发现
 *   - 某把 key 被上游拉黑 → 401/403，同上
 *   - 某把 key 被限流 → 429，其实换一把就能接着说
 *   - 上游抽风 → 5xx / 连不上
 * 这些都不该让主人半夜起来切 key。
 *
 * 做法：把候选档里排好序的钥匙组成一条链，逐个试；失败的那把进冷却，
 * 冷却期内跳过，到点自动复活。**顺序由主人在面板上实时调，改完下一句生效。**
 *
 * 纯函数，无 IO —— 中转只负责「读配置 / 落状态」，判据全在这里，方便单测。
 */

import { 候选时段, 凭证可用, 时段可用, 有效倍率, 基础倍率, 谷期 } from './接口时段.mjs'

/** 各类失败该冷静多久。宁可短一点：她哑 30 秒能忍，哑半小时不能忍。 */
export const 冷却毫秒 = {
  余额不足: 30 * 60e3, // 没钱了只能等人充，试再多次也没用
  钥匙失效: 30 * 60e3, // 被拉黑/删号，同理
  拒绝访问: 3 * 60e3, // 403 可能是 WAF、地区限制，往往一会儿就好
  限流: 90e3,
  上游故障: 45e3,
  连不上: 20e3,
}

/** 余额低于这个数就当「没钱了」，直接跳过（只拦「几乎为零」，不做精算）。 */
export const 默认最低余额 = 0.5

/**
 * ROUTE_KEEP 2026-11-17（批次668）：自动切上游时，把某把钥匙**置顶**，其余顺序原样保留。
 *
 * 事故（2026-11-17 11:30）：`探测上游.mjs` 自动切官方时写了 `路由 = []`。
 * `建链()` 把空路由定义成「退回老行为 = 只试当前这把 + fallback」，而自动切官方之后
 * 当前和兜底是同一把官方 key，按 `base|key` 去重后整条链只剩 1 项 ——
 * 面板「换的顺序」就只剩官方一条，其余两把看着像丢了（候选档其实一直是好的）。
 *
 * 语义：「切换」只该改**先试谁**，不该删成员。
 *
 * @param {string[]} 旧路 现有路由 id 数组
 * @param {Array<{id?:string,key?:string,base?:string}>} 候选 候选档
 * @param {string} 官方Key 兜底里那把官方 key
 * @returns {{路由: string[], 找到: boolean}} 找到=false 表示候选档里没有官方那条
 */
export function 置顶官方(旧路, 候选, 官方Key) {
  const 老 = Array.isArray(旧路) ? 旧路.map((x) => String(x)) : []
  const 列 = Array.isArray(候选) ? 候选 : []
  const 钥 = String(官方Key ?? '')
  const 官 = 列.find((x) => x && String(x.key ?? '') === 钥
    && (!x.base || /deepseek\.com/.test(String(x.base))))
  if (!官 || String(官.id ?? '') === '') return { 路由: 老, 找到: false }
  const 官Id = String(官.id)
  return { 路由: [官Id, ...老.filter((id) => id !== 官Id)], 找到: true }
}

/** 余额数据只信这么久以内的（更旧的可能已经充值了）。 */
const 余额保鲜 = 10 * 60e3

const 数 = (v, 空 = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 空
}

/** 北京时间的「MM-DD HH:MM」，只用于人看。 */
export function 时刻串(ms) {
  return new Date(数(ms) + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')
}

// 「余额不够」的说法各家不同：portdan 用 insufficient balance，
// 官方用 Insufficient Balance，国内站用「余额不足」「额度不足」。
const 没钱话 = /insufficient|no\s*credit|credit\s*(?:is\s*)?(?:too\s*low|exhaust)|balance\s*(?:is\s*)?(?:too\s*low|not\s*enough|insufficient)|余额不足|余额不够|欠费|额度不足|额度已用尽|请充值/i
// 限流：有的站把 quota 用在「这个小时用完了」，那是限流不是没钱 —— 所以 quota 归这里。
const 限流话 = /rate\s*limit|too\s*mani?y\s*request|quota\s*(?:exceed|exhaust|used)|请求(?:过于)?频繁|限流|并发/i

/**
 * 这一次失败该不该换下一把、算哪一类。
 * @param {number} status HTTP 状态码；0 表示连接层就挂了（DNS/超时/被拒）
 * @param {string} 文本 响应体前若干字节（没有就传空串）
 * @returns {{换:boolean, 因:string}}
 */
export function 判失败(status, 文本) {
  const s = 数(status)
  const t = String(文本 || '')
  if (s === 0) return { 换: true, 因: '连不上' }

  // 「没钱」优先于「钥匙失效」：有的站用 401/400 表达余额耗尽，
  // 按钥匙失效处理会白白冷却 30 分钟，等主人充了值也不恢复。
  if (没钱话.test(t)) {
    if (s === 400 || s === 401 || s === 402 || s === 403 || s === 429) return { 换: true, 因: '余额不足' }
  }
  if (s === 402) return { 换: true, 因: '余额不足' }
  if (s === 401) return { 换: true, 因: '钥匙失效' }
  if (s === 403) return { 换: true, 因: '拒绝访问' }
  if (s === 429) return { 换: true, 因: '限流' }
  if (s >= 500) return { 换: true, 因: '上游故障' }
  // 400 只在明确是限流时才换：其余 400 是请求本身的问题，
  // 换一把 key 会得到同样的 400，白白多烧一次上游调用。
  if (s === 400 && 限流话.test(t)) return { 换: true, 因: '限流' }
  return { 换: false, 因: '' }
}

/** 要不要把这个响应体读出来判原因（读掉就没了，所以只在这几种状态码上读）。 */
export function 需要读文(status) {
  const s = 数(status)
  return s === 400 || s === 401 || s === 402 || s === 403 || s === 429
}

/** 官方 Anthropic 兼容端点。候选档里「官方」那一条的 base 是空串，展开时得补上。 */
export const 官方BASE = 'https://api.deepseek.com/anthropic'

/** 把一个候选 + 它的冷却状态变成一个可尝试的 target。 */
export function 成项(x, 状态, 现在, 最低余额, 官方地址 = 官方BASE) {
  const id = String((x && x.id) || '')
  const st = (状态 && 状态[id]) || {}
  const 冷却到 = 数(st.冷却到)
  const 剩 = 冷却到 - 现在
  const 余额 = st.余额 === null || st.余额 === undefined ? null : 数(st.余额, null)
  const 余额于 = 数(st.余额于)
  const 余额新 = 余额 !== null && 余额于 > 0 && 现在 - 余额于 < 余额保鲜
  let 跳过 = ''
  if (剩 > 0) 跳过 = String(st.因 || '冷却') + '，还等 ' + Math.ceil(剩 / 1000) + ' 秒'
  else if (余额新 && 余额 <= 最低余额) 跳过 = '余额只剩 ' + 余额
  const 停用 = x && x.停用 === true
  if (停用) 跳过 = '已停用'
  // KEY_EMPTY_BASE 2026-11-09（批次324）：官方那把在候选档里 base 是空字符串
  // （面板写入时用 base||官方BASE 兜的），这里不补就会把它当无效项丢掉，
  // 结果「路由里有官方」却永远不试它。
  const 原 = String((x && x.base) || '').replace(/\/+$/, '')
  return {
    id,
    名: String((x && x.名) || ''),
    base: 原 || 官方地址,
    key: String((x && x.key) || ''),
    map: x && x.map && typeof x.map === 'object' ? x.map : {},
    倍率: 基础倍率(x),
    当前倍率: 有效倍率(x, 现在),
    峰谷: x && x.峰谷 === true,
    峰倍率: x && x.峰倍率 != null && Number.isFinite(Number(x.峰倍率)) ? Number(x.峰倍率) : null,
    谷倍率: x && x.谷倍率 != null && Number.isFinite(Number(x.谷倍率)) ? Number(x.谷倍率) : null,
    谷期: 谷期(现在),
    停用,
    跳过,
  }
}

/**
 * 组链。
 *
 * 顺序规则（这就是「主人实时调顺序」的全部语义）：
 *   1. `conf.路由` 是 id 数组，从头到尾就是要尝试的顺序；
 *   2. 找不到的 id（被删了）跳过，不报错 —— 删钥匙时不用同步改路由；
 *   3. 末尾追加 `conf.fallback`（官方兜底），去重；
 *   4. **`conf.路由` 为空时退回老行为**：只试「当前这把 + fallback」，
 *      这样没排顺序的部署跟改之前完全一样。
 *
 * @returns {Array<{id,名,base,key,map,跳过}>} 含被跳过的项（面板要展示），
 *          调用方取 `跳过 === ''` 的才是真正会试的。
 */
export function 建链(conf, 候选, 状态, 现在 = Date.now(), 最低余额 = 默认最低余额) {
  if (!Array.isArray(候选)) return []
  const 列表 = 候选
  const byId = new Map()
  for (const x of 列表) {
    const id = String((x && x.id) || '')
    if (id) byId.set(id, x)
  }
  const 链 = []
  const 见过 = new Set()
  // DEDUP_BY_KEY 2026-11-09（批次326）：除了按 id 去重，还要按「base + key」去重。
  // 线上真实撞到：`deepseek 官方` 和 `兜底 · api.deepseek.com` 是同一个 key、同一个地址，
  // 排进路由后链里出现两条一模一样的通道 —— 第一把挂了之后会拿同一把再试一次，
  // 白等一轮延迟，还让「连挂次数」翻倍。
  const 见过钥 = new Set()
  const 推 = (x) => {
    if (!x) return
    const id = String(x.id || '')
    if (id) {
      if (见过.has(id)) return
      见过.add(id)
    }
    const 项 = 成项(x, 状态, 现在, 最低余额)
    if (!项.key) return // 没有 key 的条目直接丢（官方那条 base 为空但 key 一定有）
    项.时段禁用 = !时段可用(候选时段(x), 现在) || !凭证可用(列表, 项.key, 现在)
    if (项.时段禁用) 项.跳过 = '不在允许时段（北京时间）'
    const 钥 = 项.base + '|' + 项.key
    if (见过钥.has(钥)) return
    见过钥.add(钥)
    链.push(项)
  }

  const 路由 = Array.isArray(conf && conf.路由) ? conf.路由.map((x) => String(x)) : []
  if (路由.length) {
    for (const id of 路由) 推(byId.get(id))
  } else if (conf && conf.base && conf.key) {
    // 老配置：没有路由字段 → 只走当前这把
    const 当前候选 = 列表.find((x) => String(x.key || '') === String(conf.key || '')
      && String(x.base || '') === String(conf.base || ''))
    if (!当前候选 || 当前候选.停用 !== true) {
      推({ id: '当前', 名: conf.名, base: conf.base, key: conf.key, map: conf.map })
    }
  }

  const fb = conf && conf.fallback
  if (fb && fb.base && fb.key) {
    // 兜底也走同一个 推()，这样它跟候选里的「官方」重复时会被自动跳过
    推({ id: '兜底:' + String(fb.base), 名: '兜底 · ' + String(fb.base).replace(/^https?:\/\//, ''), base: fb.base, key: fb.key, map: fb.map })
  }

  // RATE_ROUTE 2026-11-23：按当前倍率从低到高试，便宜的先走；
  // 倍率相同保持面板顺序，兜底永远最后。`倍率优先:false` 可退回纯手动顺序。
  if (conf?.倍率优先 !== false) {
    const 兜底 = 链.filter((x) => String(x.id).startsWith('兜底:'))
    const 主 = 链.filter((x) => !String(x.id).startsWith('兜底:'))
    主.sort((a, b) => (Number(a.停用 === true) - Number(b.停用 === true)) || (a.当前倍率 - b.当前倍率))
    链.length = 0
    链.push(...主, ...兜底)
  }
  return 链
}

/**
 * 挑出这一次真正要试的顺序。
 * 全都冷却时**不再跳过**：硬按原顺序试一遍。
 * 理由：宁可打一个可能已经恢复的 key，也不能让她彻底说不了话。
 */
export function 挑顺序(链) {
  const 到点 = (链 || []).filter((x) => !x.时段禁用 && !x.停用)
  const 活 = 到点.filter((x) => !x.跳过)
  if (活.length) return { 试: 活, 全冷却: false }
  return { 试: 到点, 全冷却: 到点.length > 0 }
}

/** 记一次失败：进冷却，累加连续失败次数。 */
export function 记失败(状态, id, 因, 现在 = Date.now()) {
  const next = { ...(状态 || {}) }
  const 旧 = next[String(id)] || {}
  next[String(id)] = {
    ...旧,
    连续失败: 数(旧.连续失败) + 1,
    因: String(因 || '失败'),
    冷却到: 现在 + (冷却毫秒[因] || 60e3),
    最后: 时刻串(现在),
  }
  return next
}

/** 记一次成功：清掉失败与冷却，**余额字段保留**（那是外部查来的，不是这条链管的）。 */
export function 记成功(状态, id, 现在 = Date.now()) {
  const next = { ...(状态 || {}) }
  const 旧 = next[String(id)]
  if (!旧) return next
  const 保 = {}
  if (旧.余额 !== undefined) 保.余额 = 旧.余额
  if (旧.余额于 !== undefined) 保.余额于 = 旧.余额于
  if (旧.币 !== undefined) 保.币 = 旧.币
  next[String(id)] = { ...保, 连续失败: 0, 因: '', 冷却到: 0, 最后: 时刻串(现在) }
  return next
}

/** 给 /health 与面板看的一句话摘要。 */
export function 链摘要(链, 状态, 现在 = Date.now()) {
  return (链 || []).map((x, i) => ({
    序: i + 1,
    id: x.id,
    名: x.名,
    上游: String(x.base || '').replace(/^https?:\/\//, ''),
    跳过: x.跳过 || '',
    时段禁用: x.时段禁用 === true,
    倍率: x.倍率,
    当前倍率: x.当前倍率,
    峰谷: x.峰谷 === true,
    峰倍率: x.峰倍率,
    谷倍率: x.谷倍率,
    谷期: x.谷期 === true,
    停用: x.停用 === true,
    连续失败: 数((状态 || {})[x.id] && 状态[x.id].连续失败),
    余额: (状态 || {})[x.id] && 状态[x.id].余额 !== undefined ? 状态[x.id].余额 : null,
    最后: ((状态 || {})[x.id] || {}).最后 || '',
  }))
}
