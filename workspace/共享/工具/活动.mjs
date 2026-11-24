// 活动.mjs —— 她待在某类地方，身体会慢慢受影响（同样只是倾向，不是规矩）
// 用法：
//   node 活动.mjs --看      # 看当前地点会有什么效果、这次抽中没
//   node 活动.mjs --tick    # 按概率真生效（cron 每 30 分钟）
// 为什么这么写：
//   · 效果表只按地点「类别」写一份（在家/逛街/吃/玩/散心/运动/学习/放松/看病/打工…），
//     不按每个地点写一遍，改一处就够。
//   · 每一次 tick 都掷一次骰子：不是「到了公园必降皮质醇」，而是「待在公园时更容易松下来」；
//     同一个人连着去三次可能两次有用、一次没感觉。
//   · 激素交给 激素.mjs，体力/困意只按小数微调，别让半小时一次的任务把人反复拉满拉空。
import { 睡着 } from './睡态.mjs'
// OCCUPY 2026-11-07（批次167）：在岗判据只在 占用.mjs 一份
import { 在岗的班 } from './占用.mjs'
import fs from "node:fs"
// LOCK_RMW 2026-11-08（批次260）：钱走锁内读-改-写，见门票那段
import { 改档 } from './_底层.mjs'
import path from "node:path"
import { execFileSync } from "node:child_process"
// HUNGER 2026-11-06（批次139）：在吃饭的地方待着，「吃了」也要落到饱腹上。
import * as 饥饿 from "./饥饿.mjs"
import { saveState, clone } from './_状态.mjs'
import { 精力 } from './恢复目标.mjs'
import { 一次性动作 } from './在干嘛.mjs'

const DIR = "{{BOT_ROOT}}"
// SANDBOX 2026-11-06（批次139）：原来硬路径 —— 想验「在餐厅吃了一顿会不会涨饱腹」，
// 只能往她真实的资产/状态里写。跟 花钱.mjs 一样给个沙盒变量。
const MEM = process.env.QQ_ACT_MEM || process.env.QQ_AUTONOMY_MEM || path.join(DIR, "记忆")
// ACT_TOOLS 2026-11-17（批次677）：测试跑在镜像目录时，地图/参数/激素也得读镜像。
// 生产一个变量都不设，仍然落回 {{BOT_ROOT}}/共享/工具，行为不变。
const TOOLS = process.env.QQ_ACT_TOOLS || process.env.QQ_AUTONOMY_TOOLS || process.env.QQ_TOOLS || path.join(DIR, "共享/工具")

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
const 参数 = load(path.join(TOOLS, "参数.json"), {})
const 活动参 = (参数.活动 && typeof 参数.活动 === "object") ? 参数.活动 : {}
// 活动对困意的增量不再直接写 状态.困意，而是进 压制.json 的待结算账；
// 半衰 30 分钟 = 每 30 分钟一次 tick、+5 那档在连续打工时约等于 +10/h，
// 停下后半小时剩一半，一小时剩四分之一 —— 既能活过 15 分钟的重算，也不会一直堆着。
const 活动困意半衰 = Math.max(10, Number(活动参.困意半衰分钟 ?? 30) || 30)
const 追加活动记录 = (entry) => 改档(logP, (latest) => {
  latest.log = [...(latest.log || []), entry].slice(-300)
}, { log: [] })
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ")
const args = process.argv.slice(2)
const logP = path.join(MEM, "活动台账.json")

// 活动困意账：只写 压制.json 的「待结算」，不碰「当前」（那是 自主行动 的压制状态）。
// 困意.mjs 每次重算都会按半衰把这里加回去；活动停下的那一刻起自然回弹。
function 记活动困意(值, 名) {
  const v = Math.round((Number(值) || 0) * 10) / 10
  if (!v) return
  const now = Date.now()
  改档(path.join(MEM, "压制.json"), (压) => {
    const 旧 = Array.isArray(压.待结算) ? 压.待结算 : []
    const 留 = 旧.filter((x) => x && Number(x.at) > 0 && now - Number(x.at) <= 8 * 3600e3)
    留.push({ at: now, 值: v, 半衰: 活动困意半衰, 啥: "活动:" + String(名 || ""), kind: "活动" })
    压.待结算 = 留.slice(-12)
    if (压.当前 === undefined) 压.当前 = null
  }, { 当前: null, 待结算: [] })
}

