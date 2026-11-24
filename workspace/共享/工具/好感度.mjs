#!/usr/bin/env node
// 好感度.mjs v2 —— 关系状态（2026-11-09，批次299 重做）
//
// ── 为什么推倒重来 ────────────────────────────────────────────────
//
// v1 的病不是「没接线」，是结构错了：
//   · 一个 score = first(永不改) + 五维；五维里只有「熟悉度」有人写，其余四维永远是 0
//     → 主人的分数从 60 冻在那儿，四天没动；
//   · 奖惩.mjs 直接 score += x，日结.mjs 又按 first+dims 重算 —— 两个写方互相覆盖，
//     谁后写谁赢；
//   · 没有衰减：接什么事件都会饱和，然后第二次冻住。
//
// ── v2 的六条约定 ────────────────────────────────────────────────
//
//   1. 存的是**四个状态**，不是分数；score 只是渲染：
//      score = 0.5×亲近 + 0.3×安全 + 0.2×兴致
//   2. 每维有自己的「日常值」和半衰期：没人理就回落，一次事件撑不住一天。
//      亲近 21 天 / 安全 60 天 / 兴致 3 天 / 思念 7 天。
//   3. 只有三种输入：往来（日结）、具体事件（奖惩/道歉/越界）、她自己的自评。
//   4. 单次事件封顶 ±8；同类事件连发按 1/(1+n) 递减。
//   5. **唯一写入口**：这个文件。日结和奖惩都调它，不再各自读写同一份档。
//   6. 92 以上走软上限（只留四成余量）——能越界，但维持不住。
//
// 用法：
//   node 好感度.mjs --who <uin> --event 日结 --n 126 --fam 60 --settle 2026-11-08
//   node 好感度.mjs --who <uin> --event 被记得 --why "他记得我说过的话"
//   node 好感度.mjs --who <uin> --event 自评 --v 1.5 --why "今天聊得挺开心"
//   node 好感度.mjs --tick                # 所有人算衰减 + 思念
//   node 好感度.mjs --migrate             # v1 → v2（一次性，原档留在 legacy）
//   node 好感度.mjs --show [--who <uin>]
//   node 好感度.mjs --json
import { 读档, 改档, 北京 } from './_底层.mjs'

const FILE = process.env.FAV_FILE || (process.platform === 'win32'
  ? 'B:/肥鱼/记忆/好感度.json'
  : '{{BOT_ROOT}}/记忆/好感度.json')

// 日常值：没人理的时候会回到这里。安全比亲近高，是因为「没出事」本身就是安全。
const 日常 = { 亲近: 40, 安全: 55, 兴致: 45, 思念: 0 }
// 半衰期（天）：兴致散得最快，安全最慢。
const 半衰 = { 亲近: 21, 安全: 60, 兴致: 3, 思念: 7 }
const 上限 = { 亲近: 100, 安全: 100, 兴致: 100, 思念: 30 }

// 事件表：只写「这次动了哪几维」。一句话改不了关系；能改的是有对象的事。
const EVENT = {
  日结: { 亲近: 0.9, 兴致: 0.6 },
  闲聊: { 亲近: 0.4, 兴致: 0.4 },
  好话: { 亲近: 1.2, 兴致: 0.8 },
  被记得: { 亲近: 2.0, 兴致: 1.0 },
  被模仿: { 亲近: 1.0, 兴致: 1.2 },
  被夸可爱: { 亲近: 1.5, 兴致: 1.5 },
  被等: { 亲近: 0.6, 兴致: 0.4 },
  收到礼物: { 亲近: 2.0, 兴致: 1.0 },
  兑现: { 亲近: 1.5, 安全: 1.0 },
  帮上忙: { 亲近: 1.2, 安全: 0.6 },
  道歉: { 安全: 3.0, 亲近: 0.5 },
  澄清: { 安全: 2.0 },
  坏话: { 安全: -5.0, 兴致: -3.0, 亲近: -1.0 },
  越界: { 安全: -8.0, 兴致: -4.0, 亲近: -2.0 },
  失信: { 安全: -4.0, 亲近: -1.0 },
  // 想岔了 = 她后来推翻了自己的判断（误以为被骂）。不是「他道歉」，是她自己改判。
  想岔了: { 安全: 1.5, 亲近: 0.8 },
}

