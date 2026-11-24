// 花钱.mjs —— 她的日常消费与打工：扣钱、生效、记一笔
// 用法：
//   node 花钱.mjs --看                      # 看有什么、多少钱
//   node 花钱.mjs --买 咖啡                  # 买一件（钱不够会拒绝）
//   node 花钱.mjs --打工 家教                # 干一份活，按小时给钱、掉体力
//   node 花钱.mjs --生效 火锅                # 只上效果不扣钱（吃饭.mjs 吃完结算时调）
// 为什么这么写：价格和效果都放 商店-生活.json，脚本只负责执行和记账，
// 以后调价、加东西不用改代码。激素事件交给 激素.mjs，避免两处各写一份。
import { 吃喝动词 } from './在干嘛.mjs'
import { 写档 } from './_底层.mjs'
import { 加锁 } from './_锁.mjs'
import { saveState, clone } from './_状态.mjs'
import fs from "node:fs"
import path from "node:path"
import { execFileSync } from "node:child_process"
// HUNGER 2026-11-06（批次139）：买完要记到饱腹上。
// 在这之前，「吃了」只写困意和心情，肚子这条线根本不存在。
import * as 饥饿 from "./饥饿.mjs"
import { mealStarted } from './自主判据.mjs'
// OPEN_GUARD 2026-11-13（批次374）：买东西要看店开没开。营业时间以前只在
// 「选去哪」（走路.mjs / 缺口.mjs）判过，卖东西这一步完全没看 ——
// 实测 22:06 走到咖啡店（22:00 关门），00:28 还在店里买到了小蛋糕。
import { 读档 as 读地点档, 营业中 } from './地点.mjs'

const DIR = "{{BOT_ROOT}}"
// SANDBOX 2026-11-05 批次65：自主行动的沙盒变量必须穿透到子脚本。
// 原来这里硬编码真路径 —— 在沙盒里跑一次「试吃东西」，真账本被扣了钱、
// 还多了一条消费记录（实测 100 → 94）。测一次脏一次，比不测更糟。
const MEM = process.env.QQ_AUTONOMY_MEM || path.join(DIR, "记忆")
const TOOLS = path.join(DIR, "共享/工具")
const SHOP = path.join(TOOLS, "商店-生活.json")
const ASSET = path.join(MEM, "资产.json")
const STATE = path.join(MEM, "状态.json")

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
const save = (p, o) => 写档(p, o)
const bjNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ")
const args = process.argv.slice(2)
const val = (k, d = "") => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] ?? d) : d }

const shop = load(SHOP, { 商品: {}, 打工: {} })
// MERGE_CLOTHES 2026-11-07（批次153）：主人原话「重复数据用最新的 旧的归档」。
// 衣服已经分到 记忆/衣物表.json（34 件，带标签/覆盖/袖长），商店表里那 30 件是旧副本。
// 这里把衣物表并进来，新表字段优先；商店表只留「买件衣服」这种泛称。
// 读不到就退回商店表原样 —— 买衣服不能因为分表没读上就整个断掉。
try {
  const 衣 = JSON.parse(fs.readFileSync(path.join(MEM, "衣物表.json"), "utf8")).件 || {}
  for (const [n, v] of Object.entries(衣)) {
    const 旧 = shop.商品[n] || {}
    const 售价 = Number((v.穿 && v.穿.价) || v.价 || 0) || Number(旧.价) || 0
    shop.商品[n] = {
      ...旧,
      ...v,
      价: 售价,
      类别: "穿",
      售卖点: Array.isArray(v.售卖点) ? v.售卖点
        : (Array.isArray(旧.售卖点) ? 旧.售卖点 : ["街市", "超市"]),
    }
  }
} catch { /* 没有衣物表就按原来的商店表来 */ }
// P0 2026-11-16：--买 整段持资产锁；spawn 物品.mjs 时用 env 让它别再抢同一把锁。
const __要买 = args.includes('--买')
const __放资产锁 = __要买 ? 加锁('资产.json', { strict: true, waitMs: 5000 }) : () => {}
process.on('exit', __放资产锁)
if (__要买) process.env.QQ_ASSET_LOCK_HELD = '1'
const asset = load(ASSET, { 钱: 0, 包: [], 家: [], 记录: [], 位置: "家" })
const state = load(STATE, {})
const __stateSnap = clone(state)
asset.记录 = Array.isArray(asset.记录) ? asset.记录 : []

