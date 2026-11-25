#!/usr/bin/env node
// 自动学习.mjs —— 从所有活跃群聊日志里抽取「真人平时怎么说话」，写进学习笔记（按当前 selfUin 排除她自己）
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
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

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const dry = args.includes('--dry')
let SELF = ''
try {
  const cfg = JSON.parse(readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8'))
  SELF = String(cfg?.selfUin ?? '').trim()
} catch { /* 配置不可读时不误排除任何新号 */ }
const now = new Date(Date.now() + 8 * 3600e3)
const day = val('--day', now.toISOString().slice(0, 10))

const logDir = '{{BOT_ROOT}}/群聊日志'
const files = existsSync(logDir)
  ? readdirSync(logDir).filter((f) => f.endsWith('.jsonl') && f.includes(day))
  : []
if (!files.length) { console.log('今天还没有群聊日志：' + day); process.exit(0) }

const byWho = new Map()
const 是占位 = (t) => /^\[(file|image|face|record|video|json|xml|reply|at|mface|bface|forward|图片|表情)[^\]]*\]$/i.test(String(t || '').trim())

const push = (uid, name, text) => {
  if (String(uid) === SELF || name === '{{ALT_BOT_DISPLAY}}') return
  const t = String(text || '').replace(/\[\[at:\d+\]\]|@\S+/g, '').trim()
  if (!t || 是占位(t) || t.startsWith('[')) return
  if (!byWho.has(name)) byWho.set(name, [])
  byWho.get(name).push(t)
}

for (const f of files) {
  const raw = readFileSync(join(logDir, f), 'utf8').split('\n').filter(Boolean)
  for (const line of raw) {
    try {
      const j = JSON.parse(line)
      const uid = String(j.sender?.user_id || j.user_id || '')
      const name = j.sender?.card || j.sender?.nickname || j.nickname || uid || '?'
      let text = j.raw_message || j.text || ''
      if (!text && Array.isArray(j.message)) text = j.message.filter((s) => s.type === 'text').map((s) => s.data?.text || '').join('')
      push(uid, name, text)
    } catch (_err) { console.error('[自动学习]', _err?.message || _err) }
  }
}

function profile(list) {
  const n = list.length
  const lens = list.map((s) => [...s].length)
  const avg = lens.reduce((a, b) => a + b, 0) / Math.max(1, n)
  const shortRatio = lens.filter((x) => x <= 10).length / Math.max(1, n)
  const isQuestion = (s) => {
    const t = String(s || '').trim()
    if (/[?？][\s。！!]*$/.test(t)) return true
    if (/(吗|呢|吧|啥|没)[\s。！!]*$/.test(t)) return true
    if (/怎么|什么|为什么|哪[里儿个]?|谁|是不是|要不要|能不能|好不好|行不行|何意味/.test(t)) return true
    return false
  }
  const questionRatio = list.filter(isQuestion).length / Math.max(1, n)
  const samples = list.filter((s) => s.length >= 2 && s.length <= 24).slice(-4)
  return { n, avg: avg.toFixed(1), shortRatio, questionRatio, samples }
}

const allMsgs = [...byWho.values()].flat()
let out = '# 学习笔记 ' + day + '\n\n> 自动从活跃群聊抽取真人说话节奏（已排除自己）。学的是短句节奏，不照抄原话。\n'
if (allMsgs.length > 0) {
  const gp = profile(allMsgs)
  out += `- 群友整体节奏：平均句长 ${gp.avg} 字；短句（≤10 字）占 ${(gp.shortRatio * 100).toFixed(0)}%；问句占 ${(gp.questionRatio * 100).toFixed(0)}%\n`
}
for (const [name, list] of [...byWho.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
  const p = profile(list)
  out += `\n## ${name}（${p.n} 条）\n`
  out += `- 平均句长 ${p.avg} 字；短句（≤10 字）占 ${(p.shortRatio * 100).toFixed(0)}%；问句占 ${(p.questionRatio * 100).toFixed(0)}%\n`
  if (p.samples.length) out += `- 近期鲜活短句：${p.samples.map((s) => '「' + s + '」').join('、')}\n`
}
if (dry) console.log(out)
else {
  const outDir = '{{BOT_ROOT}}/记忆'
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, '学习笔记.md'), out, 'utf8')
  console.log('写好了：' + join(outDir, '学习笔记.md'))
}
}
