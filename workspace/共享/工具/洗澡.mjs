// 洗澡.mjs —— 她的清洁度与洗澡（2026-11-05，主人要求「她要有洗澡系统」）
//
// 2026-11-05 批次89：从「一按就洗完」改成有过程。
//   原来 --洗 是瞬时的：进去就出来，清洁 92，面板上看不出她刚才在浴室里待过；
//   主人要的是「进浴室 20~35 分钟、出来头发是湿的、这期间状态是洗澡」。
//
// 用法：
//   node 洗澡.mjs --开始 [--到 92] [--为什么 打工回来]   # 进浴室（在家/澡堂、醒着、没在洗）
//   node 洗澡.mjs --完                                    # 提前出来（按现在结算）
//   node 洗澡.mjs --洗   [--为什么 ...]                   # 立刻洗完（手动；等于开始+马上结算）
//   node 洗澡.mjs --看看                                  # 多干净、多久没洗、在不在洗
//   node 洗澡.mjs --tick                                  # 变脏 + 到点自动结算（cron 每 10 分钟）
//
// 为什么这么写：
//   · 脏不脏要有个数，清洁 0-100；起床约 88，一天下来自然掉。
//   · 掉得看情况：在家闲着慢，出门、打工、出汗快；睡着不掉。
//   · 洗澡只在「家」或「澡堂」，不然她能在街上洗 —— 先让她到家。
//   · 洗多久由清洁差算，不是写死的：越脏洗得越久；澡堂泡一泡多待 6 分钟。
//   · 洗完不立刻「干」：头发湿着 25 分钟，面板和对话侧都读得到。
//   · 记一笔到 资产.记录（手账/日记会写进去）—— 日志里不能只有「买了什么」。
import { 写档, 改档 } from './_底层.mjs'
import { saveState, clone } from './_状态.mjs'
import { 睡着 } from './睡态.mjs'
import { 起 as 起自主 } from './自主状态.mjs'
import fs from 'node:fs'
import path from 'node:path'
// ENERGY_SYNC 2026-11-06（批次123）：洗完澡的精力原来用 (体力+情绪)/2 覆盖，
// 和其余四处的木桶公式打架 —— 用当前值算，洗完精力会从 13 跳到 33。
import { 精力 } from './恢复目标.mjs'

const DIR = '{{BOT_ROOT}}'
const MEM = process.env.QQ_AUTONOMY_MEM || path.join(DIR, '记忆')
const HY = path.join(MEM, '卫生.json')
const ST = path.join(MEM, '状态.json')
const AU = path.join(MEM, '自主.json')
const AS = path.join(MEM, '资产.json')

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const save = (p, o) => 写档(p, o, { 容错: true })
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const parseBj = (s) => {
  const t = Date.parse(String(s || '').replace(' ', 'T') + ':00+08:00')
  return Number.isFinite(t) ? t : 0
}
const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || 0))
// SHOWER_TICK 2026-11-16（批次549）：清洁度留两位小数。
// 原来一律 `Math.round(x*10)/10`（0.1 精度），而心跳改成 1 分钟后每次只掉 1.1/60 ≈ 0.018，
// 四舍五入成 0.0 —— 那样清洁度会永远不动。两位够用（一天最多掉 50 点，0.01 精度是 5000 格）。
const 两位 = (n) => Math.round(clamp(n, 0, 100) * 100) / 100
const 有人说 = (s) => String(s == null ? '' : s).trim()

const args = process.argv.slice(2)
const 卫生 = load(HY, { 清洁: 86, 上次洗: '', 次数: 0, 上次更新: '' })
const 状态 = load(ST, {})
// SNAP_FIX 2026-11-12：洗完了() 里 saveState(ST, 状态, __stSnap) 用的快照。原来没定义，
// 一到「洗完」就 ReferenceError 退出，卫生.json 存不回去，洗澡中 永远清不掉。
const __stSnap = clone(状态)
const 自主 = load(AU, {})
const 位置 = String(load(AS, {}).位置 || '家')

if (!Number.isFinite(Number(卫生.清洁))) 卫生.清洁 = 86

const 睡 = 睡着(MEM)   // 批次164：判据在 睡态.mjs

