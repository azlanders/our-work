// 批次532：打分不许挡在说话前面
//
// 数据：1092 次 memory_judge 调用，**每次让模型晚开口中位 4.8 秒**（p90 9.2 秒）；
// 而 4755 条带工具调用的消息里 4521 条只调了 1 个工具 —— 她几乎从不并行。
// 打分是给记忆库用的，跟他什么时候看到回复无关，所以应当和 qq_send 并列发。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'

const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? (process.env.DSH_HOME + '/profiles/web/node_modules/dsh-onebot-channel/lib') : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const { markVoiceTarget, buildVoiceText } = await import(LIB + '/stateVoice.js')

const 造 = (mute = false) => {
  const a = {}
  markVoiceTarget(a, { peer: '{{OWNER_UIN}}', isPrivate: true, mute, at: Date.now() })
  return a
}
const sys = (mute = false) =>
  buildVoiceText(造(mute), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })()

test('J1 规则必须在，而且点名 memory_judge 说明评分与回复解耦', () => {
  const s = sys()
  assert.ok(/memory_judge.*不等于.*回复/.test(s), '没有这条规则')
})

test('J2 必须说清按需调用（看这轮事情是否需要）', () => {
  const s = sys()
  assert.ok(/看这轮事情是否需要|按需/.test(s), '没写按需调用')
})

test('J3 顺序：追加在待办规则之后（前缀缓存按最长公共前缀算，动末尾影响最小）', () => {
  const s = sys()
  const 待办 = s.indexOf('待办.mjs')
  const 新 = s.indexOf('memory_judge 只是给记忆库记录评分')
  assert.ok(待办 > 0 && 新 > 待办, '新规则没在待办之后：待办@' + 待办 + ' 新@' + 新)
})

test('J4 同一轮内两次调用必须逐字相同（否则前缀缓存被自己打掉）', () => {
  const f = buildVoiceText(造(), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  assert.equal(f(), f())
})

test('J5 静音时仍然一个字都不注入', () => {
  assert.equal(sys(true), '')
})

test('J6 静态段别无限膨胀：总长压在 700 字以内（现在 598）', () => {
  const s = sys()
  assert.ok(s.length <= 700, '静态段太长了：' + s.length + ' 字')
})
