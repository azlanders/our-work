// 出口/面板响应/index.mjs —— Web 面板 HTTP 响应与图片缓存新鲜度工具（符合 目录与文件规矩.md §1.2）。
// 仅依赖 node:fs，无写盘副作用，无跨层反向依赖。
import { existsSync, readFileSync, statSync } from 'node:fs'

export function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  })
  return res.end(JSON.stringify(payload))
}

export function isFreshFile(filePath, maxAgeMs = 4000, now = Date.now()) {
  try {
    return existsSync(filePath) && (now - statSync(filePath).mtimeMs) < maxAgeMs
  } catch { /* 文件不存在或 stat 失败视为不新鲜 */ return false }
}

export function sendPngFile(res, filePath, missingMsg = '图片暂未生成') {
  try {
    if (!existsSync(filePath)) return sendJson(res, 404, { ok: false, msg: missingMsg })
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
    return res.end(readFileSync(filePath))
  } catch (e) {
    return sendJson(res, 500, { ok: false, msg: String(e?.message || e) })
  }
}