const 单次封顶 = 8
const 日志上限 = 8
const 旧事件 = { 分享: '好话', 叫名字: '被等', 被冷落: '失信', 冒犯: '越界' }

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const r1 = (v) => Math.round(v * 10) / 10
const 数 = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

/** 把一维拉回日常值：dt 天里走了多少比例。 */
function 回落(v, 日常值, 天, halfLife) {
  if (!(天 > 0)) return v
  return 日常值 + (v - 日常值) * Math.exp(-天 / halfLife)
}

function 结算(p, now) {
  const dt = Math.max(0, (now - 数(p.lastTick, now)) / 86400e3)
  if (dt > 0) {
    for (const k of ['亲近', '安全', '兴致']) {
      p.dims[k] = r1(回落(数(p.dims[k], 日常[k]), 日常[k], dt, 半衰[k]))
    }
    p.lastTick = now
  }
  // 思念：按「距上次说话」饱和到 30，不是越久越无限。久别会想，但不会想到失控。
  const 别 = Math.max(0, (now - 数(p.last, now)) / 86400e3)
  p.dims['思念'] = r1(clamp(30 * (1 - Math.exp(-别 / 14)), 0, 上限['思念']))
  // 软上限：92 以上只留四成余量
  for (const k of ['亲近', '安全', '兴致']) {
    let v = 数(p.dims[k], 日常[k])
    if (v > 92) v = 92 + (v - 92) * 0.4
    p.dims[k] = r1(clamp(v, 0, 上限[k]))
  }
  // 保留一位小数：日结一天只动 0.6~1 分，取整就永远看不出在动。
  p.score = r1(0.5 * p.dims['亲近'] + 0.3 * p.dims['安全'] + 0.2 * p.dims['兴致'])
  return p
}

/** 同类事件最近一小时的次数——用来做递减，防「十句好话顶到满」。 */
function 同类次数(p, kind, now) {
  return (Array.isArray(p.log) ? p.log : [])
    .filter((x) => x && x.kind === kind && now - 数(x.atMs) < 3600e3).length
}

function 记一条(p, kind, why, dims, now, extra = {}) {
  const 总 = Object.values(dims).reduce((a, b) => a + b, 0)
  p.log = [{
    at: 北京(now), atMs: now, kind, delta: r1(总), why: String(why || ''), dims, ...extra,
  }, ...(Array.isArray(p.log) ? p.log : [])].slice(0, 日志上限)
}

/** 施加一个事件。 */
function 施加(p, kind, opt, now) {
  const def = EVENT[kind] || EVENT['闲聊']
  const mult = 1 / (1 + 同类次数(p, kind, now))
  const n = 数(opt.n)
  // 日结按句数放大，但封顶 1.6 倍：聊 10 句和聊 1000 句不该差 100 倍
  const scale = kind === '日结' ? Math.min(1.6, 0.3 + n / 100) : 1
  const dims = {}
  for (const [k, v] of Object.entries(def)) {
    const d = clamp(v * mult * scale, -单次封顶, 单次封顶)
    if (!d) continue
    p.dims[k] = r1(clamp(数(p.dims[k], 日常[k]) + d, 0, 上限[k]))
    dims[k] = r1(d)
  }
  记一条(p, kind, opt.why, dims, now, n ? { n } : {})
  p.events = 数(p.events) + 1
  p.last = now
  return true
}

/** 她自己给今天的关系打分（-2..+2）：亲近放大 1.5、安全 0.8、兴致 1.0。 */
function 自评(p, v, why, now) {
  const val = clamp(数(v), -2, 2)
  if (!val) return false
  const map = { 亲近: val * 1.5, 安全: val * 0.8, 兴致: val * 1.0 }
  const dims = {}
  for (const [k, d0] of Object.entries(map)) {
    const d = clamp(d0, -3, 3)
    if (!d) continue
    p.dims[k] = r1(clamp(数(p.dims[k], 日常[k]) + d, 0, 上限[k]))
    dims[k] = r1(d)
  }
  记一条(p, '自评', why, dims, now, { v: val })
  p.events = 数(p.events) + 1
  return true
}

