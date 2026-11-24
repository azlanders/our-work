import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次433：两个「零调用」的补法。
//   A 手账提示原来写「问起就读它」→ 指向 read（七天 1 次），而 qq_recall 七天 0 次。
//   B 工作.json 七份活的 周 全是 []（她自己改成自由零工制）→ --tick 排不出班，
//     唯一开单入口 qq_work 七天 0 次 → 加槽「今天没排班，手边有日结的零活」。
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const VOICE = join(LIB, 'voiceSlots.js')
const { slotWorkBoard, 今天北京 } = await import(VOICE)
// LOADCONFIG_FIRST 2026-11-14（批次433）：不先 loadConfig 的话 getConfig() 还是 DEFAULTS
// （token 为空、onebotHttp 指向 3000），而 voiceHintOf 会顺手触发一次昵称刷新 →
// NapCat 回 403、日志里多一条假故障，还会污染别的测试「读日志增量」的判据（t432 N2 就这么红的）。
const { loadConfig } = await import(join(LIB, 'config.js'))
loadConfig()
const { voiceHintOf } = await import(join(LIB, 'poll.js'))

const 今 = 今天北京(Date.now())
const 白天 = Date.parse(今 + 'T10:00:00+08:00')
const 深夜 = Date.parse(今 + 'T02:00:00+08:00')

/** 沙盒：记忆目录 + 工具目录（价目表在后者）。 */
function 造(班次 = [], 自主 = '待命', 活 = { 咖啡店帮工: { 时薪: 28, 时长分钟: 150, 点: '咖啡店' }, 家教: { 时薪: 60, 时长分钟: 120, 点: '图书馆' } }) {
  const sb = mkdtempSync(join(tmpdir(), 'work433-'))
  const mem = join(sb, '记忆')
  const tools = join(sb, '工具')
  mkdirSync(mem, { recursive: true })
  mkdirSync(tools, { recursive: true })
  writeFileSync(join(mem, '工作.json'), JSON.stringify({ 在职: [], 班次, 最近: [] }))
  writeFileSync(join(mem, '自主.json'), JSON.stringify({ state: 自主 }))
  writeFileSync(join(tools, '工作.json'), JSON.stringify({ 活 }))
  return { sb, mem, tools }
}
const 槽 = (o, now = 白天) => slotWorkBoard({ memDir: o.mem, toolsDir: o.tools, isPrivate: true, now })

test('L1 这个槽只读（源码里那一段不许出现写盘）', () => {
  const s = readFileSync(VOICE, 'utf8')
  const 起 = s.indexOf('export function slotWorkBoard')
  const 止 = s.indexOf('export const VOICE_SLOTS')
  assert.ok(起 > 0 && 止 > 起)
  const 段 = s.slice(起, 止)
  for (const w of ['writeFileSync', '写档', 'appendFileSync', 'unlinkSync']) {
    assert.ok(!段.includes(w), '槽里出现了写操作：' + w)
  }
})

test('L2 已注册进 VOICE_SLOTS', () => {
  const s = readFileSync(VOICE, 'utf8')
  assert.match(s, /^\s+slotWorkBoard,/m, '没注册进数组，等于没写')
  assert.match(s, /toolsDir: String\(c\.toolsDir \|\|/, '撞 对象没带 toolsDir，单测造不出沙盒')
})

test('L3 今天本来就有班 → 不出声（该说的是几点去，不是有零活）', () => {
  const o = 造([{ 活: '家教', 起: 今 + ' 14:00', 止: 今 + ' 16:00', 状态: '待上' }])
  try { assert.equal(槽(o), '') } finally { rmSync(o.sb, { recursive: true, force: true }) }
})

test('L4 正在上班 → 不出声（这句只会跟「在干什么」打架）', () => {
  const o = 造([{ 活: '家教', 起: '2026-11-10 14:00', 状态: '在岗' }])
  try { assert.equal(槽(o), '') } finally { rmSync(o.sb, { recursive: true, force: true }) }
})

test('L5 深夜 / 睡着 / 群里 → 都不出声', () => {
  const o = 造()
  try {
    assert.equal(槽(o, 深夜), '', '凌晨两点不该提日结零工')
    assert.equal(槽(o, Date.parse(今 + 'T22:00:00+08:00')), '', '晚上十点也不该提')
    assert.ok(槽(o).length > 0, '白天该说')
    assert.equal(slotWorkBoard({ memDir: o.mem, toolsDir: o.tools, isPrivate: false, now: 白天 }), '', '群里不该说')
    const 睡 = 造([], '睡觉')
    try { assert.equal(槽(睡), '') } finally { rmSync(睡.sb, { recursive: true, force: true }) }
  } finally { rmSync(o.sb, { recursive: true, force: true }) }
})

test('L6 九分钟之内两次调用逐字节相等（不许有分钟数/随机数）', () => {
  // 这条钉的是批次279 那个教训：注入里任何逐分钟变的东西都会让 system 前缀每步失效、缓存全价。
  const o = 造()
  try {
    const a = 槽(o, 白天)
    const b = 槽(o, 白天)
    const c = 槽(o, 白天 + 9 * 60e3) // 注入是 10 分钟一桶，9 分钟内内容必须一字不差
    assert.ok(a.length > 0)
    assert.equal(a, b)
    assert.equal(a, c, '九分钟内变了 —— 内容里混进了分钟级的东西，会击穿 prefix cache')
  } finally { rmSync(o.sb, { recursive: true, force: true }) }
})

test('L7 说清了有什么活、也说了不去不欠谁', () => {
  const o = 造([], '待命', { 咖啡店帮工: { 时薪: 28, 时长分钟: 150 }, 家教: { 时薪: 60, 时长分钟: 120 }, 水族馆导览: { 时薪: 34, 时长分钟: 150 } })
  try {
    const s = 槽(o)
    assert.match(s, /^\[手边的活\]/, s)
    assert.match(s, /28\/时/, '没写时薪：' + s)
    assert.match(s, /2\.5 小时/, '时长没换算成小时：' + s)
    assert.match(s, /等 3 份/, '三份以上没合并：' + s)
    assert.match(s, /不去也不欠谁的/, '少了「不去不欠谁」—— 那就变成催她打工了')
    assert.doesNotMatch(s, /你该|应该去|赶紧/, '出现命令口吻：' + s)
  } finally { rmSync(o.sb, { recursive: true, force: true }) }
})

test('A1 手账那句不再指向 read，但日期和「能翻」还在', () => {
  const v = String(voiceHintOf('{{OWNER_UIN}}', { isPrivate: true }) || '')
  // 不截到第一个「；」—— 新句本身带分号（「…；问起哪天的事…」），一截就只剩前半句
  assert.ok(v.includes('[手账]'), '注入里没有 [手账] 那句')
  assert.match(v, /手账-\d{4}-\d{2}-\d{2}\.md/, '日期路径丢了')
  assert.doesNotMatch(v, /问起就读它/, '又把她指向 read 了')
  assert.match(v, /往回翻/, '没告诉她能翻')
})