function 记一笔(what, id = '') {
  asset.记录.push({ at: bjNow(), what, ...(id ? { id } : {}) })
  if (asset.记录.length > 200) asset.记录 = asset.记录.slice(-200)
}

// 送法 2026-11-07（批次219c，主人要求）：家不是店，能送的三条路得说清楚 ——
//   · 外卖：餐厅/街市/咖啡店 的饭和喝的，店家自己送，不加钱；
//   · 跑腿：便利店/超市的干货（泡面、饼干、洗发水…），按「件数 + 往返距离」加跑腿费；
//   · 快递：隔天到，便宜，东西先记在 包裹.json，到点由 快递.mjs --tick 送进家。
function 最近单程分钟(售卖点) {
  try {
    const 地 = load(path.join(TOOLS, '地图.json'), {}).地点 || {}
    const 分 = 售卖点.map((s) => Number((地[s] || {}).t)).filter((n) => Number.isFinite(n))
    return 分.length ? Math.min(...分) : 10
  } catch { return 10 }
}
// FEE_CAL 2026-11-07（批次220，主人原话「正常 30 分钟路程骑手有电动车也就 5 块差不多，
// 外卖按距离最多不超过跑腿」）：原来按往返分钟×0.4 算，30 分钟单程要 20 多，太离谱。
// 现在按单程分钟走电动车速度：2 + 0.1×单程（30 分钟 = 5 块），起价 4，多一件加 1 块。
const 跑腿费 = (售卖点, 件数 = 1) => {
  const 单程 = 最近单程分钟(售卖点)
  return Math.max(4, Math.round(2 + 0.1 * 单程)) + Math.max(0, Number(件数 || 1) - 1)
}
// 快递比跑腿便宜：隔天、凑单、不着急
const 快递费 = (件数 = 1) => Math.max(3, 2 + Number(件数 || 1))

// SLEEPY_LEDGER 2026-11-06（批次104）：困意的单一真源是 困意.mjs（每次从头现算），
// 直接 `state.困意 += x` 会被下一次 状态推进 抹掉（实测一顿饭的 -6 活不过 15 分钟）。
// 所以这里记一条带时间的账，由 困意.mjs 按 半衰（指数衰减）或 峰/峰位（饭后曲线）折算。
// 同一件东西只留最新一条：再喝一杯同款咖啡是替换上一杯，不是叠两杯；
// 换了一样（咖啡→可乐、一顿饭→火锅）就各算各的，叠着来才是真的。
function 记困意账(kind, entry) {
  const 账 = Array.isArray(state.困意账) ? state.困意账 : (state.困意账 = [])
  const nowMs = Date.now()
  const 谁 = String(entry && entry.啥 || '')
  for (let i = 账.length - 1; i >= 0; i -= 1) {
    const e = 账[i] || {}
    if (nowMs - (Number(e.at) || 0) > 8 * 3600e3 || (String(e.kind) === kind && String(e.啥 || '') === 谁)) 账.splice(i, 1)
  }
  if (账.length >= 8) 账.splice(0, 账.length - 7)
  账.push({ kind, at: nowMs, ...entry })
}

function 记激素(kind, id) {
  if (!kind) return
  const eventId = String(id || ('spend:' + Date.now() + ':' + process.pid))
  try { execFileSync(process.execPath, [path.join(TOOLS, "激素.mjs"), "--event", kind, "--id", eventId], { encoding: "utf8" }) }
  catch (e) { console.log("（激素没记上：' + e.message + '）") }
}

