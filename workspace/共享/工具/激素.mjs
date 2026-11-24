#!/usr/bin/env node
// 激素.mjs —— 情绪激素的「瞬时值 + 设定点 + 适应」+ 相互抑制 + 关系调制（2026-11-04）
//
// 用法：
//   node 激素.mjs --tick                 # 按经过时间衰减 + 更新设定点（cron 每 15 分钟）
//   node 激素.mjs --event 被夸 [--id x] [--who QQ]   # 记一次事件；--who 走关系调制
//   node 激素.mjs --show                 # 打印人话 + 数值
//   node 激素.mjs --reset-baseline       # 设定点归基线（建议每月一次）
//   node 激素.mjs --dry                  # 只算不写
//   HJ_BASE=/tmp/x node 激素.mjs --tick  # 测试用：把「记忆」目录换到沙盒
//
// 为什么这么写：
//   · 激素只当「底色」，不改 layers、不碰好感度；扣数值的事仍归 奖惩.mjs。
//   · 用户要的「缓冲」= 受体适应：水平长期偏高 → 设定点抬 → 同样的事增量变小；
//     长期没事 → 设定点回落 → 小事也能开心。设定点漂移慢、有上下限。
//   · 互相抑制只压「正向增量」，不主动把值往下按：皮质醇高最多压掉多巴胺 65%，
//     多巴胺高反向压皮质醇 35%；皮质醇超过设定点还有 HPA 自限（越高压得越狠）。
//   · 关系调制幅度很小，且只对有 --who 的事件生效：bond/safety 只影响增量，不改设定点。
//   · 事件必须能去重：同一条消息重放两次，不允许结算两次。

import fs from 'node:fs'
import path from 'node:path'
import { 写档 } from './_底层.mjs'

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

const BASE = process.env.HJ_BASE || '{{BOT_ROOT}}/记忆'
const FILE = path.join(BASE, '激素.json')
const EVENTS = path.join(BASE, '激素事件.jsonl')
const REL_FILE = path.join(BASE, '关系.json')
const PAIN_FILE = path.join(BASE, '激素痛苦.json')
const PARAM = '{{BOT_ROOT}}/共享/工具/参数.json'
const dry = process.argv.includes('--dry')

// —— 默认参数（可被 参数.json 的「激素」段覆盖）
const DEFAULTS = {
  // BUDGET_WINDOW 2026-11-05：多巴胺的 budget 原来是「每天 40 点」，但它的半衰期只有 0.75 小时。
  // 结果是一天里前几件开心事（吃饭+6、被夸+10、喝咖啡+4…）就把 40 点花光，
  // 之后大半天再被夸，多巴胺一动不动 —— 她"开心"这条线下午是死的。
  // 改成 1 小时滑动窗口、每小时 20 点：一小时里两次大的（各 8~10）或三次小的就会饱和，
  // 但过一小时又能重新开心。半衰期本来就快，这里只需要防"刷"，不需要防"一天"。
  // 其他三种不动：皮质醇半衰期 3 小时、催产素 6 小时，按天算本来就是对的。
  dopamine: { b0: 45, half: 0.75, capPos: 12, capNeg: 8, budget: 20, window: 0.5, budgetWindow: 1, name: '多巴胺' },
  cortisol: { b0: 25, half: 3, capPos: 15, capNeg: 10, budget: 45, window: 12, name: '皮质醇' },
  oxytocin: { b0: 40, half: 6, capPos: 10, capNeg: 8, budget: 30, window: 6, name: '催产素' },
  gaba: { b0: 50, half: 1.5, capPos: 8, capNeg: 6, budget: 30, window: 0.5, name: 'GABA' },
  // ADRENALINE 2026-11-16（批次572，主人要的第五个）
  //
  // 为什么 half 只有 0.35 小时（21 分钟）：血中半衰期 2~3 分钟，功能效应 20~60 分钟。
  // 它跟皮质醇（3 小时）差一个量级 —— 这个差距本身就是设计：
  // 「被吓一跳」是当下的事，「一直提着心」才是皮质醇。
  //
  // 为什么 noAdapt：设定点漂移是**受体适应**（长期偏高 → 同样的事增量变小），
  // 那是体质层面的事。急性激素不该有 —— 否则今天看三部恐怖片，设定点被永久抬高，
  // 以后看恐怖片就「不吓人了」，而这不是适应，是把她的惊吓额度用完了。
  //
  // budget 30/半小时：看一部片子（+26）就差不多用光，第二部开始衰减 —— 合理，
  // 人也不能一晚上被吓三次还次次跳起来。
  adrenaline: { b0: 18, half: 0.35, capPos: 28, capNeg: 8, budget: 30, window: 0.5, name: '肾上腺素', noAdapt: true },
}

