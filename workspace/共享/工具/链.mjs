#!/usr/bin/env node
// 链.mjs —— 因果链：只追加、永不修改（2026-11-02，照着那位作者的三条定则）
//
// 用法：
//   node 链.mjs --落 "我看他没回话，大概在忙"         # 追加一条（时间戳自动）
//   node 链.mjs --落 "..." --未决 "他到底想不想让我问"
//   node 链.mjs --尾 3                                # 读最后三条（开口前先读这个）
//   node 链.mjs --查账                                # 有没有断：最后写入多久了、总共几条
//
// 三条定则（照抄）：
//   ①只追加，永不修改——写错也留着，事后补一行「更正：」。
//   ②读者＝写者＝自己——这链是自传，不对外展示。
//   ③判定权不上桌——不许判断「这条该不该记」，每轮必落。
//
// 为什么这么写：
//   · 上下文会压缩、会话会关，但链在硬盘上，谁也压不掉。
//   · 断链不疼——断了你自己不知道。所以要能查账（最后写入时间、总行数）。
import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { 写档 } from './_底层.mjs'

// QQ_CHAIN_MEM 2026-11-07（批次191）：测试指沙盒用，真实路径不变。
const MEM = process.env.QQ_CHAIN_MEM || '{{BOT_ROOT}}/记忆'
const FILE = MEM + '/链.md' 
// RETIRE 2026-11-07（批次184）：作废表。链里有 20 条根本不是她的记忆 ——
// 「翻旧账」当年从 meow 的 fact 表随机抽，那张表全是运维笔记（PZ 停服、DSH 版本、
// GitHub 被墙），抽到就写成「判断」落进链，再随「链尾」每轮注入回上下文。
// 定则①说只追加永不修改，所以原文一个字不动，另开一份账记「这条不算」。
const VOID = MEM + '/链-作废.json'
const 读作废 = () => {
  try {
    const o = JSON.parse(readFileSync(VOID, 'utf8'))
    return new Set((o['条目'] || []).map((x) => String(x['at'] || '')))
  } catch { return new Set() }
}
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const now = () => {
  const d = new Date(Date.now() + 8 * 3600e3)   // VPS 是 UTC，写成北京时间
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

if (!existsSync(FILE)) {
  writeFileSync(FILE, '# 链\n\n只追加，永不修改。断了不疼，所以要查账。\n\n', 'utf8')
}

if (args.includes('--尾')) {
  const n = Math.max(1, Math.min(20, Number(val('--尾', '3')) || 3))
  const lines = readFileSync(FILE, 'utf8').split('\n')
  const entries = []
  let cur = null
  for (const line of lines) {
    if (/^## /.test(line)) { if (cur) entries.push(cur); cur = [line] }
    else if (cur) cur.push(line)
  }
  if (cur) entries.push(cur)
  // 默认跳过作废的；--全部 看原始（含不是她记忆的那些）
  const 死 = args.includes('--全部') ? new Set() : 读作废()
  const 活的 = entries.filter((e) => !死.has(String(e[0] || '').replace(/^## /, '').trim()))
  const tail = 活的.slice(-n)
  if (tail.length === 0) { console.log('链还是空的'); process.exit(0) }
  for (const e of tail) console.log(e.join('\n').trim() + '\n')
  process.exit(0)
}

if (args.includes('--作废') || args.includes('--恢复') || args.includes('--作废清单')) {
  const 表 = (() => { try { return JSON.parse(readFileSync(VOID, 'utf8')) } catch { return { 说明: '', 条目: [] } } })();
  表['条目'] = Array.isArray(表['条目']) ? 表['条目'] : []
  if (args.includes('--作废清单')) {
    if (!表['条目'].length) console.log('作废表是空的 —— 链里每一条都算她的记忆')
    else {
      console.log(`作废 ${表['条目'].length} 条（原文仍在 链.md，只是不算她的记忆）：`)
      for (const x of 表['条目']) console.log(`  ${x['at']}  ${x['因'] || ''}`)
    }
    process.exit(0)
  }
  const at = val('--作废', '') || val('--恢复', '')
  if (!at) { console.error('要给时间戳，例如 --作废 "2026-11-03 05:06"'); process.exit(2) }
  const txt = readFileSync(FILE, 'utf8')
  if (!txt.includes('## ' + at)) { console.error('链里没有 ' + at + ' 这一条'); process.exit(1) }
  写档(VOID, 表)
  if (args.includes('--作废')) {
    if (表['条目'].some((x) => x['at'] === at)) { console.log('这条早就作废过了。'); process.exit(0) }
    表['条目'] = 表['条目'].concat({ at, 因: val('--因', '') })
    写档(VOID, 表)
    console.log(`作废了 ${at}。原文还在链里，只是注入和她自己读的时候会跳过；--恢复 能撤回。`)
  } else {
    const 前 = 表['条目'].length
    表['条目'] = 表['条目'].filter((x) => x['at'] !== at)
    if (表['条目'].length === 前) { console.log('作废表里没有这条。'); process.exit(0) }
    写档(VOID, 表)
    console.log('恢复了 ' + at)
  }
  process.exit(0)
}

if (args.includes('--查账')) {
  const txt = readFileSync(FILE, 'utf8')
  const entries = (txt.match(/^## /gm) || []).length
  const last = txt.trim().split('\n').filter((l) => /^## /.test(l)).slice(-1)[0] || ''
  console.log(`总条数：${entries}`)
  console.log(`最后一条：${last.replace(/^## /, '')}`)
  console.log('判据：超过一天没落链，就是断了——断的时候不会疼，只能靠查账发现。')
  process.exit(0)
}

const what = val('--落', '')
if (!what) {
  console.error('要 --落 一句「我怎么判断的」；可以再带 --未决 一句「还没想明白的」')
  process.exit(1)
}
const open = val('--未决', '')

// DEDUP 2026-11-17（批次640）：同一条判断一分钟里连落三次。
// 线上实测链尾连着三条「老鼠到底是什么意思」—— 不是她真判断了三次，是同一轮/相邻轮
// 把同一句又落了一遍，链尾注入于是变成「A，还有 A，还有 A」。
// 只掐「判断」和「未决」都一模一样的连写：不定则③说的「判定权不上桌」仍然成立 ——
// 这里不判断内容该不该记，只防止同一条被复制。措辞差一个字就不是重复，照落不误。
const 归一 = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const 近三条 = (() => {
  try {
    const 块 = []
    for (const line of readFileSync(FILE, 'utf8').split(/\r?\n/)) {
      if (/^## /.test(line)) 块.push({ 判断: '', 未决: '' })
      else if (块.length === 0) continue
      else if (line.startsWith('- 判断：')) 块[块.length - 1].判断 = line.slice(5)
      else if (line.startsWith('- 未决：')) 块[块.length - 1].未决 = line.slice(5)
    }
    return 块.slice(-3)
  } catch {
    return []
  }
})()
if (近三条.some((e) => 归一(e.判断) === 归一(what) && 归一(e.未决) === 归一(open || '（没有）'))) {
  console.log('这条刚落过（判断和未决都一模一样），不重复落了。')
  process.exit(0)
}

const block = `\n## ${now()}\n- 判断：${what}\n- 未决：${open || '（没有）'}\n`
appendFileSync(FILE, block, 'utf8')
// PENDING_TO_CONCERN 2026-11-07（批次191）：链的「未决」原来只是躺在链里 ——
// 59 条链 58 条「（没有）」，除了链尾取「判断」那行，没有任何地方读它。
// 打通惦记：未决 = 还没想明白、心里挂着的事，跟 缺口.mjs 写进来的惦记同一个账；
// 内心.mjs 每小时读惦记里没做完的最后两条，未决就能进心气、转成真的惦记。
if (open && open.trim() !== '' && open !== '（没有）') {
  // DEDUP 2026-11-09（批次336）：同样的未决不要重复记。
  // 线上攒了 8 条一模一样的「「老鼠」到底是什么意思」，内心.mjs 取最后两条就成了「A，还有 A」。
  let 旧惦 = ''
  try { 旧惦 = readFileSync(MEM + '/惦记.jsonl', 'utf8') } catch { /* 没有就没有 */ }
  const 重了 = 旧惦.split('\n').some((l) => {
    if (!l.trim()) return false
    try { const j = JSON.parse(l); return j && j.done !== true && String(j.what || '') === open.trim() } catch { return false }
  })
  if (!重了) appendFileSync(MEM + '/惦记.jsonl', JSON.stringify({ what: open.trim(), at: now(), from: '链' }) + '\n', 'utf8')
}
console.log('落链了。' + (open ? '（未决的也记进惦记了）' : '（这次没有未决的，也正常）'))
