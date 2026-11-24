#!/usr/bin/env node
// 关系.mjs —— 按人存的「关系强度 bond + 社交安全感 safety」（2026-11-04）
//
// 用法：
//   node 关系.mjs --who <QQ> --事件 <陪伴|被夸|被冷落|争吵|越界|修复|告别> [--why 备注]
//   node 关系.mjs --who <QQ> --show      # 人话 + 数值
//   node 关系.mjs --list                 # 所有人生话
//   HJ_BASE=/tmp/x node 关系.mjs ...     # 沙盒测试
//
// 为什么这么写：
//   · 不做「相识→朋友→亲密→恋人」阶梯：那会诱导升级解锁，也分不清死党、兄妹、伴侣。
//   · 两个连续量：bond 涨得慢（每天最多 +0.01，且要真有互动天数），safety 快升慢降，
//     真越界立刻掉。称谓只是人物卡上的说法，不解锁任何东西。
//   · 关系按人各存一份，绝不共用；激素状态仍是「她自己的」，由 激素.mjs --who 读取做小幅调制。

import fs from 'node:fs'
import path from 'node:path'
import { 写档 } from './_底层.mjs'

const BASE = process.env.HJ_BASE || '{{BOT_ROOT}}/记忆'
const FILE = path.join(BASE, '关系.json')
const now = Date.now()
const bjDate = () => new Date(now + 8 * 3600e3).toISOString().slice(0, 10)
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const round2 = (n) => Math.round(n * 100) / 100

// 事件表：bond/safety 的增量（bond 会被每日上限削平）
const RULES = {
  陪伴: { bond: 0.01, safety: 0.02 },
  被夸: { bond: 0.01, safety: 0.05 },
  被冷落: { bond: -0.003, safety: -0.08 },
  争吵: { bond: -0.005, safety: -0.12 },
  越界: { bond: -0.02, safety: -0.25 },
  修复: { bond: 0.003, safety: 0.06 },
  告别: { bond: -0.005, safety: -0.02 },
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch (e) {
    // REL_LOAD_GUARD 2026-11-04：只有「文件不存在」才当空库；解析失败/权限错误必须直接报错，
    // 否则一次坏读就会拿空对象保存，把所有人的关系数据清空。
    if (e && e.code === 'ENOENT') return { people: {} }
    console.error('关系.json 读取失败（不写回，避免覆盖）：' + e.message)
    process.exit(1)
  }
}

function save(j) {
  // ATOMIC_SAVE 2026-11-07（批次178）：锁在外层（withLock，118 行），这里只补原子写。
  // 裸 writeFileSync 被 kill 会留半截 JSON，读档的 catch 当空档 → 下次 save 整档清零。
  写档(FILE, j)
}

// LOCK 2026-11-04：奖惩钩子和手动命令可能同时写，串行化一下（只读分支不加锁）
// LOCK_V2 2026-11-04：锁文件里写唯一 token；释放前校验 token，过期锁用 rename 抢（只可能一个人抢到），
// 避免「两个进程都判定过期、后一个把前一个新锁删掉」的竞态。
const LOCK = FILE + '.lock'
const LOCK_TOKEN = process.pid + '-' + Math.random().toString(36).slice(2, 8)
function withLock(fn) {
  let got = false
  for (let i = 0; i < 80 && !got; i++) {
    try { fs.writeFileSync(LOCK, LOCK_TOKEN, { flag: 'wx' }); got = true } catch {
      try {
        const st = fs.statSync(LOCK)
        if (Date.now() - st.mtimeMs > 30000) {
          const stale = LOCK + '.stale.' + LOCK_TOKEN
          fs.renameSync(LOCK, stale)
          fs.unlinkSync(stale)
        }
      } catch { /* 锁刚好被放掉/被别人抢走：重试即可 */ }
      const t0 = Date.now(); while (Date.now() - t0 < 20) { /* 20ms 自旋 */ }
    }
  }
  if (!got) throw new Error('关系锁超时')
  try { return fn() } finally {
    try { if (fs.readFileSync(LOCK, 'utf8') === LOCK_TOKEN) fs.unlinkSync(LOCK) } catch { /* 锁已不是自己的 */ }
  }
}

function getPerson(j, who) {
  j.people = j.people || {}
  const k = String(who)
  const p = j.people[k] || { bond: 0, safety: 0.5, bondDate: '', events: 0, updatedAt: 0 }
  p.bond = clamp(Number(p.bond || 0), 0, 1)
  p.safety = clamp(Number(p.safety ?? 0.5), 0, 1)
  j.people[k] = p
  return p
}

// —— 人话（面板/提示词用，不暴露数值）
function words(bond, safety) {
  const b = bond >= 0.7 ? '很熟' : bond >= 0.4 ? '挺熟' : bond >= 0.15 ? '有点熟' : '还生分'
  const s = safety >= 0.75 ? '很放心' : safety >= 0.5 ? '还算踏实' : safety >= 0.3 ? '有点防着' : '挺提防'
  return `${b}，${s}`
}

const args = process.argv.slice(2)
const val = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : null }
const who = val('--who')
const j = load()

if (args.includes('--list')) {
  const people = j.people || {}
  const keys = Object.keys(people)
  if (keys.length === 0) console.log('还没有任何人的关系记录')
  for (const k of keys) {
    const p = people[k]
    console.log(`${k}：${words(p.bond, p.safety)}（bond ${round2(p.bond)} / safety ${round2(p.safety)} / 事件 ${p.events || 0}）`)
  }
} else if (!who) {
  console.log('用法：--who <QQ> --事件 <陪伴|被夸|被冷落|争吵|越界|修复|告别> 或 --who <QQ> --show')
} else if (args.includes('--show')) {
  const p = getPerson(j, who)
  console.log(`${who}：${words(p.bond, p.safety)}（bond ${round2(p.bond)} / safety ${round2(p.safety)} / 事件 ${p.events || 0}）`)
} else {
  const kind = val('--事件')
  const r = RULES[kind]
  if (!r) { console.log('未知事件：' + kind); process.exit(0) }
  const msg = withLock(() => {
    // 锁内重新读，避免覆盖锁外那会儿的旧快照
    const jj = load()
    const p = getPerson(jj, who)
    const before = { bond: p.bond, safety: p.safety }
    // BOND_DAILY 2026-11-04：关系强度每天最多 +0.01，且要真有互动；防止一天刷满
    let dBond = r.bond
    if (dBond > 0) {
      if (p.bondDate === bjDate()) dBond = 0
      else dBond = Math.min(dBond, 0.01)
    }
    p.bond = clamp(p.bond + dBond, 0, 1)
    p.safety = clamp(p.safety + r.safety, 0, 1)
    p.bondDate = bjDate()
    p.events = Number(p.events || 0) + 1
    p.updatedAt = now
    save(jj)
    return `${who} ${kind}：${words(p.bond, p.safety)}（bond ${round2(before.bond)}→${round2(p.bond)}，safety ${round2(before.safety)}→${round2(p.safety)}）`
  })
  console.log(msg)
}
