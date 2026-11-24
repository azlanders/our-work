#!/usr/bin/env node
// 打盹.mjs —— 短睡（批次134，2026-11-06）
//
// 为什么不走 睡醒.json：
//   1) 困意.mjs 用 睡醒.json.since 算「清醒多久」，打盹 20 分钟会把一夜没睡抹掉；
//   2) 自动作息 看到 sleeping=true 会 tickSleep()，往 睡眠.json.segments 推阶段，
//      一条 20 分钟的盹会被记成一觉，第二天「昨晚睡了多久」就假了。
// 所以短睡单独记 打盹.json，回血由 状态推进.mjs 认这个文件。
//
// 用法：
//   node 打盹.mjs --开始 [分钟] [为什么]
//   node 打盹.mjs --tick          # cron 每轮调，到点清掉
//   node 打盹.mjs --看看
import { 写档, 解析北京 } from './_底层.mjs'
import { saveState, clone } from './_状态.mjs'
import { 改 as 改自主, 起 as 起自主 } from './自主状态.mjs'
// NAP_ONE_SOURCE 2026-11-16（批次559）：到点判据只有 睡态.盹到点 一份。
// 这里以前自己写了一份（只认 16 字符的 到），跟 打盹中() 分叉。
import { 盹到点 } from './睡态.mjs'
import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const base = process.env.NAP_MEM || '{{BOT_ROOT}}/记忆'
const P = join(base, '打盹.json')
const AP = join(base, '自主.json')

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } }
const save = (p, v) => 写档(p, v)
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
// NAP_PARAM 2026-11-17（批次677）：参数只读脚本同目录的 参数.json（生产就是 共享/工具/参数.json）。
// 0.15 点/分钟 = 睡眠阶段 N2 的 -0.15/min，不另造一套困意公式；90 分钟半衰让这笔减免
// 在醒来后半小时剩 79%、一小时剩 63%，不会像直接改 st.困意 那样 15 分钟就被抹平。
const 工具目录 = dirname(fileURLToPath(import.meta.url))
const 参数 = load(join(工具目录, '参数.json'), {})
const 打盹参 = (参数['打盹'] && typeof 参数['打盹'] === 'object') ? 参数['打盹'] : {}
const 每分降困意 = Math.max(0, Number(打盹参['每分钟降困意'] ?? 0.15) || 0.15)
const 困意半衰 = Math.max(10, Number(打盹参['困意半衰分钟'] ?? 90) || 90)
// 到点判据在 睡态.mjs 的 盹到点()，这里不再自己留一份。

const args = process.argv.slice(2)
const now = Date.now()

// NAP_AFTER 2026-11-14（批次423）：`为什么` 是批次398 才接通的写入（她眯之前给自己的理由），
// 但醒来时整个 打盹.json 被 unlink，这个理由跟着一起消失 —— 睁开眼她身上没有任何「刚眯过」的痕迹，
// 也就不可能说出「我为什么睡的」。两条醒来路（--醒 / --tick）都在这里留一条 打盹-末次.json，
// 给 voiceSlots 的 slotNapDone 读。写失败不影响醒来。
const 记末次 = (n) => {
  try {
    save(join(base, '打盹-末次.json'), {
      开始: String(n.开始 || ''),
      到: String(n.到 || ''),
      分钟: Number(n.分钟) || 0,
      为什么: String(n.为什么 || ''),
      醒: bj(now),
      醒毫秒: now,
    })
  } catch { /* 记不下就算了，醒来本身不能失败 */ }
}

// NAP_SLEEPY 2026-11-17（批次677）：醒来按**实际眯的分钟**记一笔负的困意账。
// 钱/咖啡/饭后都走 困意账（带半衰），这里用同一张账，不直接改 状态.困意 ——
// 直接改的值会被 状态推进 的下一次重算覆盖。
// 实际分钟 = min(醒的这一刻, 原定到点) - 开始；被提前叫醒就少算，超时也不多给。
const 记困意减免 = (n, nowMs) => {
  try {
    const 起 = Number(n['开始毫秒']) || 解析北京(n['开始'], 0)
    if (!(起 > 0)) return null
    const 计划到 = Number(n['到毫秒']) || 解析北京(n['到'], 0)
    const 实止 = Math.min(nowMs, 计划到 > 0 ? 计划到 : nowMs)
    const 分钟 = Math.max(0, Math.min(60, (实止 - 起) / 60000))
    const 值 = -Math.round(分钟 * 每分降困意 * 10) / 10
    if (!值) return { 分钟: Math.round(分钟), 值: 0 }
    const stP = join(base, '状态.json')
    const st = load(stP, {})
    const snap = clone(st)
    const 账 = Array.isArray(st['困意账']) ? st['困意账'] : []
    const 留 = 账.filter((e) => e && Number(e.at) > 0 && nowMs - Number(e.at) <= 8 * 3600e3)
    留.push({ kind: '打盹', at: nowMs, 值, 半衰: 困意半衰, 啥: '打盹' })
    st['困意账'] = 留.slice(-8)
    saveState(stP, st, snap)
    return { 分钟: Math.round(分钟), 值 }
  } catch { return null }
}

