// 批次663（审计 P1-8）：自动回忆不许挂在「状态进正文」开关下
//   那个开关管的是「状态提示放正文还是 system」，关掉它不该让回忆一起消失，
//   而且原来的位置在 慢变段() 里，日志也不会说一句「回忆被开关关掉」。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const lib = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const pollPath = path.join(lib, 'poll.js')
const 可用 = existsSync(pollPath)
const 跳过 = '找不到 poll.js'
const 源 = 可用 ? readFileSync(pollPath, 'utf8') : ''

test('P1 自动回忆有独立入口，不再埋在 慢变段 里', { skip: 可用 ? false : 跳过 }, () => {
  assert.match(源, /function 自动回忆条\(t\)/, '缺少独立入口')
  const 慢起 = 源.indexOf('function 慢变段(t) {')
  assert.ok(慢起 > 0)
  let i = 源.indexOf('{', 慢起)
  let dep = 0
  let 慢终 = -1
  for (; i < 源.length; i++) {
    if (源[i] === '{') dep++
    else if (源[i] === '}') { dep--; if (dep === 0) { 慢终 = i + 1; break } }
  }
  assert.ok(慢终 > 慢起)
  assert.ok(!源.slice(慢起, 慢终).includes('自动回忆段'), '慢变段里还留着回忆调用')
})

test('P2 私聊调用点在「状态进正文」的 if 之外', { skip: 可用 ? false : 跳过 }, () => {
  const 调 = 源.indexOf('const 忆 = 自动回忆条({ peer: String(uin')
  assert.ok(调 > 0, '私聊没有独立调用')
  // 找调用点之前最近的一次 `if (config.状态进正文 === true) {`，再看它的块是否已经闭合。
  const 前 = 源.slice(0, 调)
  const ifPos = 前.lastIndexOf('if (config.状态进正文 === true) {')
  assert.ok(ifPos > 0)
  let i = 源.indexOf('{', ifPos)
  let dep = 0
  let 闭合 = -1
  for (; i < 源.length; i++) {
    if (源[i] === '{') dep++
    else if (源[i] === '}') { dep--; if (dep === 0) { 闭合 = i; break } }
  }
  assert.ok(闭合 > 0 && 闭合 < 调, '回忆调用还在开关块里面')
})

test('P3 群聊刻意不注入（结构上不接，不靠内部判权限）', { skip: 可用 ? false : 跳过 }, () => {
  assert.ok(!/自动回忆条\(\{ peer: String\(groupId/.test(源), '群聊不该调自动回忆')
})

test('P4 回忆仍然只在主人私聊生效', { skip: 可用 ? false : 跳过 }, () => {
  assert.match(源, /isPrivate !== true \|\| owner === '' \|\| peer !== owner/)
})

test('P5 命中时有日志，能定位到底注入了什么', { skip: 可用 ? false : 跳过 }, () => {
  assert.match(源, /note\('recall', '自动回忆命中：'/)
})
