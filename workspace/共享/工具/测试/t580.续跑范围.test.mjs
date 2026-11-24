// 批次580：实时续跑的「本回合工具」必须按 seq 裁区间
//
// 真 bug：events 是「从 scanFrom 起的一整段历史」，原来只判 type==='tool/call'，
// 前几轮的 bash / web_search 会一直被算进「这一轮」→ 干过活永远为 true →
// 每轮都多推一次「接着做」，白烧一整轮模型时间，出站队列也一直等 turn/end。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 本回合工具, 在回合内 } = await import(LIB + '/实时续跑.js')

test('R1 旧回合的 bash 不许污染本回合', () => {
  const events = [
    { type: 'tool/call', seq: 5, data: { name: 'bash' } },
    { type: 'tool/call', seq: 12, data: { name: 'qq_send' } },
  ]
  assert.deepEqual(本回合工具(events, 10, 20), ['qq_send'])
})

test('R2 本回合真干过活要留下（不能把正常续跑关掉）', () => {
  const events = [
    { type: 'tool/call', seq: 5, data: { name: 'bash' } },
    { type: 'tool/call', seq: 12, data: { name: 'qq_send' } },
    { type: 'tool/call', seq: 15, data: { name: 'web_search' } },
  ]
  assert.deepEqual(本回合工具(events, 10, 20), ['qq_send', 'web_search'])
})

test('R3 边界：seq=from 和 seq=end 都不算本回合', () => {
  const events = [
    { type: 'tool/call', seq: 10, data: { name: 'bash' } },
    { type: 'tool/call', seq: 20, data: { name: 'bash' } },
  ]
  assert.deepEqual(本回合工具(events, 10, 20), [])
  assert.equal(在回合内({ seq: 10 }, 10, 20), false)
  assert.equal(在回合内({ seq: 20 }, 10, 20), false)
  assert.equal(在回合内({ seq: 11 }, 10, 20), true)
})

test('R4 from/end 缺失时退回全收（老调用方不被误伤）', () => {
  const events = [
    { type: 'tool/call', seq: 1, data: { name: 'bash' } },
    { type: 'tool/call', seq: 2, data: { name: 'qq_send' } },
  ]
  assert.deepEqual(本回合工具(events, undefined, undefined), ['bash', 'qq_send'])
})

test('R5 非 tool/call 与没有 seq 的事件都不算', () => {
  const events = [
    { type: 'tool/result', seq: 12, data: { name: 'bash' } },
    { type: 'tool/call', data: { name: 'bash' } },
    { type: 'assistant/message', seq: 13 },
  ]
  assert.deepEqual(本回合工具(events, 10, 20), [])
})
