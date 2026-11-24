// 留言板.mjs —— 一块大家一起贴的板子（批次228，2026-11-08）
//
// 数据：共享/留言板/<YYYY-MM-DD>.json
//   { date, notes: [ { id, by, color, x, y, w, h, text, at, comments:[{id,by,text,at}] } ], updated }
//
// 规矩（主人定的）：
//   · 全部人看同一块板；便签自己选颜色、自己拖位置、确认才贴；
//   · **不能重叠**（她的回复除外：可以稍微压一点边，但不能挡字）；
//   · 便签可以点开看大图，右边可以给别人的便签留言；
//   · 按日期切换。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { 加锁 } from './_锁.mjs'

const 根 = process.env.BOARD_DIR || '{{BOT_ROOT}}/共享/留言板'
// BOARD_NAME 2026-11-24：原来这里写死两个实例名来判断「她自己的便签」。
// 模板里不能出现实例名，改成从环境变量读（BOARD_BOT_NAMES 逗号分隔，默认 {{BOT_DISPLAY}}）。
// 运行时若某台实例要额外认几个别名，设环境变量即可，不用改代码。
const 自己名 = String(process.env.BOARD_BOT_NAMES || '{{BOT_DISPLAY}}').split(',').map(s => s.trim()).filter(Boolean)
const 已读P = process.env.BOARD_READ || '{{BOT_ROOT}}/记忆/留言板已读.json'

export const 颜色 = ['yellow', 'pink', 'blue', 'green', 'orange', 'purple']
const 色值 = {
  yellow: '#fdf3b0', pink: '#fbd3e0', blue: '#cfe6fb',
  green: '#d6f2d0', orange: '#ffe0b8', purple: '#e3d7fb',
}
const 天 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)
const 北京 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 夹 = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0))
const id = (p) => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
const 图片上限 = 900 * 1024
const 图片号 = /^[a-f0-9-]{36}$/
const 图片路 = (图号) => path.join(根, '照片', 图号 + '.jpg')

function 位置(值 = {}) {
  const w = 夹(值?.w ?? 48, 20, 96)
  const h = 夹(值?.h ?? 62, 20, 96)
  return { x: 夹(值?.x ?? 48, 0, 100 - w), y: 夹(值?.y ?? 8, 0, 100 - h), w, h }
}

function 读上传照片(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(图片上限 / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null
  const 图 = Buffer.from(data, 'base64')
  if (图.length < 16 || 图.length > 图片上限 || 图.readUInt16BE(0) !== 0xffd8 || 图.readUInt16BE(图.length - 2) !== 0xffd9) return null
  // 只收浏览器重编码的 JPEG；在读取尺寸前检验每段边界，禁止超大画布。
  for (let 起 = 2; 起 + 9 < 图.length;) {
    if (图[起] !== 0xff) return null
    const 标记 = 图[起 + 1], 段长 = 图.readUInt16BE(起 + 2)
    if (段长 < 2 || 起 + 2 + 段长 > 图.length) return null
    if (标记 === 0xc0 || 标记 === 0xc2) {
      const 高 = 图.readUInt16BE(起 + 5), 宽 = 图.readUInt16BE(起 + 7)
      return 段长 >= 11 && 宽 > 0 && 高 > 0 && 宽 <= 1800 && 高 <= 1800 ? 图 : null
    }
    if (标记 === 0xda) return null
    起 += 2 + 段长
  }
  return null
}

function 存照片(图) {
  const 图号 = randomUUID()
  fs.mkdirSync(path.dirname(图片路(图号)), { recursive: true, mode: 0o700 })
  fs.writeFileSync(图片路(图号), 图, { flag: 'wx', mode: 0o600 })
  return 图号
}

function 清照片(图号) {
  if (!图片号.test(图号 || '')) return
  try { fs.unlinkSync(图片路(图号)) } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[留言板] 清理照片失败：' + error.code)
  }
}

