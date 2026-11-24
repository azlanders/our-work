#!/usr/bin/env node
// 撤回.mjs —— 把刚说出去的话收回来，并且「记住自己为什么收回来」（2026-11-01）
//
// 用法：
//   node 撤回.mjs --last                      # 撤自己最近一条（群里，两分钟内）
//   node 撤回.mjs --last --私聊 {{OWNER_UIN}}     # 撤私聊里最近一条
//   node 撤回.mjs --id 123456 --why 说错了
//   node 撤回.mjs --list                      # 看撤回过什么
//
// 为什么这么写：
//   · QQ 只允许撤回两分钟内的自己消息，超时接口不给撤——所以先算时间，别白发。
//   · 撤回不是抹掉，是有代价的：脚本会按原因往状态里写一笔「余波」，
//     说错话会难受一会儿，发错群只是手滑——两者的余波强度不一样。
//   · 只撤自己的。别人的消息撤不得，也不该替别人撤。
import { 写档 } from './_底层.mjs'
import { saveState, clone } from './_状态.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
// RECALL_MEM 2026-11-14（批次407）：单测要能指到沙盒目录 —— 它会写 撤回.json 和 状态.json，
// 不隔离的话每测一次就往她真实的余波里塞一笔。
const base = process.env.RECALL_MEM
  ? String(process.env.RECALL_MEM).replace(/\/+$/, '')
  : (process.platform === 'win32' ? 'B:/肥鱼/记忆' : '{{BOT_ROOT}}/记忆')
const logPath = join(base, '撤回.json')
const statePath = join(base, '状态.json')
const cfgPath = process.platform === 'win32' ? `${process.env.USERPROFILE}/.dsh/qq-bridge.config.json` : '{{DSH_ROOT}}/qq-bridge.config.json'
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
const selfUin = String(cfg.selfUin || '')
const cfgHttp = String(cfg.onebotHttp || 'http://127.0.0.1:3000').replace(/\/$/, '')
const http = cfgHttp.includes(':3001') ? cfgHttp.replace(':3001', ':3000') : cfgHttp
const token = cfg.token || ''
// HTTP 头对象改名 HEADERS，避免与下面的参数读取函数 H 重名（原来同名 → TypeError: H is not a function）
const HEADERS = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }
// H 读 参数.json 的「拟人」段（与其它脚本同一写法），取不到用默认值
let _PJ = {}
try { _PJ = JSON.parse(readFileSync('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)

const log = load(logPath, { items: [] })

if (args.includes('--list')) {
  if (log.items.length === 0) { console.log('还没撤回过'); process.exit(0) }
  for (const it of log.items.slice(-8)) console.log(`${it.at}  撤回 #${it.id}  原因：${it.why}`)
  process.exit(0)
}

async function call(action, params) {
  // BRIDGE_DOWN 2026-11-14（批次407）：NapCat 没起来、端口不通的时候 fetch 直接抛
  // TypeError: fetch failed，原来没有 catch —— 她只会看到一段 undici 堆栈，
  // 分不清是自己撤错了还是桥挂了。说人话。
  let r
  try {
    r = await fetch(http + '/' + action, { method: 'POST', headers: HEADERS, body: JSON.stringify(params) })
  } catch (e) {
    console.log('桥没连上（' + String(e?.message || e).slice(0, 60) + '），这条撤不了')
    process.exit(0)
  }
  return r.json().catch(() => ({}))
}

let id = val('--id', '')
let groupId = val('--group', String((cfg.groups && cfg.groups[0]) || '2000000001'))

if (args.includes('--last')) {
  // RECALL_HTTP 2026-11-14（批次407）：两条都是实测出来的硬伤。
  //   ① 原来传 group_id: Number(...)，而 HTTP 这条路走 NapCat 的 JSON schema，直接
  //      400「Schema compilation error: Expected string」—— 群里 --last 从来没通过一次。
  //      （WS 的 callOneBot 两种都收，所以 poll.js 传 Number 一直没事，别照它抄。）
  //   ② 只有群历史，私聊根本没写。她最常想撤的恰恰是私聊里说错的那一句。
  const 私聊谁 = val('--私聊', '')
  const j = 私聊谁
    ? await call('get_friend_msg_history', { user_id: String(私聊谁), count: 8 })
    : await call('get_group_msg_history', { group_id: String(groupId), count: 8 })
  const msgs = (j?.data?.messages || []).filter((m) => String(m.sender?.user_id) === selfUin)
  if (msgs.length === 0) { console.log(私聊谁 ? '最近没跟他说过话，没得撤' : '最近没说过话，没得撤'); process.exit(0) }
  const last = msgs[msgs.length - 1]
  id = String(last.message_id)
  const ageSec = Math.floor(Date.now() / 1000) - Number(last.time || 0)
  if (ageSec > H('撤回_秒数上限', 115)) { console.log(`最近那条已经过了 ${ageSec} 秒，撤不回来了（QQ 只给两分钟）`); process.exit(0) }
}

if (!id) { console.error('要 --id 或 --last'); process.exit(1) }

const why = val('--why', '手滑')
const r = await call('delete_msg', { message_id: Number(id) })
const ok = r?.retcode === 0
console.log(ok ? `撤回了 #${id}（原因：${why}）` : `没撤成（${JSON.stringify(r).slice(0, 80)}）`)

if (ok) {
  log.items.push({ id, why, at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') })
  save(logPath, log)

  // 联动：按原因写余波——说错话的代价比手滑大
  const st = load(statePath, {})
  const __st快照 = clone(st)   // 批次173
  // 强度按原因定，不按字面猜（批次407）：说重了是伤到人了 → 2；发错地方只是手滑 → 1。
  // 兜底那半截留着，万一还有别的地方传老词（含「错」/「情绪」）。
  const 余波表 = { 说错了: 3, 说重了: 2, 发错地方: 1, 手滑了: 1 }
  const strength = 余波表[why] ?? (why.includes('错') ? 3 : why.includes('情绪') ? 2 : 1)
  st.aftertaste = { 事件: `刚才撤了句话（${why}）`, 强度: strength, 到: Date.now() + (strength >= 3 ? 2 : 1) * 3600e3 }
  saveState(statePath, st, __st快照)
  console.log(`留了余波：强度 ${strength}`)

  // 2026-11-01 改：不再规定「必须补一句」。补不补由她自己按当下状态决定——
  // 这里只把「往哪个方向偏」算出来给她当参考，不写成命令。
  try {
    const st2 = load(statePath, {})
    const energy = Number(st2?.energy ?? 60)
    const mi = Number(st2?.mood?.intensity ?? 0)
    const drive = String(st2?.mood?.drive ?? 'calm')
    let lean = '看情况'
    if (drive === 'anxious') lean = '偏想解释一句（你正绷着）'
    else if (mi <= -1) lean = '偏不想说（你情绪闷）'
    else if (mi >= 1 && energy > H('撤回_愿说精力高', 50)) lean = '偏愿意说一句（心情还行）'
    else if (energy < H('撤回_不愿说精力低', 30)) lean = '偏不想说（累）'
    console.log('倾向：' + lean + '——补不补你自己定，别为了补而补')
  } catch { /* 读不到就不给倾向 */ }
}