// EFFECT_ONE 2026-11-06（批次144）：吃进去之后身体怎么变，全项目只有这一份。
//
// 批次144 之前「买」和「吃」是同一秒发生的，所以效果挂在买单那一刻。
// 现在拆成两段（能买回家存着、饭店坐下来吃完再走），效果就得跟着「真吃进嘴」走。
// 规则写两处必然分叉（咖啡半衰 240 分钟这条改过一次），所以抽成一个函数：
//   · 花钱.mjs --买     → 非吃喝（玩/放松/穿）当场调它
//   · 花钱.mjs --生效   → 吃饭.mjs 结算时回来调它
function 上效果(it, buy, __k = 1, eventId = '') {
  const eff = (it && it.效果) || {}
  if (eff.困意) {
    // SLEEPY_ONE_WRITE 2026-11-24：这里原来还多写一句
    //   state.困意 = clamp(state.困意 + eff.困意)
    // 但下面注释自己就写着「直接 state.困意 += x 会被下一次 状态推进 抹掉」——
    // 而 困意.mjs 每次都会用现算值覆盖这个字段，那句赋值是纯装饰，
    // 只会让「本分钟面板」和「15 分钟后的真实值」不一致。真正生效的是 记困意账。
    // 半衰看这是什么：咖啡因撑得久，糖一小时，普通吃喝 45 分钟
    // 注意 激素 挂在 效果 里（不是商品上），读 it.激素 永远是 undefined
    const __hj = String(eff.激素 || '')
    const 半衰 = __hj === '喝咖啡' ? 240 : __hj === '吃糖' ? 60 : 45
    记困意账('提神', { 值: Number(eff.困意), 半衰, 啥: buy })
    // POSTPRANDIAL 2026-11-06（批次104）：食困（餐后警觉性下降）。
    // 生理链是血糖升 → 胰岛素 → 色氨酸进脑 → 血清素/褪黑素，加上副交感接手「休息消化」。
    // 它不是常数：轻度（一小块点心、几口甜的）20~40 分钟就退，一顿大餐 1~2 小时才落，
    // 所以「持续」跟着份量走 —— 小吃 40 分钟、普通一餐 90 分钟、大餐 120 分钟。
    // 高糖的喝的（奶茶/可乐/果汁）同样走血糖，按「几口甜的」算，给一条轻的。
    const __吃 = String(it.类别 || '') === '吃'
    const __甜 = __hj === '吃糖'
    // DROWSY_SWITCH 2026-11-24：原注释说「先留一个总闸，新账上线后挂 0 就整条熄火」，
    // 但全仓 grep 不到任何一处设 DROWSY_AFTER_MEAL=0 —— 这个闸从来没关上过，属于死开关。
    // 现在做成真能关：默认开（保持现行为）。
    // 开关位置：环境变量 DROWSY_AFTER_MEAL=0，或 参数.json 里显式加 {"开关":{"食困":false}}。
    // 注意：参数.json 现在**没有** 开关 段（2026-11-24 实测确认）—— 不写就一直默认开，
    // 想关的时候才加，别以为它已经在生效。
    let __食困开 = String(process.env.DROWSY_AFTER_MEAL ?? '1') !== '0'
    if (__食困开) {
      try {
        const __pj = JSON.parse(fs.readFileSync(path.join(TOOLS, '参数.json'), 'utf8'))
        if (__pj && __pj['开关'] && __pj['开关']['食困'] === false) __食困开 = false
      } catch { /* 参数表读不到就保持默认开 */ }
    }
    if ((__吃 || __甜) && __食困开) {
      const __价 = Number(it.价 || 0)
      // SUGAR_DROWSY 2026-11-17（批次 682）：糖原来走「2 + 价/12」算峰值，
      // 6 块钱的糖峰 2.5，正好把 -2 的提神盖过去 —— 越吃糖越困，和直觉相反。
      // 糖的食困只留 1 点（一小块点心本来就该是轻的），提神 -2 仍然占上风。
      const 峰 = __甜 ? 1 : Math.round(Math.min(12, Math.max(2, 2 + __价 / 10)) * __k * 10) / 10
      const 持续 = __甜 ? 40 : (__价 <= 12 ? 40 : __价 <= 40 ? 90 : 120)
      if (峰 > 0) 记困意账('饭后', { 峰, 持续, 啥: buy })
    }
  } else if (String(it.类别 || '') === '喝' && Number(it.价 || 0) <= 3) {
    // 喝水不改变当下的困意值，但能让人清醒一点（也让食困退得利索）——给一条很浅的账
    记困意账('提神', { 值: -2, 半衰: 30, 啥: buy })
  }
  if (eff.情绪) {
    // MOOD_SCALE 2026-11-05：商品扩到 41 种以后，吃顿火锅不该把心情顶满；
    // 系数 /10 改 /25，并夹在 -3..3——吃一次是「抬一点」，不是逆天改命
    const m = state.mood || (state.mood = {})
    const next = Number(m.intensity || 0) + Number(eff.情绪) / 25
    m.intensity = Math.round(Math.max(-3, Math.min(3, next)) * 100) / 100
  }
  if (eff.激素) 记激素(eff.激素, eventId)
}

if (args.includes("--看") || args.length === 0) {
  console.log(`现在有 ${asset.钱} 块`)
  for (const [name, it] of Object.entries(shop.商品)) {
    console.log(`  ${name}  ${it.价} 块  ${it.说明 || ""}`)
  }
  console.log("打工：")
  for (const [name, it] of Object.entries(shop.打工)) {
    console.log(`  ${name}  ${it.时长小时} 小时 ${it.收入} 块  ${it.说明 || ""}`)
  }
  process.exit(0)
}

