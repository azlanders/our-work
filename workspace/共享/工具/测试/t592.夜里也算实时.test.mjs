// 批次592：静默时段给「人还醒着」让路
//
// 真问题：静默时段（01:00–07:00）一律不开口。可主人半夜一点还在聊，
// 01:47 判定直接是 quiet-hours —— 人醒着，钟却当人睡了，实时对话整段被掐掉。
// 规则收窄成：只有他 30 分钟没说话，才把静默时段当回事（那才可能是睡了）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web/node_modules/dsh-onebot-channel/lib` : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const { shouldNudge } = await import(LIB + '/proactive.js')

const 深夜 = Date.parse('2026-11-17T02:00:00+08:00')
const 白天 = Date.parse('2026-11-17T14:00:00+08:00')
const 基础 = {
  enabled: true,
  idleHours: 0.7,
  dailyMax: 3,
  quietFrom: '01:00',
  quietTo: '07:00',
  backoffMax: 4,
  key: 'private:1',
  topicReady: true,
}

test('P1 深夜但他 20 分钟前说过话：静默时段让路', () => {
  const r = shouldNudge({ ...基础, now: 深夜, entry: { lastIncomingAt: 深夜 - 20 * 60e3 } })
  assert.equal(r.ok, true)
  assert.equal(r.reason, 'ok')
})

test('P2 深夜且他已 45 分钟没说话：仍然静默，不许吵人', () => {
  const r = shouldNudge({ ...基础, now: 深夜, entry: { lastIncomingAt: 深夜 - 45 * 60e3 } })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'quiet-hours')
})

test('P3 白天不在静默时段：跟以前一样正常判', () => {
  const r = shouldNudge({ ...基础, now: 白天, entry: { lastIncomingAt: 白天 - 45 * 60e3 } })
  assert.equal(r.ok, true)
})

test('P4 续话那条路也按同一个规则让路', () => {
  const src = readFileSync(LIB + '/实时续跑.js', 'utf8')
  assert.match(src, /function 在静默时段\(now, 龄\)/)
  assert.match(src, /Number\(龄\) < 30 \* 60e3\) return false/)
})
