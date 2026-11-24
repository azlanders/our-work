#!/usr/bin/env node
// 会话体检.mjs —— 会话文件大了，写进面板「需要你处理」，**绝不发 QQ**（2026-11-14 批次385）
//
// 为什么单独成一条：
//   · 批次273 只在提示词里写了「这类事别发他 QQ」，靠我自己记 —— 记不住就漏。11-13 23:5x
//     我又在私聊里报了「会话文件涨到 23.7MB」，主人当场说「别在聊天栏发这个了，你自己改到
//     webui 的需要处理界面里面」。
//   · 所以改成机器自己盯：跑一次算一次体积，超门槛就维护一条待办；降到门槛以下、或者换完
//     会话，那条待办自己挪进 done。我不用记，他只在面板上看得见。
//
// 判定口径（沿用 会话轮换方案.md）：
//   · 只看 routes 指向的那几条会话 —— 工程会话多大跟她无关
//   · 门槛 8MB（3–4MB 一天就涨回去，天天触发变成噪音）
//
// 用法：
//   node 会话体检.mjs          # 正常跑（心跳每 6 小时一次）
//   node 会话体检.mjs --看     # 只打印，不写待办
//   ROTATE_MB=20 node 会话体检.mjs   # 临时换门槛（测试用）
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { 写档 } from './_底层.mjs'
import * as 待办 from './待办.mjs'

const CFG = process.env.BRIDGE_CFG || '{{DSH_ROOT}}/qq-bridge.config.json'
const 根 = process.env.SESS_ROOT || '{{DSH_ROOT}}/sessions'
const 门MB = Number(process.env.ROTATE_MB || 8)
const DRY = process.argv.includes('--看')
const 日志档 = '{{BOT_ROOT}}/记忆/日志/会话体检.json'
const 方案 = '共享/_归档/工具历史文档-2026-11-11/会话轮换方案.md'

const 读 = (p, fb) => {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return v && typeof v === 'object' ? v : fb
  } catch {
    return fb
  }
}

