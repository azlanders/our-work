// 批次509/510：两个真 bug 的回归
//
// A. 实时续跑把 qq_pass（工具调用）当成「还在干活」，一次「我不说话」反而再推 5 轮。
// B. 她会把英文状态说明当正文写出来，中文闸门不认英文。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? (process.env.DSH_HOME + '/profiles/web/node_modules/dsh-onebot-channel/lib') : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const { isEnglishMetaNote } = await import(LIB + '/outbound.js')

const 流出 = readFileSync(LIB + '/outbound.js', 'utf8')
const 续跑 = readFileSync(LIB + '/实时续跑.js', 'utf8')

test('E1 真实出现过的两句英文状态说明必须被吞掉', () => {
  assert.equal(isEnglishMetaNote('Nothing to send this turn — just recorded the memory verdicts.'), true)
  assert.equal(isEnglishMetaNote('Done — nothing sent.'), true)
  assert.equal(isEnglishMetaNote('nothing to send'), true)
  assert.equal(isEnglishMetaNote('No message this round.'), true)
})

test('E2 有中文就不算（她正常说话是中文，不能误吞）', () => {
  assert.equal(isEnglishMetaNote('Nothing to send 了这轮'), false)
  assert.equal(isEnglishMetaNote('好的，Done'), false)
})

test('E3 正常的英文回复不能误吞', () => {
  assert.equal(isEnglishMetaNote('Done, that was fun.'), false)
  assert.equal(isEnglishMetaNote('I think it is fine.'), false)
  assert.equal(isEnglishMetaNote('Nothing beats a cold drink.'), false, '这句不是状态说明')
  assert.equal(isEnglishMetaNote(''), false)
})

test('E4 太长了不算（状态说明都很短）', () => {
  assert.equal(isEnglishMetaNote('Nothing to send ' + 'x'.repeat(200)), false)
})

test('E5 必须真的接进出站闸门，不是只导出个函数没人用', () => {
  // 批次523b 把七道闸门收进了 元话术命中()，所以它不再逐字出现在那个 if 里。
  // 要保的东西没变：①它在闸门名单里 ②名单被发送路径真的调用并真的拦。
  const i = 流出.indexOf('export function 元话术命中')
  assert.ok(i > 0, '没有统一的闸门入口 元话术命中()')
  assert.ok(流出.slice(i, i + 900).includes("'isEnglishMetaNote'"), '英文元话术不在闸门名单里')
  const 用 = 流出.indexOf('= 元话术命中(text)')
  assert.ok(用 > 0, '发送路径没调 元话术命中')
  assert.ok(/return\s*\{[^}]*\}/.test(流出.slice(用, 用 + 800)), '调了却没拦下消息')
})

test('E6 续跑：qq_pass / qq_close 必须当成收尾，直接返回不再推', () => {
  // 批次513 把「收尾」从「只认 qq_pass」放宽成「说过话且没干活」，qq_pass 仍是其中一条。
  assert.ok(续跑.includes('const 主动收尾'), '没有收尾判据')
  const 说过话行 = 续跑.split(String.fromCharCode(10)).find((l) => l.includes('const 说过话'))
  assert.ok(说过话行, '没有「说过话」判据')
  assert.ok(说过话行.includes("'qq_pass'"), 'qq_pass 没算进说过话')
  assert.ok(说过话行.includes("'qq_close'"), 'qq_close 没算进说过话')
  const i = 续跑.indexOf('const 主动收尾')
  const j = 续跑.indexOf('const 动过 =')
  assert.ok(i > 0 && j > i, '收尾判据必须在「动过」之前')
  assert.ok(续跑.slice(i, j).includes('return'), '收尾了却没 return，后面还会继续推')
})

test('E7 续跑：收尾时要把连跑计数清掉（否则下次一进来就撞上限）', () => {
  const i = 续跑.indexOf('const 主动收尾')
  const j = 续跑.indexOf('const 动过 =')
  const 段 = 续跑.slice(i, j)
  assert.ok(段.includes('连跑.delete(sessionId)'), '没清连跑计数')
})
