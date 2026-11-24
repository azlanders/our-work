#!/usr/bin/env node
/**
 * 本子同步.mjs —— 把她的记忆抄一份到网盘「我的本子」。
 *
 * 背景（批次486）：2026-11-14 21:44 她自己建了网盘目录「我的本子」，手动传了一次
 * （手账/、日记/、群聊日志/ + 惦记/关系/内心/偏好/圈子黑话/他的作息/印象 七个文件），
 * 然后记下事实「**每天凌晨自动抄一份上去**」—— 但心跳表 52 个任务里没有这一个，
 * 她只是手动跑了一次，把「想做」记成了「已经做了」。
 *
 * 这个脚本就是补上那句话：每天凌晨把最新的抄上去。
 *
 * 2026-11-19：只把本轮选中的文件拷到私有临时目录，再走 `--tree-sync`。
 * 无归属或按聊天隔离的词库不上传；已有暂存和远端旧档不改动。
 *
 * 为什么不用 `--putdir`：它只按文件名跳过，`内心.md` 这种固定名字、内容会变的永远传不上去；
 * 而 PDS 的 `auto_rename` 又会造出「内心(1).md」「内心(2).md」，越滚越多。
 *
 * 手账/日记/群聊日志是按日期命名的（`手账-2026-11-14.md`），只会新增不会变，所以天然增量。
 */

import { readdirSync, statSync, mkdirSync, copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { 是旧黑话惦记 } from './黑话.mjs'

// CLI_GUARD 2026-11-17（批次616B）：审计 P0-4。
// 以前任何额外参数都被忽略，`--help` 会真的刷新暂存区并上传网盘。
// 帮助必须最先只读退出；裸跑仍是生产同步；其他参数一律拒绝。
const args = process.argv.slice(2)
const 用法 = [
  '用法：',
  '  node 本子同步.mjs          # 刷新暂存区并同步到网盘',
  '  node 本子同步.mjs --help   # 只打印用法，不读写、不上传',
].join('\n')

if (args.includes('--help') || args.includes('-h')) {
  console.log(用法)
  process.exit(0)
}
if (args.length > 0) {
  console.error('未知参数：' + args.join('、'))
  console.error(用法)
  process.exit(2)
}

const 记忆 = process.env.QQ_MEM || '{{BOT_ROOT}}/记忆'
const 日记 = process.env.QQ_DIARY || '{{BOT_ROOT}}/日记'
const 群聊 = process.env.QQ_GROUP_LOG || '{{BOT_ROOT}}/群聊日志'
const 工具 = process.env.QQ_TOOLS || '{{BOT_ROOT}}/共享/工具'

// 「我的本子」的 file_id（她自己 2026-11-14 21:44 建的）。改了名字就得换这里。
const 远端本子 = process.env.QQ_BOOK_DIR || ''
if (!远端本子) { console.log('未配置 QQ_BOOK_DIR，跳过本子同步'); process.exit(0) }

const 固定 = ['惦记.jsonl', '关系.json', '内心.md', '偏好.json', '他的作息.json', '印象.json']

function 拷(源, 目标, 过滤旧惦记 = false) {
  try {
    if (!existsSync(源)) return 0
    if (过滤旧惦记) {
      const lines = readFileSync(源, 'utf8').split('\n').filter((line) => {
        try { return !是旧黑话惦记(JSON.parse(line)) }
        catch { return false }
      })
      writeFileSync(目标, lines.filter(Boolean).join('\n') + '\n')
    } else copyFileSync(源, 目标)
    return 1
  } catch (e) {
    console.log(`  ✗ ${源} — ${e instanceof Error ? e.message.slice(0, 80) : e}`)
    return 0
  }
}

function 拷目录(源目录, 目标目录) {
  let n = 0, 字节 = 0
  try {
    if (!existsSync(源目录)) return { n, 字节 }
    mkdirSync(目标目录, { recursive: true })
    for (const f of readdirSync(源目录)) {
      const p = join(源目录, f)
      try {
        if (!statSync(p).isFile()) continue
        字节 += statSync(p).size
        copyFileSync(p, join(目标目录, f))
        n++
      } catch { /* 单个文件坏了跳过 */ }
    }
  } catch (e) {
    console.log(`  ✗ 目录 ${源目录} — ${e instanceof Error ? e.message.slice(0, 80) : e}`)
  }
  return { n, 字节 }
}

const 统计 = { 固定: 0, 手账: 0, 日记: 0, 群聊: 0 }

const 指定暂存 = process.env.QQ_BOOK_STAGE || ''
const 临时根 = realpathSync(tmpdir())
const 暂存 = 指定暂存 || mkdtempSync(join(临时根, 'fish-book-sync-'))
if (指定暂存) mkdirSync(指定暂存, { recursive: true })
try {
  for (const f of 固定) {
    if (拷(join(记忆, f), join(暂存, f), f === '惦记.jsonl') === 1) 统计.固定++
  }
  mkdirSync(join(暂存, '手账'), { recursive: true })
  const 手账源目录 = existsSync(join(记忆, '手账')) ? join(记忆, '手账') : 记忆
  for (const f of readdirSync(手账源目录)) {
    if (!/^手账-.*\.md$/.test(f)) continue
    if (拷(join(手账源目录, f), join(暂存, '手账', f)) === 1) 统计.手账++
  }
  if (手账源目录 !== 记忆) {
    for (const f of readdirSync(记忆)) {
      if (!/^手账-.*\.md$/.test(f)) continue
      if (拷(join(记忆, f), join(暂存, '手账', f)) === 1) 统计.手账++
    }
  }
  统计.日记 = 拷目录(日记, join(暂存, '日记')).n
  统计.群聊 = 拷目录(群聊, join(暂存, '群聊日志')).n
  console.log(`[本子] 暂存区已刷新：固定 ${统计.固定} / 手账 ${统计.手账} / 日记 ${统计.日记} / 群聊 ${统计.群聊}`)
  const out = execFileSync(process.execPath, [join(工具, '网盘.mjs'), '--tree-sync', 暂存, 远端本子], {
    encoding: 'utf8',
    timeout: 240000
  })
  const line = out.trim().split('\n').filter((x) => x.includes('[sync]')).pop()
  console.log(line || out.trim().slice(0, 300))
} catch (e) {
  console.error('[本子] 上传失败：' + (e instanceof Error ? e.message.slice(0, 200) : String(e)))
  process.exitCode = 1
} finally {
  if (!指定暂存 && existsSync(暂存)) rmSync(暂存, { recursive: true, force: true })
}
