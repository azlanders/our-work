// 缺口.mjs —— 她缺什么、有多大倾向去补：全都是权重，没有硬性规矩
// 用法：
//   node 缺口.mjs --看            # 看她缺什么、每种做法各占多少倾向
//   node 缺口.mjs --tick          # 按倾向抽一次，真去做（买 / 走过去 / 打工 / 要钱 / 忍着）
// 为什么这么写：
//   · 不设「必须怎样」的门。钱不够也一样可能硬买（花到见底），累了一样可能硬去干活，
//     有钱一样可能舍不得花——只是概率高低不同，这才像活人。
//   · 所有倾向权重都在 参数.json 的「倾向」段里，能调，不用改代码。
//   · 价格只在 商店-生活.json，地点服务只在 地图.json，这里不存第二份。
import { 睡着 } from './睡态.mjs'
// OCCUPY 2026-11-07（批次167）：占用态（在岗/吃饭/洗澡/打盹）的判据只在 占用.mjs 一份
import { 在岗的班, 在打盹, 在吃饭 } from './占用.mjs'
import fs from "node:fs"
import { 加锁 } from './_锁.mjs'
import { 改档 } from './_底层.mjs'
import path from "node:path"
import { execFileSync } from "node:child_process"
// 地点功能区（批次79）：「这儿开着吗」「下雨天该去哪儿」原来散在各处，
// 现在统一问 地点.mjs。传 MEM 进去而不是靠环境变量 —— 沙盒才不会漏。
import { 读档 as 读地点, 营业中 } from './地点.mjs'
// HUNGER 2026-11-06（批次139）：饿按饱腹算，不按精力。
import * as 饥饿 from './饥饿.mjs'
import * as 饱渴 from './饱渴.mjs'   // THIRST_DEADFIELD 2026-11-24：渴的唯一真源
import { 该去的班 as 共享该去的班 } from './排班判据.mjs'
import { 写惦记, 销账生理惦记 } from './惦记.mjs'
import { 能接水 as 物品能接水, 杯态 } from './水点.mjs'
import { 缺口应补水, 饮水动作成功 } from './自主判据.mjs'

// GAP_MEM 把「记忆」指到沙盒（状态/资产/台账都在里面），
// 工具目录默认还读真的——测试要的是真商店真地图，只是别动她的人。
const DIR = process.env.GAP_DIR || "{{BOT_ROOT}}"
const MEM = process.env.GAP_MEM || path.join(DIR, "记忆")
const TOOLS = process.env.GAP_TOOLS || path.join(DIR, "共享/工具")

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
// ATOMIC_WRITE 2026-11-05：先写临时文件再改名。两个定时任务撞在同一秒时，
// 最坏是丢一次更新，但绝不会留下半截 JSON 把她的数据读崩。
// LOCKED_WRITE 2026-11-05：外面再套一把「抢不到就放弃」的软锁，减少同时写的概率；
// 锁失败不阻塞（见 _锁.mjs），所以不会让定时任务卡住。
// TMPNAME_FIX 2026-11-24：临时名原来只有 pid —— 同进程内两次写会撞。
// 已补随机后缀，与 _底层.写档 口径一致（锁只降概率，原子性靠唯一临时名）。
const save = (p, o) => {
  const 放 = 加锁(p.split('/').pop())
  try {
    const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2))
    fs.renameSync(tmp, p)
  } finally { 放() }
}
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ")
const args = process.argv.slice(2)
const val = (k, d = "") => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] ?? d) : d }

const shop = load(path.join(TOOLS, "商店-生活.json"), { 商品: {} })
const 地图 = load(path.join(TOOLS, "地图.json"), { 地点: {} })
const st = load(path.join(MEM, "状态.json"), {})
const asset = load(path.join(MEM, "资产.json"), { 钱: 0, 位置: "家", 记录: [] })
const 台账P = path.join(MEM, "缺口台账.json")
const 台账 = load(台账P, { asks: [], worked: [], log: [] })

// 倾向权重全部可调（参数.json 的「倾向」段），读不到就用下面这套默认
const PJ = (load(path.join(TOOLS, "参数.json"), {}) || {})["倾向"] || {}
const W = (k, d) => (PJ[k] !== undefined ? Number(PJ[k]) : d)

const 钱 = Number(asset.钱 ?? 0)
const energy = Number(st.energy ?? 60)
const 困意 = Number(st.困意 ?? 0)
const mi = Number((st.mood || {}).intensity ?? 0)
const 地点 = asset.位置 || "家"
const 价 = (k) => Number((shop.商品[k] || {}).价 ?? 0)

// 缺什么：同样只是「有多缺」，用 0~1 的强度表示，不做硬判定
const 缺 = []
const 强度 = (v, lo, hi) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)))
// SATIETY 2026-11-05：刚吃过就别马上又饿——沙盒模拟里她一口气买了两顿早饭。
// 90 分钟内买过正经吃的，饿的强度压到三成（不是不饿，是没那么急）
let __刚吃过 = false
try {
  const 今 = bj().slice(0, 10)
  const 吃的 = /早饭|包子|粥和咸菜|拉面|一顿正经饭|麻辣烫|汉堡|自热饭|火锅|烤肉|寿司/
  __刚吃过 = (asset.记录 || []).some((r) => {
    if (!String(r.at || "").startsWith(今)) return false
    const t = String(r.at || "").slice(11)
    const 分钟 = Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5))
    const 现在 = Number(bj().slice(11, 13)) * 60 + Number(bj().slice(14, 16))
    return 现在 - 分钟 >= 0 && 现在 - 分钟 <= 90 && 吃的.test(String(r.what || ""))
  })
} catch (e) { __刚吃过 = false }
// BODY_GAP 2026-11-05：身体一直在报数（状态.json 的 body 里有渴/累的那种痒），
// 但这些字段只有面板在看，缺口从来不理——她渴到 80 也不会想买水。
// 现在接两条：
//   · 渴 → 算一个真缺口，补的是喝的（水/果汁这类，不拿咖啡当水喝）。
//   · 累的那种痒 → 不是「缺什么」，是「快撑不住了」，所以不单列，
//     加成到「困」的强度上：越痒越坐不住，越想找地方歇。
// 「说不清的不舒服」故意不接：那更像情绪，硬塞进购物清单会变得很怪。
// THIRST_DEADFIELD 2026-11-24：这里原来读 `st.body.渴`，而 状态推进.mjs 在
// THIRST_RETIRE（批次434）里写了 `delete b['渴']` —— 写入方早删了，读取方还在读。
// 结果 `Number(undefined ?? 0) = 0` → 渴强度恒为 0，**「渴」这条缺口从来没触发过**。
// 现在改读 饱渴.mjs 的水百分比（唯一真源，`状态推进` 也是从它取的）。
const body = st.body || {}
const 渴 = (() => {
  try { return 强度(Number(饱渴.读().水百分比 ?? 100), 40, 100) } catch { return 0 }
})()
const 累痒 = 强度(Number(body["累的那种痒"] ?? 0), 30, 100)

