import test from 'node:test'
import assert from 'node:assert/strict'
import { 关系档 } from '../../判据/关系档.mjs'
import { 关系档 as 关系档_兼容 } from '../../关系档.mjs'

test('判据/关系档: bond 优先且兼容入口等价', () => {
  assert.equal(关系档, 关系档_兼容)
  assert.equal(关系档({ bond: 0.75 }).档, '熟')
  assert.equal(关系档({ bond: 0.5 }).档, '在意')
  assert.equal(关系档({ bond: 0.2 }).档, '一般')
  assert.equal(关系档({ bond: 0.05 }).档, '还不熟')
})

test('判据/关系档: 无数据时返回 有据=false', () => {
  const r = 关系档({})
  assert.equal(r.有据, false)
  assert.equal(r.档, '一般')
})
