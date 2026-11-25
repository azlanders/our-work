#!/usr/bin/env node
// 生长.mjs —— 她能给自己长出新东西（2026-11-01）
//
// 用法：
//   node 生长.mjs --path 人味.怕与要.怕 --value "被当成工具使唤" --why "他问我怕不怕，我才发现"
//   node 生长.mjs --path 偏好.讨厌 --value "被催"
//   node 生长.mjs --list                                  # 看她给自己长过什么
//
// 为什么这么写：
//   · 人会因为一句话、一次经历长出新东西：以前没想过怕什么，被问了才发现有。
//     所以这里允许「新建」，不只是改已有的。
//   · 但新长出来的东西要带「起源」：什么时候、因为什么。没有起源的新性子是硬加的设定，
//     有起源的才是长出来的。
//   · 只许在属于她自己的文件里长（偏好/人味/想要）；碰不得的地方一根手指都不动。
import { 改档 } from './_底层.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

// GROW_MEM 沙盒：测试时指到临时目录，不碰她真实的 偏好/人味/想要。
const base = process.env.GROW_MEM || ('{{BOT_ROOT}}/记忆')
// 2026-11-04 修：日志改用独立文件。原来与 生长复盘.mjs 共用 记忆/生长记录.json，
// 但两边结构完全不同（这边是 {items:[...]}，复盘那边是 {week,trend,16pf_delta,habits...}），
// 实测 --list 直接抛 TypeError，写入时则会在 push 处崩、把复盘的数据覆盖掉。
const growLog = join(base, '长出来的.json')
const LEGACY = join(base, '生长记录.json')
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError

const ALLOW = ['偏好.json', '人味.json', '想要.json']
// 2026-11-04 修：读到什么都不信，结构不对就重建，避免 items 不是数组时整个脚本崩。
let log = load(growLog, { items: [] })
if (!log || typeof log !== 'object' || !Array.isArray(log.items)) {
  // 首次升级：老日志若还留在共用文件里（且确实是数组），迁过来再继续
  const legacy = load(LEGACY, null)
  log = { items: legacy && Array.isArray(legacy.items) ? legacy.items : [] }
}

if (args.includes('--list')) {
  if (log.items.length === 0) { console.log('还没给自己长过什么'); process.exit(0) }
  for (const it of log.items.slice(-10)) {
    console.log(`${it.at}  长了「${it.value}」到 ${it.path}${it.why ? '（因为：' + it.why + '）' : ''}`)
  }
  process.exit(0)
}

const path = val('--path', '')
const value = val('--value', '')
const why = val('--why', '')
if (!path || !value) { console.error('要 --path 文件.路径 和 --value 内容'); process.exit(1) }

const segs = path.split('.').filter(Boolean)
const file = segs[0] + '.json'
if (!ALLOW.includes(file)) { console.log('这个不归她长：' + file); process.exit(0) }

const fp = join(base, file)
const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
// LOCK 2026-11-17（批次606）：改成 改档() 锁内重读。这个入口要给 qq_grow 用，
// 以后可能和心跳/复盘同时写；整档读改写会把别人刚写的条目盖掉。
let 失败 = ''
改档(fp, (db) => {
  let cur = db
  for (let i = 1; i < segs.length; i += 1) {
    const k = segs[i]
    const isLast = i === segs.length - 1
    if (isLast) {
      const prev = cur[k]
      if (Array.isArray(prev)) { prev.push(value) }
      else if (prev === undefined) { cur[k] = [value] }        // 以前没有 → 现长一个
      else if (typeof prev === 'string') { cur[k] = prev + '；' + value }
      else if (typeof prev === 'object' && prev !== null) { 失败 = k + ' 是个对象，指到里面的字段去'; return false }
      else { cur[k] = [String(prev), value] }
    } else {
      if (cur[k] === undefined) { cur[k] = {} }                 // 整条路径没有就现搭
      if (typeof cur[k] !== 'object' || cur[k] === null) { 失败 = segs[0] + '.' + segs.slice(1, i + 1).join('.') + ' 不是对象，长不进去'; return false }
      cur = cur[k]
    }
  }
}, {})
if (失败) { console.log(失败); process.exit(0) }
改档(growLog, (l) => {
  l.items = Array.isArray(l.items) ? l.items : []
  l.items.push({ at, path, value, why })
}, { items: [] })
console.log(`长出来了：${path} += 「${value}」${why ? '（因为：' + why + '）' : ''}`)
