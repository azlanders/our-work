// 批次506b：客服腔规则的回归
//
// 依据：她群聊文字 2249 条里「我这边」154 条（6.8%）、「这边」173 条（7.7%），
// 而「其实 0.4% / 确实 1.0% / 有点 0.8%」—— 只有这两个是离群值。
// 主人 2026-11-05：「你的鱼八股 别老是我认我认了」。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { markVoiceTarget, buildVoiceText } = await import(LIB + '/stateVoice.js')

const 造 = (peer, isPrivate, mute = false) => {
  const a = {}
  markVoiceTarget(a, { peer, isPrivate, mute, at: Date.now() })
  return a
}

test('S1 私聊的 system 静态段里有反客服腔那句', () => {
  const f = buildVoiceText(造('{{OWNER_UIN}}', true), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  const s = f()
  assert.ok(s.includes('客服腔'), '没注入反客服腔规则')
  assert.ok(s.includes('我这边'), '没点名「我这边」这两个字（不点名她不会改）')
})

test('S2 群聊也有（她 6.8% 的「我这边」主要就出现在群里）', () => {
  const f = buildVoiceText(造('1051483012', false), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  assert.ok(f().includes('客服腔'), '群聊没注入')
})

test('S3 同一轮内两次调用必须逐字相同（这句不能破坏 Prefix Cache）', () => {
  const f = buildVoiceText(造('1051483012', false), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  assert.equal(f(), f(), '两次结果不一样 —— 会把 3 万 token 的前缀缓存击穿')
})

test('S4 静音（mute）时仍然什么都不注入，别被这句顶开', () => {
  const f = buildVoiceText(造('1051483012', false, true), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  assert.equal(f(), '', 'mute 时还注入了内容')
})

test('S5 没有任何状态的情况下也得有这句（原来那里是「[态] 平常」兜底）', () => {
  const f = buildVoiceText(造('1051483012', false), { ownerUin: '', 状态进正文: true })
  const s = f()
  assert.ok(s.includes('客服腔'), '空状态时被兜底覆盖掉了')
})

test('S6 说话规则保留成本事实，但不命令她先开口', () => {
  const f = buildVoiceText(造('1051483012', false), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  const s = f()
  assert.ok(s.includes('qq_send 是唯一能让他看到话的出口'), '没注入发送事实')
  assert.ok(s.includes('先聊、先查还是先整理，都由你定'), '没说明选择权归她')
  assert.ok(!s.includes('把 qq_send 放第一个动作'), '仍在命令工具顺序')
})

test('S7 两条风格规则都在，而且说话事实在「别客服腔」前面（顺序固定才有缓存）', () => {
  const f = buildVoiceText(造('1051483012', false), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  const s = f()
  const a = s.indexOf('qq_send 是唯一能让他看到话的出口')
  const b = s.indexOf('客服腔')
  assert.ok(a > 0 && b > 0, '有一条没注入')
  assert.ok(a < b, '顺序变了')
})
