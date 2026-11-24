#!/usr/bin/env node
/**
 * 工具用量.mjs —— 从宿主会话流统计「哪些工具真在用」（批次396）
 *
 * 为什么要有这个，而不是直接用 记忆/工具调用.jsonl：
 *   `lib/toolrecord.js` 的账本靠劫持 `tools.register` 记账，只能包到
 *   「劫持之后、走同一个 tools 服务」注册的工具。实测（2026-11-14）：
 *     会话流里出现过 56 种工具，账本只记了 26 种，**漏掉 30 种** ——
 *     包括使用量最大的 memory_update 533 次、memory_remember 449 次、memory_judge 435 次，
 *     以及 web_search 20 / web_fetch 24 / read_animation 7 / search_meme_wiki 18。
 *   后果不是「少几个数字」，是**判据会骗人**：批次395 我拿账本判「12 个工具零调用」，
 *   其中 read_animation / search_meme_wiki / memory_* 全在正常使用，结论整批作废。
 *
 *   所以分工：
 *     · 工具调用.jsonl  —— 记细节（参数摘要、耗时、成败），只覆盖插件自己的工具；
 *     · 工具用量.json    —— 记「用没用过」（宿主自己写的 stream.jsonl，一行不落），判据一律用它。
 *
 * 用法：
 *   node 工具用量.mjs                 # 默认窗口 7 天，打一张表并写 记忆/工具用量.json
 *   node 工具用量.mjs --天 30          # 换窗口
 *   node 工具用量.mjs --静             # 心跳用：不打印，只落盘
 *   node 工具用量.mjs --打印           # 强制打印
 *
 * 环境变量（沙盒测试用）：
 *   USAGE_HOME   默认 {{DSH_ROOT}}/hippocampus（下面每个 <会话>/stream.jsonl 都算）
 *   USAGE_MEM    默认 {{BOT_ROOT}}/记忆
 *   USAGE_CONFIG 默认 {{DSH_ROOT}}/qq-bridge.config.json（取「工具白名单」算零调用）
 */
import { readFileSync, writeFileSync, readdirSync, statSync, renameSync, existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

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

const HOME = process.env.USAGE_HOME || '{{DSH_ROOT}}/hippocampus'
const MEM = process.env.USAGE_MEM || '{{BOT_ROOT}}/记忆'
const CFG = process.env.USAGE_CONFIG || '{{DSH_ROOT}}/qq-bridge.config.json'

const args = process.argv.slice(2)
const 取参 = (k, d) => {
  const i = args.indexOf(k)
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d
}
const 天 = Math.max(1, Math.min(90, Number(取参('--天', 7)) || 7))
const 静 = args.includes('--静')
const 打印 = args.includes('--打印') || !静

const 京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 日 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)
const 读 = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

// ── 1. 找到所有会话流 ─────────────────────────────────────────────
const 流们 = []
try {
  for (const d of readdirSync(HOME)) {
    const p = join(HOME, d, 'stream.jsonl')
    let st
    try { st = statSync(p) } catch { continue }
    流们.push({ 会话: d, 路: p, 字节: st.size, mtime: st.mtimeMs })
  }
} catch { /* 目录不在就一路空跑 */ }

if (!流们.length) {
  // 故意不动已有的 工具用量.json —— 会话流暂时读不到（路径改了/权限坏了）时，
  // 把上一份好数据覆盖成「全都是 0」比不更新更糟：面板会显示「她什么都没用过」。
  // 新装的 bot / QQ 还没上线时本来就一条流都没有，这不是故障，别让心跳刷「需要你处理」。
  if (打印) console.error(`还没有会话流：${HOME}/*/stream.jsonl（保留已有的 工具用量.json）`)
  process.exit(0)
}

// ── 2. 数 ────────────────────────────────────────────────────────
const 起 = Date.now() - 天 * 86400e3
const 按工具 = new Map()  // 名字 -> { 次, 最后 }
const 按天 = new Map()    // 日 -> Map(名字 -> 次)
const 按会话 = new Map()  // 会话 -> Map(名字 -> 次)
let 扫描行 = 0, 工具行 = 0, 坏行 = 0, 窗口最早 = 0, 窗口最晚 = 0