// HUNGER 2026-11-06（批次139）：饿不再由精力推。
// 原来 `45 - energy`：她精力常年 12，饿的强度永远是 1（满格），
// 缺口每分钟都推她去吃 —— 一天 10 顿里有一半是这条推出来的。
// 现在按饱腹：90 分饱 → 0；55 → 0.25；20 → 满。再乘「想吃意向」，
// 刚吃完那 40 分钟连 0.15 都不到（这是 __刚吃过 那条正则判据真正的替身）。
const __饥 = (() => { try { const h = 饥饿.读(); return { 饱腹: h.饱腹, 距: 饥饿.距上次分钟(h) } } catch { return null } })()
const 饿 = __饥
  ? 强度(78 - __饥.饱腹, 0, 60) * (0.25 + 0.75 * 饥饿.想吃意向(__饥.饱腹, __饥.距))
  : 强度(45 - energy, 0, 30) * (__刚吃过 ? 0.3 : 1)   // 读不到饱腹才退回老判据
const 困 = Math.min(1, 强度(困意, 60, 120) + 0.25 * 累痒)
const 闷 = 强度(-mi, 1.0, 2.0)
const 穷 = 强度(15 - 钱, 0, 15)

// VARIETY 2026-11-05：不再固定买那几样，按类别从店里挑；刚吃过的东西降权，别天天同一个
const 最近买过 = (台账.log || []).slice(-6).map((x) => (x.选 && x.选.物) || "").filter(Boolean)
function 挑(池, 偏好低 = false) {
  const 有 = 池.filter((n) => (shop.商品 || {})[n])
  if (!有.length) return 池[0]
  const 票 = []
  for (const n of 有) {
    const p = 价(n)
    let w = 4
    if (偏好低) w *= p <= 12 ? 3 : p <= 30 ? 2 : 1
    if (最近买过.slice(-2).includes(n)) w -= 3        // 刚买过，近期降权
    else if (最近买过.includes(n)) w -= 1
    for (let i = 0; i < Math.max(1, w); i += 1) 票.push(n)
  }
  return 票[Math.floor(Math.random() * 票.length)] || 有[0]
}
const 饿的池 = ["包子", "粥和咸菜", "早饭", "拉面", "一顿正经饭", "麻辣烫", "汉堡套餐", "自热饭", "吃好吃的"]
const 困的池 = ["咖啡", "能量饮料", "奶茶"]
const 闷的池 = ["小蛋糕", "蛋糕卷", "布丁", "冰淇淋", "巧克力", "薯片", "糖", "奶茶", "果汁", "可乐", "果冻"]
const 穷的池 = ["泡面", "包子", "饼干", "粥和咸菜"]
// 解渴只挑真解渴的：咖啡和能量饮料越喝越渴，不放进这个池
const 渴的池 = ["水", "矿泉水", "果汁", "可乐", "气泡水", "酸奶", "热牛奶"]

if (饿 > 0) { const 物 = 挑(穷 > 0.5 ? 穷的池 : 饿的池, 穷 > 0.3); 缺.push({ kind: "饿", 补: 物, 价: 价(物), 强度: 饿 }) }
if (困 > 0) { const 物 = 挑(困的池); 缺.push({ kind: "困", 补: 物, 价: 价(物), 强度: 困 }) }
if (闷 > 0) { const 物 = 挑(闷 > 0.5 ? 闷的池.slice(0, 9) : 闷的池); 缺.push({ kind: "闷", 补: 物, 价: 价(物), 强度: 闷 }) }
if (穷 > 0.4) { const 物 = 挑(穷的池, true); 缺.push({ kind: "穷", 补: 物, 价: 价(物), 强度: 穷 }) }
if (渴 > 0) { const 物 = 挑(渴的池); 缺.push({ kind: "渴", 补: 物, 价: 价(物), 强度: 渴 }) }
缺.sort((a, b) => b.强度 - a.强度)// 最难受的排前面，但只是权重更高

