import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// 批次 691：375px 下 31 个调试分组标签按 2 个一行排，导航占 621px（视口 667），
// 正文整块被挤出屏幕 —— 看着就是「手机只能看到核心状态」。
// 修法：窄屏一行横滑（nowrap + overflow-x:auto），别再换行堆高。

const 工具 = process.env.QQ_TEST_TOOLS || join(dirname(fileURLToPath(import.meta.url)), '..')
const 源 = readFileSync(join(工具, '简洁页.html'), 'utf8')

test('M1 窄屏调试导航是一行横滑，不换行', () => {
  assert.match(源, /#viewDebug \.dbgnav\{[^}]*flex-wrap:nowrap !important/, '要 nowrap，否则 31 个标签堆 20 行')
  assert.match(源, /#viewDebug \.dbgnav\{[^}]*overflow-x:auto !important/, '要横向滚动')
  assert.equal(/#viewDebug \.dbgnav\{[^}]*flex-wrap:wrap !important/.test(源), false, '别又改回 wrap')
})

test('M2 标签按内容宽度，不再 46% 一行两个', () => {
  assert.equal(/#viewDebug \.dbgnav button\{flex:1 1 46%/.test(源), false, '46% 两列会把导航堆高')
  assert.match(源, /#viewDebug \.dbgnav button\{flex:0 0 auto/, '标签按内容宽度')
})
