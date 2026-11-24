// 水点.mjs —— 哪儿能接水、杯里现在有多少（批次223）
//
// 只读的一个小模块：判据写在这里一份，`物品.mjs`（执行接水）和 `自主行动.mjs`（要不要去喝）
// 都问它，别再各写一遍 —— 分叉过一次的账（状态推进/困意/饱渴 三份倍率）不想再记一次。
//
// 「接水点」的口径（主人 2026-11-08）：
//   · 除了街上，其他地方都有接水点 —— 室内、能坐/吃/喝/买/逛的地方都算；
//   · 打工点是露天工地，原来接不到，补了 `接水: true`；
//   · 街上（走路/路过）没有，只能喝杯里带着的。
import fs from 'node:fs'
import path from 'node:path'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 地图P = path.join(TOOLS, '地图.json')
const MEM = process.env.QQ_AUTONOMY_MEM || process.env.BAOKE_MEM
  || process.env.HUNGER_MEM || process.env.GAP_MEM || '{{BOT_ROOT}}/记忆'
const 物品P = path.join(MEM, '物品.json')

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }

/** 这个地点接不接得到水。显式 `接水:false` 优先，其次 `接水:true`、室内、能坐/吃/喝/买/逛。 */
export function 能接水(地) {
  const p = (load(地图P, { 地点: {} }).地点 || {})[String(地 || '')] || {}
  if (p.接水 === false) return false
  if (p.接水 === true) return true
  if (p.室内 === true) return true
  const 能 = Array.isArray(p.能) ? p.能 : []
  return 能.some((k) => ['坐', '吃', '喝', '买', '逛'].includes(k))
}

/** 水杯现状：在不在手上、还剩多少毫升、装的是什么。没有杯子时也返回形状，调用方少判空。 */
export function 杯态() {
  const d = load(物品P, { items: [] })
  const c = (d.items || []).find((x) => x && x.n === '水杯')
  if (!c) return { 有杯: false, 在包: false, 毫升: 0, 容量: 1000, 成分: [] }
  const 成分 = c.容器 && Array.isArray(c.容器.成分) ? c.容器.成分 : []
  const 量 = 成分.length
    ? 成分.reduce((n, x) => n + (Number(x.量) || 0), 0)
    : Number(c.容器 && c.容器.装) || 0
  return {
    有杯: true, 在包: c.在 === '包', 毫升: Math.round(量),
    容量: Number(c.容器 && c.容器.容量) || 1000, 成分,
  }
}
