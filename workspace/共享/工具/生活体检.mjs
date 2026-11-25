// 生活体检.mjs —— 她这套生活系统自己盯着自己
// 用法：
//   node 生活体检.mjs          # 打一遍，看有没有不转的地方
//   node 生活体检.mjs --静     # 只在有问题时说话（给 cron 用）
// 为什么这么写：
//   · 只查「有没有在转」和「数值有没有烂」，不判断好坏——判断留给人。
//   · 日志按「最近一次出现的时间」判断新鲜度，不看行数：行数多不代表今天在跑。
//   · 每一项都分开报，免得一个坏掉把别的遮了。
import { 睡着, 判据 } from './睡态.mjs'
import fs from "node:fs"
import path from "node:path"
// PHOTO_ID 2026-11-07（批次161）：数照片别把截图数进去。
import { 是成品图 } from "./成品图.mjs"
import { 某天 } from "./账本.mjs"

// ENTRY_GUARD 2026-11-14（批次459）：被 import 时不要跑主流程。
// 冒烟测试「逐个 import」会把每个 .mjs 当 CLI 真跑一遍（457 实测一次写 16 个真档），
// 而这些脚本顶层就是整条流程。只有 `node <本文件>` 才执行下面的主流程；被 import 时是空模块。
// 用 __path/__fileURLToPath 这两个别名，避免和各文件已有的 path/join 撞名。
import __path from 'node:path'
import { fileURLToPath as __fileURLToPath } from 'node:url'
const 是入口 = (() => {
  try { return !!process.argv[1] && __path.resolve(process.argv[1]) === __fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {

const DIR = "{{BOT_ROOT}}"
const MEM = path.join(DIR, "记忆")
const LOG = path.join(MEM, "日志", "生活体检.log")
const args = process.argv.slice(2)
const 静 = args.includes("--静")

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return d } }
const 有 = (p) => fs.existsSync(p)
const now = Date.now()
const bj = (ms = now) => new Date(ms + 8 * 3600e3)
const 今天 = bj().toISOString().slice(0, 10)
const 分钟前 = (ms) => Math.round((now - ms) / 60e3)

const 结果 = []
const 记 = (级, 名, 说明) => 结果.push({ 级, 名, 说明 })   // 级: ok / warn / bad

// 醒来结算 2026-11-15（批次502）：`醒来.log` 是这一批新加的黑匣子。
// 有内容 = endSleep 抛了异常，或者被调用时 live 已经空（早退）—— 两种都该看一眼。
// 没有文件 = 从来没出过事，这是「正常」，不是「没在跑」。
try {
  const wp = path.join(MEM, '日志', '醒来.log')
  if (!有(wp)) 记('ok', '醒来结算', '没有失败记录（文件还没建过）')
  else {
    const 行 = fs.readFileSync(wp, 'utf8').split('\n').filter((l) => l.startsWith(今天))
    if (行.length) 记('warn', '醒来结算', '今天 ' + 行.length + ' 条失败：' + 行[行.length - 1].slice(0, 100))
    else 记('ok', '醒来结算', '今天没有失败记录')
  }
} catch (e) { 记('warn', '醒来结算', '读不了：' + String(e.message).slice(0, 60)) }

// 1) 面板在不在
//
// PANEL_OPTIONAL 2026-11-24：原来面板连不上就记 bad → 整个体检 exit 1 →
// 心跳把它当「任务失败」。而面板是**可选组件**：{{ALT_BOT_DISPLAY}} VPS 上 fish-panel.service
// 就是 inactive(dead)，于是这条体检**每个整点必然失败**，连败账一路涨到 21 次，
// 待办里永远挂着一条假警报，真正的失败被淹没。
//
// 现在先探测端口：没有进程在听 = 这台机器本来就不装面板 → 记 ok(跳过)；
// 有进程在听但连不上 = 面板真坏了 → 才记 bad。
function 端口在听(p) {
  const hex = p.toString(16).toUpperCase().padStart(4, '0')
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const txt = String(fs.readFileSync(f, 'utf8'))
      for (const line of txt.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c.length < 4) continue
        if ((c[1] || '').endsWith(':' + hex) && c[3] === '0A') return true
      }
    } catch { /* 读不到就跳过 */ }
  }
  return false
}
const 面板端口 = Number(process.env.PANEL_PORT || 8788)
if (!端口在听(面板端口)) {
  记("ok", "面板 " + 面板端口, "本机未启用（跳过）")
} else {
  try {
    const r = await fetch("http://127.0.0.1:" + 面板端口 + "/", { signal: AbortSignal.timeout(5000) })
    记(r.ok || r.status === 302 ? "ok" : "bad", "面板 " + 面板端口, "HTTP " + r.status)
  } catch (e) { 记("bad", "面板 " + 面板端口, "端口在听但连不上（真故障）") }
}

