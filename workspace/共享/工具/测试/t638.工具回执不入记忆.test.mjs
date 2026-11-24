/**
 * 批次 638：工具回执不进长期记忆。
 *
 * 背景：rofm 的压缩归档（lib/surface.js buildSurfaceEntries）原来把 role='tool'
 * 的消息原样写进记忆 folder，线上 5542 个 folder 里 4078 个含工具回执，
 * 回执正文占全部归档字符的 44.6%（2026-11-17 只读统计）。
 * 被召回时那些 JSON/报错栈会被当成「她经历过的事」，也是提示注入面。
 *
 * 现在的口径：
 * - tool 消息仍然留在 entries 里（seq 不能丢，压缩切段和 tool-call 配对检查都靠它）；
 * - 归档文本换成「（工具名 回执：前 40 字…；正文不入长期记忆）」；
 * - user / assistant 文本一个字都不动；
 * - options.toolReceipts=false 保留旧行为（兼容开关）。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const 候选根 = String(process.env.QQ_ROFM_DIR ?? '').trim() === ''
  ? ['{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm']
  : [String(process.env.QQ_ROFM_DIR).trim()]
const 根 = 候选根.find((dir) => existsSync(path.join(dir, 'lib', 'surface.js'))) ?? ''
const 可用 = 根 !== ''
const 跳过原因 = '找不到 dsh-rofm（设置 QQ_ROFM_DIR 指向插件目录）'

const 载入 = 可用 ? await import(pathToFileURL(path.join(根, 'lib', 'surface.js')).href) : null

function 造会话(消息列表) {
  const 事件 = new Map()
  const 节点 = []
  for (let i = 0; i < 消息列表.length; i += 1) {
    const seq = i + 1
    节点.push(seq)
    事件.set(seq, { type: 'message', time: 1_790_000_000_000 + i * 1000, message: 消息列表[i] })
  }
  return {
    id: 'session-t638',
    surface: { nodes: 节点 },
    eventAt: (seq) => 事件.get(seq),
    deriveEventMessage: (event) => event.message,
  }
}

const 用户 = (text) => ({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] })
const 助手 = (text) => ({ role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text }] })
const 回执 = (名字, text) => ({
  role: 'tool',
  source: { kind: 'tool', callId: 'call-1' },
  toolCallId: 'call-1',
  content: [{ type: 'text', text }],
  toolName: 名字,
})

const 量 = { nodes: [] }

test('T1 工具回执正文不进归档，只留工具名和短预览', { skip: 可用 ? false : 跳过原因 }, () => {
  const 长文本 = `HTTP/1.1 200 OK ${'X'.repeat(5000)}`
  const 会话 = 造会话([用户('看看'), 回执('web_search', 长文本), 助手('看到了')])
  const 条目 = 载入.buildSurfaceEntries(会话, 量)
  assert.equal(条目.length, 3, 'tool 消息必须仍留在 entries 里（seq/配对检查要用）')
  const 工具条 = 条目[1]
  assert.equal(工具条.role, 'tool')
  assert.ok(!工具条.text.includes('X'.repeat(100)), '正文不能进归档文本')
  assert.ok(工具条.text.includes('web_search'), '要记下是哪个工具')
  assert.ok(工具条.text.includes('正文不入长期记忆'))
  assert.ok(工具条.text.length <= 80, `回执文本要短，实际 ${工具条.text.length} 字`)
})

test('T2 用户和助手原话一个字都不动', { skip: 可用 ? false : 跳过原因 }, () => {
  const 会话 = 造会话([用户('看看'), 回执('qq_send', '已发到 QQ'), 助手('嗯，发了')])
  const 条目 = 载入.buildSurfaceEntries(会话, 量)
  assert.equal(条目[0].text, '看看')
  assert.equal(条目[2].text, '嗯，发了')
})

test('T3 取不到工具名时退化成「工具」而不是报错', { skip: 可用 ? false : 跳过原因 }, () => {
  const 会话 = 造会话([{ role: 'tool', source: { kind: 'tool' }, content: [{ type: 'text', text: 'done' }] }])
  const 条目 = 载入.buildSurfaceEntries(会话, 量)
  assert.equal(条目.length, 1)
  assert.ok(条目[0].text.startsWith('（工具 回执'))
})

test('T4 token 记账仍按真实正文算，压缩收益不能缩水', { skip: 可用 ? false : 跳过原因 }, () => {
  const 正文 = 'Y'.repeat(4000)
  const 会话 = 造会话([回执('shell', 正文)])
  const 条目 = 载入.buildSurfaceEntries(会话, 量)
  assert.ok(条目[0].tokens >= 900, `tokens 应按原文估算（${条目[0].tokens}）`)
  assert.ok(条目[0].text.length < 100)
})

test('T5 toolReceipts=false 保留旧行为（必要时一键回滚）', { skip: 可用 ? false : 跳过原因 }, () => {
  const 会话 = 造会话([回执('qq_send', '已发到 QQ，message_id=1')])
  const 条目 = 载入.buildSurfaceEntries(会话, 量, { toolReceipts: false })
  assert.equal(条目[0].text, '已发到 QQ，message_id=1')
})
