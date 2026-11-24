/**
 * 批次 647：只有工具回执、没有一句对话的 folder 不进召回块。
 *
 * 线上只读统计（2026-11-17 12:00，`memory/sessions` 全库）：
 *   5542 个 folder 里 1433 个只有 tool 消息、user/assistant 一句都没有，
 *   共 169.6 万字（占全部归档字符 31%）。它们是 638 之前归档工具原文留下的，
 *   召回时整段是命令输出/报错栈/网页正文。
 *
 * 这里只锁判据本身（纯函数），并确认 engine 真的调它。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const 根 = (() => {
  const 指定 = String(process.env.QQ_ROFM_DIR ?? '').trim()
  if (指定 !== '') return 指定
  const 默认 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm'
  return existsSync(path.join(默认, 'engine', 'only-tool-receipts.js')) ? 默认 : ''
})()
const 可用 = 根 !== ''
const 跳过 = '找不到 dsh-rofm 的 engine/only-tool-receipts.js'

const 载入 = 可用 ? await import(pathToFileURL(path.join(根, 'engine', 'only-tool-receipts.js')).href) : null

test('T1 只有 tool 消息 → 判为空壳', { skip: 可用 ? false : 跳过 }, () => {
  assert.equal(载入.只有工具回执([{ role: 'tool' }, { role: 'tool' }]), true)
})

test('T2 只要有一句人话就照常召回（判据要窄）', { skip: 可用 ? false : 跳过 }, () => {
  assert.equal(载入.只有工具回执([{ role: 'tool' }, { role: 'user' }]), false)
  assert.equal(载入.只有工具回执([{ role: 'assistant' }, { role: 'tool' }]), false)
})

test('T3 空数组不在这里判（交给原来的缺档处理）', { skip: 可用 ? false : 跳过 }, () => {
  assert.equal(载入.只有工具回执([]), false)
  assert.equal(载入.只有工具回执(null), false)
})

test('T4 system/developer 不算对话（它们不是谁说过的话）', { skip: 可用 ? false : 跳过 }, () => {
  assert.equal(载入.只有工具回执([{ role: 'system' }, { role: 'tool' }]), true)
  assert.equal(载入.只有工具回执([{ role: 'developer' }]), true)
})

test('T5 脏数据不崩', { skip: 可用 ? false : 跳过 }, () => {
  assert.equal(载入.只有工具回执([null, undefined, {}, { role: 123 }]), true)
})

test('T6 engine/recall.js 真的调了这个判据', { skip: 可用 ? false : 跳过 }, () => {
  const 源 = readFileSync(path.join(根, 'engine', 'recall.js'), 'utf8')
  assert.match(源, /only-tool-receipts\.js/, 'engine 没 import 判据')
  // 661 之后装填前要先保留原文（rawMessages）给截断逻辑用，这里只锁「真的调了」，
  // 不再绑定具体变量名，否则改个局部变量名就会误报。
  assert.match(源, /只有工具回执\(/, 'engine 没在装填前调用判据')
})