// 每小时自然掉多少：家里慢、外面快、睡着不掉
function 每小时掉多少() {
  if (睡) return 0
  const 在干什么 = String(自主.state || '')
  if (位置 !== '家' && 位置 !== '澡堂') {
    if (/打工/.test(在干什么)) return 3.2
    if (/走|逛/.test(在干什么)) return 2.2
    return 1.8
  }
  if (/打工|收拾|干活/.test(在干什么)) return 2.4
  return 1.1
}

/**
 * 洗澡进行到哪一步了。没在洗返回 null。
 *
 * SHOWER_PROGRESS 2026-11-16（批次549）：主人要求「洗的时候每分钟更新一次清洁度」。
 * 原来的做法是**洗完一次性跳**：进浴室那一刻 清洁 15.2，出来直接 92 —— 中间十几二十分钟
 * 面板上一直是 15.2，看不出她正在洗；而且这段时间 `补衰减` 还在按「在家闲着 1.1/h」继续往下扣。
 *
 * 现在按**时间线性插值**：洗前 15.2 → 洗到 92，进浴室 20 分钟就每分钟涨（92-15.2)/20 ≈ 3.84。
 * 算的是「按真实经过时间」，所以哪怕某次心跳晚了／漏了，读出来的值也是对的。
 */
function 洗澡进度(now = Date.now()) {
  const 洗 = 卫生.洗澡中
  if (!洗 || typeof 洗 !== 'object') return null
  // MS_FIELD 2026-11-16（批次549）：`开始`/`结束` 只有分钟精度（`bj()` 截断），
  // 直接拿它们算比例最多偏 1 分钟 —— 20 分钟的澡就是 5%，实测「洗到一半」算出 57 而不是 53.6。
  // 所以另存一份毫秒。**`结束` 的字符串格式一个字不动**：自主行动.mjs:356 用
  // `String(结束).replace(' ','T') + ':00+08:00'` 解析它，加秒会让那边整条失效。
  const 起 = Number.isFinite(Number(洗.开始毫秒)) ? Number(洗.开始毫秒) : parseBj(洗.开始)
  const 止 = Number.isFinite(Number(洗.结束毫秒)) ? Number(洗.结束毫秒) : parseBj(洗.结束)
  if (!Number.isFinite(起) || !Number.isFinite(止) || 止 <= 起) return null
  const 到 = clamp(Number(洗.到 ?? 92), 0, 100)
  // 老记录没有「洗前」：拿当前值当起点（等于从这一刻开始算，不会跳变）
  const 洗前 = Number.isFinite(Number(洗.洗前)) ? clamp(Number(洗.洗前), 0, 100) : clamp(Number(卫生.清洁), 0, 100)
  const 比例 = clamp((now - 起) / (止 - 起), 0, 1)
  return { 起, 止, 到, 洗前, 比例, 现在: 洗前 + (到 - 洗前) * 比例 }
}

function 补衰减() {
  const now = Date.now()
  // 正在洗澡：清洁度按进度往上走，**不按小时往下掉**（人在水里，还往下扣就荒唐了）
  const 进 = 洗澡进度(now)
  if (进) {
    卫生.清洁 = 两位(进.现在)
    卫生.上次更新 = bj(now)
    return 0
  }
  const last = 卫生.上次更新 ? parseBj(卫生.上次更新) : now
  const 小时 = Math.max(0, (now - last) / 3600e3)
  if (!Number.isFinite(小时) || 小时 <= 0) { 卫生.上次更新 = bj(now); return 0 }
  const 掉 = Math.min(60, 小时 * 每小时掉多少())
  卫生.清洁 = 两位(Number(卫生.清洁) - 掉)
  卫生.上次更新 = bj(now)
  return Math.round(掉 * 10) / 10
}

function 记一笔(what) {
  // 手账/日记读的是 资产.记录。原来洗澡什么都不留，日志里只有「买了什么」。
  // 批次578（P0-2 残留）：启动时那份 资产 是旧副本，锁外整档写回会盖掉并发扣的钱。
  改档(AS, (a) => {
    a.记录 = Array.isArray(a.记录) ? a.记录 : []
    a.记录.push({ at: bj(), what })
    if (a.记录.length > 200) a.记录 = a.记录.slice(-200)
  }, { 记录: [] })
}