// ══════════════════════════════════════════════════════════════
// 事件表（2026-11-16 批次572 **全审重写**，从四种激素扩到五种）
//
// 分四组：急性（肾上腺素）/ 慢性压力（皮质醇）/ 奖赏与亲密 / 地点与身体 / 内容反应。
//
// **急性组的判据只有一条：有没有真实的心跳加速。** 没有就不给肾上腺素 ——
// 给多了她会变成「动不动就激动」的人，那不是她。
//
// 数值校准（2026-11-16 对过文献，不是拍的）：
//   · 恐怖片是三者齐上：肾上腺素 +26 / 皮质醇 +6 / 多巴胺 +7。
//     肾上腺素是当下的（半衰期 0.35h），多巴胺是事后那股「爽」（安全的恐惧，0.75h），
//     两条曲线靠半衰期自然错开，不需要写两段代码。
//   · 负面事件的余韵本来就长：皮质醇半衰期 3h、多巴胺 0.75h ——
//     一次被骂 ≈ 四次被夸。这是 negative bias，**不是 bug，别再拉平**。
//   · 「晒太阳」以前被 逛街/散心/逛店 共用，等于在便利店站着也降皮质醇 ——
//     一天 84 次把皮质醇打到 2.2（平常 24.7）。现在各归各的。
// ══════════════════════════════════════════════════════════════
const EVENTS_TABLE = {
  // ── 急性：有心跳加速的那种 ──────────────────────────────────
  看恐怖片: { adrenaline: 26, cortisol: 6, dopamine: 7, oxytocin: 2 },
  被吓到: { adrenaline: 22, cortisol: 5, dopamine: -2 },
  差点出事: { adrenaline: 24, cortisol: 8, dopamine: -3 },
  当众被点名: { adrenaline: 18, cortisol: 7, dopamine: -2 },
  // 过山车是「安全的危险」：肾上腺素和多巴胺一起上，皮质醇只轻抬
  玩过山车: { adrenaline: 22, dopamine: 14, cortisol: 6 },

  // ── 慢性压力：皮质醇为主 ────────────────────────────────────
  // 吵架是急+慢各一半：当下 adrenaline 10 让心跳上来，cortisol 12 留得久
  争吵: { cortisol: 12, oxytocin: -6, adrenaline: 10 },
  被打断: { cortisol: 8, dopamine: -4, adrenaline: 3 },
  熬夜: { cortisol: 10, gaba: -8 },
  饿: { cortisol: 3 },
  // THIRST 2026-11-08（批次223）：长期渴着才压底色，不是「当下有点烦」。
  // 触发在 状态推进：水 <50%、3 小时一次；别每 15 分钟发一条把皮质醇刷满。
  渴: { cortisol: 4, dopamine: -2 },
  // SICK 2026-11-08（批次224）：发病那一下发一次，不是每 15 分钟刷。
  生病: { cortisol: 6, dopamine: -3 },
  被骂: { cortisol: 14, oxytocin: -8, adrenaline: 6 },
  // RELATION 2026-11-05：她开了口没人应（主动搭话落空）／对方隔了会儿又回来。
  // 这两个是「关系温度」最直接的信号，比奖惩那边的事件轻，所以增量也小。
  被冷落: { oxytocin: -5, cortisol: 4, dopamine: -3 },
  搞砸: { cortisol: 10, dopamine: -6 },
  越界: { cortisol: 12, oxytocin: -10, adrenaline: 5 },

  // ── 奖赏与亲密：多巴胺 / 催产素 ─────────────────────────────
  被夸: { dopamine: 10, oxytocin: 4 },
  陪伴: { oxytocin: 8, cortisol: -6 },
  被抱: { oxytocin: 10, cortisol: -8 },
  修复: { oxytocin: 8, cortisol: -8 },
  被想起: { oxytocin: 6, cortisol: -3, dopamine: 2 },
  // LIKE_HORMONE 2026-11-05：**她自己**觉得「刚才被看见了」。
  // 只升催产素，**不给多巴胺**：被看见是「有人在听」，不是「我干得好」。
  被注意到: { oxytocin: 5 },
  // FEELING_LEDGER 2026-11-05：她自己发现刚才判错了 —— 绷着的松开一点。
  想岔了: { cortisol: -7, dopamine: 3 },
  吃饭: { dopamine: 6 },
  吃好吃的: { dopamine: 10, oxytocin: 3 },
  吃糖: { dopamine: 8 },
  // 咖啡的肾上腺素只给 4：是「清醒一点」，不是「心跳到嗓子眼」
  喝咖啡: { dopamine: 4, cortisol: 3, adrenaline: 4 },
  看书: { dopamine: 3 },
  电影: { dopamine: 6, oxytocin: 2 },
  // ALIAS 2026-11-17（批次677）：物品总表·服务「电影」的 效果.激素 写的是「看电影」；
  // 以前只在事件表里留了「电影」，活动/计划/服务三条入口都静默发不出去。
  // 「电影」仍是正名，这一条只是给存量数据的别名，增量和「电影」完全一致。
  看电影: { dopamine: 6, oxytocin: 2 },

  // ── 地点与身体 ──────────────────────────────────────────────
  // ADRENALINE_FIX 2026-11-16（批次572）：下面三条以前统统映射到「晒太阳」。
  // 晒太阳是**真的晒到太阳**：皮质醇降、多巴胺轻抬。逛街和逛店是「在动 / 在看东西」，
  // 跟太阳没关系 —— 尤其便利店逛店，一天能发 84 次。
  晒太阳: { cortisol: -6, dopamine: 3, oxytocin: 2 },
  逛街: { dopamine: 4, cortisol: -2 },
  逛店: { dopamine: 3 },
  散心: { cortisol: -4, dopamine: 2 },
  看海: { cortisol: -8, oxytocin: 4 },
  // 运动：多巴胺（跑完那股爽）+ 肾上腺素（当下心跳）+ 皮质醇只轻抬（急性运动不压免疫）
  运动: { dopamine: 8, adrenaline: 8, cortisol: 2 },
  泡澡: { cortisol: -5, gaba: 6, adrenaline: -3 },
  睡醒: { cortisol: -8, gaba: 6, adrenaline: -4 },

  // ── 内容反应：她自己写下的那个词 ───────────────────────────
  //
  // 名字全是「我怎么了」，没有一条是「内容是什么」—— 这是整套系统唯一不能越的线：
  // 系统不读标题、不扫正文关键词去判「这是悲伤的内容」，那样做已经栽过一次
  // （「滚」被当成骂人，6624 条语料里 47 条几乎全是「回滚/滚动」）。
  // 所以系统只做两件事：把内容递到她面前，把她自己写下的那个词记成激素。
  //
  // 也不进 PAIN_KINDS：那一组会触发 30~120 分钟的痛苦窗口和补偿加成，
  // 是留给「有人伤到她」的。片子让她难受，不该记在谁头上。
  看到好笑的: { dopamine: 9, gaba: 4 },
  看到难受的: { cortisol: 8, dopamine: -3 },
  被打动: { oxytocin: 7, cortisol: -4 },
  // 她说「发慌」就是真的被吓到 —— 这一条给肾上腺素，和恐怖片同一个道理
  看得发慌: { cortisol: 7, gaba: -3, adrenaline: 9 },
  看得来气: { cortisol: 7, dopamine: -4, adrenaline: 4 },
  看得没劲: { dopamine: -3 },
  看明白点什么: { dopamine: 4 },
}

