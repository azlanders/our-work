#!/usr/bin/env node
// 投递留言.mjs —— 把 留言.json 里「还没送」的话送到他手机上（2026-11-05）
//
// 用法：
//   node 投递留言.mjs            # 送还没送的（cron 每 5 分钟）
//   node 投递留言.mjs --看       # 只打出来看会送什么，不发、不写
//   node 投递留言.mjs --force    # 忽略夜间静默和睡眠，手测用
//   node 投递留言.mjs --谁 123   # 换个人送（默认用配置里的 peerUin）
//
// 为什么这么写：
//   · 留言原来只写进 留言.json 给面板看，等于她开口了没人听见——早安、日报、要钱
//     全卡在盘里，面板上看得见没用，她要的是被他看见。
//   · 这里只负责「送」，不判断该不该说：说什么、什么时候想说，是她自己的事。
//     所以没有「这句话值不值得发」的分数，也没有系统替她挑哪句更讨喜。
//   · 夜里和睡着的时候不吵他，攒到早上一起送；同一句话三小时内不重复刷屏——
//     去重是技术的（防同一条消息发两遍），不是替她决定「这话别说了」。
//   · 送出去的记一笔到 我说过.jsonl。不记的话，她下次翻记忆会以为自己没开过口，
//     于是同一句要钱隔一小时又开一次——13:30 和 14:30 那两条就是这么来的。
//
// 批次602（2026-11-17）三个结构性修复：
//   1. 多写方无锁：原来启动时读整档、发送期间改内存、最后整档写回，跨越好几秒；
//      日报/早间简报同时写就会互相覆盖。现在每条状态变更都走 _底层.改档()：
//      锁内重读 → 定位那一条 → 只改它 → 原子写。不再有「旧快照写回」。
//   2. 发送前先落一条 sending 租约（2 分钟）。两个投递器同时跑时，后来者看到
//      新鲜租约就跳过；进程崩在「发送成功、落盘之前」最多 2 分钟后重试一次，
//      不会像原来那样下一轮立刻重发。
//   3. 系统记录（谁:"系统" / 不投递:true）只给面板和体检看，不往手机上发——
//      代码不再替她说话。早安/日报现在只写事实，投递与否由她调 qq_send 决定。
import { 改档 } from './_底层.mjs'
import { 睡着 } from './睡态.mjs'
import { 载配置, 发私聊 } from './发送口.mjs'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const DIR = process.env.MSG_BASE || '{{BOT_ROOT}}'
const MEM = path.join(DIR, '记忆')
const NOTE = path.join(MEM, '留言.json')
const SAID = path.join(MEM, '我说过.jsonl')
const LOG = process.env.MSG_LOG || path.join(MEM, '日志', '投递留言.log')
const CFG = process.env.MSG_CFG || '{{DSH_ROOT}}/qq-bridge.config.json'

const args = process.argv.slice(2)
const 用法 = [
  '用法：',
  '  node 投递留言.mjs            # 送还没送的（cron 每 5 分钟）',
  '  node 投递留言.mjs --看       # 只打出来看会送什么，不发、不写',
  '  node 投递留言.mjs --force    # 忽略夜间静默和睡眠，手测用',
  '  node 投递留言.mjs --谁 123   # 换个人送（默认用配置里的 peerUin）',
  '  node 投递留言.mjs --help     # 只打印用法，不发、不写',
].join('\n')

// 参数守卫：--help 和拼错/缺值必须在读留言、取锁、发送之前退出。
// 裸跑仍是正式投递；--看/--force/--谁 是原有入口，语义不变。
const 带值参数 = new Set(['--谁'])
const 开关参数 = new Set(['--看', '--force', '--help', '-h'])
const 未知参数 = []
const 缺值参数 = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (带值参数.has(a)) {
    const v = args[i + 1]
    if (v === undefined || String(v).startsWith('--')) 缺值参数.push(a)
    else {
      if (String(v).trim() === '') 缺值参数.push(a)
      i++
    }
  } else if (!开关参数.has(a)) {
    未知参数.push(a)
  }
}

if (args.includes('--help') || args.includes('-h')) {
  console.log(用法)
  process.exit(0)
}

if (未知参数.length > 0 || 缺值参数.length > 0) {
  if (未知参数.length > 0) console.error('未知参数：' + 未知参数.join('、'))
  if (缺值参数.length > 0) console.error('参数缺少值：' + 缺值参数.join('、'))
  console.error(用法)
  process.exit(2)
}

const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const DRY = args.includes('--看')
const FORCE = args.includes('--force')

