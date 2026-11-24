// 快照.mjs —— 每天记一条她这一天的样子，方便以后看趋势
// 用法：
//   node 快照.mjs --tick    # 记今天的（同一天重复跑会覆盖当天那条）
//   node 快照.mjs --看      # 看最近几天的
// 为什么这么写：状态文件只保存「此刻」，过去的东西不留就等于没有。
// 一天一条、只留数值和去处，不做分析——分析留给以后想看的时候再说。
import fs from "node:fs"
import { 加锁 } from './_锁.mjs'
import * as 账本 from './账本.mjs'
import path from "node:path"

const MEM = process.env.FISH_SANDBOX_DIR || "{{BOT_ROOT}}/记忆"
const P = path.join(MEM, "每日快照.json")

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
// ATOMIC_WRITE 2026-11-05：先写临时文件再改名。两个定时任务撞在同一秒时，
// 最坏是丢一次更新，但绝不会留下半截 JSON 把她的数据读崩。
// LOCKED_WRITE 2026-11-05：外面再套一把「抢不到就放弃」的软锁，减少同时写的概率；
// 锁失败不阻塞（见 _锁.mjs），所以不会让定时任务卡住。
const save = (p, o) => {
  const 放 = 加锁(p.split('/').pop())
  try {
    const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    fs.writeFileSync(tmp, JSON.stringify(o, null, 2))
    fs.renameSync(tmp, p)
  } finally { 放() }
}
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3)
const 今天 = bj().toISOString().slice(0, 10)
const args = process.argv.slice(2)

const st = load(path.join(MEM, "状态.json"), {})
const asset = load(path.join(MEM, "资产.json"), { 钱: 0, 位置: "家", 记录: [] })
const 活动 = load(path.join(MEM, "活动台账.json"), { log: [] })
const 计划 = load(path.join(MEM, "计划.json"), { days: {} })
const 好感 = load(path.join(MEM, "好感度.json"), { people: {} })

const 今日活动 = (活动.log || []).filter((x) => String(x.at || "").startsWith(今天))
const 去过 = {}
for (const x of 今日活动) 去过[x.地点] = (去过[x.地点] || 0) + 1
const 记录 = (asset.记录 || []).filter((r) => String(r.at || "").startsWith(今天))
// 批次174：口径在 账本.mjs。这份原来认「给了」但不认「打工赚了 20」（没有「块」字），
// 于是 11-03 她挣了 1137 这天，历史快照记的是 赚 0。
// 那个 else if 也有问题：一笔既像花又像赚的记录只能进一边。
const __账 = 账本.汇总(记录)
const 花 = __账.花, 赚 = __账.赚
const 计划今日 = (计划.days || {})[今天] || { goals: [], done: [] }
const 我 = ((好感.people || {})["{{OWNER_UIN}}"] || {}).score

const 条 = {
  date: 今天,
  money: Number(asset.钱 ?? 0),
  energy: Number(st.energy ?? 0),
  困意: Number(st.困意 ?? 0),
  mood: Number((st.mood || {}).intensity ?? 0),
  layers: st.layers || {},
  花, 赚, 被拿: __账.被拿,
  去过,
  计划: { 定了: (计划今日.goals || []).length, 做成: (计划今日.done || []).length },
  好感: 我,
}


if (args.includes("--看")) {
  const snap = load(P, { days: [] })
  for (const d of (snap.days || []).slice(-7)) {
    console.log(`${d.date}｜钱 ${d.money}｜体力 ${d.energy}｜困意 ${d.困意}｜心情 ${d.mood}｜花 ${d.花} 赚 ${d.赚}｜计划 ${d.计划.做成}/${d.计划.定了}｜去过 ${Object.keys(d.去过 || {}).join("、") || "没出门"}`)
  }
  process.exit(0)
}

if (args.includes("--tick")) {
  const snap = load(P, { days: [] })
  snap.days = Array.isArray(snap.days) ? snap.days : []
  const i = snap.days.findIndex((d) => d.date === 今天)
  if (i >= 0) snap.days[i] = 条
  else snap.days.push(条)
  snap.days = snap.days.slice(-120)   // 留四个月
  save(P, snap)
  console.log(`记下 ${今天}：钱 ${条.money}｜体力 ${条.energy}｜心情 ${条.mood}｜花 ${花} 赚 ${赚}｜去过 ${Object.keys(去过).join("、") || "没出门"}`)
  process.exit(0)
}

console.log("用法：--tick / --看")