// SHOWER_STATE 2026-11-05（批次101）：洗澡以前只写 卫生.json，自主.json 还停在上一件事上 ——
// 面板和对话侧说她在「吃点东西」，人却在浴室里。两套状态各说各的，她自己也对不上。
// 进浴室就把自主状态改成「洗澡」，doneAt 写出来的时刻（跟 自主行动 挑到洗澡时同一个写法）。
// 这里重新读一遍 自主.json，不用启动时那份：中间可能已被 自主行动 的 tick 改过。
function 记自主洗澡(结束, 因) {
  try {
    const end = parseBj(结束)
    // 批次169：原来这里裸 writeFileSync（半截 JSON 风险）且锁外整份覆盖。
    起自主(MEM, {
      state: '洗澡',
      form: '线下',
      place: 位置,
      doneAt: Number.isFinite(end) ? end : 0,
      last: { at: bj(), what: '洗澡', note: '在' + 位置 + '洗澡' + (因 ? '（' + 因 + '）' : ''), feel: '', feelKind: '' },
    })
  } catch (e) { /* 写不进去不影响洗澡本身 */ }
}

function 洗完了(说明 = '') {
  const 洗 = 卫生.洗澡中
  if (!洗) return ''
  const 到 = clamp(Number(洗.到 ?? 92), 0, 100)
  补衰减()
  // 到点就是「到」，不受插值进度影响（可能有几次心跳漏了）
  卫生.清洁 = 两位(到)
  卫生.上次洗 = bj()
  卫生.次数 = Number(卫生.次数 || 0) + 1
  // 头发不会瞬间干：25 分钟内面板上都写「头发还湿着」。
  卫生.头发湿到 = bj(Date.now() + 25 * 60e3)
  delete 卫生.洗澡中

  // 洗个澡掉点体力、涨点心情（热水的舒服）；在澡堂泡的，体力掉得少、心情涨得多。
  const 澡堂 = String(洗.在哪 || '') === '澡堂'
  状态.layers = (状态.layers && typeof 状态.layers === 'object') ? 状态.layers : {}
  const 掉力 = 澡堂 ? 1 : 2
  const 涨情 = 澡堂 ? 3 : 2
  状态.layers.physical = Math.round(clamp(Number(状态.layers.physical || 50) - 掉力, 0, 100) * 10) / 10
  状态.layers.emotional = Math.round(clamp(Number(状态.layers.emotional || 50) + 涨情, 0, 100) * 10) / 10
  状态.energy = 精力(状态.layers) // ENERGY_SYNC：跟其余四处同一个木桶公式，不再拿两个数平均
  saveState(ST, 状态, __stSnap)

  记一笔(澡堂 ? '在澡堂泡了个澡' : '洗了个澡')
  save(HY, 卫生)
  return `洗完了，清洁 ${卫生.清洁}/100` + (说明 ? `（${说明}）` : '') +
    `，体力 ${状态.layers.physical}、情绪 ${状态.layers.emotional}`
}

function 多久没洗() {
  const t = 卫生.上次洗 ? parseBj(卫生.上次洗) : 0
  if (!t) return null
  return Math.max(0, Math.round((Date.now() - t) / 60e3))
}

if (args.includes('--看看')) {
  const 掉 = 补衰减()
  save(HY, 卫生)
  const 分 = 多久没洗()
  const 洗 = 卫生.洗澡中
  console.log(`清洁 ${卫生.清洁}/100（刚掉了 ${掉}）`)
  console.log(分 === null ? '还没正式洗过澡' : `上次洗澡 ${卫生.上次洗}（${分 < 60 ? 分 + ' 分钟' : Math.round(分 / 60) + ' 小时'}前）`)
  if (洗) {
    const 剩 = Math.max(0, Math.ceil((parseBj(洗.结束) - Date.now()) / 60e3))
    const 进 = 洗澡进度()
    console.log(进
      ? `正在${洗.在哪 || '家'}洗澡，还有 ${剩} 分钟 —— 现在 ${卫生.清洁}/100（${Math.round(进.比例 * 100)}%），洗完到 ${洗.到}`
      : `正在${洗.在哪 || '家'}洗澡，还有 ${剩} 分钟（洗到 ${洗.到}）`)
  }
  if (卫生.头发湿到 && parseBj(卫生.头发湿到) > Date.now()) console.log('头发还湿着')
  console.log(`这会儿在${位置}，${卫生.清洁 < 45 ? '身上该洗了' : 卫生.清洁 < 70 ? '有点黏' : '还算清爽'}`)
  process.exit(0)
}