const PAIN_KINDS = new Set(['被骂', '争吵', '被打断', '越界', '搞砸'])

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n))
const round1 = (n) => Math.round(n * 10) / 10
const now = Date.now()
const bjDate = () => new Date(now + 8 * 3600e3).toISOString().slice(0, 10)
const bjTime = () => new Date(now + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function loadParams() {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS))
  try {
    const pj = JSON.parse(fs.readFileSync(PARAM, 'utf8'))
    const over = pj['激素'] || {}
    for (const k of Object.keys(cfg)) if (over[k]) Object.assign(cfg[k], over[k])
  } catch { /* 参数表读不到就用默认 */ }
  return cfg
}

function loadState(cfg) {
  let s = null
  try {
    s = JSON.parse(fs.readFileSync(FILE, 'utf8'))
  } catch (e) {
    // LOAD_GUARD 2026-11-04：只有文件不存在才当首次运行；解析失败/权限错误必须报错退出，
    // 否则会拿默认值写回，把现有激素状态整个覆盖掉。
    if (!e || e.code !== 'ENOENT') {
      console.error('激素.json 读取失败（不写回，避免覆盖）：' + (e && e.message))
      process.exit(1)
    }
  }
  if (!s || typeof s !== 'object') s = {}
  s.v = s.v || {}
  s.B = s.B || {}
  s.repeats = s.repeats || {}
  s.daily = s.daily && s.daily.date === bjDate() ? s.daily : { date: bjDate(), used: {} }
  for (const k of Object.keys(cfg)) {
    // 2026-11-04 修：原来只判 typeof number，NaN 也是 number、1e12 也是 number，原样带进公式。
    // 实测把 v 写成 1e12 后 tick 也不夹（dt=0 时整段跳过），脏数会一直留在盘上。
    // 这里统一：有限才留，越界就夹到 0–100，脏值回落基线。
    if (typeof s.v[k] !== 'number' || !Number.isFinite(s.v[k])) s.v[k] = cfg[k].b0
    else s.v[k] = clamp(s.v[k], 0, 100)
    if (typeof s.B[k] !== 'number' || !Number.isFinite(s.B[k])) s.B[k] = cfg[k].b0
    // ADRENALINE 2026-11-16（批次572）：急性激素的设定点恒等于基线，不参与漂移也不许被写歪
    else s.B[k] = cfg[k].noAdapt ? cfg[k].b0 : clamp(s.B[k], 0.85 * cfg[k].b0, 1.15 * cfg[k].b0)
    if (typeof s.daily.used[k] !== 'number' || !Number.isFinite(s.daily.used[k])) s.daily.used[k] = 0
    // 滑动窗口账本（只有配了 budgetWindow 的激素用）。脏记录直接丢掉，
    // 不然一条 at=NaN 会让 filter 永远留着它、预算一直被占。
    if (cfg[k].budgetWindow) {
      // BUDGET_CLEAN 2026-11-05：改成窗口后，daily.used[k] 不再参与计算，
      // 但昨天攒到 40/40 的旧值还留在盘上——面板/体检看到了会以为"今天的额度已经满了"，
      // 排查时也会被它带偏。这里归零，只留窗口那一份真账。
      s.daily.used[k] = 0
      s.used = s.used || {}
      if (!Array.isArray(s.used[k])) s.used[k] = []
      s.used[k] = s.used[k].filter((x) => x && Number.isFinite(Number(x.at)) && Number.isFinite(Number(x.d)))
    }
  }
  // 2026-11-04 修：文件里还留着早期版本写的中文键（多巴胺/皮质醇…），现在只用拉丁键，
  // 这些残键没人读却会误导排查（实测被塞成 1e12 还一直留着）。统一清掉。
  for (const k of Object.keys(s.v)) if (!(k in cfg)) delete s.v[k]
  for (const k of Object.keys(s.B)) if (!(k in cfg)) delete s.B[k]
  return s
}

