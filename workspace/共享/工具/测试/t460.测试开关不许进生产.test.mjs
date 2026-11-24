// t460.测试开关不许进生产.test.mjs —— 批次460（2026-11-14）
//
// 起因：457/459 加的沙盒守卫是靠环境变量生效的（`SMOKE_GUARD_SANDBOX`）。
// 一旦这个变量出现在生产单元或 env 文件里，她的每一次写都会被**静默改道**到沙盒：
// 服务还 active、日志还干净、面板还显示「已更新」，可真档永远不动。
// 这比「服务跑旧代码」更隐蔽 —— 那个至少 mtime 能看出来，这个连 mtime 都不动。
//
// 所以钉住三件事：① 生产单元环境干净；② /etc/dshbot.env 干净；③ 生产代码不 import 沙盒守卫。
// 契约检查里也有同样三项（这里是独立的第二道，免得哪天契约那一段被人删了没人发现）。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 契约 = fs.readFileSync(path.join(TOOLS, '契约检查.mjs'), 'utf8')
const 禁词 = ['SMOKE_GUARD_SANDBOX', 'SMOKE_GUARD_ROOT', 'SMOKE_GUARD_LOG', 'SMOKE_NO_MODEL', 'QUIET_NOTE']

test('A1 契约检查里确实有这三项', () => {
  assert.ok(契约.includes('生产单元里没有测试开关'), '契约里没有「生产单元」这项')
  assert.ok(契约.includes('env 文件里没有测试开关'), '契约里没有「env 文件」这项')
  assert.ok(契约.includes('生产代码不引用沙盒守卫'), '契约里没有「生产代码」这项')
})

test('A2 契约检查真跑一遍：640 项左右、0 不对', () => {
  const 出 = execFileSync('/usr/local/bin/node', [path.join(TOOLS, '契约检查.mjs')],
    { encoding: 'utf8', timeout: 300000 })
  const m = 出.match(/契约检查：(\d+) 项通过 \/ (\d+) 项不对/)
  assert.ok(m, '契约输出格式变了：' + 出.slice(-200))
  assert.equal(Number(m[2]), 0, '契约有不对项：' + 出.slice(-400))
  assert.ok(Number(m[1]) >= 640, '契约项数掉到 ' + m[1] + '（原来 640）—— 有检查被删了')
})

test('A3 独立复算：/etc/dshbot.env 里没有测试开关', () => {
  const 文 = fs.readFileSync('/etc/dshbot.env', 'utf8')
  const 行 = 文.split('\n').filter((l) => !l.trim().startsWith('#'))
  const 脏 = 禁词.filter((k) => 行.some((l) => l.includes(k)))
  assert.deepEqual(脏, [], '/etc/dshbot.env 里出现了测试开关：' + 脏.join('、'))
})

test('A4 生产单元的环境变量里也没有（直接问 systemctl）', () => {
  const 脏 = []
  for (const 单元 of ['dsh-bot', 'fish-panel', 'fish-music']) {
    let 环境 = ''
    try {
      环境 = execFileSync('systemctl', ['show', 单元, '-p', 'Environment', '-p', 'EnvironmentFile', '--value'],
        { encoding: 'utf8', timeout: 5000 })
    } catch { 脏.push(单元 + '(读不到)'); continue }
    if (!环境.trim()) continue
    const 命中 = 禁词.filter((k) => 环境.includes(k))
    if (命中.length) 脏.push(单元 + '(' + 命中.join('+') + ')')
  }
  assert.deepEqual(脏, [], '这些单元带着测试开关：' + 脏.join('、'))
})