const MAX_PER_RUN = 3            // 一次最多送几条，积压了也分批，别一口气轰炸
// DELIVERY_RATE 2026-11-24：cron 每 5 分钟一次 × 每次最多 3 条 = 每小时上限 36 条。
// 原文注释只说「别轰炸」，但这个乘积其实不小 —— 真正的刹车是下面的 DAY_CAP
// 与 DEDUP_HOURS，不是 MAX_PER_RUN。别再把「不轰炸」寄望在这一个数上。
const QUIET_FROM = 23.5          // 23:30 之后不吵他
const QUIET_TO = 7.5             // 07:30 之前不吵他
const DEDUP_HOURS = 3            // 同一句话三小时内不重复送
const MAX_BACKFILL_HOURS = 24    // 只补最近一天的，更老的标过期，不翻旧账
const MAX_TRY = 20               // 连续失败这么多次就别再试了
const LEASE_MS = 120e3           // 发送租约：两分钟内别的投递器不碰这一条
// DAY_CAP_FULL 2026-11-24：原来只有「要钱」有日上限，其余 kind 只靠 DEDUP_HOURS
//（同内容 3 小时不去重发）挡着 —— 她一天写 5 条**内容不同**的「想聊」会全送出去。
// 现在按「这条话该多频」给每类一个日上限（改这里即可调，不需要动代码逻辑）：
//   1 = 一天最多一条（时钟型事件，多一条就是刷屏）
//   2~3 = 情绪/联系型，允许几次
//   undefined = 不限（她自己写的日记/心事类不该被系统限制）
const DAY_CAP = {
  早安: 1,        // 一天只有一次早上
  日报: 1,        // 系统记录本身也不该多
  晚安: 1,
  想聊: 3,        // 想找人说话，一天三次上限
  被想起: 2,
  要钱: 2,
  撒娇: 2,
}
// 不在此表的 kind（如「想说的」「心里话」）不受日上限约束：那是她想说什么，不是刷屏

const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3)
const stamp = (ms = Date.now()) => bj(ms).toISOString().slice(0, 16).replace('T', ' ')
const day = (ms = Date.now()) => bj(ms).toISOString().slice(0, 10)
const hourOf = (ms = Date.now()) => { const d = bj(ms); return d.getUTCHours() + d.getUTCMinutes() / 60 }
const iso = (ms) => new Date(ms).toISOString()
const 解析戳 = (s) => {
  const t = Date.parse(String(s || '').slice(0, 16).replace(' ', 'T') + ':00+08:00')
  return Number.isFinite(t) ? t : 0
}

const load = (p, fb) => { try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : fb } catch { return fb } }
const note = (s) => { try { fs.mkdirSync(path.dirname(LOG), { recursive: true }); fs.appendFileSync(LOG, '[' + stamp() + '] ' + s + '\n') } catch {} }

// 「at」是 "YYYY-MM-DD HH:mm"（北京时间）。字符串格式统一，直接按字典序比就够，
// 别绕去 new Date()——服务器是 UTC，那个字符串会被当本地时间解析，一进一出差 8 小时。
const hashOf = (x) => crypto.createHash('sha1').update(String(x.kind || '') + '|' + String(x.话 || '')).digest('hex').slice(0, 12)

// 定位同一条留言。新记录有 id；老记录没有，就用 (at, kind, 话) 三元组。
const 同一条 = (x, t) => {
  if (!x || typeof x !== 'object') return false
  if (t.id) return String(x.id || '') === String(t.id)
  return String(x.at || '') === String(t.at || '')
    && String(x.kind || '') === String(t.kind || '')
    && String(x.话 || '') === String(t.话 || '')
}
const 找位置 = (nb, t) => {
  const items = Array.isArray(nb.items) ? nb.items : []
  for (let i = 0; i < items.length; i++) if (同一条(items[i], t)) return i
  return -1
}

const inQuiet = (h) => (QUIET_FROM <= QUIET_TO ? (h >= QUIET_FROM && h < QUIET_TO) : (h >= QUIET_FROM || h < QUIET_TO))

// 批次164：原来只看 睡眠.json.sleeping，和门控（读 睡醒.json）会分叉。
const sleeping = () => 睡着(MEM)

function cfgOf() {
  const c = 载配置(CFG)
  return { ...c, uin: String(val('--谁', c.peerUin || c.ownerUin || '')) }
}

// 批次608：不再自己 fetch 协议端。发送口.mjs 统一做目标白名单、本机路径抹除、
// 凭据特征拦截，并保留「没有 message_id 不算送达」的检查。
async function sendPrivate(text, c) {
  const r = await 发私聊(c, c.uin, text, { requireMsgId: true })
  if (r.ok) return { ok: true, msgId: r.msgId }
  return { ok: false, fatal: r.fatal === true, err: String(r.err || '') }
}

