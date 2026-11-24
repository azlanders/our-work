// 批次515：自己发的图不进「收到的图片」+ 还没回话别弄不急的事
//
// 依据（2026-11-16 01:11–01:16 私聊 + 日志）：
//   01:11:20 他：「你记在台账或者什么地方捏」
//   01:11:24  [image] 副本已存 …_3556352474_F1482BB8….jpg   ← 存的是她自己发的图
//   01:11:30 / :43 / 01:12:14  [emoji] 预览 4/4/2 张         ← 在翻收藏夹
//   01:12:04  qq_collect_face delete …F1482BB8…             ← 删的正是那张
//   01:13:23  [emoji] 已收藏 指定文件（顶盆站桩）
//   01:16:08  才说话                                        ← 迟了 4 分 48 秒
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 是自己发的图片 } = await import(LIB + '/images.js')
const { markVoiceTarget, buildVoiceText } = await import(LIB + '/stateVoice.js')

const 造 = (peer, isPrivate, mute = false) => {
  const a = {}
  markVoiceTarget(a, { peer, isPrivate, mute, at: Date.now() })
  return a
}
const sys = (peer = '{{OWNER_UIN}}', isPrivate = true, mute = false) =>
  buildVoiceText(造(peer, isPrivate, mute), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })()

const SELF = '3556352474'

// ---------------- 自己发的图 ----------------

test('I1 数字 config 对字符串 uin 也要认出来（类型不一致是最常见的漏判）', () => {
  assert.equal(是自己发的图片('3556352474', 3556352474), true)
})

test('I2 反过来也得认（uin 数字、config 字符串）', () => {
  assert.equal(是自己发的图片(3556352474, '3556352474'), true)
})

test('I3 config 是 0 或空：谁都不算自己（否则所有图都不存，而且不报错）', () => {
  for (const v of [0, '0', '', '  ', null, undefined]) {
    assert.equal(是自己发的图片(SELF, v), false, 'selfUin=' + String(v) + ' 把所有图都判成自己了')
  }
})

test('I4 uin 缺失/空：不能当成自己', () => {
  for (const v of [null, undefined, '', '  ']) {
    assert.equal(是自己发的图片(v, SELF), false, 'uin=' + String(v) + ' 被判成自己')
  }
})

test('I5 前后空格要 trim 掉', () => {
  assert.equal(是自己发的图片(' 3556352474 ', SELF), true)
  assert.equal(是自己发的图片(SELF, ' 3556352474 '), true)
})

test('I6 别人发的照旧存（别把主人发的也吞了）', () => {
  assert.equal(是自己发的图片('{{OWNER_UIN}}', SELF), false)
})

test('I7 必须真的接在落盘那条链路上，不是只导出个函数没人用', () => {
  const 源码 = readFileSync(LIB + '/images.js', 'utf8')
  const i = 源码.indexOf('function saveImageCopy(')
  assert.ok(i > 0, '找不到 saveImageCopy')
  const 体 = 源码.slice(i, i + 700)
  assert.ok(体.includes('是自己发的图片('), 'saveImageCopy 里没调用判据')
  assert.ok(体.includes("return ''"), '判成自己之后没提前返回，图还是会被存')
})

// ---------------- 还没回话别弄不急的事 ----------------

test('U1 system 里要给出未回话的事实和那些不急的事，不命令她先回', () => {
  const s = sys()
  assert.ok(s.includes('还没回话'), '没注入这条：' + s.slice(0, 150))
  assert.ok(s.includes('先聊、先查还是先整理，都由你定'), '没说明选择权归她')
  for (const k of ['收藏夹', '表情', '删收藏']) {
    assert.ok(s.includes(k), '没点名「' + k + '」，她不知道哪些事晚点做也不会丢')
  }
})

// ORDER_DROP 2026-11-16（批次521b）：原来这条断言抢的是「客服腔 → 台账 → 还没回话」的字面顺序。
// 但批次521b 把「还没回话」合并进了最前面那条说话规则（三条重叠规则合一），顺序必然变。
// 而顺序本身不是目的 —— 挡缓存击穿靠的是「同一轮内逐字相同」，U3 已经在测那件事。
// 所以这里只保留真正要保的：三条规则都在。
test('U2 三条规则都在（顺序交给 U3 的逐字一致来守）', () => {
  const s = sys()
  assert.ok(s.includes('客服腔'), '客服腔没注入')
  assert.ok(s.includes('待办.mjs'), '台账没注入')
  assert.ok(s.includes('还没回话'), '急事优先没注入')
})

test('U3 同一轮两次调用逐字相同', () => {
  const f = buildVoiceText(造('{{OWNER_UIN}}', true), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  assert.equal(f(), f())
})

test('U4 静音时仍然一个字都不注入', () => {
  assert.equal(sys('{{OWNER_UIN}}', true, true), '')
})

test('U5 群里也有（群里她同样会先翻收藏夹）', () => {
  assert.ok(sys('1051483012', false).includes('还没回话'))
})
