#!/usr/bin/env node
/**
 * 算作息.mjs —— 统计他一天里各个小时发消息的次数，写成 他的作息.json。
 *
 * 为什么：她没有「他几点睡、哪个时段通常在」这个概念，凌晨三点和下午三点在她眼里一样。
 * 数据源是 stream.jsonl 里 who=he 的记录。心跳每天跑一次就够（分布不会天天变）。
 */
import fs from 'node:fs'

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

const 流 = '{{DSH_ROOT}}/hippocampus/bot-workspace-1415d680/stream.jsonl'
const 出 = '{{BOT_ROOT}}/记忆/他的作息.json'

if (!fs.existsSync(流)) {
  console.log('没有会话流，跳过')
  process.exit(0)
}

const 小时 = new Array(24).fill(0)
const 天 = new Set()
let 条 = 0
for (const 行 of fs.readFileSync(流, 'utf8').split('\n')) {
  if (!行) continue
  let e
  try { e = JSON.parse(行) } catch { continue }
  if (e.who !== 'he' || e.type !== 'user/message') continue
  const t = String(e.text || '').trim()
  if (!t) continue
  const ts = Number(e.ts) || 0
  if (!ts) continue
  const bj = new Date(ts + 8 * 3600e3)
  小时[bj.getUTCHours()] += 1
  天.add(bj.toISOString().slice(0, 10))
  条 += 1
}

const 均 = 小时.reduce((a, b) => a + b, 0) / 24
const 结果 = {
  算于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
  样本条数: 条,
  样本天数: 天.size,
  每小时: 小时,
  均值: Math.round(均),
  说明: '每小时他发过多少条消息；均值以上的时段说明他通常醒着，远低于均值的多半在睡或忙。',
}
fs.writeFileSync(出, JSON.stringify(结果, null, 1) + '\n', 'utf8')
console.log('样本 %d 条 / %d 天，均值 %.1f → %s' % (条, 天.size, 均, 出))
const 活跃 = 小时.map((v, i) => [i, v]).filter(([, v]) => v > 均 * 1.2).map(([i]) => i + '点')
const 安静 = 小时.map((v, i) => [i, v]).filter(([, v]) => v < 均 * 0.4).map(([i]) => i + '点')
console.log('他通常在：' + (活跃.join('、') || '无'))
console.log('他通常不在：' + (安静.join('、') || '无'))
}