function tick(s, cfg) {
  const dt = clamp((now - (Number(s.lastTick) || now)) / 3600e3, 0, 24 * 14)
  if (dt > 0) {
    for (const k of Object.keys(cfg)) {
      const c = cfg[k]
      // 1) 瞬时值朝设定点做半衰期衰减（无条件，别写「相等就跳过」）
      s.v[k] = s.B[k] + (s.v[k] - s.B[k]) * Math.pow(2, -dt / c.half)
      // 2) 设定点用 72 小时 EMA 慢慢追，限在 0.85~1.15 倍基线
      // ADRENALINE 2026-11-16（批次572）：noAdapt 的那几个（肾上腺素）跳过这一段 ——
      // 它是急性状态，不是体质。漂移 = 把「今天被吓了三次」变成「以后不怕了」，那是错的。
      if (!c.noAdapt) {
        const ema = s.B[k] + (s.v[k] - s.B[k]) * (1 - Math.pow(2, -dt / 72))
        s.B[k] = clamp(ema, 0.85 * c.b0, 1.15 * c.b0)
      } else {
        s.B[k] = c.b0
      }
      s.v[k] = clamp(s.v[k], 0, 100)
      s.v[k] = round1(s.v[k])
      s.B[k] = round1(s.B[k])
    }
  }
  s.lastTick = now
  return dt
}