export function 取照片(date, 图号) {
  if (!图片号.test(图号 || '') || !读(date).notes.some(签 => 签.photo?.id === 图号)) return null
  try { return fs.readFileSync(图片路(图号)) } catch (error) {
    if (error.code !== 'ENOENT') console.warn('[留言板] 读取照片失败：' + error.code)
    return null
  }
}

function 路(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) throw new Error('日期不对')
  return path.join(根, String(date) + '.json')
}

export function 读(date) {
  try {
    const d = JSON.parse(fs.readFileSync(路(date), 'utf8'))
    d.notes = Array.isArray(d.notes) ? d.notes : []
    return d
  } catch { return { date: String(date), notes: [], updated: '' } }
}

function 存(date, d) {
  fs.mkdirSync(根, { recursive: true })
  d.date = String(date)
  d.updated = 北京()
  const p = 路(date)
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), 'utf8')
  fs.renameSync(tmp, p)
  return d
}

/** 两个矩形相不相交（百分比坐标，留 1.2 的呼吸）。 */
function 撞(a, b, 让 = 1.2) {
  return !(a.x + a.w + 让 <= b.x || b.x + b.w + 让 <= a.x
    || a.y + a.h + 让 <= b.y || b.y + b.h + 让 <= a.y)
}

/** 找一块能放下 w×h 的空位（从目标点向外找，找不到就返回 null）。 */
export function 找位(date, w, h, 想 = { x: 10, y: 10 }, 允许微压 = false) {
  const d = 读(date)
  // 主人规矩：她的回复「可以稍微重叠点，但不能挡字」。
  // 只允许跟**她自己的**便签轻微压边（交叠 <= 18%），别人的一张都不压。
  const 交叠 = (a, b) => {
    const iw = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
    const ih = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
    return iw > 0 && ih > 0 ? iw * ih : 0
  }
  const 撞到 = (r, n) => {
    if (!撞(r, n, 0)) return false
    if (允许微压 && 自己名.includes(String(n.by || ''))) return 交叠(r, n) > Math.min(r.w * r.h, n.w * n.h) * 0.18
    return true
  }
  const 占 = d.notes
  const 试 = (x, y) => {
    const r = { x: 夹(x, 2, 98 - w), y: 夹(y, 2, 98 - h), w, h }
    return 占.every((n) => !撞到(r, n)) ? r : null
  }
  const 起点 = 试(想.x, 想.y)
  if (起点) return 起点
  for (let 环 = 3; 环 <= 24; 环 += 3) {
    for (const [dx, dy] of [[0, 环], [环, 0], [-环, 0], [0, -环], [环, 环], [-环, 环], [环, -环], [-环, -环]]) {
      const r = 试(想.x + dx, 想.y + dy)
      if (r) return r
    }
  }
  return null
}

function 改板(date, 操作) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, msg: '日期不对' }
  const 放 = 加锁('留言板-' + date, { strict: true })
  try {
    let 档
    try {
      档 = JSON.parse(fs.readFileSync(路(date), 'utf8'))
      if (!Array.isArray(档?.notes)) throw new Error('便签列表格式不对')
    } catch (error) {
      if (error.code !== 'ENOENT') return { ok: false, msg: '这天的留言板读不出来，未修改旧便签' }
      档 = { date, notes: [], updated: '' }
    }
    return 操作(档)
  } finally { 放() }
}