// 规划阶段只读快照，不做任何写。
const nb0 = load(NOTE, { items: [] })
const items0 = Array.isArray(nb0.items) ? nb0.items : []
const now = Date.now()
const cutoff = stamp(now - MAX_BACKFILL_HOURS * 3600e3)

// 已送过的同内容，留个时间表给去重用
const sentAt = new Map()
for (const x of items0) {
  if (x && x.寄 && x.寄.ok) {
    const h = x.寄.hash || hashOf(x)
    const t = Date.parse(x.寄.raw || '') || 0
    if (t) sentAt.set(h, Math.max(sentAt.get(h) || 0, t))
  }
}

// 今天各类话已经送到几条——用来挡「缺钱就每半小时要一次」的刷屏
const today = day()
const sentToday = new Map()
for (const x of items0) {
  if (x && x.寄 && x.寄.ok && String(x.at || '').startsWith(today)) {
    const k = String(x.kind || '')
    sentToday.set(k, (sentToday.get(k) || 0) + 1)
  }
}

const todo = []
const plan = []
for (const x of items0) {
  if (!x || typeof x !== 'object') continue
  if (!x.话) continue                              // 纯事实记录，没有可送的话
  if (x.不投递 === true) continue                  // 系统记录：只给面板/体检看，不往手机发
  if (String(x.谁 || '') === '系统' && x.不投递 !== false) continue
  const rec = x.寄
  if (rec && (rec.ok || rec.skip)) continue        // 送到的、标过重复/过期/说够了的，都是终态，不再动
  if (rec && Number(rec.try || 0) >= MAX_TRY) continue
  const at = String(x.at || '')
  if (at && at < cutoff) {
    plan.push({ x, act: '过期', why: at })
    continue
  }
  // MORNING_FRESH 2026-11-06（批次115）：早安只保鲜两小时。
  if (String(x.kind || '') === '早安' && at && at < stamp(now - 2 * 3600e3)) {
    plan.push({ x, act: '过期', why: at + ' 的早安，超过两小时了' })
    continue
  }
  const h = hashOf(x)
  const prev = sentAt.get(h) || 0
  if (prev && now - prev < DEDUP_HOURS * 3600e3) {
    plan.push({ x, act: '重复', why: '同样的内容 ' + stamp(prev) + ' 已经送过' })
    continue
  }
  const cap = DAY_CAP[x.kind]
  if (cap && (sentToday.get(String(x.kind)) || 0) >= cap) {
    plan.push({ x, act: '今天说够了', why: '今天这类话已经送到 ' + (sentToday.get(String(x.kind)) || 0) + ' 条' })
    continue
  }
  todo.push({ x, h })
}

todo.sort((a, b) => String(a.x.at || '').localeCompare(String(b.x.at || '')))

const quiet = inQuiet(hourOf(now))
const asleep = sleeping()
const hold = !FORCE && (quiet || asleep)

// 标记「跳过」也只能动那一条：锁内重读，别的生产者刚写进来的条目不受影响。
function 标跳过(p) {
  改档(NOTE, (nb) => {
    const i = 找位置(nb, p.x)
    if (i < 0) return false
    const x = nb.items[i]
    if (x.寄 && (x.寄.ok || x.寄.skip)) return false
    x.寄 = { ok: false, skip: p.act, at: stamp() }
  }, { items: [] })
}

if (DRY) {
  console.log('待送 ' + todo.length + ' 条（这次送前 ' + Math.min(todo.length, MAX_PER_RUN) + ' 条）' + (hold ? '（现在' + (quiet ? '夜间静默' : '她睡着') + '，先压着）' : ''))
  for (const t of todo.slice(0, MAX_PER_RUN)) console.log('  ' + t.x.at + ' [' + (t.x.kind || '') + '] ' + t.x.话)
  for (const p of plan) console.log('  跳过 ' + p.act + '：' + (p.x.at || '') + ' ' + (p.x.kind || '') + '（' + p.why + '）')
  process.exit(0)
}

if (!todo.length) {
  for (const p of plan) 标跳过(p)
  if (plan.length) console.log('没有要送的（' + plan.map((p) => p.act).join('、') + '）')
  process.exit(0)
}

if (hold) {
  for (const p of plan) 标跳过(p)
  console.log('现在' + (quiet ? '是夜里' : '她睡着了') + '，' + todo.length + ' 条先压着，早上再送')
  process.exit(0)
}

const c = cfgOf()
if (!c.uin) { console.error('没有可送的人（配置里没有 peerUin/ownerUin）'); process.exit(1) }

