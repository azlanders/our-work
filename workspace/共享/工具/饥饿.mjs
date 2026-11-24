// 饥饿.mjs —— 对外那张「几分饱」的脸（2026-11-07 换成新账）
//
// 数字不再由这里算：毫升、千卡、顶胃全在 饱渴.mjs（按主人定的 2000 毫升 / 2000 千卡）。
// 这里只做三件事：① 把 0~100 的「饱腹」换算给别处用；② 记今天吃了几顿花了多少钱；
// ③ 老的命令行（--看 / --吃 / --tick / --dry）照旧能用，别处不用改。
import { 改档 } from './_底层.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import * as 饱渴 from './饱渴.mjs'
import * as 物品表 from './表.mjs'

const MEM = process.env.HUNGER_MEM || process.env.GAP_MEM || process.env.QQ_ACT_MEM
  || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const FILE = path.join(MEM, '饥饿.json')   // 只存「今天几顿、花了多少」这类记账

export const 醒着掉 = 1.4      // 千卡/分钟（换算口径，别处当作「安静时」）
export const 睡着掉 = 0.56     // 四成
// MEAL_LINE 2026-11-17（批次599）：一顿正经饭的门槛只留一处。
// 原来 吃() 判 >=400、记一顿() 判 >=350，360 千卡的饼干走两条路口径不同，
// 面板上「今天几顿」会跟着调用路径漂。
const 一顿门槛 = 400

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 解析 = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00'); return Number.isFinite(t) ? t : 0 }
const 今天 = (ms = Date.now()) => 北京(ms).slice(0, 10)

export function 读(now = Date.now()) {
  const r = 饱渴.读(now)
  const 记账 = load(FILE, {})
  const 天 = 今天(now)
  const 今 = 记账.今天 && 记账.今天.日期 === 天 ? 记账.今天 : { 日期: 天, 顿: 0, 钱: 0, 零食: 0 }
  // 胃里塞的东西也算「当下觉得饱」，但不给热量——这是水和汤那点临时饱腹
  const 胃百 = Math.round(r.胃 / 饱渴.胃满 * 100)
  // HUNGER_VISIBLE 2026-11-07（主人问「饥饿 38% 怎么显示不饿」）：
  // 原来把胃里塞的水也算一半进「饱腹」，一升水就把 38% 抬到 88%，看着像不饿。
  // 肚子被水撑满不等于有热量——对外那个数只认千卡，胃里的量单独当「临时」报。
  const 有效 = Math.round(r.卡百分比 * 10) / 10
  return {
    ...记账, 饱腹: 有效, 食物: r.卡百分比, 卡: r.卡, 水: r.水, 水百分比: r.水百分比,
    临时: 胃百, 血糖: r.血糖, 饱腹感: 饱渴.饱腹感(胃百, r.血糖), 档: r.卡档, 水档: r.水档, 渴话: 饱渴.渴话(r.水百分比), 欠: r.欠, 双低: r.双低,
    最后吃At: 记账.最后吃At || '', 最后吃了: 记账.最后吃了 || '',
    今天: 今, 账: r.账,
  }
}

/**
 * 饿着吗 —— 「她饿不饿」这件事的唯一判据（批次415）。
 *
 * 原来有三处各自 `load('饥饿.json').饱腹 <= 10`：自动作息:341、醒来:119、状态推进:232。
 * 而 `饥饿.json` 里的 `饱腹` 是个**死字段** —— `吃()` 存的时候 `out` 里没有它，
 * `...记账` 带的是旧值，于是它停在一个历史数字（实测线上恒为 55），
 * 而 `读()` 现算出来是 98。三处判据的输入是常数，等于从来没生效过。
 *
 * 现在只此一处问，且问的是现算值。阈默认 10（原来三处都写死 10）。
 */
export function 饿着(阈 = 10, now = Date.now()) {
  try { return Number(读(now).饱腹) <= Number(阈) } catch { return false }
}

export const 标签 = (值) => 饱渴.档(Number(值) || 0).名 === '满' ? '不饿'
  : 饱渴.档(Number(值) || 0).名 === '轻' ? '有点空'
  : 饱渴.档(Number(值) || 0).名 === '中' ? '饿了'
  : 饱渴.档(Number(值) || 0).名 === '重' ? '很饿' : '饿得发慌'

export function 说(值) {
  const v = Math.round(Number(值) || 0)
  return `${标签(v)}（${v}/100）—— 想吃点东西的话，饱渴那份表里挑一样就行`
}