/** v1 → v2：按原 score 反推亲近，保证面板上数字不跳；原档整份留在 legacy 里。 */
function 迁移(db, now) {
  if (db && db.version === 2) return false
  const 原 = (db && typeof db.people === 'object' && db.people) ? db.people : {}
  const legacyPeople = JSON.parse(JSON.stringify(原))
  const people = {}
  for (const [uin, old] of Object.entries(原)) {
    const score = clamp(数(old && old.score, 40), 0, 100)
    const 安全 = 55
    const 兴致 = 45
    const 亲近 = clamp((score - 0.3 * 安全 - 0.2 * 兴致) / 0.5, 0, 100)
    people[uin] = {
      dims: { 亲近: r1(亲近), 安全, 兴致, 思念: 0 },
      熟悉度: 数(old && old['熟悉度'], 20),
      turns: 数(old && old.turns),
      events: 数(old && old.events),
      last: 数(old && old.last, now),
      lastTick: now,
      ...(old && old['只展示'] ? { 只展示: true } : {}),
      ...(old && old.memo ? { memo: String(old.memo) } : {}),
      ...(old && old['结算日'] ? { 结算日: String(old['结算日']) } : {}),
      ...(old && old.nick ? { nick: String(old.nick) } : {}),
      log: [{
        at: 北京(now), atMs: now, kind: '迁移', delta: score,
        why: 'v1→v2 框架重置（按原分反推，原档留在 legacy）', dims: {},
      }, ...((old && Array.isArray(old.log)) ? old.log : [])].slice(0, 日志上限),
    }
    // 迁移完立刻按 v2 公式算一次 score（不结算就没有 score，面板会显示 undefined）
    结算(people[uin], now)
  }
  db.version = 2
  db.note = '关系状态 v2：四个会回落的状态；score 只是渲染（0.5亲近+0.3安全+0.2兴致）'
  db.people = people
  db.legacy = { migratedAt: now, people: legacyPeople }
  return true
}

function 保证(db, now) {
  const out = (db && typeof db === 'object' && !Array.isArray(db)) ? db : { people: {} }
  if (out.version !== 2) 迁移(out, now)
  if (!out.people || typeof out.people !== 'object') out.people = {}
  return out
}

function 取人(db, uin, now) {
  db.people[uin] = db.people[uin] || {
    dims: { ...日常 }, turns: 0, events: 0, last: now, lastTick: now, 熟悉度: 20, log: [],
  }
  const p = db.people[uin]
  p.dims = { ...日常, ...(p.dims || {}) }
  return p
}

/** 在锁内应用一次写入。返回 false = 不写。 */
function 应用(db, ctx) {
  保证(db, ctx.now)
  const p = 取人(db, ctx.who, ctx.now)
  // 日结幂等：同一天只结一次（先判，别先写结算日）
  if (ctx.kind === '日结' && ctx.settle && p.结算日 === ctx.settle) return null
  if (ctx.fam !== null) p['熟悉度'] = clamp(ctx.fam, 0, 100)
  if (ctx.turns !== null) p.turns = ctx.turns
  if (ctx.settle) p.结算日 = ctx.settle
  if (ctx.onlyDisplay) p['只展示'] = true
  if (ctx.memo) p.memo = String(ctx.memo).slice(0, 200)
  const ok = ctx.kind === '自评'
    ? 自评(p, ctx.v, ctx.why, ctx.now)
    : 施加(p, ctx.kind, { n: ctx.n, why: ctx.why }, ctx.now)
  if (!ok) return null
  结算(p, ctx.now)
  return p
}

// ── CLI ───────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const 有 = (n) => args.includes(n)
const dry = 有('--dry')
const now = Date.now()