const 地图 = load(path.join(TOOLS, "地图.json"), { 地点: {} })
const st = load(path.join(MEM, "状态.json"), {})
const stSnap = clone(st)
const asset = load(path.join(MEM, "资产.json"), { 位置: "家" })
const 地点 = asset.位置 || "家"
let kind = ((地图.地点 || {})[地点] || {}).kind || "家"

// WORK_ACT 2026-11-06（批次147）：在店里上班，不是「在店里逛」。
//
// 实测那条是：「[22:30] 便利店：逛店｜体力 -2，困意 +1，激素记了「晒太阳」」——
// 她 22:00-06:00 在便利店守着夜班，系统把她当顾客，半夜还晒了一次太阳；
// 体力被扣了两份（状态推进 -2.4/h + 活动 -4/h）。
// 判据跟 缺口/自主行动 同源：有在岗的班、位置就是这个点 —— 那她是在值班，不是在逛街。
try {
  // 批次167：判据在 占用.mjs。原来只认「状态=在岗」——
  // 上班第一分钟（待上 + 已到点 + 人已在店里）会被记成 kind=打工 那条：
  // 沙盒实测「咖啡店：打工｜体力 -5」，正确应该是「守店｜体力 -2.5」。
  const 在班 = 在岗的班(MEM)
  // 位置也要对得上：挂着在岗的班但人不在店里（被谁搬走了）不该记「守店」。
  if (在班 && String(在班.点 || "") === 地点) kind = "值班"
} catch { /* 读不到班次就按地点类别 */ }

// 效果表：按类别写。p 是「这一次生效」的概率，其余是增量
const 表 = {
  // REST_ONCE 2026-11-17（批次689）：在家休息原来 活动 +2/30 分钟，状态推进 又按 +8/小时回，
  // 合计最多约 +12/小时（40→100 只要 5 小时）。体力恢复归 状态推进 一本账（它有软顶），
  // 这里只留困意。两张表同步。
  家:     { p: 0.55, 名: "在家待着", energy: 0, 困意: 1, 激素: null },
  // ADRENALINE_FIX 2026-11-16（批次572）：逛街 / 散心 / 逛店 以前全发「晒太阳」。
  // 晒太阳是 cortisol -6（真晒到太阳才降），结果她在便利店站着也降 ——
  // 一天 84 次把皮质醇打到 2.2（平常 24.7）。现在三个动作各自成事件。
  逛街:   { p: 0.7,  名: "逛街", energy: -3, 困意: 2, 激素: "逛街", emotional: 1 },
  吃:     { p: 0.8,  名: "吃饭", energy: 6, 困意: 1, 激素: "吃饭", emotional: 0.8 },
  玩:     { p: 0.85, 名: "玩", energy: -4, 困意: 3, 激素: 地点 === "电影院" ? "电影" : "玩过山车", emotional: 2 },
  散心:   { p: 0.75, 名: "散心", energy: -1, 困意: 1, 激素: 地点 === "海边" ? "看海" : "散心", emotional: 1.5 },
  运动:   { p: 0.8,  名: "练一场", energy: -6, 困意: 4, 激素: "运动", emotional: 0.5 },
  学习:   { p: 0.7,  名: "看进去书", energy: -2, 困意: 2, 激素: "看书", cognitive: 1.5 },
  放松:   { p: 0.8,  名: "泡一泡", energy: 5, 困意: -3, 激素: "泡澡", emotional: 1 },
  // 困意 2026-11-17（批次685）：干活 +5/30min = 稳态约 +10/小时，是腺苷（清醒 8 小时才 +4.5/小时）
  // 的两倍多；干满 8 小时光活动账就 +80，超过腺苷封顶 60。降到 +3（约 +6/小时），守店 +4→+2.5。
  打工:   { p: 0.9,  名: "干活", energy: -5, 困意: 3, 激素: null, emotional: -0.5 },
  // WORK_SHIFT 2026-11-06（批次147）：值班跟「干活」不是一回事。
  // 发传单是站着发两小时（-5/半小时），守夜是坐着看店（-2.5），但夜里困意涨得快。
  // 不共用一条：共用会把 8 小时夜班按 -5 扣成 -80，人直接耗干。
  值班:   { p: 0.85, 名: "守店", energy: -2.5, 困意: 2.5, 激素: null, emotional: -0.2 },
  // 注意：kind="买" 是「人在买东西的地方」，不是「买了东西」。
  // 真买了什么、花多少，由 花钱.mjs 写进 资产.记录，两条是分开的。
  买:     { p: 0.6,  名: "逛店", energy: -2, 困意: 1, 激素: "逛店" },
  看病:   { p: 0.5,  名: "看病", energy: 3, 困意: 0, 激素: "陪伴" },
  // DONE_SHOT 档（批次538）：她做完一件几十秒的事之后待在原地。体力不动，只是会困。
  待着:   { p: 1,    名: "待着", energy: 0, 困意: 1, 激素: null },
}

