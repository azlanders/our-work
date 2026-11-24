// 批次586：qq_listen 不能用陈旧游标回放旧话，也不能把自己/本回合已见的消息当新话。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 选听新消息 } = await import(LIB + '/tool.js')
const { markDeliveredBatch, deliveredIdsUpTo } = await import(LIB + '/rhythm.js')

test('L1 旧游标压在时间下限，早于下限的历史全部丢掉', () => {
  const list = [
    { messageId: 1, time: 4000, userId: 'u1', text: '很旧' },
    { messageId: 2, time: 9000, userId: 'u1', text: '新话' }
  ]
  const { fresh } = 选听新消息(list, { lastTime: 1000, floorSec: 5000 })
  assert.deepEqual(fresh.map((m) => m.messageId), [2])
})

test('L2 本回合已进上下文的消息不再算新，后面的新话保留', () => {
  const now = Math.floor(Date.now() / 1000)
  const list = [
    { messageId: 10, time: now - 4000, userId: 'u1', text: '很早' },
    { messageId: 11, time: now - 10, userId: 'u1', text: '已进 prompt' },
    { messageId: 12, time: now - 5, userId: 'u1', text: '真正的新话' }
  ]
  const { fresh } = 选听新消息(list, {
    lastTime: now - 4000,
    floorSec: now - 20,
    skipIds: new Set([11])
  })
  assert.deepEqual(fresh.map((m) => m.messageId), [12])
})

test('L3 自己发的消息不算新话', () => {
  const list = [
    { messageId: 20, time: 9000, userId: 'self', text: '我说的' },
    { messageId: 21, time: 9100, userId: 'u1', text: '他说的' }
  ]
  const { fresh } = 选听新消息(list, { lastTime: 1000, floorSec: 5000, self: 'self' })
  assert.deepEqual(fresh.map((m) => m.messageId), [21])
})

test('L4 超过上限只回最近 N 条，但全部新话都记下来', () => {
  const list = [1, 2, 3, 4].map((n) => ({ messageId: n, time: 9000 + n, userId: 'u1', text: String(n) }))
  const { fresh, all } = 选听新消息(list, { lastTime: 1000, floorSec: 5000, max: 2 })
  assert.deepEqual(fresh.map((m) => m.messageId), [3, 4])
  assert.deepEqual(all.map((m) => m.messageId), [1, 2, 3, 4])
})

test('L5 投递批次并集：回合 B 能排除回合 A 已见的那条', () => {
  const key = 'private:586'
  const now = Date.now()
  markDeliveredBatch(key, [{ message_id: 31 }], now - 10000)
  markDeliveredBatch(key, [{ message_id: 32 }], now - 5000)
  assert.deepEqual([...deliveredIdsUpTo(key, now - 8000)].sort(), [31])
  assert.deepEqual([...deliveredIdsUpTo(key, now)].sort(), [31, 32])
})

test('L6 线上场景：21:33 旧游标 + 22:44 两条连发，只回未进 prompt 的第二条', () => {
  const now = Math.floor(Date.now() / 1000)
  const list = [
    { messageId: 41, time: now - 4000, userId: 'u1', text: '看看' },
    { messageId: 42, time: now - 3900, userId: 'u1', text: '你的' },
    { messageId: 43, time: now - 10, userId: 'u1', text: '能看到吗' },
    { messageId: 44, time: now - 5, userId: 'u1', text: '这两条' }
  ]
  const { fresh } = 选听新消息(list, {
    lastTime: now - 4000,
    floorSec: now - 20,
    skipIds: new Set([43])
  })
  assert.deepEqual(fresh.map((m) => m.messageId), [44])
})
