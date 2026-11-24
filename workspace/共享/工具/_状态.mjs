// _状态.mjs —— 状态文件的安全写入（2026-11-04 新建）
//
// 为什么要有这个：
//   状态.json 有六七个脚本会写（耐心 / 困意 / 醒来 / 状态推进 / 自动作息 / 奖惩），
//   全都是「整份读进来 → 改自己的字段 → 整份写回去」。两个脚本撞在同一秒时，
//   后写的会把先写的一整片字段按自己手里的旧副本盖回去。实测 30 轮并发撞了 1 次。
//
// 它做三件事：
//   1 只合并「自己改过的键」——别把别人刚写的字段按旧值盖回去
//   2 写入走临时文件 + rename，读者不会读到半截 JSON
//   3 用 lock 文件串行化读改写的整个窗口（不是只锁写入那一下）
//
// 用法：
//   import { loadState, saveState } from './_状态.mjs'
//   const st = loadState(p)          // 读
//   const snap = clone(st)           // 读之后立刻留一份快照
//   ...改 st...
//   saveState(p, st, snap)           // 只把 st 与 snap 的差异合并进磁盘上的最新内容
import { readFileSync, writeFileSync, appendFileSync, renameSync, unlinkSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { 加锁 } from './_锁.mjs'

export const clone = (o) => JSON.parse(JSON.stringify(o ?? null))

export function loadState(p, fallback = {}) {
  try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fallback }
}

// 与 _底层.改档 / _锁 使用同一锁身份；抢锁失败时不允许旧快照继续写。
function withLock(p, fn) {
  const waitMs = Number.isFinite(Number(process.env.QQ_STATE_LOCK_WAIT_MS)) ? Math.max(0, Number(process.env.QQ_STATE_LOCK_WAIT_MS)) : 5000
  // LOCKNAME_REVERT 2026-11-24：见 _底层.改档 同一段说明 —— 改父目录名会破坏
  // 契约测试里「预建 <名>.lock 期望 fail-closed」的用法。回滚到 basename。
  const 放 = 加锁(basename(String(p)), { strict: true, waitMs })
  try { return fn() } finally { 放() }
}

// 把 next 相对 prev 的变化合并到文件当前内容上。
// prev 没给（老调用方）时退化成整份覆盖，保持向后兼容。
// 2026-11-04：改成递归合并——好感度.json 是 {people:{QQ:{...}}}，
// 只在第一层比对等于「整张 people 表都算我改的」，照样会盖掉别人刚记的人。
function isPlainObj(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o)
}

function mergeDiff(freshVal, nextVal, prevVal) {
  // 没有快照可依：以 next 为准
  if (prevVal === undefined) return nextVal
  if (JSON.stringify(nextVal) === JSON.stringify(prevVal)) return freshVal // 我没动这个键
  // 两边都是普通对象：逐个子键递归，保住别人写的兄弟键
  if (isPlainObj(nextVal) && isPlainObj(freshVal)) {
    const out = { ...freshVal }
    const keys = new Set([...Object.keys(nextVal), ...Object.keys(prevVal || {})])
    for (const k of keys) {
      const r = mergeDiff(out[k], nextVal[k], prevVal?.[k])
      if (r === undefined) delete out[k]
      else out[k] = r
    }
    return out
  }
  return nextVal
}

// STATE_AUDIT 2026-11-08（批次255）：某层一次跳变超过 4 点就落一行账。
//
// 为什么要有：11-08 她情绪从 42.5 掉到 19.4，逐条公式反推都算不出来 ——
// 六个写入口、两处融合、三处扣减全查过，谁也不可能是 19.4。
// 没有留痕就只能靠猜，而「父脚本拿旧副本再 save」这个病已经复发三次了。
// 以后再有这种，直接在 记忆/状态变更.log 里看是谁、什么时候、从多少到多少。
const 跳变阈值 = 4

function 审计跳变(p, fresh, merged) {
  try {
    const a = fresh && fresh.layers
    const b = merged && merged.layers
    if (!a || !b) return
    const 变 = []
    for (const k of ['physical', 'emotional', 'cognitive', 'existential']) {
      const x = Number(a[k])
      const y = Number(b[k])
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      if (Math.abs(y - x) > 跳变阈值) 变.push(k + ' ' + x + '→' + y)
    }
    if (!变.length) return
    const 谁 = String((process.argv[1] || 'unknown')).split('/').pop()
    const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    const 日志基 = String(p).replace(/[^/]+$/, ''); const 日志 = (existsSync(日志基 + '日志') ? 日志基 + '日志/' : 日志基) + '状态变更.log'
    appendFileSync(日志, at + ' ' + 谁 + ' : ' + 变.join(' | ') + '\n')
  } catch { /* 审计是旁路，绝不能因为写日志把状态写坏 */ }
}

export function saveState(p, next, prev) {
  return withLock(p, () => {
    let merged = next
    if (prev !== undefined && prev !== null) {
      const fresh = loadState(p, {})
      merged = mergeDiff(fresh, next, prev)
      审计跳变(p, fresh, merged)
    }
    // TMPNAME_FIX 2026-11-24：原来是 `${p}.tmp${process.pid}` —— 只带 pid、没有随机。
    // 同进程内靠锁兜住了，但这正是 睡眠阶段.mjs 那个「固定临时名互相灌半截」的同一个形状；
    // 与 _底层.写档 统一成 pid + 随机。
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
    renameSync(tmp, p)
    return merged
  })
}
