// 批次513：说话也算收尾 + 内心话别当正文发出去
//
// 证据（私聊 11-15 22:34–22:39）：4 分钟她发了 5 次，同期 4 次「队头条目已等 30s」。
// 那几轮她用 qq_send，批次509 只把 qq_pass 当收尾 → 说一句被推一轮，连发。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { isSelfTalkNote } = await import(LIB + '/outbound.js')
const 续跑 = readFileSync(LIB + '/实时续跑.js', 'utf8')
const 流出 = readFileSync(LIB + '/outbound.js', 'utf8')

test('T1 真实出现过的内心话必须被吞', () => {
  assert.equal(isSelfTalkNote('这一轮我不发消息，安静待着。'), true)
  assert.equal(isSelfTalkNote('我这边没有新消息，就不打扰主人了。'), true)
  assert.equal(isSelfTalkNote('没有新消息，这轮不用开口。'), true)
  assert.equal(isSelfTalkNote('安静待着'), true)
  assert.equal(isSelfTalkNote('这轮到此'), true)
})

test('T2 正常的短句不能误吞（这是收紧过的判据）', () => {
  assert.equal(isSelfTalkNote('不打扰你了，去忙吧'), false, '这句是真心话，不该吞')
  assert.equal(isSelfTalkNote('那你先忙'), false)
  assert.equal(isSelfTalkNote('我在呢，就是有点困'), false)
  assert.equal(isSelfTalkNote('好'), false)
})

test('T3 太长的不算（内心话都很短）', () => {
  assert.equal(isSelfTalkNote('安静待着' + '啊'.repeat(200)), false)
})

test('T4 必须真的接进出站闸门', () => {
  // 批次523b：闸门名单搬进了 元话术命中()，不再是一行 7 个 ||。要保的是「在名单里 + 被调用」。
  const i = 流出.indexOf('export function 元话术命中')
  assert.ok(i > 0, '没有统一的闸门入口 元话术命中()')
  assert.ok(流出.slice(i, i + 900).includes("'isSelfTalkNote'"), '心里话判据不在闸门名单里')
  assert.ok(流出.includes('= 元话术命中(text)'), '发送路径没调闸门')
})

test('T5 续跑：qq_send 也算「说过话」，而且要在「干过活」的前提下才收尾', () => {
  assert.ok(续跑.includes("n === 'qq_send' || n === 'qq_pass' || n === 'qq_close'"), 'qq_send 没算进说过话')
  assert.ok(续跑.includes('const 干过活'), '没有区分「干活」的工具')
  assert.ok(续跑.includes('const 主动收尾 = 说过话 && !干过活'), '收尾判据不是「说过话且没干活」')
})

test('T6 记账类工具不该被当成「干活」（否则她记个笔记就一直被推）', () => {
  const 段 = 续跑.slice(续跑.indexOf('const 记账号'), 续跑.indexOf('const 主动收尾'))
  for (const 名 of ['memory_judge', 'qq_remember', 'qq_feel', 'qq_react']) {
    assert.ok(段.includes(`'${名}'`), 名 + ' 没被算作记账')
  }
})

test('T7 收尾判据必须在「动过」之前，且带 return', () => {
  const i = 续跑.indexOf('const 主动收尾')
  const j = 续跑.indexOf('const 动过 =')
  assert.ok(i > 0 && j > i, '顺序不对')
  assert.ok(续跑.slice(i, j).includes('return'), '没有 return，后面还会推')
})