function sensitivity(s, cfg, k) {
  return clamp(cfg[k].b0 / Math.max(1, s.B[k]), 0.65, 1.35)
}

function repeatFactor(s, cfg, k, kind) {
  const key = k + ':' + kind
  const rec = s.repeats[key] || { n: 0, at: 0 }
  const fresh = now - rec.at <= cfg[k].window * 3600e3
  const n = fresh ? rec.n : 0
  s.repeats[key] = { n: n + 1, at: now }
  return Math.max(0.15, Math.pow(0.55, n))
}

// 窗口内已经用掉多少预算。顺手把过期的条目清掉——这个函数只在结算时调，
// 所以清理的时机刚好：写之前先瘦身，文件不会越攒越大。
function usedInWindow(s, k, hours) {
  s.used = s.used || {}
  const arr = Array.isArray(s.used[k]) ? s.used[k] : []
  const since = now - hours * 3600e3
  const kept = arr.filter((x) => Number(x.at) >= since)
  s.used[k] = kept
  return kept.reduce((a, x) => a + (Number(x.d) || 0), 0)
}

/**
 * 这个事件 id 记过没有（去重）。
 *
 * SEEN_INDEX 2026-11-24：原来是「读整个账本、取最后 300 行、线性 includes」——
 * 而账本已经 387 行，**再往后涨，更早的 id 就查不到了，同一事件会重复入账**。
 * 现在是增量索引：记住上次读到第几行（存在 .seen-index.json），
 * 下次只从那里往后扫，把新出现的 id 收进一个 Set（上限 5000，超出丢最老的）。
 * 首次运行会全量扫一遍（一次性开销），之后每次只读新增的几行。
 */
const SEEN_CACHE = path.join(BASE, '.激素已见.json')
const SEEN_MAX = 5000
let __seen = null