/** 主观饱腹 2026-11-08（批次223）：胃 60% + 血糖 40% —— 主人原话「受胃里的东西和血糖影响的」。
 *  千卡不进来（原来 0.35 的千卡项已撤）；算法本体在 饱渴.饱腹感，这里只做转发，免得两处各算一套。 */
export function 主观饱腹(胃百分比, 血糖) {
  return 饱渴.饱腹感(胃百分比, 血糖)
}

export function 想吃意向(值, 距上次分钟 = 999) {
  const v = Number(值) || 0
  if (v >= 85) return 0
  let x = v >= 72 ? 0.06 : v >= 58 ? 0.18 : v >= 42 ? 0.42 : v >= 26 ? 0.72 : v >= 12 ? 0.92 : 1
  const m = Number(距上次分钟)
  if (Number.isFinite(m) && m >= 0) {
    if (m < 30) x *= 0.15
    else if (m < 60) x *= 0.35
    else if (m < 100) x *= 0.65
  }
  return Math.round(x * 1000) / 1000
}

// 吃/喝统一入口：先按口粮表结算，再补一层「加多少千卡/临时饱腹」的兼容
export function 吃({ 名 = '', 加 = 0, 临时加 = 0, 价 = 0, 类别 = '吃', at = 0 } = {}) {
  const now = Number(at) || Date.now()
  // RET_FIELD 2026-11-17（批次599）：`前` 原来直接抄 `后`，命令行永远显示「50 → 50」。
  // 吃之前先取一次现算值，返回值才是真的「前 → 后」。
  const 前值 = 读(now).饱腹
  // 表口径 2026-11-07（批次156）：只认 表.mjs。口粮表已归档（34 条全被总表覆盖）。
  const 表 = 物品表.所有()
  let kcal = 0, 补 = 0, 胃 = 0
  if (表[名]) {
    const r = 饱渴.吃(名, now)
    kcal = r ? r.kcal : 0; 补 = r ? r.补 : 0; 胃 = r ? r.顶 : 0
  } else {
    // 表里没有：把「加」当作饱腹点数（1 点 = 20 千卡），临时加当作毫升
    kcal = Math.max(0, Number(加) || 0) * 20
    补 = Math.max(0, Number(临时加) || 0)
    // KCAL_FIX 2026-11-13（批次385）：原来这里写的是 `if (kcal) 饱渴.喝(0, now)` ——
    // 「喝 0 毫升」只固化衰减、一个卡都不加，算出来的 kcal 就这么丢了。
    // 活动.mjs:148 真的走这条路（在餐厅/咖啡店随机活动选到「吃」时 加: 42 = 840 千卡），
    // 后果是「顿数 +1 但饱腹不涨」，等于记了一顿没吃。
    // 补液() 本来就是为「水 + 卡一起进、但不走口粮表」写的（批次224 医院挂水）。
    if (kcal || 补) 饱渴.补液(补, kcal, 0, now)
  }
  // HUNGER_FIELD 2026-11-14（批次415）：`out` 里原来没有 `饱腹`，`...记账` 带的是旧值 ——
  // 这个字段从某天起就停住了（实测 55，而现算是 98），还有三处判据在读它。
  // 先算后写：`后` 不依赖 save，挪到前面才有最新值可存。
  const 后 = 读(now)
  let out = null
  // 批次609：锁内重读再改。心跳的 记一顿 / 面板改千卡 与这里并发时，
  // 原来「读整档 → 算 → 整档写」会把别人刚写的顿数/饱腹缓存抹掉。
  改档(FILE, (记账) => {
    const 今 = 记账.今天 && 记账.今天.日期 === 今天(now) ? { ...记账.今天 } : { 日期: 今天(now), 顿: 0, 钱: 0, 零食: 0 }
    if (String(类别) === '吃' && kcal >= 一顿门槛) 今.顿 += 1
    今.钱 = Math.round((Number(今.钱) || 0) + (Number(价) || 0))
    if (String(类别) !== '吃') 今.零食 += 1
    out = {
      今天: 今,
      最后吃At: kcal >= 100 ? 北京(now) : (记账.最后吃At || ''),
      最后吃了: kcal >= 100 ? 名 : (记账.最后吃了 || ''),
    }
    记账.今天 = out.今天
    记账.最后吃At = out.最后吃At
    记账.最后吃了 = out.最后吃了
    记账.饱腹 = 后.饱腹
  }, {})
  return { ...out, 后: 后.饱腹, 前: Math.round(前值), 标签: 标签(后.饱腹), kcal, 补, 胃 }
}


