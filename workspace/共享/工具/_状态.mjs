// _状态.mjs —— 状态文件的安全写入（2026-11-04 新建，重构加固坏文件保护）
import { readFileSync, writeFileSync, appendFileSync, renameSync, copyFileSync, unlinkSync, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { 加锁 } from './_锁.mjs'

export const clone = (o) => JSON.parse(JSON.stringify(o ?? null))

/**
 * 读取 JSON 状态文件：
 * - 文件不存在（ENOENT）：返回 fallback。
 * - 文件损坏（JSON SyntaxError）或非对象：备份为 .corrupt-<ts> 并打印 stderr 告警，
 *   strict=true（默认在 saveState 合并时开启）抛出异常防止用空对象覆盖历史状态。
 */
export function loadState(p, fallback = {}, { strict = false } = {}) {
  let raw
  try {
    raw = readFileSync(p, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') return fallback
    console.error(`[_状态] 读取失败 ${p}: ${err && err.message}`)
    if (strict) throw err
    return fallback
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') {
      throw new SyntaxError('状态文件根节点不是对象')
    }
    return parsed
  } catch (err) {
    const bak = `${p}.corrupt-${Date.now()}`
    try { copyFileSync(p, bak) } catch (bakErr) {
      console.error(`[_状态] 备份损坏文件失败 ${bak}: ${bakErr && bakErr.message}`)
    }
    console.error(`[_状态] JSON 损坏 ${p}（已备份至 ${bak}）: ${err && err.message}`)
    if (strict) throw err
    return fallback
  }
}

function withLock(p, fn) {
  const waitMs = Number.isFinite(Number(process.env.QQ_STATE_LOCK_WAIT_MS)) ? Math.max(0, Number(process.env.QQ_STATE_LOCK_WAIT_MS)) : 5000
  const 放 = 加锁(basename(String(p)), { strict: true, waitMs })
  try { return fn() } finally { 放() }
}

function isPlainObj(o) {
  return o !== null && typeof o === 'object' && !Array.isArray(o)
}

function mergeDiff(freshVal, nextVal, prevVal) {
  if (prevVal === undefined) return nextVal
  if (JSON.stringify(nextVal) === JSON.stringify(prevVal)) return freshVal
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
    const 日志基 = String(p).replace(/[^/]+$/, '')
    const 日志 = (existsSync(日志基 + '日志') ? 日志基 + '日志/' : 日志基) + '状态变更.log'
    appendFileSync(日志, at + ' ' + 谁 + ' : ' + 变.join(' | ') + '\n')
  } catch (err) {
    console.error(`[_状态] 旁路审计写盘失败: ${err && err.message}`)
  }
}

export function saveState(p, next, prev) {
  return withLock(p, () => {
    let merged = next
    if (prev !== undefined && prev !== null) {
      const fresh = loadState(p, {}, { strict: true })
      merged = mergeDiff(fresh, next, prev)
      审计跳变(p, fresh, merged)
    }
    const tmp = `${p}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    try {
      writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf8')
      renameSync(tmp, p)
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch (_err) { console.error('[_状态]', _err?.message || _err) }
      throw err
    }
    return merged
  })
}
