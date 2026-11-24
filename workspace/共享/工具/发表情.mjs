#!/usr/bin/env node
// 发表情.mjs —— 把本地图片/GIF 原样发到群里（2026-11-02）
//
// 用法：
//   node 发表情.mjs /path/to/x.gif            # 发到冰服务（默认）
//   node 发表情.mjs /path/to/x.gif --group 2000000001
//   node 发表情.mjs --list                    # 看收到的表情目录
//
// 为什么单独写一个：
//   · 实测 OneBot 的 /send_group_msg 用 file:// 直发 GIF 是通的（retcode 0，能播出动画）。
//     桥里那条路径为什么丢掉动态，是它自己转码/转存的事；这里给一个「原样发」的可靠口子。
//   · 先嗅真实格式：QQ 给的图常常叫 .jpg，内容其实是 GIF。扩展名错了，QQ 就按静态处理。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { 载配置, 发群 } from './发送口.mjs'

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

// 批次608：走统一发送口（群白名单 + 内容审计 + 代理动作日志）
const cfg = 载配置()

// 加上这台机器实际的表情库（里面有 2026-10 / 2026-11 子目录）
const dirs = ['{{DSH_ROOT}}/qq-faces', '{{DSH_ROOT}}/faces', '{{BOT_ROOT}}/表情', '{{BOT_ROOT}}/表情库']
if (args.includes('--list')) {
  // 递归最多两层（表情库按月份分子目录），只收图片，按文件名去重后排序
  const exts = /\.(gif|png|jpg|jpeg|webp)$/i
  const files = new Set()
  const walk = (d, depth) => {
    if (depth > 2) return
    let ents
    try { ents = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const full = join(d, e.name)
      if (e.isDirectory()) { walk(full, depth + 1); continue }
      if (exts.test(e.name)) files.add(e.name)
    }
  }
  for (const d of dirs) if (existsSync(d)) walk(d, 0)
  const names = [...files].sort()
  if (!names.length) console.log('没找到表情，试过：' + dirs.join('、'))
  else {
    console.log('共 ' + names.length + ' 张')
    for (const n of names.slice(0, 50)) console.log('  ' + n)
  }
  process.exit(0)
}

const file = args.find((a) => !a.startsWith('--'))
if (!file || !existsSync(file)) { console.error('要一个存在的文件路径'); process.exit(1) }

// 嗅真实格式
const head = readFileSync(file).subarray(0, 12)
const isGif = head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46
const isPng = head[0] === 0x89 && head[1] === 0x50
const isJpg = head[0] === 0xff && head[1] === 0xd8
const kind = isGif ? 'GIF（会动）' : isPng ? 'PNG' : isJpg ? 'JPEG' : '未知格式'
const size = statSync(file).size

const group = val('--group', String((cfg.groups && cfg.groups[0]) || '2000000001'))
const r = await 发群(cfg, group, [{ type: 'image', data: { file: 'file://' + file } }])
if (r.ok) {
  console.log(`发出去了（${kind}，${(size / 1024).toFixed(0)}KB），message_id=${r.msgId ?? '?'}`)
} else {
  console.log(`没发成：${r.err}`)
  process.exit(1)
}
