// 批次622：碎片召回/碎片话题只递素材，不再替她生成第一人称回忆句。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.QUIET_NOTE = '1'

const 库 = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 召回 = readFileSync(join(库, '碎片召回.mjs'), 'utf8')
const 话题 = readFileSync(join(库, '碎片话题.mjs'), 'utf8')

test('A1 碎片召回只给素材，不再拼「忽然想起」', () => {
  assert.ok(召回.includes('[旧事素材·模糊]'), '没有素材标记')
  assert.ok(!召回.includes('忽然想起一件事'), '仍在生成第一人称回忆')
  assert.ok(!召回.includes('别问我后来怎样'), '仍在生成固定台词')
  assert.ok(召回.includes('FOUR_HOURS'), '冷却逻辑被误删')
})

test('A2 碎片话题只给素材，不再拼「你一说我倒记起来了」', () => {
  assert.ok(话题.includes('[旧事素材'), '没有素材标记')
  assert.ok(!话题.includes('你一说我倒记起来了'), '仍在生成固定台词')
  assert.ok(!话题.includes('以前是不是也'), '仍在生成固定反问')
  assert.ok(话题.includes('TWO_HOURS'), '冷却逻辑被误删')
})