/** 仅登记今日顿数与最后进食时间（供 吃饭.mjs 分分钟结算完成后调用，避免重复加 kcal）。 */
export function 记一顿({ 名 = '', 类别 = '吃', 价 = 0, at = 0 } = {}) {
  const now = Number(at) || Date.now()
  const 项 = 物品表.查(名)
  const kcal = Number(项?.吃?.kcal ?? (类别 === '吃' ? 500 : 120)) || 0
  // HUNGER_CACHE 2026-11-17（批次596）：`记一顿` 原来只写顿数/最后吃，
  // 面板直接改千卡后 `饥饿.json.饱腹` 会停在旧值（雷霆体检一直报缓存漂）。
  // 现算一次再存；读的是 饱渴 的唯一账，不二次加卡。
  const 后 = 读(now)
  let out = null
  改档(FILE, (记账) => {
    const 今 = 记账.今天 && 记账.今天.日期 === 今天(now) ? { ...记账.今天 } : { 日期: 今天(now), 顿: 0, 钱: 0, 零食: 0 }
    if (String(类别) === '吃' && kcal >= 一顿门槛) 今.顿 += 1
    else 今.零食 += 1
    今.钱 = Math.round((Number(今.钱) || 0) + (Number(价) || 0))
    out = {
      今天: 今,
      最后吃At: kcal >= 100 ? 北京(now) : (记账.最后吃At || ''),
      最后吃了: kcal >= 100 ? 名 : (记账.最后吃了 || ''),
    }
    记账.今天 = out.今天
    记账.最后吃At = out.最后吃At
    记账.最后吃了 = out.最后吃了
    记账.饱腹 = 后.饱腹
  }, {})
  return { ...out, 饱腹: 后.饱腹 }
}

/**
 * 只刷新派生缓存 `饥饿.json.饱腹`，不推进衰减、不二次加卡。
 *
 * CACHE_REFRESH 2026-11-17（批次677）：`tick` 原来只 `饱渴.推进()` 后 return 现算，
 * 不写回 `饥饿.json`；面板直接改千卡后缓存会停在旧值（线上 105.6 vs 现算 87.7）。
 * 吃()/记一顿() 已经各自写回；这里给 tick 和面板改千卡共用同一条刷新路径。
 */
export function 刷新饱腹(now = Date.now()) {
  let 后 = null
  改档(FILE, (记账) => {
    后 = 读(now)
    记账.饱腹 = 后.饱腹
  }, {})
  return 后 || 读(now)
}

export const tick = (now = Date.now()) => {
  饱渴.推进(now)
  return 刷新饱腹(now)
}

export function 距上次分钟(d = null) {
  const x = d || 读()
  const t = 解析(x.最后吃At)
  return t ? Math.max(0, Math.round((Date.now() - t) / 60e3)) : 999
}

// ---------- 命令行 ----------
const 是主 = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (是主) {
  const args = process.argv.slice(2)
  const dry = args.includes('--dry')
  const val = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] ?? d) : d }
  const d = 读()
  const 距 = 距上次分钟(d)
  const 意向 = 想吃意向(d.饱腹, 距)
  if (args.includes('--吃')) {
    if (dry) { console.log(`[dry] 不吃，保持 ${d.饱腹}`); process.exit(0) }
    const r = 吃({ 名: val('--吃'), 加: Number(val('--加', 0)), 临时加: Number(val('--临时', 0)), 价: Number(val('--价', 0)), 类别: val('--类别', '吃') })
    console.log(`吃了${val('--吃')}｜饱腹 ${r.前} → ${r.后}（${r.标签}）｜${r.kcal} 千卡`)
    process.exit(0)
  }
  if (args.includes('--tick')) {
    if (dry) { console.log(`[dry] ${饱渴.说()}`); process.exit(0) }
    const t = tick()
    console.log(`${饱渴.说()}｜今天 ${t.今天.顿} 顿 ${t.今天.钱} 块`)
    process.exit(0)
  }
  console.log(饱渴.说())
  console.log(`饱腹 ${d.饱腹}/100 —— ${标签(d.饱腹)}（食物 ${d.食物}%，胃里还塞着 ${d.临时}%）`)
  console.log(`  距上次吃：${距 >= 999 ? '很久了（账上没有）' : 距 + ' 分钟前'}${d.最后吃了 ? '（' + d.最后吃了 + '）' : ''}`)
  console.log(`  还想吃：${Math.round(意向 * 100)}%｜今天 ${d.今天.顿} 顿，${d.今天.零食} 次零嘴，${d.今天.钱} 块`)
}
