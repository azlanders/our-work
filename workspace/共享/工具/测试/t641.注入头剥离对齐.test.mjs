/**
 * 批次 641：rofm 归档时的注入头剥离，跟 hippocampus 对齐。
 *
 * 群聊/私聊投递前，桥会在正文最前面拼一串系统提示：
 *   （提示：这张图没配文字…）、（模式：工程）、（提醒：…）、（身份：…）、（未读…）
 * hippocampus 的 injected-prefix.mjs 一直认这些前缀，rofm 的 surface.js 只认
 * 「你现在的状态/关于他/群里说的…」这几条 —— 于是群提示被当成「他说过的话」归档，
 * 下次召回就变成他自己的记忆。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const 根 = (() => {
  const 指定 = String(process.env.QQ_ROFM_DIR ?? '').trim()
  if (指定 !== '') return 指定
  const 默认 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm'
  return existsSync(path.join(默认, 'lib', 'surface.js')) ? 默认 : ''
})()
const 可用 = 根 !== ''
const 跳过原因 = '找不到 dsh-rofm（设置 QQ_ROFM_DIR 指向插件目录）'

const 载入 = 可用 ? await import(pathToFileURL(path.join(根, 'lib', 'surface.js')).href) : null

const 归档文本 = (text) => {
  const 消息 = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
  const 会话 = {
    id: 'session-t641',
    surface: { nodes: [1] },
    eventAt: () => ({ type: 'user/message', time: 1_790_000_000_000, message: 消息 }),
    deriveEventMessage: (event) => event.message,
  }
  const 条目 = 载入.buildSurfaceEntries(会话, { nodes: [] })
  return 条目.length === 0 ? '' : 条目[0].text
}

test('T1 群聊「提示：」前缀不进记忆', { skip: 可用 ? false : 跳过原因 }, () => {
  assert.equal(归档文本('（提示：这张图没配文字、也没点你名。看一眼就够了。）\n今天好累'), '今天好累')
})

test('T2 模式/提醒/身份/未读 都算注入头', { skip: 可用 ? false : 跳过原因 }, () => {
  assert.equal(归档文本('（模式：工程）\n把配置改回来'), '把配置改回来')
  assert.equal(归档文本('（提醒：别解释。）\n嗯'), '嗯')
  assert.equal(归档文本('（身份：主人）\n在吗'), '在吗')
  assert.equal(归档文本('（未读：3 条）\n刚回来'), '刚回来')
})

test('T3 连续多个注入头要一层层剥干净', { skip: 可用 ? false : 跳过原因 }, () => {
  assert.equal(归档文本('（你现在的状态：此刻 11:15）\n（提示：这张图没配文字。）\n[11:15] 在吗'), '在吗')
})

test('T4 他自己打的括号不许剥', { skip: 可用 ? false : 跳过原因 }, () => {
  assert.equal(归档文本('（笑）我在呢'), '（笑）我在呢')
  assert.equal(归档文本('（顺便说一下）晚安'), '（顺便说一下）晚安')
})

test('T5 老式群聊节奏标记也剥掉', { skip: 可用 ? false : 跳过原因 }, () => {
  assert.equal(归档文本('[群聊节奏] 刷屏\n（提示：没点你名。）\n我先睡'), '我先睡')
})

test('T6 只剩注入头时不留空壳记忆', { skip: 可用 ? false : 跳过原因 }, () => {
  assert.equal(归档文本('（提示：这张图没配文字。）'), '')
})
