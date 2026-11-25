// 计划.mjs —— 今天想干点什么：她自己给自己定几件小事，做了就记一笔
// 用法：
//   node 计划.mjs --看        # 今天的目标和进度
//   node 计划.mjs --tick      # 没有就生成（每天最多一次），有就检查做没做
// 为什么这么写：
//   · 目标不是任务清单，是「今天大概想怎样」——所以最多三件，成了是意外之喜，没成也不罚。
//   · 目标从身体和钱包里长出来（缺钱想攒、闷了想玩），不凭空写，避免和她的状态对不上。
//   · 完成不靠人判，靠事实：去没去过、账上有没有进账、活动台账里有没有那类地方。
import { 睡着 } from './睡态.mjs'
import fs from "node:fs"
import { 改档 } from './_底层.mjs'
import path from "node:path"
import { execFileSync } from "node:child_process"
import { saveState, clone } from './_状态.mjs'

const DIR = "{{BOT_ROOT}}"
const MEM = path.join(DIR, "记忆")
const TOOLS = path.join(DIR, "共享/工具")

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
const save = (p, mutate, fallback = { days: {} }) => 改档(p, mutate, fallback)
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace("T", " ")
const 今天 = bj().slice(0, 10)
const args = process.argv.slice(2)
export function 是正经饭购买(记录, 今天) {
  if (!记录 || !String(记录.at || '').startsWith(String(今天 || ''))) return false
  const what = String(记录.what || '')
  return /(?:买了|外卖|跑腿|吃了).*(?:饭|好吃的|火锅|烤肉|烧烤|拉面|麻辣烫|汉堡|寿司|面|饺|包|套餐|便当|披萨|粥)/.test(what)
}

const P = path.join(MEM, "计划.json")

const plan = load(P, { days: {} })
const st = load(path.join(MEM, "状态.json"), {})
const stSnap = clone(st)
const asset = load(path.join(MEM, "资产.json"), { 钱: 0, 位置: "家", 记录: [] })
const 活动 = load(path.join(MEM, "活动台账.json"), { log: [] })
const 地图 = load(path.join(TOOLS, "地图.json"), { 地点: {} })

const 钱 = Number(asset.钱 ?? 0)
const energy = Number(st.energy ?? 60)
const mi = Number((st.mood || {}).intensity ?? 0)
const 困意 = Number(st.困意 ?? 0)

const 今日 = plan.days[今天] || { goals: [], madeAt: null, done: [] }

function 生成() {
  const 池 = []
  if (钱 < 60) 池.push({ id: "挣点钱", 说明: "账上有点薄，想去打一次工", 判: "钱涨过 30" })
  if (energy < 55) 池.push({ id: "好好吃一顿", 说明: "体力不高，想吃顿正经饭", 判: "买过一次饭" })
  if (困意 >= 60) 池.push({ id: "补个觉或者喝咖啡", 说明: "困得厉害", 判: "困意降过 15" })
  if (mi <= -0.6) 池.push({ id: "出门散散心", 说明: "心里有点闷，想去公园或海边", 判: "去过散心的地方" })
  if (mi <= -0.2) 池.push({ id: "看场电影", 说明: "想找点别的事分神", 判: "去过电影院" })
  if (钱 >= 120) 池.push({ id: "去游乐园", 说明: "攒够了，想去坐过山车", 判: "去过游乐园" })
  池.push({ id: "看点书", 说明: "想安静看会儿书", 判: "去过图书馆或学校" })
  // 随机挑，最多三件；倾向越强的排前面
  const 选 = 池.sort(() => Math.random() - 0.5).slice(0, 1 + Math.floor(Math.random() * 3))
  今日.goals = 选
  今日.madeAt = bj()
  今日.done = []
  save(P, (latest) => { latest.days[今天] = 今日 }, { days: {} })
  return 选
}

