// 碎片公共.mjs —— 碎片库的读取与 mtime 缓存。两个碎片模块共用这一份。
//
// 为什么单独抽（2026-11-05）：
//   碎片召回.mjs 和 碎片话题.mjs 各抄了一份**逐字相同**的 读碎片文件()，
//   而且 碎片召回 那份里写的是 `typeof statSync === 'function' ? statSync(p) : fs.statSync(p)`，
//   可那个文件根本没导入 fs —— 真走到 fallback 分支会 ReferenceError，被外层 catch 吞掉、
//   静默返回空串。平时走不到（statSync 一定存在），但这是颗留着不响的雷。
//
// 缓存是共享的：两个模块读的是同一个 碎片.jsonl，各存一份缓存纯属浪费。
import { statSync } from 'node:fs'

let cache = { mtimeMs: 0, size: 0, text: '' }

/**
 * 读碎片文件，按 mtime + size 判断是否需要重读。
 * 读不到（文件不存在 / 权限 / 磁盘）一律返回空串，不抛错 —— 调用方都按「没有碎片」处理。
 *
 * @param {string} p 文件路径
 * @param {(p: string) => string} read 实际读取方式（同步），传进来是为了让调用方决定编码
 * @returns {string}
 */
export function 读碎片文件(p, read) {
  try {
    const st = statSync(p)
    if (cache.mtimeMs === st.mtimeMs && cache.size === st.size) return cache.text
    const text = read(p)
    cache = { mtimeMs: st.mtimeMs, size: st.size, text }
    return text
  } catch {
    return ''
  }
}
