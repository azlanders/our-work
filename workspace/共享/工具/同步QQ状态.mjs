#!/usr/bin/env node
// 同步QQ状态.mjs —— 把「她在干什么、在哪里」写到 QQ 的在线状态上（2026-11-05）
//
// 用法：
//   node 同步QQ状态.mjs                  # 按当前状态同步（cron 每 5 分钟）
//   node 同步QQ状态.mjs --看             # 只看会写成什么，不调接口
//   node 同步QQ状态.mjs --设 "在窗边发呆"  # 她自己改一句（30 分钟内不被自动覆盖）
//   node 同步QQ状态.mjs --清             # 清掉自定义状态，回到普通在线
//
// 为什么这么写：
//   · 面板上写着「在便利店 逛贴吧」，QQ 上还是「在线」—— 两边对不上，她自己也说不上来。
//   · 平时不该一直手动：活动和位置变了，状态自己跟上。
//     但她刚写的那句 30 分钟内不许被顶掉 —— 那是她自己想说的，不是缓存。
//   · 只改文字状态，不动在线/离开类型：换类型会让好友列表以为她掉线了。
import { 写档 } from './_底层.mjs'
import { 睡着 } from './睡态.mjs'
// OCCUPY 2026-11-07（批次167）：在岗判据只在 占用.mjs 一份
import { 在岗的班, 在吃饭 } from './占用.mjs'
import { 说法, 是歇着 } from './在干嘛.mjs'
import fs from 'node:fs'
import path from 'node:path'

const DIR = process.env.STATUS_BASE || '{{BOT_ROOT}}'
const MEM = path.join(DIR, '记忆')
const STATE = path.join(MEM, 'qq状态.json')
// CFG_PATH_FIX 2026-11-24：原来只读 {{DSH_ROOT}}/qq-bridge.config.json，
  // 但本机那份是**另一实例的旧配置**（selfUin 对不上、onebotHttp 指向不存在的 3001）。
  // 现在按优先级探测：环境变量 > 实例专属目录 > 默认。
  // 判据是「selfUin 与本机 DSH_HOME 目录名对应的实例是否一致」——这里用文件存在性 + 端口可用来判定。
  const __cfg候选 = [
    process.env.QQ_BRIDGE_CFG,
    '{{DSH_ROOT}}/qq-bridge.config.json',
    '{{DSH_ROOT}}/qq-bridge.config.json',
  ].filter(Boolean)
  const CFG = __cfg候选.find((f) => { try { return fs.existsSync(f) } catch { return false } }) || '{{DSH_ROOT}}/qq-bridge.config.json'
const OMNI_CFG = process.env.STATUS_OMNI_CFG || '{{DSH_ROOT}}/fish-omni.json'

const MANUAL_HOLD = 30 * 60e3
const MAX_LEN = 20

const args = process.argv.slice(2)
const 用法 = [
  '用法：',
  '  node 同步QQ状态.mjs                  # 按当前状态同步（cron 每 5 分钟）',
  '  node 同步QQ状态.mjs --看             # 只看会写成什么，不调接口、不写状态',
  '  node 同步QQ状态.mjs --设 "在窗边坐着"  # 她自己改一句（30 分钟内不被自动覆盖）',
  '  node 同步QQ状态.mjs --清             # 清掉自定义状态，回到普通在线',
  '  node 同步QQ状态.mjs --help           # 只打印用法，不调接口、不写状态',
].join('\n')

// 参数守卫：--help/拼错/缺值必须在读状态和调 set_diy_online_status 之前退出。
// 裸跑自动同步、--看/--清/--设 都是原有入口，语义不变。
const 带值参数 = new Set(['--设'])
const 开关参数 = new Set(['--看', '--清', '--help', '-h'])
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

const DRY = args.includes('--看')
const CLEAR = args.includes('--清')
const SET_IDX = args.indexOf('--设')
const SET_TEXT = SET_IDX >= 0 ? String(args[SET_IDX + 1] || '').trim() : ''

