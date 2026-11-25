#!/usr/bin/env node
/**
 * 自主行动.mjs —— 她自己安排做什么，也自己安排什么时候再做。
 *
 * cron 可以每分钟调用一次，但这里只检查 nextAt：没到就退出，不选动作、不烧 token。
 * 到点后按精力、心情、激素、近期重复程度挑一件事；做完再算下一次间隔。
 * B站/贴吧学习轮会额外返回 SELF_NEXT_MINUTES，那是她在学习后自己定的时间，优先采用。
 *
 * 用法：--tick / --看 / --dry（只演示，不写状态、不联网）/ --试走动 / --试吃东西 / --试拍照
 */
import { 写档 } from './_底层.mjs'
import { 睡着 } from './睡态.mjs'
import { 改 as 改自主 } from './自主状态.mjs'
// OCCUPY 2026-11-07（批次167）：占用态的判据只在 占用.mjs 一份
import { 在岗的班, 在打盹, 在吃饭, 在洗澡, 在看病 } from './占用.mjs'
// NAP_READBACK 2026-11-16（批次560）：打盹的到点只有一份真值（睡态.盹到点 读 打盹.json）。
// 以前这里自己 `Date.now() + _分钟`，跟 打盹.json 里那一刻的真相各算各的。
import { 盹到点 } from './睡态.mjs'
import { 读资产再判 } from './睡在哪.mjs'
// OPEN_FILTER 2026-11-14（批次404）：挑吃的之前先问一句「这个点买得到吗」——
// 判据统一在 买得到.mjs（和 花钱.mjs 的营业时间闸同源），这里不再自己写一套。
import { 读档 as 读地点档 } from './地点.mjs'
import { 算激素倾向 } from './_总线.mjs'
import { 现在能买 } from './买得到.mjs'
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, renameSync, mkdirSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { join } from 'node:path'
// HUNGER 2026-11-06（批次139）：饱腹决定「还想不想吃」。
import * as 饥饿 from './饥饿.mjs'
// SICK_IMPORT 2026-11-12：下面 SICK_LEAN / SICK_DOCTOR 用的 疾病.倾向() / 疾病.读() 从批次221 起就没 import，
// ReferenceError 被那两处 try/catch 吞成 null —— 「想躺着 / 去医院 / 去药店」从没进过池子。
import * as 疾病 from './疾病.mjs'
// WATER 2026-11-08（批次223）：接水点判据和杯里剩多少，跟 物品.mjs 问同一个模块。
import { 能接水, 杯态 } from './水点.mjs'
// XINQI 2026-11-07（批次187）：心气行里的「昨晚那个梦」要和梦文件去重
import { 只留心气, 去重池 } from './心气.mjs'
import { classifyFoodAttempt, purchaseSucceeded, 急渴应喝, 饮水冷却中, 允许在岗饮水, 饮水动作成功, 吃东西冷却中, 该滑入整觉 } from './自主判据.mjs'
import { 该赴的班 as 共享该赴的班 } from './排班判据.mjs'
import { 一次性动作, 吃喝动词, 压制账推进 } from './在干嘛.mjs'

const base = process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const tools = process.env.QQ_AUTONOMY_TOOLS || '{{BOT_ROOT}}/共享/工具'
const stP = join(base, '状态.json')
const autP = join(base, '自主.json')
const chainP = join(base, '链.md')
const LOCK = join(base, '.自主行动.lock')
const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const QUIET = args.includes('--quiet') // cron 用：睡觉/互斥等待不写日志，避免每分钟一条噪音
const 试黑话 = args.includes('--试黑话')
const 试走动 = args.includes('--试走动')
const 试吃东西 = args.includes('--试吃东西')
const 试拍照 = args.includes('--试拍照')
// SHOWER 2026-11-05（批次89）：洗澡以前只有 cron 在掉清洁、没人洗（次数 0）。
// --试洗澡 只用于验这条分支，正式 cron 没有这个旗标。
const 试洗澡 = args.includes('--试洗澡')
const 试断片 = args.includes('--试断片')   // MICROSLEEP（566）：验这条分支，正式 cron 没有这个旗标
// NAP_SLIDE 之后补的两个：发呆拆成刷手机/玩电脑（批次570），只用于验分支
const 试刷手机 = args.includes('--试刷手机')
const 试玩电脑 = args.includes('--试玩电脑')
// MICROSLEEP_OFF 2026-11-16（批次566）：**测试专用开关。**
// 断片是随机的，而「困了要能打断安排」「打盹别被重置」这两个用例的沙盒本来就困意很高 ——
// 随机断片会把 pick 改掉，两条稳定红（t542/t545 各跑 2 次都 1 fail）。
// 跟 QUIET_NOTE 同一个套路：测试可以关掉随机源，生产永远开着。
const 断片关 = process.env.QQ_NO_MICROSLEEP === '1'
const forced = 试走动 || 试吃东西 || 试拍照 || 试洗澡 || 试黑话 || 试断片 || 试刷手机 || 试玩电脑

