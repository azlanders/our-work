import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.QUIET_NOTE = '1'

const LIB = process.env.QQ_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { markVoiceTarget, buildVoiceText } = await import(LIB + '/stateVoice.js')
const { slotCleanliness, slotRelationBond, slotDreamAftertaste, slotClash } = await import(LIB + '/voiceSlots.js')

const 造 = () => {
  const a = {}
  markVoiceTarget(a, { peer: '{{OWNER_UIN}}', isPrivate: true, mute: false, at: Date.now() })
  return a
}
const 系统提示 = () => buildVoiceText(造(), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })()

test('R1 提示只给事实，不再命令先开口或固定工具顺序', () => {
  const s = 系统提示()
  assert.ok(s.includes('qq_send 是唯一能让他看到话的出口'))
  assert.ok(s.includes('先聊、先查还是先整理，都由你定'))
  assert.ok(!s.includes('把 qq_send 放第一个动作'))
  assert.ok(!s.includes('记完扭头就回他'))
})

test('R2 memory_judge 调用与否完全由她决定，不是命令', () => {
  const s = 系统提示()
  assert.ok(s.includes('是否调用、何时调用，看这轮事情是否需要'))
  assert.ok(!s.includes('必须先调用 memory_judge'))
})

test('R3 清洁、关系和梦余味只描述事实，不替她决定动作', () => {
  const d = mkdtempSync(join(tmpdir(), 't625-'))
  try {
    writeFileSync(join(d, '卫生.json'), JSON.stringify({ 清洁: 40 }))
    writeFileSync(join(d, '关系.json'), JSON.stringify({ people: { 1: { safety: 0.8, bond: 0.8 } } }))
    writeFileSync(join(d, '刚醒.json'), JSON.stringify({ at: new Date().toISOString() }))
    const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    writeFileSync(join(d, '梦余味.json'), JSON.stringify({ date: today, 好: true, 余味: '暖' }))
    const ctx = { memDir: d, peer: '1', now: Date.now() }
    assert.ok(!slotCleanliness(ctx).includes('该去洗澡'))
    const rel = slotRelationBond(ctx)
    assert.ok(rel.includes('bond 0.80'))
    assert.ok(!rel.includes('会主动找话说'))
    assert.ok(!slotDreamAftertaste(ctx).includes('不用主动提'))
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('R4 两处打架只报状态差异，不给行为命令', () => {
  const d = mkdtempSync(join(tmpdir(), 't625-clash-'))
  try {
    writeFileSync(join(d, '状态.json'), JSON.stringify({
      energy: 70, layers: { emotional: 35, physical: 50, cognitive: 50 },
    }))
    const s = slotClash({ isPrivate: true, memDir: d, peer: '1', now: Date.now() })
    // 665 起只报两边的数值，不写「身上还有劲，心已经不想动了」这种第一人称判断。
    assert.equal(s, '[两处打架] 精力 70 / 情绪 35')
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('R5 工具回执不再用「我这边」冒充她的话', () => {
  const photo = readFileSync(LIB + '/photo.js', 'utf8')
  const tool = readFileSync(LIB + '/tool.js', 'utf8')
  assert.ok(!photo.includes('我这边会自己叫你一声'))
  assert.ok(photo.includes('系统会通知你'))
  assert.ok(!tool.includes('我这边功能出问题了'))
  assert.ok(tool.includes('工具调用失败'))
})
