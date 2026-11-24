#!/usr/bin/env node
// 封面.mjs —— 给登录页准备轮换用的封面图
//
// 为什么单独做这一步：
//   · 成品/ 里是 1920x1080 的 PNG，单张 2.9MB。登录页现在每 10 秒换一张，
//     直接在热路径上发原图，手机一进来就是十几 MB。
//   · 面板的请求处理里同步压图会卡住事件循环（convert 一张 0.3~0.8s），
//     别人正好在刷面板就会卡。所以压图放在这条离线任务里，面板只管读文件。
//   · /cover/list 只列「已经压好的」，没压好的新照片最多晚几分钟才进轮换，
//     换来的是热路径永远零阻塞。
//
// 两档尺寸：
//   <id>.jpg     1600 宽  ≈225KB   桌面全屏
//   <id>@s.jpg    900 宽  ≈85KB    手机。1600 的图在手机上要多解 3 倍像素，
//                                  纹理能到 5.7MB，老机型会掉帧。
//
// 用法：
//   node 封面.mjs           扫一遍，补缺的、清孤儿
//   node 封面.mjs --看      只看会做什么，不动文件
//   node 封面.mjs --全      全部重压（改了宽度/质量之后用）
//
// 沙盒：COVER_BASE 指到别处就能整段跑在临时目录里。

import { readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from 'node:fs'
// PHOTO_ID 2026-11-07（批次161）：成品目录里的 png 不全是照片。
// 别给截图压封面 —— 压了它就会进登录页轮换。判据只在 成品图.mjs 一份。
import { 是成品图 } from './成品图.mjs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const BASE = process.env.COVER_BASE || '{{BOT_ROOT}}/共享/自拍'
const SRC = join(BASE, '成品')
const DST = join(BASE, '封面')
const MAX = Number(process.env.COVER_MAX || 60)   // 只看最新这么多张，老的不再生成

// 大图给小屏之外的，小图给手机。质量分开是因为缩到 900 后压缩痕迹更明显，得留高一点。
const SIZES = [
  { suffix: '', width: 1600, quality: 80 },
  { suffix: '@s', width: 900, quality: 78 },
]

const DRY = process.argv.includes('--看')
const ALL = process.argv.includes('--全')

const log = (...a) => console.log(...a)
const outOf = (id, suffix) => join(DST, id + suffix + '.jpg')

function listPng() {
  try { return readdirSync(SRC).filter(是成品图).sort() } catch { return [] }
}

const pngs = listPng()
if (!DRY && !existsSync(DST)) mkdirSync(DST, { recursive: true })

if (DRY) {
  if (!pngs.length) { log('成品目录里没有照片'); process.exit(0) }
  for (const f of pngs) {
    const id = f.replace(/\.png$/, '')
    const src = statSync(join(SRC, f)).mtimeMs
    const todo = SIZES.filter((z) => {
      const o = outOf(id, z.suffix)
      return ALL || !existsSync(o) || statSync(o).mtimeMs < src
    })
    log((todo.length ? '要压 ' + todo.map((z) => z.suffix || '大').join('+') : '已最新') + '  ' + id)
  }
  process.exit(0)
}

// COVER_MAX：只保留最新的一批，超出的不再生成（也不删已有文件，免得链接断掉）
const keep = pngs.slice(-MAX)
const dropped = pngs.length - keep.length
const made = []

for (const f of keep) {
  const id = f.replace(/\.png$/, '')
  const p = join(SRC, f)
  const srcMs = statSync(p).mtimeMs
  for (const z of SIZES) {
    const o = outOf(id, z.suffix)
    // 源图比封面新才重压——她重新渲染同一张时 id 不变，这里靠 mtime 兜住
    if (!ALL && existsSync(o) && statSync(o).mtimeMs >= srcMs) continue
    try {
      execFileSync('convert', [
        p,
        '-resize', z.width + 'x',
        '-strip',                // 去掉 EXIF/ICC，省几 KB，也不泄露渲染参数
        '-interlace', 'Plane',   // 渐进式：网慢时先出马赛克再清楚，比一直白着好
        '-quality', String(z.quality),
        o,
      ], { stdio: 'ignore', timeout: 20000 })
      made.push([id + (z.suffix || ''), statSync(o).size])
    } catch (e) {
      log('压失败 ' + id + (z.suffix || '') + '：' + String(e.message || e).slice(0, 120))
    }
  }
}

// 孤儿：成品没了但封面还在，删掉，不然登录页会轮出一张已经不存在的照片。
// 注意这条要在「成品为空」时也能跑到 —— 她要是把所有照片都删了，封面不能留着占地方。
let gone = 0
try {
  const live = new Set(pngs.map((f) => f.replace(/\.png$/, '')))
  for (const f of readdirSync(DST)) {
    if (!f.endsWith('.jpg')) continue
    // id 里不会有 @，去掉 @s 后缀就是它对应的那张成品
    const id = f.replace(/\.jpg$/, '').replace(/@s$/, '')
    if (!live.has(id)) { unlinkSync(join(DST, f)); gone++ }
  }
} catch (e) {
  log('清孤儿出错：' + String(e.message || e).slice(0, 120))
}

const all = readdirSync(DST).filter((f) => f.endsWith('.jpg'))
const bytes = all.reduce((s, f) => { try { return s + statSync(join(DST, f)).size } catch { return s } }, 0)
const big = all.filter((f) => !/@s\.jpg$/.test(f))
const bigBytes = big.reduce((s, f) => { try { return s + statSync(join(DST, f)).size } catch { return s } }, 0)

// 静默：没压也没清就什么都不打。这是给 cron 用的，一天 288 次，不该把日志灌满。
if (!made.length && !gone) process.exit(0)
if (made.length) {
  log('压好 ' + made.length + ' 张：' + made.map(([id, n]) => id + ' ' + Math.round(n / 1024) + 'KB').join('、'))
}
if (gone) log('清掉 ' + gone + ' 张孤儿封面')
if (dropped > 0) log('超过上限 ' + MAX + ' 张，跳过 ' + dropped + ' 张老的')
log('封面 ' + all.length + ' 个文件，合计 ' + (bytes / 1024 / 1024).toFixed(2) + 'MB'
  + '；其中大图 ' + big.length + ' 张 ' + (bigBytes / 1024 / 1024).toFixed(2) + 'MB'
  + '（首屏只下一个，约 ' + Math.round(bigBytes / Math.max(1, big.length) / 1024) + 'KB）')
