// 早间简报.mjs —— 醒来时把「昨晚睡得怎么样、今天想干什么」整理成事实，交给她自己决定说不说
// 用法：
//   node 早间简报.mjs --tick   # 醒来路径调用；同一天重复跑不会重复记
//   node 早间简报.mjs --看     # 只打出来看看
//
// 为什么这么写（批次602，2026-11-17）：
//   · 原来这里用固定句子拼出「早。昨晚睡了 X 小时……」并以 谁:"她" 写进 留言.json，
//     由 投递留言.mjs 直接发到主人手机 —— 话不是她说的，她本人也不知道自己「说过」。
//     这违反拟人化红线：代码只递事实、只影响权重，不替她开口。
//   · 现在只产出结构化事实：明细写 记忆/早间简报-日期.md，摘要记进当天手账（她翻回忆时能看到）；
//     要不要说、什么时候说、怎么说，由她自己调 qq_send。
//   · 不再写 留言.json，也就不存在和 日报/投递留言 抢同一份档的问题。
import fs from "node:fs"
import path from "node:path"

const DIR = process.env.BRIEF_BASE || "{{BOT_ROOT}}"
const MEM = path.join(DIR, "记忆")
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
// 测试可以钉一个「现在」，生产不传就是真实时间。北京时间一律从 UTC+8 算。
const NOW = Number(process.env.BRIEF_NOW_MS) > 0 ? Number(process.env.BRIEF_NOW_MS) : Date.now()
const bj = (ms = NOW) => new Date(ms + 8 * 3600e3)
const today = bj().toISOString().slice(0, 10)
const stamp = bj().toISOString().slice(0, 16).replace("T", " ")
const args = process.argv.slice(2)

const st = load(path.join(MEM, "状态.json"), {})
const asset = load(path.join(MEM, "资产.json"), { 钱: 0 })
const 睡眠 = load(path.join(MEM, "睡眠.json"), { segments: [] })
const 计划 = load(path.join(MEM, "计划.json"), { days: {} })

// 昨晚睡了多久：找今天结束的那一段
//
// SLEEP_MIN 2026-11-06（批次115）：两个坑一起修。
// ① 原来只看「最后一条有 end 的段」，不管它是哪天的 —— 半夜被叫醒时最后一条就是刚眯的几分钟。
// ② 没下限。2026-11-06 那次她 01:22 睡、01:23 醒（一分钟），简报照算，
//    第二天 07:30 她把「昨晚睡了 0 小时」原样说进群里 —— 主人看到的就是这句。
//    一分钟不叫睡了一觉，短于半小时就当没有这段记录，宁可不说。
const MIN_HOURS = 0.5
function 昨晚睡眠() {
  const segs = (睡眠.segments || []).filter((s) => s && s.end)
  const ms = (v) => { const t = Date.parse(String(v || "").slice(0, 16).replace(" ", "T") + ":00+08:00"); return Number.isFinite(t) ? t : 0 }
  // 从后往前找第一段「今天结束」的（昨天的补觉段不算昨晚）
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i]
    const a = ms(seg.start), b = ms(seg.end)
    if (!a || !b || b <= a) continue
    if (bj(b).toISOString().slice(0, 10) !== today) continue
    const h = (b - a) / 3600e3
    if (h < MIN_HOURS) return null
    return { hours: Number(h.toFixed(1)), start: seg.start, end: seg.end }
  }
  return null
}

const 昨夜 = 昨晚睡眠()
const 精力 = Number(st.energy ?? 0)
const 层 = st.layers || {}
const 困意 = Number(st.困意 ?? 0)
const 今日 = (计划.days || {})[today] || { goals: [] }
const 目标 = (今日.goals || []).map((g) => g.id)

// 只陈述事实，不造句、不加语气词。每一条都能在 状态/睡眠/计划/资产 里找到出处。
const 事实 = []
事实.push(`昨晚睡眠：${昨夜 ? 昨夜.hours + " 小时（" + 昨夜.start + " → " + 昨夜.end + "）" : "没有记录"}`)
事实.push(`醒来状态：精力 ${精力}｜困意 ${困意}｜心理 ${层.physical ?? "?"}/${层.emotional ?? "?"}/${层.cognitive ?? "?"}/${层.existential ?? "?"}`)
事实.push(`今天想做：${目标.length ? 目标.join("、") : "还没定"}`)
事实.push(`手头的钱：${Number(asset.钱 ?? 0)}`)

const 摘要 = "【记录】" + (昨夜 ? `昨晚睡了 ${昨夜.hours} 小时；` : "昨晚睡眠没有记录；")
  + `精力 ${精力}，困意 ${困意}；`
  + (目标.length ? `今天想做：${目标.join("、")}。` : "今天还没想好做什么。")

// 原子写文本：临时名带 pid + 随机，避免两个进程往同一个 .tmp 里灌。
function 写文本(p, s) {
  const 临时 = p + ".tmp-" + process.pid + "-" + Math.random().toString(36).slice(2, 8)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(临时, s)
  fs.renameSync(临时, p)
}

// 把事实记进当天手账。手账是 回忆.mjs 真正会读的地方；面板看不到也不影响。
// 同一天重复 --tick 不重复追加；写日记.mjs 若在 15:35 重写手账，这份摘要会跟着没掉，
// 但明细 md 还在，属于可接受的取舍（不在别人的写入口里插锁）。
function 记手账() {
  const p = path.join(MEM, `手账-${today}.md`)
  let 旧 = ""
  try { 旧 = fs.readFileSync(p, "utf8") } catch { /* 还没有今天的 */ }
  if (旧.includes("## 早间（系统记录）")) return false
  const 块 = (旧 && !旧.endsWith("\n") ? "\n" : "") + "\n## 早间（系统记录）\n"
    + 事实.map((x) => "- " + x).join("\n") + "\n"
  fs.appendFileSync(p, 块)
  return true
}

if (args.includes("--看") || args.length === 0) {
  console.log("早间事实：")
  for (const x of 事实) console.log("  - " + x)
  console.log("摘要（只给系统看）：" + 摘要)
  process.exit(0)
}

if (args.includes("--tick")) {
  // MORNING_ONLY 2026-11-06（批次115）：只在早上生成。
  // 半夜醒来不写 —— 那时候本来也不该说「早」。
  const 现在小时 = bj().getUTCHours() + bj().getUTCMinutes() / 60
  if (现在小时 < 5 || 现在小时 >= 10) {
    console.log("（" + bj().toISOString().slice(11, 16) + " 不是早上，先不记）")
    process.exit(0)
  }

  const md = [
    `# ${today} 早间简报`,
    ``,
    ...事实.map((x) => `- ${x}`),
    ``,
    `> 这是系统记录的事实，不是她说的话。要不要说、怎么说，由她自己决定。`,
  ].join("\n")
  写文本(path.join(MEM, `早间简报-${today}.md`), md)
  const 记了 = 记手账()
  console.log("早间事实已记录（" + stamp + "）：" + 摘要 + (记了 ? "" : "（手账里已有，未重复）"))
  process.exit(0)
}

console.log("用法：--tick / --看")
