// 批次585：发送前对账要按回合取投递批次，不能再被新回合覆盖。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 当前回合开始 } = await import(LIB + '/tool.js')
const { markDeliveredBatch, deliveredCursor } = await import(LIB + '/rhythm.js')

test('P1 当前回合开始取最近的 turn/start', () => {
  const exec = {
    agent: {
      session: {
        seq: 5,
        snapshotEvents: () => [
          { type: 'turn/start', time: 1000 },
          { type: 'user/message', time: 1100 },
          { type: 'turn/end', time: 1200 },
          { type: 'turn/start', time: 2000 },
          { type: 'user/message', time: 2100 },
        ],
      },
    },
  }
  assert.equal(当前回合开始(exec), 2000)
})

test('P2 没有 turn/start 返回 null', () => {
  const exec = { agent: { session: { seq: 2, snapshotEvents: () => [{ type: 'user/message', time: 1 }] } } }
  assert.equal(当前回合开始(exec), null)
})

test('P3 session 读不到返回 null', () => {
  assert.equal(当前回合开始(null), null)
  assert.equal(当前回合开始({ agent: { session: { seq: 1, snapshotEvents: () => { throw new Error('x') } } } }), null)
})

test('P4 按回合开始时间选对应的投递批次', () => {
  const key = 'private:585'
  const now = Date.now()
  markDeliveredBatch(key, [{ message_id: 1 }], now - 5000)
  markDeliveredBatch(key, [{ message_id: 2 }], now - 1000)
  assert.deepEqual([...deliveredCursor(key, now - 4000).ids], [1])
  assert.deepEqual([...deliveredCursor(key, now).ids], [2])
  assert.deepEqual([...deliveredCursor(key).ids], [2])
})

test('P5 过期批次返回 null', () => {
  const key = 'private:586'
  markDeliveredBatch(key, [{ message_id: 3 }], Date.now() - 11 * 60 * 1000)
  assert.equal(deliveredCursor(key), null)
})
