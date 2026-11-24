import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次435：`钱账.mjs` 的 `--月` 2026-11-14 就写好了，但**工具层没有入口** ——
// 她问「我上个月花了多少」，系统里没有任何一条路能答。现在接在 qq_money 的 action='账'。
//
// 顺带记一条边界：`资产.记录` 是滚动 200 条（实测最早 2026-11-03），
// 所以比那更早的账**根本不存在**，不是算错 —— 描述里要求她「答不出就说答不出」。
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const MONEY = join(LIB, 'money.js')
const 钱账 = '{{BOT_ROOT}}/共享/工具/钱账.mjs'
const { 月号 } = await import(MONEY)

test('M1 「上个月」「2026-1」「-2」都要翻成脚本认的写法', () => {
  assert.equal(月号('上个月'), '-1')
  assert.equal(月号('上月'), '-1')
  assert.equal(月号('上上个月'), '-2')
  assert.equal(月号('-2'), '-2')          // 脚本自己的相对写法，原样递
  assert.equal(月号('2026-10'), '2026-10')
  assert.equal(月号('2026-1'), '2026-01')  // 补零，否则脚本按 '2026-1' 比字符串会漏
  // 「这个月 / 不填」按**北京时间**当月 —— 服务器是 UTC，月初那几小时用本地月份会差一个月
  const 北京当月 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7)
  assert.equal(月号('这个月'), 北京当月)
  assert.equal(月号(''), 北京当月)
  assert.equal(月号(undefined), 北京当月)
})

test('M2 qq_money 真的暴露了 action=账，而且说清了数据边界', () => {
  const s = readFileSync(MONEY, 'utf8')
  assert.match(s, /enum: \['看', '价', '买', '账'\]/, 'action 里没有 账')
  assert.match(s, /if \(act === '账'\)/, 'execute 没有 账 的分支')
  // 源码是 join(tools, '钱账.mjs'), '--月' —— 中间隔着右括号，别把整串写死（上一版就栽在这）
  assert.match(s, /钱账\.mjs/, '没去调 钱账.mjs')
  assert.match(s, /'--月'/, '没传 --月')
  assert.match(s, /MONEY_MEM: mem/, '没把沙盒变量传下去（QQ_MONEY_MEM 那一套）')
  // 边界必须写进描述：不然她会在没有数据时估一个数出来
  assert.match(s, /2026-11-03/, '描述里没写「账只记到哪天」')
  assert.match(s, /别估/, '描述里没要求她答不出就直说')
})

test('M3 钱账.mjs 的 --月 现在还能跑（接口没被改坏）', () => {
  const out = execFileSync(process.execPath, [钱账, '--月', '2026-11'], { encoding: 'utf8', timeout: 30000 })
  assert.match(out, /2026-11：\d+ 笔/, out)
  assert.match(out, /花 \d+/, out)
})

test('M4 工具层翻出来的月份，脚本真的认得（拿 -1 和当月各跑一次）', () => {
  for (const 输入 of ['上个月', '这个月']) {
    const out = execFileSync(process.execPath, [钱账, '--月', 月号(输入)], { encoding: 'utf8', timeout: 30000 })
    assert.match(out, /^\d{4}-\d{2}：\d+ 笔/, '「' + 输入 + '」翻出来的月份脚本不认：' + out.slice(0, 120))
  }
})
