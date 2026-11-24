// 批次582：私聊合并要认「对方正在输入」
//
// 真 bug（2026-11-16 21:33）：「看看」和「你的」相隔 3.2 秒，
// 600ms 窗口把第一条先放了，第二条只能开新回合，她回了两段割裂的话。
// 现在输入中延长窗口，停止输入再按正常窗口放行。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { createMergeQueue } = await import(LIB + '/merge.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const 建队列 = (flushes, settings) => createMergeQueue(
  async (uin, messages) => {
    flushes.push(messages.map((m) => m.id))
    return 'ok'
  },
  () => settings,
)

test('M1 正在输入时延长窗口，两条合成一次投递', async () => {
  const flushes = []
  const q = 建队列(flushes, { windowMs: 40, maxWaitMs: 1000, maxMessages: 10, typingHoldMs: 200 })
  q.push({}, 'u', { id: 1 })
  await sleep(20)
  q.noteTyping('u', true)
  await sleep(80)
  q.push({}, 'u', { id: 2 })
  q.noteTyping('u', false)
  await sleep(120)
  assert.deepEqual(flushes, [[1, 2]])
})

test('M2 没有输入状态就按正常窗口放行', async () => {
  const flushes = []
  const q = 建队列(flushes, { windowMs: 40, maxWaitMs: 1000, maxMessages: 10, typingHoldMs: 200 })
  q.push({}, 'u', { id: 1 })
  await sleep(100)
  assert.deepEqual(flushes, [[1]])
})
