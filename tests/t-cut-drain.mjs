import assert from 'node:assert'
import { pathToFileURL } from 'node:url'

const target = process.argv[2]
if (!target) {
  console.error('用法: node t-cut-drain.mjs <plan.js 路径>')
  process.exit(2)
}
const { selectCutIndexes } = await import(pathToFileURL(target).href)

// 会踩到 walkOffTail：纯聊天尾巴（全是短 user + assistant，没有工具轮）
const chat = [{ type: 'system', tokens: 4000 }]
for (let i = 0; i < 40; i += 1) {
  chat.push({ type: 'user', tokens: 200 })
  chat.push({ type: 'assistant', tokens: 400 })
}
const chatTotal = chat.reduce((a, b) => a + b.tokens, 0)
const picked = selectCutIndexes(chat, {
  engine: 'cloud', chunkMin: 1000, chunkMax: 32000, pointerMax: 32000,
  maxEnd: chat.length - 1, totalTokens: chatTotal, drain: true, urgentTokens: 48000,
})
assert.ok(picked, '纯聊天尾巴在 drain 时必须有切点')
assert.ok(picked.start > 0, '不能切到 system 前面')

// 没到线不该切
assert.equal(selectCutIndexes(chat, {
  engine: 'cloud', chunkMin: 1000, chunkMax: 32000, pointerMax: 32000,
  maxEnd: chat.length - 1, totalTokens: 12000, drain: false, urgentTokens: 48000,
}), null)

// 带工具轮
const tools = [{ type: 'system', tokens: 4000 }]
for (let i = 0; i < 10; i += 1) {
  tools.push({ type: 'user', tokens: 300 })
  tools.push({ type: 'assistant', tokens: 200, toolCalls: 1 })
  tools.push({ type: 'tool', tokens: 3000 })
  tools.push({ type: 'assistant', tokens: 300 })
}
assert.ok(selectCutIndexes(tools, {
  engine: 'cloud', chunkMin: 1000, chunkMax: 32000, pointerMax: 32000,
  maxEnd: tools.length - 1, totalTokens: 40000, drain: true, urgentTokens: 48000,
}), '带工具轮的尾巴也要有切点')

console.log('cut 逻辑 ok')
