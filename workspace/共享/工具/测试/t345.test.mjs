import test from 'node:test'
import assert from 'node:assert/strict'
import { 命中, 北京时刻 } from '{{BOT_ROOT}}/共享/工具/心跳.mjs'

// 用模块自己的 北京时刻() 造时刻，不手抄时分（批次301 的教训）
const 时刻北京 = (h, m, day = 9) => 北京时刻(Date.UTC(2026, 10, day, h - 8, m, 0))

test('每天：11:30 命中', () => {
  const t = 时刻北京(11, 30)
  assert.equal(t.时, 11)
  assert.equal(t.分, 30)
  assert.equal(命中({ 每天: true, 时: 11, 分: 30 }, t.分, t), true)
})

test('每天：11:31 不命中（这是这次的真 bug —— 旧写法会每分钟跑）', () => {
  const t = 时刻北京(11, 31)
  assert.equal(命中({ 每天: true, 时: 11, 分: 30 }, t.分, t), false)
})

test('每天：凌晨 03:16 不命中', () => {
  const t = 时刻北京(3, 16)
  assert.equal(命中({ 每天: true, 时: 11, 分: 30 }, t.分, t), false)
})

test('旧写法（只有 时/分、没有 每天/每周/每月）：会退化成每分钟 —— 记录这个陷阱', () => {
  const t = 时刻北京(3, 16)
  // 这就是批次344 我踩的：时/分 被忽略、间隔分 默认 1 → 恒真
  assert.equal(命中({ 时: 11, 分: 30 }, t.分, t), true)
})

test('间隔分回归：2 分钟一次', () => {
  for (const m of [0, 2, 4, 58]) {
    const t = 时刻北京(10, m)
    assert.equal(命中({ 间隔分: 2 }, t.分, t), true, '分 ' + m + ' 应命中')
  }
  for (const m of [1, 3, 59]) {
    const t = 时刻北京(10, m)
    assert.equal(命中({ 间隔分: 2 }, t.分, t), false, '分 ' + m + ' 不该命中')
  }
})

test('每周回归：周一 13:00 命中，周二不命中', () => {
  const 周一 = 时刻北京(13, 0, 9)
  assert.equal(周一.周, 1)
  assert.equal(命中({ 每周: 1, 时: 13, 分: 0 }, 周一.分, 周一), true)
  const 周二 = 时刻北京(13, 0, 10)
  assert.equal(周二.周, 2)
  assert.equal(命中({ 每周: 1, 时: 13, 分: 0 }, 周二.分, 周二), false)
})

test('每月回归：1 号 9:00 命中，2 号不命中', () => {
  const 一号 = 时刻北京(9, 0, 1)
  assert.equal(命中({ 每月: 1, 时: 9, 分: 0 }, 一号.分, 一号), true)
  const 二号 = 时刻北京(9, 0, 2)
  assert.equal(命中({ 每月: 1, 时: 9, 分: 0 }, 二号.分, 二号), false)
})

test('每天 + 只给 HH:MM（时刻.日 为 null）也命中（日级任务不需要日期）', () => {
  const t = { 分: 30, 时: 11, 日: null, 周: null }
  assert.equal(命中({ 每天: true, 时: 11, 分: 30 }, t.分, t), true)
})
