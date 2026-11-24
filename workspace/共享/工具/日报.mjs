// 日报.mjs —— 晚上把「今天过得怎么样」整理成事实，留给她自己决定要不要说
// 用法：
//   node 日报.mjs --tick    # 生成今天的（同一天只写一条，重跑会替换）
//   node 日报.mjs --看      # 打出来看看会记什么，不写
//
// 为什么这么写（批次602，2026-11-17）：
//   · 2026-11-13 主人：「这种跟机器人一样的话就不用留给我了 你写自己想给我写的就行了」。
//     旧版从候选句库挑句子拼成「今天去了……就这样吧。」，再以 谁:"她" 写进 留言.json
//     由 投递留言.mjs 直接发到手机 —— 这是代码替她说话，她本人不知道。
//   · 现在只写事实：去处、打工趟数、计划完成度、心情强度。
//     条目显式标 谁:"系统"、不投递:true，只给面板和 生活体检 看；投递器不会把它发出去。
//     要不要说、怎么说，由她自己调 qq_send。
//   · 留言.json 的读-改-写统一走 _底层.改档()（带锁重读 + 原子写），
//     不再和 投递留言.mjs / 早间简报.mjs 各拿一份旧快照互相覆盖。
import { 改档 } from './_底层.mjs'
import fs from "node:fs"
import path from "node:path"

const DIR = process.env.QQ_AUTONOMY_MEM ? path.dirname(process.env.QQ_AUTONOMY_MEM) : "{{BOT_ROOT}}"
const MEM = process.env.QQ_AUTONOMY_MEM || path.join(DIR, "记忆")
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
// 测试可以钉一个「现在」，生产不传就是真实时间。
const NOW = Number(process.env.DAILY_NOW_MS) > 0 ? Number(process.env.DAILY_NOW_MS) : Date.now()
const bj = (ms = NOW) => new Date(ms + 8 * 3600e3)
const today = bj().toISOString().slice(0, 10)
const stamp = bj().toISOString().slice(0, 16).replace("T", " ")
const args = process.argv.slice(2)

const 账 = load(path.join(MEM, "资产.json"), { 记录: [] })
const 活动 = load(path.join(MEM, "活动台账.json"), { log: [] })
const 计划 = load(path.join(MEM, "计划.json"), { days: {} })
const st = load(path.join(MEM, "状态.json"), {})

const 今日记录 = (账.记录 || []).filter((r) => String(r.at || "").startsWith(today))
// 只留一件日报关心的事：今天去打工了没有。
// 「上班：便利店夜班（475 分钟，130 块，扣了 20）」是批次145 之后的新格式，两个词都认。
let 打工次数 = 0
for (const r of 今日记录) if (/打工|上班：/.test(String(r.what || ""))) 打工次数 += 1

const 今日活动 = (活动.log || []).filter((x) => String(x.at || "").startsWith(today) && x.生效)
const 去处 = [...new Set(今日活动.map((x) => x.地点).filter(Boolean))]
const 计划今日 = (计划.days || {})[today] || { goals: [], done: [] }
const 做成 = (计划今日.done || []).length
const 定了 = (计划今日.goals || []).length
const 心情 = Number((st.mood || {}).intensity ?? 0)

// 只陈述事实，不挑句、不造句。
const 事实 = []
事实.push(`去处：${去处.length ? 去处.join("、") : (打工次数 ? "出门上了班" : "没出门")}`)
if (打工次数) 事实.push(`打工：${打工次数} 趟`)
事实.push(`计划：${定了 ? `做成 ${做成}/${定了}` : "今天没定计划"}`)
事实.push(`心情强度：${心情}`)

const 去处句 = !去处.length
  ? (打工次数 ? "今天出门上了班" : "今天没出门")
  : (去处.length === 1 && 去处[0] === "家" ? "今天在家" : `今天去了${去处.join("、")}`)
const 摘要 = "【记录】" + [
  去处句,
  打工次数 ? `打工 ${打工次数} 趟` : "",
  定了 ? `计划做成 ${做成}/${定了}` : "今天没定计划",
  `心情 ${心情}`,
].filter(Boolean).join("；") + "。"

// 原子写文本：临时名带 pid + 随机，避免两个进程往同一个 .tmp 里灌。
function 写文本(p, s) {
  const 临时 = p + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(临时, s)
  fs.renameSync(临时, p)
}

function 记手账() {
  const p = path.join(MEM, `手账-${today}.md`)
  let 旧 = ""
  try { 旧 = fs.readFileSync(p, "utf8") } catch { /* 还没有今天的 */ }
  if (旧.includes("## 晚上（系统记录）")) return false
  const 块 = (旧 && !旧.endsWith("\n") ? "\n" : "") + "\n## 晚上（系统记录）\n"
    + 事实.map((x) => "- " + x).join("\n") + "\n"
  fs.appendFileSync(p, 块)
  return true
}

if (args.includes("--看") || args.length === 0) {
  console.log("今天的事实：")
  for (const x of 事实) console.log("  - " + x)
  console.log("摘要（只给系统看）：" + 摘要)
  process.exit(0)
}

if (args.includes("--tick")) {
  // 同一天只留一条：先删当天的旧记录，再 push 新的。
  const 新 = {
    id: "daily-" + today,
    at: stamp,
    谁: "系统",
    话: 摘要,
    事实,
    kind: "日报",
    不投递: true,
  }
  改档(path.join(MEM, "留言.json"), (nb) => {
    if (!Array.isArray(nb.items)) nb.items = []
    nb.items = nb.items.filter((x) => !(x && x.kind === "日报" && String(x.at || "").startsWith(today)))
    nb.items.push(新)
    nb.items = nb.items.slice(-50)
  }, { items: [] })

  const md = [
    `# ${today} 日报`,
    ``,
    ...事实.map((x) => `- ${x}`),
    ``,
    `> 这是系统记录的事实，不是她说的话。要不要说、怎么说，由她自己决定。`,
  ].join("\n")
  写文本(path.join(MEM, `日报-${today}.md`), md)
  const 记了 = 记手账()
  console.log("日报事实已记录（" + stamp + "）：" + 摘要 + (记了 ? "" : "（手账里已有，未重复）"))
  process.exit(0)
}

console.log("用法：--tick / --看")