const load = (p, fb) => { try { const v = JSON.parse(fs.readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v : fb } catch { return fb } }
const save = (p, o) => 写档(p, o)
const stamp = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function cfgOf() {
  const c = load(CFG, {})
  const raw = String(process.env.ONEBOT_API || c.onebotHttp || 'http://127.0.0.1:3000/').replace(/\/$/, '')
  return { http: raw.replace(/:3001$/, ':3000'), token: c.token || '' }
}

/**
 * 协议端（NapCat）在这台机器上有没有起来。
 *
 * PROTOCOL_OPTIONAL 2026-11-24：原来协议端没运行时，每次调用都 fetch 失败 →
 * exit 1 → 心跳判「任务失败」。而{{ALT_BOT_DISPLAY}} VPS 上 napcat.service 与 onebot-proxy.service
 * 本来就是 inactive(dead)（QQ 协议端只跑在{{BOT_DISPLAY}}那台），于是**每 2 分钟失败一次，
 * 一天 459 次**，把心跳日志和连败账全刷满，真失败完全看不见。
 *
 * 现在先看端口：没有进程在听 = 这台机器不接 QQ → 记一行说明，**退出码 0**（不算失败）。
 * cron 每 2 分钟跑一次也不会有噪音；协议端起来后自动恢复正常逻辑。
 */
function 端口在听(p) {
  const hex = p.toString(16).toUpperCase().padStart(4, '0')
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const txt = String(fs.readFileSync(f, 'utf8'))
      for (const line of txt.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c.length < 4) continue
        if ((c[1] || '').endsWith(':' + hex) && c[3] === '0A') return true
      }
    } catch { /* 读不到就跳过 */ }
  }
  return false
}

function 协议端在跑() {
  const http = cfgOf().http
  const m = /:([0-9]{2,5})(\/|$)/.exec(http)
  const p = m ? Number(m[1]) : 3000
  return 端口在听(p)
}

async function call(action, params) {
  const c = cfgOf()
  try {
    const r = await fetch(c.http + '/' + action, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(c.token ? { Authorization: 'Bearer ' + c.token } : {}) },
      body: JSON.stringify(params || {}),
    })
    const j = await r.json().catch(() => ({}))
    // DIAG 2026-11-14（批次483）：原来只留 `data || message`，retcode 和 HTTP 状态全丢了 ——
    // 20:24~20:38 连挂 8 次，日志里只有一句「设置在线状态失败」，看不出是限流、断线还是参数问题。
    // 现在把 retcode 和 http 一起带上，下次再挂能直接定性。
    const 码 = `retcode=${j && j.retcode != null ? j.retcode : '?'} http=${r.status}`
    const 原话 = String((j && j.data) || (j && j.message) || '') || '无返回体'
    return { ok: j && j.retcode === 0, msg: `${原话}（${码}）` }
  } catch (e) {
    return { ok: false, msg: String(e && e.message || e) }
  }
}

const setDiy = (text) => call('set_diy_online_status', { face_id: 0, face_type: 1, wording: text })

// 活动 → 外面看得懂的说法。批次170 搬到 在干嘛.mjs（它已经是 state 的唯一判据了，
// 说法表放在这里等于第四份「state → 什么」的字典）。

function 当前文案() {
  const aut = load(path.join(MEM, '自主.json'), {})
  const a = load(path.join(MEM, '资产.json'), { 位置: '家' })
  const sleep = load(path.join(MEM, '睡眠.json'), {})
  if (睡着(MEM)) {   // 批次164：判据在 睡态.mjs
    // SLEEP_PLACE 2026-11-06（批次107）：睡着也得说在哪睡。
    // 光写「睡着了」会被读成「在床上」，而她可能真在便利店趴着。
    const 位 = String(a.位置 || '家')
    return 位 === '家' ? '睡着了' : '在' + 位 + '睡着了'
  }
  const 位 = String(a.位置 || '家')
  const t = a.在途
  if (t && Number(t.arriveAt) > Date.now()) return '在去' + String(t.to || '') + '的路上'
  const st = String(aut.state || '待命')
  try {
    const __omni开关 = load(OMNI_CFG, {})
      const 歌 = (__omni开关?.一起听?.开启 === false) ? null : load(path.join(MEM, '一起听.json'), null)
    if (歌 && 歌.ok && 歌.name && 歌.playTime && (Date.now() - Number(歌.playTime)) <= Math.max(180e3, ((Number(歌.durationSec) || 240) * 1000) + 60e3) && (st === '待命' || 是歇着(st))) {
      return '一起听《' + String(歌.name).slice(0, 12) + '》'
    }
  } catch (_err) { console.error('[同步QQ状态]', _err?.message || _err) }
  if (st === '待命') return '在' + 位
  // WORK_WORD 2026-11-06（批次146）：上班不写「打工」—— 那像系统标签，不像她的状态。
  // 实测同步出来是「在便利店，打工」。改成「在便利店上夜班」，带着是哪份活。
  if (st === '打工') {
    let b = null
    try {
      // 批次167：判据在 占用.mjs。原来这里连起止时段都不看 ——
      // 班次表里只要留着一条「在岗」，哪怕早过点了，她签名也一直写「在XX上夜班」。
      b = 在岗的班(MEM)
    } catch { /* 读不到就当不在岗 */ }
    // 批次172：不在班上就不说「上班」。原来不管 b 有没有值都往下拼，
    // 实测 06:00 她已经到家、班次 06:00 才到点，签名成了「在家上便利店夜班」。
    if (b) {
      const 活 = String(b.活 || '')
      // 「便利店夜班」在便利店 → 只剩「夜班」，别写成「在便利店上便利店夜班」
      const 短 = 活 && 位 && 活.startsWith(位) ? 活.slice(位.length) : 活
      return '在' + 位 + '上' + (短 || '班')
    }
    // 班还没开始 / 人已经离开店里 —— 她就是个在{位}的人，别替她编在上班。
    return '在' + 位
  }
  const 饭 = 在吃饭(MEM)
  if (饭) return '在' + String(饭.在哪 || 位) + '吃' + String(饭.吃啥 || '东西')
  // 自主.state 记录的是最近动作，不是当前占用；过期/失败的吃饭动作不能当作正在进餐。
  if (st === '吃点东西' || st === '吃饭') return '在' + 位
  return '在' + 位 + '，' + 说法(st)
}

