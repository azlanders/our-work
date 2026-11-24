// 批次591：实时对话 —— 话题/热度驱动的动态空闲 + 纯聊天收尾补一句
//
// 真问题：主动钟的空闲阈值是死数字（配置 42 分钟）。哪怕她手里刚攒下一件想说的、
// 哪怕两个人半小时前还在聊，也得干等 42 分钟 ——「自己找话题」只剩整点问候感。
// 这里钉住新的边界：话题只缩短等待，不绕过静默/配额/退避/睡着。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web/node_modules/dsh-onebot-channel/lib` : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const { shouldNudge, dayKey } = await import(LIB + '/proactive.js')

const NOW = Date.parse('2026-11-17T12:00:00+08:00')
const 基础 = {
  now: NOW,
  enabled: true,
  idleHours: 0.7,
  dailyMax: 3,
  quietFrom: '00:00',
  quietTo: '00:00', // from === to 视为不静默
  backoffMax: 4,
  key: 'private:1',
}

test('L1 刚聊过、手里没材料：仍然要等满 36 分钟地板', () => {
  const r = shouldNudge({ ...基础, entry: { lastIncomingAt: NOW - 30 * 60e3 }, topicReady: false })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not-idle-enough')
})

test('L2 同一时刻手里有新鲜材料：已经可以开口', () => {
  const r = shouldNudge({ ...基础, entry: { lastIncomingAt: NOW - 30 * 60e3 }, topicReady: true })
  assert.equal(r.ok, true)
  assert.equal(r.via, 'idle')
  assert.ok(r.idleMs < 36 * 60e3, '有话题时必须比 36 分钟地板快，实际 ' + Math.round(r.idleMs / 60000) + ' 分钟')
})

test('L3 话题不绕过退避：连续两次没被回应照样等更久', () => {
  const r = shouldNudge({
    ...基础,
    entry: { lastIncomingAt: NOW - 30 * 60e3, lastProactiveAt: NOW - 26 * 60e3, unanswered: 2 },
    topicReady: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'backoff')
})

test('L4 话题不绕过日配额', () => {
  const r = shouldNudge({
    ...基础,
    entry: { lastIncomingAt: NOW - 30 * 60e3, day: dayKey(NOW), countToday: 6 },
    topicReady: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'daily-quota')
})

test('L5 话题不绕过静默时段', () => {
  const r = shouldNudge({
    ...基础,
    quietFrom: '11:00',
    quietTo: '13:00',
    entry: { lastIncomingAt: NOW - 30 * 60e3 },
    topicReady: true,
  })
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'quiet-hours')
})

test('L6 没有话题时地板仍是 36 分钟', () => {
  const r = shouldNudge({ ...基础, idleHours: 0.05, entry: { lastIncomingAt: NOW - 10 * 3600e3 }, topicReady: false })
  assert.equal(r.ok, true)
  assert.equal(Math.round(r.idleMs / 60000), 36)
})

test('L7 有话题时地板放到 9 分钟', () => {
  const r = shouldNudge({ ...基础, idleHours: 0.05, entry: { lastIncomingAt: NOW - 10 * 3600e3 }, topicReady: true })
  assert.equal(r.ok, true)
  assert.equal(Math.round(r.idleMs / 60000), 9)
})

test('L8 对话热度三档：2 小时内 0.5、6 小时内 0.75、更久 1', () => {
  const 取 = (小时) => shouldNudge({
    ...基础,
    idleHours: 0.05,
    entry: { lastIncomingAt: NOW - 小时 * 3600e3 },
    topicReady: true,
  })
  assert.equal(取(1).系数.热度, 0.5)
  assert.equal(取(4).系数.热度, 0.75)
  assert.equal(取(10).系数.热度, 1)
})

test('L9 纯聊天收尾要排续话，而不是直接结束', () => {
  const src = readFileSync(LIB + '/实时续跑.js', 'utf8')
  assert.match(src, /const 主动收尾 = 说过话 && !干过活[\s\S]{0,500}排续话\(ctx, sessionId, entry\)/)
  assert.match(src, /续话每段/)
  assert.match(src, /\[(还没回|暂未收到新来信)\]/)
})
