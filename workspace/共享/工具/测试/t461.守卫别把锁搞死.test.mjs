// t461.守卫别把锁搞死.test.mjs —— 批次461（2026-11-14）
//
// 这一条是「写入画像」跑出来的：把心跳表 52 条任务逐个挂在沙盒守卫下跑，
// 契约检查忽然报「底座自检：退出码 1」。查下去是 自检 抛 `文件锁超时：自主.json`。
//
// 根因：`_锁.mjs` 用 `mkdirSync(锁目录)` 当原子锁、`rmdirSync` 解锁。
// 我在 457 写守卫时把 writeFile/appendFile/rename/rm/unlink 都包了，**唯独漏了 rmdirSync**
// ——于是锁目录建到沙盒里、解锁删的是真路径（ENOENT），沙盒里的锁永远不释放，第二次加锁必超时。
//
// 这类漏 API 不会报错，只会让「加锁的脚本在守卫下一律卡死」。
// 这条测试就钉：mkdir 锁能在守卫下 加→解→再加。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const T = '{{BOT_ROOT}}/共享/工具/测试'
const 守卫 = path.join(T, '沙盒守卫.mjs')
const 源 = fs.readFileSync(守卫, 'utf8')

test('A1 守卫必须包住 rmdirSync（mkdir 锁的解锁就是它）', () => {
  assert.ok(/包\('rmdirSync', 0\)/.test(源), '守卫没包 rmdirSync —— mkdir 锁在守卫下会死锁')
})

test('A2 沙盒里的锁：加→解→再加 不超时', () => {
  const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard461-'))
  const 真锁 = '{{BOT_ROOT}}/记忆/.locks/__t461.lock'
  const 码 = `
    const fs = await import('node:fs')
    const 锁 = ${JSON.stringify(真锁)}
    const 试 = (n) => {
      try { fs.mkdirSync(锁); fs.rmdirSync(锁); return n + ':ok' } catch (e) { return n + ':fail:' + e.code }
    }
    console.log(试(1) + ' ' + 试(2) + ' ' + 试(3))
    console.log('真档里有锁吗=' + fs.existsSync(锁))
  `
  try {
    const 出 = execFileSync(process.execPath, ['--input-type=module', '-e', 码], {
      encoding: 'utf8', timeout: 30000,
      env: {
        ...process.env,
        NODE_OPTIONS: '--import ' + pathToFileURL(守卫).href,
        SMOKE_GUARD_SANDBOX: 沙, SMOKE_GUARD_LOG: path.join(沙, 'w.log'), SMOKE_GUARD_TAG: 't461',
      },
    })
    assert.ok(/1:ok 2:ok 3:ok/.test(出), '三次加锁解锁不是全 ok（锁没释放）：' + 出.trim())
    assert.ok(/真档里有锁吗=false/.test(出), '真档里留下了锁目录：' + 出.trim())
  } finally {
    try { fs.rmdirSync(真锁) } catch {}
    fs.rmSync(沙, { recursive: true, force: true })
  }
})

test('A3 契约检查在守卫下必须和裸跑一样绿（守卫不能改变结论）', () => {
  const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard461-'))
  try {
    const 出 = execFileSync('/usr/local/bin/node', ['{{BOT_ROOT}}/共享/工具/契约检查.mjs'], {
      encoding: 'utf8', timeout: 300000,
      env: {
        ...process.env,
        NODE_OPTIONS: '--import ' + pathToFileURL(守卫).href,
        SMOKE_GUARD_SANDBOX: 沙, SMOKE_GUARD_LOG: path.join(沙, 'w.log'), SMOKE_GUARD_TAG: 't461',
      },
    })
    const m = 出.match(/契约检查：(\d+) 项通过 \/ (\d+) 项不对/)
    assert.ok(m, '契约输出格式变了：' + 出.slice(-200))
    assert.equal(Number(m[2]), 0, '守卫下契约有不对项（守卫把某个检查搞红了）：' + 出.slice(-400))
  } finally { fs.rmSync(沙, { recursive: true, force: true }) }
})