// EAT_BACK 2026-11-06（批次144）：吃饭.mjs 结算时回来调这一条。
// 只上效果，不扣钱、不动饱腹（饱腹归 饥饿.mjs，钱在买的时候已经扣了）。
const 生效名 = val("--生效", "")
if (生效名) {
  const it = shop.商品[生效名]
  if (!it) { console.log(`没有「${生效名}」这样东西`); process.exit(0) }
  上效果(it, 生效名, 1, val("--事件ID", 'meal:' + Date.now() + ':' + process.pid))
  saveState(STATE, state, __stateSnap)
  console.log(`记上了：${生效名}`)
  process.exit(0)
}

const buy = val("--买", "")
if (buy) {
  const it = shop.商品[buy]
  if (!it) {
    // BUY_MISS 2026-11-14（批次471）：她 4 次拿自由描述当商品名（「一碗牛肉面」「烤红薯」「一顿正经饭」），
    // 每次只回「没有这样东西」—— 她不知道有哪些名字，只能再猜一个，连着试三次。
    // 现在把**她当前地点能买到的名字**直接列出来，一次说完。
    const 场 = String(asset.位置 || '')
    const 可买 = Object.entries(shop.商品)
      .filter(([, v]) => Array.isArray(v && v.售卖点) && (!场 || v.售卖点.includes(场)))
      .map(([n]) => n)
    const 名单 = (可买.length ? 可买 : Object.keys(shop.商品)).slice(0, 14).join('、')
    console.log(`没有「${buy}」这样东西 —— 名字要照抄表里的，别自己组词。`
      + (可买.length
        ? `你现在在${场}，这儿能买：${名单}`
        : (场 ? `你现在在${场}，这儿不卖这些（要吃得先挪地方，或者走外卖）。` : '')
          + `表里有的：${名单}`))
    process.exit(0)
  }
  // CREDIT_PRECHECK 2026-11-07（批次221）：这道预检原来只认现金，钱不够就直接退出，
  // 后面那套「刷花呗/贷款」根本轮不到。现在把可用额度算进来；真不够才拒。
  const __可用额度 = (() => {
    try {
      const 信 = asset.信贷 || {}
      const 花 = 信.花呗 || {}, 贷 = 信.贷款 || {}
      return Math.max(0, Number(花.额度 || 0) - Number(花.已用 || 0)) + Math.max(0, Number(贷.额度 || 0) - Number(贷.已用 || 0))
    } catch { return 0 }
  })()
  if ((asset.钱 || 0) + __可用额度 < it.价) { console.log(`钱不够，额度也不够：${buy} 要 ${it.价}，现金 ${asset.钱}，还能借 ${Math.round(__可用额度 * 100) / 100}`); process.exit(0) }
  // SPOT_CHECK 2026-11-06（批次123）：加上「这儿买不买得到」。
  // 原来只查商品存不存在 —— 她在家能买到街市才有的「吃好吃的」，一天 9 顿有 6 顿买在错地方。
  // 售卖点在 商店-生活.json 里，数据早就齐了，只是没人读。
  // 拒绝时顺手报「这儿有哪几样同类的」，别只给一句买不到 —— 调用方（自主行动/缺口）
  // 是按状态随机挑的，看到替代品才有机会改主意。
  let 方式 = '到店'
  let 附加费 = 0
  try {
    const 售卖点 = Array.isArray(it.售卖点) ? it.售卖点.map(String) : []
    const 场 = String(asset.位置 || '')
    const 类 = String(it.类别 || '')
    const 熟食点 = 售卖点.some((s) => ['餐厅', '街市', '咖啡店'].includes(s))
    const 能送 = 场 === '家' && ['吃', '喝', '零食'].includes(类)
    if (售卖点.length && !售卖点.includes('任意') && !售卖点.includes(场)) {
      if (!能送) {
        const 替代 = Object.entries(shop.商品 || {})
          .filter(([名, v]) => 名 !== buy
            && String(v.类别 || '') === 类
            && (Array.isArray(v.售卖点) ? v.售卖点.map(String) : []).includes(场))
          .map(([名]) => 名).slice(0, 4)
        console.log(`这儿买不到「${buy}」—— 要到${售卖点.join('/')}。你现在在${场 || '不知道哪'}` +
          (替代.length ? `，这儿有：${替代.join('、')}` : ''))
        process.exit(0)
      }
      if (类 !== '零食' && 熟食点) {
        方式 = '外卖'
        // 外卖配送费：店家自己送，收一点跑腿的六成，封顶就是跑腿费（主人定的上限）
        附加费 = Math.min(跑腿费(售卖点, 1), Math.max(2, Math.round(跑腿费(售卖点, 1) * 0.6)))
      } else {
        // 干货（泡面/饼干/瓶装水）没有店家自己送：默认叫跑腿（快），想省钱用 --送 快递（隔天）
        方式 = String(val('--送', '')).trim() === '快递' ? '快递' : '跑腿'
        附加费 = 方式 === '跑腿' ? 跑腿费(售卖点, 1) : 快递费(1)
      }
    }
  } catch { /* 售卖点数据坏了就别拦着买 */ }
  // OPEN_GUARD 2026-11-13（批次374）：卖东西这一步以前根本不看营业时间。
  // 实测：22:06 走到咖啡店（07:00-22:00，已关门）→ 00:28 买到小蛋糕 →
  // 00:36 在店里吃。她自己还说「这会儿店都关了」，账上却真买了。
  // 按 方式 分别校验：到店看当前位置，外卖看售卖点（任一家开着就算能点），
  // 快递是隔天到、不该受营业时间限制。
  // 判不了就不拦：地图上没登记的地点、读不到营业数据，都放行 —— 宁可少拦一次，
  // 也别让她在有货的店里买不到东西。
  if (方式 === '到店' || 方式 === '外卖') {
    try {
      const 地点档 = 读地点档(MEM)
      const 售卖点 = Array.isArray(it.售卖点) ? it.售卖点.map(String) : []
      const 要开的 = (方式 === '到店' ? [String(asset.位置 || '')] : 售卖点)
        .filter((s) => s && s !== '任意')
      const 开着的 = 要开的.filter((s) => {
        try {
          const 营 = 营业中(s, 地点档)
          if (营.因 === '地图上没有这个地方') return true   // 不认识的地方不拦
          return 营.ok
        } catch { return true }
      })
      if (要开的.length && !开着的.length) {
        const 类 = String(it.类别 || '')
        const 替代 = Object.entries(shop.商品 || {})
          .filter(([名, v]) => 名 !== buy
            && String(v.类别 || '') === 类
            && (Array.isArray(v.售卖点) ? v.售卖点 : []).some((s) => {
              try {
                const 营 = 营业中(String(s), 地点档)
                return 营.因 === '地图上没有这个地方' ? true : 营.ok
              } catch { return false }
            }))
          .map(([名]) => 名).slice(0, 3)
        console.log(`${要开的.join('/')}这个点关门了，买不到「${buy}」。` +
          (替代.length ? `现在还能买到：${替代.join('、')}` : '这会儿只有便利店还开着。'))
        process.exit(0)
      }
    } catch { /* 营业数据读不到就别拦着买 */ }
  }
  const __eventId = 'purchase:' + bjNow().slice(0, 16) + ':' + buy + ':' + String(it.价) + ':' + String(方式)
  // CREDIT 2026-11-07（批次221）：钱不够先刷花呗、再贷款；两级额度都不够才拒绝。
  // 额度/日息在 资产.json（花呗 500、贷款 3000），这里只负责「花」和留痕。
  // EAT_GUARD 2026-11-09（批次304）：点外卖/堂食前先问 吃饭.mjs 在不在吃。
  // 原来 execFileSync 不读 stdout，吃饭.mjs 打印「还在吃…」后正常退出，
  // 花钱.mjs 以为成功 —— 23:38–00:08 连点 4 单烧烤，3 单白扣钱、饱腹一点没加。
  if (['吃', '喝', '零食'].includes(String(it.类别 || '')) && String(it.吃法 || '') === '堂食') {
    try {
      const 看 = execFileSync(process.execPath, [path.join(TOOLS, '吃饭.mjs'), '--看'],
        { encoding: 'utf8', timeout: 5000, env: { ...process.env, NODE_OPTIONS: '' } }).trim()
      if (/正在/.test(看)) { console.log('还在吃，这单先不点（' + 看.split('\n')[0] + '）'); process.exit(0) }
    } catch { /* 看不了就不拦 */ }
    try {
      const 记 = load(path.join(MEM, '饥饿.json'), {})
      const 今 = 记.今天 && 记.今天.日期 === bjNow().slice(0, 10) ? 记.今天 : { 顿: 0 }
      if (Number(今.顿 || 0) >= 4) { console.log('今天三顿吃过了，这顿先不点'); process.exit(0) }
      const 上 = Date.parse(String(记.最后吃At || '').replace(' ', 'T') + '+08:00') || 0
      if (上 && Date.now() - 上 < 90 * 60e3) { console.log('两小时前才吃过，这顿先不点'); process.exit(0) }
    } catch { /* 记账读不到就不拦 */ }
    // 同类冷却：今天同一样买到第 3 次直接拒。原来只有效果衰减（0.8^n），钱照扣。
    try {
      // 滚动 24 小时，不按自然日 —— 23:38/23:48/23:58/00:08 这四单跨了零点，
      // 按自然日只数到 1 单，冷却等于没加。
      const 今0 = Date.now()
      const 次 = (asset.记录 || []).filter((r) => {
        const t = Date.parse(String(r.at || '').replace(' ', 'T') + '+08:00') || 0
        return t > 0 && 今0 - t < 24 * 3600e3 && String(r.what || '').includes(buy + '（')
      }).length
      if (次 >= 2) { console.log('今天已经买过 ' + 次 + ' 次「' + buy + '」了，换一样吧'); process.exit(0) }
    } catch { /* 记录读不到就不拦 */ }
  }
  let 借款话 = ''
  const 总价 = Math.round((it.价 + 附加费) * 100) / 100
  if ((asset.钱 || 0) < 总价) {
    const 差 = Math.round((总价 - (asset.钱 || 0)) * 100) / 100
    if (!asset.信贷) asset.信贷 = { 花呗: { 额度: 500, 已用: 0, 日息: 0.0005 }, 贷款: { 额度: 3000, 已用: 0, 日息: 0.0008 }, 上次结息: '' }
    const 花 = asset.信贷.花呗, 贷 = asset.信贷.贷款
    const 花剩 = Math.max(0, Math.round((Number(花.额度) - Number(花.已用)) * 100) / 100)
    const 贷剩 = Math.max(0, Math.round((Number(贷.额度) - Number(贷.已用)) * 100) / 100)
    if (差 > 花剩 + 贷剩) {
      console.log(`钱不够，花呗+贷款也不够：要 ${总价}，现金 ${asset.钱}，还能借 ${Math.round((花剩 + 贷剩) * 100) / 100}`)
      process.exit(0)
    }
    const 用花 = Math.min(差, 花剩)
    const 用贷 = Math.round((差 - 用花) * 100) / 100
    if (用花 > 0) { 花.已用 = Math.round((Number(花.已用) + 用花) * 100) / 100; 借款话 += `刷花呗 ${用花}` }
    if (用贷 > 0) { 贷.已用 = Math.round((Number(贷.已用) + 用贷) * 100) / 100; 借款话 += (借款话 ? '、' : '') + `贷款 ${用贷}` }
    asset.钱 = Math.round((Number(asset.钱 || 0) + 差) * 100) / 100
  }
  asset.钱 = (asset.钱 || 0) - (it.价 + 附加费)
  // REPEAT_DECAY 2026-11-05：24 小时内买过同样的东西，效果按 0.8^n 衰减——
  // 第二块蛋糕没那么甜，连着吃五顿火锅也不会一直爽（评审提的负反馈）
  let __n = 0
  try {
    const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    for (const r of (asset.记录 || [])) {
      if (!String(r.at || '').startsWith(今天)) continue
      if (String(r.what || '').includes(buy + '（')) __n += 1
    }
  } catch (e) { __n = 0 }
  const eff = JSON.parse(JSON.stringify(it.效果 || {}))
  let __k = 1
  if (__n > 0) {
    __k = Math.pow(0.8, __n)
    for (const key of ['困意', '情绪']) if (eff[key] !== undefined) eff[key] = Math.round(Number(eff[key]) * __k * 100) / 100
  }
  const __类 = String(it.类别 || "")
  // FOOD_DEFER 2026-11-06（批次144）：吃喝的效果不再挂在「买」上。
  // 买了 5 杯咖啡放家里、人却一路清醒，那是假的；等真吃进嘴再算，
  // 由 吃饭.mjs 结算时调 --生效 回来走 上效果()。
  const __延后 = ["吃", "喝", "零食"].includes(__类)
  if (!__延后) 上效果(it, buy, __k, __eventId)
  // BUY_ROUTE 2026-11-05：买完按类别归位——衣服进衣柜、日用品进包，
  // 吃喝玩的当场消耗掉、不留库存（不然包会越堆越怪，主人已经问过一次「台灯怎么在包里」）
  try {
    const 类别 = String(it.类别 || '')
    if (类别 === '穿') {
      asset.衣柜 = Array.isArray(asset.衣柜) ? asset.衣柜 : []
      if (!asset.衣柜.includes(buy)) asset.衣柜.push(buy)
    } else if (类别 === '日用') {
      asset.包 = Array.isArray(asset.包) ? asset.包 : []
      if (!asset.包.includes(buy)) asset.包.push(buy)
    }
  } catch (e) { /* 归位失败不影响买东西 */ }
  // FOOD_FORM 2026-11-06（批次144，主人要求）：买了不等于吃了。
  //
  // 在这之前吃喝一律当场进肚子：便利店买包薯片，饱腹立刻 +7，
  // 想在家存点东西根本没这条路。主人要的是三件事：
  //   ① 零食、牛奶可以买回家放着，不是一买就吃；
  //   ② 饭店的饭还是在店里吃完再走；
  //   ③ 吃饭要有时间 —— 毕竟得坐在那儿吃。
  //
  // 所以按 商店-生活.json 的 吃法 分流：
  //   · 堂食（吃法=堂食，或现在这个售卖点在 堂食点 里）→ 交给 吃饭.mjs 起「正在吃饭」，
  //     饱腹等吃完那一刻才加；这段时间 自主行动 / 缺口 / qq_go 都不搬她。
  //   · 带走（零食、饮料、包子、泡面…）→ 收进包（物品.json），回家能存着（物品.mjs --收），
  //     什么时候吃由她自己定（物品.mjs --吃）。这时候一两饱腹都不加。
  const 现在 = String(asset.位置 || "")
  let 吃法说明 = ""
  if (方式 === '快递') {
    // 快递 2026-11-07（批次219c）：东西不进家，先进 记忆/包裹.json，到点由 快递.mjs 送进来。
    try {
      const 包 = load(path.join(MEM, '包裹.json'), { 件: [] })
      包.件 = Array.isArray(包.件) ? 包.件 : []
      包.件.push({
        名: buy, 类: __类, 价: Number(it.价 || 0), 付: it.价 + 附加费,
        到At: new Date(Date.now() + 24 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
        记At: bjNow(),
      })
      save(path.join(MEM, '包裹.json'), 包)
      吃法说明 = '，快递明天这个点送到'
    } catch (e) { 吃法说明 = '，快递单没记上' }
  } else if (__类 === '药') {
    // 药 2026-11-08（批次224）：买到的是实物，进包，什么时候吃由她自己定（物品 --吃）。
    try {
      execFileSync(process.execPath, [
        path.join(TOOLS, "物品.mjs"), "--入", buy,
        "--在", "包", "--类", "药", "--价", String(Number(it.价 || 0)),
      ], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_OPTIONS: "" } })
      吃法说明 = `，${buy}装进包里了`
    } catch (e) { 吃法说明 = '，药没装进包里' }
  } else if (["吃", "喝", "零食"].includes(__类)) {
    const 堂食点 = Array.isArray(it.堂食点) ? it.堂食点.map(String) : []
    const 堂食 = String(it.吃法 || "") === "堂食" || 堂食点.includes(现在)
    const 分钟 = Number(it.分钟) || 25
    const 加 = Number(it.饱腹 ?? 0)
    if (堂食) {
      const requestedAt = Date.now()
      try {
        // 退出码 0 不保证开始成功；扣款和账本提交前核对新建的同一顿饭。
        execFileSync(process.execPath, [
          path.join(TOOLS, "吃饭.mjs"), "--开始",
          "--吃", buy, "--在哪", 现在, "--分钟", String(分钟),
          "--加", String(加), "--类别", __类, "--激素事件ID", __eventId,
        ], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_OPTIONS: "" } })
      } catch (e) {
        console.log(`堂食状态未建立，未扣款：${buy}`)
        process.exit(0)
      }
      const activeMeal = load(path.join(MEM, '吃饭.json'), null)
      if (!mealStarted(activeMeal, buy, Date.now(), requestedAt, __eventId)) {
        console.log(`堂食状态未建立，未扣款：${buy}`)
        process.exit(0)
      }
      吃法说明 = `，坐下来${吃喝动词(buy)}${buy}，大概 ${分钟} 分钟`
    } else {
      try {
        // 人在家买的（外卖/家里下单）直接进家，用不着先塞包里再放回去
        execFileSync(process.execPath, [
          path.join(TOOLS, "物品.mjs"), "--入", buy,
          "--在", 现在 === "家" ? "家" : "包",
          "--类", __类,
          "--饱腹", String(加),
          "--临时", String(Number(it.临时饱腹 ?? (__类 === "喝" ? 12 : 0))),
          "--价", String(Number(it.价 || 0)),
        ], { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_OPTIONS: "" } })
        吃法说明 = `，${buy}收进${现在 === "家" ? "家里" : "包里"}了`
      } catch (e) { /* 入库失败不影响她买到 */ }
    }
  }
  const 费名 = 方式 === '跑腿' ? '跑腿费' : 方式 === '外卖' ? '配送费' : '快递费'
  const 单 = `${it.价 + 附加费} 块${附加费 ? `，含${费名} ${附加费}` : ''}${方式 === '快递' ? '，明天到' : ''}${借款话 ? '，' + 借款话 : ''}`
  // 注意：这行的**句式就是账本.mjs 的输入契约**（批次288）。
  // 到店写「买了糖（6 块）」，外卖/跑腿/快递写「外卖：早饭（10 块，含配送费 2）」——
  // 账本.mjs 的 ⑦ 兜底按「第一个 N 块」取总价。2026-11-08 就是因为这几种前缀
  // 不在它的白名单里，她花掉 122 块，面板显示「今天 花 0」。
  // 以后改句式（总价挪后面、改成「共计」等），先在 契约检查.mjs 的账样本里加一条。
  记一笔(`${方式 === '到店' ? '买了' : 方式 + '：'}${buy}（${单}）`, __eventId)
  // BAG_SYNC 2026-11-06（批次144）：物品.mjs --入 会把新东西写进 资产.包（它的 存()），
  // 而这里的 asset 是调它之前读的 —— 直接 save 会把刚入库的东西抹掉（实测：钱扣了、包没变）。
  // 只把「包」这一个字段读回来，钱和记录是本次算的，不能被覆盖。
  try {
    const 新档 = load(ASSET, null)
    if (新档 && Array.isArray(新档.包)) asset.包 = 新档.包
  } catch (e) { /* 读不到就沿用旧的 */ }
  save(ASSET, asset)
  saveState(STATE, state, __stateSnap)
  // NOTE_TAIL 2026-11-05（批次103）：这行 stdout 会被自主行动当成 last.note 存下来，
  // 原来「困意 -6；心情 +4；」尾巴留一个分号，插件再补句号就成了「心情 +4；。」。
  // 尾巴统一去掉标点，让调用方自己决定用什么结尾。
  const 尾 = __延后
    ? `（还没吃，等真吃进嘴才算）${吃法说明}`
    : (`${eff.困意 ? `困意 ${eff.困意 > 0 ? "+" : ""}${eff.困意}；` : ""}${eff.情绪 ? `心情 ${eff.情绪 > 0 ? "+" : ""}${eff.情绪}；` : ""}`.replace(/[；;，,、]+$/, "") || "。")
  const 动词 = 方式 === '到店' ? '买了' : 方式 === '外卖' ? '点了外卖' : 方式 === '跑腿' ? '叫了跑腿' : '下了快递'
  console.log(`${动词} ${buy}，花 ${it.价 + 附加费} 块${附加费 ? `（含${费名} ${附加费}）` : ''}${借款话 ? `（${借款话}）` : ''}，剩 ${asset.钱}${尾}`)
  process.exit(0)
}

const work = val("--打工", "")
if (work) {
  // WORK_SHIFT 2026-11-06（批次145）：这条不再发钱。
  //
  // 112c 给它加过冷却（按上一条记录 + 这份活的时长算），但冷却只是「别太频繁」，
  // 本质还是「点一下就到账」—— 真上班是 22:00 到 06:00 人守在店里，
  // 不是想起来点一下就拿 150。班次、打卡、迟到、睡岗、全勤、加薪都在 工作.mjs 里，
  // 钱也只能从那儿出。留着这个子命令，只是为了让老调用方听到一句人话。
  const it = shop.打工[work]
  if (!it) { console.log(`没有「${work}」这种工`); process.exit(0) }
  console.log(`${work} 不再点一下就到账了 —— 上班要按班次打卡，干到下班才结工资（看 工作.mjs --班）`)
  process.exit(0)
}

console.log("用法：--看 / --买 东西 / --打工 活")
