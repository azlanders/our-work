import { 原子写 } from './_底层.mjs'
// 刷群.mjs —— 闲下来翻一眼群里刚说了啥，记成一张纸（2026-11-06）
// 只读群聊日志，不发言、不贴表情。看不看、贴不贴，留给她下一轮自己定。
import fs from 'node:fs'
import path from 'node:path'

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

const 日志 = '{{BOT_ROOT}}/群聊日志'
const 出 = '{{BOT_ROOT}}/记忆/刷到的.json'
const 群 = (process.argv[2] || '1051483012').split(',')

// ACT_2026-11-06（主人点头）：翻手机要跟着日子走，不在忙的时候硬翻。
let 态 = ""
try { 态 = String(JSON.parse(fs.readFileSync("{{BOT_ROOT}}/记忆/自主.json", "utf8"))?.state || "") } catch (_err) { console.error('[刷群]', _err?.message || _err) }
const 忙 = ["走动", "打工", "洗澡"].includes(态)
if (忙) console.log("这会儿在" + 态 + "，就瞄两眼")

const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const 条目 = []
for (const g of 群) {
  const p = path.join(日志, `${g}-${今天}.jsonl`)
  if (!fs.existsSync(p)) continue
  const 行 = fs.readFileSync(p, 'utf8').trim().split('\n').slice(-40)
  for (const l of 行) {
    try {
      const o = JSON.parse(l)
      if (String(o.user_id) === '3556352474') continue
      const 净 = String(o.text || '').replace(/\[(图片|表情|json|xml|file|image|face|record|video|reply|at|mface|bface|forward)[^\]]*\]/gi, '').replace(/\[\[at:\d+\]\]/g, '').trim()
      if (!净) continue
      条目.push({ 群: g, 时: o.time, 谁: o.nickname, 号: o.message_id, 话: 净.slice(0, 80) })
    } catch (_err) { console.error('[刷群]', _err?.message || _err) }
  }
}
const 尾巴 = 条目.slice(忙 ? -3 : -12)
原子写(出, JSON.stringify({ 看于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), 条目: 尾巴 }, null, 1))
console.log('记下 ' + 尾巴.length + ' 条')
}
