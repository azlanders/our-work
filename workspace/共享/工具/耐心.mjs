#!/usr/bin/env node
// 耐心.mjs（她那边）—— 短期耐心随打断掉、随时间回；长期耐心只在「看到变化」时回（2026-11-02）
//
// 用法：
//   node 耐心.mjs                 # 按时间恢复（短期回得快、长期几乎不动）
//   node 耐心.mjs --打断          # 被催/被打断一次，短期 -12
//   node 耐心.mjs --扣 5          # 按指定点数扣短期耐心（插件打断用）
//   node 耐心.mjs --看到变化      # 他真改了一点，长期 +15
//   node 耐心.mjs --show
//
// 为什么分开：精力是电池（睡一觉满），耐心是弦（绷久了会松）。
// 短期靠「别再打断我」恢复；长期靠「看到变化」恢复——几乎不随时间涨。
import { readFileSync, writeFileSync } from 'node:fs'
// 2026-11-04 修：状态.json 由多个脚本共写，整份覆盖会丢别人刚写的字段（实测 30 轮撞 1 次）。
// 改成「读时留快照、写时只合并自己改过的键」，细节见 _状态.mjs。
import { saveState, clone } from './_状态.mjs'

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

// ST_BASE 沙盒：跟 状态推进.mjs 用同一个变量，测试才不会写到她真实的状态上
const path = process.env.ST_BASE ? `${process.env.ST_BASE}/状态.json` : '{{BOT_ROOT}}/记忆/状态.json'
const args = process.argv.slice(2)
const val = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? String(args[i + 1] ?? d) : d }
// DRY_GUARD 2026-11-04：本脚本没有 --dry 语义，传了就直接退出，避免「以为在演练、其实真写」
if (args.includes('--dry')) { console.log('（耐心.mjs 不支持 --dry，已跳过；真跑请去掉该参数）'); process.exit(0) }
const now = Date.now()
// 2026-11-06 批次124：时间戳一律存北京时间。以前这里用 new Date(now).toISOString()，那是 UTC，比北京早 8 小时；而 Date.parse 读回来按本地时区解释，于是每次运行都多算 8 小时。
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const load = () => { try { const v = JSON.parse(readFileSync(path, 'utf8')); return v === null || typeof v !== 'object' ? {} : v } catch { return {} } } // 2026-11-04 修：null/标量也回落，别让 st['耐心'] 直接抛
// 2026-11-04：写入改为合并式，快照在读到数据后立刻留，用来算「我到底改了什么」
const save = (o) => saveState(path, o, snap)

const st = load()
const snap = clone(st)
st['耐心'] = st['耐心'] || { 短期: 60, 长期: 70, 上次被打断: 0, 短期更新于: bj(now), 长期更新于: bj(now) }
// JSON 可能被写坏：“耐心”不存在或不是普通对象时，重建默认对象。
if (st['耐心'] === null || typeof st['耐心'] !== 'object' || Array.isArray(st['耐心'])) {
  st['耐心'] = { 短期: 60, 长期: 70 };
}

// 将字段转成有限数字，非法值分别回落到默认值 60 / 70。
// 2026-11-04 修：只判有限不够——实测 -99999 和 1e12 会原样留下（
// 负的长期耐心永远不会被 --打断 夹回来，超大的短期会算出 999999999988）。
// 这里统一夹到 0–100，跟「耐心是 0–100 的刻度」这个前提对齐。
for (const [key, fallback] of [['短期', 60], ['长期', 70]]) {
  const value = Number(st['耐心'][key]);
  st['耐心'][key] = Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}
const pn = st['耐心']

// 2026-11-06 批次124：裸字符串一律按北京时间解析。系统时区是 UTC，直接 Date.parse('2026-11-06 12:20')
// 会被当成 UTC，比北京时间早 8 小时；而本项目的落盘字符串都是北京墙上时间（跟 poll.js 一致）。
const 北京时刻 = (s) => {
  const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? t : 0
}

if (args.includes('--show')) { console.log(`短期 ${pn['短期']}/100  长期 ${pn['长期']}/100`); process.exit(0) }