// ── 伞 2026-11-05（批次75）──────────────────────────────────
// 这跟饿渴不是一类需求：不是身体要，是回不去。
// 伞落在家里反而比「根本没伞」更难受 —— 有伞却用不上。
const 天气吧 = load(path.join(MEM, "天气.json"), {})
const 物件档 = load(path.join(MEM, "物品.json"), { items: [] })
const 物表 = Array.isArray(物件档.items) ? 物件档.items : []
const 手上有伞 = 物表.some((x) => x.n === "雨伞" && x.在 === "包")
const 家里有伞 = 物表.some((x) => x.n === "雨伞" && x.在 === "家")
// 下雨分两档（批次79）：
//   正在下   —— 她这会儿出门会淋到，借伞最急
//   今天有雨 —— 现在停着，也该带一把，但没必要当场冲去借
// 新天气有「现在.下」这个字段才做得到。老逻辑只认天气名，
// 于是「早上八点下过、现在停了」也会判成正在下。
const 今天有雨 = /雨|雪/.test(String(天气吧.天气 || ""))
const 现在在下 = !!(天气吧.现在 && 天气吧.现在.下)
const 在下雨 = 今天有雨
const 雨急 = 现在在下 ? 1 : (今天有雨 ? 0.55 : 0)
// 借的伞到点了：押金压在人家那儿，这事比饿渴都急
// 2026-11-06 批次128：>= 不是 >。注入那边（poll.js 物件提示）用的是「现在 >= 到期」，
// 会在到期那一分钟就告诉她「已经过点了」；这里用 > 的话，12:30 那一轮 tick 不算到期，
// 整个 12:30 白丢一次（实测 12:30 那轮抽到了「忍」），伞只能再等半小时。
const 该还伞 = 物表.find((x) => x.n === "雨伞" && x.来 === "借" && x.该还 && bj() >= String(x.该还)) || null
let 缺伞 = 0
let 伞的话 = ""
if (雨急 > 0 && 地点 !== "家" && !手上有伞) {
  缺伞 = (家里有伞 ? 0.85 : 0.7) * 雨急
  伞的话 = 家里有伞 ? "伞落在家里了" : "手上没伞"
  // LOAN_CAP 2026-11-05：今天已经借过两次就别再借了 ——
  // 还了之后如果还在下雨，她手上又没伞，就会一直「借—还—再借」地打转。
  // 借两次还淋雨，那就该想别的办法（买一把，或者干脆淋着）。
  const 今天 = bj().slice(0, 10)
  const 今天借过 = (asset.记录 || []).filter((r) => String(r.at || "").startsWith(今天) && /借雨伞/.test(String(r.what || ""))).length
  if (今天借过 >= 2) { 缺伞 = 0; 伞的话 = "" }
}

// 只留现在开着的（批次79）。
// 原来这里列的是地图上的全部地点，于是凌晨两点也会抽到「去图书馆买热牛奶」，
// 走到门口才发现关着。营业时间现在由 地点.mjs 判，跨夜/周休都在里面算好。
const 地点档 = 读地点(MEM)
const 地名 = Object.keys(地图.地点 || {}).filter((n) => 营业中(n, 地点档).ok)
const 卖这个 = (物) => 地名.filter((n) => ((地图.地点[n] || {}).服务 || []).includes(物))
const 招这个 = (活) => 地名.filter((n) => ((地图.地点[n] || {}).招工 || []).includes(活))

function 打工选() {
  // WORK_SHIFT 2026-11-06（批次112）：排了班的活不能「点一下干完」。
  //
  // 便利店夜班 / 咖啡店 / 家教现在有班次，走 工作.mjs 打卡、结算、扣款；
  // 可 `花钱.mjs --打工` 那条老路还在，一次到账 150 块。两条路并着走，
  // 她一天能挣两份，班次就成了摆设 —— 上班迟到扣的那点钱还不如多打一次工。
  // 这里只留「不排班」的活（发传单）当临时工：想干就干，干完就有钱，跟班次无关。
  const 排了 = (() => {
    try {
      const 配 = load(path.join(TOOLS, '工作.json'), {})
      return new Set(
        Object.entries(配.活 || {})
          .filter(([, c]) => Array.isArray(c.周) && c.周.length > 0)
          .map(([k]) => k)
      )
    } catch { return new Set() }
  })()
  const jobs = Object.entries(shop.打工 || {})
    .filter(([name]) => !排了.has(name))
    .map(([name, j]) => ({ name, 收入: Number(j.收入 || 0), 耗体力: Number((j.耗 || {}).体力 ?? 0) }))
    .sort((a, b) => b.收入 - a.收入)
  return jobs
}

// 把「能做的事」折成一堆票，然后抽一张——这就是「倾向」
// WORK_LINK 2026-11-06（批次112）：工作系统接进日常。
//
// 原来「打工」只有一个入口：抽到「挣」→ 花钱.mjs --打工，点一下钱就到手，没有几点、没有班次。
// 现在有了班次表，缺口得知道两件事：
//   ① 我正在上班 → 别搬我（在岗的班，判据在 占用.mjs）
//   ② 快上班了 / 已经迟到了 → 先走这一趟，比逛该重要（该去的班）
// 判据只看 工作.json 里写着的班次，不猜"今天该不该上"。
//
// WORK_LINK_ONE 2026-11-07（批次167）：这里原来有一份 在岗的班()，自动作息.mjs
// 另有一份同名的，自主行动.mjs 内联了两处 —— 三份判据还不一样：
// 这一份认「待上 + 已到点 + 人在点上」（批次146 补的），那三份只认「状态=在岗」。
// 沙盒实测（09:00:01 刚上班那一分钟）：缺口 说「在上班，不补缺口」，
// 自主行动 说「现在去拍张照」—— 同一分钟，两套说法。现在只有 占用.mjs 一份。