// 2) 日志新鲜度：多久没动静了
for (const [文件, 上限分钟] of [["走路.log", 20], ["缺口.log", 90], ["活动.log", 90], ["计划.log", 120]]) {
  const p = 有(path.join(MEM, "日志", 文件)) ? path.join(MEM, "日志", 文件) : path.join(MEM, 文件)
  if (!有(p)) { 记("warn", 文件, "还没生成（cron 可能还没跑过）"); continue }
  const st = fs.statSync(p)
  const m = 分钟前(st.mtimeMs)
  // STALE_TIER 2026-11-24：从 bad 降成 warn。日志「很久没动」多半是
  // 那个任务被停用/睡着跳过，不是她坏了 —— 记 bad 会把整份体检判红，
  // 反而盖住「钱对不上 / 四层越界」这类真问题。
  if (m > 上限分钟 * 3) 记("warn", 文件, `已经 ${m} 分钟没动静`)
  else if (m > 上限分钟) 记("warn", 文件, `${m} 分钟没动静（通常该有更近的）`)
  else 记("ok", 文件, `${m} 分钟前还在动`)
}

// 3) 关键数据文件在不在、数值烂没烂
const 必须 = ["状态.json", "资产.json", "自主.json", "睡醒.json", "计划.json", "每日快照.json", "活动台账.json", "缺口台账.json"]
for (const f of 必须) 有(path.join(MEM, f)) ? 记("ok", f, "在") : 记("warn", f, "还没生成")

const st = load(path.join(MEM, "状态.json"), {})
const L = st.layers || {}
const 层好 = ["physical", "emotional", "cognitive", "existential"].every((k) => L[k] === undefined || (L[k] >= 0 && L[k] <= 100))
记(层好 ? "ok" : "bad", "四层数值", 层好 ? "都在 0-100" : "有越界的层")
记(Number.isFinite(Number(st.energy)) ? "ok" : "bad", "精力", "energy=" + st.energy)
记(Number(st.困意 ?? 0) >= 0 && Number(st.困意 ?? 0) <= 160 ? "ok" : "warn", "困意", "困意=" + st.困意)

const a = load(path.join(MEM, "资产.json"), {})
记(Number(a.钱) >= 0 ? "ok" : "bad", "钱", "钱=" + a.钱)
记(a.位置 ? "ok" : "warn", "位置", "人在" + (a.位置 || "?"))

// 4) 今天的快照
const snap = load(path.join(MEM, "每日快照.json"), { days: [] })
const 有今天 = (snap.days || []).some((d) => d.date === 今天)
记(有今天 ? "ok" : "warn", "今日快照", 有今天 ? "有了（23:50 会覆盖成终版）" : "还没记今天")

记("ok", "睡醒标记", 睡着(MEM) ? "睡着（自主动作会跳过）" : "醒着")

