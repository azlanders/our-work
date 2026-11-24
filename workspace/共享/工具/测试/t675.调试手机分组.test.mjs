import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具 = process.env.QQ_TOOLS_DIR || path.resolve(本目录, '..')
const 页 = readFileSync(path.join(工具, '简洁页.html'), 'utf8')
const 面板 = readFileSync(path.join(工具, '面板.mjs'), 'utf8')

// 批次 691：换行网格在 375px 上把导航堆到 621px（视口 667），正文整块被挤出屏幕。
// 改成一行横滑后，这两条期望也跟着改 —— 别再让测试钉住旧的坏布局。
test('手机断点把调试分组改成一行横滑', () => {
  const 桌面粉 = 页.indexOf('#viewDebug .dbgnav{flex-wrap:nowrap')
  const 手机粉 = 页.indexOf('#viewDebug .dbgnav{position:static !important')
  assert.ok(桌面粉 > 0, '找不到桌面端 dbgnav 规则')
  assert.ok(手机粉 > 桌面粉, '手机端覆盖必须排在桌面规则后面')
  const 段 = 页.slice(手机粉, 页.indexOf('}', 手机粉) + 1)
  assert.match(段, /flex:none !important/, '必须清掉全局 nav 的 flex 拉伸')
  assert.match(段, /flex-wrap:nowrap !important/, '必须一行，31 组换行会把正文挤出屏幕')
  assert.match(段, /overflow-x:auto !important/, '一行放不下要能横向滑')
  assert.match(段, /height:auto !important/, '高度跟一行内容走')
})

test('手机分组按钮按内容宽度，不再两列 46%', () => {
  assert.match(页, /#viewDebug \.dbgnav button\{flex:0 0 auto;width:auto/)
})

test('31 个分组仍由接口下发并全部渲染，体力层编辑器仍在', () => {
  assert.match(面板, /id: 'layers\.physical'/)
  assert.match(页, /dbgGroups = d\.groups \|\| \[\]/)
  assert.match(页, /dbgGroups\.map\(function \(g\)/)
})
