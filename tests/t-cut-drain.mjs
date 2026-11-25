import assert from 'node:assert'
import { pathToFileURL } from 'node:url'

const target = process.argv[2]
if (!target) {
  console.error('用法: node t-cut-drain.mjs <plan.js 路径>')
  process.exit(2)
}
const { selectCutIndexes } = await import(pathToFileURL(target).href)

// 1. 纯聊天尾巴（walkOffTail 回归）
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
assert.ok(picked.start > 0 && picked.end >= picked.start && picked.end < chat.length, '切点范围合法')

// 2. 没到阈值不该切
assert.equal(selectCutIndexes(chat, {
  engine: 'cloud', chunkMin: 1000, chunkMax: 32000, pointerMax: 32000,
  maxEnd: chat.length - 1, totalTokens: 12000, drain: false, urgentTokens: 48000,
}), null)

// 3. 带工具轮：验证不拆散 assistant(toolCalls) 与 tool
const tools = [{ type: 'system', tokens: 4000 }]
for (let i = 0; i < 10; i += 1) {
  tools.push({ type: 'user', tokens: 300 })
  tools.push({ type: 'assistant', tokens: 200, toolCalls: 1 })
  tools.push({ type: 'tool', tokens: 3000 })
  tools.push({ type: 'assistant', tokens: 300 })
}
const toolPick = selectCutIndexes(tools, {
  engine: 'cloud', chunkMin: 1000, chunkMax: 32000, pointerMax: 32000,
  maxEnd: tools.length - 1, totalTokens: 40000, drain: true, urgentTokens: 48000,
})
assert.ok(toolPick, '带工具轮的尾巴也要有切点')
assert.notEqual(tools[toolPick.start].type, 'tool', '起点不能落在孤立 tool 消息上')
assert.ok(!(tools[toolPick.end].type === 'assistant' && tools[toolPick.end].toolCalls), '终点不能拆散 toolCalls 与 tool')

// 4. 边界：仅 system 消息或空数组不得越界崩溃
assert.equal(selectCutIndexes([{ type: 'system', tokens: 4000 }], {
  engine: 'cloud', chunkMin: 1000, chunkMax: 32000, pointerMax: 32000,
  maxEnd: 0, totalTokens: 4000, drain: true, urgentTokens: 48000,
}), null)
assert.equal(selectCutIndexes([], {
  engine: 'cloud', chunkMin: 1000, chunkMax: 32000, pointerMax: 32000,
  maxEnd: -1, totalTokens: 0, drain: true, urgentTokens: 48000,
}), null)

console.log('cut 逻辑 ok（含工具轮配对、越界防护与边界检查）')
