// 批次582：qq_send 发送前增量对账。
//
// 真 bug（2026-11-16 21:33）：「看看」先投递，3.2 秒后「你的」才到；
// 合并窗口已经把第一条放出去了，她这一回合的 prompt 里没有第二句。
// qq_send 发送前强制拉一次私聊，发现本回合没见过的对方消息就拦下。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 筛选新入站 } = await import(LIB + '/tool.js')
const { markDeliveredBatch, deliveredCursor, rememberDeliveredIds } = await import(LIB + '/rhythm.js')

const cur = { ids: new Set([101]), at: 1000000 }

test('S1 已投递的不算新', () => {
  const list = [{ messageId: 101, userId: '2', time: 1000 }]
  assert.deepEqual(筛选新入站(list, cur, '1'), [])
})

test('S2 投递后到达的对方消息算新', () => {
  const list = [
    { messageId: 101, userId: '2', time: 1000 },
    { messageId: 102, userId: '2', time: 1003 },
  ]
  assert.deepEqual(筛选新入站(list, cur, '1').map((m) => m.messageId), [102])
})

test('S3 自己发的不算新', () => {
  const list = [{ messageId: 103, userId: '1', time: 1003 }]
  assert.deepEqual(筛选新入站(list, cur, '1'), [])
})

test('S4 太旧的不算（超出 2 秒容差）', () => {
  const list = [{ messageId: 104, userId: '2', time: 900 }]
  assert.deepEqual(筛选新入站(list, cur, '1'), [])
})

test('S5 拦截后记住 id，下一次不再拦同一批', () => {
  const key = 'private:2'
  const now = Date.now()
  const sec = Math.floor(now / 1000)
  markDeliveredBatch(key, [{ message_id: 201 }], now)
  const c = deliveredCursor(key)
  assert.deepEqual(筛选新入站([{ messageId: 201, userId: '2', time: sec }], c, '1'), [])
  assert.deepEqual(
    筛选新入站([{ messageId: 202, userId: '2', time: sec }], c, '1').map((m) => m.messageId),
    [202],
  )
  rememberDeliveredIds(key, [202])
  assert.deepEqual(筛选新入站([{ messageId: 202, userId: '2', time: sec }], deliveredCursor(key), '1'), [])
})

test('S6 过期游标返回 null', () => {
  const key = 'private:3'
  markDeliveredBatch(key, [{ message_id: 301 }], Date.now() - 11 * 60 * 1000)
  assert.equal(deliveredCursor(key), null)
})
