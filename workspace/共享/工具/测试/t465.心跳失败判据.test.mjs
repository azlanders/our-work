// t465 心跳的失败判据：被信号杀死、起不来，都不能算成功
//
// 起因（批次465）：`坏 = 超时 || (typeof r.status === 'number' && r.status !== 0)`。
// 子进程被 OOM / 外部 kill 时 status 是 null、signal 有值 → 判成功，还会把连败账归零。
// 这类失败最难受的地方是「台账上永远健康」，所以必须有测试钉住。
//
// 跑法：node --test t465.心跳失败判据.test.mjs
// 全程在 mkdtemp 沙盒里，FISH_SANDBOX_DIR / QQ_LOCK_DIR 都指到沙盒，不碰真档。

process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const 心跳 = join(工具, '心跳.mjs')
const 探测 = join(工具, '探测上游.mjs')

const 读 = (p) => readFileSync(p, 'utf8')

test('A1 源码里三种失败都要判：超时 / 被信号 / 起不来', () => {
  const s = 读(心跳)
  assert.ok(/const 被信号 = !超时 && r\.status === null && !!r\.signal/.test(s),
    '没有「被信号杀死」这一条 —— OOM 杀掉的任务会被记成成功')
  assert.ok(/const 起不来 = !超时 && !!r\.error/.test(s),
    '没有「spawn 起不来」这一条')
  assert.ok(/const 坏 = 超时 \|\| 被信号 \|\| 起不来 \|\|/.test(s),
    '坏 的判据没把 被信号 / 起不来 串进去')
})

test('A2 端到端：任务自杀（SIGKILL）必须记失败，且原因写清是被信号杀的', () => {
  const 沙 = mkdtempSync(join(tmpdir(), 't465-'))
  try {
    const 记忆 = join(沙, '记忆')
    mkdirSync(记忆, { recursive: true })
    const 自杀 = join(沙, '自杀.mjs')
    writeFileSync(自杀, "process.kill(process.pid, 'SIGKILL')\n", 'utf8')
    const 表 = join(沙, '心跳表.json')
    writeFileSync(表, JSON.stringify([
      { 名: '自杀任务', 脚本: 自杀, 参数: [], 间隔分: 1, 偏移分: 0, 睡着跑: true },
    ]), 'utf8')

    execFileSync(process.execPath, [心跳, '--tick', '--表', 表], {
      cwd: 沙,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, FISH_SANDBOX_DIR: 记忆, QQ_LOCK_DIR: join(沙, 'lock'), 心跳_超时毫秒: '8000' },
    })

    const 日志路径 = join(记忆, '日志', '心跳.log')
    assert.ok(existsSync(日志路径), '心跳没写日志，路径可能变了')
    const 日志 = 读(日志路径)
    assert.ok(/\[失败\] 自杀任务/.test(日志), '任务被 SIGKILL 杀掉，心跳却没记失败：\n' + 日志)
    assert.ok(/被信号 SIGKILL 杀掉/.test(日志), '失败原因没写「被信号」：\n' + 日志)
  } finally { rmSync(沙, { recursive: true, force: true }) }
})

test('A3 端到端：正常退出仍是成功，不许被误判', () => {
  const 沙 = mkdtempSync(join(tmpdir(), 't465-'))
  try {
    const 记忆 = join(沙, '记忆')
    mkdirSync(记忆, { recursive: true })
    const 好 = join(沙, '正常.mjs')
    writeFileSync(好, "process.exit(0)\n", 'utf8')
    const 表 = join(沙, '心跳表.json')
    writeFileSync(表, JSON.stringify([
      { 名: '正常任务', 脚本: 好, 参数: [], 间隔分: 1, 偏移分: 0, 睡着跑: true },
    ]), 'utf8')

    execFileSync(process.execPath, [心跳, '--tick', '--表', 表], {
      cwd: 沙,
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, FISH_SANDBOX_DIR: 记忆, QQ_LOCK_DIR: join(沙, 'lock'), 心跳_超时毫秒: '8000' },
    })

    const 日志 = existsSync(join(记忆, '日志', '心跳.log')) ? 读(join(记忆, '日志', '心跳.log')) : ''
    assert.ok(!/\[失败\] 正常任务/.test(日志), '退出码 0 被误判成失败：\n' + 日志)
  } finally { rmSync(沙, { recursive: true, force: true }) }
})

test('A4 探测上游的单次超时必须落在心跳预算内（3 次串行 < 25 秒）', () => {
  const 探 = 读(探测)
  const m = 探.match(/AbortSignal\.timeout\((\d+)\)/)
  assert.ok(m, '探测上游里找不到 AbortSignal.timeout(N)')
  const 单次 = Number(m[1])
  const 默认 = Number((读(心跳).match(/心跳_超时毫秒\) \|\| (\d+)/) || [])[1])
  assert.ok(默认 > 0, '读不到心跳默认超时')
  assert.ok(单次 <= 默认 / 3, `单次 ${单次}ms × 3 = ${单次 * 3}ms，超过心跳预算 ${默认}ms —— 探针会被砍在半路，状态档写不进去，切官方的兜底永远不触发`)
  assert.ok(单次 >= 3000, `单次 ${单次}ms 太紧（实测单次 0.6~1.0 秒），正常上游也会被误判成连不上`)
  assert.ok(!/timeout\(150000\)/.test(探), '又退回 150 秒了')
})