/** 会话文件可能落在别的工作区目录下，按 id 找一遍（找不到就 null） */
function 找会话(sessionId) {
  if (!sessionId) return null
  let 目录 = []
  try {
    目录 = readdirSync(根, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch {
    return null
  }
  for (const d of 目录) {
    const f = path.join(根, d, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(f)) return f
  }
  return null
}

const 名 = (类型, 号) => (类型 === 'private' ? '私聊 ' : '群 ') + 号 + (号 === '{{OWNER_UIN}}' ? '（主人）' : '')

/**
 * 孤儿会话：同一个工作区里、routes 没指向的那些 session-*。
 *
 * 为什么单独报：他每次在面板上看到的是「私聊会话涨到 28.7MB，该换了」，
 * 可那个工作区里其实躺着 17 条会话、97MB —— 在用的只有 4 条约 32MB，
 * 剩下 63MB 是以前换下来的，谁也不会再读。只报在用的那一条，等于把大头藏起来。
 *
 * 只统计、不删：删会话不可逆，等他点头。
 */
export function 孤儿统计(根, 在用) {
  const 用 = new Set(Array.from(在用 || []).map(String))
  const 明细 = []
  // 根既可能是 sessions/ 也可能是 sessions/--workspace--/，两种都认：
  //   一层：根/session-xxx/session.v4.jsonl.zstd
  //   两层：根/<workspace>/session-xxx/session.v4.jsonl.zstd
  const 扫 = (工作区) => {
    let 子 = []
    try {
      子 = readdirSync(工作区, { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name)
    } catch { return }
    for (const sid of 子) {
      if (!/^session-/.test(sid) || 用.has(sid)) continue
      const f = path.join(工作区, sid, 'session.v4.jsonl.zstd')
      try {
        const MB = Math.round((statSync(f).size / 1048576) * 10) / 10
        明细.push({ sessionId: sid, MB })
      } catch { /* 没有会话文件的不算 */ }
    }
  }
  let 一层 = []
  try {
    一层 = readdirSync(根, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
  } catch { return { 条数: 0, MB: 0, 明细 } }
  if (一层.some((d) => /^session-/.test(d))) 扫(根)
  else for (const d of 一层) 扫(path.join(根, d))
  明细.sort((a, b) => b.MB - a.MB)
  const MB = Math.round(明细.reduce((s, x) => s + x.MB, 0) * 10) / 10
  return { 条数: 明细.length, MB, 明细 }
}

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
const 配 = 读(CFG, {})
const 路由 = []
for (const [类型, 表] of Object.entries(配.routes || {})) {
  if (!表 || typeof 表 !== 'object') continue
  for (const [号, v] of Object.entries(表)) {
    if (v && v.sessionId) 路由.push({ 类型, 号, sessionId: String(v.sessionId), 称呼: 名(类型, 号) })
  }
}

const 结果 = []
for (const r of 路由) {
  const f = 找会话(r.sessionId)
  if (!f) {
    结果.push({ ...r, 文件: '', MB: 0, 超: false, 缺: true })
    continue
  }
  const MB = Math.round((statSync(f).size / 1048576) * 10) / 10
  结果.push({ ...r, 文件: f, MB, 超: MB >= 门MB, 缺: false })
}

const 超的 = 结果.filter((x) => x.超)

// ORPHAN_SESSIONS 2026-11-14（批次451）：只报 routes 那一条 = 把大头藏起来。
// 同工作区里换下来的旧会话没人读、也不删，实测 17 条 97MB 里 63MB 是这种。
const 在用 = new Set(结果.map((r) => r.sessionId))
const 工作区根 = Array.from(new Set(结果
  .map((r) => (r.文件 ? path.dirname(path.dirname(r.文件)) : ''))
  .filter(Boolean)))
const 孤儿 = 工作区根.reduce((a, 根) => {
  const o = 孤儿统计(根, 在用)
  return { 条数: a.条数 + o.条数, MB: Math.round((a.MB + o.MB) * 10) / 10 }
}, { 条数: 0, MB: 0 })
const 余 = 孤儿.条数 > 0
  ? '；同工作区另有 ' + 孤儿.条数 + ' 条旧会话共 ' + 孤儿.MB + 'MB（不在 routes 里，没在用，删不删你定）'
  : ''

if (!DRY) {
  for (const r of 结果) {
    const id = '会话轮换-' + r.sessionId.slice(8, 16)
    const 事项 =
      r.称呼 + '会话涨到 ' + r.MB + 'MB（门槛 ' + 门MB + 'MB）—— 该换会话了：按 ' + 方案 + ' 走，换完把这条标掉'
      + (r.超 ? 余 : '')
    待办.同步({ id, 事项, 来源: '会话体检', 该在: r.超 })
  }
  写档(日志档, {
    时间: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
    门槛MB: 门MB,
    条目: 结果.map((r) => ({ 称呼: r.称呼, sessionId: r.sessionId, MB: r.MB, 超: r.超, 缺: r.缺 })),
    孤儿,
  })
}

if (!结果.length) console.log('routes 里没读到会话，跳过。')
else {
  console.log('会话体检（门槛 ' + 门MB + 'MB' + (DRY ? '，只看不写' : '') + '）：')
  for (const r of 结果) console.log('  ' + r.称呼 + ' ' + r.sessionId.slice(0, 16) + '  ' + (r.缺 ? '没有会话文件' : r.MB + 'MB' + (r.超 ? ' ← 超了' : '')))
  if (孤儿.条数 > 0) console.log('  另有 ' + 孤儿.条数 + ' 条旧会话共 ' + 孤儿.MB + 'MB（不在 routes 里，没在用）')
  if (超的.length) console.log('结论：' + 超的.map((x) => x.称呼).join('、') + ' 该换，' + (DRY ? '（没写待办）' : '已写进面板「需要你处理」，没发 QQ'))
  else console.log('结论：都在门槛内，待办里那条（如果有）会自己挪进已处理')
}
}
