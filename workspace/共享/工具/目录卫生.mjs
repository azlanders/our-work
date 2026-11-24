#!/usr/bin/env node
// 目录卫生.mjs —— 2026-11-11 立规矩：工作区与 /root 目录自动保洁与防腐化巡检
//
// 职责：
//   1. 自动归档 `记忆/` 下超过 7 天的 `手账-*.md`、`梦-*.md`、`巡检-*.md` 到 `记忆/归档/历史按月/`；
//   2. 清理过期视频缓存、面板试听和已登记的测试沙盒；
//   3. 自动清理 `屏幕/history/` 下只保留最近 50 张历史截图，清空 `下载/` 下超过 2 天的临时文件；
//   4. 自动把误写到 `记忆/*.log` 顶层的日志归位到 `记忆/日志/`，并把超过 5000 行的日志裁留后 2500 行；
//   5. 散落的 `.bak*` 按批次和原路径归档至 `/root/bak2/`。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

// ENTRY_GUARD 2026-11-14（批次459）：被 import 时不要跑主流程。
// 冒烟测试「逐个 import」会把每个 .mjs 当 CLI 真跑一遍（457 实测一次写 16 个真档），
// 而这些脚本顶层就是整条流程。只有 `node <本文件>` 才执行下面的主流程；被 import 时是空模块。
// 用 __path/__fileURLToPath 这两个别名，避免和各文件已有的 path/join 撞名。
import __path from 'node:path'
import { fileURLToPath as __fileURLToPath } from 'node:url'
const 是入口 = (() => {
  try { return !!process.argv[1] && __path.resolve(process.argv[1]) === __fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {

const 用法 = [
  '用法：',
  '  node 目录卫生.mjs          # 按规则归档/清理（心跳每日北京时间 04:20）',
  '  node 目录卫生.mjs --dry    # 只检查、不创建目录、不移动/归档/删除',
  '  node 目录卫生.mjs --help   # 只打印用法，不读写',
].join('\n')

const 参数 = process.argv.slice(2)
const 未知参数 = 参数.filter((a) => a !== '--dry' && a !== '--help' && a !== '-h')

if (参数.includes('--help') || 参数.includes('-h')) {
  console.log(用法)
  process.exit(0)
}

if (未知参数.length > 0) {
  console.error('未知参数：' + 未知参数.join('、'))
  console.error(用法)
  process.exit(2)
}

const DRY = 参数.includes('--dry')
// 测试可在临时目录跑；不设时仍是原来的生产路径。
const W = process.env.DIRHY_BASE || '{{BOT_ROOT}}'
const MEM = path.join(W, '记忆')
const LOG_DIR = path.join(MEM, '日志')
const ARC_MONTH = path.join(MEM, '归档', '历史按月')
const BAK2 = process.env.DIRHY_BAK2 || '/root/bak2'
const TMP_ROOTS = W === '{{BOT_ROOT}}' ? ['/tmp', '/var/tmp'] : []

if (!DRY) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.mkdirSync(ARC_MONTH, { recursive: true })
  fs.mkdirSync(BAK2, { recursive: true })
}

const now = Date.now()
const DAY_MS = 86400_000
const bjDate = (ms = now) => new Date(ms + 8 * 3600_000).toISOString().slice(0, 10)
let moved = 0, trimmed = 0, cleaned = 0
let cleanedBytes = 0
let errors = 0

function entries(dir) {
  if (!fs.existsSync(dir) || !fs.lstatSync(dir).isDirectory() || fs.realpathSync(dir) !== path.resolve(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true })
}

function cleanFiles(dir, nameMatches, days) {
  let count = 0, bytes = 0
  for (const entry of entries(dir)) {
    if (!entry.isFile() || !nameMatches(entry.name)) continue
    const file = path.join(dir, entry.name)
    try {
      const info = fs.lstatSync(file)
      if (!info.isFile() || now - info.mtimeMs <= days * DAY_MS) continue
      if (!DRY) fs.unlinkSync(file)
      count++
      bytes += info.size
    } catch (err) {
      if (err.code !== 'ENOENT') { errors++; console.error(file, err.code) }
    }
  }
  cleaned += count
  cleanedBytes += bytes
  if (count) console.log(`${dir}：${count} 项，${bytes} bytes`)
}

// 1) 记忆/ 顶层误落的 .log 自动移入 记忆/日志/
for (const f of fs.readdirSync(MEM)) {
  const p = path.join(MEM, f)
  let isLink = false
  let isFile = false
  try {
    const lst = fs.lstatSync(p)
    isLink = lst.isSymbolicLink()
    isFile = lst.isFile() || isLink
  } catch {
    continue
  }
  if (!isFile) continue

  if (f.endsWith('.log')) {
    const dst = path.join(LOG_DIR, f)
    if (!DRY) {
      if (fs.existsSync(dst)) {
        fs.appendFileSync(dst, fs.readFileSync(p))
        fs.unlinkSync(p)
      } else {
        fs.renameSync(p, dst)
      }
    }
    moved++
  }
  // 2) 超过 7 天的手账/梦/巡检/早间简报/日报 归入 对应子目录与按月归档
  // 兼顾 t434 历史断言对 (手账|梦|巡检|早间简报) 正则字面量的匹配，同时拓展 日报
  const m = /^(手账|梦|巡检|早间简报)-(\d{4}-\d{2}-\d{2})\.md$/.exec(f) || /^(日报)-(\d{4}-\d{2}-\d{2})\.md$/.exec(f)
  if (m) {
    const 类型 = m[1]
    const 日期 = m[2]
    const fileMs = Date.parse(日期 + 'T00:00:00+08:00')
    const isOld = Number.isFinite(fileMs) && (now - fileMs) > 7.5 * DAY_MS
    const subDir = path.join(MEM, 类型)
    const inSub = path.join(subDir, f)

    if (isLink) {
      // 软链接：超过 7.5 天自动解绑，释放顶层空间（实体文件已在子目录下）
      if (isOld) {
        if (!DRY) fs.unlinkSync(p)
        cleaned++
      }
    } else {
      // 实体文件：确保存放到对应独立子目录中，并在顶层保持软链接兼容
      if (!DRY) {
        fs.mkdirSync(subDir, { recursive: true })
        if (!fs.existsSync(inSub) || fs.statSync(p).mtimeMs > fs.statSync(inSub).mtimeMs) {
          fs.copyFileSync(p, inSub)
        }
        fs.unlinkSync(p)
        if (!isOld) {
          // 7.5 天内：建立相对软链接，保证下游脚本读取无感知
          fs.symlinkSync(path.join(类型, f), p)
        }
      }
      moved++
    }
  }
}

// 3) 记忆/日志/*.log 超过 5000 行自动裁留后 2500 行
if (fs.existsSync(LOG_DIR)) {
  for (const f of fs.readdirSync(LOG_DIR)) {
    if (!f.endsWith('.log')) continue
    const p = path.join(LOG_DIR, f)
    try {
      const st = fs.statSync(p)
      if (st.size < 512 * 1024) continue
      const lines = fs.readFileSync(p, 'utf8').split('\n')
      if (lines.length > 5000) {
        if (!DRY) fs.writeFileSync(p, lines.slice(-2500).join('\n'))
        trimmed++
      }
    } catch {}
  }
}

// 4) 视频原片与可重建的 B 站分镜缓存
const vidDir = path.join(MEM, '视频画面')
cleanFiles(vidDir, name => name.endsWith('.mp4'), 3)
// STORYBOARD_TTL 2026-11-24：分镜 png 原来保留 30 天 —— 实测 记忆/视频画面 已经
// 1.1GB（占整个 记忆/ 的 92%），而分镜是「可重建缓存」：要看时重跑一次就有。
// 改成 7 天（跟 .mp4 的 3 天一样属于「看过的内容不必长期留着」），
// 但保留 .srt / .omni.json（小、且是文本结论，重跑也未必一致）。
cleanFiles(vidDir, name => /^BV[A-Za-z0-9]{10}(?:\.p\d+\.\d+)?(?:\.sb-\d+)?\.png$/.test(name), 7)
cleanFiles(path.join(W, '共享', '面板试听'), name => /^tts-\d{8,20}\.(mp3|wav)$/.test(name), 7)

// 5) 屏幕/history/ 只留最近 50 张
const scrHist = path.join(W, '屏幕', 'history')
const imgs = []
for (const entry of entries(scrHist)) {
  if (!entry.isFile() || !/\.(png|jpe?g|webp)$/i.test(entry.name)) continue
  const file = path.join(scrHist, entry.name)
  try {
    const info = fs.lstatSync(file)
    if (info.isFile()) imgs.push({ file, info })
  } catch (err) {
    if (err.code !== 'ENOENT') { errors++; console.error(file, err.code) }
  }
}
imgs.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)
for (const item of imgs.slice(50)) {
  try {
    if (!DRY) fs.unlinkSync(item.file)
    cleaned++
    cleanedBytes += item.info.size
  } catch (err) {
    if (err.code !== 'ENOENT') { errors++; console.error(item.file, err.code) }
  }
}

// 6) 下载/ 下超过 2 天的临时文件清理
const dlDir = path.join(W, '下载')
cleanFiles(dlDir, () => true, 2)

const testPrefix = /^(?:t363(?:card|off)?|t353-usage|base416|land420|sulk411|ledger417|self418|hunger419|t467-cfg|rofm661|smoke1b?)-[A-Za-z0-9]{6}$/
const releasePrefix = /^fish-(?:memory-(?:release|full-check|snapshot|input)|dialogue-(?:legacy|708)|queue-spec|panel-label|cutover-preflight|balance-schedule|board-release|diary-paper-photo|webui-1119)-[A-Za-z0-9]{8}$/
function activeTmpPaths() {
  const active = new Set()
  for (const pid of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    const proc = path.join('/proc', pid)
    try {
      const targets = [fs.readlinkSync(path.join(proc, 'cwd'))]
      for (const fd of fs.readdirSync(path.join(proc, 'fd'))) {
        try { targets.push(fs.readlinkSync(path.join(proc, 'fd', fd))) } catch {}
      }
      for (const target of targets) {
        const match = target.match(/^(\/(?:var\/)?tmp\/[^/]+)(?:\/|$)/)
        if (match) active.add(match[1])
      }
    } catch {}
  }
  return active
}

if (TMP_ROOTS.length) {
  const active = activeTmpPaths()
  const mountpoints = fs.readFileSync('/proc/self/mountinfo', 'utf8').split('\n').map(line => line.split(' ')[4]).filter(Boolean)
  for (const dir of TMP_ROOTS) {
    const match = dir === '/tmp' ? testPrefix : releasePrefix
    const days = dir === '/tmp' ? 2 : 7
    let count = 0
    for (const entry of entries(dir)) {
      if (!entry.isDirectory() || !match.test(entry.name)) continue
      const target = path.join(dir, entry.name)
      try {
        const info = fs.lstatSync(target)
        if (!info.isDirectory() || info.uid !== 0 || active.has(target) || now - info.mtimeMs <= days * DAY_MS) continue
        if (mountpoints.some(mount => mount === target || mount.startsWith(`${target}/`))) continue
        if (!DRY) fs.rmSync(target, { recursive: true, force: true })
        count++
      } catch (err) {
        if (err.code !== 'ENOENT') { errors++; console.error(target, err.code) }
      }
    }
    cleaned += count
    if (count) console.log(`${dir}：${count} 个到期测试沙盒`)
  }
}

// 7) 违章散落的 *.bak* 自动收进 /root/bak2/
const 扫描根 = process.env.DIRHY_SCAN_ROOTS
  ? process.env.DIRHY_SCAN_ROOTS.split(path.delimiter).filter(Boolean)
  : ['/root', W, path.join(W, '共享'), path.join(W, '共享/工具'), MEM, '/usr/local/bin']
let backupBatch
for (const dir of 扫描根) {
  for (const entry of entries(dir)) {
    if (!entry.isFile() || !/\.bak($|[-._])/i.test(entry.name)) continue
    const p = path.join(dir, entry.name)
    try {
      if (!DRY) {
        backupBatch ??= path.join(BAK2, `目录卫生-${bjDate()}-${randomUUID().slice(0, 8)}`)
        const target = path.join(backupBatch, p)
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.copyFileSync(p, target, fs.constants.COPYFILE_EXCL)
        const info = fs.statSync(p)
        fs.chmodSync(target, info.mode & 0o777)
        fs.utimesSync(target, info.atime, info.mtime)
        fs.unlinkSync(p)
      }
      moved++
    } catch (err) { errors++; console.error(p, err.code) }
  }
}

console.log(`[${bjDate()}] 目录卫生：归位/归档 ${moved} 项，裁剪日志 ${trimmed} 份，清理过期缓存 ${cleaned} 项（文件 ${cleanedBytes} bytes），错误 ${errors}${DRY ? ' (dry-run)' : ''}`)
if (errors) process.exitCode = 1
}
