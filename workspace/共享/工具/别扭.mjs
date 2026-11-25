#!/usr/bin/env node
// 别扭.mjs —— 记「正在闹别扭」（2026-11-01；按心理学定义补了「需求」和「破冰」）
//
// 用法：
//   node 别扭.mjs --who {{OWNER_UIN}} --why "说好不熬夜又通宵" --need 想被在意 --level 2
//   node 别扭.mjs --comfort --who {{OWNER_UIN}}        # 对方来哄/道歉/转移话题 → 提前消气
//   node 别扭.mjs --list                            # 现在谁在别扭、还剩多久、想要什么
//   node 别扭.mjs --clear --who {{OWNER_UIN}}
//
// 为什么这么写：
//   · 闹别扭不是单纯的「心情差」，它是**需求没被满足的小抗议**：嘴上说 A，
//     心里想要 B。只记理由不记需求，就等于只记了症状。
//   · 它还是个**试探**：对方来哄就是「他还在乎」的证据，气会提前消；没人来
//     就慢慢升级一点，但到点也会自己消——不拿冷战当武器。
//   · 所以有两个动作：--level 记强度，--comfort 表示「对方破冰了」。
import fs, { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { 写档 } from './_底层.mjs'
import { 加锁 } from './_锁.mjs' // FS_DEFAULT 2026-11-03：默认导入补上，否则 fs2=fs 那两处会抛错被吞
// 2026-11-07（批次175）：这里原来读整份 参数.json 拿 `别扭.基准时长分钟`（30/120/360），
// 再算成 BASE_DURATION、赋给 DURATION —— 而 DURATION **一次都没被用过**。
// 真正决定时长的是下面 durationFor() 的曲线（它的两个拐点来自 HUM 的
// 别扭_低段上限 / 别扭_中段上限）。参数表里那两组数（别扭.基准时长分钟、
// 拟人.别扭_基准分钟）都改不动任何东西，已删；这段死代码一并删掉。

import { basename, dirname, join } from 'node:path'

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

// 2026-11-01：拟人相关的数字走参数表，别写死在脚本里
let HUM = {}
try { const _fs=fs; const _p = '{{BOT_ROOT}}/共享/工具/参数.json'; if(_fs.existsSync(_p)) HUM = JSON.parse(_fs.readFileSync(_p,'utf8'))['拟人']||{} } catch (e) { console.error('[吞错]', e && e.message) } // CATCH_LOG_FIX
const H = (k, d) => (HUM && HUM[k] !== undefined ? HUM[k] : d)

// SULK_MEM 2026-11-14（批次406）：单测要能指到沙盒目录，不然每测一次就改写她真实的别扭账
// （这个文件以前没有沙盒变量，所以它的判据一直没被单测覆盖过）。
const path = process.env.SULK_MEM
  ? String(process.env.SULK_MEM).replace(/\/+$/, '') + '/别扭.json'
  : ('{{BOT_ROOT}}/记忆/别扭.json')

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

// 2026-11-01 动态时长：分高气短，分低气长（曲线在 durationFor 里，不读参数表的档位）。
function durationFor(level, who) {
  // 2026-11-01 百分制：强度 0-100 → 时长按曲线给
  //   30 分 ≈ 30 分钟；60 分 ≈ 2 小时；100 分 ≈ 6 小时
  const pct = Math.max(1, Math.min(100, Number(level) || 30))
  let base = (pct <= H('别扭_低段上限', 30) ? pct : pct <= H('别扭_中段上限', 60) ? 30 + (pct - 30) * 3 : 120 + (pct - 60) * 6) * 60e3
  try {
    const fs2 = fs
    const affP = '{{BOT_ROOT}}/记忆/好感度.json'
    if (fs2.existsSync(affP)) {
      const db2 = JSON.parse(fs2.readFileSync(affP, 'utf8'))
      const sc = Number(db2?.people?.[who]?.score ?? 40)
      if (sc >= H('别扭_折半好感', 75)) base *= H('别扭_好感高折扣', 0.5)   // 分高：气消得快
      else if (sc <= H('别扭_拉长好感', 35)) base *= H('别扭_好感低倍率', 1.6) // 分低：拖得久
    }
  } catch { /* 读不到就按基准 */ }
  // SENSITIVE_SULK 2026-11-03：天生敏感（I 敏感性 + O 忧虑性高）的人气消得慢；系数 0.8~1.3
  try {
    const fs2 = fs // SCOPE_FIX 2026-11-03：原来这里引用了上一个 try 里的局部变量，永远抛错被吞
    const fp = '{{BOT_ROOT}}/记忆/性格-16PF.json'
    if (fs2.existsSync(fp)) {
      const pj = JSON.parse(fs2.readFileSync(fp, 'utf8'))
      const i = Math.min(10, Math.max(1, Number(pj['I_敏感性'] ?? 5)))
      const o = Math.min(10, Math.max(1, Number(pj['O_忧虑性'] ?? 5)))
      const co = 0.8 + ((i - 1) / 9 + (o - 1) / 9) / 2 * 0.5
      base = base * Math.min(1.3, Math.max(0.8, co))
    }
  } catch { /* 拿不到性格就按基准 */ }
  return base
}
const load = () => (existsSync(path) ? (() => { try { const v = JSON.parse(readFileSync(path, 'utf8')); return v === null || typeof v !== 'object' || Array.isArray(v) ? { people: {} } : v } catch { return { people: {} } } })() : { people: {} }) // 2026-11-04 修：null/数组都要回落，后面要读 v.people
// ATOMIC_SAVE 2026-11-07（批次178）：原来这里是裸 writeFileSync —— 进程写到一半被 kill
// （cron 超时、OOM、手动 restart）就留下半截 JSON，下一次 load() 的 catch 把它当成空档
// （{people:{}}），再一 save 就整档清零。写档 用「唯一临时名 + rename」，
// 落地的永远是完整的一份，没有中间态。锁在调用方（外层 withLock / 进程级锁）。
const save = (db) => { 写档(path, db) }

// LOCK_ALL 2026-11-07（批次178）：同 好感度.mjs —— 6 处 save 散在分支里，
// 开头抢锁、退出放开，一次覆盖。理由和取舍都写在那边的注释里。
const __放锁 = 加锁(basename(path), { strict: true })
process.on('exit', () => { try { __放锁() } catch { /* 已放或没抢到 */ } })
const db = load()
const now = Date.now()
for (const [who, rec] of Object.entries(db.people || {})) if (rec.until && rec.until < now) delete db.people[who]

const who = val('--who', '')

if (args.includes('--list')) {
  const alive = Object.entries(db.people || {})
  if (alive.length === 0) { console.log('现在没人在闹别扭'); process.exit(0) }
  for (const [u, r] of alive) {
    const mins = Math.max(0, Math.round((r.until - now) / 60000))
    console.log(`${u}：强度 ${r.level}，因为「${r.why}」，想要「${r.need || '没说'}」，还剩 ${mins} 分钟`)
  }
  save(db)
  process.exit(0)
}

if (!who) { console.error('要指定 --who <QQ号>'); process.exit(1) }

// 2026-11-01：道歉写在账上——他说了对不起，气该往下走一档
if (args.includes('--sorry')) {
  const u = val('--who', '')
  const rec = (db.people || {})[u]
  if (!rec) { console.log('这个人现在没在闹别扭'); process.exit(0) }
  // PERCENT_DOWN 2026-11-14（批次406）：level 早已是百分制（1~100），这里还留着三档制
  // （1~3）时代的「-1」—— 记 60 分就得道 60 次歉才消，而面板 >=60 才画别扭脸，
  // 等于道了歉脸色一点不变。「降一档」的原意折成 33%：至少降 10 点，或降到原来的 67%。
  const __lv = Number(rec.level) || 0
  rec.level = Math.max(0, Math.min(__lv - 10, Math.round(__lv * 0.67)))
  rec.until = Date.now() + Math.max(5 * 60e3, (Number(rec.until) - Date.now()) / 3)
  if (rec.level === 0) delete db.people[u]
  save(db)
  console.log('他道歉了，气降一档')
  process.exit(0)
}

if (args.includes('--clear')) { delete db.people[who]; save(db); console.log('不别扭了'); process.exit(0) }

// 破冰：对方来哄/道歉/主动转移话题 → 强度降一级，时长砍到四分之一
if (args.includes('--comfort')) {
  const rec = (db.people || {})[who]
  if (!rec) { console.log('这个人现在没在闹别扭'); process.exit(0) }
  // 同 --sorry（批次406）：三档制的「-1」在百分制下等于没降。
  const __lv2 = Number(rec.level) || 0
  rec.level = Math.max(0, Math.min(__lv2 - 10, Math.round(__lv2 * 0.67)))
  rec.until = now + Math.max(5 * 60e3, (rec.until - now) / 4)
  if (rec.level === 0) { delete db.people[who]; save(db); console.log('气消了'); process.exit(0) }
  save(db)
  console.log(`破冰收到：强度降到 ${rec.level}，气快消了`)
  process.exit(0)
}

// FROM_FEEL 2026-11-14（批次406）：qq_feel 记完负向感受就到此为止 —— 别扭.json 里
// 从来没有过任何一条（{"people":{}}），而 deliver / outbound / split / poll / 面板
// 一共 12 处在读它，全都在等一份永远不会出现的档。判断权仍在她手里：只有她自己
// 调 qq_feel 记了下面这几种，才在这里落一笔别扭，系统不替她判定「该不该生气」。
// 强度表放在本文件而不是 tool.js：多气、气多久的语义只有这一处。
const FEEL_LEVEL = { 被骂: 60, 越界: 55, 被冷落: 45, 被打断: 25 }
const feelKind = val('--from-feel', '')
if (feelKind) {
  const lv = FEEL_LEVEL[feelKind]
  if (!lv) { console.log('这种感受不用记别扭：' + feelKind); process.exit(0) }
  const feelWhy = val('--why', '')
  db.people = db.people || {}
  const old = db.people[who]
  // 已经在别扭就不降级 —— 二次受伤不该比第一次轻
  const level = old && Number(old.until) > now ? Math.max(lv, Number(old.level) || 0) : lv
  db.people[who] = {
    level,
    why: feelWhy || (old && old.why) || '',
    need: (old && old.need) || '',
    since: (old && Number(old.since)) || now,
    until: now + durationFor(level, who),
  }
  save(db)
  console.log(`${who} 开始闹别扭：强度 ${level}（来自「${feelKind}」），${Math.round(durationFor(level, who) / 60000)} 分钟后自己消`)
  process.exit(0)
}

// 百分制：强度 0-100（老写法 1~3 再乘 33，兼容旧的调用）
const rawLevel = Number(val('--level', '30')) || 30
const level = Math.max(1, Math.min(100, rawLevel <= 3 ? rawLevel * 33 : rawLevel))
const why = val('--why', '')
const need = val('--need', '')
db.people = db.people || {}
db.people[who] = { level, why, need, since: now, until: now + durationFor(level, who) }
save(db)
console.log(`${who} 开始闹别扭：强度 ${level}，因为「${why || '没说'}」，想要「${need || '没说'}」，${Math.round(durationFor(level, who) / 60000)} 分钟后自己消`)
}