// WORK_MEAL 2026-11-06（批次146）：上班期间就地吃一口。
//
// 判据只用两个：饱腹 < 45、距上次吃 ≥ 3 小时。前者保证不是嘴馋，
// 后者保证一夜最多两三次（不然就成了在班上一直吃）。
// 先吃包里的存货（不花钱），没有才在店里买「带走」类（堂食要占座，上班不合适）。
// 吃完照样走 物品.mjs → 吃饭.mjs：坐下来那几分钟 在岗 照常累计，位置不变，不影响考勤。
function 上班吃一口(班) {
  const run = (script, argv) => {
    try {
      // NODE_OPTIONS 清空：cron 顶部挂了 --import=日志前缀.js，子进程 stdout 会变成
      // 「[23:00:01 物品.mjs] 收进包里：气泡水」——拼进日志就是脏话（批次134 同一个坑）。
      return String(execFileSync(process.execPath, [path.join(TOOLS, script), ...argv], {
        encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
      }) || "").trim()
    } catch (e) { return "" }
  }
  try {
    const h = 饥饿.读()
    if (Number(h.饱腹 || 0) >= 45) return ""
    if (饥饿.距上次分钟(h) < 180) return ""
    // ① 包里现成的（零食、饮料、包子…）
    const 物 = load(path.join(MEM, "物品.json"), { items: [] })
    // 按商店表里的饱腹挑最大的那份 —— 包里同时有糖和水时，先吃糖（3 块）不如先吃包子。
    // 物品条目本身不存饱腹（只有 n/在/类/数），数值在 商店-生活.json 的商品表里。
    const 包里 = (物.items || [])
      .filter((x) => x && String(x.在) === "包" && ["吃", "喝", "零食"].includes(String(x.类 || "")))
      .map((x) => {
        const v = (shop.商品 || {})[String(x.n)] || {}
        // 跟 物品.mjs 第 183 行同一套默认：喝类没写 临时饱腹 就是 12
        const 类 = String(v.类别 || x.类 || "")
        return { x, 饱腹: Number(v.饱腹 || 0), 临时: Number(v.临时饱腹 ?? (类 === "喝" ? 12 : 0)) }
      })
    // ① 包里有真顶饿的就先吃它（水不算 —— 一杯只顶十几分钟，别把这一轮占掉）
    const 顶饿 = 包里.filter((o) => o.饱腹 > 0).sort((a, b) => b.饱腹 - a.饱腹)[0]
    if (顶饿) return run("物品.mjs", ["--吃", String(顶饿.x.n)]) || ("吃了包里的" + 顶饿.x.n)
    // ② 店里卖、带走类、买得起
    const 卖 = new Set((地图.地点[班.点] || {}).服务 || [])
    const 选 = Object.entries(shop.商品 || {})
      .filter(([n, v]) => 卖.has(n)
        && ["吃", "喝", "零食"].includes(String(v.类别 || ""))
        && String(v.吃法 || "") === "带走"
        && Number(v.饱腹 || 0) > 0
        && Number(v.价 || 0) <= 钱)
      .sort((a, b) => Number(b[1].饱腹 || 0) - Number(a[1].饱腹 || 0))[0]
    if (!选) {
      // 店里没得卖 / 都买不起：包里还有水就喝一口。
      // 水饱腹 0，但有临时量（12，按 45/小时掉，一杯顶十几分钟）—— 不顶饿，
      // 可总比干熬着强。主人 2026-11-07 特意提过这一条，别再把它当没用的东西筛掉。
      const 水 = 包里.filter((o) => o.临时 > 0).sort((a, b) => b.临时 - a.临时)[0]
      if (水) return run("物品.mjs", ["--吃", String(水.x.n)]) || ("喝了包里的" + 水.x.n)
      return ""
    }
    const 买 = run("花钱.mjs", ["--买", 选[0]])
    const 吃 = run("物品.mjs", ["--吃", 选[0]])
    if (!买) return ""
    // BUY_ONE_LINE 2026-11-06（批次149）：别把两个子进程的 stdout 拼进日志 ——
    // 那是「买了 自热饭，花 15 块，剩 252（还没吃…），自热饭收进包里了；坐下来吃自热饭，
    // 大概 12 分钟（00:12 吃完），自热饭这份吃完了」。一句话的事，拼成流水账没人读。
    // 失败时才把原文带出来，免得看不出断在哪一步。
    if (/还在吃/.test(吃)) return "这轮已经坐下吃了，等吃完再说"
    if (!吃) return (买 + "（没坐下来吃成，下一轮再看）").slice(0, 120)
    return `在店里买了份${选[0]}（${选[1].价} 块），坐下吃 ${选[1].分钟 || 8} 分钟`
  } catch { return "" }
}

// 渴了自己接水喝（批次151）。判据三条，都能对着数据说出来：
//   ① 嘴里没水了：饥饿.临时 < 3（一杯水 12，按 45/小时掉，约 16 分钟见底）
//   ② 距上次吃喝 ≥ 90 分钟（临时At 每次吃都写，包括吃饭 —— 刚吃完也不用喝）
//   ③ 有杯子、杯里空、脚下这地方接得到水
// 不花钱，所以不用问钱够不够；接完直接喝，走 吃饭.json 那套占用（3 分钟）。
function 渴了接水() {
  const run = (script, argv) => {
    try {
      return String(execFileSync(process.execPath, [path.join(TOOLS, script), ...argv], {
        encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" },
      }) || "").trim()
    } catch { return "" }
  }
  try {
    const h = 饥饿.读()
    if (!缺口应补水({ 水百分比: h.水百分比, 账: h.账, 现在: Date.now(), 水线: 50, 间隔分钟: 90 })) return ""
    const 杯 = 杯态()
    if (!杯 || !杯.在包) return ""
    const 地点 = String(load(path.join(MEM, "资产.json"), {}).位置 || "家")
    const 需接 = Number(杯.毫升 || 0) < 100
    const 能接 = (() => { try { return 物品能接水(地点) } catch { return false } })()
    if (需接 && !能接) return ""
    // 水位与冷却取饱渴账；进食造成的临时饱腹不冒充补水。
    const 接 = 需接 ? run("物品.mjs", ["--接水"]) : "杯里还有水"
    const 喝 = run("物品.mjs", ["--喝杯", "300"])
    if (!饮水动作成功({ 需接水: 需接, 接水出: 接, 可直接喝: !需接, 喝出: 喝 })) return ""
    return [需接 ? 接 : "", 喝].filter(Boolean).join("；") || 喝
  } catch { return "" }
}

// 该去的班：要么正在班内人还没到，要么 30 分钟内就开工。已经到点了也照样去（迟到总比缺勤好）。
function 该去的班(now = Date.now(), 提前分钟 = 30) {
  try {
    const 工 = load(path.join(MEM, '工作.json'), null)
    return 共享该去的班(工 && 工.班次, now, 提前分钟)
  } catch { return null }
}