const 修短 = (t) => (String(t || '').length > MAX_LEN ? String(t).slice(0, MAX_LEN - 1) + '…' : String(t || ''))

// SHELF_LIFE 2026-11-05（批次85）：判断「她是不是已经离开写那句话的地方了」。
// 位置或在途状态变了，她自己写的那句就不再成立，不必等满 30 分钟。
function 位置快照() {
  const a = load(path.join(MEM, '资产.json'), { 位置: '家' })
  const t = a.在途
  return { 位: String(a.位置 || '家'), 在途: !!(t && Number(t.arriveAt) > Date.now()) }
}

const cur = load(STATE, {})

if (CLEAR) {
  if (DRY) { console.log('会清掉自定义状态'); process.exit(0) }
  const c = cfgOf()
  const r = await call('set_online_status', { status: 10, ext_status: 0, battery_status: 100 })
  save(STATE, { wording: '', at: stamp(), source: 'clear', manualUntil: 0 })
  console.log(r.ok ? '清掉了，回到在线' : ('没清成：' + r.msg))
  process.exit(r.ok ? 0 : 1)
}

// PROTOCOL_OPTIONAL 2026-11-24：协议端不在本机 → 直接成功退出，不打网络。
if (!协议端在跑()) {
  console.log('协议端（NapCat）未在本机运行，跳过状态同步（不是失败）')
  process.exit(0)
}


if (SET_TEXT !== '') {
  const text = 修短(SET_TEXT)
  if (DRY) { console.log('会写成：' + text); process.exit(0) }
  const r = await setDiy(text)
  if (!r.ok) { console.error('没写成：' + r.msg); process.exit(1) }
  const 快 = 位置快照()
  save(STATE, { wording: text, at: stamp(), source: 'self', manualUntil: Date.now() + MANUAL_HOLD, 位: 快.位, 在途: 快.在途 })
  console.log('状态改成了「' + text + '」')
  process.exit(0)
}

// —— 自动 ——
// 她刚自己写的那句，30 分钟内不被顶掉。**但她换了地方就不算** ——
// 「到家了，在擦头发」在她走出家门那一刻就过期了，再挂半小时就是撒谎。
// 老记录（批次85 之前写的）没有 位 字段，按「没动」处理，行为跟以前一样。
const 现 = 位置快照()
const 动过 = cur.位 !== undefined && (String(cur.位) !== 现.位 || !!cur.在途 !== 现.在途)
if (Number(cur.manualUntil || 0) > Date.now() && !动过) {
  const left = Math.round((Number(cur.manualUntil) - Date.now()) / 60e3)
  console.log('她刚自己写过「' + String(cur.wording || '') + '」，还有 ' + left + ' 分钟才轮到自动同步')
  process.exit(0)
}
if (Number(cur.manualUntil || 0) > Date.now() && 动过) {
  console.log('她从' + String(cur.位) + '动到' + 现.位 + '了，之前那句「' + String(cur.wording || '') + '」不再成立，直接同步')
}

const text = 修短(当前文案())
if (cur.wording === text && cur.source === 'auto') {
  process.exit(0)   // 没变，不重复调接口
}
if (DRY) { console.log('会写成：' + text); process.exit(0) }

const r = await setDiy(text)
if (!r.ok) { console.error('没写成：' + r.msg); process.exit(1) }
save(STATE, { wording: text, at: stamp(), source: 'auto', manualUntil: 0, 位: 现.位, 在途: 现.在途 })
console.log('状态同步成「' + text + '」')