function 载已见() {
  if (__seen) return __seen
  let cache = null
  try { cache = JSON.parse(fs.readFileSync(SEEN_CACHE, 'utf8')) } catch { /* 首次或坏了都重建 */ }
  const ids = Array.isArray(cache && cache.ids) ? cache.ids : []
  let 行数 = Number(cache && cache.行数) || 0
  const set = new Set(ids)
  // 增量：从上次读到的行往后扫，把新 id 补进来
  let 全 = ''
  try { 全 = fs.readFileSync(EVENTS, 'utf8') } catch { /* 账本还不存在 */ }
  const 全部行 = 全 ? 全.split('\n').filter((x) => x.trim() !== '') : []
  // 账本被轮转/截断时行数会变小，此时重扫
  if (行数 > 全部行.length) 行数 = 0
  for (let i = 行数; i < 全部行.length; i++) {
    const m = 全部行[i].match(/"id"\s*:\s*"([^"]+)"/)
    if (m) set.add(m[1])
  }
  const 截 = [...set]
  const 留 = 截.slice(Math.max(0, 截.length - SEEN_MAX))
  __seen = { set: new Set(留), 行数: 全部行.length, 脏: 留.length !== 截.length || 行数 !== (cache && cache.行数) }
  return __seen
}

function 存已见() {
  if (!__seen || !__seen.脏) return
  try {
    fs.writeFileSync(SEEN_CACHE, JSON.stringify({ 行数: __seen.行数, ids: [...__seen.set] }))
    __seen.脏 = false
  } catch { /* 索引用丢了只影响去重精度，不影响激素本身 */ }
}

function seenEvent(id) {
  if (!id) return false
  try {
    const s = 载已见()
    const 有 = s.set.has(String(id))
    if (!有) { s.set.add(String(id)); s.脏 = true }
    存已见()
    return 有
  } catch { return false }
}

// —— 关系（按人存）与痛苦窗口：缺文件时按中性处理，不影响主流程
function loadRel(who) {
  if (!who) return null
  try {
    const j = JSON.parse(fs.readFileSync(REL_FILE, 'utf8'))
    const p = (j.people || {})[String(who)] || {}
    return { bond: clamp(Number(p.bond || 0), 0, 1), safety: clamp(Number(p.safety || 0.5), 0, 1) }
  } catch { return null }
}

function painActive() {
  try {
    const j = JSON.parse(fs.readFileSync(PAIN_FILE, 'utf8'))
    const dt = (now - Number(j.at || 0)) / 60000
    return dt >= 30 && dt <= 120
  } catch { return false }
}

function applyEvent(s, cfg, kind, id, who) {
  const deltas = EVENTS_TABLE[kind]
  if (!deltas) return { ok: false, why: '未知事件: ' + kind }
  if (seenEvent(id)) return { ok: false, why: '重复事件，已忽略: ' + id }
  const rel = loadRel(who)
  const pain = painActive()
  const out = { ok: true, kind, at: bjTime(), deltas: {} }
  for (const k of Object.keys(deltas)) {
    const c = cfg[k]
    const raw = deltas[k]
    let d = raw * sensitivity(s, cfg, k) * repeatFactor(s, cfg, k, kind)

    // CROSS_TALK 2026-11-04：互相抑制与 HPA 自限只压「正向增量」，不主动把值往下按
    const D = s.v.dopamine, C = s.v.cortisol
    if (k === 'dopamine' && d > 0) {
      const u = clamp((C - s.B.cortisol) / Math.max(1, 100 - s.B.cortisol), 0, 1)
      d *= clamp(1 - 0.65 * u, 0.35, 1)
    }
    if (k === 'cortisol' && d > 0) {
      const v = clamp((D - s.B.dopamine) / Math.max(1, 100 - s.B.dopamine), 0, 1)
      d *= clamp(1 - 0.35 * v, 0.65, 1)
      const u2 = clamp((C - s.B.cortisol) / Math.max(1, 100 - s.B.cortisol), 0, 1)
      d *= clamp(1 - 0.6 * u2, 0.25, 1)
    }

    // REL_MOD 2026-11-04：关系强度/安全感只做小幅调制，避免谁都能刷到亲密
    if (rel && d > 0) {
      if (k === 'oxytocin') d *= 0.8 + 0.4 * rel.bond * rel.safety
      if (k === 'cortisol') d *= 1 + 0.8 * rel.bond * (1 - rel.safety)
      if (k === 'dopamine') d *= 1 + 0.3 * rel.bond
    }

    // PAIN_RELIEF 2026-11-04：痛苦事件后 30~120 分钟内，正向事件允许一点补偿加成
    if (pain && d > 0 && (k === 'dopamine' || k === 'oxytocin')) d *= 1.25

    d = clamp(d, -c.capNeg, c.capPos)
    if (d > 0) {
      if (c.budgetWindow) {
        // 滑动窗口：只算最近 budgetWindow 小时用掉的，出去的自然回到额度里
        const left = Math.max(0, c.budget - usedInWindow(s, k, c.budgetWindow))
        d = Math.min(d, left)
        if (d > 0) {
          s.used = s.used || {}
          if (!Array.isArray(s.used[k])) s.used[k] = []
          s.used[k].push({ at: now, d })
        }
      } else {
        const left = Math.max(0, c.budget - s.daily.used[k])
        d = Math.min(d, left)
        s.daily.used[k] += d
      }
    }
    const before = s.v[k]
    s.v[k] = clamp(s.v[k] + d, 0, 100)
    out.deltas[k] = { from: round1(before), to: round1(s.v[k]), delta: round1(s.v[k] - before) }
  }
  try {
    if (PAIN_KINDS.has(kind)) fs.writeFileSync(PAIN_FILE, JSON.stringify({ at: now, kind }), 'utf8')
  } catch { /* 写不进去就只是没有补偿 */ }
  if (id) {
    try { fs.appendFileSync(EVENTS, JSON.stringify({ id, kind, at: now }) + '\n') } catch { /* 落盘失败只影响去重 */ }
  }
  return out
}