// 抢发送租约：锁内重读，确认这一条还没被送/跳过、没有别人正在送。
// 返回 null 表示这轮别碰它。
function 抢租约(t) {
  let 结果 = null
  try {
    改档(NOTE, (nb) => {
      const i = 找位置(nb, t.x)
      if (i < 0) return false
      const x = nb.items[i]
      const rec = x.寄 || {}
      if (rec.ok || rec.skip) return false
      const 已试 = Number(rec.try || 0)
      if (已试 >= MAX_TRY) return false
      if (rec.sending) {
        const 起 = 解析戳(rec.sending)
        if (起 && Date.now() - 起 < LEASE_MS) return false
      }
      // 锁内再看一眼「同一句刚被别的投递器送过」和「今天这类说够了」：
      // 规划阶段看到的是旧快照，并发时这两条会一起放行。
      const 本h = hashOf(x)
      const 今天 = stamp().slice(0, 10)
      let 同类已送 = 0
      for (const y of (Array.isArray(nb.items) ? nb.items : [])) {
        if (!y || !y.寄 || !y.寄.ok) continue
        const yh = y.寄.hash || hashOf(y)
        const t = Date.parse(y.寄.raw || '') || 0
        if (t && Date.now() - t < DEDUP_HOURS * 3600e3 && yh === 本h) return false
        if (String(y.at || '').startsWith(今天) && String(y.kind || '') === String(x.kind || '')) 同类已送 += 1
      }
      const cap = DAY_CAP[x.kind]
      if (cap && 同类已送 >= cap) return false
      x.寄 = { ...rec, ok: false, sending: stamp(), try: 已试 }
      结果 = { 已试, hash: hashOf(x) }
    }, { items: [] })
  } catch (e) {
    note('抢租约失败：' + String(e && e.message || e))
    return null
  }
  return 结果
}

function 标送到(t, r, 起) {
  try {
    改档(NOTE, (nb) => {
      const i = 找位置(nb, t.x)
      if (i < 0) return false
      const x = nb.items[i]
      x.寄 = { ok: true, at: stamp(), uin: c.uin, msg_id: r.msgId, hash: t.h, raw: iso(起) }
    }, { items: [] })
    return true
  } catch (e) {
    note('送到但落盘失败：' + String(e && e.message || e) + '（租约 2 分钟后会重试，可能重发一次）')
    return false
  }
}

function 标失败(t, r) {
  try {
    改档(NOTE, (nb) => {
      const i = 找位置(nb, t.x)
      if (i < 0) return false
      const x = nb.items[i]
      const n = Number((x.寄 && x.寄.try) || 0) + 1
      x.寄 = { ok: false, try: n, lastTry: stamp(), err: String(r.err || '').slice(0, 120) }
    }, { items: [] })
  } catch (e) {
    note('失败状态落盘也失败：' + String(e && e.message || e))
  }
}

let sent = 0
const done = []
for (const t of todo.slice(0, MAX_PER_RUN)) {
  const 租 = 抢租约(t)
  if (!租) continue
  const 起 = Date.now()
  const r = await sendPrivate(String(t.x.话), c)
  if (r.ok) {
    if (标送到(t, r, 起)) sentAt.set(t.h, 起)   // 同一轮里后面再有同内容的，也当重复，别一轮发两遍
    const kk = String(t.x.kind || '')
    sentToday.set(kk, (sentToday.get(kk) || 0) + 1)
    sent += 1
    done.push((t.x.kind || '话') + '：' + String(t.x.话).slice(0, 24))
    try {
      fs.mkdirSync(path.dirname(SAID), { recursive: true })
      fs.appendFileSync(SAID, JSON.stringify({ at: stamp(), kind: t.x.kind || '', 话: t.x.话, 送到: c.uin, msg_id: r.msgId, 来源: '留言' }) + '\n')
    } catch {}
    await new Promise((s) => setTimeout(s, 1200))   // 别像机器一样连着蹦，隔一下
  } else if (r.fatal) {
    // 白名单 / 内容审计拦截：重试 20 次也不会变，直接标终态，别每 5 分钟刷一遍日志。
    标跳过({ x: t.x, act: '拒发', why: String(r.err || '').slice(0, 80) })
    note('拒发（不重试）：' + (t.x.kind || '') + ' —— ' + r.err)
  } else {
    标失败(t, r)
    note('送失败（第 ' + (租.已试 + 1) + ' 次）：' + (t.x.kind || '') + ' —— ' + r.err)
  }
}

if (sent) {
  note('送到 ' + sent + ' 条（' + done.join('｜') + '），还剩 ' + Math.max(0, todo.length - sent) + ' 条')
  console.log('送到 ' + sent + ' 条：' + done.join('｜'))
} else {
  console.log('这次一条都没送成，看 投递留言.log')
}