function 抽签(top) {
  const 票 = []
  const add = (act, w) => { for (let i = 0; i < Math.max(0, Math.round(w)); i += 1) 票.push(act) }

  // UMBRELLA 2026-11-05：伞的两件事先算，不跟饿渴抢 ——
  // ① 借的伞过点了要还回去（押金在人家手里）
  // ② 下雨没伞：先看能不能借（押金会退，最划算），借不到再买
  if (该还伞) {
    const 借处 = String(该还伞.自 || "")
    if (借处 === 地点) add({ act: "还伞" }, 14)
    else if (地名.includes(借处)) add({ act: "去", 哪: 借处 }, 11)
  }
  if (缺伞 > 0) {
    const 这地 = 地图.地点[地点] || {}
    if ((这地.可借 || []).includes("雨伞")) add({ act: "借伞" }, 13 * (0.6 + 缺伞))
    const 卖伞 = 卖这个("雨伞")
    if (卖伞.includes(地点)) add({ act: "买伞" }, (钱 >= 25 ? 10 : 3) * (0.5 + 缺伞))
    else if (卖伞.length) add({ act: "去", 哪: 卖伞[0] }, 8 * (0.5 + 缺伞))
  }

  if (!top) {
    add({ act: "什么也不做" }, W("无缺口_闲着", 6))
    return 票
  }
  const 卖 = 卖这个(top.补)
  const 在卖点 = 卖.includes(地点)
  // ① 去卖点（不在卖点时才可能）
  if (卖.length && !在卖点) add({ act: "去", 哪: 卖[0] }, W("去卖点", 7) * (0.5 + top.强度))
  // EAT_HOME 2026-11-06（批次144）：人在家、家里存着吃的，先吃家里的。
  //
  // 这一票要比「直接买」重 —— 存着的东西不吃、顿顿买新的，那就白存了，
  // 主人要的「零食牛奶买回家放着」也就没意义。只对「饿」生效：
  // 渴了还是得看有没有喝的（家里那包饼干解不了渴）。
  const 家里吃的 = 物表.filter((x) => x.在 === '家'
    && ['吃', '喝', '零食'].includes(String(x.类 || ''))
    && (top.kind === '渴' ? String(x.类 || '') === '喝' : true))
  if (top.kind === '饿' || top.kind === '渴') {
    if (地点 === '家' && 家里吃的.length) {
      add({ act: '吃存货', 物: String(家里吃的[0].n) }, W('吃存货', 12) * (0.6 + top.强度))
    }
  }
  // ② 直接买（钱够概率高，不够也允许偶尔硬买，会花到见底）
  if (在卖点 || !卖.length) {
    const 够 = 钱 >= top.价
    add({ act: "花", 物: top.补 }, (够 ? W("买得起", 9) : W("买不起也硬买", 1)) * (0.6 + top.强度))
  }
  // ③ 打工（越缺越可能去，但累了也挡不住偶尔硬去）
  //
  // WEIGHT_MIN 2026-11-06（批次146）：原来这里是 `add({...}, 浮点权重)`，
  // 而 add 内部是 `Math.round(w)` —— 权重 6×(0.5+强度)×(1-累度/2) 在「体力 27、缺 72%」
  // 这种真实局面下算出来是 4.6，本该有 4 票；可一旦某天 强度 读到 undefined 就变 NaN，
  // `Math.round(NaN)` 让循环一次都不进 —— 选项静默消失，日志里只剩一句
  // 「这次完全不可能：去打工」，看不出是没票还是没这段代码。
  // 现在权重至少 1 票，并且 NaN 一律按「有点缺」兜底：宁可多去一趟，也别让一条活凭空没了。
  const jobs = 打工选()
  if (jobs.length) {
    const 干得动 = jobs.filter((j) => j.耗体力 <= Math.max(0, energy - 10))
    const 选 = (干得动[0] || jobs[0])
    const 招处 = 招这个(选.name)
    const 累度 = 1 - Math.min(1, energy / 100)
    const 缺强 = Number(top && top.强度)
    const 强 = Number.isFinite(缺强) ? 缺强 : 0.3
    if (招处.length && !招处.includes(地点)) {
      add({ act: "去打工", 去哪: 招处[0], 活: 选.name },
        Math.max(1, W("去打工点", 6) * (0.5 + 强) * (1 - 累度 * 0.5)))
    } else if (招处.includes(地点)) {
      add({ act: "挣", 活: 选.name },
        Math.max(1, W("就地打工", 8) * (0.5 + 强) * (1 - 累度 * 0.6)))
    }
  }
  // ④ 开口要钱（钱少、累、闷的时候更想开口，但「今天求过了」会大幅压低）
  const 今天 = bj().slice(0, 10)
  const 求过 = (台账.asks || []).filter((a) => String(a.at || "").startsWith(今天)).length
  add({ act: "要", n: Math.max(30, top.价 - 钱 + 20) }, (W("要钱", 5) * (0.4 + 穷) * (1 - Math.min(0.85, 求过 * 0.5))) || 0)
  // ⑥ 该上班了。权重给得很高：迟到要扣钱、缺勤要掉信用，这两件事压过逛街和买东西。
  // 位置已经在班上就不出这张票（到了就在店里待着，由 工作.mjs 打卡）。
  const 该去 = 该去的班()
  if (该去 && String(该去.点 || "") !== 地点) {
    add({ act: "去上班", 去哪: 该去.点, 活: 该去.活 }, 该去.急 === 0 ? 24 : 18)
  }
  // ⑤ 忍着（永远留一票，谁都有算了的时候）
  add({ act: "忍" }, W("忍着", 3) * (0.5 + (1 - 穷)))
  return 票
}