if (args.includes('--tick')) {
  const 掉 = 补衰减()
  const 进 = 洗澡进度()
  let 句 = ''
  if (卫生.洗澡中 && Date.now() >= parseBj(卫生.洗澡中.结束)) 句 = 洗完了('到点了')
  else if (进) {
    const 剩 = Math.max(0, Math.ceil((进.止 - Date.now()) / 60e3))
    句 = `洗到 ${卫生.清洁}/100（${Math.round(进.比例 * 100)}%，还有 ${剩} 分钟）`
  }
  save(HY, 卫生)
  // QUIET_TICK：心跳从 10 分钟改成 1 分钟后，不能每分钟往 日常.log 写一行
  // 「清洁 15.2/100（掉 0）」—— 一天 1440 行会把日志刷满。
  // 洗澡中每分钟都报（那是有信息量的进度）；不洗的时候只有真掉了 0.1 以上才吭声。
  if (句) console.log(句)
  else if (掉 >= 0.1) console.log(`清洁 ${卫生.清洁}/100（掉 ${掉}）`)
  process.exit(0)
}

if (args.includes('--完')) {
  补衰减()
  const 句 = 洗完了('提前出来')
  save(HY, 卫生)
  console.log(句 || '这会儿没在洗澡')
  process.exit(0)
}

if (args.includes('--开始') || args.includes('--洗')) {
  const 立刻 = args.includes('--洗')
  if (卫生.洗澡中) { console.log('已经在洗了，别重复进浴室'); process.exit(0) }
  if (!['家', '澡堂'].includes(位置)) { console.log(`人在${位置}，得先回去才能洗`); process.exit(0) }
  if (睡 && !立刻) { console.log('睡着呢，醒了再洗'); process.exit(0) }
  补衰减()
  const 因 = 有人说(args.indexOf('--为什么') >= 0 ? args[args.indexOf('--为什么') + 1] : '')
  // 洗到多干净由她自己说，不说就按「好好洗了一次」算 92。
  const 到 = Math.round(clamp(args.indexOf('--到') >= 0 ? args[args.indexOf('--到') + 1] : (args.indexOf('到') >= 0 ? args[args.indexOf('到') + 1] : 92), 40, 100) * 10) / 10
  const 差 = Math.max(4, 到 - Number(卫生.清洁))
  // 时长跟「有多脏」走：15 分钟起，最多 45 分钟；澡堂泡一泡多待 6 分钟。
  let 分钟 = 14 + 差 * 0.35 + Math.random() * 6 + (位置 === '澡堂' ? 6 : 0)
  分钟 = Math.round(clamp(分钟, 15, 45))
  const 结束 = bj(Date.now() + 分钟 * 60e3)

  if (立刻) {
    卫生.洗澡中 = { 开始: bj(), 开始毫秒: Date.now(), 结束, 结束毫秒: Date.now() + 分钟 * 60e3, 到, 洗前: 两位(卫生.清洁), 为什么: 因, 在哪: 位置 }
    const 句 = 洗完了('手动')
    save(HY, 卫生)
    console.log(句)
    process.exit(0)
  }

  // 洗前 = 进浴室那一刻的清洁度。进度插值要用它当起点，不然第一分钟就会跳。
  卫生.洗澡中 = { 开始: bj(), 开始毫秒: Date.now(), 结束, 结束毫秒: Date.now() + 分钟 * 60e3, 到, 洗前: 两位(卫生.清洁), 为什么: 因, 在哪: 位置 }
  save(HY, 卫生)
  记自主洗澡(结束, 因)
  console.log(`开始洗了，预计 ${分钟} 分钟（清洁 ${卫生.清洁} → ${到}，${结束} 出来）` + (因 ? ` · ${因}` : ''))
  process.exit(0)
}

console.log('用法：--开始 [--到 92] [--为什么 ...] / --完 / --洗 / --看看 / --tick')
