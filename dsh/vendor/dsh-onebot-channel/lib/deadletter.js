/**
 * deadletter.js —— 出站失败正文的持久化（批次611，审计 P1-7）。
 *
 * 602B 的 outboundDeadLetters 只在进程内，重启就清空：
 * 「她明明发了、主人没收到」这种事故一重启就查不到原文，也没法补发。
 * 这里把发送失败的正文追加到 JSONL（最近 200 条），面板/排障脚本能读、能补。
 *
 * 只存「已经生成、发送失败」的正文与目标，不存凭据。
 * 任何写盘失败都只记一行日志，绝不阻断出站主链路。
 */
import fs from 'node:fs'
import path from 'node:path'
import { note } from './env.js'

const FILE = process.env.DSH_DEAD_LETTER_FILE || '{{DSH_ROOT}}/outbound-dead-letters.jsonl'
const MAX_KEEP = 200          // 对外的有效条数上限
const MAX_SCAN = 600          // 文件里最多留这么多行（含 replay 标记），防止无限长
const MAX_BYTES = 512 * 1024  // 超过这个大小就重写裁剪

let seq = 0

export function 死信文件() {
  return FILE
}

function 读全部() {
  try {
    return fs.readFileSync(FILE, 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => { try { return JSON.parse(line) } catch { return null } })
      .filter((x) => x && typeof x === 'object')
  } catch { return [] }
}

function 重写(行) {
  const 临时 = FILE + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.writeFileSync(临时, 行.map((x) => JSON.stringify(x)).join('\n') + (行.length ? '\n' : ''))
    fs.renameSync(临时, FILE)
  } catch (e) {
    try { fs.unlinkSync(临时) } catch { /* 没造出来 */ }
    note('deadletter', '裁剪失败：' + String(e?.message || e))
  }
}

/** 追加一条死信；返回进程内序号。 */
export function 记录死信(entry) {
  const item = {
    id: `${Date.now().toString(36)}-${(++seq).toString(36)}-${process.pid}`,
    at: Date.now(),
    ...entry,
  }
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.appendFileSync(FILE, JSON.stringify(item) + '\n')
    let 行 = null
    try {
      if (fs.statSync(FILE).size > MAX_BYTES) 行 = 读全部().slice(-MAX_SCAN)
    } catch { /* stat 失败不裁 */ }
    if (行 !== null) 重写(行)
  } catch (e) {
    note('deadletter', '写死信失败（不影响出站）：' + String(e?.message || e))
  }
  return item
}

/**
 * 读还没补发的死信（旧 → 新）。
 * @param {number} limit 最多返回多少条（默认 50，上限 MAX_KEEP）
 */
export function 读死信(limit = 50) {
  const n = Math.max(1, Math.min(MAX_KEEP, Math.floor(Number(limit) || 50)))
  const 行 = 读全部()
  const 已补 = new Set(行.filter((x) => x.type === 'replay').map((x) => String(x.id ?? '')))
  const items = 行.filter((x) => x.type !== 'replay' && !已补.has(String(x.id ?? '')))
  return items.slice(-n)
}

/** 补发成功后落一个标记；下次 读死信 不再返回它。 */
export function 标记补发(id) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true })
    fs.appendFileSync(FILE, JSON.stringify({ type: 'replay', id: String(id ?? ''), at: Date.now() }) + '\n')
    return true
  } catch (e) {
    note('deadletter', '写补发标记失败：' + String(e?.message || e))
    return false
  }
}