// DONE_SHOT 2026-11-16（批次538）：**她是在逛店，还是喝完水站在这儿**
//
// 原来这里只按地点类别算：人在便利店 → kind='买' → 「逛店」-2/半小时。
// 而她做完「喝点水」这种几十秒的事之后只是待在原地 —— `自主.json` 里
// `state` 是「最近做过什么」的标签、`doneAt` 写死在那一刻（06:27）、`nextAt` 还有两小时（08:39）。
// 实测 11-16 03:30–07:00 连续 8 次「逛店」共 -16，体力 28 → 12，可那两个多小时她只是在店里站着。
//
// 判据只看两个字段：state 属于一次性动作 **且** doneAt 比现在早 5 分钟以上。
// 不碰逛街/洗澡 —— 它们不在一次性集合里；打工即使 doneAt 旧了，
// 只要 工作.json 还有真实在岗班次，也以班次为准（下面 __待着 不覆盖 值班）。
// 读不到 自主.json 就当没这回事（按原来的算），不因为读失败改变她的活动。
let 自主态 = ""
let __待着 = false
try {
  const au = JSON.parse(fs.readFileSync(path.join(MEM, "自主.json"), "utf8"))
  自主态 = String((au.state && au.state.状态) || au.state || "")
  const done = Number(au.doneAt || 0)
  if (done > 0 && Date.now() - done > 5 * 60e3 && 一次性动作.has(String(au.state || ""))) __待着 = true
} catch { /* 没有就按原来的算 */ }
if (__待着 && kind !== "值班") kind = "待着"

// ACT_TYPE 2026-11-17（批次677）：**扣体力的是她正在干什么，不是她站在哪类地方。**
//
// 旧账：地图里 咖啡店 kind=打工，于是「人在咖啡店、state=看B站」也按「干活 -5/30min」扣，
// 一天下来和 状态推进 的「歇着」曲线完全相反。表演/吃饭/泡澡这些地点效果也一样 ——
// 地点只决定「这里能做什么」（门票、自动吃饭、激素事件），身体增量按活动类型取。
//
// 数值全部沿用原来那张地点表里的同一档（打工 -5、值班 -2.5、逛街 -3…），没有调平衡；
// 唯一新加的「在家休息 +2」就是原来 家 那一档，只是现在要求 state 是待着/看B站这类坐着的事。
const 体力表 = {
  // 同 地点表：干活 +3、守店 +2.5（批次685），别让一张表改了另一张还是旧值。
  打工:     { 名: "干活",     energy: -5,   困意: 3,  emotional: -0.5, cognitive: 0 },
  值班:     { 名: "守店",     energy: -2.5, 困意: 2.5, emotional: -0.2, cognitive: 0 },
  逛街:     { 名: "逛街",     energy: -3,   困意: 2,  emotional: 1,    cognitive: 0 },
  运动:     { 名: "练一场",   energy: -6,   困意: 4,  emotional: 0.5,  cognitive: 0 },
  学习:     { 名: "看进去书", energy: -2,   困意: 2,  emotional: 0,    cognitive: 1.5 },
  玩:       { 名: "玩",       energy: -4,   困意: 3,  emotional: 2,    cognitive: 0 },
  散心:     { 名: "散心",     energy: -1,   困意: 1,  emotional: 1.5,  cognitive: 0 },
  // WALK_TIER 2026-11-17（批次688）：原来「走动」没有独立档，落到「待着」：体力 +0、困意 +1/30min。
  // 比逛街轻一档（-1.5 / 困意 +2），好歹走了路要掉点体力。
  走动:     { 名: "走动",     energy: -1.5, 困意: 2,  emotional: 0,    cognitive: 0 },
  放松:     { 名: "泡一泡",   energy: 5,    困意: -3, emotional: 1,    cognitive: 0 },
  吃:       { 名: "吃饭",     energy: 6,    困意: 1,  emotional: 0.8,  cognitive: 0 },
  看病:     { 名: "看病",     energy: 3,    困意: 0,  emotional: 0,    cognitive: 0 },
  在家休息: { 名: "在家待着", energy: 0,    困意: 1,  emotional: 0,    cognitive: 0 },
  待着:     { 名: "待着",     energy: 0,    困意: 1,  emotional: 0,    cognitive: 0 },
}