// SLEEP_SPLIT 2026-11-07（批次164）：两套标记各有各的复位路径（endSleep 写两个、
// 醒来.mjs 的「已经醒了」分支只写 睡醒.json、endSleep 抛异常时两边各留一半）。
// 任一条漏掉就分叉：一个说在睡、一个说醒着，然后 房间/投递留言 和 缺口/自主行动
// 给出相反的答案。每 6 小时把四个来源摆一次，分叉当场看得见。
{
  const 睡 = 判据(MEM)
  const 岔 = 睡.标记文件在 && 睡.睡醒标记 !== 睡.睡眠段
  记(岔 ? "warn" : "ok", "睡眠判据",
    (睡.标记文件在 ? (睡.睡醒标记 ? "标记:在睡" : "标记:醒着") : "标记:没有")
    + "｜段:" + (睡.睡眠段 ? "开着 " + 睡.段起点 : "已关")
    + "｜打盹:" + (睡.打盹 ? "是" : "否")
    + "｜门控:" + (睡.睡着 ? "拦住" : "放行")
    + (岔 ? "   ← 两个来源不一致（看 睡态.mjs 顶部注释）" : ""))
}

// 5) 计划：醒着却没定今天的小事，隔太久就该管
const plan = load(path.join(MEM, "计划.json"), { days: {} })
const 今日计划 = (plan.days || {})[今天]
if (睡着(MEM)) 记("ok", "今日计划", "睡着，不定")
else if (!今日计划 || !(今日计划.goals || []).length) 记("warn", "今日计划", "醒着但今天还没定事")
else 记("ok", "今日计划", `定了 ${今日计划.goals.length} 件，做成 ${(今日计划.done || []).length} 件`)

// 6) 在途别卡死：超过 6 小时还没到，说明结算没在跑
if (a.在途 && a.在途.arriveAt && now - Number(a.在途.arriveAt) > 6 * 3600e3) {
  记("bad", "在途", "卡在路上超过 6 小时，结算没在跑")
} else if (a.在途) {
  记("ok", "在途", `去${a.在途.to}，还有 ${Math.max(0, Math.ceil((a.在途.arriveAt - now) / 60e3))} 分钟`)
}

// SELFIE_QUEUE 2026-11-05：自拍请求积压说明本机那个常驻小工没在跑——
// 生成停掉之后她要是想拍照，请求就会一直躺着，得有人提醒
try {
  const dir = '{{BOT_ROOT}}/共享/自拍/请求'
  const fs2 = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
  if (!fs2.length) 记('ok', '自拍请求', '队列空着')
  else {
    const 最老 = Math.min(...fs2.map((f) => fs.statSync(dir + '/' + f).mtimeMs))
    const m = 分钟前(最老)
    if (m > 120) 记('warn', '自拍请求', `积压 ${fs2.length} 条，最老 ${m} 分钟没取（自拍工没在跑）`)
    else 记('ok', '自拍请求', `${fs2.length} 条在等，最老 ${m} 分钟`)
  }
  const 成品 = '{{BOT_ROOT}}/共享/自拍/成品'
  const n = fs.existsSync(成品) ? fs.readdirSync(成品).filter(是成品图).length : 0
  记('ok', '自拍成品', n + ' 张')
} catch (e) { 记('warn', '自拍目录', '读不到') }

// HORMONE_CHECK 2026-11-05：激素文件可读、四个值都在 0~100（激素是情绪的底色，
// 它坏了面板上看着一切正常，但她的反应会变得不对劲）
try {
  const hj = load(path.join(MEM, '激素.json'), {})
  const v = hj.v || {}
  const 名 = { dopamine: '多巴胺', cortisol: '皮质醇', oxytocin: '催产素', gaba: 'GABA' }
  const 坏 = Object.keys(名).filter((k) => !(Number(v[k]) >= 0 && Number(v[k]) <= 100))
  记(坏.length ? 'bad' : 'ok', '激素', 坏.length ? '越界或缺失：' + 坏.map((k) => 名[k]).join('、') : Object.keys(名).map((k) => 名[k] + ' ' + Number(v[k]).toFixed(0)).join(' '))
} catch (e) { 记('warn', '激素', '读不到 激素.json') }