let _PJ = {}
try { _PJ = JSON.parse(readFileSync(join(tools, '参数.json'), 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)
const load = (p, fb) => {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return v === null || typeof v !== 'object' ? fb : v
  } catch { return fb }
}
const save = (p, o) => 写档(p, o, { 不写: DRY })
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const rand = (lo, hi) => lo + Math.random() * (hi - lo)
const bjDate = (at = Date.now()) => new Date(Number(at) + 8 * 3600e3)
const dayKey = bjDate().toISOString().slice(0, 10)
export function 念头动作加权(state, weight, thoughts = [], now = Date.now()) {
  const baseWeight = Number(weight)
  if (!Number.isFinite(baseWeight) || baseWeight <= 0 || !Array.isArray(thoughts)) return weight
  const 对应动作 = { 花: '买东西', 去: '走动', 吃存货: '吃点东西' }
  const 时间戳 = (value) => {
    if (typeof value === 'number') return value
    const raw = String(value || '').trim()
    if (!raw) return NaN
    const iso = raw.includes('T') ? raw : raw.replace(' ', 'T')
    return Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}+08:00`)
  }
  const freshMatch = thoughts.some((thought) => {
    if (对应动作[String(thought?.想到 || '')] !== state) return false
    const at = 时间戳(thought?.at)
    const age = Number(now) - at
    return Number.isFinite(at) && age >= 0 && age <= 30 * 60e3
  })
  return freshMatch ? Math.round(baseWeight * 1.35) : weight
}
export function 计划动作加权(state, weight, todayPlan) {
  const w = Number(weight)
  if (!(w > 0)) return weight
  const goals = Array.isArray(todayPlan?.goals) ? todayPlan.goals : []
  const done = Array.isArray(todayPlan?.done) ? todayPlan.done : []
  const active = new Set(goals.map((g) => g?.id).filter((id) => id && !done.includes(id)))
  if (!active.size) return weight
  if (state === '吃点东西' && active.has('好好吃一顿')) return Math.round(w * 1.35)
  if (state === '打零工' && active.has('挣点钱')) return Math.round(w * 1.6)
  if (state === '打瞌睡' && active.has('补个觉或者喝咖啡')) return Math.round(w * 1.4)
  if (state === '学点东西' && active.has('看点书')) return Math.round(w * 1.35)
  if (state === '走动' && ['出门散散心', '看场电影', '去游乐园', '看点书'].some((k) => active.has(k))) {
    return Math.round(w * 1.45)
  }
  return weight
}
const __今日计划 = load(join(base, '计划.json'), { days: {} }).days?.[dayKey] || { goals: [], done: [] }
const nowStr = bjDate().toISOString().slice(0, 16).replace('T', ' ')

const aut = load(autP, { state: '待命', since: 0, nextAt: 0, log: [] })
if (!Array.isArray(aut.log)) aut.log = []

// 批次169：差量写。原来结尾是 save(autP, aut) —— 整份覆盖。
// 但这一轮跑十几秒，中间 家区域/工作/洗澡/打盹 都可能刚写过 自主.json，
// 拿启动时读的旧副本整份盖回去，就把它们刚写的东西抹了。
// 现在只写「这一轮真改过的字段」，log 按条追加（子进程 打盹.mjs 写的那条也保得住）。
const 起点 = JSON.parse(JSON.stringify({ ...aut, log: [] }))
const 本轮log = []
function 存自主() {
  if (DRY) return 0
  const 现 = JSON.parse(JSON.stringify({ ...aut, log: [] }))
  const 变 = {}
  for (const k of Object.keys(现)) {
    if (JSON.stringify(现[k]) !== JSON.stringify(起点[k])) 变[k] = aut[k]
  }
  改自主(base, (真) => {
    Object.assign(真, 变)
    if (本轮log.length) 真.log = [...(Array.isArray(真.log) ? 真.log : []), ...本轮log].slice(-200)
  })
  Object.assign(起点, 现)
  起点.log = []
  本轮log.length = 0
  return 1
}
const st = load(stP, {})
const assets = load(join(base, '资产.json'), { 钱: 0, 位置: '家' })
const __工作档 = load(join(base, '工作.json'), { 班次: [] })
const hormones = load(join(base, '激素.json'), { v: {} }).v || {}
// HORMONE_BEHAVIOR 2026-11-16（批次573）：激素 → 行为倾向（判据在 _总线.算激素倾向）。
// 唤醒高 = 坐不住（更想动、更想看刺激的）；压力高 + 静不下来 = 想缩着（更容易翻旧账）。
// 跟 curiosity 不是一回事：那个用多巴胺/皮质醇（奖赏 vs 压力），这个用肾上腺素（急性唤醒）。
//
// **必须定义在第一次使用（push('走动')）之前。** 第一版放在 curiosity 后面（第 486 行），
// 而 push('走动') 在第 471 行 —— const 不提升，TDZ 直接 ReferenceError，自主行动 整个起不来。
// 那次 t573 只做了静态断言（grep 到了「想动」），所以绿着；真跑 t569/t570 才炸出来。
const { 想动, 想缩 } = 算激素倾向({ v: hormones })
// SHOWER 2026-11-05（批次89）：清洁度是身体状态，原来只有 cron 在掉、没有任何东西会让她去洗。
// 洗澡是线下动作：只在家或澡堂、醒着、且没在洗的时候才进候选。
let 卫生 = load(join(base, '卫生.json'), { 清洁: 86 })
let 清洁 = Number(卫生.清洁 ?? 86)
// 批次167：判据在 占用.mjs。注意洗澡档里的 `到` 是【清洁度数字】，时间是 `结束`。
let 在洗 = !!在洗澡(base)
const energy = Number(st.energy ?? 60)
const mi = Number(st?.mood?.intensity ?? 0)
// SLEEPY_FROM_STATE 2026-11-06（批次134）：这一行原来只读 状态.熬夜.over ——
// 那个字段只有「熬夜惩罚」触发时才存在，平时是 undefined，于是 sleepy 常年 null，
// 下面 `if (sleepy && sleepy >= 78)` 一次都没成立过：打瞌睡写了半年，从没触发。
// 真值在 状态.困意（困意.mjs 每轮现算并回写），熬夜时再叠加罚分。
const sleepy = (() => {
  const v = Number(st?.困意)
  const over = Number(st?.熬夜?.over || 0)
  if (Number.isFinite(v) && v >= 0) return Math.round(v + (over > 0 ? over : 0))
  return over > 0 ? 100 + over : null
})()

if (args.includes('--看')) {
  const mins = Math.round((Date.now() - Number(aut.since || 0)) / 60e3)
  const wait = Math.max(0, Math.ceil((Number(aut.nextAt || 0) - Date.now()) / 60e3))
  console.log(`现在：${aut.state}（已经 ${mins} 分钟）`)
  console.log(aut.nextAt ? `下次由她安排：${bjDate(aut.nextAt).toISOString().slice(0, 16).replace('T', ' ')}（还有 ${wait} 分钟）` : '下次：还没安排，清醒时会重新选')
  for (const it of aut.log.slice(-5)) console.log('  ' + it.at + ' ' + it.state + (it.note ? '：' + it.note : ''))
  process.exit(0)
}
if (!args.includes('--tick') && !forced && !DRY) {
  console.log('用法：--tick / --看 / --dry / --试走动 / --试吃东西 / --试拍照 / --试洗澡 / --试黑话 / --试断片')
  process.exit(0)
}

// 1) 睡着就不动。测试旗标只用于验分支，正式 cron 没有这些旗标。
const flag = load(join(base, '睡醒.json'), {})
// 批次164：判断只认 睡着()；flag 留着，下面要用 since 和 266 行那个条件。
const 在睡 = 睡着(base)
if (在睡 && !forced && !DRY) { if (!QUIET) console.log('她在睡，不动'); process.exit(0) }

// NAP_HOLD 2026-11-06（批次134）：打盹是连续动作，中途不该被换成「发呆」。
// 它不写 睡醒.json（写了会把清醒时长清零，还会让 自动作息 往 睡眠.json 推阶段），
// 所以这里单独认一次 打盹.json。
// NAP_SLIDE 2026-11-16（批次569）：这一轮是不是「打盹睡到一半滑进整觉」。
// 声明在早退之前 —— 那个分支要用，pick 那两个地方也要用。
let 从打盹滑入 = false
if (!forced && !DRY) {
  try { execFileSync(process.execPath, [join(tools, '打盹.mjs'), '--tick'], { encoding: 'utf8', timeout: 10000 }) } catch { /* 结算失败下次再试 */ }
  // 先结算再判（结算会改 打盹.json）。批次167 起判据在 占用.mjs。
  if (在打盹(base)) {
    // NAP_SLIDE（批次569）：**打盹滑入整觉。**
    // 原来这里无条件 exit —— 于是「困到该睡整觉」那条判据对正在打盹的人永远不生效，
    // 整夜在「眯 40 分钟 → 起来还是困 → 再眯」里转（批次500 的实测）。
    // 过线就不退出，把这一轮强制成「打瞌睡」：那一支会先收打盹、再判家、再 startSleep。
    // 判据只有 自主判据.该滑入整觉 一份；**家**仍然问 读资产再判（批次542：不许睡在便利店）。
    if (!该滑入整觉(sleepy, st?.layers?.physical, {
      困到该睡整觉: H('自主_困到该睡整觉', 95),
      困低体力整觉困意: H('自主_困低体力整觉困意', 55),
      体力低线: H('自主_体力低线', 38),
    })) {
      if (!QUIET) console.log('她在打盹，这一轮不换动作')
      process.exit(0)
    }
    if (!QUIET) console.log('打盹睡到一半困意又涨上来了 —— 收掉打盹，按整觉走')
    从打盹滑入 = true
  }
}

// EAT_HOLD 2026-11-06（批次144）：吃饭是连续动作，中途不该被换成「发呆」。
//
// 她在餐厅吃火锅，这一分钟 cron 抽到「走动」就把她搬去街口 —— 人还没吃完。
// 跟 NAP_HOLD / SHOWER_HOLD 同一个道理：占着位子的状态要先挡一下。
// 到点了先结算，结算完再往下走（这一轮就能挑下一件事），不用等她再等一分钟。
if (!forced && !DRY) {
  try { execFileSync(process.execPath, [join(tools, '吃饭.mjs'), '--tick'], { encoding: 'utf8', timeout: 10000 }) } catch { /* 结算失败下次再试 */ }
  // 先结算再判。批次167 起判据在 占用.mjs。
  const _饭 = 在吃饭(base)
  if (_饭) {
    if (!QUIET) console.log(`在${_饭.在哪 || '家'}${吃喝动词(_饭.吃啥)}${_饭.吃啥}，还有 ${Math.ceil((_饭.到 - Date.now()) / 60e3)} 分钟，这一轮不换动作`)
    process.exit(0)
  }
}

// DOCTOR_HOLD 2026-11-08（批次224）：排队/挂水是硬占用，这一轮不换动作。
// 顺便让 疾病 --tick 走一步：挂水每 10 分钟补液靠它，心跳漏跑也不会断。
if (!forced && !DRY) {
  try { execFileSync(process.execPath, [join(tools, '疾病.mjs'), '--tick'], { encoding: 'utf8', timeout: 10000 }) } catch { /* 结算失败下次再试 */ }
  const _病 = 在看病(base)
  if (_病) {
    if (!QUIET) console.log(`在${_病.在哪 || '医院'}${_病.阶段}，还有 ${Math.ceil((_病.到 - Date.now()) / 60e3)} 分钟，这一轮不换动作`)
    process.exit(0)
  }
}

// 身体急渴先于在岗守卫计算：夜班只允许原地补水，其余动作继续被占用态拦住。
const __水状态 = (() => { try { return 饥饿.读() } catch { return null } })()
const __渴水位 = Number.isFinite(Number(__水状态?.水百分比)) ? Number(__水状态.水百分比) : -1
const __杯0 = (() => { try { return 杯态() } catch { return null } })()
const __能接0 = (() => { try { return 能接水(assets.位置 || '家') } catch { return false } })()
const __售水信息 = (() => {
  try {
    const products = JSON.parse(readFileSync(join(tools, '商店-生活.json'), 'utf8')).商品 || {}
    const water = products['水'] || {}
    const sale = Array.isArray(water.售卖点) && water.售卖点.includes(String(assets.位置 || '家'))
    const price = Number(water.价 ?? 2)
    return { sale, price: Number.isFinite(price) && price > 0 ? price : 2 }
  } catch { return { sale: false, price: 2 } }
})()
const __可买水 = __售水信息.sale && Number(assets.钱 ?? 0) >= __售水信息.price
const __刚补水 = 饮水冷却中({ 账: __水状态?.账, 行动日志: aut.log, 现在: Date.now(), 冷却分钟: 20, 失败冷却分钟: 5 })
const __急渴 = 急渴应喝({
  水百分比: __渴水位, 水线: H('自主_急渴水条', 50), 能接: __能接0,
  杯在包: !!__杯0?.在包, 杯毫升: Number(__杯0?.毫升 ?? 0), 可买: __可买水, 刚补水: __刚补水,
})
const __在岗班 = 在岗的班(base)
const __值班结束At = __在岗班
  ? (Number(aut.doneAt || 0) || Date.parse(String(__在岗班.止 || '').replace(' ', 'T') + ':00+08:00'))
  : 0
// 在岗期间不换动作；只有低水位且确实能补水时，放行同地点饮水。
if (!forced && !DRY && __在岗班 && !允许在岗饮水({ 在岗: true, 急渴: !!__急渴 })) {
  if (!QUIET) console.log(`在${__在岗班.点}上班（${__在岗班.活}），这一轮不换动作`)
  process.exit(0)
}

// 2) 不再每 15 分钟硬做一件事。只有到她自己安排的 nextAt 才选动作。
//
// THIRST_OVERRIDE 2026-11-08（批次268）：身体急事不受她自己排的日程限制。
// 实测她的 nextAt 间隔是 111 / 27 / 118 分钟 —— 一天只抽十次签，喝水按权重
// 只中两三次（约 900ml），而水条每小时掉 84ml（一天 2016ml）。面板上就是
// 「609 毫升 · 30% · 很渴」挂两小时不动。渴不该等日程：掉到「中」档以下、
// 又有水可喝（接水点或有存水），这一轮就喝，把 nextAt 顶掉。
// EAT_OVERRIDE 2026-11-08（批次275）：热量见底也不该等日程。
// 批次268 只给了水一条「急事顶掉 nextAt」，千卡这条当时只加了抽签权重（批次269）。
// 实测一次抽签抽到「吃点东西」约 7%（权重 11 / 池子 ~150），而她 16:03 抽到「发呆」、
// 安排 28 分钟后 —— 面板上就是「千卡 25.8%（512/2000）」一直挂着不动，15:07 吃的那颗糖
// 是家里最后一颗（+80 kcal，等于没吃）。
// 判据**跟池子里 CALORIE_HUNGER 那段逐字一致**，不另立一套：
//   热量 < 30% 且 距上次吃 >= 150 分钟 且 饱腹感 < 96（真吃撑就忍）
// 防连顶：30 分钟内已经「吃点东西」过就不再顶（买失败也不会每分钟重试把 nextAt 顶穿）。
const __急饿 = (() => {
  try {
    const h = 饥饿.读()
    // FIELD_TRAP 2026-11-08（批次275c）：读() 的返回里**没有「距」这个键**，
    // 距要调 距上次分钟(h) 现算（池子里那句就是这么来的）。
    // 第一版直接读了那个不存在的键 → undefined → NaN → 判据恒假 →
    // 整个 __急饿 永远是空串，--dry 还在「摸鱼」。而单测的 stub 恰好给了「距」，
    // 22 条全绿 —— **stub 多给一个字段就能把真 bug 全盖住**。
    // 这条跟批次269 那次读错键名是同一个病：读之前先确认真实返回里有没有这个键。
    const 距 = Number(饥饿.距上次分钟(h))
    // CALORIE_LINE 2026-11-08（批次278）：同上，30% 才叫「见底」太晚了 ——
    // 她一天掉 100%，30% 意味着长期在 30~50% 徘徊。抬到 50，
    // 再配合「距上顿 150 分钟」，正好一天两三顿，不会连吃。
    if (!(Number(h.饱腹) < H('自主_热量见底卡条', 50))) return ''
    if (!(距 >= H('自主_热量见底距上次分钟', 150))) return ''
    if (!(Number(h.饱腹感) < H('自主_热量见底饱腹上限', 96))) return ''
    // EAT_COOLDOWN 2026-11-14（批次404/405）：整段搬到 自主判据.吃东西冷却中()。
    // 这里原来只认 state === '吃点东西'，而失败那条的 state 是「吃东西失败」——
    // 于是「防吃失败还每分钟重试」那句注释写是写了，从来没生效：
    // 实测 11-11 19:13~19:19 在图书馆连撞 7 分钟「汉堡套餐买不到」。
    if (吃东西冷却中({ 行动日志: aut.log, 现在: Date.now() })) return ''
    return '吃点东西'
  } catch { return '' }
})()
const __班次强制动作 = 共享该赴的班(__工作档.班次, assets, Date.now(), 30)
// NAP_PRIORITY 2026-11-16（批次540）：**困意过线也该顶掉 nextAt。**
// 原来只有 急渴 / 急饿 / 班次 三条能顶。于是她困意 114（清醒 24 小时）还得站在原地
// 等 nextAt 走完 —— 实测 06:27 那轮安排了 132 分钟、要站到 08:39，
// 而 physical 已经从 28 掉到 12.6。她不会「自己想睡」，因为这一行先把她 exit 掉了。
// 门槛跟下面选动作那条用同一个数（自主_打瞌睡困意门槛 78），不另立一个。
// NAP_GUARD 2026-11-16（批次544）：`__急困` 不能把正在打的那个盹每分钟重置一次。
// 实测 08:00 打了 33 分钟（到 08:33），08:03 又重开成 08:36 —— 因为困意 91 >= 78 一直成立，
// `__急困` 就每分钟都不让 exit，于是又抽一次「打瞌睡」、又调一次 打盹 --开始。
// 打盹本来就不清困意账（批次134），这么一来她永远眯在那 33 分钟里。
// 判据：已经在打盹（打盹.json 还没到点）就别再叫醒-重开。
// NAP_INTERRUPT 2026-11-16（批次566）：**回到「只看困意」。**
// 批次563 我在这里加过一条「体力低才打断」，理由是「困但有劲就先把手上的做完」——
// 那条是错的（t542 N1 当场红：困意 114、nextAt 还有 89 分钟，她还在发呆，却没去睡）。
// `__急困` 的语义是「困到该停手」，跟体力无关：困得狠的人就算有劲也该去打盹，
// 那正是主人说的「困意高体力高 → 打盹」。体力只该影响「去打盹还是去床上睡」（象限），
// 不该影响「要不要停下来」。
const __急困 = !!(sleepy && sleepy >= H('自主_打瞌睡困意门槛', 78)) && !在打盹(base)
const waitMin = Math.ceil((Number(aut.nextAt || 0) - Date.now()) / 60e3)
if (!forced && !DRY && waitMin > 0 && !__急渴 && !__急饿 && !__班次强制动作 && !__急困) process.exit(0)

// 3) 防止上一轮模型学习还没结束时，下一分钟 cron 又挤进来。
function alive(pid) { try { process.kill(Number(pid), 0); return true } catch { return false } }
if (!DRY && existsSync(LOCK)) {
  const old = Number(readFileSync(LOCK, 'utf8').trim())
  if (old && old !== process.pid && alive(old)) { if (!QUIET) console.log(`上一轮还在进行（pid ${old}），不挤进去`); process.exit(0) }
}
if (!DRY) writeFileSync(LOCK, String(process.pid))

// QUADRANT 2026-11-16（批次563）——**主人的行为模型**，只在这里实现一处。
//
// 原话：「精力体力和困意联动，其中体力占比大、精力占比较小；困意高体力低更倾向于直接床上睡觉，
// 困意低体力低倾向于进行休息（坐着躺着刷手机看B站贴吧或发呆）；困意高体力高倾向于打盹；
// 困意低体力高就不用讲了。精力则在此基础上小幅度倾向影响，如精力低更消极
// （因为体力层也会影响精力，所以要着重考虑设计）。」
//
// 所以：**象限只看 体力 × 困意**；精力只做 ±20% 的修饰，不参与定象限
// （`energy` 是 layers 的木桶合成，physical 已经是其中一层，再拿它定象限就是双重计数）。
//
// 以前是「困意 >= 78 就清空池子硬推打瞌睡」—— 一个变量、一刀切、不看体力，
// 而且清池是「必须」不是「倾向」。这里换成乘在票数上的系数：
//   困高体力低 → 打瞌睡票最多（去了就整觉，见 672 行那段）
//   困低体力低 → 消极休息类翻倍，积极类砍到三成
//   困高体力高 → 打瞌睡票偏高（去了就只打盹）
//   困低体力高 → 全 1.0，跟原来一样
const 消极类 = new Set(['刷手机', '玩电脑', '摸鱼', '看B站', '逛贴吧', '翻旧账', '琢磨黑话', '躺着'])
const 积极类 = new Set(['走动', '学点东西', '拍张照', '打零工', '逛街'])
const 体力线 = () => Number(st?.layers?.physical ?? 50)
function 象限系数(name) {
  const 体 = 体力线()
  const 低体 = 体 <= H('自主_体力低线', 38)
  const 困高 = Number(sleepy ?? 0) >= H('自主_打瞌睡困意门槛', 78)
  const 消沉 = Number(energy) <= H('自主_精力低线', 35)
  const 振作 = Number(energy) >= H('自主_精力高线', 70)
  let k = 1
  if (低体) {
    if (消极类.has(name)) k = 困高 ? 0.6 : H('自主_休息类权重', 2.0)
    else if (积极类.has(name)) k = 困高 ? 0.25 : 0.3
  } else if (困高) {
    if (消极类.has(name)) k = 0.8
    else if (积极类.has(name)) k = 0.7
  }
  // ENERGY_TRIM：精力低更消极、精力高更来劲。只 ±20%，压在体力主导之上。
  if (消极类.has(name)) k *= 消沉 ? 1.2 : 振作 ? 0.9 : 1
  else if (积极类.has(name)) k *= 消沉 ? 0.8 : 振作 ? 1.1 : 1
  // ENERGY_TRIM_ONLY 2026-11-16（批次563）：**精力只做 ±20%，不额外加倍数。**
  // 试过给「躺着/发呆」再乘 1.4（想让「精力低更想什么都不干」看得出来），
  // 实测把这一对的占比从 23% 推到 67%（t563 B5 当场红）—— 那是主导，不是修饰。
  // 主人的话是「精力则在此基础上**小幅度**倾向影响」，所以就停在 ±20%。
  return k
}

const countToday = (name) => aut.log.filter((x) => String(x.at || '').startsWith(dayKey) && x.state === name).length
const recent = aut.log.slice(-4).map((x) => x.state)
const choices = []
const __近期念头 = (() => {
  try {
    return readFileSync(join(base, '念头.jsonl'), 'utf8').split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch { return [] }
})()
function push(state, weight) {
  // QUADRANT（批次563）：所有票数统一过象限系数，别挨个 push 去改权重（会漏、会漂）。
  let w = Math.max(0, Math.round(念头动作加权(state, weight, __近期念头) * 象限系数(state)))
  // PUSH_ZERO 2026-11-06（批次139）：权重给 0 就是「这一轮不想」，不该被下面的
  // 「刚做过就降权」救回来 —— 那里是 Math.max(1, ...)，于是 0 变成 1，永远在池子里。
  // 洗澡那条「清洁 76 以上根本不会想起来」写的就是 0，从来没真归零过。
  if (w <= 0) return
  // 同一件事刚做过就降权；连续重复再降，避免“发呆—发呆—发呆”像卡死。
  if (recent.at(-1) === state) w = Math.max(1, Math.floor(w * 0.45))
  if (recent.at(-2) === state && recent.at(-1) === state) w = Math.max(0, Math.floor(w * 0.25))
  for (let i = 0; i < w; i += 1) choices.push(state)
}

// 3.5) 走路不是瞬移（2026-11-05 批次65）。
// `走路.mjs --去` 只写「在途」、位置不变，设计是对的；但除了下面「走动」那个分支，
// 没有任何动作看这个字段 —— 实测 01:14 从家出发去餐厅（说好 01:34 到），
// 01:15 就买了餐厅的东西。人在半路上，饭已经吃完了。
// 现在：没到之前只把 nextAt 推到到达时刻，别的什么都不做；
// 到点了先结算（--到 会更新位置），再做这一轮本来要做的事。
if (!forced && !DRY && assets.在途) {
  const 途 = assets.在途
  const arriveAt = Number(途.arriveAt || 0)
  if (Number.isFinite(arriveAt) && arriveAt > Date.now()) {
    // 没到：睡到到达那一刻再醒，中间不干别的（也不写 aut.log，那不是她做过的事）
    aut.nextAt = arriveAt + 1000
    存自主()
    if (!QUIET) console.log(`在去${途.to}的路上，还有 ${Math.ceil((arriveAt - Date.now()) / 60e3)} 分钟，先不干别的`)
    process.exit(0)
  }
  // 到点了：先把到达结算掉，位置才更新，后面做的事才落在对的地方
  try {
    const out = execFileSync(process.execPath, [join(tools, '走路.mjs'), '--到'], { encoding: 'utf8' }).trim()
    if (!QUIET && out) console.log(out)
  } catch { /* 结算失败就下次再试，不阻塞 */ }
  try { Object.assign(assets, load(join(base, '资产.json'), assets)) } catch { /* 读不到就沿用旧的 */ }
}

// 3.6) SHOWER 2026-11-05（批次89）：洗澡到点了先结算，再挑下一件事。
// 不结算的话，这一轮读到的还是洗澡前的清洁度 —— 她刚从浴室出来，又被判「身上黏」。
// 这里的 --tick 是幂等的：cron 已经结算过也不会重复计次数。
if (!DRY && 卫生.洗澡中) {
  const 洗完At = Date.parse(String(卫生.洗澡中.结束 || '').replace(' ', 'T') + ':00+08:00')
  if (Number.isFinite(洗完At) && 洗完At <= Date.now()) {
    try {
      const out = execFileSync(process.execPath, [join(tools, '洗澡.mjs'), '--tick'], { encoding: 'utf8' }).trim()
      if (!QUIET && out) console.log(out)
    } catch { /* 结算失败就下次再试，不影响挑动作 */ }
    卫生 = load(join(base, '卫生.json'), 卫生)
    清洁 = Number(卫生.清洁 ?? 清洁)
    在洗 = false
  }
}

// SHOWER_HOLD 2026-11-05（批次101）：洗澡是连续动作，中途不该被换成「发呆」或「走动」。
// 原来 `在洗` 只挡「再进一次浴室」，没挡「洗到一半被安排去做别的事」——
// tick 每分钟跑，人还在浴室里，state 已经变成「逛贴吧」，面板和对话两边开始说她不在做的事。
if (在洗 && !DRY) {
  console.log('在洗澡，这一轮不换动作')
  try { unlinkSync(LOCK) } catch { /* 忽略 */ }
  process.exit(0)
}

// 4) 选择不是课程表：身体和兴趣占大头，外部学习每天各最多一轮作为预算上限。
// WORK_HOLD 2026-11-06（批次112）：在岗的时候不挪窝。
// 她 22:00 在便利店守着夜班，这一分钟抽到「走动」就把她搬去别处，
// 工作.mjs 下一分钟记她迟到，她本人还一脸茫然 —— 跟批次106「没有腿」是同一类：
// 不是她想翘班，是另一套系统不知道她在上班。
// 只掐「走动」这一票：看书、刷手机、发呆照旧，人留在店里就行。
// 批次167：判据在 占用.mjs，跟上面那道闸同源（原来这里又抄了一遍，只认「在岗」）。
const __在岗 = 在岗的班(base)
// PHONE_PC 2026-11-16（批次570）：**「发呆」拆成「刷手机 / 玩电脑」。**
// 主人：「发呆的时候可以转换为刷手机玩电脑」。一个人不会真坐着空白，手上总有手机；
// 在家还会开电脑。**电脑只在家**（电脑桌是 家区域 里的一块地方，不是随身物品）。
// 两个名字都必须进 在干嘛.mjs 的 `坐着`，否则 是歇着 判 false，她刷手机反而按干活掉体力。
const __位置 = (() => { try { return String(load(base + '/资产.json', {}).位置 || '家') } catch { return '家' } })()
push('刷手机', energy < H('自主_发呆精力门槛', 30) ? 8 : 4)
if (__位置 === '家') push('玩电脑', energy < H('自主_发呆精力门槛', 30) ? 6 : 3)
push('走动', (__在岗 ? 0 : (energy > 35 ? 2 : 1)) * 想动)
push('摸鱼', 3)
// CASUAL_GIG 2026-11-12：自由单日临时工（不排班、不扣信用，精力够且缺零花钱或想体验时随心去干一单）
if (!__在岗 && energy >= 50 && countToday('打零工') < 1) {
  const __钱数 = Number(assets.钱 ?? 0)
  const __想赚 = __钱数 < 80 ? 6 : (__钱数 < 200 ? 3 : 1)
  push('打零工', __想赚)
}
push('翻旧账', (mi <= -1 ? 4 : 2) * 想缩)
push('学点东西', energy > H('自主_学东西精力门槛', 55) ? 3 : 1)
// SLANG_RADAR 2026-11-07（批次193）：低票常驻 —— 抽中时才现场扫群聊（3 天的量，秒级）。
const dopamine = Number(hormones.dopamine ?? 50)
const cortisol = Number(hormones.cortisol ?? 50)
const curiosity = clamp(1 + (dopamine - 50) / 50 - (cortisol - 50) / 100, 0.5, 2)
// BROWSE_MORE 2026-11-14（批次392，主人原话「完全可以把她看b站和贴吧设置频繁点，
// 我每天都要刷一百多条视频呢，闲着的时候」）：原来两条都写死 `< 1`，一天各只有一票，
// 池子里十几次抽签抽不到是常态 —— 她 11-13 自己都说「这两天轮到的全是打瞌睡、喝水、洗澡，
// 困得没劲儿看片」。现在上限与权重都从 参数.json 读：看B站 3 次/天、逛贴吧 2 次/天，权重翻倍。
// 「刷」（只划标题，0 成本，一天几十次）不在这张池子里，在 刷一刷.mjs —— 那是另一件事。
if (countToday('看B站') < Number(H('自主_看B站每天上限', 3))) push('看B站', (energy >= 40 ? 6 * curiosity : 1) * 想动)
if (countToday('逛贴吧') < Number(H('自主_逛贴吧每天上限', 2))) push('逛贴吧', (energy >= 45 ? 4 * curiosity : 0.5) * 想动)
// HUNGER 2026-11-06（批次139）：这一行原来只有 `energy < 45 ? 4 : 2`。
//   两个毛病：①判据是精力 —— 精力是体力，不是饥饿，她累的时候精力常年 12，
//     于是一天吃了 10 顿；②权重最低也有 2，永远在候选池里，吃撑了也照去。
//   现在按饱腹算：吃撑了意向是 0，直接不进池子；饿了才高。
const __饿 = (() => { try { const h = 饥饿.读(); return { 饱腹: h.饱腹, 距: 饥饿.距上次分钟(h), 胃: Number(h.临时) || 0, 血糖: Number(h.血糖) || 5, 饱感: Number(h.饱腹感) || 0 } } catch { return null } })()
if (__饿 && Number(assets.钱 ?? 0) >= 6) {
  // APPETITE 2026-11-08（批次222，主人原话「想不想吃，饱腹度这种身体主观感受应该占大多数」）：
  // 主观饱腹 = 胃 65% + 千卡 35%。原来只看千卡（66% → 18% 意向），胃空一天也不进池子；
  // 现在反过来，胃是主、千卡只当底子。上面那条「胃空 +0.45」已经被吸收进这个权重里，删掉。
  // 2026-11-08（批次223）：饱腹感 = 胃 + 血糖（饥饿.读 已经算好），不再拿千卡顶。
  const __主观饱 = Number.isFinite(__饿.饱感) ? __饿.饱感 : 饥饿.主观饱腹(__饿.胃 ?? 60, __饿.血糖 ?? 5)
  let __想吃 = Math.min(1, 饥饿.想吃意向(__主观饱, __饿.距))
  // CALORIE_HUNGER 2026-11-08（批次269）：热量见底也要有食欲。
  // 实测她 11-07 05:52 吃完早饭，到 11-08 11:15 才吃下一顿 —— 中间 29 小时一口没吃，
  // 千卡掉到 573（29%）。原因是 饱腹感 = 胃 60% + 血糖 40%，**不看千卡**；
  // 而喝水会把胃顶起来（11:46 喝了 450ml，顶胃 500），于是「热量空、肚子饱、不饿」。
  // 生理上热量缺口是会产生食欲的，这条补上；真吃撑（饱腹感 >= 96）时仍然不补。
  // 字段名踩过一次：饥饿.读() 里**没有**「卡百分比」，热量在 `饱腹` 里
  // （读() 里写着 `有效 = 卡百分比`，对外只认千卡；含水那个叫 `饱腹感`）。
  // 写成 h.卡百分比 会永远读到 undefined → 兜底 100 → 这条永远不生效。
  // 判据换成「热量 + 多久没吃」，不再拿饱腹感当闸门：
  // 喝水会把胃顶起来（300ml 加 270，胃满 1000），而 饱腹感 = 胃 60% + 血糖 40%，
  // 于是「一口饭没吃、全靠水撑着」也能算到 90 分。实测 13:55 她卡 26%、饱腹感 90、
  // 想吃意向 0 —— 饿着肚子还是抽不到「吃点东西」。
  // 真实信号是这两个：热量见底 + 已经两个半小时没正经吃过。饱腹感只留 96 当「真吃撑」的兜底。
  const __没吃多久 = Number(__饿.距) >= H('自主_热量见底距上次分钟', 150)
  if (Number(__饿.饱腹) < H('自主_热量见底卡条', 50) && __没吃多久 && __主观饱 < H('自主_热量见底饱腹上限', 96)) {
    __想吃 = Math.min(1, __想吃 + H('自主_热量见底加成', 0.7))
  }
  // 心情差会想吃点好的（情绪性进食），但撑的时候也吃不下 —— 乘 (1 - 饱腹/100)
  const __情绪 = (mi <= -1 ? 0.35 : 0) * (1 - __饿.饱腹 / 100)
  const __权重 = Math.floor((__想吃 + __情绪) * 15)
  if (__权重 > 0) push('吃点东西', 计划动作加权('吃点东西', __权重, __今日计划))
} else if (!__饿 && Number(assets.钱 ?? 0) >= 6) {
  // 饥饿文件读不出来才退回老判据：宁可偶尔多吃一顿，也别让她饿着
  push('吃点东西', energy < 45 ? 4 : 1)
}
// DRINK 2026-11-07（批次219）：渴了得有腿。原来池子里只有「吃点东西」，喝水全靠她自己想起来，
// 面板写着 42%「渴了」也一动不动。家里有自来水，接一杯 300 毫升不花钱；人不在家这条不进池子
// （在外面渴了要么买水要么忍着，别让她站在街上假装接水）。
// 复用上面 THIRST_OVERRIDE 里读到的水位/杯态，别重复读一遍
const __渴 = __渴水位 >= 0 ? { 水: __渴水位 } : null
const __在家 = String(assets.位置 || '家') === '家'
// WATER 2026-11-08（批次223，主人原话「水除了随身携带在街上喝水，其他地方应该都有接水点」）：
// 在接水点 → 总能喝（先接满）；不在接水点（街上）→ 只有杯里还剩够喝才进池子。
const __杯 = __杯0
const __能接 = __能接0
// BUY_WATER 2026-11-08（批次225）：露天场地（公园/街市/游乐园/海边）没有接水点，但有卖的。
// 杯空、渴到一半以下、身上有钱，就在这儿买一瓶（2 块）。
const __卖水 = __售水信息.sale
// SICK_LEAN 2026-11-07（批次221）：病中的「想躺着」只进权重，不封她的选择 ——
// 主人定的规矩：想法类不强制，身体事实（头晕/发沉）才不可避免；硬撑着出门也行，
// 代价由身体账承担（体力掉得快、恢复慢），这里不设硬闸。
const __病向 = (() => { try { return 疾病.倾向() } catch { return null } })()
if (__病向 && __病向.想躺着 > 0.15) push('躺着', Math.round(4 + __病向.想躺着 * 12))
// SICK_DOCTOR 2026-11-08（批次224）：病重了自己会想去看病 —— 只是"想"，进了池子也要抽中才去。
// 钱不够就不进池子（挂号 15 + 挂水 45；只开药也要 23）。
const __病况 = (() => { try { return 疾病.读() } catch { return null } })()
if (__病况 && __病况.数 && !__病况.就诊) {
  const __钱 = Number(assets.钱 ?? 0)
  if (__病况.重 >= 0.5 && __钱 >= 25) push('去医院', 24)
  else if (__病况.重 >= 0.2 && __钱 >= 8) push('去药店', 10)
}
if (__渴 && __渴.水 < 50 && __杯 && __杯.在包 && __杯.毫升 < 100 && !__能接 && __卖水 && Number(assets.钱 ?? 0) >= __售水信息.price) {
  push('买瓶水', 12)
}
if (__渴 && (__能接 || (__杯 && __杯.在包 && __杯.毫升 >= 100))) {
  // 2026-11-07（批次220，主人原话「水条意向 80% 就要考虑喝了，75% 是渴、50% 很渴、0% 渴死」）
  const 想喝 = __渴.水 >= 85 ? 0
    : __渴.水 >= 75 ? 0.3
      : __渴.水 >= 50 ? 0.55
        : __渴.水 >= 25 ? 0.85 : 1
  const __喝权 = Math.floor(想喝 * 14)
  if (__喝权 > 0) push('喝点水', __喝权)
}
if (!/睡/.test(String(aut.state || ''))) push('拍张照', (mi >= 0.4 ? 3 : 1) + (String(assets.位置 || '家') !== '家' ? 1 : 0))
// 身上黏了才想去冲澡。清洁 76 以上根本不会想起来；越脏权重越高。
if (!在洗 && !在睡 && ['家', '澡堂'].includes(String(assets.位置 || '家'))) {
  push('洗澡', 清洁 < 45 ? 16 : 清洁 < 58 ? 9 : 清洁 < 76 ? 4 : 0)
}
// NAP_PICK 2026-11-06（批次134）：两条触发，都要真睡，不只是挂个标签。
//   1 困意过线（原逻辑）
//   2 体力/认知已经见底 —— 「撑不住了」不是时间概念，所以不看钟点；
//     但刚起不到 3 小时不睡，免得一觉接一觉。
// QUADRANT（批次563）：**不再清池。** 主人说的是「倾向于」，不是「必须」。
// 打瞌睡按象限给票（体力低给得多、不困不给），跟别的动作一起抽；
// 抽不中她会去做别的，下一轮再抽 —— 这才是「倾向」。
{
  const __体 = Number(st?.layers?.physical ?? 50)
  const __低体 = __体 <= H('自主_体力低线', 38)
  // QUADRANT（563）：体力低就该能躺着。原来 `躺着` 只在病中进池子（SICK_LEAN），
  // 而主人的模型里「困低体力低」的休息类明确包含「坐着躺着」。
  if (__低体) push('躺着', H('自主_躺着权重', 3))
  const __困 = Number(sleepy ?? 0)
  const __困高 = __困 >= H('自主_打瞌睡困意门槛', 78)
  push('打瞌睡', Number(
    __困高 && __低体 ? H('自主_打瞌睡权重_困高体力低', 22)
      : __困高 ? H('自主_打瞌睡权重_困高体力高', 14)
        : __低体 ? H('自主_打瞌睡权重_困低体力低', 2)
          : 0
  ))
  // 熬穿（>= 105）是生理上限，不是倾向 —— 这时候还去「逛贴吧」就是数据假了。
  // MICROSLEEP（566）：**清池线从 105 抬到 130。**
  // 原来困意 105 就清池只留「打瞌睡」—— 那 100~105 是断片唯一能发生的区间，概率 0~3%，
  // 等于新机制上线的第一天就永远不会触发（t566 B3 当场红）。
  // 按主人「100-150 透支、150 以上崩溃边缘」的分档，100~130 应该是**她还能硬撑、但会断片**的区间；
  // 130 以上才是真撑不住、清池去睡。这不是放宽惩罚 —— 是让惩罚有个能看见的地方。
  if (__困 >= H('自主_熬穿困意', 130)) { choices.length = 0; choices.push('打瞌睡') }
  if (!QUIET && choices.includes('打瞌睡')) {
    console.log('[累] 困 ' + __困 + ' 体力 ' + __体 + (__困高 ? (__低体 ? ' → 困高体力低' : ' → 困高体力高') : (__低体 ? ' → 困低体力低' : ' → 困低体力高')) + '，打瞌睡票 ' + choices.filter((x) => x === '打瞌睡').length + '/' + choices.length)
  }
}
const __lowBody = Math.min(Number(st?.layers?.physical ?? 100), Number(st?.layers?.cognitive ?? 100))
const __awake = Number(st?.hoursAwake ?? 0)
if (!choices.includes('打瞌睡') && __lowBody <= H('自主_累到必须打盹', 20) && __awake >= H('自主_打盹最短清醒小时', 3)) {
  choices.length = 0; push('打瞌睡', 1)
}

// ORDER 2026-11-08（批次275）：__急渴/__急饿 提到最前面，且**饿在渴前面**。
// 原来 __急渴 只在最后一级兜底 —— 前面「琢磨黑话/洗澡/走动」任一命中就盖掉它，
// nextAt 已经被顶开了，人却去做别的事，这次顶就白顶了。
// 饿必须压过渴：实测渴的周期比饿短得多（水每小时掉 84ml，3 小时就回到「该喝了」，
// 而吃一顿能顶 5 小时）。渴在前的话，每轮都先喝水、nextAt 又被推到 115 分钟后，
// 饭永远排不上 —— 16:30 那次 dry 就是「又渴又饿 → 去喝水 → 再等 115 分钟」。
// 吃完这一轮水只会掉到 28~31%，下一轮照样触发急渴，渴不会被饿饿死。
// CHOICE_FALLBACK 2026-11-15（批次498）：池子在困意过线时被清空，如果 push 又没进去，
// 最后会落到 `|| '发呆'` —— 困意 94 的人发呆 83 分钟就是这么来的（01:00 那次）。
// 兜底按困意判：过线就打瞌睡，没过才是发呆。
const __困兜底 = (sleepy && sleepy >= H('自主_打瞌睡困意门槛', 78)) ? '打瞌睡' : '刷手机'   // QUADRANT（563）：池子正常情况下不为空，这只是兜底
const __常规选择 = __班次强制动作 ? '去上班' : (__急饿 ? '吃点东西' : (__急渴 ? '喝点水' : (试黑话 ? '琢磨黑话' : (试洗澡 ? '洗澡' : (试走动 ? '走动' : (试吃东西 ? '吃点东西' : (试拍照 ? '拍张照' : (choices[Math.floor(Math.random() * choices.length)] || __困兜底))))))))
let pick = (__在岗班 && __急渴) ? __急渴 : __常规选择
// NAP_SLIDE（批次569）：从打盹滑进来的这一轮，池子抽到什么都不算 —— 只有「打瞌睡」那一支
// 会先收打盹、再判家、再开整觉。别在这条路上另写第三份判家（批次542 的坑就在「又写了一份」）。
if (从打盹滑入) pick = '打瞌睡'
// PHONE_PC（批次570）：验分支的两个旗标（正式 cron 没有）
if (试刷手机) pick = '刷手机'
if (试玩电脑) pick = '玩电脑'
// 兜底：电脑只在家。票数那步已经拦过一次（外面根本不投这一票），这里再拦一次 ——
// 池子以外的路径（参数、旧档、旗标）也别让「在便利店玩电脑」出现。
if (pick === '玩电脑' && __位置 !== '家') pick = '刷手机'

// MICROSLEEP 2026-11-16（批次566）：**困意爆表之后，行为上要有表现，不能只是数值难看。**
// 主人原话：「100-150 透支，角色开始出现微睡眠（几秒钟断片）、视线模糊、走路撞墙。」
// 这不是她的选择 —— 所以她「想做事但断片了」，这一轮什么也没做成。
// 概率随困意线性涨（100 起、每点 0.6%、封顶 45%）：困得越狠越容易断，但不是必然。
let 断片到点 = 0
{
  const __s = Number(sleepy ?? 0)
  const __线 = Number(H('自主_微睡眠困意线', 100))
  const __率 = __s >= __线
    ? Math.min(Number(H('自主_微睡眠上限', 0.45)), (__s - __线) * Number(H('自主_微睡眠斜率', 0.008)))
    : 0
  // 熬穿（>=105）时池子被清成只有「打瞌睡」—— 她本来就要去睡了，
  // 这时候再判断片只会把「去睡」改写成「原地断片」（t563 B8 抓到 {"打瞌睡":7,"断片":1}）。
  // 断片是「硬撑着做事」的代价，只对她还在做别的事时生效。
  // PRIORITY_GUARD 2026-11-16（批次566）：**断片只覆盖「普通抽签」的结果。**
  // 实测 t353 第 48 条当场红：夜班急渴时 `pick = __急渴`（喝点水），断片把它改写成了「断片」——
  // 渴到极点、饿到极点、班次强制动作都是更高优先级的需求，不该被无意识打断。
  // 判据就用「pick 还是不是 __常规选择」—— 是，说明这一轮没被任何优先级覆盖。
  const __普通轮 = pick === __常规选择
  const __该睡 = pick === '打瞌睡'
  const __中 = !断片关 && (试断片 || (__普通轮 && !__该睡 && __率 > 0 && Math.random() < __率))
  if (__中) {
    pick = '断片'
    断片到点 = Date.now() + rand(Number(H('自主_断片最短秒', 20)), Number(H('自主_断片最长秒', 90))) * 1000
    if (!QUIET) console.log('[断] 困意 ' + __s + '（概率 ' + Math.round(__率 * 100) + '%）→ 断片一次')
  }
}

// SUPPRESS 2026-11-16（批次565）：**硬扛行为的代价，在这里记账。**
// 判据在 在干嘛.压制账推进（纯函数）；这个文件只负责「每轮把当前动作报给它，变了就落盘」。
// 为什么在这里：只有 自主行动 知道这一轮换了什么动作 —— 换个地方判就要再读一次 aut.log。
// 为什么落在 压制.json 而不是 状态.json：那个文件 状态推进 / 困意 / 睡眠心跳 都在写，
// 多一个写者就多一次并发；这个新文件只有这里写、只有 困意.mjs 读。
if (!DRY) {
  try {
    const __压P = join(base, '压制.json')
    const __新压 = 压制账推进(load(__压P, {}), pick, Date.now(), {
      压制值: H('自主_压制值', 14),
      半衰分: H('自主_反弹半衰分', 40),
      利息: H('自主_反弹利息', 0.8),
    })
    if (__新压.变了) save(__压P, { 当前: __新压.当前, 待结算: __新压.待结算 })
  } catch { /* 记不上账不影响她做事 */ }
}
let note = ''
let selfNext = 0
let foodFailed = false
let foodPending = false
let drinkFailed = false
// CONTENT_FEEL 2026-11-05（批次87）：这一轮她读完之后心里那一下（她自己选的词）。
// 学习轮没跑通时它自然是空的 —— 上面那两处 `if (r.code !== 0) throw` 在赋值之前，
// 所以「失败」不会被当成「她读完了没感觉」。
let feelKind = ''

// 反应词 → 人话。只在「写进 last」这一处映射，面板和对话侧都读人话，不各写一张表。
const FEEL_SAY = {
  看到好笑的: '笑了出来',
  看到难受的: '有点堵',
  被打动: '被戳了一下',
  看得发慌: '有点发慌',
  看得来气: '来气',
  看得没劲: '觉得没劲',
  看明白点什么: '琢磨明白了一点',
}
// WALK_ARRIVE 2026-11-05：走动是唯一一个「做完时刻还没到」的一次性动作。
// 出发时 doneAt 写 now 的话，对话侧会当她走完了，人在半路上却说「走完了」；
// 所以先把到达时刻记下来，末尾写 doneAt 时用它。
let walkArriveAt = 0
let napUntil = 0  // 2026-11-06（批次134）：打盹到点时刻
// SHOWER 2026-11-05（批次89）：洗澡也是「做完时刻还没到」的一次性动作。
// 进去的那一刻不算洗完 —— doneAt 要写她出来的时刻，不然对话侧会当她刚洗完、人还在浴室。
let 洗澡结束At = 0

function runLearning(mode, readingId = '') {
  if (DRY) return { code: 0, output: `[dry] 自主学习 ${mode} ${readingId}`, selfNext: 0 }
  const r = spawnSync(process.execPath, [join(tools, '自主学习.mjs'), mode, readingId].filter(Boolean), {
    encoding: 'utf8', timeout: 21 * 60e3, maxBuffer: 16 * 1024 * 1024,
  })
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n')
  const waits = [...output.matchAll(/SELF_NEXT_MINUTES=(\d{1,3})/g)]
  const sums = [...output.matchAll(/SELF_SUMMARY=(.+)/g)]
  // CONTENT_FEEL 2026-11-05（批次87）：她自己写的那个反应词。
  // 激素那笔已经由 自主学习.mjs 记过了，这里只是把它带上来给人看 ——
  // 面板上要能看见「她刚看完什么、心里什么反应」。
  const feels = [...output.matchAll(/SELF_FEEL=(.+)/g)]
  return {
    code: r.status ?? 1,
    output,
    selfNext: waits.length ? Number(waits.at(-1)[1]) : 0,
    summary: sums.length ? String(sums.at(-1)[1]).trim().slice(0, 150) : '',
    feel: feels.length ? String(feels.at(-1)[1]).trim() : '',
  }
}

// 时长话 2026-11-06（批次130）：body.duration 一直都在（单位秒），但只被用来筛候选，
// 从没往上传过 —— 她因此只知道片名、不知道多长。11-06 她先说「三分钟」，20 秒后自己
// 探了一遍才改口「二十一秒」（真值 21 秒）。系统手里有的事实不递给她，她就只能估。
// 这里只做一件事：把秒数说成人话。不判断内容、不替她描述感受。
function 时长话(秒) {
  const s = Math.round(Number(秒) || 0)
  if (!s) return ''
  if (s < 60) return `${s} 秒`
  const m = Math.floor(s / 60)
  const r = s % 60
  return r ? `${m} 分 ${r} 秒` : `${m} 分`
}

async function unreadBiliReading() {
  // 只有真的要看 B 站才加载 sqlite；每分钟检查 nextAt 时不产生实验警告或额外 IO。
  const { DatabaseSync } = await import('node:sqlite')
  // 优先读每日预取但还没写手账的稿，避免重复下载、重复学习。
  const db = new DatabaseSync('{{DSH_ROOT}}/bili-humanism/ledger.sqlite', { readOnly: true })
  try {
    const rows = db.prepare('SELECT id, body FROM readings WHERE id NOT IN (SELECT reading_id FROM notes) ORDER BY created DESC').all()
    for (const row of rows) {
      try {
        const body = JSON.parse(row.body)
        if ((body.segments || []).length > 0) return { id: row.id, title: body.title || '一份旧稿', duration: Number(body.duration) || 0 }
      } catch { /* 跳过坏行 */ }
    }
  } finally { db.close() }
  return null
}

async function isBiliLearned(id) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync('{{DSH_ROOT}}/bili-humanism/ledger.sqlite', { readOnly: true })
  try { return Boolean(db.prepare('SELECT 1 FROM notes WHERE reading_id = ? LIMIT 1').get(id)) }
  finally { db.close() }
}

/** BROWSE_PICK 2026-11-14（批次392）：从「刷到过但没点开」的那堆里挑。
 *  刷完再点一条进去看，才是人的顺序。以前只从热门前 3 条挑，
 *  热门榜十分钟不变，同一批标题会反复出现在候选里 —— 她那边的体感是「老是这几条」。 */
function browsedBiliPick() {
  try {
    const 行 = readFileSync(join(base, '刷过.jsonl'), 'utf8').trim().split('\n').slice(-600)
    const 表 = new Map()
    for (const l of 行) {
      try {
        const o = JSON.parse(l)
        // 后写的覆盖先写的：「标看过」那条会盖掉当初刷到的那条
        if (o && o.平台 === 'B站' && o.id) 表.set(String(o.id), o)
      } catch { /* 坏行跳过 */ }
    }
    const 候 = [...表.values()].filter((o) => o.看过 !== true
      && Number(o.时长) >= 45 && Number(o.时长) <= 1500)
    if (!候.length) return null
    // 越新鲜越像「刚划过去又划回来」：只在最后 60 条里挑
    return 候.slice(-60)[Math.floor(Math.random() * Math.min(60, 候.length))]
  } catch { return null }
}

/** 学完标一笔「这条点开过了」，免得下次还从同一批里挑。标不上不影响这一轮。 */
function 标看过了(id) {
  try {
    const 池 = join(base, '刷过.jsonl')
    const 行 = readFileSync(池, 'utf8').split('\n').filter(Boolean).slice(-2000)
    const 时 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    const t = 池 + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    writeFileSync(t, [...行, JSON.stringify({ at: 时, 平台: 'B站', id, 看过: true })].join('\n') + '\n')
    renameSync(t, 池)
  } catch { /* 最多下次少挑一条 */ }
}

function fetchBiliReading() {
  const cli = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-bili-humanism/bin/cli.mjs'
  const env = { ...process.env, BILI_HUMANISM_HOME: '{{DSH_ROOT}}/bili-humanism', BILI_HUMANISM_CREDENTIAL_FILE: '{{DSH_ROOT}}/bili-humanism/credential.json' }
  // 先试她刚刷到的那条（BROWSE_PICK）：读不出来（删了/限流）就退回热门候选
  const 刷到 = browsedBiliPick()
  if (刷到) {
    try {
      const readRaw = execFileSync(process.execPath, [cli, 'read', 刷到.id], { encoding: 'utf8', env, timeout: 180e3 })
      const result = JSON.parse(readRaw).result || {}
      if (result.id && (result.segments || []).length) {
        标看过了(刷到.id)
        return { id: result.id, title: result.title || 刷到.标题, duration: Number(刷到.时长 || result.duration) || 0 }
      }
    } catch { /* 那条可能删了或被限流 —— 下面照旧走热门候选 */ }
  }
  const raw = execFileSync(process.execPath, [cli, 'candidates', '3'], { encoding: 'utf8', env, timeout: 120e3 })
  const candidates = JSON.parse(raw).result || []
  // 太长的片子一次看不完；在 45 秒~25 分钟里挑接近短片的两个，再随机一个。
  const usable = candidates.filter((x) => Number(x.duration) >= 45 && Number(x.duration) <= 1500)
  if (!usable.length) throw new Error('这批候选都太长，今天不硬看')
  usable.sort((a, b) => Math.abs(Number(a.duration) - 480) - Math.abs(Number(b.duration) - 480))
  const chosen = usable.slice(0, 2)[Math.floor(Math.random() * Math.min(2, usable.length))]
  const readRaw = execFileSync(process.execPath, [cli, 'read', chosen.bvid], { encoding: 'utf8', env, timeout: 180e3 })
  const result = JSON.parse(readRaw).result || {}
  if (!result.id || !(result.segments || []).length) throw new Error(`《${chosen.title}》没有取得可读文字，不假装看过`)
  return { id: result.id, title: result.title || chosen.title, duration: Number(chosen.duration || result.duration) || 0 }
}

try {
  if (pick === '断片') {
    // 什么也不做 —— 她"想"做，但这几十秒是无意识的。
    // note 写清是被困意掐掉的，不是她自己不想做（下一轮注入会原样念给她听）。
    note = '眼皮一沉，头栽了一下 —— 断片了几秒，回神的时候手还停在半空'
  } else if (pick === '打瞌睡') {

    // NAP_TO_SLEEP 2026-11-15（批次500）：困意 >= 95 的人不该只眯 40 分钟。
    // 实测这一夜：00:35 / 03:19 / 03:43 / 04:39 连着四次打盹，每次起来困意还在 96+，
    // 因为打盹不清困意账（批次134 的设计）—— 整晚都在「打盹→还是困→再打盹」。
    // 这一票升级成整觉：先收掉正在打的盹，再 startSleep + 作息 --想睡（跟 sleep.js 同一条路）。
    // QUADRANT（批次563）：**整觉以前只看困意 95**，跟体力无关。
    // 主人的模型是「困意高体力低 → 直接床上睡觉」—— 没劲的人 55 的困就该去睡整觉了，
    // 硬撑到 95 再睡，中间那几小时她是「困着在发呆」。体力还够的，困到 95 才整觉，
    // 95 以下只打盹（这就是「困高体力高 → 打盹」）。
    // NAP_SLIDE（批次569）：判据收进 自主判据.该滑入整觉 —— 打盹途中那一处问的是同一份。
    const __该整觉 = 该滑入整觉(sleepy, st?.layers?.physical, {
      困到该睡整觉: H('自主_困到该睡整觉', 95),
      困低体力整觉困意: H('自主_困低体力整觉困意', 55),
      体力低线: H('自主_体力低线', 38),
    })
    if (__该整觉) {
      if (DRY) {
        note = '[dry] 会去睡整觉（不是打盹）'
        napUntil = Date.now() + 8 * 3600e3
      } else {
        try { execFileSync(process.execPath, [join(tools, '打盹.mjs'), '--醒'], { encoding: 'utf8', timeout: 10000 }) } catch { /* 没在打盹 */ }
        // SLEEP_AT_HOME 2026-11-16（批次542）：**这里是睡觉的第二个入口，而它没判家。**
        // 批次107 修过「在便利店床上睡」，但只修了 自动作息.mjs 那半边（它第 200 行有 睡在哪 判据）；
        // 「困到该睡整觉」这条路是 批次500 后来加的，直接 startSleep()。
        // 实测 2026-11-16 07:12：她困意 128，人在便利店 —— 面板就成了「在便利店」+「睡着」。
        // 判据跟 自动作息 逐字同源（在岗的班 → 走不开；否则问 睡在哪），别自己再写一份。
        const __班2 = 在岗的班(base)
        const __哪2 = __班2
          ? { 走: false, 在路上: false, 位: String(__班2.点 || ''), 话: '在' + String(__班2.点 || '') + '上班，走不开，柜台后面眯一会儿' }
          : 读资产再判(base)
        if (__哪2.走) {
          // 先走回家，这一轮不睡 —— 到了下一轮（最多几分钟）再睡。
          let 走成2 = false
          try {
            execFileSync(process.execPath, [join(tools, '走路.mjs'), '--去', '家'], { encoding: 'utf8', timeout: 15000 })
            const 后2 = load(base + '/资产.json', {})
            走成2 = !!(后2.在途 && String(后2.在途.to || '') === '家')
          } catch (e) { /* 看下面兜底 */ }
          if (走成2) {
            note = '困得撑不住了，但人在' + String(__哪2.位 || '外面') + ' —— 先往家走，到了再睡'
            napUntil = 0
          } else {
            // 走不成也不能让她永远不睡（跟 自动作息 那条兜底一字不差）
            console.log('走不成，先在' + String(__哪2.位 || '') + '将就睡')
            try {
              const __m = await import('./睡眠阶段.mjs')
              __m.startSleep()
              execFileSync(process.execPath, [join(tools, '作息.mjs'), '--想睡'], { encoding: 'utf8', timeout: 10000 })
              note = '困得撑不住了，走不回家，先在这儿睡了'
            } catch (e) {
              note = '想睡没睡成：' + String((e && e.message) || e).slice(0, 50)
            }
          }
        } else {
          try {
            const __m = await import('./睡眠阶段.mjs')
            // SLEEP_ASSERT 2026-11-16（批次543）：`startSleep` 有防重入
            // （`if (data.sleeping) return fail()`），返回 {ok:false} 就是「它认为已经在睡」。
            // 原来看都不看就报「去睡」—— 于是日志写着去睡了、`live.start` 却没动，
            // 外面看起来像「反复开睡」。现在把返回值摊开：开成了才喊 作息 --想睡。
            const __r = __m.startSleep()
            if (__r && __r.ok === false) {
              note = '想睡没开成（睡眠记录说已经在睡 / live 还在），本轮不重复开'
            } else {
              execFileSync(process.execPath, [join(tools, '作息.mjs'), '--想睡'], { encoding: 'utf8', timeout: 10000 })
              note = '困得撑不住了，去睡（不是眯一会儿）'
            }
          } catch (e) {
            note = '想睡没睡成：' + String((e && e.message) || e).slice(0, 50)
          }
        }
      }
    } else {
    // NAP_REAL 2026-11-06（批次134）：原来这一票只把 state 写成「打瞌睡」，
    // 既不睡也不回血 —— 她在电脑前「打瞌睡」四十分钟，体力一点没动。
    // NAP_LENGTH 2026-11-15（批次498）：原来一律 20~40 分钟。
    // 困意 118（熬穿档）的人只眯 24 分钟，起来还是 118 —— 她 03:19 那次就是这样。
    // 越困睡得越久是常识，不是替她做决定；上限仍按 打盹.mjs 的 60。
    const _分钟 = Math.round(
      (sleepy && sleepy >= 100) ? rand(40, 60)
        : (sleepy && sleepy >= 85) ? rand(30, 45)
          : rand(20, 40)
    )
    if (DRY) {
      note = `[dry] 会眯 ${_分钟} 分钟`
      napUntil = Date.now() + _分钟 * 60e3
    } else {
      try {
        // NAP_NOTE_CLEAN 2026-11-06（批次134）：cron 顶部挂了 NODE_OPTIONS=--import=日志前缀，
        // 子进程 stdout 会带 "[2026-11-06 13:57:01 打盹.mjs] " —— 这行原本把输出当 note 写进
        // 自主.json，面板和注入里就成了「[时间 脚本] 眯 27 分钟」。note 自己拼，不读它的输出。
        // NAP_WHY 2026-11-14（批次423）：原来写死「困了」。低于 20 体力才抽到这个签的时候，
        // 那不是困，是撑不住 —— 醒来看到的「给自己的理由」得是当时真的事。
        // NAP_READBACK 2026-11-16（批次560）：**以前这里不读输出、也不读回 打盹.json。**
        // 而 `打盹.mjs --开始` 可能把这次挡回来（「已经在打盹，08:33 醒」）——
        // 挡住了它也照样自己 `Date.now() + _分钟` 算一个到点，写进 note 和 nextAt。
        // 实测 11-16：08:00 记「眯 33 分钟（08:33 醒）」、08:03 又记「（08:36 醒）」，
        // 两条都不等于 打盹.json 那一刻的真值。一个事实两处算，必然分叉。
        // 现在：接住输出，到点从 打盹.json 读回（盹到点）。脚本没写成（拿不到到点）才退回自己算。
        const __嗝 = String(execFileSync(process.execPath, [join(tools, '打盹.mjs'), '--开始', String(_分钟), (__lowBody <= H('自主_累到必须打盹', 20) ? '实在撑不住了' : '困了')], { encoding: 'utf8', timeout: 10000 }) || '').trim()
        const __盹 = load(join(base, '打盹.json'), null)
        const __到 = 盹到点(__盹)
        napUntil = __到 > Date.now() ? __到 : Date.now() + _分钟 * 60e3
        const __剩 = Math.max(1, Math.round((napUntil - Date.now()) / 60e3))
        note = `眯 ${__剩} 分钟（${new Date(napUntil + 8 * 3600e3).toISOString().slice(11, 16)} 醒）`
        if (/已经在打盹/.test(__嗝)) {
          // 这一轮其实没开新盹，只是撞上了还在打的那个。留一行，aut.log 里出现两条
          // 「打瞌睡」时才看得出是哪一种（重开 vs 撞上）。
          try {
            const __d = join(base, '日志')
            if (!existsSync(__d)) mkdirSync(__d, { recursive: true })
            appendFileSync(join(__d, '打盹.log'), new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
              + ' [自主行动] 想眯 ' + _分钟 + ' 分钟，但还在打盹里（到 ' + new Date(napUntil + 8 * 3600e3).toISOString().slice(11, 16) + '），不重开\n')
          } catch { /* 日志失败不影响 */ }
        }
      } catch (e) {
        note = `想眯一会儿没眯成：${String(e.message).slice(0, 60)}`
      }
    }
    }

  } else if (pick === '看B站') {
    if (DRY) note = '[dry] 会优先读未学稿，没有才取一条候选'
    else {
      const reading = (await unreadBiliReading()) || fetchBiliReading()
      if (await isBiliLearned(reading.id)) throw new Error(`《${reading.title}》以前已经学过，不重复凑笔记`)
      const r = runLearning('--bili', reading.id)
      selfNext = r.selfNext
      if (r.code !== 0) throw new Error(`学习轮退出码 ${r.code}`)
      // NOTE_SELF 2026-11-05（批次87）：原来这里只写「看了《标题》，学习轮结束」——
      // 她写的自述（哪一点留在心里）被整个丢掉，对话侧只拿得到一个标题。
      // 于是别人问「看的什么」，她说得出片名、说不出内容；再往下就只能编。
      feelKind = r.feel
      // 时长进 note（批次130）：这句话会写进 自主.json.note，下一轮注入原样给她看。
      // 片名后面带上「（21 秒）」，别人问「看了多长」她才答得出来，不用现估。
      const 多久 = 时长话(reading.duration)
      const 片名 = 多久 ? `《${reading.title}》（${多久}）` : `《${reading.title}》`
      note = r.summary ? `看了${片名}：${r.summary}` : `看了${片名}，没留下什么`
    }
  } else if (pick === '逛贴吧') {
    const r = runLearning('--tieba')
    selfNext = r.selfNext
    if (r.code !== 0) throw new Error(`贴吧学习轮退出码 ${r.code}`)
    // ONE_SHOT_NOTE 2026-11-05：原来 note 是硬编码的「去贴吧看了一轮」，
    // 对话侧只能读到 state=逛贴吧 + 已经 N 分钟，她就以为自己还在翻。
    // 现在把这一轮真正读到的写进 note —— 她才有东西可说，也才不会拿旧梗当新的。
    feelKind = r.feel
    note = DRY ? '[dry] 会跑一轮只读贴吧学习' : (r.summary || '去贴吧看了一轮，没读到合适的')
  } else if (pick === '打零工') {
    try {
      const 配 = load(join(tools, '工作.json'), { 活: {} }).活 || {}
      const 地档 = (() => {
        try {
          const out = execFileSync(process.execPath, [join(tools, '地点.mjs'), '--json'], { encoding: 'utf8', env: { ...process.env, QQ_MEM: base, LOG_PREFIX_OFF: '1' }, timeout: 8000 })
          return new Set((JSON.parse(out).能去哪 || []).map((x) => x.name))
        } catch { return new Set(['便利店', '咖啡店']) }
      })()
      const cur = String(assets.位置 || '家')
      地档.add(cur)
      const 可选 = Object.entries(配).filter(([, c]) => c && 地档.has(String(c.点 || '')))
      if (!可选.length) {
        note = '翻了翻日结招工信息，这会儿店都关着，算啦不去啦'
      } else {
        // 优先挑就在脚下这间店的活，没有再随机挑一个开着门的地方走过去接单
        const 就地 = 可选.filter(([, c]) => String(c.点) === cur)
        const [活名, 活配] = 就地.length ? 就地[Math.floor(Math.random() * 就地.length)] : 可选[Math.floor(Math.random() * 可选.length)]
        if (DRY) {
          note = `[dry] 随心选单日零工：${活名} @${活配.点}`
        } else if (String(活配.点) === cur) {
          const out = execFileSync(process.execPath, [join(tools, '工作.mjs'), '--临时', '--活', 活名], { encoding: 'utf8', timeout: 10000 }).trim()
          note = out || `在${cur}接了单日零工：${活名}`
        } else {
          const out = execFileSync(process.execPath, [join(tools, '走路.mjs'), '--去', String(活配.点)], { encoding: 'utf8', timeout: 10000 }).trim()
          note = `${out || ('出发去' + 活配.点)}（想去干单日零工：${活名}）`
          try { const trip = load(join(base, '资产.json'), {}).在途; if (trip && Number(trip.arriveAt) > 0) walkArriveAt = Number(trip.arriveAt) } catch (_err) { console.error('[自主行动]', _err?.message || _err) }
        }
      }
    } catch (e) { note = '（看了一眼零工没去成：' + String(e.message).slice(0, 40) + '）' }
  } else if (pick === '去上班') {
    try {
      const out = DRY ? `[dry] 去${__班次强制动作.去哪}上班` : execFileSync(process.execPath, [join(tools, '走路.mjs'), '--去', __班次强制动作.去哪], { encoding: 'utf8', timeout: 10000 }).trim()
      note = out || `去${__班次强制动作.去哪}上${__班次强制动作.活}班`
      if (!DRY) {
        try { Object.assign(assets, load(join(base, '资产.json'), assets)) } catch { /* keep snapshot */ }
        try { const trip = load(join(base, '资产.json'), {}).在途; if (trip && Number(trip.arriveAt) > 0) walkArriveAt = Number(trip.arriveAt) } catch (_err) { console.error('[自主行动]', _err?.message || _err) }
      }
    } catch (e) { note = `赶去${__班次强制动作.活}班失败：${String(e.message).slice(0, 60)}` }
  } else if (pick === '走动') {
    try {
      const walk = join(tools, '走路.mjs')
      if (assets.在途) {
        // 2026-11-05 批次65：原来无条件写「（到X了）」—— 可 --到 在时间没到时
        // 回的是「还在路上，剩 12 分钟」，那句话被丢了，日志就成了假账。
        // 现在照它自己说的话记。
        const said = DRY ? '' : execFileSync(process.execPath, [walk, '--到'], { encoding: 'utf8' }).trim()
        // ARRIVE_REREAD 2026-11-07（批次166）：--到 会改 资产.位置，也会自己同步 自主.place。
        // 手里这份 assets 是出门前读的 —— 不重读，下面 aut.place = assets.位置 就写成【出发地】，
        // 再把子进程写好的 place 整份抹回去（她到了街市、自主记着家）。
        // 生产路径走不到这一行（上面 3.5 的守卫已经结算并重读过），所以这个 bug 一直没露头；
        // 但它是「第二条到达路径」，留着就是等下一个入口来踩。
        if (!DRY) { try { Object.assign(assets, load(join(base, '资产.json'), assets)) } catch { /* 读不到就沿用旧的 */ } }
        note = said || ('走了走，人在' + (assets.位置 || '?'))
      } else {
        // SPOT_PICK 2026-11-05（批次79）：
        // 原来是从地图上随机跳一个点到另一个点，不看开没开、不看天气。
        // 于是 02:00 说去图书馆，下雨天往公园跑 —— 她自己都不知道那会儿关门了。
        // 现在问 地点.mjs：此刻开着、又待得住的，按舒服程度加权抽。
        const cur = String(assets.位置 || '家')
        const 候选 = (() => {
          // DRY 也照样问一次：地点.mjs 是只读的，不写任何东西。
          // 不让它跑的话 --dry 就永远看不到「会选哪儿」，等于没法验证。
          try {
            // 传 QQ_MEM 而不是靠 地点.mjs 自己读环境：沙盒必须一路传到底，
            // 不然测试会读到真实天气和真实位置。
            const out = execFileSync(process.execPath, [join(tools, '地点.mjs'), '--json'], {
              encoding: 'utf8',
              env: { ...process.env, QQ_MEM: base, LOG_PREFIX_OFF: '1' },
              timeout: 8000,
            })
            const j = JSON.parse(out)
            return (j.能去哪 || []).filter((x) => x && x.name && x.name !== cur && Number(x.分) >= 0.1)
          } catch { return [] }
        })()
        // GO_HOME 2026-11-05（批次89）：身上黏了先回家 —— 洗澡只在家/澡堂。
        // 能去哪 默认把「家」滤掉（那是住处，不是去处），所以不补这一条，
        // 她会在外面一直逛到所有店都关门才「没地方去，只好回家」。
        // TEST_DETERMINISTIC 2026-11-05（批次101）：`--试走动` 是测试专用旗标，
        // 它要验的是「这条路通不通」，不是「今天掷到哪儿」。原来按 0.95 的权重跟
        // 电玩城/商店一起抽，回家概率只有两成多，测一次红一次绿 —— 假失败比失败更贵。
        // 只在测试旗标下把「家」顶到必选，生产路径的权重一分不动。
        if (清洁 < 55 && cur !== '家') 候选.unshift({ name: '家', 分: 试走动 ? 99 : 0.95, 走: 0, 室内: true })
        const 家数 = Array.isArray(assets.家) ? assets.家.length : 0
        const to = (() => {
          if (候选.length) {
            // 按分数加权，但不是「必然选最高分」—— 人不会天天去同一个最舒服的地方，
            // 所以把差距压平一点（每个都加 0.15 的底），保留「就是想走走」的随机。
            const __未完目标 = new Set(((__今日计划 && __今日计划.goals) || []).map((g) => g && g.id).filter((id) => id && !((__今日计划.done || []).includes(id))))
            const __目标地 = new Set([
              ...(__未完目标.has('出门散散心') ? ['公园', '海边', '街市'] : []),
              ...(__未完目标.has('看场电影') ? ['电影院'] : []),
              ...(__未完目标.has('去游乐园') ? ['游乐园'] : []),
              ...(__未完目标.has('看点书') ? ['图书馆', '学校'] : []),
            ])
            const 权 = 候选.map((x) => Math.max(0.2, Number(x.分) + 0.15 + (!试走动 && __目标地.has(x.name) ? 0.45 : 0)))
            const 总 = 权.reduce((a, b) => a + b, 0)
            let r = Math.random() * 总
            for (let i = 0; i < 候选.length; i += 1) {
              r -= 权[i]
              if (r <= 0) return 候选[i].name
            }
            return 候选[候选.length - 1].name
          }
          // 一个都去不成（深夜、全关门）：在家待着，或者回那个开着的地方
          if (cur !== '家') return 家数 > 3 ? '家' : ''
          return ''
        })()
        if (!to) {
          note = '在' + cur + '待了会儿，这个点也没别的地方可去'
        } else {
        const out = DRY ? `[dry] 去${to}` : execFileSync(process.execPath, [walk, '--去', to], { encoding: 'utf8' }).trim()
        note = out || ('出发去' + to)
        if (!DRY) {
          try {
            const 途 = load(join(base, '资产.json'), {}).在途
            if (途 && Number(途.arriveAt) > 0) walkArriveAt = Number(途.arriveAt)
          } catch { /* 读不到就按「现在就到了」处理 */ }
        }
        }
      }
    } catch (e) { note = '（想出门没走成：' + String(e.message).slice(0, 40) + '）' }
  } else if (pick === '洗澡') {
    try {
      // 洗到多干净、洗多久，交给 洗澡.mjs 算（越脏越久，澡堂多泡一会儿）。
      const 到 = 清洁 < 50 ? 95 : 92
      // HUMANIZE 2026-11-18（批次696，P2-10）：原来这里替她编了「身上都黏了 / 该洗了」两个理由，
      // 之后又会以「你当时给自己的理由是「…」」回到她上下文里 —— 等于代码先编动机，再当她的原话还她。
      // 自动路径不再传 --why；只有她自己显式说过理由时才带。
      const out = DRY
        ? '[dry] 进浴室洗澡'
        : execFileSync(process.execPath, [join(tools, '洗澡.mjs'), '--开始', '--到', String(到)], { encoding: 'utf8' }).trim()
      note = out || '去洗澡了'
      if (!DRY) {
        try {
          const 洗 = load(join(base, '卫生.json'), {}).洗澡中
          const 结 = 洗 ? Date.parse(String(洗.结束 || '').replace(' ', 'T') + ':00+08:00') : 0
          if (Number.isFinite(结) && 结 > Date.now()) 洗澡结束At = 结
        } catch { /* 读不到就按下面 ranges 里的固定时长 */ }
      }
    } catch (e) { note = '（想洗澡没洗成：' + String(e.message).slice(0, 40) + '）' }
  } else if (pick === '拍张照') {
    try {
      // 2026-11-05 批次65：沙盒跑 --试拍照 会往她真实的自拍队列里塞一张假请求
      // （自拍.mjs 用的是 SHOT_MEM / SHOT_BASE，不是 QQ_AUTONOMY_MEM）。
      const shotEnv = process.env.QQ_AUTONOMY_MEM
        ? { ...process.env, SHOT_MEM: base, SHOT_BASE: join(base, '自拍沙盒') }
        : process.env
      const out = DRY
        ? '[dry] 自拍排队'
        // PICK_SUBJECT 2026-11-05：自拍.mjs 现在会先问一次模型「这张拍什么」（实测 2~4 秒，
        // 偶尔十几秒），原来 15 秒的超时会把这一步掐掉，退化成兜底的自拍。
        : execFileSync(process.execPath, [join(tools, '自拍.mjs')], { encoding: 'utf8', timeout: 90e3, env: shotEnv }).trim()
      // NOTE_HUMAN 2026-11-05：这段 note 会被 poll.js 原样念给她听（「你上一次自己做的事…」）。
      // 原来是 自拍.mjs 的机器输出「自拍已排队: mw395ll2g8z2 ｜场景 便利店 ｜动作 逛贴吧 ｜…」，
      // 她照着念就是一堆 id 和竖线。只留「在哪儿拍的」，其余交给照片墙。
      const 场 = (String(out).match(/场景\s*([^｜|]+)/) || [])[1]
      const 主 = (String(out).match(/主体\s*([^｜|]+)/) || [])[1]
      // 说法：她拍的不一定是自己了，note 得说清拍的是什么，不然对话里她还说「拍了张照」，
      // 照片墙上一看是张空台阶 —— 对不上。
      const 说法 = { 自己: '自拍', 风景: '风景', 物件: '手边的东西', 别人: '别人的背影', 猫: '猫' }
      const 啥 = 说法[String(主 || '').trim()] || '照'
      note = 场 ? ('在' + String(场).trim() + '拍了张' + 啥) : '想拍张照，排上了'
    } catch (e) { note = '（想拍照没排上：' + String(e.message).slice(0, 40) + '）' }
  } else if (pick === '躺着') {
    note = '裹着被子躺着，什么也不想干'
  } else if (pick === '买瓶水') {
    try {
      if (DRY) note = '买了瓶水'
      else {
        const buy = execFileSync(process.execPath, [join(tools, '花钱.mjs'), '--买', '水'], { encoding: 'utf8', timeout: 12000 }).trim()
        const fill = purchaseSucceeded(buy)
          ? execFileSync(process.execPath, [join(tools, '物品.mjs'), '--装', '水'], { encoding: 'utf8', timeout: 10000 }).trim()
          : ''
        const drink = fill
          ? execFileSync(process.execPath, [join(tools, '物品.mjs'), '--喝杯', '300'], { encoding: 'utf8', timeout: 10000 }).trim()
          : ''
        if (饮水动作成功({ 需购买: true, 买出: buy, 装水出: fill, 喝出: drink })) note = '买了瓶水，拧开喝了几口'
        else { drinkFailed = true; note = `买水或饮用没成：${[buy, fill, drink].filter(Boolean).join('；') || '没有成功回执'}` }
      }
    } catch (e) { drinkFailed = true; note = '（买水没成：' + String(e.message).slice(0, 60) + '）' }
  } else if (pick === '去医院') {
    // 2026-11-08（批次224）：不在医院就先去，到了才挂号。看病全程占用在 疾病.json 的 就诊。
    try {
      if (DRY) note = '去医院看病'
      else if (String(assets.位置 || '家') !== '医院') {
        execFileSync(process.execPath, [join(tools, '走路.mjs'), '--去', '医院'], { encoding: 'utf8', timeout: 10000 })
        note = '去医院挂号'
      } else {
        const out = execFileSync(process.execPath, [join(tools, '疾病.mjs'), '--挂号'], { encoding: 'utf8', timeout: 10000 }).trim()
        note = /挂上号/.test(out) ? '挂上号了，在候诊区排着' : '号没挂上'
      }
    } catch (e) { note = '（去医院没成：' + String(e.message).slice(0, 40) + '）' }
  } else if (pick === '去药店') {
    // 到店买一盒感冒药，当场吃一片（药 30~45 分钟才起效，不假装立刻好）
    try {
      if (DRY) note = '去药店买药'
      else if (String(assets.位置 || '家') !== '药店') {
        execFileSync(process.execPath, [join(tools, '走路.mjs'), '--去', '药店'], { encoding: 'utf8', timeout: 10000 })
        note = '去药店'
      } else {
        const 买 = execFileSync(process.execPath, [join(tools, '花钱.mjs'), '--买', '感冒药'], { encoding: 'utf8', timeout: 12000 }).trim()
        if (/买了/.test(买)) {
          execFileSync(process.execPath, [join(tools, '物品.mjs'), '--吃', '感冒药'], { encoding: 'utf8', timeout: 10000 })
          note = '在药店买了感冒药，当场吃了一片'
        } else note = '药店没买成'
      }
    } catch (e) { note = '（去药店没成：' + String(e.message).slice(0, 40) + '）' }
  } else if (pick === '喝点水') {
    try {
      if (DRY) note = '接了杯水喝'
      else {
        const 位 = String(assets.位置 || '家')
        const 前杯 = 杯态()
        let 接水出 = ''
        const 需接水 = !!(前杯.在包 && 前杯.毫升 < 100 && 能接水(位))
        if (需接水) 接水出 = execFileSync(process.execPath, [join(tools, '物品.mjs'), '--接水'], { encoding: 'utf8', timeout: 8000 }).trim()
        const 喝出 = execFileSync(process.execPath, [join(tools, '物品.mjs'), '--喝杯', '300'], { encoding: 'utf8', timeout: 8000 }).trim()
        if (饮水动作成功({ 需接水, 接水出, 可直接喝: Number(前杯?.毫升) >= 100, 喝出 })) {
          note = 需接水 ? '接了杯水，一口气喝完' : '拧开水杯喝了几口'
        } else {
          drinkFailed = true
          note = `想喝水没喝上：${[接水出, 喝出].filter(Boolean).join('；') || '没有成功回执'}`
        }
      }
    } catch (e) { drinkFailed = true; note = '（想喝水没喝上：' + String(e.message).slice(0, 60) + '）' }
  } else if (pick === '吃点东西') {
    function 厨房煮面兜底(原因) {
      if (String(assets.位置 || '') !== '家') return false
      try {
        execFileSync(process.execPath, [
          join(tools, '吃饭.mjs'), '--开始',
          '--吃', '热汤面', '--在哪', '家', '--分钟', '20',
          '--加', '600', '--类别', '吃'
        ], { encoding: 'utf8', timeout: 10000 })
        const _meal = load(join(base, '吃饭.json'), null)
        if (_meal && _meal.吃啥 === '热汤面') {
          aut.区域 = '厨房'
          aut.地盘 = '在厨房煮了碗热汤面吃'
          note = `${原因}，在厨房自己煮了碗热汤面吃`
          foodFailed = false
          return true
        }
      } catch (_err) { console.error('[自主行动]', _err?.message || _err) }
      return false
    }
    // EAT_STOCK 2026-11-06（批次144）：家里存着的东西先吃，别一饿就再买一份。
    // 这也是「零食、牛奶买回家」这件事的意义 —— 买了存着，饿了在家吃，
    // 而不是每顿都站在便利店柜台前当场拆开。
    let 吃了存货 = ''
    // DRY 时不能真吃：--dry 是「只演示」，替她把存货吃掉就成了测试污染（批次65 那个坑）
    if (!DRY && String(assets.位置 || '') === '家') {
      try {
        const 物 = load(join(base, '物品.json'), { items: [] })
        const 存货 = (Array.isArray(物.items) ? 物.items : [])
          .filter((x) => x.在 === '家' && ['吃', '喝', '零食'].includes(String(x.类 || '')))
        if (存货.length) {
          let __饱0 = 55
          try { __饱0 = 饥饿.读().饱腹 } catch { /* 读不到就按还行挑 */ }
          // 饿得厉害先挑顶饱的；只是嘴馋就随便一样（天天同一包饼干也腻）
          存货.sort((a, b) => (Number(b.饱腹) || 0) - (Number(a.饱腹) || 0))
          const 选 = __饱0 < 45 ? 存货[0] : 存货[Math.floor(Math.random() * 存货.length)]
          const requestedAt = Date.now()
          const out = execFileSync(process.execPath, [join(tools, '物品.mjs'), '--吃', String(选.n)],
            { encoding: 'utf8', timeout: 15000 }).trim()
          const outcome = classifyFoodAttempt({ purchased: true, consumeOutput: out,
            meal: load(join(base, '吃饭.json'), null), food: String(选.n), now: Date.now(), requestedAt })
          if (outcome === 'started') 吃了存货 = out
          else { foodFailed = true; note = out || '库存食物没有开始进食' }
        }
      } catch (e) { foodFailed = true; note = '库存食物没有开始进食：' + String(e.message).slice(0, 40) }
    }
    try {
      const 困意 = Number(st.困意 ?? 0)
      // HUNGER 2026-11-06（批次139）：点什么按肚子来，不按精力。
      // 原来 `energy < 45 → 一顿正经饭`：她精力一直低，于是一天点了 6 次正经饭。
      // 第二版还漏了地点 —— 她在便利店，`一顿正经饭` 只有超市/餐厅有，会被拒。
      // 现在按档位排一个清单，用「这儿买不买得到」挑第一个。
      let __饱 = 55
      try { __饱 = 饥饿.读().饱腹 } catch { /* 读不到就按「还行」挑 */ }
      let want = '糖'
      if (困意 >= 70 && __饱 >= 40) want = '咖啡'   // 撑的时候咖啡也灌不下；饿了还是先吃饭
      else {
        // CALORIE_VS_HUNGER 2026-11-08（批次278）。主人两句话定的规矩：
        //   ①「不要把热量跟饥饿度混淆，饥饿是饥饿，热量是热量，热量低的时候应该更倾向于吃热量高的食物」
        //   ②「低于 50% 就算挺低了，90% 差不多才算充足」
        // 所以这里只看热量缺口，不看「饿不饿」——饿不饿是饱腹感（胃 60% + 血糖 40%），
        // 那个在池子权重那边算过了，跟「吃多重」是两件事。
        //   < 30%  极缺 → 火锅/烤肉这种一顿补满的
        //   30~50% 挺低 → 汉堡/麻辣烫/正经饭/拉面这一档（不排火锅，但也不许拿零食糊弄）
        //   50~90% 一般 → 按钟点吃顺口的
        //   >= 90% 充足 → 才只垫零食
        // kcal 取自 物品总表（实测）：火锅1160 烤肉1120 吃好吃的1040 寿司920 汉堡套餐900
        //   麻辣烫840 一顿正经饭800 拉面760 早饭640 自热饭640 粥和咸菜600 包子520 泡面440
        //   烧烤1000 炒饭700（批次278 新加的两个夜宵）；零食类只有 80~260。
        const 钟 = bjDate().getUTCHours()
        const 早饭点 = 钟 >= 5 && 钟 < 10
        const 夜里 = 钟 >= 22 || 钟 < 5
        // 夜宵：过了十点，除了泡面包子，也能正经吃一顿烧烤。
        // 两个清单都严格按 kcal 降序（1160>1120>1040>1000>920），
        // 因为「热量低就挑热量高的」全靠这个顺序，插错一项就失效。
        const 最顶饱 = ['火锅', '烤肉', '吃好吃的', '烧烤', '寿司']
        const 顶饱 = 夜里
          ? ['烧烤', '汉堡套餐', '麻辣烫', '拉面', '炒饭', '自热饭', '包子', '泡面']
          : ['汉堡套餐', '麻辣烫', '一顿正经饭', '拉面', '自热饭', '早饭', '粥和咸菜', '包子', '泡面']
        const 顺口 = 早饭点
          ? ['早饭', '粥和咸菜', '包子', '拉面', '自热饭']
          : 夜里
            ? ['烧烤', '炒饭', '泡面', '包子', '自热饭']
            : ['一顿正经饭', '拉面', '麻辣烫', '汉堡套餐', '自热饭', '泡面']
        const 零食 = ['饼干', '水果', '糖', '薯片', '布丁', '小蛋糕']
        const 去重 = (a) => [...new Set(a)]
        const 热 = Number(__饱) || 55   // 热量百分比。变量名叫 __饱 有歧义，但值就是千卡占比
        const 想要 = 去重(
          热 < 30
            // 极缺：一顿补满。早饭点仍先吃早饭（640 不算低），不早上吃火锅
            ? (早饭点 ? ['早饭', '粥和咸菜', ...最顶饱, ...顶饱, ...零食] : [...最顶饱, ...顶饱, ...零食])
            : 热 < 50
              // 挺低：不排火锅，但也要正经一顿
              ? (早饭点 ? ['早饭', '粥和咸菜', ...顶饱, ...零食] : [...顶饱, ...零食])
              : 热 < 90
                ? [...顺口, ...零食]   // 一般：按钟点吃顺口的
                : 零食)                // 充足：才垫零食
        want = 想要[0]
        if (mi <= -1.2 && __饱 >= 40) want = '奶茶'
        try {
          const 店 = JSON.parse(readFileSync(join(tools, '商店-生活.json'), 'utf8')).商品 || {}
          const 这 = String(assets.位置 || '家')
          // OPEN_FILTER 2026-11-14（批次404）：原来这里只判「这个地点卖不卖」，
          // **不判「这个点开不开门」** —— 于是凌晨四点她会一直挑只卖街市/餐厅的烧烤，
          // 买不到就 5 分钟后再试，而花钱.mjs 的回话里明明写着便利店还有早饭。
          // 现在把营业时间也判上；判据在 买得到.mjs 一份，跟 花钱 的闸同源。
          let 地点这份 = null
          try { 地点这份 = 读地点档(base) } catch { /* 读不到就全放行 */ }
          const 买得到 = (名) => {
            try { return 现在能买(名, 这, 店, 地点这份) } catch { return true }
          }
          const 命中 = 想要.find(买得到)
          if (命中) want = 命中
          else if (!DRY) {
            // BUGFIX 2026-11-12：如果当前所在地点（如图书馆/学校/水族馆/海边）一样吃的都不卖，
            // 先查包里有没有吃的；没有就直接迈腿走去开着门的便利店/餐厅/街市，绝不再原地连撞 花钱.mjs 刷屏「吃东西失败」！
            const 物包 = (load(join(base, '物品.json'), { items: [] }).items || [])
              .filter((x) => x && x.在 === '包' && ['吃', '喝', '零食'].includes(String(x.类 || '')))
            if (物包.length) {
              const out = execFileSync(process.execPath, [join(tools, '物品.mjs'), '--吃', String(物包[0].n)], { encoding: 'utf8', timeout: 12000 }).trim()
              吃了存货 = out || ('吃了包里的' + 物包[0].n)
            } else {
              let 去吃哪 = '便利店'
              try {
                const j = JSON.parse(execFileSync(process.execPath, [join(tools, '地点.mjs'), '--json'], { encoding: 'utf8', env: { ...process.env, QQ_MEM: base, LOG_PREFIX_OFF: '1' }, timeout: 8000 }))
                const 食点 = (j.能去哪 || []).find((x) => ['便利店', '餐厅', '街市', '咖啡店', '超市'].includes(x.name))
                if (食点) 去吃哪 = 食点.name
              } catch (_err) { console.error('[自主行动]', _err?.message || _err) }
              const wout = execFileSync(process.execPath, [join(tools, '走路.mjs'), '--去', 去吃哪], { encoding: 'utf8', timeout: 10000 }).trim()
              foodPending = true
              note = `${这}没卖吃的，${wout || ('出发去' + 去吃哪 + '觅食')}`
              try { const trip = load(join(base, '资产.json'), {}).在途; if (trip && Number(trip.arriveAt) > 0) walkArriveAt = Number(trip.arriveAt) } catch (_err) { console.error('[自主行动]', _err?.message || _err) }
            }
          }
        } catch { /* 商店表读不到就用默认第一项 */ }
      }
      if (吃了存货) {
        // 家里有存着的就先吃家里的，这一轮不花钱
        note = 吃了存货
      } else if (!foodFailed && !foodPending) {
        const requestedAt = Date.now()
        const out = DRY ? `[dry] 买${want}` : execFileSync(process.execPath, [join(tools, '花钱.mjs'), '--买', want], { encoding: 'utf8' }).trim()
        if (DRY) note = out
        else if (!purchaseSucceeded(out)) {
          // NOODLE_FALLBACK 2026-11-24（批次715，按《方案-总.md》D8 厨房煮面兜底落地）：
          if (!厨房煮面兜底(`想买没买成（${out || '未知原因'}）`)) {
            foodFailed = true
            note = out || '购买未成功'
          }
        }
        else if (/下了快递|明天到/.test(out)) { foodPending = true; note = out }
        else {
          let meal = load(join(base, '吃饭.json'), null)
          let outcome = classifyFoodAttempt({ purchaseOutput: out, meal, food: want, now: Date.now(), requestedAt })
          let consumeOutput = ''
          if (outcome !== 'started') {
            try { consumeOutput = execFileSync(process.execPath, [join(tools, '物品.mjs'), '--吃', want], { encoding: 'utf8', timeout: 15000 }).trim() }
            catch (e) { consumeOutput = '启动进食失败：' + String(e.message).slice(0, 40) }
            meal = load(join(base, '吃饭.json'), null)
            outcome = classifyFoodAttempt({ purchaseOutput: out, consumeOutput, meal, food: want, purchased: true, now: Date.now(), requestedAt })
          }
          if (outcome === 'started') note = consumeOutput || out
          else if (outcome === 'pending') { foodPending = true; note = out }
          else {
            // FOOD_KEEP 2026-11-16（批次554）：**这句话原来只是话术 —— 代码里根本没入库。**
            // 实测 11-15 23:55 她买泡面（5 块）：钱扣了，`物品.json` 里没有泡面，
            // 而这一行写着「食物保留在库存」。第二天她想「吃存货」永远吃不到，
            // 家里 `物品.json` 从头到尾只有一只水杯。
            // 根因：花钱.mjs 把泡面走了「堂食」分支（直接调 吃饭.mjs，不写物品），
            // 吃饭没起来 → 钱花了、东西没了、还留了一句假话。
            // 现在真补一次入库；已经有同名的就不补（幂等，防止花钱那边已经入过）。
            const __包里 = (() => {
              try {
                const d = load(join(base, '物品.json'), {})
                return (Array.isArray(d.items) ? d.items : []).some((x) => x && String(x.n) === String(want))
              } catch { return false }
            })()
            let 留住了 = __包里
            if (!__包里) {
              try {
                execFileSync(process.execPath, [
                  join(tools, '物品.mjs'), '--入', String(want), '--在', '包', '--价', '0',
                ], { encoding: 'utf8', timeout: 15000 })
                留住了 = true
              } catch { /* 见下面的话术 */ }
            }
            foodFailed = true
            note = 留住了
              ? `买到了${want}，但没有开始有效进食；先塞进包里存着`
              : `买到了${want}，但没吃成，也没能存进包（这份算丢了）`
          }
        }
      }
    } catch (e) {
      if (!厨房煮面兜底(`想买没买成（${String(e.message).slice(0, 40)}）`)) {
        foodFailed = true
        note = '（想买没买成：' + String(e.message).slice(0, 40) + '）'
      }
    }
  // OLD_MEM_FIX 2026-11-07（批次184）：这里原来从 meow 的 fact 表随机抽一条
  // （`select substr(content,1,60) from fact order by random() limit 1`），
  // 而那张表里全是运维技术笔记 —— PZ 服务器停服、DSH 版本号、GitHub 被墙、
  // 「B:/Downloads/人设/表情包/」。实测 35 次「想起了」，最近 10 条全是这类内容，
  // 每一条都写成「判断：突然想起一件事」进了链，再随「链尾」每轮注入回上下文。
  // 她是生活型 agent，不该把维护者的运维日志当成自己的回忆。
  // 改成翻她自己的账：跨天手账的「那天的心气」→ 梦的余味。抽过的不再抽，转完一圈从头。
  } else if (pick === '翻旧账') {
    if (DRY) note = '[dry] 翻一条自己的旧账'
    else {
      try {
        const 账本 = join(base, '翻旧账.json')
        let 已抽 = []
        try { 已抽 = JSON.parse(readFileSync(账本, 'utf8')).已抽 || [] } catch { 已抽 = [] }
        const 池 = []
        for (let i = 1; i <= 14; i++) {
          const day = new Date(bjDate().getTime() - i * 86400e3).toISOString().slice(0, 10)
          const hp = existsSync(join(base, '手账-' + day + '.md')) ? join(base, '手账-' + day + '.md') : join(base, '手账', '手账-' + day + '.md')
          if (existsSync(hp)) {
            const m = readFileSync(hp, 'utf8').match(/^那天的心气：(.+)$/m)
            const t = 只留心气(m && m[1])
            if (t && t.length >= 15) 池.push({ id: '手账-' + day, 说: day + ' 那天，' + t })
          }
          const dp = existsSync(join(base, '梦-' + day + '.md')) ? join(base, '梦-' + day + '.md') : join(base, '梦', '梦-' + day + '.md')
          if (existsSync(dp)) {
            const m = readFileSync(dp, 'utf8').match(/^余味[:：]\s*(.+)$/m)
            const t = m && m[1].trim()
            if (t && t.length >= 6) 池.push({ id: '梦-' + day, 说: day + ' 那晚的梦，' + t })
          }
        }
        // DEDUP 2026-11-07（批次187b）：相同的正文只留最新一条，见 心气.mjs 的 去重池
        const 池去重 = 去重池(池)
        let 可选 = 池去重.filter((x) => !已抽.includes(x.id))
        if (!可选.length) { 已抽 = []; 可选 = 池去重 }
        if (可选.length) {
          const 选 = 可选[Math.floor(Math.random() * 可选.length)]
          已抽 = 已抽.concat(选.id).slice(-30)
          写档(账本, { 已抽 })
          const 正文 = 选.说.slice(0, 60)
          appendFileSync(chainP, '\n## ' + nowStr + '\n- 判断：想起 ' + 正文 + '\n- 未决：（没有）\n')
          note = '想起了：' + 正文.slice(0, 24)
        } else {
          note = '想翻翻旧账，翻了翻什么也没想起来'
        }
      } catch (e) { note = '想翻旧账没翻成：' + String(e.message).slice(0, 40) }
    }
  } else if (pick === '琢磨黑话') {
    // 2026-11-19：保留旧测试入口，但自主行动没有聊天归属，不再从混合群日志学词。
    note = '没有具体聊天，先不翻词库'
  } else if (pick === '学点东西') {
    const f = join(base, '学习笔记.md')
    if (existsSync(f)) {
      const lines = readFileSync(f, 'utf8').split('\n').filter((l) => l.trim().length > 8)
      if (lines.length) note = '翻了翻学习笔记：' + lines[Math.floor(Math.random() * lines.length)].slice(0, 20)
    }
  }
} catch (e) {
  note = `（想做「${pick}」没做成：${String(e.message).slice(0, 100)}）`
  if (pick === '吃点东西') foodFailed = true
  if (pick === '喝点水' || pick === '买瓶水') drinkFailed = true
}

// 5) 决定下一次什么时候再动。学习轮自己给的优先；本地动作按内容留消化时间。
// FORM 2026-11-05：动作要分「在哪做」。
// 线上动作（逛贴吧/看B站/学点东西/翻旧账）在手机上就能做，跟脚下的地方没关系；
// 线下动作（拍张照/吃点东西/买东西/打工逛街走动）才和地点强绑定。
// 不分这个的后果：她人在便利店、状态写着「逛贴吧」，主人说「别在便利店逛太久」，
// 她只能把「逛贴吧」的逛和便利店的货架缝在一起，答成「看货架看得太入迷」。
const FORM = {
  逛贴吧: '线上', 看B站: '线上', 学点东西: '线上', 翻旧账: '线上',
  刷手机: '线上', 玩电脑: '线上', 摸鱼: '线上', 打瞌睡: '线上',
  拍张照: '线下', 吃点东西: '线下', 喝点水: '线下', 躺着: '线上', 买东西: '线下', 吃饭: '线下', 去医院: '线下', 去药店: '线下', 买瓶水: '线下',
  打工: '线下', 打零工: '线下', 逛街: '线下', 走动: '线下', 洗澡: '线下',
}
// ONE_SHOT 2026-11-05：这一轮几十秒就做完的动作。state 是「最近做过什么」的标签，
// 不是「正在做」——原来两者混用一个字段，14:58 那轮逛贴吧 30 秒读完，状态挂到 15:56，
// 她一直跟人说「还在翻」。区分开之后，对话侧才敢说「这件事已经做完了」。
// IMPORTED_SHOT 2026-11-16（批次538）：清单搬到 在干嘛.mjs 了 —— 活动.mjs 也要用同一份判
// 「她是在逛店，还是喝完水站在这儿」。这里只留个别名，不许再写第二份。
const ONE_SHOT = 一次性动作

const ranges = {
  刷手机: [20, 70], 玩电脑: [40, 120], 摸鱼: [35, 120], 翻旧账: [50, 160], 学点东西: [55, 180],
  走动: [30, 100], 吃点东西: [60, 180], 喝点水: [40, 120], 躺着: [60, 180], 拍张照: [80, 220], 打瞌睡: [20, 60], 去医院: [180, 600], 去药店: [60, 180],
  看B站: [60, 220], 逛贴吧: [80, 260], 洗澡: [25, 45], 断片: [1, 3],   // MICROSLEEP（566）：几十秒，真值由 断片到点 决定
}
let nextMinutes = selfNext > 0 ? clamp(selfNext, 20, 360) : rand(...(ranges[pick] || [35, 120]))
if (!selfNext) {
  if (energy < 35) nextMinutes *= 1.35
  else if (energy > 75) nextMinutes *= 0.9
  if (cortisol > 65) nextMinutes *= 1.2
  if (recent.at(-1) === pick) nextMinutes *= 1.15
}
nextMinutes = clamp(Math.round(nextMinutes), 15, 360)
// MICROSLEEP（566）：断片只有几十秒。`clamp` 的下限是 15 分钟 —— 那是给真动作用的，
// 断片不能照抄，否则 aut.log 和面板上都写「15 分钟」，而她 40 秒就回神了。
if (pick === '断片' && 断片到点 > Date.now()) {
  nextMinutes = Math.max(1, Math.round((断片到点 - Date.now()) / 60000))
}
// 洗澡的时长不是「她打算多久以后再看情况」，是水放好了、人进浴室了：
// 出来那一刻就是这一轮结束，nextAt 跟 洗澡.mjs 算的结束时刻对齐，别自己另说一套。
if (洗澡结束At > Date.now()) nextMinutes = Math.max(1, Math.ceil((洗澡结束At - Date.now()) / 60e3))
// EAT_TIME 2026-11-06（批次144）：坐下来吃多长是 吃饭.mjs 定的（按吃什么算），
// 不在这里另说一套 —— 原来「吃点东西」的间隔是 60~180 分钟随机，
// 跟「吃一顿要多久」一点关系都没有。
try {
  // 批次167：判据在 占用.mjs。
  const _饭 = 在吃饭(base)
  if (_饭 && !foodFailed && !foodPending) nextMinutes = Math.max(1, Math.ceil((_饭.到 - Date.now()) / 60e3))
} catch { /* 读不到就按原间隔 */ }
if (foodFailed || drinkFailed) nextMinutes = 5
else if (foodPending) nextMinutes = Math.min(nextMinutes, 60)
const reportedAction = foodFailed ? '吃东西失败' : drinkFailed ? '喝水失败' : foodPending ? '等食物送达' : pick

// LAST_DONE 2026-11-05：记下刚做完的这一次（做的是什么、读到了什么）。
// state 会一直挂到 nextAt，但「刚读完」和「正在读」是两回事 ——
// 不分开的话，她会跟人说自己还在翻，其实那轮几十秒就结束了。
// LAST_ALWAYS 2026-11-05（批次86）：每轮都写，note 空也写。
// 原来只在 note 非空时才写，于是「发呆」「摸鱼」这些没有 note 的轮次不动它 ——
// 15:57 拍完照之后一直发呆，last 就停在「拍张照」上挂了三个多小时：
// 面板写「刚做完 15:57 拍张照」，她自己的上下文里也写着「刚做完的一件事：拍张照」，
// 两边看着都像卡住了 —— 主人报的就是这个。
// 现在 last 说的是「这一轮的结果」，note 空就是空；
// 面板和 poll.js 都靠 note 是否为空，决定要不要把那件事展开细说。
aut.last = {
  at: nowStr,
  what: reportedAction,
  note: String(note || '').slice(0, 120),
  // 心里那一下。只有她自己写了词、而且那轮真跑通了才有；
  // 不写就是不写 —— 空着比填一个「还好」诚实。
  feel: (feelKind && FEEL_SAY[feelKind]) || '',
  feelKind: feelKind || '',
}
aut.state = foodFailed || foodPending || drinkFailed ? '待命' : pick
if (__在岗班 && (pick === '喝点水' || pick === '买瓶水')) aut.state = '打工'
aut.since = Date.now()
// NAP_NOTE 2026-11-06（批次134）：打盹.mjs 已经写过 note，但父进程手里的 aut 是
// 调它之前读的，最后 save 会把那句覆盖成旧的。这里补回去，面板才看得见「眯到几点」。
// NOTE_FRESH 2026-11-07（批次169）：原来只有打瞌睡才更新 note —— 实测她 07:00 睡、
// 07:34 起来洗澡，state 已经变成「洗澡」，note 还挂着「睡着了」。
// note 是下一轮原样念给她听的那句，换了事就得换话；这一轮没说出个所以然就清掉，
// 别把上一件的留在脸上。
aut.note = note ? String(note).slice(0, 120) : ''
// FORM_NOTE 2026-11-05：把「在哪做」「什么时候做完」「当时人在哪」一起写进去。
// place 原来是个从来没被赋过值的哑字段（一直 null），对话侧只能从 资产.json 另读位置，
// 两句话分开拼，她才有机会把线上动作错接到线下地点上。
aut.form = foodFailed || foodPending ? '无所谓' : (FORM[pick] || '无所谓')
aut.place = String(assets.位置 || '')
aut.doneAt = (pick === '打瞌睡' && napUntil > Date.now())
  ? napUntil
  : (pick === '洗澡' && 洗澡结束At > Date.now())
    ? 洗澡结束At
    : (ONE_SHOT.has(pick)
      ? (walkArriveAt > Date.now() ? walkArriveAt : Date.now())
      : 0)
if (__在岗班 && (pick === '喝点水' || pick === '买瓶水') && __值班结束At > 0) aut.doneAt = __值班结束At
if (__在岗班 && (pick === '喝点水' || pick === '买瓶水') && __值班结束At > 0) aut.doneAt = __值班结束At
aut.nextAt = (pick === '打瞌睡' && napUntil > Date.now()) ? napUntil
  // MICROSLEEP（566）：断片只有几十秒，别按 ranges 的 35~120 分钟排。
  : (pick === '断片' && 断片到点 > Date.now()) ? 断片到点
    : Date.now() + nextMinutes * 60e3
if (__在岗班 && (pick === '喝点水' || pick === '买瓶水') && !drinkFailed && __值班结束At > 0) aut.nextAt = __值班结束At
// EAT_STATE 2026-11-06（批次144）：真坐下了，state 就写「吃饭」而不是「吃点东西」。
// 两句话不一样：「吃点东西」是刚做完的一件事（一次性），「吃饭」是正在做（占了这段时间）。
// 面板、注入、qq_go 的守卫都靠这个词判断她走不走得开。
try {
  // 批次167：判据在 占用.mjs。
  const _饭2 = 在吃饭(base)
  if (_饭2 && !foodFailed && !foodPending) {
    aut.state = '吃饭'
    aut.doneAt = _饭2.到
    aut.nextAt = _饭2.到
    aut.form = '线下'
    aut.place = String(_饭2.在哪 || aut.place || '')
  }
} catch { /* 读不到就按原样 */ }
const 这条 = { at: nowStr, state: reportedAction, note, nextMinutes }
aut.log = [...aut.log, 这条].slice(-200)
本轮log.push(这条)
存自主()
console.log(foodFailed ? `这轮没能开始进食，5 分钟后再试：${note}` : foodPending ? `食物尚未送达，暂不记为正在吃：${note}` : `现在去「${pick}」${note ? '：' + note : ''}`)
if (pick === '打瞌睡' && napUntil > Date.now()) {
  console.log(`眯到 ${new Date(napUntil + 8 * 3600e3).toISOString().slice(11, 16)}${DRY ? '（dry 未写入）' : ''}`)
} else if (pick === '断片') {
  console.log(`断片 ${Math.max(1, Math.round((断片到点 - Date.now()) / 1000))} 秒，之后接着过${DRY ? '（dry 未写入）' : ''}`)
} else {
  console.log(`这次她自己安排 ${nextMinutes} 分钟后再看情况${DRY ? '（dry 未写入）' : ''}`)
}
if (!DRY) { try { unlinkSync(LOCK) } catch { /* 忽略 */ } }