// P1 2026-11-16：插件打断时扣的是可变点数（5 或 10），不能挪用固定 -12 的 --打断。
const 扣 = Number(val('扣', '0'))
if (Number.isFinite(扣) && 扣 > 0) {
  pn['短期'] = Math.max(0, Number(pn['短期'] || 60) - 扣)
  pn['上次被打断'] = now
  pn['短期更新于'] = bj(now)
  save(st)
  console.log(`扣耐心 ${扣}：短期 → ${pn['短期']}/100`)
  process.exit(0)
}

if (args.includes('--打断')) {
  pn['短期'] = Math.max(0, Number(pn['短期'] || 60) - 12)
  pn['上次被打断'] = now
  pn['短期更新于'] = bj(now)
  save(st); console.log(`被打断一次：短期 → ${pn['短期']}/100`); process.exit(0)
}

if (args.includes('--看到变化')) {
  pn['长期'] = Math.min(100, Number(pn['长期'] || 70) + 15)
  pn['长期更新于'] = bj(now)
  save(st); console.log(`看到变化了：长期 → ${pn['长期']}/100`); process.exit(0)
}

// 默认：按时间恢复，但短期耐心的上限由认知水平决定
const cap = Math.max(30, Math.min(95, Math.round(45 + 0.45 * (Number(st.layers && st.layers.cognitive) || 50)))) // 让认知决定短期耐耐心上限，并限制在 30~95，避免极端值
const last = 北京时刻(pn['短期更新于']) || now // 缺少有效时间戳时从当前时间算起，避免首次运行产生异常恢复量
const mins = Math.max(0, Math.floor((now - last) / 60e3)) // 计算经过的分钟数并防止未来时间戳造成负数
const rec = Math.min(30, Math.round((mins / 10) * 4)) // 保持每 10 分钟恢复 4 点、单次最多恢复 30 点的原规则
const cur = Number(pn['短期'] || 60) // 保留原来的默认值，并先读取当前值以便与动态上限比较
const decay = cur > cap ? Math.max(1, Math.floor((mins / 60) * 20)) : 0 // 超出上限时按每小时 6 点向下回收，且至少回收 1 点
if (cur < cap) { // 当前值低于上限时才恢复，避免继续向固定的 100 增长
  pn['短期'] = Math.min(cap, cur + rec) // 恢复后不超过认知决定的动态上限
} else if (cur > cap) { // 当前值高于上限时说明耐心需要随认知负荷回落
  pn['短期'] = Math.max(cap, cur - decay) // 按时间向下回收，但最低只降到动态上限
} else { // 当前值恰好等于上限时不需要恢复或回收
  pn['短期'] = cur // 保持当前值，同时确保写回的是数字
} // 三种情况都让短期耐心只向动态上限靠拢
const lastL = 北京时刻(pn['长期更新于']) || now // 长期耐心沿用原时间戳回退逻辑
pn['长期'] = Math.min(100, Number(pn['长期'] || 70) + Math.max(0, Math.floor((now - lastL) / 864e5))) // 未来时间戳会得 -1，夹住 // 长期耐心仍按原规则恢复且上限保持 100
pn['短期更新于'] = bj(now) // 更新短期恢复基准时间，避免下次重复计算同一段时间
pn['长期更新于'] = bj(now) // 更新长期恢复基准时间，保持原有行为
// CLAMP_OUT 2026-11-04：数据被写成负数或超大时，写回前统一夹到 0-100，避免越界值传播
pn['短期'] = Math.max(0, Math.min(100, Number(pn['短期']) || 0))
pn['长期'] = Math.max(0, Math.min(100, Number(pn['长期']) || 0))
save(st) // 持久化更新后的耐心数值和时间戳
console.log(`短期 ${pn['短期']}/${cap}（上限跟认知走）  长期 ${pn['长期']}/100`) // 展示短期动态上限，同时保留长期固定上限
if (decay > 0) console.log(`短期超出认知上限，回收 ${cur - pn['短期']} 点`) // 仅在发生回收时额外提示，并显示实际回收点数
}