function 打印(db, who) {
  const list = who ? [[who, db.people[who]]] : Object.entries(db.people || {})
  for (const [uin, p] of list) {
    if (!p) continue
    const d = p.dims || {}
    console.log(`${uin}：${p.score} 分 · 亲近 ${d['亲近']} / 安全 ${d['安全']} / 兴致 ${d['兴致']} / 思念 ${d['思念']}` +
      ` · 熟悉度 ${p['熟悉度']}${p['只展示'] ? ' · 只展示' : ''}`)
    for (const x of (p.log || []).slice(0, 3)) console.log(`  ${x.at} ${x.kind} ${x.delta > 0 ? '+' : ''}${x.delta}${x.why ? '（' + x.why + '）' : ''}`)
  }
}

if (有('--json')) {
  const db = 保证(JSON.parse(JSON.stringify(读档(FILE, { people: {} }))), now)
  console.log(JSON.stringify(db, null, 2))
  process.exit(0)
}

if (有('--migrate')) {
  const db0 = 读档(FILE, { people: {} })
  if (db0 && db0.version === 2) { console.log('已经是 v2，不用迁'); process.exit(0) }
  let 变了 = false
  if (dry) { 变了 = 迁移(JSON.parse(JSON.stringify(db0)), now) }
  else 改档(FILE, (db) => { 变了 = 迁移(db, now); return 变了 ? undefined : false }, { people: {} })
  console.log(变了 ? '已迁移到 v2（原档留在 legacy）' : '没什么可迁的')
  process.exit(0)
}

if (有('--tick')) {
  let 人数 = 0
  if (dry) {
    const db = 保证(JSON.parse(JSON.stringify(读档(FILE, { people: {} }))), now)
    for (const p of Object.values(db.people)) { p.dims = { ...日常, ...(p.dims || {}) }; 结算(p, now); 人数 += 1 }
  } else {
    改档(FILE, (db) => {
      保证(db, now)
      for (const p of Object.values(db.people)) { p.dims = { ...日常, ...(p.dims || {}) }; 结算(p, now); 人数 += 1 }
      return 人数 ? undefined : false
    }, { people: {} })
  }
  console.log(`衰减/思念已结算：${人数} 人${dry ? '（dry 不写）' : ''}`)
  process.exit(0)
}

if (有('--show')) {
  const db = 保证(JSON.parse(JSON.stringify(读档(FILE, { people: {} }))), now)
  打印(db, String(val('--who', '') || ''))
  process.exit(0)
}

const who = String(val('--who', '') || '').trim()
if (!who) {
  console.error('要指定 --who <QQ号>，或用 --tick / --migrate / --show / --json')
  process.exit(1)
}

// 兼容旧调用：--say 闲聊 / --dim 相似性 2
let kind = String(val('--event', '') || val('--say', '')).trim()
if (!kind) kind = String(val('--dim', '') || '').trim() ? '自评' : '闲聊'
// 旧开关兼容（感受.mjs 还在用）：--scold / --unscold / --sorry
if (有('--scold')) kind = '坏话'
else if (有('--unscold')) kind = '想岔了'
else if (有('--sorry')) kind = '道歉'
kind = 旧事件[kind] || kind
const famRaw = val('--fam', '')
const turnsRaw = val('--turns', '')

const ctx = {
  who, kind, now,
  n: val('--n', ''),
  why: val('--why', ''),
  v: val('--v', val('--say', '1')),
  settle: String(val('--settle', '') || ''),
  fam: famRaw === '' ? null : Number(famRaw),
  turns: turnsRaw === '' ? null : Number(turnsRaw),
  onlyDisplay: 有('--only-display'),
  memo: String(val('--memo', '') || ''),
}

let 结果 = null
if (dry) {
  const db = 保证(JSON.parse(JSON.stringify(读档(FILE, { people: {} }))), now)
  结果 = 应用(db, ctx)
} else {
  改档(FILE, (db) => { const r = 应用(db, ctx); if (!r) return false; 结果 = r }, { people: {} })
}

if (!结果) {
  console.log(`${who}：这一天已经结过（${ctx.settle}），跳过`)
  process.exit(0)
}
console.log(`${who}：${kind} → ${结果.score} 分（亲近 ${结果.dims['亲近']} / 安全 ${结果.dims['安全']} / 兴致 ${结果.dims['兴致']}）${dry ? '（dry 不写）' : ''}`)