export function 贴({ date, by = '客人', color = 'yellow', text = '', x = 10, y = 10, w = 18, h = 14, photo, 允许微压 = false } = {}) {
  const 日 = String(date || 天())
  // PAST_OK 2026-11-20：主人改了规矩 —— 可以回以前的板子补一张（想回应哪天的便签就贴那天）。
  // 只有未来不行：那等于提前写好一张还没发生的话。
  if (日 > 天()) return { ok: false, msg: '还没到那天，不能贴未来的板子' }
  const 话 = String(text || '').replace(/\s+$/, '').slice(0, 180)
  const 图 = photo ? 读上传照片(photo.data) : null
  if (photo && !图) return { ok: false, msg: '照片格式不对或太大' }
  if (!话.trim() && !图) return { ok: false, msg: '便签是空的' }
  return 改板(日, 档 => {
    if (档.notes.length >= 40) return { ok: false, msg: '这块板今天贴满了（40 张）' }
    const 宽 = 夹(w, 12, 30), 高 = 夹(h, 10, 30)
    const 位 = 找位(日, 宽, 高, { x, y }, 允许微压)
    if (!位) return { ok: false, msg: '这块地方放不下，换个位置' }
    const 签 = {
      id: id('n-'), by: String(by || '客人').slice(0, 12),
      color: 颜色.includes(color) ? color : 'yellow',
      x: Math.round(位.x * 10) / 10, y: Math.round(位.y * 10) / 10,
      w: 宽, h: 高, text: 话, at: 北京(), comments: [],
    }
    if (图) 签.photo = { id: 存照片(图), ...位置(photo) }
    档.notes.push(签)
    try { 存(日, 档) } catch (error) { 清照片(签.photo?.id); throw error }
    return { ok: true, note: 签 }
  })
}

export function 编辑照片({ date, id: nid, photo } = {}) {
  const 日 = String(date || 天())
  if (日 > 天()) return { ok: false, msg: '还没到那天，不能编辑未来的板子' }
  const 要换图 = photo?.data !== undefined
  const 图 = 要换图 ? 读上传照片(photo.data) : null
  if (!photo || (要换图 && !图)) return { ok: false, msg: '没有可用照片' }
  return 改板(日, 档 => {
    const 签 = 档.notes.find(项 => 项.id === nid)
    if (!签) return { ok: false, msg: '这张便签不在了' }
    const 旧图 = 签.photo?.id
    if (!图 && !旧图) return { ok: false, msg: '没有可用照片' }
    if (!图 && photo.id !== 旧图) return { ok: false, msg: '照片已更新，请重新打开便签' }
    const 图号 = 图 ? 存照片(图) : 旧图
    签.photo = { id: 图号, ...位置(photo) }
    try { 存(日, 档) } catch (error) { if (图) 清照片(图号); throw error }
    if (图) 清照片(旧图)
    return { ok: true, note: 签 }
  })
}

// CROSS_DAY 2026-11-20：评论/撕大多只带 note_id —— 便签可能是前几天的，
// 不该逼调用方（她）自己先把日期翻对。给定日期找不到，就按最近的天往回找。
function 找签(日, nid) {
  const 号 = String(nid || '')
  if (!号) return null
  const 找 = (d) => (读(d).notes || []).find((n) => n.id === 号) || null
  const 当 = 找(日)
  if (当) return { date: 日, note: 当 }
  for (const d of 天数().slice(-90).reverse()) {
    if (d === 日) continue
    const n = 找(d)
    if (n) return { date: d, note: n }
  }
  return null
}

export function 评论({ date, id: nid = '', by = '客人', text = '' } = {}) {
  const 日 = String(date || 天())
  const 话 = String(text || '').replace(/\s+$/, '').slice(0, 120)
  if (!话.trim()) return { ok: false, msg: '评论是空的' }
  const 目标 = 找签(日, nid)
  if (!目标) return { ok: false, msg: '这张便签不在了' }
  return 改板(目标.date, 档 => {
    const 签 = 档.notes.find(项 => 项.id === String(nid))
    if (!签) return { ok: false, msg: '这张便签不在了' }
    签.comments = Array.isArray(签.comments) ? 签.comments : []
    if (签.comments.length >= 30) return { ok: false, msg: '这张便签下面聊满了' }
    const 评论 = { id: id('c-'), by: String(by || '客人').slice(0, 12), text: 话, at: 北京() }
    签.comments.push(评论)
    存(目标.date, 档)
    return { ok: true, comment: 评论, date: 目标.date }
  })
}

