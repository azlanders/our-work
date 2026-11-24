#!/usr/bin/env node
// 写入画像.mjs —— 批次461（2026-11-14）
//
// 为什么有它：雷霆体检里「读了没人写」这项静态扫不准（写路径跨行、经 写档/save 包装、中文变量），
// 四版全是误报，最后下线了。要回答「谁写谁读」只有一个可靠办法：**跑一遍，看谁真写了**。
//
// 做法：把心跳表里每个任务按它自己的参数跑一次，全程挂 沙盒守卫（所有写都改道到沙盒并记账），
// 于是拿到 `脚本 → 写了哪些文件` 的真实映射，而且一个字节都不会写进真档。
//
// 用法：node 写入画像.mjs [--含模型]
//   默认跳过会调模型的脚本（写日记/自主学习/拍照想法），它们一跑就花钱。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const DIR = '{{BOT_ROOT}}'
const TOOLS = path.join(DIR, '共享/工具')
const MEM = path.join(DIR, '记忆')
const GUARD = path.join(TOOLS, '测试/沙盒守卫.mjs')
const 含模型 = process.argv.includes('--含模型')

const 表 = (() => {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(TOOLS, '心跳表.json'), 'utf8'))
    return Array.isArray(t) ? t : (t.任务 || [])
  } catch { return [] }
})()

const 跳过 = new Set(['写日记.mjs', '自主学习.mjs', '拍照想法.mjs', '自拍.mjs'])
const 写者 = new Map()   // 文件名 → Set(脚本)
const 脚本写 = new Map() // 脚本 → Set(文件名)
const 结果 = []

const 记写 = (脚本, 文件) => {
  if (!写者.has(文件)) 写者.set(文件, new Set())
  写者.get(文件).add(脚本)
  if (!脚本写.has(脚本)) 脚本写.set(脚本, new Set())
  脚本写.get(脚本).add(文件)
}

if (!fs.existsSync(GUARD)) {
  console.log('找不到沙盒守卫：' + GUARD)
  process.exit(1)
}

console.log(`开始：${表.length} 条心跳任务${含模型 ? '（含模型）' : '（跳过调模型的）'}\n`)

for (const t of 表) {
  const 脚本 = String(t.脚本 || '')
  if (!脚本) continue
  if (!含模型 && 跳过.has(脚本)) { 结果.push({ 名: t.名, 脚本, 状态: '跳过（会调模型）', 写: [] }); continue }
  const 脚本路径 = path.join(TOOLS, 脚本)
  if (!fs.existsSync(脚本路径)) { 结果.push({ 名: t.名, 脚本, 状态: '脚本不存在', 写: [] }); continue }

  const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'wmap-'))
  const 日志 = path.join(沙, 'w.log')
  const env = {
    ...process.env,
    NODE_OPTIONS: '--import ' + pathToFileURL(GUARD).href,
    SMOKE_GUARD_ROOT: DIR,
    SMOKE_GUARD_SANDBOX: 沙,
    SMOKE_GUARD_LOG: 日志,
    SMOKE_GUARD_TAG: 脚本,
    SMOKE_NO_MODEL: '1',
    QUIET_NOTE: '1',
  }
  const t0 = Date.now()
  const r = spawnSync(process.execPath, [脚本路径, ...(t.参数 || [])], {
    cwd: TOOLS, env, encoding: 'utf8', timeout: 30000, maxBuffer: 8 << 20,
  })
  const 耗时 = Date.now() - t0
  let 行们 = []
  try { 行们 = fs.readFileSync(日志, 'utf8').trim().split('\n').filter(Boolean) } catch {}
  const 写了 = new Set()
  for (const 行 of 行们) {
    const 部 = 行.split('\t')
    const 目标 = 部[部.length - 2] || ''
    const 名 = path.basename(目标)
    if (!名 || !/\.(json|jsonl|md|txt)$/.test(名)) continue
    写了.add(名)
    记写(脚本, 名)
  }
  const 状态 = r.error && r.error.code === 'ETIMEDOUT' ? '超时'
    : r.status === 0 ? 'ok' : '退出 ' + r.status
  结果.push({ 名: t.名, 脚本, 状态, 耗时, 带参数: JSON.stringify(t.参数 || []), 写: [...写了].sort() })
  fs.rmSync(沙, { recursive: true, force: true })
  console.log(`  ${String(脚本).padEnd(18)} ${状态.padEnd(8)} ${String(耗时).padStart(5)}ms  写 ${写了.size}`)
}

// ── 真档里从来没被任何脚本写过的 ──
const 真档 = []
const 走 = (d, 深) => {
  let 名 = []
  try { 名 = fs.readdirSync(d) } catch { return }
  for (const f of 名) {
    const p = path.join(d, f)
    let st
    try { st = fs.statSync(p) } catch { continue }
    if (st.isDirectory()) { if (深 < 1 && !['日志', '归档', '.locks', '视频画面', '听过的歌', '收藏表情', '聊天记录', '收到的图片', '梦'].includes(f)) 走(p, 深 + 1); continue }
    if (!/\.(json|jsonl|md|txt)$/.test(f)) continue
    if (Date.now() - st.mtimeMs > 30 * 86400e3) continue
    真档.push({ 名: f, 相对: path.relative(MEM, p), 大小: st.size, 改: st.mtimeMs })
  }
}
走(MEM, 0)
const 没人写 = 真档.filter((x) => !写者.has(x.名)).sort((a, b) => b.大小 - a.大小)

// ── 出报告 ──
const 现 = Date.now()
const 时 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')
const 出 = []
出.push('# 写入画像 · ' + 时(现))
出.push('')
出.push(`跑 ${结果.filter((x) => x.状态 === 'ok').length}/${表.length} 条任务（全程挂沙盒守卫，没写真档）`)
出.push('')
出.push('## 一、谁写了什么（按脚本）')
出.push('')
for (const [脚本, 文件] of [...脚本写].sort((a, b) => b[1].size - a[1].size)) {
  出.push(`- **${脚本}** → ${[...文件].sort().join('、')}`)
}
出.push('')
出.push('## 二、记忆目录里「跑了全部心跳任务都没人写」的文件：' + 没人写.length + ' 个')
出.push('')
出.push('（只统计 30 天内动过的；日志/归档/视频/听过的歌 不计）')
出.push('')
for (const x of 没人写.slice(0, 40)) 出.push(`- ${x.相对}  ${(x.大小 / 1024).toFixed(0)}KB  最后写 ${时(x.改)}`)
出.push('')
出.push('## 三、任务执行情况')
出.push('')
for (const x of 结果) 出.push(`- ${x.名}（${x.脚本}）${x.状态}${x.耗时 ? ' ' + x.耗时 + 'ms' : ''}  写 ${x.写.length} 个`)

const 文本 = 出.join('\n')
const 目录 = path.join(DIR, '共享/工作日志')
const 名 = '写入画像-' + new Date(现 + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12) + '.md'
try { fs.writeFileSync(path.join(目录, 名), 文本) } catch (e) { console.log('写报告失败：' + e.message) }
console.log('\n' + 文本)
console.log('\n---- 报告：共享/工作日志/' + 名)