const top = 缺[0] || null
// SLEEP_GUARD 2026-11-05：睡着的时候不补缺口——睡着的人不会半夜爬起来去买奶茶
if (args.includes("--tick")) {
  if (睡着(MEM)) { console.log("她在睡，不补缺口"); process.exit(0) }
  // NAP_GUARD 2026-11-06（批次134）：打盹也不补缺口，道理跟睡着一样。
  // 打盹不写 睡醒.json（会把清醒时长清零），所以这里单独认一次。
  // 批次167：判据挪到 占用.mjs（跟 睡态.打盹中 同一份：先看 到毫秒，退回 到）。
  if (在打盹(MEM)) { console.log("她在打盹，不补缺口"); process.exit(0) }
  // EAT_GUARD 2026-11-06（批次144）：坐在那儿吃的时候不补缺口。
  //
  // 缺口每 30 分钟抽一次签，一签就可能抽到「去街市逛逛」—— 她火锅才吃了一半。
  // 跟 SLEEP_GUARD / NAP_GUARD / WORK_HOLD 同一个道理：
  // 人不方便动的时候，就别安排需要动的事。
  // 批次167：判据在 占用.mjs（判 `到` 不判文件存在 —— 文件常在，只是吃完了）。
  const __饭 = 在吃饭(MEM)
  if (__饭) {
    console.log('在' + (__饭.在哪 || '家') + '吃' + __饭.吃啥 + '，吃完再说')
    process.exit(0)
  }

  // INTRAVEL 2026-11-06（批次132）：在途的时候也不补缺口。
  //
  // 地点取的是 资产.位置，那是「上一个待过的地方」；人正走在路上时它会撒谎。
  // 于是她走去上班的那几分钟里，缺口完全可能给她「在家买个早饭」（账本上就多一笔
  // 家·买早饭，人却在路上），或者抽到「去街角逛逛」把 在途 改掉——走一半被叫走。
  // 跟 SLEEP_GUARD / WORK_HOLD 同一个道理：人不在这儿，就别安排这儿的事。
  // 注意别用 资产.到此At 判：到达后 在途 会清掉，这里只看它还在不在、有没有到点。
  const __途中 = asset["在途"]
  if (__途中 && Number(__途中.arriveAt) > Date.now()) {
    console.log("正在从" + (__途中.from || "?") + "去" + (__途中.to || "?") + "，路上不补缺口")
    process.exit(0)
  }
  // ── 渴了自己接水喝（批次151，主人 2026-11-07）──────────────
  // 放在 在途 之后：人正走在路上，没地方接。
  // 放在 WORK_HOLD 之前：上班的便利店也是室内，接杯水站着喝两口不耽误守店 ——
  // 而且 上班吃一口 只管「饿」不管「渴」，放在它后面就永远轮不到。
  const 水话 = 渴了接水()
  if (水话) { console.log(水话); process.exit(0) }

  // WORK_HOLD 2026-11-06（批次112）：在岗的时候不补缺口。
  // 她 22:00 在便利店守夜班，缺口这一分钟完全可能抽到「去街市逛逛」，
  // 一搬人就成了「上班上到一半人不见了」—— 这不是她想翘班，是系统没问过她有没有班。
  const __班 = 在岗的班(MEM)
  if (__班) {
    // WORK_MEAL 2026-11-06（批次146）：上班不是不吃不喝。
    //
    // 这一条闸把缺口整个拦掉之后，实测跑出来的第一个夜班：饱腹 30.6、距上次吃 1 小时，
    // 到 06:00 会是 0 —— 人就在便利店里，柜台后面全是包子和水，8 小时一口不动。
    // 但让她离开工位去买饭也不行，那就成翘班了。所以只做一件事：
    // 饱腹 < 45 且距上次吃 ≥ 3 小时，就地吃一份「带走」的东西。不堂食、不占座、不挪窝。
    const 吃话 = 上班吃一口(__班)
    console.log("在" + __班.点 + "上班（" + __班.活 + "），不补缺口" + (吃话 ? "；" + 吃话 : ""))
    process.exit(0)
  }
}
// 试要 2026-11-05（批次100）：「要」这条分支要能单独验，不能靠掷骰子撞上。
// 跟 自主行动 的 --试走动 / --试洗澡 一个道理：只用于测分支，正常不会传。
const 试要 = args.includes("--试要")
const 票 = 试要 ? [] : 抽签(top)
// WEIGHT_SANITY 2026-11-05：权重配成 0/负数会让某个选项静默消失（评审点到的坑）。
// 这里把「这一次完全没票的动作」算出来，看的时候直接说——不是等以后发现她从来不打工。
const 零票 = ['去', '花', '挣', '去打_工'.replace('_',''), '要', '忍'].filter((a) => !票.some((t) => t.act === a))
// 固定抽（--seed N）方便复现，默认随机
const seed = Number(val("--seed", "0")) || Math.floor(Math.random() * 1e9)
let x = seed % 2147483647 || 1
const rnd = () => ((x = (x * 48271) % 2147483647) / 2147483647)
const 选 = 试要
  ? { act: "要", n: Number(val("--n", "30")) || 30 }
  : (票.length ? 票[Math.floor(rnd() * 票.length)] : { act: "什么也不做" })

// 统计一下各票占多少，给她自己（和主人）看倾向
function 分布() {
  const m = {}
  for (const t of 票) m[t.act] = (m[t.act] || 0) + 1
  return Object.entries(m).map(([k, v]) => `${k} ${Math.round((v / 票.length) * 100)}%`).join("｜")
}