const 坐着态 = /看B站|逛贴吧|刷手机|玩电脑|发呆|摸鱼|待着|躺|坐着|打瞌睡|打盹|喝点水|买瓶水|买东西|拍张照|翻旧账|学点东西|洗澡/
const 空态 = /^(待命|待着|)$/

// 地点只当「这里能做什么」的兜底：待命/空串时才按地点类别取；
// 明说在看B站/刷手机/洗澡就是坐着，哪怕人在咖啡店也不按干活扣。
const 地点兜底 = {
  家: "在家休息", 逛街: "逛街", 吃: "吃", 玩: "玩", 散心: "散心", 运动: "运动",
  学习: "学习", 放松: "放松", 看病: "看病",
  打工: "待着", 值班: "待着", 买: "待着", 买药: "待着", 待着: "待着",
}

function 判活动类型(态, 地点名, 类别, 已待着) {
  if (类别 === "值班") return "值班"
  if (已待着) return 地点名 === "家" ? "在家休息" : "待着"
  const s = String(态 || "").trim()
  if (坐着态.test(s)) return 地点名 === "家" ? "在家休息" : "待着"
  // WORK_TRUTH 2026-11-17（批次677，A5 线上案例）：
  // `自主.state` 里写着「打工/上班」不等于真有班。16:09 她只是到咖啡店，
  // 资产没有打工收入、工作.json 没有班次，活动却按 state 字样记了「干活 -5」。
  // 真班次已经由上面的 `在岗的班()` 判成 kind="值班"；这里不再凭字样猜干活。
  // 单纯到店 → 落到下面的地点兜底（咖啡店/便利店/店铺 = 待着）。
  if (/逛街|逛店|逛超市/.test(s)) return "逛街"
  if (/运动|健身|跑步|锻炼|练一场/.test(s)) return "运动"
  if (/学习|看书|读书|复习/.test(s)) return "学习"
  if (/看电影|打游戏|去游乐园|玩过山车|出去玩/.test(s) || s === "玩") return "玩"
  if (/散步|散心|看海/.test(s)) return "散心"
  // WALK_TIER 2026-11-17（批次688）：走着去某处原来落到「待着」，体力一点不掉；
  // 给一档比逛街轻、比坐着重的：-1.5/30 分钟、困意 +2。
  if (/走路|走到|在途|往回走|出门去/.test(s)) return "走动"
  if (/泡澡|放松/.test(s)) return "放松"
  if (/吃饭|吃点东西/.test(s)) return "吃"
  if (/看病|去医院|去药店/.test(s)) return "看病"
  if (空态.test(s)) return 地点兜底[类别] || "待着"
  return 地点名 === "家" ? "在家休息" : "待着"
}

const 活动类型 = 判活动类型(自主态, 地点, kind, __待着)
const e = 表[kind] || 表.家
const 活动 = 体力表[活动类型] || 体力表.待着
// p（这一次生不生效）仍按地点算 —— 那是「这里有没有机会」；身体增量按活动类型取。
const a = { ...e, ...活动 }
const r = Math.random()
const 生效 = r < a.p

