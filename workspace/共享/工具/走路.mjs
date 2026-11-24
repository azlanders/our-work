// 走路.mjs —— 她在城市里换地方要花时间，不是瞬移
// 用法：
//   node 走路.mjs --去 街市      # 出发（没到之前位置不变，账上记「在途」）
//   node 走路.mjs --到           # 结算：时间到了才真的到，没到就报还剩几分钟
//   node 走路.mjs --看           # 现在在哪、在不在路上
// 为什么这么写：路程时间只在 地图.json 里维护一份（t=从家出发的单程分钟），
// 两点之间走「经过家」的路（tA + tB），不另建距离矩阵；在途状态写进 资产.json 的 在途 字段，
// 面板读这个字段就能显示「在去某地的路上」，进程挂了也不会把人卡在原地。
//
// MOVE_SINGLE 2026-11-07（批次166）：写 在途 / 结算到达 / 同步 自主.json 全部搬进 移动.mjs。
// 这个文件只负责「算多久」和「把话说给人听」。原来这里自己写了一遍同步，
// 缺口.mjs 和 qq_go 又各写一遍，三份规则不一样（place 写目的地 vs 出发地）。
import fs from "node:fs"
import path from "node:path"
// 营业时间在 地点.mjs 里维护一份，别在这儿再写一遍
import { 读档 as 读地点, 营业中 } from './地点.mjs'
import { 出发 as 出发走, 到了 as 结算到 } from './移动.mjs'

const DIR = "{{BOT_ROOT}}"
// SANDBOX 2026-11-05 批次65：同 花钱.mjs —— 沙盒测试不能动她真实的资产与位置。
const MEM = process.env.QQ_AUTONOMY_MEM || path.join(DIR, "记忆")
const MAP = path.join(DIR, "共享/工具/地图.json")
const ASSET = path.join(MEM, "资产.json")

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ")
const args = process.argv.slice(2)
const val = (k, d = "") => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] ?? d) : d }

const map = load(MAP, { 地点: {} })
const asset = load(ASSET, { 钱: 0, 位置: "家" })
const here = asset.位置 || "家"
const 在途 = asset.在途 || null

// 两个地点之间的分钟数：都经过家算，家自己就是 0
// COORD_ROUTE 2026-11-05：地点表格里只有「从家出发几分钟」，两个人之间直接走会被算成绕回家一趟
// （电影院→街市变成 25+12=37 分钟）。改成按地图坐标算直线距离，比例从「家→各点」的 t 自动标定。
// RATIO_TRUTH 2026-11-24：这个函数原来算完 15 行（遍历地图、累加 总/n）之后
// **直接 return 0.55**，累加结果一次都没用上；注释还写着「用中位数而不是平均数」——
// 代码里既没中位数也没平均数。注释描述的是没实现的方案，这是典型的注释骗人。
//
// 现在老实按中位数实现（注释说的那个方法），并加上两条保护：
//   · 家没坐标 / 有效样本 < 3 → 中位数不可靠（一两个坐标标歪就会带偏），回 0.55
//   · 中位数落在 0.2~1.5 之外 → 地图坐标与 t 严重不自洽，退回 0.55
//     （宁可保守，也不能让她「走 200 分钟去便利店」）
function 距离比例() {
  const h = map.地点["家"]
  if (!h) return 0.55
  const 比 = []
  for (const k of Object.keys(map.地点)) {
    if (k === "家") continue
    const p = map.地点[k]
    const d = Math.hypot((p.x || 0) - (h.x || 0), (p.y || 0) - (h.y || 0))
    const t = Number(p.t)
    if (d > 1 && t > 0) 比.push(t / d)
  }
  if (比.length < 3) return 0.55
  比.sort((a, b) => a - b)
  const 中 = 比.length % 2 ? 比[(比.length - 1) / 2] : (比[比.length / 2 - 1] + 比[比.length / 2]) / 2
  if (!Number.isFinite(中) || 中 < 0.2 || 中 > 1.5) return 0.55
  return 中
}
function 用时(a, b) {
  if (a === b) return 0
  const pa = map.地点[a], pb = map.地点[b]
  if (!pa || !pb) return 0
  const d = Math.hypot((pa.x || 0) - (pb.x || 0), (pa.y || 0) - (pb.y || 0))
  if (d < 0.5) return 0
  return Math.max(1, Math.round(d * 距离比例()))
}

const go = val("--去", "")
if (go) {
  if (!map.地点[go]) { console.log(`地图上没有「${go}」`); process.exit(0) }
  if (在途) { console.log(`还在去${在途.to}的路上，先说到了再走`); process.exit(0) }
  const mins = 用时(here, go)
  if (mins <= 0) { console.log(`你已经在${here}了`); process.exit(0) }
  // CLOSED_WARN 2026-11-05（批次79）：这个点关着门，说一声。
  // 不拦：走过去本身也可能就是她想干的事。但说清楚，别到了门口还说自己进去看了书。
  let 关话 = ''
  try {
    const 档 = 读地点(MEM)
    const 营 = 营业中(go, 档)
    if (!营.ok) 关话 = `（${go}这个点${营.因 || '关着'}）`
  } catch { /* 读不到营业时间就不提，别因此走不成 */ }
  // 写在途 + 同步自主都归 移动.mjs —— 别在这儿再写一遍。
  const 走 = 出发走(MEM, { 从: here, 到: go, 分钟: mins })
  console.log(`从${here}出发去${go}，路上 ${走.分钟} 分钟，大约 ${bj(走.arriveAt)} 到${关话}`)
  process.exit(0)
}

if (args.includes("--到") || args.includes("--tick")) {
  // 结算幂等：没在途 / 没到点都不会动账。
  const r = 结算到(MEM)
  if (r.ok) {
    console.log(`到${r.到}了（走了 ${r.分钟} 分钟）`)
  } else if (r.why === '没在路上') {
    console.log(`没在路上，人在${here}`)
  } else {
    console.log(`还在去${r.到}的路上，剩 ${r.剩} 分钟`)
  }
  process.exit(0)
}

if (args.includes("--看") || args.length === 0) {
  if (在途) {
    const left = Math.max(0, Math.ceil((在途.arriveAt - Date.now()) / 60e3))
    console.log(`人在去${在途.to}的路上，还剩 ${left} 分钟（从${在途.from}出发）`)
  } else {
    console.log(`人在${here}${(map.地点[here] || {}).desc ? ' · ' + map.地点[here].desc : ''}`)
  }
  process.exit(0)
}

console.log("用法：--去 地点 / --到 / --看")
