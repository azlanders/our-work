// 批次623：接梗槽保留梗识别，但不再递可直接照念的完整台词。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

process.env.QUIET_NOTE = '1'

const 库 = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 源 = readFileSync(join(库, 'voiceSlots.js'), 'utf8')

test('A1 接梗槽不再夹带可照念的完整台词', () => {
  assert.ok(!源.includes('你这个人，满脑子都只想着自己呢'), 'MyGO 台词还在')
  assert.ok(!源.includes('真是抱歉没能让你尽兴'), '咒术台词还在')
  assert.ok(!源.includes('竖着切还是横着切'), '咒术台词还在')
  assert.ok(!源.includes('味太冲了'), '固定吐槽还在')
})

test('A2 梗识别还在，出口改成“由你定”', () => {
  assert.ok(源.includes('什么都会做的'), 'MyGO 梗识别被误删')
  assert.ok(源.includes('宿傩'), '咒术梗识别被误删')
  assert.ok(源.includes('接不接、怎么接由你定'), '缺少出口边界')
})
