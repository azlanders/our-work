// 话题.mjs —— 2026-11-12（主人：对话系统她还要会自己思考找话题）
//
// 主动搭话原来只有两个来源：「回头说」到点项、手账里今天做过的事。
// 前者要她先记过，后者只是流水账 —— 她开口时手里没什么「想说的」，
// 于是要么报时间（「距上次说话 3 小时」），要么问一句「在干嘛」。
//
// 这里把散在各处的真材料收成一个池子：她自己记着想聊的、她最近想要的、
// 她冒过的念头、刚在群里看到的、正在听的歌。
//
// **只递材料，不替她写任何一句话** —— 原则跟 composeNudge 一致：事实归系统，话归她。
// 池子里的每条都会记「给过谁、什么时候」，同一对象 48 小时内不重复喂，
// 否则每次都是同一条，她只能反复说同一件事。
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'

const 记忆 = process.env.QQ_TOPIC_MEM || `${QQ_WS}/记忆`
const 用过的档 = 记忆 + '/话题用过的.json'
export const 想聊档 = 记忆 + '/想聊.json'

function 读(p, 缺) {
  try {
    if (!existsSync(p)) return 缺
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return v === null || v === undefined ? 缺 : v
  } catch { return 缺 }
}

function 写(p, v) {
  const tmp = p + '.tmp-' + process.pid
  writeFileSync(tmp, JSON.stringify(v, null, 2), 'utf8')
  renameSync(tmp, p)
}

function 掐(s, n = 60) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

function 京(ms) {
  try {
    return new Date(Number(ms) + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')
  } catch { return '' }
}

/** 她说过「回头再聊」、到点还没说的（跟 proactive 的 topicOf 同源，这里只作材料）。 */
function 回头说(now) {
  const j = 读(记忆 + '/回头说.json', { items: [] })
  const out = []
  for (const x of (Array.isArray(j.items) ? j.items : [])) {
    if (!x || x.done) continue
    const due = Number(x.due)
    if (!(due > 0) || due > now || now - due > 24 * 3600e3) continue
    const 文 = 掐(x.what, 60)
    if (文) out.push({ id: 'later:' + 文.slice(0, 40), 类: '你记着回头要说的', 文, 硬: true })
  }
  return out
}

/** 她自己写下来的、想聊但还没说的事（qq_later 的「想聊」）。 */
export function 想聊列表() {
  const j = 读(想聊档, { items: [] })
  return (Array.isArray(j.items) ? j.items : []).filter((x) => x && !x.done && 掐(x.what))
}

function 想聊材料(now) {
  const out = []
  for (const x of 想聊列表()) {
    const 文 = 掐(x.what, 60)
    const at = Number(x.at) || now
    // 想了超过三天的，还留着但只提一句「前几天想过」——话题也有保鲜期
    const 旧 = now - at > 3 * 86400e3
    out.push({
      id: 'want2:' + String(x.id || 文.slice(0, 24)),
      类: 旧 ? '你前几天记着想聊的' : '你自己记着想聊的',
      文: 文 + (旧 ? '（' + 京(at) + ' 记下的）' : ''),
    })
  }
  return out
}

/** 记忆/想要.json 的「当下想要」——没有欲望就没有主动性，这是燃料。 */
function 想要的() {
  const j = 读(记忆 + '/想要.json', {})
  const out = []
  for (const x of (Array.isArray(j['当下想要']) ? j['当下想要'] : [])) {
    if (!x || !掐(x.what)) continue
    const 劲 = Number(x.strength)
    const 文 = 掐(x.what, 50) + (Number.isFinite(劲) && 劲 >= 2 ? '（想要得挺厉害）' : '')
    out.push({ id: 'want:' + 掐(x.what, 40), 类: '你最近想要的', 文 })
  }
  return out
}

/** 最近 24 小时她自己冒出来的念头，去掉「什么也不做」这类空转。 */
function 念头(now) {
  const p = 记忆 + '/念头.jsonl'
  if (!existsSync(p)) return []
  let 线 = []
  try { 线 = readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-200) } catch { return [] }
  const 见 = new Set()
  const out = []
  for (const l of 线.reverse()) {
    let x
    try { x = JSON.parse(l) } catch { continue }
    const at = Date.parse(String(x?.at || '').replace(' ', 'T') + '+08:00')
    if (!Number.isFinite(at) || now - at > 24 * 3600e3 || at > now) continue
    const t = 掐(x['想到'], 40)
    if (!t || t.length < 4 || /什么也不做|发呆|没事干|等消息/.test(t)) continue
    if (见.has(t)) continue
    见.add(t)
    out.push({ id: 'idea:' + t.slice(0, 30), 类: '你自己冒过的念头', 文: t + '（' + 京(at) + '）' })
    if (out.length >= 3) break
  }
  return out
}

