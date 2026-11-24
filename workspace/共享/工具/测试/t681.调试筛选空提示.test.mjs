// t681 —— 批次681：调试页筛选不到任何分组时，要给一句人话
//
// 旧行为：输入「xyz」，31 个分组 pill 全部 display:none，页面只剩空白。
// 分不清是「没有这一项」还是「页面挂了」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 源 = readFileSync(join(工具, '简洁页.html'), 'utf8')

test('F1 筛选逻辑会统计可见分组，并在 0 条时给提示', () => {
  assert.match(源, /EMPTY_HINT/, '缺少批次681 的注释锚点')
  assert.match(源, /let 可见 = 0/)
  assert.match(源, /可见 === 0/)
  assert.match(源, /没有匹配「' \+ q \+ '」的分组或指标/)
})

test('F2 提示节点只创建一次，清空筛选后自动隐藏', () => {
  assert.match(源, /提示\.id = 'dbgEmpty'/)
  assert.match(源, /提示\.style\.display = 空 \? '' : 'none'/)
  assert.match(源, /if \(!提示\)/, '应该复用节点，不能每次输入都插一个新 div')
})