function 执行(a) {
  const run = (script, argv) => {
    try { return execFileSync(process.execPath, [path.join(TOOLS, script), ...argv], { encoding: "utf8" }).trim() }
    catch (e) { return "（没做成：" + String(e.message).slice(0, 30) + "）" }
  }
  // MOVE_SINGLE 2026-11-07（批次166）：这里的 同步搬动() 删了。
  // 它原来干的事（人动了就把 自主.json 对齐）现在由 走路.mjs → 移动.出发() 一处做完，
  // 而且做得更准：place 写【出发地】不是目的地 —— 人还在路上，先说到了就是撒谎。
  // 当时这里是「线下活动才改成走动、线上活动不动」，qq_go 是「无条件走动」，
  // 走路到达是「只有 state 还是走动才重置计时」，三份规则三种，加第四个入口时又漏了一个。
  // SHOWER_LOCK 2026-11-05（批次101）：洗澡这二三十分钟她人在浴室，不能一边冲水一边被搬去便利店。
  // 缺口每小时重挑「现在该干嘛」，以前完全不知道 洗澡.mjs 已经把这间浴室占了 ——
  // 走到一半、甚至洗到一半被搬家，对话侧还会说她「在走动」。
  try {
    const hy = JSON.parse(fs.readFileSync(path.join(MEM, "卫生.json"), "utf8"))
    const washEnd = Date.parse(String(hy?.洗澡中?.结束 || "").replace(" ", "T") + ":00+08:00")
    if (Number.isFinite(washEnd) && washEnd > Date.now()) return "在洗澡，先不走"
  } catch { /* 没在洗就照常 */ }
  if (a.act === "去") {
    return run("走路.mjs", ["--去", a.哪]) || ("出发去" + a.哪)
  }
  // ITEMS 2026-11-05：伞的三件事都走 物品.mjs —— 借钱、押金、该还不该还全在那儿算，
  // 这里只管「她现在想做哪一件」，别在两边各记一份账。
  if (a.act === "借伞") return run("物品.mjs", ["--借", "雨伞"]) || "想借把伞"
  if (a.act === "买伞") return run("物品.mjs", ["--买", "雨伞"]) || "想买把伞"
  if (a.act === "还伞") return run("物品.mjs", ["--还", "雨伞"]) || "想把伞还了" 
  if (a.act === "吃存货") return run("物品.mjs", ["--吃", a.物])
  if (a.act === "花") return run("花钱.mjs", ["--买", a.物])
  // WISH_2026-11-06（主人要求）：打工不再由文件替她决定。
  // 只把「此刻想去挣这笔钱」记成一条心愿，去不去、什么时候去，由她自己当场定。
  if (a.act === "挣") {
    // TEMP_SHIFT 2026-11-06（批次146）：临时工真开班。
    // 以前这里只写一条「想挣一笔，还没动手」——人站在打工点，钱一分不会来。
    // 现在把开班交给 工作.mjs --临时：起一段真时长，在岗按分钟算，下班按表现结。
    const 话 = run("工作.mjs", ["--临时", "--活", a.活]) || ("想挣一笔（" + a.活 + "）")
    return 话
  }
  if (a.act === "去打工") {
    // WISH_2026-11-06 的原意是「不替她跑腿」，可结果是这条活彻底死掉：
    //   只剩发传单一个临时工有票，抽中了只写一条心愿，人还在原地，
    //   到了 打工点 也没有任何动作能开工 —— 心愿攒了 30 条，一次活没干过。
    // 抽签抽中就是「她想去」，跟「去上班」一样要有一条腿。走过去的路上由 走路.mjs 记在途。
    const 愿P = path.join(MEM, "想干的活.json")
    const 愿 = load(愿P, { items: [] })
    愿.items = [...(愿.items || []), { at: bj(), kind: "去打工", 去哪: a.去哪, 活: a.活, 地点 }].slice(-30)
    save(愿P, 愿)
    return run("走路.mjs", ["--去", a.去哪]) || ("去" + a.去哪 + "找活：" + a.活)
  }
  // 去上班：到了之后 工作.mjs 下一分钟自己打卡（它只看位置在不在班上），
  // 所以这里只管把人送过去，不在两处各写一份考勤。
  if (a.act === "去上班") {
    return run("走路.mjs", ["--去", a.去哪]) || ("去上班：" + a.活)
  }
  if (a.act === "要") {
    // ASK_BY_HERSELF 2026-11-05（批次100）：不再替她写要钱的话。
    //
    // 原来这里拼一句「那个……我钱不太够了，能不能给我转 N 块呀。我之后打工还你。」
    // 塞进 留言.json，由 投递留言.mjs 直接发到他手机上 —— 她本人不知道，话也不是她说的。
    // 批次81 已经吃过一次同款亏：给钱后自动道谢，她当场已经谢过，于是同一件事回两次，
    // 第二次还不是她说的。而且「我之后打工还你」是句承诺，她压根没打算过。
    //
    // 现在只记「她想开口」这个事实（什么时候、想多少、为什么），
    // 由 poll.js 当成一句话递到她眼前 —— 说不说、什么时候说、怎么说，她自己定。
    // 记在 想开口.json 而不是 留言.json：留言那条路是「直接发到他手机上」，没有她开口这一步。
    const 想P = path.join(MEM, "想开口.json")
    const 想 = load(想P, { items: [] })
    想.items = [...(想.items || []), { at: bj(), n: a.n, 为什么: "钱不够" }].slice(-20)
    save(想P, 想)
    改档(台账P, (latest) => {
      latest.asks = [...(latest.asks || []), { at: bj(), n: a.n }].slice(-50)
    }, { asks: [], worked: [], log: [] })
    return `想跟他开口要 ${a.n} 块（还没说出口）`
  }
  if (a.act === "忍") {
    try { execFileSync(process.execPath, [path.join(TOOLS, "激素.mjs"), "--event", "饿", "--id", 'gap:resist:' + bj()], { encoding: "utf8" }) } catch (_err) { console.error('[缺口]', _err?.message || _err) }
    return "算了，忍一忍"
  }
  return "什么也不做"
}

// 念头 2026-11-07（主人原话「抽中了只是告诉你 就像是你觉得你应该去做了 但是你要不要去做还得是你来决定」）：
// --tick 不再替她做事，只把这一刻想到什么记一行；做不做、什么时候做，由她自己看着办。
// 真要动手，得显式带 --真做（我手动调），或者她自己拿别的工具去做。
const 念头P = path.join(MEM, "念头.jsonl")
// 渴和饿的当下数，从 饥饿 这层拿（它后面已经接到新的毫升/千卡账上了）
function 读渴() {
  try { return 饥饿.读() } catch { return null }
}

