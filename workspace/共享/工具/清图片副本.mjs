#!/usr/bin/env node
// 清图片副本.mjs —— 「收到的图片」目录按内容哈希去重归档（2026-11-07 批次196）。
//
// 背景：NapCat 收到图片另存副本时文件名带内容哈希（…_<MD5>.gif），同一个表情
// 群友每发一次就存一份 —— 实测 218M 里 95M 是纯重复（同一个 4.3M 的 GIF 存了 11 份）。
//
// 规则：文件名里能解出 32 位十六进制哈希的参与去重；同哈希保留 mtime 最新的一份，
// 其余 **移到归档目录**（不删，随时能拿回来）。没有哈希段的文件名不参与（不硬算 md5，
// 同名即同组、不同名就当不同——不误伤）。
//
// collect.js 的 index（第 N 张）按目录序号，去重会使其偏移；但她从未用过 index
// （群聊日志 grep「第 N 张」= 0），recent 按最新算不受影响。风险已记变更。
//
// 用法：node 清图片副本.mjs [--dry]      # --dry 只说不做
// 沙盒：QQ_IMGDIR 指图片目录、QQ_IMG_ARCHIVE 指归档目录（测试用）。
import { readdirSync, lstatSync, readFileSync, mkdirSync, linkSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const DIR = process.env.QQ_IMGDIR || '{{BOT_ROOT}}/收到的图片'
const 归档 = process.env.QQ_IMG_ARCHIVE || '{{BOT_ROOT}}/记忆/归档/收到的图片-重复'
const DRY = process.argv.includes('--dry')

export function 分组(files) {
  const by = new Map()
  for (const f of (Array.isArray(files) ? files : [])) {
    const m = String(f).match(/_([0-9A-Fa-f]{32})\./)
    if (!m) continue
    const k = m[1].toUpperCase()
    if (!by.has(k)) by.set(k, [])
    by.get(k).push(f)
  }
  return by
}

// 是主判据用 pathToFileURL 对比 —— import.meta.url 里的中文路径是 URL 编码，
// 直接 endsWith('清图片副本.mjs') 永远是 false，主流程一次都没跑过（实测踩坑）。
const 是主 = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (是主) {
  let files = []
  try { files = readdirSync(DIR, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name) }
  catch { console.log('目录读不到：' + DIR); process.exit(1) }
  const by = 分组(files)
  let 移 = 0
  let 省bytes = 0
  let 跳过 = 0
  for (const [哈希, 组] of by) {
    if (组.length < 2) continue
    const 带时 = 组.map((f) => {
      try {
        const s = lstatSync(join(DIR, f))
        if (s.isFile()) return { f, m: s.mtimeMs, size: s.size }
      } catch (err) { if (err.code !== 'ENOENT') throw err }
    }).filter(Boolean).sort((a, b) => b.m - a.m)
    if (带时.length < 2) continue
    const 留 = 带时[0]
    const 摘要 = file => createHash('sha256').update(readFileSync(join(DIR, file))).digest('hex')
    const 保留摘要 = 摘要(留.f)
    for (const x of 带时.slice(1)) {
      if (x.size !== 留.size || 摘要(x.f) !== 保留摘要) { 跳过++; continue }
      if (!DRY) {
        mkdirSync(归档, { recursive: true })
        try { linkSync(join(DIR, x.f), join(归档, x.f)) }
        catch (err) { if (err.code === 'EEXIST') { 跳过++; continue } throw err }
        unlinkSync(join(DIR, x.f))
      }
      省bytes += x.size
      移 += 1
    }
  }
  console.log((DRY ? '[dry] ' : '') + `共 ${files.length} 个文件、${by.size} 组带哈希；重复 ${移} 份`
    + (DRY ? '（待归档 ' : '（已归档 ') + (省bytes / 1e6).toFixed(1) + 'M → ' + 归档 + `），跳过 ${跳过} 份`)
}