// DAILY_CHECK 2026-11-05：晚上九点以后应该有当天的「日报」，没有就是日志/留言那条链路断了
try {
  const 留言 = load(path.join(MEM, '留言.json'), { items: [] })
  const 有日报 = (留言.items || []).some((x) => x.kind === '日报' && String(x.at || '').startsWith(今天))
  const 小时 = Number(bj().toISOString().slice(11, 13))
  if (小时 >= 21 && !有日报) 记('warn', '今天的日报', '九点过了还没写（日报.mjs 可能没跑）')
  else if (有日报) 记('ok', '今天的日报', '写了')
} catch (e) { 记('warn', '今天的日报', '读不到留言') }

// LEDGER_CHECK 2026-11-07（批次174）：账本和钱包要能对上。
// 今天钱的变化，必须等于账本算出的 赚 - 花 - 被拿。对不上只有两种可能：
//   · 有一笔钱动了却没进 资产.记录（改了钱没记账）
//   · 账本的写法 账本.mjs 认不出来（新加了一种记录格式）
// 这条是跨文件对账 —— 批次174 之前，同一个「今天花了多少」有四处各算一遍，
// 差出几十块都没人发现，因为没有任何一处去和「钱」对过。
try {
  const 资 = load(path.join(MEM, '资产.json'), { 记录: [] })
  const snap = (load(path.join(MEM, '每日快照.json'), { days: [] }).days || [])
    .filter((d) => Number.isFinite(Number(d.money)))
  const 昨 = [...snap].reverse().find((d) => d.date < 今天)
  if (!昨) 记('ok', '账本对账', '还没有前一天的快照')
  else {
    const 账 = 某天(资.记录 || [], 今天)
    const 差 = Math.round(Number(资.钱 || 0) - Number(昨.money || 0))
    const 该 = Math.round(账.赚 - 账.花 - 账.被拿)
    const 偏 = 差 - 该
    记(Math.abs(偏) <= 1 ? 'ok' : 'warn', '账本对账',
      Math.abs(偏) <= 1
        ? '钱 ' + 昨.money + '→' + Number(资.钱 || 0) + '，账本 赚' + 账.赚 + ' 花' + 账.花 + ' 对得上'
        : '钱变了 ' + 差 + '，账本只算出 ' + 该 + '（差 ' + 偏 + ' —— 有笔钱没记账，或写法认不出）')
  }
} catch (e) { 记('warn', '账本对账', '算不动：' + e.message) }

const bad = 结果.filter((x) => x.级 === "bad").length
const warn = 结果.filter((x) => x.级 === "warn").length
const 摘要 = `生活体检：${结果.length - bad - warn} 正常 / ${warn} 提醒 / ${bad} 不对`

if (!静 || bad || warn) {
  console.log(摘要)
  for (const r of 结果) if (r.级 !== "ok" || !静) console.log(`  ${r.级 === "ok" ? "✓" : r.级 === "warn" ? "·" : "✗"} ${r.名}：${r.说明}`)
}
try {
  // DIAG 2026-11-14（批次483）：原来只往 log 写摘要，明细只打 stdout ——
  // 11-09~11-13 那 8 次「2 不对」事后完全查不出是哪两项，只能猜。
  // 现在把非 ok 的项一起写进 log（ok 项太多不记），下次再出就能直接对上。
  const 明细 = 结果.filter((r) => r.级 !== "ok").map((r) => `  ${r.级 === "warn" ? "·" : "✗"} ${r.名}：${r.说明}`)
  fs.appendFileSync(LOG, `${bj().toISOString().slice(0, 16).replace("T", " ")} ${摘要}${明细.length ? "\n" + 明细.join("\n") : ""}\n`)
} catch (_err) { console.error('[生活体检]', _err?.message || _err) }
process.exit(bad ? 1 : 0)
}
