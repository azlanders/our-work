// 契约检查.mjs —— 数据格式对不对得上：脚本假定什么，文件里就得有什么
// 用法：node 契约检查.mjs
// 为什么这么写：这套东西靠「文件当接口」，一个字段名打错、一个地点漏了 kind，
// 不会报错，只会让她那一头的行为悄悄变怪。所以把暗契约写成明检查。
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
// 表口径 2026-11-07（批次156）：商品不再只有 商店-生活.json 一份，
// 衣服在 衣物表.json、服务在 物品总表.分组.服务。检查必须走门面，否则会误报。
import { 所有 as 全部条目, 撞价, 孤儿 } from './表.mjs'
// BODY 2026-11-07（批次163）：身体/天气这几个接口的口径要钉住 —— 它们缺字段不报错，
// 只会让她那一头悄悄算错（脖子永远露着、风永远 0 级、海边当成有暖气）。
import { 九部位, 权重 } from './穿衣.mjs'
// BATCH288 2026-11-08：契约要真调一次解析，不能只比源码字符串。
import { 一笔 } from './账本.mjs'
import * as 待办 from './待办.mjs'   // TODO_SYNC 2026-11-14（批次409）

// ENTRY_GUARD 2026-11-14（批次458）：这个脚本顶层就是整条主流程，末尾还有 process.exit。
// 被 import 时（冒烟测试逐个 import）它会**真跑一遍**：实测冒烟跑一次 = 顺带跑两遍契约检查
// + 两遍自检，光这两项就往真档写了 538 次；而且 import 到一半 process.exit 直接把冒烟子进程
// 带走，冒烟那边只能记成「主动退出」，等于「加载测试」从来没真测过它。
// 现在只有 `node <本文件>` 这条路径才执行主流程；被 import 时只是一个空模块。
const 是入口 = (() => {
  try { return !!process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {


const DIR = "{{BOT_ROOT}}"
const TOOLS = path.join(DIR, "共享/工具")
const MEM = path.join(DIR, "记忆")
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }

const 问题 = []
const 好 = []
const 查 = (cond, 名, 说明) => (cond ? 好.push(名) : 问题.push(`${名}：${说明}`))

const 地图 = load(path.join(TOOLS, "地图.json"), { 地点: {} })
const 商店 = load(path.join(TOOLS, "商店-生活.json"), { 商品: {}, 打工: {} })
const 状态 = load(path.join(MEM, "状态.json"), {})
const 资产 = load(path.join(MEM, "资产.json"), {})

// 1) 地点必须有坐标、路程、类别；「家」必须存在且路程 0
const 地名 = Object.keys(地图.地点 || {})
查(地名.includes("家"), "地图有家", "缺少「家」这个地点")
for (const n of 地名) {
  const p = 地图.地点[n]
  查(typeof p.x === "number" && typeof p.y === "number" && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100, `地点坐标 ${n}`, "x/y 必须是 0~100 的数")
  查(Number.isFinite(Number(p.t)) && Number(p.t) >= 0, `地点路程 ${n}`, "t 必须是大于等于 0 的数")
  查(typeof p.kind === "string" && p.kind.length > 0, `地点类别 ${n}`, "缺 kind，活动脚本会认不出该给什么效果")
  // BODY 2026-11-07（批次163）：室内 是穿衣/体温判冷暖的唯一依据。缺了它不会报错，
  // 只会退回到一张手写的「打工点/街市/公园露天」名单 —— 游乐园和海边就是这么被当成有暖气的。
  查(typeof p.室内 === "boolean", `地点室内 ${n}`, "室内 必须是 true/false")
  查(Array.isArray(p.服务), `地点服务 ${n}`, "服务 必须是数组（没有就给空数组）")
  查(Array.isArray(p.招工), `地点招工 ${n}`, "招工 必须是数组")
}
查(Number(地图.地点["家"]?.t) === 0, "家的路程", "家的 t 应该是 0")

// 2) 要卖的东西必须有价、有售卖点，且售卖点都得是地图上真实存在的地方
//    家具（书桌/台灯/水杯）不卖，没有售卖点，不要求有价。
const 全部 = 全部条目()
const 商品名 = Object.keys(全部).filter((n) => (全部[n].售卖点 || []).length || 全部[n].类别 === "服务")
查(Object.keys(全部).length > 0, "总表非空", "物品总表.json + 衣物表.json 里没有东西")
for (const n of 商品名) {
  const it = 全部[n]
  查(Number.isFinite(Number(it.价)) && Number(it.价) > 0, `商品价格 ${n}`, "要卖的东西 价 必须是正数")
  查(Array.isArray(it.售卖点) && it.售卖点.length > 0, `商品售卖点 ${n}`, "缺售卖点，缺口脚本会找不到该去哪买")
  查(Array.isArray(it.售卖点) && it.售卖点.every((p) => 地名.includes(p)), `商品售卖点有效 ${n}`, "售卖点里有地图上不存在的地方")
}
// 3) 商品的售卖点 和 地图的服务 必须双向一致
for (const n of 商品名) {
  for (const p of (全部[n].售卖点 || [])) {
    if (地名.includes(p) && !(地图.地点[p].服务 || []).includes(n)) 问题.push(`不一致：${p} 的服务里没有「${n}」（总表写了它在那儿卖，跑一次 node 同步表.mjs --写）`)
  }
}
for (const p of 地名) {
  for (const it of (地图.地点[p].服务 || [])) {
    if (!全部[it]) 问题.push(`不一致：${p} 卖「${it}」，但总表里没这样东西`)
  }
}
// 4) 打工：地点招工 与 打工表 必须对得上
for (const p of 地名) {
  for (const j of (地图.地点[p].招工 || [])) {
    if (!商店.打工[j]) 问题.push(`不一致：${p} 招「${j}」，但打工表里没有`)
  }
}
for (const j of Object.keys(商店.打工 || {})) {
  const 有处 = 地名.some((p) => (地图.地点[p].招工 || []).includes(j))
  if (!有处) 问题.push(`不一致：打工「${j}」没有任何地方招`)
}
// 5) 状态：四层必须有
for (const k of ["physical", "emotional", "cognitive", "existential"]) {
  查(typeof 状态.layers?.[k] === "number", `状态层 ${k}`, "layers 里缺这一层")
}
查(Number.isFinite(Number(状态.困意)), "状态困意", "困意 必须是数字")
// 6) 资产：位置必须是地图上的地方或在途
const 位置 = 资产.位置
查(地名.includes(位置) || 位置 === "床上", "资产位置", `位置「${位置}」不是地图上的地方`)
if (资产.在途) {
  查(地名.includes(资产.在途.to), "在途目的地", "在途的 to 不是地图上的地方")
  查(Number.isFinite(Number(资产.在途.arriveAt)), "在途到达时间", "在途缺 arriveAt")
}

// DERIVED_SCORE 2026-11-05：好感度的 score 是「first + 各维度 + 思念」现算出来的，
// 不是存着不动的数字——主人要的 60 被我写成存值，下次一重算就掉回 42。
// 这里按同一套公式复算一遍，和文件里存的比，不一致就报（说明有人直接改存值了）。
try {
  const 好感 = load(path.join(MEM, "好感度.json"), { people: {} })
  const V2 = Number(好感.version) === 2
  const DIM_CAP = { 需求匹配: 20, 相似性: 12, 熟悉度: 10, 性格特质: 10, 情绪唤起: 8 }
  for (const [who, p] of Object.entries(好感.people || {})) {
    // V2 2026-11-09（批次299）：v2 存四个状态，score 只是渲染。
    // 公式：0.5×亲近 + 0.3×安全 + 0.2×兴致（保留一位小数）
    if (V2) {
      const d = p.dims || {}
      const 应为 = Math.round((0.5 * Number(d["亲近"] ?? 40) + 0.3 * Number(d["安全"] ?? 55) + 0.2 * Number(d["兴致"] ?? 45)) * 10) / 10
      if (Number(p.score) !== 应为) 问题.push(`好感度分数不一致：${who} 文件里 ${p.score}，v2 公式算是 ${应为}（有人直接写了存值）`)
      if (d["亲近"] === undefined || d["安全"] === undefined || d["兴致"] === undefined) 问题.push(`好感度 v2 缺维度：${who}`)
      continue
    }
    // UNIFY 2026-11-05：v1 的五维公式（历史档，迁移后不再走这条）
    const first = Number.isFinite(Number(p.first)) ? Number(p.first) : 40
    let s0 = first
    for (const [k, v] of Object.entries(p.dims || {})) {
      const cap = DIM_CAP[k] ?? 10
      s0 += Math.max(-cap, Math.min(cap, Number(v) || 0))
    }
    s0 += Math.max(0, Math.min(5, Math.round(Number(p["思念"] || 0) / 2)))
    const 应为 = Math.max(0, Math.min(100, Math.round(s0)))
    if (Number(p.score) !== 应为) 问题.push(`好感度分数不一致：${who} 文件里 ${p.score}，公式算是 ${应为}（有人直接写了存值）`)
  }
} catch (e) { 问题.push("好感度检查失败：" + e.message) }

// 7) 表口径：同名不同价、商店有总表没有
const 撞 = 撞价()
const 孤 = 孤儿()
查(!撞.length, "表不撞价", `同名不同价：${撞.map((x) => x.名).join("、")}（改总表，再跑 node 同步表.mjs --写）`)
查(!孤.length, "表没孤儿", `商店表有但总表没有：${孤.join("、")}（买到也算不出饱腹）`)

// 8) 身体与天气：2026-11-07 新接上的接口
//    · 地图 室内 必须是布尔 —— 穿衣/体温判冷暖只认它（缺了会退回旧的手写露天名单）
//    · 天气 风 必须有 级/米/话，24 小时都得有 风（体温按风折算，缺一项等于没风）
//    · 衣物 覆盖 的键必须在 九部位 里（写错一个字，那格永远露着），成数 0~1
//    · 穿衣 权重 总和必须是 1（改了面积不归一，保暖合计就飘）
const 天气 = load(path.join(MEM, "天气.json"), {})
查(天气.风 && Number.isFinite(Number(天气.风.级)), "天气有风级", "天气.json 缺 风.级")
查(天气.风 && Number.isFinite(Number(天气.风.米)), "天气有风速", "天气.json 缺 风.米（米/秒）")
查(天气.风 && typeof 天气.风.话 === "string" && 天气.风.话.length > 0, "天气有风话", "天气.json 缺 风.话")
查(Array.isArray(天气.小时) && 天气.小时.length === 24, "天气小时齐全", "小时[] 不是 24 项")
查(Array.isArray(天气.小时) && 天气.小时.every((h) => Number.isFinite(Number(h.风))), "天气逐时有风", "小时[] 里有项缺 风")
const 衣物 = load(path.join(MEM, "衣物表.json"), { 件: {} })
for (const [名, it] of Object.entries(衣物.件 || {})) {
  const 盖 = it && it.穿 && it.穿.覆盖
  if (!盖 || typeof 盖 !== "object" || Array.isArray(盖)) continue
  for (const [部, 成] of Object.entries(盖)) {
    查(九部位.includes(部), `衣物覆盖部位 ${名}/${部}`, `覆盖里写了不存在的部位「${部}」`)
    查(Number.isFinite(Number(成)) && Number(成) >= 0 && Number(成) <= 1, `衣物覆盖成数 ${名}/${部}`, "覆盖成数必须是 0~1")
  }
}
查(Object.keys(权重).length === 九部位.length && 九部位.every((部) => 部 in 权重), "穿衣权重齐全", "权重 和 九部位 对不上")
const 权和 = Object.values(权重).reduce((a, b) => a + b, 0)
查(Math.abs(权和 - 1) < 0.001, "穿衣权重归一", `权重合计 ${权和}，应该是 1`)

// 9) 静态：地图只有 共享/工具/地图.json 一份。谁再写「读记忆目录下的地图」，读到的永远是空。
//    只匹配真正会执行到的写法（path.join(MEM, '地图.json') / 绝对路径），注释里提到不算。
const 读错图 = []
try {
  for (const f of fs.readdirSync(TOOLS)) {
    if (!f.endsWith('.mjs') || f === '契约检查.mjs') continue
    const 行们 = fs.readFileSync(path.join(TOOLS, f), 'utf8').split('\n')
    行们.forEach((行, i) => {
      const t = 行.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return   // 注释里提到不算
      if (!t.includes('地图.json')) return
      // 真正会读到错地方的三类写法：path.join(MEM, '地图.json')、require('path').join(MEM, …)、绝对路径
      if (!/\bMEM\b|记忆\/地图\.json|base\.replace/.test(t)) return
      读错图.push(f + ':' + (i + 1))
    })
  }
} catch (e) { 读错图.push('（扫不动：' + e.message + '）') }
查(!读错图.length, "没人读错地图路径", `这些脚本在读 记忆/地图.json：${读错图.join("、")}（地图在 共享/工具/地图.json，用 地点.读图()）`)

// 10) 批次164：底层模块在位 + 睡醒标记是布尔。
//     睡醒.json 的 sleeping 不是布尔时，门控判不出「在睡/醒着」，
//     要么永远拦住她、要么永远放行 —— 两种都像「叫不醒」。
查(fs.existsSync(path.join(TOOLS, '睡态.mjs')) && fs.existsSync(path.join(TOOLS, '_底层.mjs')),
  "底层模块在位", "睡态.mjs / _底层.mjs 不在：所有 import 它们的脚本会直接启动失败")
{
  const 睡醒 = load(path.join(MEM, '睡醒.json'), null)
  查(睡醒 && typeof 睡醒.sleeping === 'boolean', "睡醒标记是布尔",
    "睡醒.json 的 sleeping 必须是 true/false（现在是 " + JSON.stringify(睡醒 && 睡醒.sleeping) + "）")
}

// 11) 底座自检（批次165）：_底层 被 27 个模块 import、睡态 被 16 个 ——
// 它们错一个字，整个 cron 全线起不来。自检里有 41 条断言 + 三条源码结构约束
//（原子写那部分单线程行为测不出来，只能锁实现）。
try {
  const 出 = execFileSync('/usr/local/bin/node', [path.join(TOOLS, '自检.mjs')], { encoding: 'utf8', timeout: 40000 })
  查(true, '底座自检', String(出 || '').trim().split('\n').pop() || '')
} catch (e) {
  const 报 = String((e.stdout || '') + (e.stderr || '') || e.message)
    .split('\n').filter((x) => x.includes('✗')).join(' / ')
  查(false, '底座自检', (报 || '退出码 ' + e.status).slice(0, 400))
}

// 11b) 回归用例（批次175）：**这套从批次164 起就一直在报错**。
//      它把 状态推进.mjs 拷进沙盒真跑，但依赖是写死的（只拷 _状态.mjs）；批次164 加了
//      睡态/_底层/自主状态/占用/在干嘛/恢复目标/饱渴 之后，每次跑都是 ERR_MODULE_NOT_FOUND。
//      而它不在 cron 里 —— 挂了也没有任何人会知道。
//      现在依赖改成顺着 import 递归拷（回归用例.mjs 的 拷依赖），并且挂到这里：
//      契约检查每周一跑，它挂了就是红的。**测试台没人跑，等于没有测试台。**
try {
  const 出 = execFileSync('/usr/local/bin/node', [path.join(TOOLS, '回归用例.mjs')], { encoding: 'utf8', timeout: 180000 })
  查(true, '回归用例', String(出 || '').trim().split('\n').pop() || '')
} catch (e) {
  const 报 = String((e.stdout || '') + (e.stderr || '') || e.message)
    .split('\n').filter((x) => x.includes('[!!]') || x.includes('ERR_')).join(' / ')
  查(false, '回归用例', (报 || '退出码 ' + e.status).slice(0, 400))
}

// 11c) 静态检查（2026-11-12）：专查「引用了没定义的名字」。
//      node --check 只验语法；这类错语法合法，只有真走到那一行才崩 —— 线上那一行多半包在 try/catch 里，
//      崩了没声音。11-12 一次审计靠人工翻出 5 处（睡醒结算静默失败两天多、洗澡必卡死、病中倾向从没生效、
//      状态审计一条没写、死会话恢复必抛错），而当天 自检/契约 全绿。
//      **门禁里没有一条管这个，就会再发生一次。**
try {
  const 出 = execFileSync('/usr/local/bin/node', [path.join(TOOLS, '静态检查.mjs')], { encoding: 'utf8', timeout: 120000 })
  查(true, '静态检查', String(出 || '').trim().split('\n').pop() || '')
} catch (e) {
  const 全部 = String((e.stdout || '') + (e.stderr || '') || e.message)
  const 报 = 全部.split('\n').filter((x) => x.includes('✗')).slice(0, 6).join(' / ')
  // 退出码 2 = eslint 没装。宁可红也别绿：门禁只要假过一次，后面就没人信了。
  查(false, '静态检查', (报 || '退出码 ' + e.status).slice(0, 400))
}

// 10) 搬人只有一个实现（批次166）。写「在途」= 让人上路，只该在 移动.mjs 里做。
//     原来四份：走路（自己写在途）、缺口（出发后再同步一次自主）、qq_go（插件里再一份）、
//     资产 --去（瞬移，什么不同步）。三套规则（place 写目的地 / 写出发地 / 不写）。
//     加第五个入口（骑车、坐公交）时必然再漏一次，所以钉死在这儿。
//     注：插件的 lib/go.js 不在这个目录，扫不到 —— 它那份现在是幂等的重复写，值一样。
const 搬人写点 = []
try {
  for (const f of fs.readdirSync(TOOLS)) {
    if (!f.endsWith('.mjs') || f === '移动.mjs' || f === '契约检查.mjs') continue
    fs.readFileSync(path.join(TOOLS, f), 'utf8').split('\n').forEach((行, i) => {
      const t = 行.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      // 写在途 或者 直接把自己设成「走动」—— 这两件事合起来才叫「搬人」
      if (/\.在途\s*=\s*\{/.test(t) || /\.state\s*=\s*['"]走动['"]/.test(t)) {
        搬人写点.push(f + ':' + (i + 1))
      }
    })
  }
} catch (e) { 搬人写点.push('（扫不动：' + e.message + '）') }
查(!搬人写点.length, "搬人只有 移动.mjs 一处",
  `这些地方自己在搬人：${搬人写点.join("、")}（写在途 + 同步自主 只该在 移动.mjs 做，否则 place 会一边说出发地一边说目的地）`)

// 11) 占用态的判据只有 占用.mjs 一份（批次167）。
//     「在岗/待上」这两个词是 工作.json 里的状态值，判「她在不在上班」只该两个地方做：
//     占用.mjs（给别人问）和 工作.mjs（自己判该不该打卡/结算）。
//     原来有 7 处各自判，其中 4 处只认「在岗」，漏掉「待上 + 已到点 + 人在点上」那一分钟 ——
//     09:00:01 缺口 说她在上班，自主行动 把她写成「拍张照」，活动 记成「打工」体力 -5。
const 私判在岗 = []
try {
  for (const f of fs.readdirSync(TOOLS)) {
    if (!f.endsWith('.mjs') || f === '占用.mjs' || f === '工作.mjs' || f === '契约检查.mjs') continue
    fs.readFileSync(path.join(TOOLS, f), 'utf8').split('\n').forEach((行, i) => {
      const t = 行.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      // 允许 `状态)`、`['状态']` 这些写法 —— 第一版写成 /状态\s*[!=]==?/，
      // 于是 `String(b.状态) === '在岗'` 里的 `)` 把整条挡掉了，三个负测试全都没报。
      if (/状态['"]?\]?\s*\)?\s*[!=]==?\s*['"](在岗|待上)['"]/.test(t)) 私判在岗.push(f + ':' + (i + 1))
    })
  }
} catch (e) { 私判在岗.push('（扫不动：' + e.message + '）') }
查(!私判在岗.length, "在岗判据只有 占用.mjs 一处",
  `这些地方自己在判在岗/待上：${私判在岗.join("、")}（判「她在不在上班」只该 占用.mjs 做，漏了「待上+已到点+人在点上」那一分钟，各处说法会打架）`)

// 10) 静态：插件目录（dsh-bot 进程）里判「她睡没睡」只该问 lib/sleepgate.js。
//     批次164 把工具目录的 5 种判据收成 睡态.mjs（覆盖 16 个 .mjs），但只扫了 共享/工具/ ——
//     插件目录里至今有 `/睡/.test(自主.state)` 和 `睡眠.json.sleeping` 两种老写法。
//     这两个字段分别是「派生」（状态推进 每 15 分钟才刷一次）和「写者自己注明不可靠」
//     （睡眠阶段.mjs：以 live 为准，sleeping 可能被别的路径先改掉）。
const 插件LIB = process.env.QQ_PLUGIN_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 插件在 = fs.existsSync(插件LIB)
const 私判睡 = []
if (插件在) {
  try {
    for (const f of fs.readdirSync(插件LIB)) {
      if (!f.endsWith('.js') || f === 'sleepgate.js') continue
      const 行们 = fs.readFileSync(path.join(插件LIB, f), 'utf8').split('\n')
      行们.forEach((行, i) => {
        const t = 行.trim()
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return   // 注释里提到不算
        if (/\/睡\/\.test\(/.test(t)) 私判睡.push(f + ':' + (i + 1) + ' 用 自主.state 判睡')
        else if (t.includes('睡眠.json') && t.includes('sleeping')) 私判睡.push(f + ':' + (i + 1) + ' 读 睡眠.json.sleeping')
      })
    }
  } catch (e) { 私判睡.push('（扫不动：' + (e && e.message) + '）') }
}
查(!插件在 || fs.existsSync(path.join(插件LIB, 'sleepgate.js')), "插件有 sleepgate 模块",
  "插件里判睡眠要转调它；文件丢了所有守卫都会退化成只读标记")
查(!私判睡.length, "插件里判睡眠只问 sleepgate",
  `这些地方自己判睡：${私判睡.join("、")}（自主.state 是派生字段、状态推进 每 15 分钟才刷一次；睡眠.json.sleeping 写者自己注明不可靠。插件里一律问 lib/sleepgate.js）`)

// 11) 静态：写 自主.json 只能经 自主状态.mjs（内部走 _底层.改档 = 锁 + 原子写）。
//     批次169 审计：九个写入点里三处裸 writeFileSync（半截 JSON 会让 state/since/log 一起没），
//     六处锁外读改写（两个 cron 撞同一秒就丢更新）。
//     这里只抓「同一行既写又指向 自主.json」——够挡住直接路径和 AU/autP/AP/自主P 两种写法。
const 私写自主 = []
const 自主变量 = /writeFileSync\(\s*(AU|autP|AP|自主P)\b/
try {
  for (const f of fs.readdirSync(TOOLS)) {
    if (!f.endsWith('.mjs')) continue
    if (f === '自主状态.mjs' || f === '回归用例.mjs') continue   // 模块自身 / 测试夹具
    const 行们 = fs.readFileSync(path.join(TOOLS, f), 'utf8').split('\n')
    行们.forEach((行, i) => {
      const t = 行.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (!t.includes('writeFileSync')) return
      if (t.includes('自主.json') || 自主变量.test(t)) 私写自主.push(f + ':' + (i + 1))
    })
  }
} catch (e) { 私写自主.push('（扫不动：' + (e && e.message) + '）') }
查(!私写自主.length, "自主.json 没有裸写",
  `这些地方直接写：${私写自主.join('、')}（写它只该经 自主状态.mjs 的 改/起）`)

const 用自主状态 = fs.readdirSync(TOOLS)
  .filter((f) => f.endsWith('.mjs') && f !== '自主状态.mjs')
  .filter((f) => fs.readFileSync(path.join(TOOLS, f), 'utf8').includes("from './自主状态.mjs'"))
// 点名而不是数个数：数量阈值会被「注释里写了 from './自主状态.mjs'」这种误命中喂饱
// （契约检查自己就命中过），也会漏掉「删一个、加一个」的替换。
const 该走 = ['吃饭.mjs', '洗澡.mjs', '工作.mjs', '打盹.mjs', '醒来.mjs', '家区域.mjs', '资产.mjs', '状态推进.mjs', '自主行动.mjs']
const 漏走 = 该走.filter((x) => !用自主状态.includes(x))
查(!漏走.length, "写自主状态的入口都走 自主状态.mjs",
  `这些没走：${漏走.join('、')}（写 自主.json 只该经它 —— 内部是 锁 + 原子写）`)

// 12) 静态：「这个 state 算什么活动」只有 在干嘛.mjs 一处。
//     批次170 量出来的：状态推进 一张数组、困意 一条正则、饱渴 一串 if、同步QQ状态 一个字典 ——
//     四份各写各的，而且已经分叉（看B站：体力按干活扣 -2.4/h、困意按坐着不动攒 0.75）。
//     分叉的原因是不停加新动作，而加的人只看自己那个文件。所以扫这四个文件里还有没有 state 字面量。
// 只扫「管行为」的四个文件。面板.mjs 那 6 处**不算**：它是前端立绘的表情映射
// （activity → 画哪个 sprite），9 个 sprite 状态（sleep/drowsy/idle/slack/happy/gloom/
// tsundere/study/work）比这 6 档细，强行统一会把 study/slack/idle 压成一档，立绘就不动了。
// 一个管「体力怎么掉」，一个管「画哪张脸」，不是同一个判据。
const 私判活动 = []
const 活动词 = /发呆|摸鱼|翻旧账|学点东西|看B站|逛贴吧/
for (const f of ['状态推进.mjs', '困意.mjs', '饱渴.mjs', '同步QQ状态.mjs']) {
  const p = path.join(TOOLS, f)
  if (!fs.existsSync(p)) continue
  fs.readFileSync(p, 'utf8').split('\n').forEach((行, i) => {
    const t = 行.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    if (活动词.test(t)) 私判活动.push(f + ':' + (i + 1))
  })
}
查(!私判活动.length, "活动分档只有 在干嘛.mjs 一处",
  `这些地方还在自己认 state：${私判活动.join('、')}（分档/倍率/对外说法一律问 在干嘛.mjs）`)

// 13) 面板前端 pickState 读的字段，服务端必须真的下发。
//     批次171 抓到两个：s.sleepy 和 s.sulk 从来没下发过（状态推进 写的是「困意」，
//     别扭.json 面板压根没读过），所以「犯困」和「别扭」两个立绘从上线起就没亮过。
//     这类 bug 不报错、不抛异常 —— 只会让她永远是一张「发呆」脸。
const 前端要的 = ['activity', 'mood', 'sleeping', 'sleepy', 'sulk']
try {
  const out = execFileSync('/usr/local/bin/node', [path.join(TOOLS, '面板.mjs'), '--dump', '--guest'],
    { encoding: 'utf8', timeout: 30000 })
  const d = JSON.parse(out)
  const 段 = d.guest || d
  const 缺 = 前端要的.filter((k) => !(k in 段))
  查(!缺.length, "面板 pickState 读的字段都下发了",
    `缺：${缺.join('、')}（前端读 s.xxx 但服务端没这个键，立绘会永远停在发呆）`)
} catch (e) {
  查(false, "面板 pickState 读的字段都下发了", '面板 --dump 跑不动：' + (e && e.message))
}

// 14) 「在不在班上」只有 占用.mjs 一处判（批次172）。
//     原来 工作.mjs 自己写 `位 === 班.点 && !途中`，而 占用.在岗的班 只看「状态=在岗」——
//     同一个事实两套判据。她 22:00 打卡守夜、05:54 走回家，06:00 到家时：
//       同步QQ状态 签名成「在家上便利店夜班」；工作.mjs 记「迟到 474 分钟」扣 20 块。
const 占源码 = fs.readFileSync(path.join(TOOLS, '占用.mjs'), 'utf8')
const 工源码 = fs.readFileSync(path.join(TOOLS, '工作.mjs'), 'utf8')
const 状源码 = fs.readFileSync(path.join(TOOLS, '同步QQ状态.mjs'), 'utf8')
查(占源码.includes("export function 算在岗"), "在岗判据在 占用.mjs 导出",
  "占用.mjs 里没有 export function 算在岗")
查(工源码.includes("算在岗(班"), "工作.mjs 问 占用.算在岗，不自己判",
  "工作.mjs 还在自己拼「位 === 班.点」—— 同一个事实两套判据会分叉")
查(状源码.includes("if (b) {"), "同步QQ状态：不在班上不说「在X上Y」",
  "打工分支没判 b 有没有值，她回到家签名会变成「在家上便利店夜班」")
查(工源码.includes("const 是主"), "工作.mjs 被 import 时不跑主流程",
  "缺入口保护：任何 import 它的脚本都会把 --tick/--打卡 跑一遍")

// 15) 精力合成只有 恢复目标.精力() 一处；状态.json 只经 _状态.saveState 写（批次173）。
//     批次173 抓到两件：
//     ① 资产.mjs 还在用「体力+情绪 两数平均」算 energy —— 批次171 只扫了 Math.pow(...,0.6)
//        的木桶写法，抓不到平均。她 physical 17.1 / emotional 49.5 时两者差 13 点：
//        逛一圈面板跳到 33，15 分钟后 状态推进 重算成 20。
//     ② 作息（2 处）/ 撤回 / 资产 用 写档 整份覆盖 状态.json —— 没有锁、没有差量合并。
//        四个进程同时「读 → 等 40ms → 改 → 写」，裸写只有 1/4 个字段更新成功。
const 精力手抄 = []
const 状态裸写 = []
for (const f of fs.readdirSync(TOOLS)) {
  if (!f.endsWith('.mjs')) continue
  if (['_状态.mjs', '恢复目标.mjs', '契约检查.mjs', '回归用例.mjs', '自检.mjs'].includes(f)) continue
  const 行们 = fs.readFileSync(path.join(TOOLS, f), 'utf8').split(String.fromCharCode(10))
  行们.forEach((行, i) => {
    const t = 行.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    if (t.includes('Math.pow') && t.includes('0.6')) 精力手抄.push(f + ':' + (i + 1))
    else if (t.includes('energy =') && t.includes('emotional') && t.includes('/ 2')) 精力手抄.push(f + ':' + (i + 1))
    if (t.startsWith('save(stP, st') || t.startsWith('save(stateP, st') || t.startsWith('save(statePath, st')) 状态裸写.push(f + ':' + (i + 1))
  })
}
查(!精力手抄.length, "精力合成只有 恢复目标.mjs 一处",
  `${精力手抄.join("、")}（木桶 pow(,0.6) 和 两数平均 都算手抄）`)
查(!状态裸写.length, "状态.json 只经 _状态.saveState 写",
  `${状态裸写.join("、")}（整份覆盖会抹掉别人刚写的字段：实测 4 进程同写只剩 1/4）`)

// 15b) 插件 lib 是状态.json 的另一个写者，原来门禁只扫 共享/工具，扫不到它（批次578）。
//      插件一旦整档覆盖，睡眠阶段每分钟 saveState 的 energy/layers 会被盖回旧值。
const 插件状态裸写 = []
for (const f of ['deliver.js', 'poll.js']) {
  const p = path.join('{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib', f)
  if (!fs.existsSync(p)) continue
  fs.readFileSync(p, 'utf8').split(String.fromCharCode(10)).forEach((行, i) => {
    const t = 行.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    if (/writeFileSync\([^)]*状态\.json/.test(t) || /写档\([^)]*状态\.json/.test(t)) 插件状态裸写.push(f + ':' + (i + 1))
  })
}
查(!插件状态裸写.length, "插件不许整档覆盖 状态.json",
  `${插件状态裸写.join("、")}（改走 耐心.mjs --扣，只动 耐心 一个字段）`)

// 16) 「一条记录值多少钱」只有 账本.mjs 一处（批次174）。
//     原来五处各自用正则从 what 里抠钱：写日记 / 快照 / 日报 / 面板×2。
//     同一天能算出三个数（11-05：写日记 154/0、快照 154/780、日报 164/0），
//     而且 11-07 起工资换成「上班：…（475 分钟，130 块，扣了 20）」，五处全都不认。
//     这类分叉不会报错 —— 只是日报写「赚了 0 块」、面板首页少一半收入。
const 私算钱 = []
for (const f of fs.readdirSync(TOOLS)) {
  if (!f.endsWith('.mjs')) continue
  if (['账本.mjs', '契约检查.mjs', '自检.mjs', '回归用例.mjs'].includes(f)) continue
  const 行们 = fs.readFileSync(path.join(TOOLS, f), "utf8").split(String.fromCharCode(10))
  行们.forEach((行, i) => {
    const t = 行.trim()
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
    if (!t.includes('match(')) return
    if (t.includes('块') || t.includes('[买花]') || t.includes('押金')) 私算钱.push(f + ':' + (i + 1))
  })
}
查(!私算钱.length, "金额解析只有 账本.mjs 一处",
  `${私算钱.join("、")}（同一条记录在几处各算一遍，一定会分出几个数来）`)
const 账源码 = fs.readFileSync(path.join(TOOLS, '账本.mjs'), 'utf8')
查(账源码.includes("export function 一笔") && 账源码.includes("export function 汇总") &&
 账源码.includes("export function 某天"), "账本.mjs 三个出口都在",
 "改了名字但没同步调用方")

// 16b) 账本必须认得 花钱.mjs 真能写出来的每一种记录格式（批次288）。
//      2026-11-08 主人看面板：「今天花了 100 多，这里显示还是 0」。
//      钱没错（532 - 122 = 410），错在 一笔() 只认「买了…」开头的句子，
//      而 花钱.mjs 对外卖/跑腿/快递写的是「外卖：早饭（10 块，含配送费 2）」，
//      这些前缀一个都不在白名单里 → 面板/日报/快照全记 0。
//      断言落在**运行结果**上而不是源码字符串：以后换成正则别的写法也照样管用。
const 账样本 = [
  ['买了糖（6 块）', 6],                              // 到店
  ['外卖：早饭（10 块，含配送费 2）', 10],              // 外卖
  ['跑腿：糖（10 块，含跑腿费 4）', 10],                // 跑腿
  ['快递：洗发水（30 块，含快递费 8，明天到）', 30],     // 快递
  ['外卖：火锅（98 块，含配送费 2，借了主人 20 块）', 98], // 带欠款话：要总价不要那句借款
]
const 账漏 = 账样本.filter(([what, 期望]) => 一笔(what).花 !== 期望).map(([what]) => what)
查(!账漏.length, "账本认得花钱.mjs 的每种记录写法",
  `这些解析不出钱：${账漏.join("、")}（面板会显示今天花 0）`)
const 非消费 = ["在家吃了早饭", "在家吃了火锅", "洗了个澡", "打了一次工"]
  .filter((what) => { const x = 一笔(what); return x.花 || x.赚 || x.被拿 })
查(!非消费.length, "账本不会把「吃了/洗了」当成「买了」",
  `这些被误判成动了钱：${非消费.join("、")}`)

// 17) 有后果的手动脚本，参数写错必须炸（批次175）。
//     主动戳.mjs 原来对不认识的参数一声不响地往下跑：我敲 `--看` 查状态，
//     它一路走到 send_poke，真给主人戳了一下，还写进 戳人记录.json ——
//     那条记录看起来像「她想被注意」。真正的她当时在睡觉。
const 戳源 = fs.readFileSync(path.join(TOOLS, '主动戳.mjs'), 'utf8')
查(戳源.includes("const 认得 = new Set") && 戳源.includes("process.exit(2)"),
  "主动戳：不认识的参数会拒绝，不会真戳",
  "参数守卫被删了 —— 传错一个参数就会真的戳人，并写进她的戳人记录")


// 18) 目录洁癖与防腐化硬契约（2026-11-11）：
//     防止以后再次出现 .bak 散落、记忆/ 顶层堆满 .log、工作区顶层乱丢临时脚本、.dsh-meow 死灰复燃。
{
  // RULES_TOP 2026-11-24：规矩已提到工作区顶层（三份并列），
  // 不再藏在 共享/规矩/ 下。白名单 = 三份规矩 + 同步规则 + 待办 + 原有 6 项。
  // 增减此集合必须同步 目录与文件规矩.md §2.1 的表，否则文档与门禁打架。
  const 顶层允许文件 = new Set(['.gitignore', 'SOUL.md', '门牌.md', 'BOT-RUNBOOK.md', '梗知识.md', '热记忆.md',
    '目录与文件规矩.md', '代码规范.md', '工程案例库.md',
    '多bot与模板同步规则.md', '待办.json'])
  const 顶层乱放 = fs.readdirSync(DIR).filter((f) => {
    const p = path.join(DIR, f)
    return fs.statSync(p).isFile() && !顶层允许文件.has(f)
  })
  查(!顶层乱放.length, "工作区顶层无乱放文件", `多出文件：${顶层乱放.join('、')}（顶层只许放 SOUL/门牌/BOT-RUNBOOK/梗知识/热记忆 + 规矩三份 + 同步规则 + 待办）`)

  const 记忆顶层日志 = fs.readdirSync(MEM).filter((f) => f.endsWith('.log') && fs.statSync(path.join(MEM, f)).isFile())
  查(!记忆顶层日志.length, "记忆/ 顶层无散落 .log", `这些日志散落在 记忆/ 顶层：${记忆顶层日志.join('、')}（一律放 记忆/日志/）`)

  const 工具散落备份 = fs.readdirSync(TOOLS).filter((f) => /\.bak($|[-._])|^patch_|^fix_|^tmp/i.test(f))
  查(!工具散落备份.length, "共享/工具/ 无散落备份或一次性补丁", `发现违章文件：${工具散落备份.join('、')}（备份一律放 /root/bak2/）`)

  查(!fs.existsSync(path.join(DIR, '.dsh-meow')), "无 .dsh-meow 僵尸目录", ".dsh-meow 被某个旧脚本意外重建了")
}

// 24) 工具目录结构 + 测试镜像（2026-11-24）
//
// 规矩（目录与文件规矩.md §1.2 / §1.3）承诺了两条结构性约束，这里把它们钉成门禁：
//   a) 共享/工具/ 顶层不许新增平铺 .mjs（顶层只留 9 个目录 + 存量白名单）
//   b) 每个生产模块要有镜像测试（测试/<层>/<模块>.test.mjs）
//
// 存量现实：当前 144 个 .mjs 平铺在顶层，属「存量债」。
// 因此这里**不用「顶层必须为空」**当判据（那会立刻全红、无法发布），
// 而是用**冻结基线**：把当前平铺文件名存成白名单，白名单之外的顶层 .mjs 一律红。
// 这样「存量不扩大」是可执行的 → 规则从口号变成闸门。
//
// 基线文件：共享/工具/数据/顶层白名单.json
// 新增模块时**不需要**改白名单（新模块应在 核心/判据/领域/接口/出口 目录里）；
// 只有「把存量搬进目录」时才需要**删除**白名单里对应条目（缩小基线）。
{
  const 工具顶层允许目录 = new Set([
    '核心', '判据', '领域', '接口', '出口', '数据', '页面', '资源', '测试',
    // 历史既有目录（迁移完成前保留，P4 后应清空）
    'lib', 'three', 'models', 'img', '_归档',
  ])
  const 白名单路径 = path.join(TOOLS, '数据', '顶层白名单.json')

  // a) 顶层散落 .mjs
  let 基线 = []
  let 基线可读 = true
  try {
    const j = JSON.parse(fs.readFileSync(白名单路径, 'utf8'))
    基线 = Array.isArray(j.允许) ? j.允许.map(String) : []
  } catch { 基线可读 = false }
  const 基线集 = new Set(基线)
  const 顶层mjs = fs.readdirSync(TOOLS).filter((f) => /\.(mjs|js)$/i.test(f))
  const 越界 = 顶层mjs.filter((f) => !基线集.has(f))
  查(基线可读, '工具目录结构：顶层白名单可读',
    `读不到 ${白名单路径}（规矩 §1.2 要求顶层不新增平铺 .mjs；请从模板同步该文件）`)
  if (基线可读) {
    查(!越界.length, '工具顶层无新增平铺 .mjs（存量已冻结）',
      `这些是白名单外的顶层 .mjs：${越界.slice(0, 8).join('、')}${越界.length > 8 ? ' 等' : ''}`
      + `（新模块请建在 核心/判据/领域/接口/出口 下，见规矩 §1.2）`)
    // 白名单里的条目若已不存在，说明搬走了但忘了缩基线 —— 不算错，只提示缩小
    const 已搬走 = 基线.filter((f) => !顶层mjs.includes(f))
    查(true, '工具顶层白名单与现状一致' + (已搬走.length ? `（可缩小 ${已搬走.length} 条）` : ''), '')
  }

  // b) 顶层目录白名单
  const 顶层目录 = fs.readdirSync(TOOLS).filter((f) => {
    try { return fs.statSync(path.join(TOOLS, f)).isDirectory() } catch { return false }
  })
  const 野目录 = 顶层目录.filter((d) => !工具顶层允许目录.has(d))
  查(!野目录.length, '工具顶层目录都在规范内',
    `这些目录不在规范清单：${野目录.join('、')}（见规矩 §1.1）`)

  // c) 测试镜像：三层目录（核心/判据/领域/接口/出口）逐一比对
  const 层们 = ['核心', '判据', '领域', '接口', '出口']
  const 缺镜像 = []
  const 悬空测试 = []
  for (const 层 of 层们) {
    const 生产目录 = path.join(TOOLS, 层)
    const 测试目录 = path.join(TOOLS, '测试', 层)
    if (!fs.existsSync(生产目录)) continue   // 该层还没开始迁移，跳过（不算错）

    const 列mjs = (d) => {
      if (!fs.existsSync(d)) return []
      const out = []
      const walk = (cur) => {
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const p2 = path.join(cur, e.name)
          if (e.isDirectory()) walk(p2)
          else if (/\.mjs$/i.test(e.name)) out.push(path.relative(d, p2).replace(/\\/g, '/'))
        }
      }
      walk(d)
      return out
    }
    const 生产 = 列mjs(生产目录).map((r) => r.replace(/\.mjs$/i, '').replace(/\/index$/, ''))
    const 测试 = new Set(列mjs(测试目录).map((r) => r.replace(/\.test\.mjs$/i, '')))
    for (const m of 生产) if (!测试.has(m)) 缺镜像.push(`${层}/${m}`)
    const 生产集 = new Set(生产)
    for (const t of 测试) if (!生产集.has(t)) 悬空测试.push(`${层}/${t}`)
  }
  查(!缺镜像.length, '测试镜像：每个生产模块都有测试',
    `缺镜像测试：${缺镜像.slice(0, 6).join('、')}${缺镜像.length > 6 ? ' 等' : ''}（规矩 §1.3）`)
  查(!悬空测试.length, '测试镜像：无悬空测试',
    `测试有、生产没有：${悬空测试.slice(0, 6).join('、')}（规矩 §1.3）`)
}

// 19) 工具白名单不许留 0 调用的 schedule_*（2026-11-12）。
//     任务书第 2 刀要求四个 schedule_* 全删（一直 0 调用）；13:36 删过一次，14:07 被另一次
//     配置写入原样盖回来 —— 桥配置是多处可写的，靠「记得删」守不住。钉进契约：谁写回来谁红。
{
  const 桥 = JSON.parse(fs.readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8'))
  const 白 = 桥.工具白名单 || []
  const 残留 = 白.filter((x) => /^schedule_/.test(String(x)))
  查(!残留.length, '工具白名单无 0 调用的 schedule_*',
    `这些还在白名单里：${残留.join('、')}（任务书第 2 刀要求全删；删完别忘 dsh-bot 不用重启）`)
}

// 20) 桥配置里的每个键都必须有代码在读（2026-11-14，批次397）。
//     起因：phoneOwnerAlways 在配置里挂了很久，而 phone.mjs 里那条「主人也不用 @」的豁免分支
//     早在批次235 就删了。改这个开关不会发生任何事 —— 但没人看得出来，因为它长得跟别的开关一样。
//     「数据文件写了没人读」已经有 体检-闭环 在查；配置项这一半一直没人管。
//     注意：**本文件自己不参与扫描** —— 这段注释里就写着那个键名，会把检查自己骗过去。
{
  const 桥2 = JSON.parse(fs.readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8'))
  const 库 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
  const 源 = []
  for (const f of fs.readdirSync(库)) {
    // MJS397 2026-11-14：原来只认 .js，**漏掉了 lib/*.mjs**（贴表情/感受/睡态/睡眠阶段… 全是 .mjs）。
    // 后果：只在 .mjs 里读的参数会被误报成「没人读」—— 贴表情_每小时上限 就这么被冤枉了一次。
    if (!/\.(js|mjs)$/.test(f) || f.includes('.pre-')) continue
    源.push(fs.readFileSync(path.join(库, f), 'utf8'))
  }
  for (const f of fs.readdirSync(TOOLS)) {
    if (!/\.(mjs|js)$/.test(f) || f === '契约检查.mjs') continue
    源.push(fs.readFileSync(path.join(TOOLS, f), 'utf8'))
  }
  const 全 = 源.join('\n')
  const 没读 = Object.keys(桥2).filter((k) => !全.includes(k))
  查(!没读.length, '桥配置每个键都有代码在读',
    `这些键没有任何代码读：${没读.join('、')}（改它们什么都不会发生；要么接上，要么从配置里删掉）`)
}

// 21) 参数.json 的「活段」里，每个键都必须有代码在读（2026-11-14，批次397）。
//     起因：睡眠段 4 个、好感度的维度上限/事件加减、拟人的性格_基准和 7 个 睡眠_* ——
//     一共 15 个键全项目零引用，却跟别的阈值长得一模一样。谁改谁踩空，而且改完不会报错。
//     项目本来就有 _未接线 这个约定（「留着是因为它们描述的是想要的行为」），
//     这批把它们按约定搬过去了。这条检查守的是「别再悄悄长回来」。
//     规则：下划线开头的段和键是文档/死信，不查；其余一律要有代码提到。
{
  const 参 = JSON.parse(fs.readFileSync(path.join(TOOLS, '参数.json'), 'utf8'))
  const 库 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
  const 源 = []
  for (const f of fs.readdirSync(库)) {
    // MJS397 2026-11-14：原来只认 .js，**漏掉了 lib/*.mjs**（贴表情/感受/睡态/睡眠阶段… 全是 .mjs）。
    // 后果：只在 .mjs 里读的参数会被误报成「没人读」—— 贴表情_每小时上限 就这么被冤枉了一次。
    if (!/\.(js|mjs)$/.test(f) || f.includes('.pre-')) continue
    源.push(fs.readFileSync(path.join(库, f), 'utf8'))
  }
  for (const f of fs.readdirSync(TOOLS)) {
    // 面板.mjs 要算进来：面板_精力足/面板_钱多 这些是它自己的显示阈值，是真在读
    if (!/\.(mjs|js)$/.test(f) || f === '契约检查.mjs') continue
    源.push(fs.readFileSync(path.join(TOOLS, f), 'utf8'))
  }
  const 全 = 源.join('\n')
  const 死参 = []
  for (const [段, 表] of Object.entries(参)) {
    if (段.startsWith('_') || !表 || typeof 表 !== 'object' || Array.isArray(表)) continue
    for (const k of Object.keys(表)) {
      if (k.startsWith('_')) continue
      if (!全.includes(k)) 死参.push(段 + '.' + k)
    }
  }
  查(!死参.length, '参数.json 活段每个键都有代码读',
    `这些参数没有任何代码读：${死参.join('、')}（要么接上，要么按约定挪进 _未接线）`)
}

// 22) 工具 schema 里声明的参数，执行体必须读（2026-11-14，批次398）。
//     起因：qq_sleep 声明了 `why`（「为什么现在睡（可选，一句话）」），execute 里一次都没提 ——
//     她照着填了，落盘什么也没有，而且不报错。模型能看见 schema，等于被自己的工具骗了。
//     判法：把 parameters.properties 第一层的键名抓出来，再在「除 schema 块以外」的源码里找这个标识符，
//     0 次才报（解构 `const { x } = args` 也算 1 次，不会误伤）。
//     本文件自己不参与扫描。
{
  const LIB2 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
  const md = (s, i) => {   // 从 '{' 或 '[' 配平，跳过字符串
    const 开 = s[i], 闭 = 开 === '{' ? '}' : ']'
    let 深 = 0, 引 = null
    for (let j = i; j < s.length; j++) {
      const c = s[j]
      if (引) { if (c === '\\') { j++; continue } if (c === 引) 引 = null; continue }
      if (c === "'" || c === '"' || c === '`') { 引 = c; continue }
      if (c === 开) 深++
      else if (c === 闭) { 深--; if (深 === 0) return j }
    }
    return -1
  }
  const 死字段 = []
  for (const f of fs.readdirSync(LIB2)) {
    if (!/\.(js|mjs)$/.test(f) || f.includes('.pre-')) continue
    const src = fs.readFileSync(path.join(LIB2, f), 'utf8')
    for (const m of src.matchAll(/name:\s*['"](qq_[a-z0-9_]*)['"]/g)) {
      const pm = /parameters\s*:\s*\{/.exec(src.slice(m.index))
      if (!pm) continue
      const 起 = m.index + pm.index + pm[0].length - 1
      const 止 = md(src, 起)
      if (止 < 0) continue
      const 块 = src.slice(起, 止 + 1)
      const 位置 = /properties\s*:\s*\{/.exec(块)
      if (!位置) continue
      const p起 = 位置.index + 位置[0].length - 1
      const p止 = md(块, p起)
      if (p止 < 0) continue
      const prop = 块.slice(p起, p止 + 1)
      const 键 = []
      let 深 = 0
      for (const ln of prop.split('\n')) {
        const t = ln.trim()
        if (深 === 1) {
          const mm = /^([\u4e00-\u9fa5A-Za-z_][\u4e00-\u9fa5A-Za-z0-9_]*)\s*:/.exec(t)
          if (mm) 键.push(mm[1])
        }
        for (const c of ln) {
          if (c === '{' || c === '[') 深++
          else if (c === '}' || c === ']') 深--
        }
      }
      const 外部 = src.slice(0, 起) + src.slice(止 + 1)
      for (const k of 键) {
        const 计 = (外部.match(new RegExp('(^|[^\\w\\u4e00-\\u9fa5])' + k + '($|[^\\w\\u4e00-\\u9fa5])', 'g')) || []).length
        if (计 === 0) 死字段.push(m[1] + '.' + k)
      }
    }
  }
  查(!死字段.length, '工具参数都有人在读',
    `这些参数声明了但执行体一次都没读：${死字段.join('、')}（要么接上，要么从 schema 删掉）`)
}

// 23) 人味.json 的每一类都要真的接进注入（2026-11-14，批次399）。
//     这个文件自己的 说明 写着「八类人味…注入时只取这里，改这里等于改她的行为倾向」——
//     但 poll.js 只按显式键名取了 6 类，**「约定与时间」「自省」一个字都没进过她的上下文**。
//     内容都在（久别重逢语气不一样 / 纪念日会提一句 / 深夜心里有数），改了却没有任何效果。
//     这条检查：除台账里明确记过「暂未接入」的，其余每一类都必须在 poll.js 里出现。
{
  const 人味P = path.join(MEM, '人味.json')
  if (fs.existsSync(人味P)) {
    const 人味 = JSON.parse(fs.readFileSync(人味P, 'utf8'))
    // 台账：这两类 2026-11-14 就确认没接（见 变更.md 批次399），改接之前先从这里划掉
    // 2026-11-14（批次400）：「约定与时间」已接进 poll.js（久别重逢 / 深夜 两个条件），
    // 只剩「自省」——它是流程说明（每月重写自述），不该进每轮注入。
    const 已知没接 = new Set(['说明', '自省'])
    const pollP = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
    const poll源 = fs.readFileSync(pollP, 'utf8')
    const 没接 = Object.keys(人味).filter((k) => !已知没接.has(k) && !poll源.includes("'" + k + "'"))
    查(!没接.length, '人味每一类都接进了注入（除台账记过的）',
      `这些类别加了但没接：${没接.join('、')}（@poll.js 的 add() 那一段加条件，别只写进 json）`)
  }
}

// 82) 服务不许跑旧代码（2026-11-14 批次452）
//
// 怎么发现的：`一起听` 开关 11-13 23:15 就关掉了，可 `下载/` 里一直在长新的 ncm-clip。
// 查到最后是 fish-music 的进程起于 11-12 11:55:49，而 `一起听歌.mjs` 改于 11:56:54 —— 差 65 秒，
// 于是这个进程一直在跑**没有开关检查的旧代码**：每 2 秒打一次网易云、每首歌下 4MB 还送去云端分析。
//
// 这一类不会报错：systemd 说 active、日志干净、面板正常，只是新逻辑一句都没生效。
// 所以对着「服务启动时刻 vs 它的脚本 mtime」钉一条。留 60 秒余量，免得同批改完立刻重启被误判。
const 北京时刻 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
// SERVICES_ENV 2026-11-24：这两行原来写死别家的单元名（fish-panel / fish-upstream）。
// 本机实例叫 {{SVC_PANEL}} / {{SVC_GATEWAY}} —— 于是「服务不许跑旧代码」这条在本机
// 一直只是「查不到就 continue」，等于**静默空转**，真跑旧代码也不会红。
// 服务名走环境变量（SVC_PANEL / SVC_GATEWAY），和 体检-基础 的 SERVICES 同一个约定；
// 没设就保留原来的历史默认，不影响别的机器。
const SVC = (k, d) => String(process.env[k] || d)
const 服务脚本 = [
  [SVC('SVC_PANEL', 'fish-panel'), path.join(TOOLS, '面板.mjs')],
  [SVC('SVC_GATEWAY', 'fish-upstream'), path.join(TOOLS, '接口网关.mjs')],
]
for (const [单元, 脚本] of 服务脚本) {
  let 活动 = 'unknown'
  try { 活动 = execFileSync('systemctl', ['is-active', 单元], { encoding: 'utf8', timeout: 5000 }).trim() } catch { 活动 = 'unknown' }
  if (活动 !== 'active') continue      // 没在跑的服务不归这条管
  let 起 = 0
  let 改 = 0
  try {
    起 = Date.parse(execFileSync('systemctl', ['show', 单元, '-p', 'ActiveEnterTimestamp', '--value'], { encoding: 'utf8', timeout: 5000 }).trim()) || 0
  } catch { 起 = 0 }
  try { 改 = fs.statSync(脚本).mtimeMs } catch { 改 = 0 }
  // 服务在跑但读不到启动时间/脚本时，**不能当通过** —— 这条第一次写就是这样漏的：
  // 反测时 touch 了脚本，契约还是全绿，因为 起 解析成 0，条件被 `起 > 0` 短路掉，静默放行。
  查(起 > 0 && 改 > 0, '服务不是旧代码：' + 单元 + '（判得了）',
    '服务是 active，却读不到启动时间或脚本 mtime —— 这条判不了，不能算通过')
  if (起 > 0 && 改 > 0) {
    查(!(改 > 起 + 60e3), '服务不是旧代码：' + 单元,
      '服务起于 ' + 北京时刻(起) + '，而 ' + path.basename(脚本) + ' 改于 ' + 北京时刻(改)
      + ' —— 进程里跑的是改动前的代码，新逻辑全没生效，得 systemctl restart ' + 单元)
  }
}

// 83) 生产环境里不许有测试专用开关（2026-11-14 批次460）
//
// 457/459 加的沙盒守卫是靠环境变量生效的：`SMOKE_GUARD_SANDBOX` 一旦出现在生产单元或 env 文件里，
// 她的每一次写都会被**静默改道**到沙盒 —— 服务还 active、日志还干净、面板还显示「已更新」，
// 可真档永远不动。这比「服务跑旧代码」更隐蔽：那个至少 mtime 能看出来。
// 所以钉一条：生产单元、env 文件、生产代码里，都不许出现测试开关。
const 禁词 = ['SMOKE_GUARD_SANDBOX', 'SMOKE_GUARD_ROOT', 'SMOKE_GUARD_LOG', 'SMOKE_NO_MODEL', 'QUIET_NOTE']
// SERVICES_ENV 2026-11-24：同上 —— 原来写死别家单元名，本机一个都对不上，
// 于是「生产单元里没有测试开关」这条在本机什么都没查。
// 走 SERVICES（逗号分隔），与 体检-基础 同名同义；没设保留历史默认。
const 生产单元 = String(process.env.SERVICES || 'dsh-bot,fish-panel,fish-upstream,fish-gptsovits,napcat-fish,onebot-proxy-fish')
  .split(',').map((x) => x.trim()).filter(Boolean)
{
  const 脏 = []
  const 挂不上 = []
  for (const 单元 of 生产单元) {
    let 载入 = ''
    let 环境 = ''
    try { 载入 = execFileSync('systemctl', ['show', 单元, '-p', 'LoadState', '--value'], { encoding: 'utf8', timeout: 5000 }).trim() } catch { 载入 = '' }
    if (载入 === 'not-found') continue
    try { 环境 = execFileSync('systemctl', ['show', 单元, '-p', 'Environment', '-p', 'EnvironmentFile', '--value'], { encoding: 'utf8', timeout: 5000 }) } catch { 环境 = '' }
    if (载入 !== 'loaded' || !环境) { 挂不上.push(单元); continue }
    const 命中 = 禁词.filter((k) => 环境.includes(k))
    if (/NODE_OPTIONS=[^\n]*--import/.test(环境)) 命中.push('NODE_OPTIONS=--import')
    if (命中.length) 脏.push(单元 + '(' + 命中.join('+') + ')')
  }
  查(!脏.length, '生产单元里没有测试开关',
    '这些单元带着测试开关跑：' + 脏.join('、') + ' —— 她的写会被改道到沙盒，真档永远不动')
  查(!挂不上.length, '生产单元的开关查得动（判得了）',
    '读不到这些单元的环境，判不了，不能算通过：' + 挂不上.join('、'))
}
{
  const 脏 = []
  const 文件们 = ['/etc/dshbot.env']
  for (const p of 文件们) {
    let t = ''
    try { t = fs.readFileSync(p, 'utf8') } catch { 脏.push(p + '(读不到)'); continue }
    const 行 = t.split('\n').filter((l) => !l.trim().startsWith('#'))
    const 命中 = 禁词.filter((k) => 行.some((l) => l.includes(k)))
    if (命中.length) 脏.push(p + '(' + 命中.join('+') + ')')
  }
  查(!脏.length, 'env 文件里没有测试开关', '这些文件带着测试开关：' + 脏.join('、'))
}
{
  // 生产代码不许 import 沙盒守卫（它只该出现在 测试/ 里）
  const 命中 = []
  const 走 = (目录) => {
    let 名 = []
    try { 名 = fs.readdirSync(目录) } catch { return }
    for (const f of 名) {
      const p = path.join(目录, f)
      let st
      try { st = fs.statSync(p) } catch { continue }
      if (st.isDirectory()) { if (f !== '测试' && f !== 'node_modules') 走(p); continue }
      if (!/\.(mjs|js)$/.test(f)) continue
      // 跳过检查者自己：它的注释里必然出现 import '...沙盒守卫.mjs' 这种示例文案，
      // 不跳过就会自指假红（这个断言已经踩过三次：includes、正则源码、示例注释）。
      if (path.resolve(p) === path.resolve(fileURLToPath(import.meta.url))) continue
      let t = ''
      try { t = fs.readFileSync(p, 'utf8') } catch { continue }
      // 只抓「真的把它 import 进来」：针是**带扩展名的文件名**，且必须在 from/import()/require() 后面。
      // 第一版用 includes('沙盒守卫')，把这条检查自己的文案和注释也抓了，自指假红；
      // 第二版改成正则，又把正则源码那一行匹配上了 —— 针带上 .mjs 才两头都不误伤。
      // 四种写法都要抓：from '...' / import('...') / import '...'（裸 import）/ require('...')。
      // 第一版漏了裸 import —— 反测里专门造了一个 `import './测试/沙盒守卫.mjs'` 的文件，居然没红。
      if (/(?:from|import\s*\(|import\s+|require\s*\()\s*['"][^'"]*沙盒守卫\.mjs/.test(t)) {
        命中.push(p.replace(DIR + '/', ''))
      }
    }
  }
  走(path.join(DIR, '共享'))
  查(!命中.length, '生产代码不引用沙盒守卫',
    '这些生产文件提到沙盒守卫（它只该被 测试/ 里引用）：' + 命中.slice(0, 5).join('、'))
}

// 84) 插件目录里不许有断链（2026-11-14 批次462）
//
// 从主人发的那个视频查下来的：视频警告「上下文到 75% 时插件提醒调 compress 工具，
// 而 QQ 记忆的白名单没有 compress → 调不到 → 反复提醒 → 烧 token」。
// 查她这儿：白名单 35 项确实没有 compress，但也没有会提醒的插件 ——
// 装的是 dsh-live-compact（自动压缩引擎，80% 阈值，不靠提醒模型调工具），宿主也没有 compress。
// 倒是查出一个真事：`node_modules/dsh-compaction-pro` 是个**断链**（指向 @helibeiqi/ 空目录）。
// 断链平时不报错，只在加载/扫描时才炸，而且很难一眼看出来。所以钉一条。
{
  const NM = '{{DSH_ROOT}}/profiles/web/node_modules'
  const 断 = []
  const 走 = (d, 深) => {
    if (深 > 2) return
    let 名 = []
    try { 名 = fs.readdirSync(d) } catch { return }
    for (const f of 名) {
      const p = path.join(d, f)
      let st
      try { st = fs.lstatSync(p) } catch { continue }
      if (st.isSymbolicLink()) {
        if (!fs.existsSync(p)) 断.push(p.replace(NM + '/', ''))
        continue
      }
      if (st.isDirectory() && f !== '.bin') 走(p, 深 + 1)
    }
  }
  走(NM, 0)
  查(!断.length, '插件目录没有断链', '这些软链指向不存在的目标（加载时才炸）：' + 断.slice(0, 8).join('、'))
}

// 85) 提示里让她调的 qq_* 工具，必须都在白名单里（2026-11-14 批次463）
//
// 主人发的那个视频讲的就是这个：插件提醒她调 compress，白名单没有 compress →
// 调不到 → 反复提醒 → 烧 token。形状是「**有人叫她调一个她看不见的工具**」。
// 现在她这儿没有这个坑，但没有任何东西挡着它以后出现 —— 所以钉住：
// 凡是每轮注入的文本（SOUL/门牌/梗知识/热记忆 + voiceSlots/poll/感受/stateVoice）里出现的 qq_* 名字，
// 必须都在 工具白名单 里。tool.js 自己的 description 不算（它必然会提自己的名字）。
{
  const 白 = new Set((() => {
    try { return (JSON.parse(fs.readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8')).工具白名单) || [] } catch { return [] }
  })())
  const 源 = []
  for (const f of ['SOUL.md', '门牌.md', '梗知识.md', '热记忆.md']) {
    try { 源.push({ 标签: f, 文本: fs.readFileSync(path.join(DIR, f), 'utf8') }) } catch (_err) { console.error('[契约检查]', _err?.message || _err) }
  }
  for (const f of ['voiceSlots.js', 'poll.js', 'stateVoice.js']) {
    try {
      const 原文 = fs.readFileSync(path.join('{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib', f), 'utf8')
      // 先剥注释再扫：这三处 qq_self / qq_lie / qq_emoji_search 全在 `*` 注释里，
      // 不剥就会把「说明文字」当成「教她调工具」（这个断言第一版就是这么假红的）。
      源.push({ 标签: f, 文本: 原文.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '') })
    } catch (_err) { console.error('[契约检查]', _err?.message || _err) }
  }
  const 缺 = new Set()
  for (const { 标签, 文本 } of 源) {
    for (const m of 文本.matchAll(/\bqq_[a-z][a-z0-9_]{2,24}\b/g)) {
      const 名 = m[0]
      if (!白.has(名)) 缺.add(名 + '（' + 标签 + '）')
    }
  }
  查(!缺.size, '提示里提到的 qq_* 工具都在白名单',
    '这些工具被提示提到、但白名单里没有 —— 她会去调一个看不见的工具：' + [...缺].slice(0, 6).join('、'))
}

// 84) 插件补丁快照必须跟线上 lib 一致（2026-11-14 批次472）
//
// 待办里挂了一整天「补丁快照和线上 lib 对不上」，没人看见；而 `reapply-patches.sh` 不带参数就是
// 「覆盖恢复 + 重启」—— 插件一重装/升级，这些天的改动会被旧快照盖回去，而且不报错。
// 体检-基础 每天会挂这条待办，但待办没人读；契约检查每批都看数字，放这儿才拦得住。
{
  let 码 = -1
  let 尾 = ''
  try {
    // REAPPLY_ENV 2026-11-24：脚本改成「不给 DSH_HOME 就拒绝猜路径」后，
    // 这里必须显式传实例根，否则永远拿不到 0，这项会永久红。
    // 实例根从 QQ_PLUGIN_LIB（…/profiles/web/node_modules/<pkg>/lib）上溯两级。
    const __lib = process.env.QQ_PLUGIN_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
    const __m = __lib.match(/^(.*?)\/profiles\//)
    const __dsh = (process.env.DSH_HOME || (__m ? __m[1] : '{{DSH_ROOT}}'))
    // 每个实例的快照目录可能不同；有专用入口就走它，否则才退回通用脚本。
    // 否则检查会拿错目录，永远红。
    const 实例名 = path.basename(__dsh).replace(/-dsh$/, '')
    const 专用 = `/root/运维服务/reapply-patches-${实例名}.sh`
    const 脚本 = fs.existsSync(专用) ? 专用 : '/root/运维服务/reapply-patches.sh'
    execFileSync('bash', [脚本, '--check'],
      { encoding: 'utf8', timeout: 60000, env: { ...process.env, DSH_HOME: __dsh } })
    码 = 0
  } catch (e) {
    码 = (e && typeof e.status === 'number') ? e.status : -1
    尾 = String((e && (e.stdout || e.stderr)) || '').trim().split('\n').slice(-2).join(' | ').slice(0, 200)
  }
  查(码 === 0, '插件补丁快照跟线上 lib 一致',
    '线上 lib 跟 /root/onebot-patches 的快照对不上（' + (尾 || ('退出码 ' + 码))
    + '）—— 插件一重装就退回旧代码。改完 lib 要跑 reapply-patches.sh --save')
}

console.log(`契约检查：${好.length} 项通过 / ${问题.length} 项不对`)
for (const q of 问题.slice(0, 40)) console.log("  ✗ " + q)
// TODO_SYNC 2026-11-14（批次409）：同上。契约检查.log 停在 11-09 14:20，
// 而那次是红的（617 通过 / 1 不对）—— 红了也没人知道，因为它只写进日志。
try {
  待办.同步({
    id: '契约检查',
    事项: '契约检查 ' + 问题.length + ' 项不对：' + 问题.slice(0, 2).join('；'),
    来源: '契约检查',
    该在: 问题.length > 0
  })
} catch (e) {
  // TODO_FAIL 2026-11-14（批次409）：原来这里是空 catch —— 而「待办.同步 is not a function」
  // 就是这么被吞掉的（二号机的 待办.mjs 还是批次385 之前的版本，没有 同步）。
  // 体检照跑、待办静默不写、谁都不知道。写一行 stderr：不影响体检本身，但心跳日志里看得见。
  process.stderr.write('[待办未写入] ' + String(e && e.message || e).slice(0, 100) + '\n')
}

process.exit(问题.length ? 1 : 0)
}