// 判完成：只看事实，不看她的自述
function 检查() {
  const 完成了 = []
  const 记录 = (asset.记录 || []).filter((r) => String(r.at || "").startsWith(今天))
  const 活动名 = (活动.log || []).filter((x) => String(x.at || "").startsWith(今天))
  const 去过 = new Set(活动名.map((x) => x.地点).filter(Boolean))
  // LINKAGE_FIX 2026-11-12：她真走到某地（资产.记录「走到X」）以及此刻正待在那儿也算去过，
  // 不再只认半小时抽一次概率的 活动台账.json（否则去了没撞上半点就被判没去过）。
  if (asset.位置) 去过.add(String(asset.位置))
  for (const r of 记录) {
    const m = String(r.what || "").match(/走到([^（\s]+)/)
    if (m && m[1]) 去过.add(m[1])
  }
  const 睡档 = load(path.join(MEM, "睡眠.json"), { segments: [] })
  const 自主档 = load(path.join(MEM, "自主.json"), { log: [] })
  const 今日补觉 = (自主档.log || []).some((x) => String(x.at || "").startsWith(今天) && x.state === "打瞌睡")
    || (睡档.segments || []).some((s) => String(s.end || "").startsWith(今天) && Number(s.hours || 0) >= 0.3 && String(s.start || "").slice(11, 13) >= "08")
  const 今日看书 = (自主档.log || []).some((x) => String(x.at || "").startsWith(今天) && x.state === "学点东西")
  for (const g of 今日.goals) {
    if ((今日.done || []).includes(g.id)) continue
    let ok = false
    if (g.id === "挣点钱") ok = 记录.some((r) => /(?:打工|上班：|零工)/.test(String(r.what || "")))
    if (g.id === "好好吃一顿") ok = 记录.some((r) => 是正经饭购买(r, 今天))
    if (g.id === "补个觉或者喝咖啡") ok = 今日补觉 || 记录.some((r) => String(r.what || "").includes("咖啡"))
    if (g.id === "出门散散心") ok = ["公园", "海边", "街市", "水族馆"].some((p) => 去过.has(p))
    if (g.id === "看场电影") ok = 去过.has("电影院")
    if (g.id === "去游乐园") ok = 去过.has("游乐园")
    if (g.id === "看点书") ok = 去过.has("图书馆") || 去过.has("学校") || 今日看书
    if (ok) 完成了.push(g.id)
  }
  return 完成了
}

if (args.includes("--看") || args.length === 0) {
  console.log(`今天：${今天}`)
  if (!今日.goals.length) console.log("  还没定下什么（--tick 会想）")
  else for (const g of 今日.goals) console.log(`  ${(今日.done || []).includes(g.id) ? "✓" : "·"} ${g.id} —— ${g.说明}`)
  process.exit(0)
}

if (args.includes("--tick")) {
  // 睡着不规划，醒了才想
  let msg = ""
  if (!今日.goals.length) {
    // FORCE_PLAN 2026-11-05：--强制 用于「刚醒来那一秒」——那时睡醒标记可能还没翻过来，
    // 但人确实醒了；只给作息调用，日常 tick 仍受睡眠门控
    if (睡着(MEM) && !args.includes("--强制")) { console.log("她在睡，不规划"); process.exit(0) }
    const 选 = 生成()
    msg = "今天想做：" + 选.map((g) => g.id).join("、")
  }
  const 完成 = 检查()
  if (完成.length) {
    今日.done = [...new Set([...(今日.done || []), ...完成])]
    plan.days[今天] = 今日
    save(P, (latest) => {
      const latestToday = latest.days[今天] || { goals: [], madeAt: null, done: [] }
      latestToday.done = [...new Set([...(latestToday.done || []), ...完成])]
      latest.days[今天] = latestToday
    }, { days: {} })
    for (const id of 完成) {
      const ev = id.includes("吃") ? "吃饭" : id.includes("散") ? "晒太阳" : id.includes("电影") ? "电影" : id.includes("游乐") ? "玩过山车" : "看书"
      try { execFileSync(process.execPath, [path.join(TOOLS, "激素.mjs"), "--event", ev, "--id", 'plan:' + 今天 + ':' + id], { encoding: "utf8" }) } catch (_err) { console.error('[计划]', _err?.message || _err) }
    }
    // 做成一件，情绪给一点点——不设「必须全做完」，完成一件就算赚到
    const m = st.mood || (st.mood = {})
    m.intensity = Math.round((Number(m.intensity || 0) + 0.1 * 完成.length) * 100) / 100
    saveState(path.join(MEM, "状态.json"), st, stSnap)
    console.log((msg ? msg + "；" : "") + "做成了：" + 完成.join("、") + `（心情 +${(0.1 * 完成.length).toFixed(1)}）`)
  } else {
    console.log(msg || "今天的小事还在推进中")
  }
  process.exit(0)
}

console.log("用法：--看 / --tick")
