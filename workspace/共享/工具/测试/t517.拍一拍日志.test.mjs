// 批次516 加、批次521c 改成行为测试：拍一拍的日志必须能分清谁→谁
//
// 为什么改：原来 6 条全是「源码里有没有这句话」。那种断言抓不到行为回归 ——
// 比如把 raw_info 拼错、截断写错、可疑判据反了，源码里的话还在，测试照样绿。
//
// 背景（2026-11-16）：主人群里看到「{{BOT_DISPLAY}} 拍了拍你的ice (害怕)」一串，问到底怎么回事。
// 批次516 当时判断「NapCat 把发起者填成 self_id」—— **错的**。
// 批次521 用 tcpdump 抓到真相：测试/冒烟1.加载.test.mjs 会 import 全部工具脚本，
// 而 主动戳.mjs 的发送逻辑在模块顶层，一 import 就真戳；写记录被沙盒守卫拦下，
// 所以「戳了但没记」。现在 主动戳.mjs 有入口保护，日志留着继续用。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// t453 A1：文件里出现插件路径就要静音
process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 拍一拍描述 } = await import(LIB + '/poll.js')

const 她 = '3556352474'
const 主人 = '{{OWNER_UIN}}'

test('P1 发起的、被拍的和群都要写出来', () => {
  const s = 拍一拍描述({ user_id: 她, target_id: 主人, group_id: '1051483012' }, 她)
  assert.ok(s.includes('发起=' + 她), s)
  assert.ok(s.includes('目标=' + 主人), s)
  assert.ok(s.includes('group=1051483012'), s)
})

test('P2 QQ 的原文要拼起来（多个 nor 段），而且截断到 24 字', () => {
  const s = 拍一拍描述({
    user_id: 她,
    target_id: 主人,
    raw_info: [{ type: 'qq', uid: 'u_x' }, { type: 'nor', txt: '拍了拍' }, { type: 'nor', txt: '的ice (害怕)' }],
  }, 她)
  assert.ok(s.includes('原文「拍了拍的ice (害怕)」'), s)

  const 长 = 拍一拍描述({ user_id: 她, target_id: 主人, raw_info: [{ type: 'nor', txt: '字'.repeat(60) }] }, 她)
  assert.ok(长.length < 120, '原文没截断，日志会被撑爆：' + 长.length)
})

test('P3 缺字段 / 垃圾输入都不能崩（这条日志绝不许影响唤醒）', () => {
  输入: for (const e of [null, undefined, {}, { raw_info: null }, { raw_info: '坏' }, { raw_info: [null, { type: 'nor' }] }]) {
    const s = 拍一拍描述(e, 她)
    assert.equal(typeof s, 'string', '输入 ' + JSON.stringify(e) + ' 没返回字符串')
    assert.ok(s.includes('发起='), '格式丢了')
  }
})

test('P4 「发起=自己、目标却是别人」要被标出来（就是这次踩的坑）', () => {
  const s = 拍一拍描述({ user_id: 她, target_id: 主人, group_id: '1' }, 她)
  assert.ok(s.includes('不像是手动戳'), '没标可疑：' + s)
})

test('P5 正常的「别人戳我」不许被误标', () => {
  const s = 拍一拍描述({ user_id: 主人, target_id: 她, group_id: '1' }, 她)
  assert.ok(!s.includes('不像是手动戳'), '误标了：' + s)
})

test('P6 私聊（没有 group_id）要写「私聊」，不能空着', () => {
  const s = 拍一拍描述({ user_id: 主人, target_id: 她 }, 她)
  assert.ok(s.includes('私聊'), s)
  assert.ok(!s.includes('group='), '私聊不该有 group=')
})

test('P7 缺 target_id 时退回 user_id（别写 目标=?）', () => {
  const s = 拍一拍描述({ user_id: 主人, group_id: '1' }, 她)
  assert.ok(s.includes('目标=' + 主人), s)
})

test('P8 必须真的接在事件处理里（抽了函数没人调等于没做）', () => {
  const 源 = readFileSync(LIB + '/poll.js', 'utf8')
  assert.ok(/note\('ws', 拍一拍描述\(event, selfUin\)\)/.test(源), '没接进 note 调用')
})
