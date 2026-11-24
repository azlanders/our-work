// 批次661（审计 P1-6）：旧混合 folder 里的工具回执，召回时要按读侧截断
//   638 只压新归档，647 只跳纯工具 folder；
//   「一句人话 + 五千字报错栈」的旧 folder 仍会整段进召回块，挤掉真正的对话预算。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs, { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const 根 = (() => {
  const 指定 = String(process.env.QQ_ROFM_DIR ?? '').trim()
  if (指定 !== '') return 指定
  const 默认 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm'
  return existsSync(path.join(默认, 'engine', 'tool-receipt.js')) ? 默认 : ''
})()
const 可用 = 根 !== ''
const 跳过 = '找不到 dsh-rofm 的 engine/tool-receipt.js'

const engine = 可用 ? await import(pathToFileURL(path.join(根, 'engine', 'recall.js')).href) : null
const store = 可用 ? await import(pathToFileURL(path.join(根, 'engine', 'store.js')).href) : null
const receipt = 可用 ? await import(pathToFileURL(path.join(根, 'engine', 'tool-receipt.js')).href) : null
const 选项 = 可用 ? false : 跳过

const 临时库 = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rofm661-'))
const 长报错 = 'Error: boom\n' + 'at foo (/a/b.js:1:1)\n'.repeat(200) + '结束标记'

test('T1 混合 folder：人话保留，工具回执压成一行', { skip: 选项 }, () => {
  const dir = 临时库()
  store.writeFolder(dir, {
    id: '000001', meta: { createdAt: 1_700_000_000_000, stats: { messages: 2, chars: 99999, tokens: 99999 } },
    messages: [
      { role: 'user', content: '帮我看看这个报错' },
      { role: 'tool', content: 长报错, toolName: 'bash' },
      { role: 'assistant', content: '是路径写错了' },
    ],
  })
  const out = engine.loadRecallAdditions([{ folder: { id: '000001' } }], { memoryDir: dir, warnings: [] })
  assert.equal(out.length, 1)
  const msgs = out[0].messages
  assert.equal(msgs[0].content, '帮我看看这个报错', '人话不许动')
  assert.equal(msgs[2].content, '是路径写错了', '人话不许动')
  assert.ok(msgs[1].content.includes('bash'), '要带工具名')
  assert.ok(msgs[1].content.includes('正文不入长期记忆'), '要标出是回执')
  assert.ok(msgs[1].content.length < 120, `回执应压短，实际 ${msgs[1].content.length}`)
  assert.ok(!msgs[1].content.includes('结束标记'), '正文细节不该进召回')
})

test('T2 截断后 chars/tokens 按正文重算，不再沿用 meta 的全文旧数', { skip: 选项 }, () => {
  const dir = 临时库()
  store.writeFolder(dir, {
    id: '000002', meta: { createdAt: 1_700_000_000_000, stats: { messages: 2, chars: 99999, tokens: 99999 } },
    messages: [
      { role: 'user', content: '看看' },
      { role: 'tool', content: 长报错, toolName: 'bash' },
    ],
  })
  const out = engine.loadRecallAdditions([{ folder: { id: '000002' } }], { memoryDir: dir, warnings: [] })
  assert.ok(out[0].chars < 500, `chars 应重算，实际 ${out[0].chars}`)
  assert.ok(out[0].tokens < 500, `tokens 应重算，实际 ${out[0].tokens}`)
})

test('T3 已经是预览形态的回执不重复包装', { skip: 选项 }, () => {
  const dir = 临时库()
  const 已压 = '（bash 回执：Error: boom；正文不入长期记忆）'
  store.writeFolder(dir, {
    id: '000003', meta: { createdAt: 1_700_000_000_000 },
    messages: [
      { role: 'user', content: '嗯' },
      { role: 'tool', content: 已压, toolName: 'bash' },
    ],
  })
  const out = engine.loadRecallAdditions([{ folder: { id: '000003' } }], { memoryDir: dir, warnings: [] })
  assert.equal(out[0].messages[1].content, 已压)
})

test('T4 纯工具 folder 仍然整块跳过（回归 647）', { skip: 选项 }, () => {
  const dir = 临时库()
  store.writeFolder(dir, {
    id: '000004', meta: { createdAt: 1_700_000_000_000 },
    messages: [{ role: 'tool', content: 长报错, toolName: 'bash' }],
  })
  const warnings = []
  const out = engine.loadRecallAdditions([{ folder: { id: '000004' } }], { memoryDir: dir, warnings })
  assert.equal(out.length, 0)
  assert.ok(warnings.some((w) => w.includes('tool-only')))
})

test('T5 读侧不改盘上数据：folder 原文仍完整', { skip: 选项 }, () => {
  const dir = 临时库()
  store.writeFolder(dir, {
    id: '000005', meta: { createdAt: 1_700_000_000_000 },
    messages: [
      { role: 'user', content: '看看' },
      { role: 'tool', content: 长报错, toolName: 'bash' },
    ],
  })
  engine.loadRecallAdditions([{ folder: { id: '000005' } }], { memoryDir: dir, warnings: [] })
  const 盘上 = store.readFolder(dir, '000005')
  assert.ok(盘上.messages[1].content.includes('结束标记'), '盘上必须是原文')
})

test('T6 写入侧与读侧共用同一份截断规则', { skip: 选项 }, () => {
  const text = receipt.toolReceiptText({ toolName: 'qq_recall' }, 'x'.repeat(500))
  assert.ok(text.includes('qq_recall'))
  assert.ok(text.includes('正文不入长期记忆'))
  assert.ok(text.length < 120)
})