// 惦记 2026-11-07（主人原话「那你自己用那个缺口文件改一改」）：
// 渴了饿了这种事不能只写在没人看的本子上——顺手在「惦记」里挂一句，
// 那一行每轮都会摆到她眼前，她自己去接水或买吃的，不用等人催。
function 挂惦记(话) {
  try {
    const p = path.join(MEM, '惦记.jsonl')
    const 旧 = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
    const 有了 = 旧.split('\n').some((l) => {
      if (!l.trim()) return false
      try { const j = JSON.parse(l); return j && j.done !== true && String(j.what || '') === 话 } catch { return false }
    })
    if (!有了) 写惦记(MEM, 话, bj())
  } catch (_err) { console.error('[缺口]', _err?.message || _err) }
}

function 记念头(a, 详情) {
  // 水位提醒 2026-11-07（主人原话「80% 吧 之后每下降 5% 再提醒一次」）：
  // 按真实百分比走——头一回在八成，此后每掉满五个点念一次；喝回去水位跟着抬。
  // 别拿「取整到五」去比，那样 77% 就会被当成 75% 提前念（第一版就是这么错的）。
  try {
    const 渴 = 读渴()
    if (渴) {
      const P = path.join(MEM, "提醒水位.json")
      const 水 = fs.existsSync(P) ? JSON.parse(fs.readFileSync(P, "utf8")) : {}
      const 渴数 = Number(渴.水百分比) || 0
      const 饿数 = Number(渴.食物 ?? 渴.卡百分比) || 0
      const 上次渴 = Number.isFinite(水.渴) ? 水.渴 : 100
      const 上次饿 = Number.isFinite(水.饿) ? 水.饿 : 100
      if (渴数 <= 80 && 渴数 <= 上次渴 - 5) {
        // HINT_PLAIN 2026-11-08（批次272）：惦记是她心里冒出来的一句话，不该带百分比。
        // 主人原话「心里话不要写数值 显得机械化 功利化」。
        挂惦记("该喝口水了")
        水.渴 = 渴数
      } else if (渴数 > 上次渴) 水.渴 = 渴数      // 喝回去了，水位抬上来
      if (渴数 >= 65) 销账生理惦记(MEM, "该喝口水了", bj())
      if (饿数 <= 80 && 饿数 <= 上次饿 - 5) {
        挂惦记("有点空了，找点吃的")
        水.饿 = 饿数
      } else if (饿数 > 上次饿) 水.饿 = 饿数
      if (饿数 >= 60) 销账生理惦记(MEM, "有点空了，找点吃的", bj())
      fs.writeFileSync(P, JSON.stringify(水))
    }
  } catch (_err) { console.error('[缺口]', _err?.message || _err) }

  // ASK_WRITE 2026-11-14（批次395）：「要」这个动作的产物是「心里搁着一件事」，不是「真去要钱」——
  // 所以它该在 --tick（只记念头）的时候就写进 想开口.json。
  //
  // 原来这段写在 执行() 里，而 执行() 只有 --真做 才调（625 行），心跳表给的参数是 --tick。
  // 于是：缺口.mjs 抽中「要」→ 只记一条念头 → 想开口.json 不写 → poll.js 那三个消解条件
  // 永远读不到 →「心里还搁着一件事：想跟他开口要 N 块」这句话从 11-07 起就没再出现过。
  // 实测证据：日志里「这次抽到：要」15 次（11-07 06:00 ~ 11-13 22:00），
  // 而 想开口.json 的 mtime 还停在 11-06 18:00，里面只有两条。
  if (a.act === '要' && Number(a.n) > 0) {
    try {
      const 想P2 = path.join(MEM, '想开口.json')
      const 想2 = load(想P2, { items: [] })
      想2.items = [...(想2.items || []), { at: bj(), n: Number(a.n), 为什么: '钱不够' }].slice(-20)
      save(想P2, 想2)
    } catch { /* 写不进去不影响记念头 */ }
  }

  const 行 = { at: bj(), 想到: a.act, 建议: 详情 || "", 钱: 钱, 体力: energy, 困意, 心情: mi, 在哪: 地点 }
  try { fs.appendFileSync(念头P, JSON.stringify(行) + "\n") } catch (_err) { console.error('[缺口]', _err?.message || _err) }
  return 详情 || ""
}
const 详情 = args.includes("--tick")
  ? (args.includes("--真做") ? 执行(选) : 记念头(选, ""))
  : ""
if (args.includes("--tick")) {
  改档(台账P, (latest) => {
    latest.log = [...(latest.log || []), { at: bj(), top: top ? top.kind : null, 选, 详情 }].slice(-200)
  }, { asks: [], worked: [], log: [] })
}

if (args.includes("--看") || args.length === 0 || args.includes("--tick")) {
  console.log(`钱 ${钱}｜体力 ${energy}｜困意 ${困意}｜心情 ${mi}｜人在${地点}`)
  if (缺伞 > 0) console.log(`  缺伞 ${(缺伞 * 100).toFixed(0)}%：${伞的话}${在下雨 ? "（外面在下雨）" : ""}`)
  if (该还伞) console.log(`  该还伞：借自${该还伞.自}，${String(该还伞.该还).slice(5)} 就到期了`)
  if (!缺.length) console.log("现在不怎么缺")
  else for (const x2 of 缺) console.log(`  缺${x2.kind} ${(x2.强度 * 100).toFixed(0)}%：想用 ${x2.补}（${x2.价} 块）`)
  console.log(`倾向：${分布()}`)
  if (票.length && 零票.length) console.log(`这次完全不可能：${零票.join('、')}`)
  console.log(`这次抽到：${选.act}${详情 ? " → " + 详情 : ""}`)
  if (!args.includes("--tick")) console.log("（--tick 只记一个念头；真要动手得我调 --真做）")
  process.exit(0)
}

// USAGE397 2026-11-14：原来这句没提 --试要，害得上一批（395）误判「这个旗标永远跑不了」。
// 它其实要配 --看 一起用（单独给只会落到这句用法上）。缺了它在用法里，下一个看代码的人还会再误判一次。
console.log("用法：--看 [--试要] / --tick [--seed N] / --看 --seed N")