// —— 人话（面板/提示词用，不暴露数值）
function humanWords(s) {
  const d = s.v.dopamine, c = s.v.cortisol, o = s.v.oxytocin, g = s.v.gaba, a = s.v.adrenaline
  const parts = []
  // ADRENALINE 2026-11-16（批次572）：急性唤醒单独一句，放在最前面 ——
  // 「心跳还没缓下来」比「心里有点压着」更贴近当下的体感。
  parts.push(a >= 55 ? '心跳还没缓下来' : a >= 35 ? '有点绷着' : '')
  parts.push(c >= 65 ? '绷得有点紧' : c >= 45 ? '心里有点压着' : '还算松弛')
  parts.push(d >= 70 ? '挺有劲' : d <= 25 ? '提不起劲' : '平常')
  parts.push(o >= 65 ? '想黏人' : o <= 30 ? '有点疏远' : '')
  parts.push(g <= 30 ? '静不下来' : '')
  return parts.filter(Boolean).join('，')
}

function save(s) {
  // ATOMIC_SAVE 2026-11-07（批次178）：锁在外层（withLock，334 行），这里只补原子写。
  写档(FILE, s, { 不写: dry })
}

// LOCK 2026-11-04：tick（cron）和事件（消息触发）可能同时跑，直接读改写会丢更新；
// 用 .lock 文件串行化写操作（--show 只读，不加锁）。
// LOCK_V2：锁里写唯一 token，释放前校验；过期锁用 rename 抢（只可能一个进程抢到），避免互相删锁。
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
      const t0 = Date.now(); while (Date.now() - t0 < 20) { /* 20ms 自旋，短到不影响 cron */ }
    }
  }
  if (!got) throw new Error('激素锁超时')
  // 2026-11-04 修：process.exit() 不会走 finally，读取失败那条早退分支会把锁留在盘上，
  // 之后 30 秒内所有调用都撞「激素锁超时」。这里挂一个 exit 钩子兜底放锁。
  const __unlock = () => { try { if (fs.readFileSync(LOCK, 'utf8') === LOCK_TOKEN) fs.unlinkSync(LOCK) } catch { /* 锁已不是自己的 */ } }
  process.once('exit', __unlock)
  try { return fn() } finally {
    process.removeListener('exit', __unlock)
    __unlock()
  }
}

