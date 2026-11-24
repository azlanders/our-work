import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { 反查群原文, 记撤回, 读最近撤回, 读档, 日 } from '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/撤回感知.mjs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 根 = '/tmp/t341'
const 群 = '1051483012'
const 阿猫 = '2997506540'
const 主人 = '{{OWNER_UIN}}'
const SELF = '3556352474'
// 北京时间 2026-11-09 03:00
const NOW = Date.UTC(2026, 10, 8, 19, 0, 0)

function 清() {
  rmSync(根, { recursive: true, force: true })
  mkdirSync(join(根, '群'), { recursive: true })
}
function 写群日志(now, 行) {
  writeFileSync(join(根, '群', 群 + '-' + 日(now) + '.jsonl'), 行.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
}
const 档 = () => join(根, '撤回的.json')
const 群事件 = (mid, uid = 阿猫) => ({
  post_type: 'notice', notice_type: 'group_recall', group_id: Number(群),
  user_id: Number(uid), operator_id: Number(uid), message_id: mid,
})

清()

test('反查群原文：能按 message_id 找到人和内容', () => {
  写群日志(NOW, [
    { time: '2026-11-09 02:58:00', user_id: 阿猫, nickname: '阿猫', message_id: '770321883', group_id: 群, text: '今天天气不错' },
    { time: '2026-11-09 02:59:00', user_id: 阿猫, nickname: '阿猫', message_id: '770321884', group_id: 群, text: '另一条' },
  ])
  const r = 反查群原文(群, 770321883, NOW, join(根, '群'))
  assert.ok(r, '应该找得到')
  assert.equal(r.text, '今天天气不错')
  assert.equal(r.nickname, '阿猫')
})

test('反查群原文：跨零点找昨天的日志', () => {
  const 早 = Date.UTC(2026, 10, 8, 16, 30, 0) // 11-09 00:30 北京
  写群日志(早 - 86_400e3, [{ time: '2026-11-08 23:50:00', user_id: 阿猫, nickname: '阿猫', message_id: '555000111', group_id: 群, text: '昨晚那条' }])
  const r = 反查群原文(群, 555000111, 早, join(根, '群'))
  assert.ok(r, '跨零点应该也能找到')
  assert.equal(r.text, '昨晚那条')
})

test('反查群原文：id 不认识就返 null，不瞎猜', () => {
  assert.equal(反查群原文(群, 999999999, NOW, join(根, '群')), null)
  assert.equal(反查群原文('', 1, NOW, join(根, '群')), null)
})

test('记撤回：群聊写进原文和昵称', () => {
  清()
  写群日志(NOW, [{ time: '2026-11-09 02:58:00', user_id: 阿猫, nickname: '阿猫', message_id: '770321883', group_id: 群, text: '今天天气不错' }])
  const r = 记撤回(群事件(770321883), { kind: 'group_recall', selfUin: SELF, now: NOW, file: 档(), dir: join(根, '群') })
  assert.ok(r)
  assert.equal(r.有, true)
  assert.equal(r.文, '今天天气不错')
  assert.equal(r.谁, '阿猫')
  assert.equal(r.我, false)
  assert.equal(读档(档()).length, 1)
})

test('记撤回：私聊没日志，只记「撤了一条」，不编内容', () => {
  清()
  const r = 记撤回(
    { post_type: 'notice', notice_type: 'friend_recall', user_id: Number(主人), message_id: 221736682 },
    { kind: 'friend_recall', selfUin: SELF, now: NOW, file: 档(), dir: join(根, '群') }
  )
  assert.equal(r.有, false)
  assert.equal(r.文, '')
  assert.equal(r.类, '私')
})

test('记撤回：她自己撤的标 我=true', () => {
  清()
  const r = 记撤回(群事件(1, SELF), { kind: 'group_recall', selfUin: SELF, now: NOW, file: 档(), dir: join(根, '群') })
  assert.equal(r.我, true)
})

test('记撤回：24 小时前的自动丢掉', () => {
  清()
  writeFileSync(档(), JSON.stringify({ items: [{ at: NOW - 25 * 3600e3, 谁Id: 阿猫, 有: true, 文: '太老了' }] }), 'utf8')
  const r = 记撤回(群事件(2), { kind: 'group_recall', selfUin: SELF, now: NOW, file: 档(), dir: join(根, '群') })
  assert.ok(r)
  const items = 读档(档())
  assert.equal(items.length, 1, '老那条要掉，只剩新的')
  assert.equal(items[0].谁Id, 阿猫)
})

test('记撤回：只留最近 20 条', () => {
  清()
  const many = []
  for (let i = 0; i < 25; i += 1) many.push({ at: NOW - i * 1000, 谁Id: String(i), 有: false, 文: '', 我: false })
  writeFileSync(档(), JSON.stringify({ items: many }), 'utf8')
  记撤回(群事件(9), { kind: 'group_recall', selfUin: SELF, now: NOW, file: 档(), dir: join(根, '群') })
  assert.equal(读档(档()).length, 20)
})

test('读最近撤回：20 分钟内、是这个人，带原文', () => {
  清()
  writeFileSync(档(), JSON.stringify({ items: [{ at: NOW - 5 * 60e3, 谁Id: 阿猫, 有: true, 文: '今天天气不错', 我: false }] }), 'utf8')
  const s = 读最近撤回({ peer: 阿猫, now: NOW, file: 档() })
  assert.match(s, /^\[撤回\]/)
  assert.match(s, /今天天气不错/)
  assert.match(s, /你自己定/)
})

test('读最近撤回：超过 20 分钟就不提了', () => {
  清()
  writeFileSync(档(), JSON.stringify({ items: [{ at: NOW - 21 * 60e3, 谁Id: 阿猫, 有: true, 文: 'x' }] }), 'utf8')
  assert.equal(读最近撤回({ peer: 阿猫, now: NOW, file: 档() }), '')
})

test('读最近撤回：换个人问就不提（不串群、不串人）', () => {
  清()
  writeFileSync(档(), JSON.stringify({ items: [{ at: NOW - 60e3, 谁Id: 阿猫, 有: true, 文: 'x' }] }), 'utf8')
  assert.equal(读最近撤回({ peer: 主人, now: NOW, file: 档() }), '')
})

test('读最近撤回：她自己撤的不出声', () => {
  清()
  writeFileSync(档(), JSON.stringify({ items: [{ at: NOW - 60e3, 谁Id: SELF, 有: true, 文: 'x', 我: true }] }), 'utf8')
  assert.equal(读最近撤回({ peer: SELF, now: NOW, file: 档() }), '')
})

test('读最近撤回：没原文就说「内容没留下」，不编', () => {
  清()
  writeFileSync(档(), JSON.stringify({ items: [{ at: NOW - 60e3, 谁Id: 主人, 有: false, 文: '', 我: false }] }), 'utf8')
  const s = 读最近撤回({ peer: 主人, now: NOW, file: 档() })
  assert.match(s, /内容没留下/)
  assert.doesNotMatch(s, /「/)
})

test('voiceSlots 集成：extraSlotsHint 能把撤回带进上下文', async () => {
  const { extraSlotsHint, VOICE_SLOTS } = await import('{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/voiceSlots.js')
  // 原来钉死 12 —— 每加一个槽（现在 19 个）这条就红，红得没有信息量。
  // 改断言「只增不减 + 每个都是函数」：真正该防的是「槽被误删」和「混进非函数」。
  assert.ok(VOICE_SLOTS.length >= 12, '槽数不该少于 12，实际 ' + VOICE_SLOTS.length)
  assert.ok(VOICE_SLOTS.every((f) => typeof f === 'function'), '每个槽都必须是函数')
  assert.ok(VOICE_SLOTS.some((f) => f.name === 'slotRecall'), '数组里要有 slotRecall')
  清()
  writeFileSync(档(), JSON.stringify({ items: [{ at: Date.now() - 60e3, 谁Id: 阿猫, 有: true, 文: '发错了', 我: false }] }), 'utf8')
  const out = extraSlotsHint({ peer: 阿猫, isPrivate: true, memDir: 根, now: Date.now(), file: 档() })
  assert.match(out, /\[撤回\]/, '槽没出声，实际：' + out)
  assert.match(out, /发错了/)
})

test('voiceSlots 集成：没撤回时这一槽保持安静', async () => {
  const { extraSlotsHint } = await import('{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/voiceSlots.js')
  清()
  const out = extraSlotsHint({ peer: 阿猫, isPrivate: true, memDir: 根, now: Date.now(), file: 档() })
  assert.doesNotMatch(out, /\[撤回\]/)
})