for (const f of 流们) {
  const 文 = 读(f.路)
  if (!文) continue
  for (const l of 文.split('\n')) {
    if (!l.trim()) continue
    扫描行++
    let d
    try { d = JSON.parse(l) } catch { 坏行++; continue }
    const t = d.tool
    // tool 可能是字符串，也可能是 { name } 对象 —— 两种都见过，别只认一种
    const 名 = typeof t === 'string' ? t : (t && typeof t === 'object' ? (t.name || t.tool) : null)
    if (!名 || typeof 名 !== 'string') continue
    const ts = Number(d.ts) || 0
    if (!ts || ts < 起) continue

    工具行++
    if (!窗口最早 || ts < 窗口最早) 窗口最早 = ts
    if (ts > 窗口最晚) 窗口最晚 = ts

    const a = 按工具.get(名) || { 次: 0, 最后: 0 }
    a.次++
    if (ts > a.最后) a.最后 = ts
    按工具.set(名, a)

    const 天键 = 日(ts)
    const b = 按天.get(天键) || new Map()
    b.set(名, (b.get(名) || 0) + 1)
    按天.set(天键, b)

    const s = 按会话.get(f.会话) || new Map()
    s.set(名, (s.get(名) || 0) + 1)
    按会话.set(f.会话, s)
  }
}

// ── 3. 对白名单，算「零调用」 ──────────────────────────────────────
const 白名单 = (() => {
  try {
    const c = JSON.parse(读(CFG))
    return Array.isArray(c['工具白名单']) ? c['工具白名单'].map(String) : []
  } catch { return [] }
})()
const 用过 = new Set(按工具.keys())
const 零调用 = 白名单.filter((n) => !用过.has(n)).sort()
// 名单外 = 没下发但在用（宿主工具 / 历史遗留），列出来才看得见全貌
const 名单外 = 白名单.length ? [...用过].filter((n) => !白名单.includes(n)).sort() : []

// ── 4. 落盘（原子写）────────────────────────────────────────────
const 出 = {
  生成于: 京(Date.now()),
  窗口天: 天,
  窗口起: 窗口最早 ? 京(窗口最早) : '',
  窗口止: 窗口最晚 ? 京(窗口最晚) : '',
  数据源: 流们.map((f) => ({ 会话: f.会话, 字节: f.字节, 最后写: 京(f.mtime) })),
  扫描行数: 扫描行,
  工具行数: 工具行,
  坏行数: 坏行,
  按工具: Object.fromEntries(
    [...按工具.entries()]
      .sort((a, b) => b[1].次 - a[1].次)
      .map(([k, v]) => [k, { 次: v.次, 最后: 京(v.最后) }]),
  ),
  按天: Object.fromEntries(
    [...按天.entries()]
      .sort()
      .map(([k, m]) => [k, Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]))]),
  ),
  按会话: Object.fromEntries(
    [...按会话.entries()].map(([k, m]) => [k, Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]))]),
  ),
  白名单: 白名单.length,
  // 白名单本身也要落盘：体检要拿它区分「下发了没调用」和「压根没下发」——
  // 后者不该报警（qq_audio_understand / qq_emoji_search / qq_qzone_post 注册了但没下发，
  // 报成「零调用」只会训练人忽略体检输出）。
  白名单工具: 白名单,
  零调用,
  名单外,
}

const 目标 = join(MEM, '工具用量.json')
const 临时 = 目标 + '.tmp'
try {
  writeFileSync(临时, JSON.stringify(出, null, 1) + '\n', 'utf8')
  renameSync(临时, 目标)
} catch (e) {
  try { if (existsSync(临时)) unlinkSync(临时) } catch { /* 清不掉就算了 */ }
  console.error('写 工具用量.json 失败：' + String((e && e.message) || e).slice(0, 120))
  process.exit(1)
}

// ── 5. 打印 ─────────────────────────────────────────────────────
if (打印) {
  const pad = (s, n) => String(s).padEnd(n)
  console.log(`窗口 ${天} 天（${出.窗口起} ~ ${出.窗口止}）｜会话流 ${流们.length} 个｜工具行 ${工具行}｜坏行 ${坏行}`)
  console.log('')
  console.log(pad('工具', 24) + pad('次数', 8) + '最后')
  console.log('-'.repeat(56))
  for (const [k, v] of Object.entries(出.按工具)) console.log(pad(k, 24) + pad(v.次, 8) + v.最后)
  if (白名单.length) {
    console.log('')
    console.log(`白名单 ${白名单.length} 个，窗口内零调用 ${零调用.length} 个：${零调用.join(' ') || '（无）'}`)
  }
  if (名单外.length) {
    console.log('')
    console.log(`名单外还在用（宿主工具/历史遗留）${名单外.length} 个：${名单外.join(' ')}`)
  }
}
}
