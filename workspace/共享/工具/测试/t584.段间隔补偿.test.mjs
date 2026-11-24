// 批次584：多段回复的后续段间隔也要跟着「已等」压缩。
//
// 补偿毫秒() 只作用于第一段前的打字停顿；后面每段仍固定等 partDelayMs，
// 三段回复会额外多 0.4–1.4 秒。这里按超出目标的比例缩短，只减不加。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 段间隔系数 } = await import(LIB + '/outbound.js')

test('L1 还没到目标：不压缩', () => {
  assert.equal(段间隔系数(2000, 1000), 1)
  assert.equal(段间隔系数(2000, 2000), 1)
})

test('L2 超出目标一半：压到 0.5', () => {
  assert.equal(段间隔系数(2000, 3000), 0.5)
})

test('L3 超出目标一倍以上：压到下限 0.2', () => {
  assert.equal(段间隔系数(2000, 4000), 0.2)
  assert.equal(段间隔系数(2000, 10000), 0.2)
})

test('L4 目标缺失/非法：保持原节奏', () => {
  assert.equal(段间隔系数(0, 5000), 1)
  assert.equal(段间隔系数(-1, 5000), 1)
  assert.equal(段间隔系数(NaN, 5000), 1)
})

test('L5 没收到过消息或时间非法：保持原节奏', () => {
  assert.equal(段间隔系数(2000, null), 1)
  assert.equal(段间隔系数(2000, undefined), 1)
  assert.equal(段间隔系数(2000, NaN), 1)
  assert.equal(段间隔系数(2000, 0), 1)
})