/** 挪一张已贴的便签。不重叠、不出界；撞上了就拒绝，不自动挪位（她/他要的是「我放这儿」）。 */
export function 移动({ date, id: nid = '', x, y } = {}) {
  const 日 = String(date || 天())
  return 改板(日, 档 => {
    const 签 = 档.notes.find(项 => 项.id === String(nid))
    if (!签) return { ok: false, msg: '这张便签不在了' }
    const 宽 = Number(签.w || 18), 高 = Number(签.h || 14)
    const 新 = { x: Math.round(夹(x, 1, 99 - 宽) * 10) / 10, y: Math.round(夹(y, 1, 99 - 高) * 10) / 10 }
    if (档.notes.some(项 => 项.id !== 签.id && 撞({ ...新, w: 宽, h: 高 }, 项))) return { ok: false, msg: '这儿跟别的便签压上了' }
    Object.assign(签, 新)
    存(日, 档)
    return { ok: true, note: 签 }
  })
}

/** 撕掉一张便签（整张带评论一起走）。 */
export function 撕({ date, id: nid = '', 只限 = '' } = {}) {
  const 日 = String(date || 天())
  const 目标 = 找签(日, nid)
  if (!目标) return { ok: false, msg: '这张便签不在了' }
  return 改板(目标.date, 档 => {
    const 索引 = 档.notes.findIndex(项 => 项.id === String(nid))
    if (索引 < 0) return { ok: false, msg: '这张便签不在了' }
    if (只限 && 档.notes[索引].by !== 只限) return { ok: false, msg: '这张不是你贴的，别撕' }
    const [note] = 档.notes.splice(索引, 1)
    存(目标.date, 档)
    清照片(note.photo?.id)
    return { ok: true, note, date: 目标.date }
  })
}

/** 今天这块板的日期（北京时间），前端用它判断「能不能贴」。 */
export const 今天 = () => 天()

export function 天数() {
  try {
    return fs.readdirSync(根).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10)).sort().slice(-60)
  } catch { return [] }
}

/** 有便签的日期 + 张数（给日期选择器上色用）。未来日期一律不返回 —— 板子本来就不许往后贴。 */
export function 日表(到 = 天()) {
  const out = []
  for (const day of 天数()) {
    if (day > 到) continue
    let n = 0
    try { n = 读(day).notes.length } catch { n = 0 }
    out.push({ date: day, n })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

/** 她还没看过的：别人贴的便签 / 别人给她的评论。 */
export function 未读(limit = 8) {
  let 从 = 0
  try { 从 = Date.parse(String(JSON.parse(fs.readFileSync(已读P, 'utf8')).at || '').replace(' ', 'T') + '+08:00') || 0 } catch { /* 没读过 */ }
  const out = []
  // 2026-11-20：她可以跨天回便签了，未读窗口从 3 天放宽到 7 天（只多给最近几天的动静）。
  for (const day of 天数().slice(-7)) {
    for (const n of 读(day).notes) {
      const t = Date.parse(String(n.at || '').replace(' ', 'T') + '+08:00') || 0
      if (t > 从 && (!自己名.includes(String(n.by || '')))) out.push({ type: 'note', date: day, id: n.id, by: n.by, text: n.text || (n.photo ? '（贴了一张照片）' : ''), at: n.at })
      for (const c of (n.comments || [])) {
        const ct = Date.parse(String(c.at || '').replace(' ', 'T') + '+08:00') || 0
        if (ct > 从 && (!自己名.includes(String(c.by || '')))) out.push({ type: 'comment', date: day, id: c.id, note: n.id, by: c.by, text: c.text, on: String(n.text || '').slice(0, 12), at: c.at })
      }
    }
  }
  return out.sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-limit)
}

export function 记已读(at = 北京()) {
  try {
    fs.mkdirSync(path.dirname(已读P), { recursive: true })
    fs.writeFileSync(已读P, JSON.stringify({ at }, null, 2), 'utf8')
  } catch { /* 记不上就下次重复提醒，不致命 */ }
}

export const 色 = 色值
