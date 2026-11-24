// 批次594：上一条主动还没被回，下一次就要翻倍
//
// 真问题：noteNudge 在这次开口之后才 unanswered+1，所以判定时读到的还是 0。
// 实测 01:47 主动搭话没人回，02:00 就按 1 倍再发一条，双倍要等到第三次才生效。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { shouldNudge } = await import(LIB + '/proactive.js')

const NOW = Date.parse('2026-11-17T14:00:00+08:00')
const 基础 = {
  now: NOW,
  enabled: true,
  idleHours: 0.7,
  dailyMax: 3,
  quietFrom: '00:00',
  quietTo: '00:00',
  backoffMax: 4,
  key: 'private:1',
  topicReady: true,
}

test('R1 上一条主动没被回：下一次直接按 2 倍，不许 1 倍再来一条', () => {
  const r = shouldNudge({
    ...基础,
    entry: { lastIncomingAt: NOW - 60 * 60e3, lastProactiveAt: NOW - 20 * 60e3, unanswered: 0 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'backoff')
})

test('R2 他回过话：退避归零，只按正常空闲判', () => {
  const r = shouldNudge({
    ...基础,
    entry: { lastIncomingAt: NOW - 5 * 60e3, lastProactiveAt: NOW - 60 * 60e3, unanswered: 0 },
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-idle-enough')
})

test('R3 他回过、也够久了：正常可以开口', () => {
  const r = shouldNudge({
    ...基础,
    entry: { lastIncomingAt: NOW - 40 * 60e3, lastProactiveAt: NOW - 90 * 60e3, unanswered: 0 },
  })
  assert.equal(r.ok, true)
})
