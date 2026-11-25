import test from 'node:test'
import assert from 'node:assert/strict'
import * as coreMod from '../../核心/恢复目标.mjs'
import * as compatMod from '../../恢复目标.mjs'

test('核心/恢复目标: 迁移后导出与兼容重导出完全一致', () => {
  assert.deepEqual(Object.keys(coreMod).sort(), Object.keys(compatMod).sort())
  assert.ok(Object.keys(coreMod).length > 0)
})