if (args.includes("--看") || args.length === 0) {
  console.log(`人在${地点}（地点类别：${kind}｜活动：${活动.名}）`)
  console.log(`按活动算：${活动.名}｜体力 ${a.energy >= 0 ? "+" : ""}${a.energy}｜困意账 ${a.困意 >= 0 ? "+" : ""}${a.困意}（半衰 ${活动困意半衰} 分）${a.激素 ? "｜激素事件：" + a.激素 : ""}`)
  console.log(`这一次（概率 ${Math.round(a.p * 100)}%）：${生效 ? "生效了" : "没什么感觉"}`)
  process.exit(0)
}

if (args.includes("--tick")) {
  // SLEEP_GUARD 2026-11-05：睡着的时候别在公园长椅上「散心」，先看睡醒标记
  if (睡着(MEM)) {
    console.log("她在睡，不活动")
    process.exit(0)
  }
  if (!生效) {
    追加活动记录({ at: bj(), 地点, kind, 活动: 活动.名, 名: 活动.名, 生效: false })
    console.log(`${地点}：待了一会儿，没什么特别的感觉`)
    process.exit(0)
  }
  // TICKET 2026-11-05：有些地方要买票才能玩（电影院/游乐园/澡堂/健身房），
  // 只逛街、散步、看书这类不需要。钱不够就只在门口转转——照样记录，但这轮效果打折。
  const 地点数据 = (地图.地点 || {})[地点] || {}
  const 门票 = Number(地点数据.门票 || 0)
  let 只逛不玩 = false
  if (门票 > 0) {
    // LOCK_RMW 2026-11-08（批次260）：扣门票改成「锁内重读 → 判断够不够 → 扣 → 写」。
    // 原来 load → 改 → save，save 的锁只护住写那一下；读完之后到写之前撞上工资入账，
    // 两边各自基于旧余额算，各丢一笔（沙盒 20 并发实测丢 9~11 块）。
    // 改() 返回 false = 钱不够，改档 不写盘、返回 null —— 这样「够不够」和「扣」在同一个锁里，
    // 不会出现「判的时候够、扣的时候不够」。
    let 已买过 = false
    const 买上了 = 改档(path.join(MEM, "资产.json"), (a) => {
      // TICKET_ONCE 2026-11-15（批次505）：门票是「进一次收一次」，不是每次 tick 收一次。
      // 实测 16:30 / 17:30 / 18:00 / 18:30 连收四笔 120，全是 活动.mjs --tick 干的 ——
      // 原来的代码只要地点有门票就扣，完全没有「这一趟已经买过票」的判据。
      // 判据直接读账本本身（不新开文件）：同记账名、8 小时内收过就不再收。
      const 记账名 = String(地点数据.门票记账 || 地点 + "门票")
      const 旧记录 = Array.isArray(a.记录) ? a.记录 : []
      for (let i = 旧记录.length - 1; i >= 0; i -= 1) {
        if (!String(旧记录[i]?.what || "").startsWith(记账名)) continue
        const t = Date.parse(String(旧记录[i].at || "").replace(" ", "T") + ":00+08:00")
        if (Number.isFinite(t) && Date.now() - t < 8 * 3600e3) { 已买过 = true; return false }
        break
      }
      if (Number(a.钱 ?? 0) < 门票) return false
      a.钱 = Number(a.钱) - 门票
      a.记录 = Array.isArray(a.记录) ? a.记录 : []
      a.记录.push({ at: bj(), what: `${地点数据.门票记账 || 地点 + "门票"}（${门票} 块）` })
      if (a.记录.length > 200) a.记录 = a.记录.slice(-200)
      return true
    }, { 钱: 0, 记录: [] }) === true
    if (买上了) {
      console.log(`在${地点}买了票，花 ${门票} 块`)
    } else if (已买过) {
      console.log(`${地点}的票还在有效期内（8 小时），这次不再收`)
    } else {
      只逛不玩 = true
      追加活动记录({ at: bj(), 地点, kind, 活动: 活动.名, 名: 活动.名, 生效: false, 说明: `没钱买票（要 ${门票} 块），只在门口转了转` })
      console.log(`${地点}要 ${门票} 块门票，她钱不够，只在门口转了转`)
      process.exit(0)
    }
  }

  // 体力按层改（layers.physical）——增量来自活动类型，不是地点类别
  const L = st.layers || (st.layers = {})
  const ph = Number(L.physical ?? 60)
  L.physical = Math.max(0, Math.min(100, ph + Number(a.energy)))
  // LAYER_TOUCH 2026-11-05：这类地方也会碰到情绪层/认知层，不是只有体力在动
  if (a.emotional) L.emotional = Math.max(0, Math.min(100, Number(L.emotional ?? 60) + Number(a.emotional)))
  if (a.cognitive) L.cognitive = Math.max(0, Math.min(100, Number(L.cognitive ?? 60) + Number(a.cognitive)))
  // DERIVED_ENERGY 2026-11-12：用统一公式 精力(L) 同步重算 st.energy，避免接下来 15 分钟内面板/自主行动读到未更新的旧精力
  st.energy = 精力(L)
  // SLEEPY_LEDGER 2026-11-17（批次677）：不再直接写 st.困意（下一次 状态推进 会按
  // 困意.mjs 重算覆盖，最多活 15 分钟）。改记进 压制.json 的「待结算」——
  // 困意.mjs 每次重算都会把待结算按半衰加回来，停下后自然回弹。
  记活动困意(a.困意, 活动.名)
  // HUNGER 2026-11-06（批次139）：kind="吃" 是「人在吃饭的地方」。
  // 这一轮生效就该涨饱腹 —— 但必须带冷却，否则她在餐厅坐两小时会被记成四顿
  // （cron 每 30 分钟一次）。判据用 想吃意向：刚吃完就不算又吃了一顿，只是坐着。
  try {
    if (kind === "吃") {
      const h = 饥饿.读()
      if (饥饿.想吃意向(h.饱腹, 饥饿.距上次分钟(h)) >= 0.3) {
        // MEAL_PATH 2026-11-17（批次677）：原来走「表里没有」的兼容路（840 千卡、胃/血糖 0）。
        // 现在走真实物品的同一条 吃() 结算：950 千卡、顶胃 850、血糖 +2.6、欠 -4.75。
        饥饿.吃({ 名: "一顿正经饭", 价: 0, 类别: "吃" })
      }
    }
  } catch (e) { /* 饥饿账坏了不影响这次活动 */ }
  // 玩这类会顺带提一点情绪
  if (kind === "玩" || kind === "散心") {
    const m = st.mood || (st.mood = {})
    m.intensity = Math.round((Number(m.intensity || 0) + 0.12) * 100) / 100
  }
  saveState(path.join(MEM, "状态.json"), st, stSnap)
  const eventAt = bj()
  if (a.激素) {
    const eventId = 'activity:' + eventAt + ':' + 地点 + ':' + kind + ':' + a.激素
    // SANDBOX_ENV 2026-11-16（批次574）：**把 MEM 一起传给子进程**。
    // 不加这句时，沙盒里跑 `活动.mjs --tick`（t539/t540/t572）只设了 `QQ_ACT_MEM`，
    // 而 `激素.mjs` 读的是 `HJ_BASE`（默认真档）—— 于是活动台账写沙盒、**激素事件写真档**。
    // 实测 14:22~14:40 六次测试把「逛店」灌进真档：dopamine 45 → 60.8、oxytocin 40 → 44。
    // 这跟 MEMORY 里「A spawn B 时两边的变量都要指沙盒」是同一条，但靠人记不住 —— 让它俩永远同源。
    try { execFileSync(process.execPath, [path.join(TOOLS, "激素.mjs"), "--event", a.激素, "--id", eventId], { encoding: "utf8", env: { ...process.env, HJ_BASE: MEM } }) } catch {}
  }
  追加活动记录({ at: eventAt, 地点, kind, 活动: 活动.名, 名: 活动.名, 生效: true, 体力: a.energy, 困意: a.困意, 困意半衰: 活动困意半衰, 激素: a.激素 })
  console.log(`${地点}：${活动.名}｜体力 ${a.energy >= 0 ? "+" : ""}${a.energy}，困意账 ${a.困意 >= 0 ? "+" : ""}${a.困意}（半衰 ${活动困意半衰} 分）${a.激素 ? "，激素记了「" + a.激素 + "」" : ""}`)
  process.exit(0)
}

console.log("用法：--看 / --tick")
