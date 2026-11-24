// 批次509：用真实聊天记录当样本，沙箱回放延迟补偿（多轮）
//
// 夹具 `fixtures/延迟样本.json` 是拿 群聊日志/1051483012-*.jsonl 里 161 条真实回复抽的 40 条，
// 每条带 (lag_ms 触发→发出, wait_ms 这条的打字目标)。日志再怎么追加，夹具不动。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 补偿毫秒 } = await import(LIB + '/outbound.js')
const { incomingAgeMs, markIncoming } = await import(LIB + '/rhythm.js')

const 夹具 = JSON.parse(readFileSync('{{BOT_ROOT}}/共享/工具/测试/fixtures/延迟样本.json', 'utf8'))
const 样本 = 夹具.样本

test('R1 夹具本身得像真的（够多、有两个极端）', () => {
  assert.ok(Array.isArray(样本) && 样本.length >= 30, '样本太少：' + 样本.length)
  assert.ok(样本.some((s) => s.lag_ms < 2000), '没有「很快」的样本，测不出补差额那一半')
  assert.ok(样本.some((s) => s.lag_ms > 15000), '没有「卡很久」的样本，测不出直接发那一半')
})

test('R2 逐条回放：实等 = max(0, 目标 - 滞后)，且不超过目标', () => {
  for (const s of 样本) {
    const 实等 = 补偿毫秒(s.wait_ms, s.lag_ms)
    const 期望 = Math.max(0, s.wait_ms - s.lag_ms)
    assert.equal(实等, 期望, `[${s.text.slice(0, 12)}] lag=${s.lag_ms} wait=${s.wait_ms}`)
    assert.ok(实等 >= 0 && 实等 <= s.wait_ms, '越界：' + 实等)
  }
})

test('R3 边界要精确：卡够了一律 0，没卡够一律 >0', () => {
  for (const s of 样本) {
    const 实等 = 补偿毫秒(s.wait_ms, s.lag_ms)
    if (s.lag_ms >= s.wait_ms) {
      assert.equal(实等, 0, `lag=${s.lag_ms} >= wait=${s.wait_ms} 却不是 0`)
    } else {
      assert.ok(实等 > 0, `lag=${s.lag_ms} < wait=${s.wait_ms} 却补了 0 —— 秒回会被吞掉打字`)
    }
  }
})

test('R4 真实样本里「卡够了直接发」得占多数（补偿不是摆设）', () => {
  const 卡够 = 样本.filter((s) => s.lag_ms >= s.wait_ms).length
  const 比例 = 卡够 / 样本.length
  assert.ok(比例 >= 0.8, `只有 ${(比例 * 100).toFixed(0)}% 的样本卡够了 —— 补偿在真实数据上基本没生效`)
})

test('R5 接上真实读取链路：markIncoming 之后 incomingAgeMs 真的能喂给补偿', () => {
  const key = 'group:replay509'
  const lag = 7300
  markIncoming(key, Date.now() - lag)
  const age = incomingAgeMs(key)
  assert.ok(age !== null && age >= lag && age < lag + 400, '来的 age=' + age)
  const 实等 = 补偿毫秒(3000, age)
  assert.equal(实等, 0, '卡 7.3 秒、目标 3 秒，应该直接发')
})

test('R6 多轮：同一批样本连跑 5 轮，结果必须逐条一致（没有状态泄漏）', () => {
  const 基准 = 样本.map((s) => 补偿毫秒(s.wait_ms, s.lag_ms))
  for (let 轮 = 1; 轮 <= 5; 轮 += 1) {
    const 这轮 = 样本.map((s) => 补偿毫秒(s.wait_ms, s.lag_ms))
    assert.deepEqual(这轮, 基准, `第 ${轮} 轮结果变了`)
  }
})

test('R7 多轮：incomingAgeMs 会被后一条刷新（模拟连发），补偿跟着归零', () => {
  const key = 'group:replay509b'
  const 轮 = []
  for (let i = 0; i < 5; i += 1) {
    // 每一轮都比上一轮更晚回：滞后 0s / 2s / 4s / 6s / 8s
    const lag = i * 2000
    markIncoming(key, Date.now() - lag)
    const age = incomingAgeMs(key)
    轮.push(补偿毫秒(3000, age))
  }
  // 滞后 0/2s → 补 3000/1000；4s 之后 → 0
  assert.ok(轮[0] > 2500, '刚来就该补满：' + 轮[0])
  assert.ok(轮[1] > 500 && 轮[1] < 1600, '2 秒应该补 1 秒左右：' + 轮[1])
  assert.equal(轮[2], 0, '4 秒了还补')
  assert.equal(轮[3], 0)
  assert.equal(轮[4], 0)
  // 单调不增
  for (let i = 1; i < 轮.length; i += 1) assert.ok(轮[i] <= 轮[i - 1], '第 ' + i + ' 轮反弹了')
})

test('R8 连续 100 轮压测：不抛错、结果永远在 [0, 目标] 内', () => {
  for (let i = 0; i < 100; i += 1) {
    const s = 样本[i % 样本.length]
    const 实等 = 补偿毫秒(s.wait_ms, s.lag_ms)
    assert.ok(Number.isFinite(实等) && 实等 >= 0 && 实等 <= s.wait_ms)
  }
})
