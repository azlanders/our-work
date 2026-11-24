// 批次604：面板调试写的是真源字段
//   好感 score 是派生值 → 按比例缩放四维，让重算后的分真的落在目标附近
//   别扭真源是 level（不是 score）→ 写 level + until，读 level
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { 缩放四维, 别扭调试档 } = await import(pathToFileURL(path.join(工具, '关系调试.mjs')).href)
const 加权 = (d) => 0.5 * d['亲近'] + 0.3 * d['安全'] + 0.2 * d['兴致']

test('好感：按比例缩放到目标分，重算后误差 < 0.2', () => {
  const d = 缩放四维({ 亲近: 40, 安全: 55, 兴致: 45, 思念: 0 }, 80)
  assert.ok(Math.abs(加权(d) - 80) < 0.2, `实际 ${加权(d)}`)
  assert.equal(d['思念'], 0, '思念不该被缩放')
})

test('好感：目标 0 清零，目标 100 封顶', () => {
  const 零 = 缩放四维({ 亲近: 60, 安全: 60, 兴致: 60 }, 0)
  assert.equal(加权(零), 0)
  const 满 = 缩放四维({ 亲近: 100, 安全: 100, 兴致: 100 }, 100)
  assert.equal(加权(满), 100)
  assert.ok(Object.values(满).every((v) => v >= 0 && v <= 100))
})

test('好感：四维全 0 时，目标分直接铺到三维', () => {
  const d = 缩放四维({ 亲近: 0, 安全: 0, 兴致: 0 }, 60)
  assert.deepEqual([d['亲近'], d['安全'], d['兴致']], [60, 60, 60])
  assert.equal(加权(d), 60)
})

test('别扭：写 level，不再写 score；0 分留一条到期记录', () => {
  const now = 1_700_000_000_000
  const r = 别扭调试档(60, { need: '想被哄' }, now)
  assert.equal(r.level, 60)
  assert.equal(r.score, undefined)
  assert.equal(r.need, '想被哄')
  assert.equal(r.why, '调试图')
  assert.equal(r.until, now + 3 * 3600e3)
  const 零 = 别扭调试档(0, r, now)
  assert.equal(零.level, 0)
  assert.equal(零.until, now)
  assert.equal(零.score, undefined)
})

test('别扭：超界值夹到 0~100', () => {
  assert.equal(别扭调试档(150, {}, 0).level, 100)
  assert.equal(别扭调试档(-20, {}, 0).level, 0)
  assert.equal(别扭调试档('abc', {}, 0).level, 0)
})