const args = process.argv.slice(2)
const 用法 = [
  '用法：',
  '  node 激素.mjs --tick',
  '  node 激素.mjs --event 被夸 [--id x] [--who QQ]',
  '  node 激素.mjs --show',
  '  node 激素.mjs --reset-baseline',
  '  node 激素.mjs --reset-all',
  '  node 激素.mjs --dry',
].join('\n')

// 参数守卫：以前任何不认识的参数（包括 --help）都会落到 else 的 --tick，
// 结果只是看一眼帮助就把线上激素状态推进了一次。帮助必须只读，拼错必须报错。
const 带值参数 = new Set(['--event', '--id', '--who', '--why'])
const 开关参数 = new Set(['--show', '--reset-all', '--reset-baseline', '--tick', '--dry', '--help', '-h'])
const 未知参数 = []
const 缺值参数 = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (带值参数.has(a)) {
    const v = args[i + 1]
    if (!v || v.startsWith('--')) 缺值参数.push(a)
    else i++
  } else if (!开关参数.has(a)) {
    未知参数.push(a)
  }
}

const cfg = loadParams()
const val = (n) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : null }

if (args.includes('--help') || args.includes('-h')) {
  console.log(用法)
} else if (未知参数.length > 0 || 缺值参数.length > 0) {
  if (未知参数.length > 0) console.error('未知参数：' + 未知参数.join('、'))
  if (缺值参数.length > 0) console.error('参数缺少值：' + 缺值参数.join('、'))
  console.error(用法)
  process.exitCode = 2
} else if (args.includes('--show')) {
  const s = loadState(cfg)
  console.log('人话：' + humanWords(s))
  for (const k of Object.keys(cfg)) console.log(`  ${cfg[k].name} 值 ${round1(s.v[k])} 设定点 ${round1(s.B[k])} 敏感度 ${round1(sensitivity(s, cfg, k))}`)
} else if (args.includes('--reset-all')) {
  // RESET_ALL 2026-11-16（批次572）：主人拍板「全部归基线重开」。
  // 跟 --reset-baseline 的区别：那个只归设定点（保留当前值和账本），这个连
  // 当前值、重复计数、滑动窗口预算一起清 —— 否则「重开」之后
  // repeats 还记着「被夸已经第 5 次」，第一次事件就只给 15%。
  withLock(() => {
    const s = loadState(cfg)
    for (const k of Object.keys(cfg)) { s.v[k] = cfg[k].b0; s.B[k] = cfg[k].b0 }
    s.repeats = {}
    s.used = {}
    s.daily = { date: bjDate(), used: {} }
    save(s)
  })
  console.log('五个激素已归基线（当前值 + 设定点 + 重复计数 + 预算账本）')
} else if (args.includes('--reset-baseline')) {
  withLock(() => {
    const s = loadState(cfg)
    for (const k of Object.keys(cfg)) s.B[k] = cfg[k].b0
    save(s)
  })
  console.log('设定点已归基线')
} else if (args.indexOf('--event') >= 0) {
  const kind = val('--event')
  const msg = withLock(() => {
    const s = loadState(cfg)
    // HORMONE_EVENT_CATCHUP：事件时间点先补齐自上次推进以来的自然衰减，
    // 再叠加刚发生的增量；否则长时间无 tick 时新事件也会被当成旧值一起衰减。
    const dt = tick(s, cfg)
    const r = applyEvent(s, cfg, kind, val('--id'), val('--who'))
    if (!r.ok) {
      if (dt > 0) save(s) // 重放/未知事件不加增量，但时间经过仍需结算
      return r.why
    }
    save(s)
    return `事件 ${kind}：` + Object.entries(r.deltas).map(([k, v]) => `${cfg[k].name} ${v.from}→${v.to}`).join('，')
  })
  console.log(msg)
} else {
  const msg = withLock(() => {
    const s = loadState(cfg)
    const dt = tick(s, cfg)
    save(s)
    return `推进 ${dt.toFixed(2)} 小时；人话：${humanWords(s)}；` + Object.keys(cfg).map((k) => `${cfg[k].name} ${round1(s.v[k])}`).join(' ')
  })
  console.log(msg)
}
}