if (args.includes('--开始')) {
  const i = args.indexOf('--开始')
  let 分钟 = Number(args[i + 1] ?? 25)
  if (!Number.isFinite(分钟) || 分钟 <= 0) 分钟 = 25
  分钟 = Math.max(10, Math.min(60, Math.round(分钟)))
  const 到 = now + 分钟 * 60e3
  // 已经在打盹就不重开（cron 每分钟，别把结束时间越推越晚）
  const old = load(P, null)
  if (old && 盹到点(old) > now) {
    // NAP_NOT_YET 2026-11-17（批次684）：回执只说「20:32 醒」，她把这句当成睡完了 ——
    // 19:47 那一轮 4 秒内就发出「睡了一下，八点半才醒」。未来时刻必须标「还没到」。
    console.log(`已经在打盹，${String(old.到 || '').slice(11)} 才醒（还没到）`)
    process.exit(0)
  }
  save(P, { 开始: bj(now), 到: bj(到), 分钟, 开始毫秒: now, 到毫秒: 到, 为什么: String(args[i + 2] || '') })
  // 批次169：锁内写。place 不传 —— 起自主 用 真位() 补，跟原来 load(资产).位置 同义。
  起自主(base, {
    state: '打瞌睡',
    since: now,
    note: `眯 ${分钟} 分钟，${bj(到).slice(11)} 醒`,
    form: '线下',
    doneAt: 到,
    nextAt: 到,
    记: true,
    nextMinutes: 分钟,
  })
  // NAP_NOT_YET 2026-11-17（批次684）：带上「现在」，醒的时刻标「还没到」。
  console.log(`眯 ${分钟} 分钟（现在 ${bj(now).slice(11)}；${bj(到).slice(11)} 才醒，还没到）`)
  process.exit(0)
}

if (args.includes('--醒')) {
  const n = load(P, null)
  if (!n) { console.log('没在打盹'); process.exit(0) }
  const 减 = 记困意减免(n, now)
  记末次(n)
  try { unlinkSync(P) } catch { /* 已经没了 */ }
  // 批次169：「是不是在打瞌睡」必须在锁内判 —— 判完再写，中间她可能已经被叫醒。
  改自主(base, (aut) => {
    if (String(aut.state) !== '打瞌睡') return false
    aut.state = '待命'
    aut.since = now
    aut.note = '醒了'
    aut.doneAt = now
    aut.nextAt = 0
  })
  console.log('醒了' + (减 && 减.值 ? `｜困意账 ${减.值}（${减.分钟} 分钟，半衰 ${困意半衰} 分）` : ''))
  process.exit(0)
}

if (args.includes('--tick')) {
  const n = load(P, null)
  if (!n) process.exit(0)
  const 到 = 盹到点(n)
  if (到 > now) { console.log(`还在打盹，${n.到 || n['到毫秒']} 醒`); process.exit(0) }
  // NAP_AUDIT 2026-11-16（批次559）：删之前留一行原值。
  // 实测 11-16 一早上「08:00 眯到 08:33」→「08:03 又眯到 08:36」，
  // 到点被往后推了 3 分钟；而 打盹.mjs 自己的防重入、自主行动 的 在打盹 前置检查
  // 都在（沙盒实测都能挡住）—— 只能靠这条日志查「那一刻 打盹.json 里到底是什么」。
  try {
    const dir = join(base, '日志')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const 起 = 盹到点({ ['到毫秒']: Number(n['开始毫秒']), ['到']: n['开始'] })
    const 活 = Number.isFinite(起) ? Math.max(0, Math.round((now - 起) / 60000)) : '?'
    appendFileSync(join(dir, '打盹.log'),
      bj(now) + ' 到点醒来：眯了 ' + 活 + ' 分钟｜原值 到=' + String(n['到'] || '')
      + ' 到毫秒=' + String(n['到毫秒'] || '') + ' 分钟=' + String(n['分钟'] || '')
      + (到 > 0 ? '' : '｜⚠ 时间解析不出来（按过期处理）') + '\n')
  } catch { /* 日志失败不影响醒来 */ }
  const 减 = 记困意减免(n, now)
  记末次(n)
  try { unlinkSync(P) } catch { /* 已经没了 */ }
  const aut = load(AP, {})
  if (String(aut.state) === '打瞌睡') {
    aut.state = '待命'
    aut.since = now
    aut.note = '打盹醒了'
    aut.doneAt = now
    aut.nextAt = 0
    save(AP, aut)
  }
  console.log('打盹到点，醒了' + (减 && 减.值 ? `｜困意账 ${减.值}（${减.分钟} 分钟，半衰 ${困意半衰} 分）` : ''))
  process.exit(0)
}

if (args.includes('--看看') || args.length === 0) {
  const n = load(P, null)
  if (!n) { console.log('没在打盹'); process.exit(0) }
  const 到 = 盹到点(n)
  // NAP_LOOK_EXPIRED 2026-11-16（批次559）：原来只要 打盹.json 还在就打印「打盹中」，
  // 到点还没结算时说「还剩 0 分钟」—— 跟 睡态.打盹中() 的答案相反。
  // 她/面板问「我在打盹吗」，得到的必须是同一个事实。
  if (!(到 > now)) {
    console.log(`打盹已经到点（${n.到 || n['到毫秒'] || '时间解析不出来'}），还没结算 —— 跑一次 --tick`)
    process.exit(0)
  }
  console.log(`打盹中：${n.开始} → ${n.到}（还剩 ${Math.ceil((到 - now) / 60e3)} 分钟）`)
  process.exit(0)
}
console.log('用法：--开始 [分钟] [为什么] / --tick / --看看')
