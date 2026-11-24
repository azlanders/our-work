// 批次533：说完话别再补 qq_pass（110 个回合是这么白多一轮的）
//
// 数据：929 个回合里，670 个说了话；其中 215 个又补了 qq_pass，
// 而这 215 个里有 **110 个中途没干任何别的活** —— 那句 pass 纯属多余，多一轮 ~30k 入参的请求。
// 另有 105 个中途干了活，pass 是正常收尾（续跑的「收尾」判据是「说过话且没干活」，所以那时仍需要它）。
// 改的是 qq_send 的工具描述（她在决策那一刻读到的就是它，比静态规则更贴身）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? (process.env.DSH_HOME + '/profiles/web/node_modules/dsh-onebot-channel/lib') : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')

test('C1 qq_send 的描述里必须说清「只说了话就别补 qq_pass」', () => {
  const 源 = readFileSync(LIB + '/tool.js', 'utf8')
  const i = 源.indexOf('QQ 唯一发消息工具')
  assert.ok(i > 0, '找不到 qq_send 描述')
  const 段 = 源.slice(i, i + 700)
  assert.ok(/不用再补(一个)?\s*qq_pass/.test(段), '没这句，她还会补：' + 段.slice(0, 80))
})

test('C2 必须保留收尾条件（不然 105 个正常收尾会被砍掉）', () => {
  const 源 = readFileSync(LIB + '/tool.js', 'utf8')
  const m = 源.match(/只(聊天|说了话)没干别的活[^。]+不用再补\s*qq_pass/)
  assert.ok(m, '没写收尾条件：' + 源.slice(0, 80))
})

test('C3 描述里不许出现我的统计口径（“实测 N 个回合”这种她会照着念）', () => {
  const 源 = readFileSync(LIB + '/tool.js', 'utf8')
  const i = 源.indexOf('QQ 唯一发消息工具')
  const 段 = 源.slice(i, i + 700)
  assert.ok(!/实测\s*\d+\s*个回合/.test(段), '把内部统计写进她的提示词了')
})
