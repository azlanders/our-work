#!/usr/bin/env node
// 钱账.mjs —— 把「钱怎么变的」单独存一份，永久（2026-11-14，批次421）
//
// 为什么：
//   `资产.记录` 同时装两样东西：钱的事件（「外卖：早饭（10 块）」）和不是钱的事件
//   （「走到街市」「换了白裙子」）。而 11 个写方各自 `slice(-200)` —— 200 条只够 10 天，
//   于是「上个月花了多少」永远算不出来（实测 200 条里 97 条是非钱事件）。
//
// 为什么不改那 11 个写方：
//   改了要动 11 处（其中一处是面板）、每处都要测，而且它们各自维护上限，改一个漏一个
//   就是新的「左右脑互博」。而「这条记录是不是钱」本来就能用 `账本.mjs` 的 `一笔()`
//   从文本里认出来 —— 账本已经承担「解析」这个职责了，那就让它继续承担。
//
// 所以做成**每天抽一次**：`资产.记录` 继续当她的近期流水（面板、记忆、做梦都在读它，
// 一个字不动），`钱账.json` 只追加、不设上限，专门回答「这个月/上个月花了多少」。
//
// 用法：
//   node 钱账.mjs --补            把 资产.记录 里还没抽过的钱事件追加进来（幂等）
//   node 钱账.mjs --看            只统计不写
//   node 钱账.mjs --月 2026-10    看某个月（-1 = 上个月，-2 = 上上个月）
//   node 钱账.mjs --月 2026-11 --细  连明细一起列
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { 写档 } from './_底层.mjs'
import { 一笔 } from './账本.mjs'

const MEM = process.env.MONEY_MEM || '{{BOT_ROOT}}/记忆'
const 资产档 = join(MEM, '资产.json')
const 账档 = join(MEM, '钱账.json')

const 读 = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb } }
const 北京 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

/**
 * 从流水里挑出还没记过的钱事件。
 *
 * 判据只看 `一笔()` —— 那是**唯一**的「这段字是不是钱」的实现（工资/退回/赚/挣/
 * 拿走/给了/买/花/被拿）。这里绝不能再写一份自己的正则，否则两边迟早走岔。
 */
export function 抽取(记录们, 已有) {
  const 有 = new Set((已有 || []).map((x) => String(x.at || '') + '|' + String(x.what || '')))
  const 新 = []
  for (const r of (记录们 || [])) {
    const what = String((r && r.what) || '').trim()
    if (what === '') continue
    const k = String((r && r.at) || '') + '|' + what
    if (有.has(k)) continue
    const x = 一笔(what)
    const 花 = Number(x.花) || 0
    const 赚 = Number(x.赚) || 0
    const 被拿 = Number(x.被拿) || 0
    if (花 === 0 && 赚 === 0 && 被拿 === 0) continue // 走路、换衣服、做饭 —— 不是钱
    新.push({ at: String((r && r.at) || ''), what, 花, 赚, 被拿 })
    有.add(k) // 同一批里重复出现的也去掉
  }
  return 新
}

/** 某个月的收支。ym 形如 2026-11。 */
export function 月度(条, ym) {
  const 选 = (条 || []).filter((x) => String(x.at || '').startsWith(ym))
  const 花 = 选.reduce((s, x) => s + (Number(x.花) || 0), 0)
  const 赚 = 选.reduce((s, x) => s + (Number(x.赚) || 0), 0)
  const 被拿 = 选.reduce((s, x) => s + (Number(x.被拿) || 0), 0)
  return { 笔: 选.length, 花, 赚, 被拿, 净: 赚 - 花 - 被拿 }
}

/** 相对月份：-1 = 上个月。跟北京时区走。 */
export function 月份(偏移 = 0, ms = Date.now()) {
  const d = new Date(ms + 8 * 3600e3)
  const m = d.getUTCMonth() + 偏移
  const y = d.getUTCFullYear() + Math.floor(m / 12)
  const mm = ((m % 12) + 12) % 12
  return y + '-' + String(mm + 1).padStart(2, '0')
}

const 是主 = process.argv[1] && process.argv[1].endsWith('钱账.mjs')
if (是主) {
  const args = process.argv.slice(2)
  const 值 = (k, d = '') => { const i = args.indexOf(k); return i >= 0 ? (args[i + 1] ?? d) : d }

  const 资产 = 读(资产档, {})
  const 档 = 读(账档, { 说明: '', 条: [], 抽到: '' })
  const 条 = Array.isArray(档.条) ? 档.条 : []
  const 新 = 抽取(资产.记录 || [], 条)

  if (args.includes('--月')) {
    const 参 = String(值('--月', '-1')).trim()
    const ym = /^-\d+$/.test(参) ? 月份(Number(参)) : 参
    if (!/^\d{4}-\d{2}$/.test(ym)) { console.error('--月 要写成 2026-11 或 -1（上个月）'); process.exit(2) }
    const r = 月度(条, ym)
    console.log(`${ym}：${r.笔} 笔 · 花 ${r.花} · 赚 ${r.赚}${r.被拿 ? ' · 被拿 ' + r.被拿 : ''} · 净 ${r.净 >= 0 ? '+' : ''}${r.净}`)
    if (args.includes('--细')) {
      ;(条 || []).filter((x) => String(x.at || '').startsWith(ym))
        .forEach((x) => console.log('  ' + x.at + '  ' + (x.花 ? '-' + x.花 : x.赚 ? '+' + x.赚 : '被拿 ' + x.被拿) + '  ' + x.what))
    }
    process.exit(0)
  }

  if (args.includes('--看')) {
    console.log(`这次能抽 ${新.length} 条（账里已有 ${条.length} 条，共 ${(资产.记录 || []).length} 条流水）`)
    新.slice(0, 8).forEach((x) => console.log('  ' + x.at + '  ' + (x.花 ? '-' + x.花 : x.赚 ? '+' + x.赚 : '被拿 ' + x.被拿) + '  ' + x.what.slice(0, 40)))
    if (新.length > 8) console.log('  …还有 ' + (新.length - 8) + ' 条')
    process.exit(0)
  }

  if (args.includes('--补') || args.length === 0) {
    if (新.length === 0) { console.log(`没有新的（账里 ${条.length} 条）`); process.exit(0) }
    const 全 = 条.concat(新)
    // 不裁上限：钱账就是用来回答「上个月花了多少」的，裁了就白做。
    // 但排一次序，免得流水乱序时账里也跟着乱。
    全.sort((a, b) => String(a.at).localeCompare(String(b.at)))
    写档(账档, { 说明: '钱的事件，永久。由 钱账.mjs --补 每天从 资产.记录 抽一次；不设上限。', 条: 全, 抽到: 北京() })
    console.log(`补了 ${新.length} 条（账里现在 ${全.length} 条）`)
    process.exit(0)
  }

  console.log('用法：node 钱账.mjs --补 ｜ --看 ｜ --月 2026-11 [--细] ｜ --月 -1')
}
