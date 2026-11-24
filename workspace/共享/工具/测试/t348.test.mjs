import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 只有媒体, 是否艾特别人 } = await import(LIB + '/poll.js')

// 原来的内联实现，逐字抄自改前源码（2440 / 2490 / 3261 / 3270）
const 旧媒体 = (段, text) => {
  const mediaTypes = new Set(['image', 'mface', 'face', 'video'])
  return text === '' && Array.isArray(段)
    && 段.some((seg) => mediaTypes.has(String(seg?.type ?? '')))
}
const 旧at = (段, selfUin) => Array.isArray(段) && 段.some(
  (seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') !== '' && String(seg?.data?.qq) !== String(selfUin ?? '')
)

const ME = '3556352474'

test('只有媒体：与旧实现逐例等价', () => {
  const 例 = [
    [undefined, ''],
    [null, ''],
    [[], ''],
    [[{ type: 'text', data: { text: '你好' } }], '你好'],
    [[{ type: 'image', data: { file: 'a.jpg' } }], ''],
    [[{ type: 'mface', data: {} }], ''],
    [[{ type: 'face', data: {} }], ''],
    [[{ type: 'video', data: {} }], ''],
    [[{ type: 'image', data: {} }, { type: 'text', data: { text: '看这个' } }], '看这个'],
    [[{ type: 'image', data: {} }, { type: 'text', data: { text: '' } }], ''],
    [[null, undefined, { type: 'image' }], ''],
    [[{ type: 'at', data: { qq: ME } }], ''],
  ]
  for (const [段, text] of 例) {
    assert.equal(只有媒体(段, text), 旧媒体(段, text),
      '不一致：段=' + JSON.stringify(段) + ' text=' + JSON.stringify(text))
  }
})

test('是否艾特别人：与旧实现逐例等价', () => {
  const 例 = [
    [undefined, ME],
    [null, ME],
    [[], ME],
    [[{ type: 'text', data: { text: 'hi' } }], ME],
    [[{ type: 'at', data: { qq: ME } }], ME],
    [[{ type: 'at', data: { qq: '123456' } }], ME],
    [[{ type: 'at', data: { qq: 'all' } }], ME],
    [[{ type: 'at', data: { qq: '' } }], ME],
    [[{ type: 'at', data: {} }], ME],
    [[{ type: 'at', data: { qq: '123' } }, { type: 'at', data: { qq: ME } }], ME],
    [[null, { type: 'at', data: { qq: '999' } }], ME],
    [[{ type: 'at', data: { qq: '999' } }], ''],
  ]
  for (const [段, self] of 例) {
    assert.equal(是否艾特别人(段, self), 旧at(段, self),
      '不一致：段=' + JSON.stringify(段) + ' selfUin=' + JSON.stringify(self))
  }
})

test('@全体 保持旧行为（算「@别人」）—— 这是刻意的，改了就是行为变化', () => {
  assert.equal(是否艾特别人([{ type: 'at', data: { qq: 'all' } }], ME), true)
})

test('两处调用点确实都改成了函数调用（源码断言）', () => {
  const s = readFileSync(LIB + '/poll.js', 'utf8')
  assert.equal(s.split('const atOthers = 是否艾特别人(').length - 1, 2, '@别人应有两处调用')
  assert.equal(s.split('const mediaOnly = 只有媒体(').length - 1, 2, '媒体应有两处调用')
  assert.ok(!s.includes('const mediaTypes = new Set'), '不该再有内联的 mediaTypes')
})

test('导出可用（别的模块也能复用，不用再抄一遍）', () => {
  assert.equal(typeof 只有媒体, 'function')
  assert.equal(typeof 是否艾特别人, 'function')
})