/** 刚在群里看到的真话（刷群落的），最多两条。 */
function 看到的(now) {
  const j = 读(记忆 + '/刷到的.json', {})
  const 条 = Array.isArray(j['条目']) ? j['条目'] : []
  const out = []
  // 同一个人只取一条：连发两句的，第二句多半是接着说同一件事，放进材料里就是同一件事说两遍
  const 见谁 = new Set()
  for (const x of 条.slice(-40).reverse()) {
    if (!x) continue
    const at = Date.parse(String(x['时'] || '').replace(' ', 'T') + '+08:00')
    if (!Number.isFinite(at) || now - at > 6 * 3600e3 || at > now) continue
    const 话 = 掐(x['话'], 40)
    if (!话 || 话.length < 4) continue
    if (/^\[(图片|表情|json|视频|语音)\]|^\[CQ:/.test(话)) continue
    const 谁 = 掐(x['谁'], 12) || '群友'
    if (见谁.has(谁)) continue
    见谁.add(谁)
    out.push({ id: 'seen:' + 话.slice(0, 24), 类: '你刚在群里看到的', 文: 谁 + '：「' + 话 + '」' })
    if (out.length >= 2) break
  }
  return out
}

/** 正在一起听的歌 —— 最有话题性的东西之一，尤其对方也在听。 */
function 在听() {
  const j = 读(记忆 + '/一起听.json', {})
  if (!j || j.active !== true) return []
  const 名 = 掐(j.name, 30)
  if (!名) return []
  const 人 = 掐(j.artist, 20)
  return [{ id: 'music:' + 名, 类: '你正在听', 文: '《' + 名 + '》' + (人 ? ' · ' + 人 : '') }]
}

/** 全池：按「她说过的 > 她想要的 > 她想的 > 她看到的 > 她在听的」排。 */
export function 话题池(now = Date.now()) {
  const out = []
  const 见 = new Set()
  let 源 = []
  try {
    源 = [
      ...回头说(now), ...想聊材料(now), ...想要的(),
      ...念头(now), ...看到的(now), ...在听(),
    ]
  } catch { return [] }
  for (const x of 源) {
    if (!x || !x.id || !x.文 || 见.has(x.id)) continue
    见.add(x.id)
    out.push(x)
  }
  return out
}

/** 去掉最近给过这个人的（默认 48 小时）。 */
export function 挑新鲜(池, 谁, now = Date.now(), 小时 = 48) {
  const 账 = 读(用过的档, {})
  const 线 = now - 小时 * 3600e3
  return (池 || []).filter((x) => !(Number(账[String(谁) + '|' + x.id]) > 线))
}

/** 记「这些材料已经给过他」。发出去之后才调 —— 没发就别记账，否则好材料白扣。 */
export function 记用过(谁, 池, now = Date.now()) {
  const 账 = 读(用过的档, {})
  for (const x of (池 || [])) if (x && x.id) 账[String(谁) + '|' + x.id] = now
  const 线 = now - 7 * 86400e3
  for (const k of Object.keys(账)) if (!(Number(账[k]) > 线)) delete 账[k]
  try { 写(用过的档, 账) } catch { /* 记不上不影响开口 */ }
}

export function 记回执话题(谁, ids, acceptedAt) {
  if (ids.length === 0) return true
  const 账 = existsSync(用过的档) ? JSON.parse(readFileSync(用过的档, 'utf8')) : {}
  if (!账 || typeof 账 !== 'object' || Array.isArray(账)) return false
  let changed = false
  for (const id of ids) {
    const key = 谁 + '|' + id
    if (Number(账[key] || 0) < acceptedAt) {
      账[key] = acceptedAt
      changed = true
    }
  }
  if (changed) 写(用过的档, 账)
  return true
}

/** 她记下一条「想聊」。同文重复记的合并成一条，不刷成十条一样的。 */
export function 加想聊(what, now = Date.now()) {
  const 文 = 掐(what, 120)
  if (!文) return null
  const j = 读(想聊档, { 说明: '她自己记下、想找机会跟人聊的事。', items: [] })
  const items = Array.isArray(j.items) ? j.items : []
  const 旧 = items.find((x) => !x.done && 掐(x.what) === 文)
  if (旧) return { ok: true, 合并: true, id: 旧.id }
  const id = 't' + now.toString(36) + Math.random().toString(36).slice(2, 6)
  items.push({ id, what: 文, at: now, done: false })
  j.items = items.slice(-50)
  写(想聊档, j)
  return { ok: true, 合并: false, id }
}

/** 划掉一条（她说聊过了/不想说了）。 */
export function 办完想聊(id) {
  const j = 读(想聊档, { items: [] })
  const items = Array.isArray(j.items) ? j.items : []
  const x = items.find((it) => it && String(it.id) === String(id))
  if (!x) return false
  x.done = true
  j.items = items
  写(想聊档, j)
  return true
}

// 死导出清理 2026-11-14（批次409）：想聊摘要() 全仓没人调 —— tool.js 只 import 了
// 加想聊 / 想聊列表 / 办完想聊 三个。要「摘要」的调用方自己 map 一下就行，
// 留着这个导出只会让闭环体检每周报一次。
