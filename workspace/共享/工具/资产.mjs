#!/usr/bin/env node
// 资产.mjs —— 她的钱、东西、家（2026-11-02 第八条第二期）
//
// 用法：
//   node 资产.mjs --看看                 # 现在有多少钱、包里有什么、家里有什么
//   node 资产.mjs --打工                 # 去打工，赚点钱，掉精力
//   node 资产.mjs --逛                    # 出门逛逛，随机遇到点事，可能捡到东西
//   node 资产.mjs --商店                  # 看店里卖什么
//   node 资产.mjs --买 台灯               # 买一件，回家摆着
//   node 资产.mjs --摆 台灯               # 把包里的东西摆进家
//
// 为什么这么写：
//   · 钱不是目的，是她「有事干」的由头：打工掉精力、逛街花时间、买东西要攒钱。
//   · 家具摆在家里，能影响她的心情（有几件会让「家」这个场景更舒服），这是后续 3D 家的数据基础。
//   · 所有数值落一个文件，面板直接读，不用另做接口。
import { 写档, 改档 } from './_底层.mjs'
import { 加锁 } from './_锁.mjs'
// MOVE_SINGLE 2026-11-07（批次166）：搬人的写盘（位置/在途/到此At/记录/自主）只走 移动.mjs
import { 瞬移 } from './移动.mjs'
import { 精力 } from './恢复目标.mjs'
import { saveState, clone } from './_状态.mjs'
import { 读图 } from './地点.mjs'
import { 睡着 } from './睡态.mjs'
import { 起 as 起自主 } from './自主状态.mjs'
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
// 2026-11-02 参数化：拟人阈值统一从 参数.json 的「拟人」段读，读不到用默认值
import { readFileSync as _rf } from 'node:fs'
let _PJ = {}
try { _PJ = JSON.parse(_rf('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)

import { join, dirname } from 'node:path'

// SANDBOX_ENV 2026-11-05：支持 QQ_AUTONOMY_MEM 覆盖记忆目录，沙盒测试才写不到真实数据（其它脚本早就有，这份漏了）
const base = process.env.QQ_AUTONOMY_MEM || ('{{BOT_ROOT}}/记忆')
const moneyP = join(base, '资产.json')
const stP = join(base, '状态.json')

// ACTIVITY_SYNC 2026-11-03：面板动作（打工/逛街）执行后，把当前活动也写进 自主.json，
// 否则面板仍显示上一次的「摸鱼」，看起来像没联动。
function 记活动(state, note = '') {
  try {
    // 批次169：原来写的是 history —— 而 history 一个读取方都没有（批次169 审计确认）。
    // 自主行动 算 countToday / recent 读的是 log，所以面板点完「打工」它根本不知道，
    // 下一分钟就把这次重挑了。现在写 log（真账）。
    // note 只进 log 不写 aut.note：aut.note 是「下一轮原样念给她听」的那句，
    // 面板按钮不该替她开口。
    起自主(base, { state, form: '线下', 记: true, logNote: note })
  } catch { /* 写不进去也不影响主流程 */ }
}


// SLEEP_GUARD_ASSET 2026-11-03：睡着时任何资产动作都不执行（面板/脚本都拦住，防止边睡边打工）
try {
  const __slP = join(base, '睡眠.json')
  if (existsSync(__slP)) {
    const __sl = JSON.parse(readFileSync(__slP, 'utf8'))
    // SLEEP_GUARD_READONLY 2026-11-03：只读动作（--看看 / --商店）不受睡眠门禁影响，
  // 否则验收脚本和任何「查看」都会被误拦
  const __读 = process.argv.includes('--看看') || process.argv.includes('--商店')
  if (!__读 && 睡着(base)) { console.log('她睡着呢，等醒了再说'); process.exit(0) }
  }
} catch { /* 读不到就放行 */ }
const args = process.argv.slice(2)
// FURNITURE_OFF 2026-11-05：主人说「家具系统停了」，买/摆/换装这些改家底的入口一律关掉，
// 开关在 记忆/功能开关.json 的 家具 字段，想恢复改成 true 即可。只读（--看看/--商店）不受影响。
const __开关文件 = process.env.QQ_ASSET_FEATURES || '{{BOT_ROOT}}/记忆/功能开关.json'
let __家具开 = false
try { __家具开 = JSON.parse((await import("node:fs")).readFileSync(__开关文件, "utf8")).家具 === true } catch (_err) { console.error('[资产]', _err?.message || _err) }
const __要改家底 = ["--买", "--摆"].some((k) => args.includes(k))
if (__要改家底 && !__家具开) {
  console.log("家具系统这会儿是停着的，先不动家底。")
  process.exit(0)
}
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)

// 商店：家具与杂物（价格都是她几趟工能攒出来的量级）
// SHOP_MERGE 2026-11-03：价格与舒适度统一读 家具表.json，别再各写一份
// SHOP_MERGE_PATH_FIX 2026-11-03：这个脚本没有 tools 变量，用绝对路径
const 家具表 = (() => { try { return JSON.parse(readFileSync('{{BOT_ROOT}}/共享/工具/家具表.json', 'utf8')) } catch { return {} } })()
// OUTFIT_ORDER_FIX 2026-11-03：服装表必须定义在 SHOP 之前，否则引用时会 TDZ 报错
const 服装表 = (() => { try { return JSON.parse(readFileSync('{{BOT_ROOT}}/共享/工具/服装表.json', 'utf8')) } catch { return {} } })()
const SHOP = Object.assign({}, 家具表, 服装表) // OUTFIT_SYS：衣服也能用 --买

// P0 2026-11-16：资产 CLI 全流程持锁，避免结息/买东西/移动互相覆盖。
// --打工 只 spawn 工作.mjs，子进程自己会锁资产；父进程不能先抢，否则父子互等。
const __资产只读 = args.includes('--看看') || args.includes('--商店') || args.includes('--服装') || args.includes('--打工')
const __放资产锁 = __资产只读 ? () => {} : 加锁('资产.json', { strict: true, waitMs: 5000 })
process.on('exit', __放资产锁)

const a = load(moneyP, { 钱: 30, 包: [], 家: [], 记录: [], 位置: '家' })
a.包 = a.包 || []; a.家 = a.家 || []; a.记录 = a.记录 || []; a.位置 = a.位置 || '家'
a.着装 = a.着装 || { 上: '睡衣', 下: '家居短裤', 鞋: '小皮鞋', 饰: [] }

const bj = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const note = (s) => { a.记录 = [...a.记录, { at: bj, what: s }].slice(-100) }

// CREDIT 2026-11-05：现金不够时可以欠着——小额走花呗、大额走贷款，按日计息
if (!a.信贷) a.信贷 = { 花呗: { 额度: 500, 已用: 0, 日息: 0.0005 }, 贷款: { 额度: 3000, 已用: 0, 日息: 0.0008 }, 上次结息: "" }
const 欠款 = () => Math.round((Number(a.信贷.花呗.已用 || 0) + Number(a.信贷.贷款.已用 || 0)) * 100) / 100
function 结息(force) {
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  if (!force && a.信贷.上次结息 === today) return 0
  let add = 0
  for (const k of ["花呗", "贷款"]) {
    const c = a.信贷[k]
    const i = Number(c.已用 || 0) * Number(c.日息 || 0)
    if (i > 0) { c.已用 = Math.round((Number(c.已用) + i) * 100) / 100; add += i }
  }
  a.信贷.上次结息 = today
  return Math.round(add * 100) / 100
}
function 还款(amount) {
  结息(false)
  let left = Math.max(0, Math.round(amount * 100) / 100)
  const paid0 = left
  for (const k of ["花呗", "贷款"]) {
    const c = a.信贷[k]
    const pay = Math.min(left, Number(c.已用 || 0))
    if (pay > 0) { c.已用 = Math.round((Number(c.已用) - pay) * 100) / 100; left = Math.round((left - pay) * 100) / 100 }
  }
  return Math.round((paid0 - left) * 100) / 100
}

if (args.includes('--看看')) {
  console.log(`现在在：${a.位置}`)
  console.log(`钱：${a.钱}`)
  if (欠款() > 0) console.log(`欠着：花呗 ${a.信贷.花呗.已用}、贷款 ${a.信贷.贷款.已用}，共 ${欠款()}`)
  console.log(`包里：${a.包.length ? a.包.join('、') : '空的'}`)
  console.log(`家里：${a.家.length ? a.家.join('、') : '还什么都没有'}`)
  const comfort = a.家.reduce((s, n) => s + Number((SHOP[n] || {}).舒适 || 0), 0)
  console.log(`家的舒服程度：${comfort}`)
  process.exit(0)
}

if (args.includes('--商店')) {
  for (const [n, v] of Object.entries(SHOP)) console.log(`${n.padEnd(4)} ${String(v.价).padStart(4)} 块   舒服 +${v.舒适}`)
  process.exit(0)
}

if (args.includes('--去')) {
  // MOVE_SINGLE 2026-11-07（批次166）：这是「瞬移」接口（不花时间）。原来只改 资产.位置，
  // 在途/到此At/记录/自主.json 一样都不动 —— 面板没接这个按钮（零调用方），
  // 但只要有人用就会造出「人到了、自主记着老地方」。现在走 移动.瞬移()：
  // 到、记一笔、清在途、同步自主，跟 走路.mjs 同一套账。
  // 地点名单也不再手写那 4 个（地图 19 个，写死的那份早过期了）。
  const where = String(val('--去', '')).trim()
  const SPOTS = Object.keys(读图().地点 || {})
  if (!SPOTS.includes(where)) { console.log('没这个地方：' + where + '（有：' + SPOTS.join('、') + '）'); process.exit(0) }
  const r = 瞬移(base, where)
  if (!r) { console.log('本来就在' + where); process.exit(0) }
  console.log(`从${r.从}走到了${r.到}`)
  process.exit(0)
}

if (args.includes('--打工')) {
  // WORK_SHIFT 2026-11-06（批次145）：不再「点一下就来钱」。
  //
  // 这条老路原来干三件事：把人瞬移到「打工点」、随机给 9~72 块、掉一点体力。
  // 跟时长无关、跟有没有班无关、跟她到底去没去店里无关 —— 面板点十下就是十份工钱。
  // 主人说的「每隔一个小时加一次钱」，入口一共有三个（缺口抽签 / 花钱.mjs --打工 / 这里），
  // 112c 只堵了中间那个，这条一直还在。
  //
  // 现在它只做一件事：把「打卡」交给 工作.mjs。有班就打卡（到点自动结算），
  // 没班就说没班 —— 钱一分都不从这里出。
  let 说 = ''
  try {
    说 = String(execFileSync(process.execPath, [join(process.env.QQ_WORK_TOOLS || '{{BOT_ROOT}}/共享/工具', '工作.mjs'), '--打卡'], {
      encoding: 'utf8', timeout: 20e3,
    }) || '').trim()
  } catch (e) { 说 = '（打卡没成功：' + String(e.message).slice(0, 40) + '）' }
  // 没打上卡（没到点 / 人不在班上）时把今天的班报出来 —— 面板这个按钮原来只会
  // 给一句「没什么可打卡的」，她点完也不知道自己几点该在哪儿。
  if (!说 || /没什么可打卡/.test(说)) {
    try {
      const 班表 = String(execFileSync(process.execPath, [join(process.env.QQ_WORK_TOOLS || '{{BOT_ROOT}}/共享/工具', '工作.mjs'), '--班'], {
        encoding: 'utf8', timeout: 20e3,
      }) || '').trim()
      if (班表 && !/今天没班/.test(班表)) 说 = '现在没到打卡的时候。今天的班：' + 班表.split(String.fromCharCode(10)).join('；')
    } catch { /* 班表读不到就用下面那句 */ }
  }
  console.log(说 || '这会儿没有要打卡的班 —— 上班按班次来，钱等下班结')
  process.exit(0)
}

if (args.includes('--逛')) {
  if (a.位置 !== '街市') {
    console.log('人不在街市，先过去')
    a.位置 = '街市'; note('走到街市'); save(moneyP, a)
  }
  const events = [
    { t: '在路边捡到一个水杯', give: '水杯' },
    { t: '看见猫在晒太阳，站了一会儿', mood: 0.4 },
    { t: '碰到有人在卖剩下的台灯，便宜收了', give: '台灯' },
    { t: '走累了，在台阶上坐了半小时', mood: 0.2, energy: -3 },
    { t: '什么也没碰上，风挺大', mood: 0 },
    { t: '看到一只很胖的团子贴纸，没忍住买了两张', money: -6, mood: 0.5 },
  ]
  const e = events[Math.floor(Math.random() * events.length)]
  if (e.give) a.包.push(e.give)
  if (e.money) a.钱 = Math.max(0, a.钱 + e.money)
  if (e.mood || e.energy) {
    const st = load(stP, {})
    const __st快照 = clone(st)   // 批次173：saveState 的差量基准
    st.mood = st.mood || {}
    st.mood.intensity = Math.max(-2, Math.min(2, Number((Number(st.mood.intensity || 0) + (e.mood || 0)).toFixed(2))))
    if (e.energy) {
      st.layers = st.layers || {}
      st.layers.physical = Math.max(0, Number(st.layers.physical || 40) + e.energy)
      // 批次173：原来是「体力 + 情绪 两数平均」。批次171 收了 作息/奖惩/状态推进/困意/洗澡
      // 五处，漏了这一处 —— 因为契约检查只扫 `Math.pow(...,0.6)` 那种木桶写法，抓不到平均。
      // 实测她 physical 17.1 / cognitive 26.8 / emotional 49.5：平均 33、木桶 21，差 12 点。
      // 逛一圈加了一点体力，面板跳到 33，15 分钟后 状态推进 重算成 21 —— 白掉 12 点。
      st.energy = 精力(st.layers)
    }
    saveState(stP, st, __st快照)   // 批次173：走 _状态（锁 + 只合并改过的键 + 原子写）
  }
  note('逛街：' + e.t)
  save(moneyP, a)
  console.log('逛了一圈：' + e.t + (e.give ? `（包里多了${e.give}）` : ''))
  记活动('逛街', e.t || '')
  process.exit(0)
}

// CREDIT_CMD 2026-11-05：借钱、还款、看欠款
const 借款额 = Number(val('--借', '0')) || 0
if (args.includes('--借') && 借款额 > 0) {
  const 余 = Math.round((a.信贷.贷款.额度 - a.信贷.贷款.已用) * 100) / 100
  if (余 <= 0) { console.log(`贷款额度用完了（已欠 ${欠款()}）`); process.exit(0) }
  const 到 = Math.min(借款额, 余)
  a.信贷.贷款.已用 = Math.round((a.信贷.贷款.已用 + 到) * 100) / 100
  a.钱 = Math.round((a.钱 + 到) * 100) / 100
  note(`借了 ${到} 块贷款`)
  save(moneyP, a)
  console.log(`借到 ${到} 块，日息 0.08%，共欠 ${欠款()}；现在现金 ${a.钱}`)
  process.exit(0)
}
const 还额 = Number(val('--还', '0')) || 0
if (args.includes('--还') && 还额 > 0) {
  const 真还 = Math.min(还额, a.钱)
  const 已还 = 还款(真还)
  a.钱 = Math.round((a.钱 - 已还) * 100) / 100
  note(`还了 ${已还} 块`)
  save(moneyP, a)
  console.log(`还了 ${已还}，还欠 ${欠款()}，现金 ${a.钱}`)
  process.exit(0)
}
if (args.includes('--结息')) {
  // CREDIT_DAILY 2026-11-08（批次225）：日息要天天结。原来只在 借/还/查信用 时才跑，
  // 不借就永远不涨 —— 等于借了白借。心跳表每小时叫一次，同一天只结一次。
  const 息 = 结息(false)
  if (息 > 0) note(`结息 ${息} 块`)
  save(moneyP, a)
  console.log(息 > 0 ? `结息 ${息} 块，欠款 ${欠款()} 块` : `今天已经结过，欠款 ${欠款()} 块`)
  process.exit(0)
}

if (args.includes('--信用')) {
  const 息 = 结息(true)
  save(moneyP, a)
  console.log(`花呗 ${a.信贷.花呗.已用}/${a.信贷.花呗.额度}（日息 0.05%）`)
  console.log(`贷款 ${a.信贷.贷款.已用}/${a.信贷.贷款.额度}（日息 0.08%）`)
  console.log(`共欠 ${欠款()}，今天利息 ${息}`)
  process.exit(0)
}

// SPEND 2026-11-05：她得能自己掏钱（看电影、吃饭、买票），不然只能嘴上说要付、钱一分没动
const 花额 = Number(val('--花', '0')) || 0
if (args.includes('--花') && 花额 > 0) {
  const 因 = val('--为什么', '')
  const 花 = Math.round(花额 * 100) / 100
  if (a.钱 >= 花) {
    a.钱 = Math.round((a.钱 - 花) * 100) / 100
    note(`花了 ${花} 块` + (因 ? `（${因}）` : ''))
    save(moneyP, a)
    console.log(`花了 ${花} 块` + (因 ? `（${因}）` : '') + `，还剩 ${a.钱}`)
  } else {
    const 缺 = Math.round((花 - a.钱) * 100) / 100
    const 余 = Math.round((a.信贷.花呗.额度 - a.信贷.花呗.已用 + a.信贷.贷款.额度 - a.信贷.贷款.已用) * 100) / 100
    if (缺 > 余) { console.log(`钱不够：要 ${花}，现金 ${a.钱}，额度只剩 ${余}`); process.exit(0) }
    const 用花呗 = Math.min(缺, Math.round((a.信贷.花呗.额度 - a.信贷.花呗.已用) * 100) / 100)
    a.信贷.花呗.已用 = Math.round((a.信贷.花呗.已用 + 用花呗) * 100) / 100
    a.信贷.贷款.已用 = Math.round((a.信贷.贷款.已用 + (缺 - 用花呗)) * 100) / 100
    a.钱 = 0
    note(`花了 ${花} 块` + (因 ? `（${因}）` : '') + `，差 ${缺} 走了借款`)
    save(moneyP, a)
    console.log(`花了 ${花} 块` + (因 ? `（${因}）` : '') + `，现金不够，欠了 ${缺}（共欠 ${欠款()}）`)
  }
  process.exit(0)
}

// CREDIT_AUTOSETTLE 2026-11-05// CREDIT_AUTOSETTLE 2026-11-05：任何命令跑一次都先按天结一次息，她不动手也不会白欠
const 今日息 = 结息(false)
if (今日息 > 0) { save(moneyP, a) }
const buy = val('--买', '')
if (buy) {
  if (a.位置 !== '商店') {
    console.log('人不在商店，先过去')
    a.位置 = '商店'; note('走到商店'); save(moneyP, a)
  }
  const it = SHOP[buy]
  if (!it) { console.log('店里没有「' + buy + '」'); process.exit(0) }
  if (a.钱 < it.价) {
    const 缺 = Math.round((it.价 - a.钱) * 100) / 100
    const 花呗余 = Math.round((a.信贷.花呗.额度 - a.信贷.花呗.已用) * 100) / 100
    const 贷款余 = Math.round((a.信贷.贷款.额度 - a.信贷.贷款.已用) * 100) / 100
    if (缺 <= 花呗余) {
      a.信贷.花呗.已用 = Math.round((a.信贷.花呗.已用 + 缺) * 100) / 100
      console.log(`钱不够，欠了花呗 ${缺} 块（共欠 ${欠款()}）`)
    } else if (缺 - 花呗余 <= 贷款余) {
      const 用花呗 = Math.max(0, 花呗余)
      a.信贷.花呗.已用 = Math.round((a.信贷.花呗.已用 + 用花呗) * 100) / 100
      a.信贷.贷款.已用 = Math.round((a.信贷.贷款.已用 + (缺 - 用花呗)) * 100) / 100
      console.log(`花呗不够，又借了贷款（共欠 ${欠款()}）`)
    } else {
      console.log(`钱不够、额度也刷完了：要 ${it.价}，现金 ${a.钱}，已欠 ${欠款()}`)
      process.exit(0)
    }
  }
  a.钱 = Math.max(0, Math.round((a.钱 - it.价) * 100) / 100)
  // BAG_ROUTE 2026-11-05：买完不再一律塞包里——衣服进衣柜、家具进「等摆放」、其余才进包。
  // 之前台灯、裙子、发卡全堆在包里，主人问「为什么这东西会在包里」。
  const 类别 = String((家具表[buy] || {}).类别 || '')
  const 是衣服 = /衣|裙|鞋|帽|饰|袜|配饰/.test(buy) || 类别 === '服装'
  if (是衣服) {
    a.衣柜 = Array.isArray(a.衣柜) ? a.衣柜 : []
    if (!a.衣柜.includes(buy)) a.衣柜.push(buy)
    note(`买了 ${buy}（-${it.价}，进衣柜）`)
    save(moneyP, a)
    console.log(`买了${buy}，剩 ${a.钱} 块。放进衣柜了`)
  } else {
    a.包.push(buy)
    note(`买了 ${buy}（-${it.价}）`)
    save(moneyP, a)
    console.log(`买了${buy}，剩 ${a.钱} 块。在包里`)
  }
  记活动('买东西', buy) // ACTIVITY_SYNC_BUY
  process.exit(0)
}

const put = val('--摆', '')
if (put) {
  const i = a.包.indexOf(put)
  if (i < 0) { console.log(`包里没有「${put}」`); process.exit(0) }
  a.包.splice(i, 1)
  a.家.push(put)
  note(`把 ${put} 摆进家`)
  save(moneyP, a)
  const comfort = a.家.reduce((s, n) => s + Number((SHOP[n] || {}).舒适 || 0), 0)
  console.log(`把${put}摆好了。家里现在 ${a.家.length} 件，舒服 ${comfort}`)
  记活动('摆家具', put)
  process.exit(0)
}

// OUTFIT_SYS：--服装 看看身上穿的、--穿 换一件、--脱 摘掉配饰
const showWear = args.includes('--服装')
if (showWear) {
  const w = a.着装 || {}
  const acc = (w.饰 || []).join('、') || '没有'
  console.log('上身：' + (w.上 || '无') + '｜下身：' + (w.下 || '无') + '｜鞋：' + (w.鞋 || '无') + '｜配饰：' + acc)
  process.exit(0)
}
const wear = val('--穿', '')
if (wear) {
  // WARDROBE 2026-11-05：衣服放在「衣柜」里，不再要求它在包里（包里只放随身物）
  const it = 服装表[wear] || {}
  const cat = it.类别 || '上'
  let 旧的 = ''
  const 更新 = 改档(moneyP, (fresh) => {
    fresh.衣柜 = Array.isArray(fresh.衣柜) ? fresh.衣柜 : []
    if (!fresh.衣柜.includes(wear) && !(fresh.包 || []).includes(wear)) return false
    fresh.着装 = fresh.着装 && typeof fresh.着装 === 'object' ? fresh.着装 : { 上: '', 下: '', 鞋: '', 饰: [] }
    if (cat === '饰') { fresh.着装.饰 = Array.from(new Set([...(fresh.着装.饰 || []), wear])) }
    else {
      // 换下来的那件回到衣柜，别凭空消失
      旧的 = fresh.着装[cat]
      if (旧的 && 旧的 !== wear && !fresh.衣柜.includes(旧的)) fresh.衣柜.push(旧的)
      fresh.着装[cat] = wear
    }
    fresh.记录 = [...(Array.isArray(fresh.记录) ? fresh.记录 : []), { at: bj, what: '换上 ' + wear }].slice(-100)
    return fresh
  }, {})
  if (!更新) { console.log('衣柜里没有「' + wear + '」'); process.exit(0) }
  try {
    const clothing = await import(join(process.env.QQ_WORK_TOOLS || '{{BOT_ROOT}}/共享/工具', '穿衣.mjs'))
    if (旧的 && 旧的 !== wear && String(it.类别 || '上') !== '饰') clothing.脱(旧的)
    clothing.穿(wear)
  } catch (e) { console.log('（穿着账没同步：' + String(e.message).slice(0, 50) + '）') }
  console.log('换上了' + wear)
  process.exit(0)
}
const off = val('--脱', '')
if (off) {
  改档(moneyP, (fresh) => {
    fresh.着装 = fresh.着装 && typeof fresh.着装 === 'object' ? fresh.着装 : { 饰: [] }
    fresh.着装.饰 = (fresh.着装.饰 || []).filter((x) => x !== off)
    return fresh
  }, {})
  try {
    const clothing = await import(join(process.env.QQ_WORK_TOOLS || '{{BOT_ROOT}}/共享/工具', '穿衣.mjs'))
    clothing.脱(off)
  } catch (e) { console.log('（穿着账没同步：' + String(e.message).slice(0, 50) + '）') }
  console.log('摘掉了' + off)
  process.exit(0)
}
console.log('用法：--看看 / --商店 / --打工 / --逛 / --买 东西 / --摆 东西')
