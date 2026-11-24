// 批次581：主动戳.mjs 的 --user 必须是私聊戳，不能偷偷发到默认群
//
// 真 bug（2026-11-16 21:15）：她用 `--force --user {{OWNER_UIN}}` 戳主人，
// 脚本回「戳了」，但实际发的是群 1051483012 的拍一拍；私聊那边什么都没收到。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const 脚本 = '{{BOT_ROOT}}/共享/工具/主动戳.mjs'
const 演练 = (...args) => execFileSync(process.execPath, [脚本, '--dry', '--force', ...args], {
  encoding: 'utf8',
  timeout: 10000,
})

test('P1 带 --user 不带 --group = 私聊戳', () => {
  const out = 演练('--user', '{{OWNER_UIN}}')
  assert.ok(out.includes('私聊戳'), out)
  assert.ok(!out.includes('group='), out)
})

test('P2 带 --group = 群里戳', () => {
  const out = 演练('--group', '1051483012', '--user', '{{OWNER_UIN}}')
  assert.ok(out.includes('群里戳'), out)
  assert.ok(out.includes('group=1051483012'), out)
})
