import test from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次442：VPS 系统时区是 UTC，但项目里一切面向人的时间都是北京时间。
// `fs.statSync()` 返回的 `mtime` / `mtimeMs` 是 **UTC 基准** ——
// 直接 `mtime.toISOString()` 出来就是 UTC 字符串，比北京时间早 8 小时。
//
// 实测面板 `档列表()` 就是这么写的：主人看「音色档改于 2026-11-04 19:02」，
// 实际是 11-05 03:02 —— 隔了一天，会照着它判断「这份模型是不是刚训完」。
// 同一个文件里另外三处显示 mtime 都是 `mtimeMs + 8 * 3600e3`，只有那一处漏了。
//
// 注意别一刀切：算「距今多久」的（`Date.now() - mtimeMs`）**不需要 +8**，只有显示给人看的才要。
const 工具 = '{{BOT_ROOT}}/共享/工具'
const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

const 扫 = (目录, 后缀) => readdirSync(目录)
  .filter((f) => f.endsWith(后缀) && !f.includes('测试'))
  .map((f) => ({ 名: f, 文: readFileSync(join(目录, f), 'utf8') }))

test('D1 全项目不许把 mtime 直接 toISOString（那是 UTC，比北京早 8 小时）', () => {
  const 撞 = []
  for (const { 名, 文 } of [...扫(工具, '.mjs'), ...扫(插件, '.js')]) {
    for (const m of 文.matchAll(/\.mtime\.toISOString/g)) {
      const 行号 = 文.slice(0, m.index).split('\n').length
      const 行 = 文.split('\n')[行号 - 1] || ''
      // 注释里提到不算
      if (/^\s*(\/\/|\*)/.test(行)) continue
      撞.push(名 + ':' + 行号)
    }
  }
  assert.deepEqual(撞, [], '这些地方把文件 mtime 直接当字符串用了（会比北京时间早 8 小时）：'
    + 撞.join(', ') + '  —— 显示给人看的要 `new Date(mtime.getTime() + 8 * 3600e3)`')
})

test('D2 面板里每个 `new Date(...mtimeMs...)` 都必须 +8', () => {
  // 第一版写的是「`mtimeMs + 8 * 3600e3` 至少出现 4 次」—— 反测把其中一处改成不带 +8，
  // 数量从 4 变 3，居然还是绿的（别处凑够了）。**数个数不算判据，要逐个看。**
  const s = readFileSync(join(工具, '面板.mjs'), 'utf8')
  const 用法 = [...s.matchAll(/new Date\(\s*[\w.$]*mtimeMs[^)]*\)/g)].map((m) => m[0])
  assert.ok(用法.length >= 3, '只找到 ' + 用法.length + ' 处用 mtimeMs 造日期 —— 判据失效了')
  const 漏 = 用法.filter((u) => !/\+ 8 \* 3600e3/.test(u))
  assert.deepEqual(漏, [], '这些地方拿 mtimeMs 造日期却没 +8（会比北京时间早 8 小时）：' + 漏.join(' / '))
})

test('D3 面板的「档列表」那条断言：改这一列的必须是 +8 的版本', () => {
  const s = readFileSync(join(工具, '面板.mjs'), 'utf8')
  const i = s.indexOf('function 档列表')
  assert.ok(i > 0, '找不到 档列表 —— 改结构了就把这条测试一起改')
  const 段 = s.slice(i, i + 1200)
  assert.match(段, /new Date\(s\.mtime\.getTime\(\) \+ 8 \* 3600e3\)/,
    '「改」这一列又退回直接 toISOString 了')
})
