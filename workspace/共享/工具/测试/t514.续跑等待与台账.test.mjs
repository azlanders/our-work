// 批次514：续跑的时间锚点 + 台账直达路径
//
// 依据（2026-11-16 私聊实录）：
//   01:11:20 他：「你记在台账或者什么地方捏」
//   01:11:23 她：qq_msg_history → 开始查文件
//   01:11:29 ~ 01:15:46  连续 20 轮 bash（翻 目录与文件规矩 / 计划.json / 待办.json /
//            待办.mjs 源码 / 变更.md / images.js / custom-faces.js…）
//   01:16:08 她：「记了记了，写进待办里了，明天就照着改」  ← 迟了 4 分 48 秒
//
// 两个缺口：①续跑的「[接着做]」里没有任何时间信息，她以为还在即时对话；
//          ②「台账」不在她脑子里有一对一的落点，只能靠翻文件找。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 该催他了吗, 续跑提示 } = await import(LIB + '/实时续跑.js')
const { markVoiceTarget, buildVoiceText } = await import(LIB + '/stateVoice.js')

const 造 = (peer, isPrivate, mute = false) => {
  const a = {}
  markVoiceTarget(a, { peer, isPrivate, mute, at: Date.now() })
  return a
}
const sys = (peer = '{{OWNER_UIN}}', isPrivate = true, mute = false) =>
  buildVoiceText(造(peer, isPrivate, mute), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })()

// ---------------- 等待时钟 ----------------

test('W1 差 1 毫秒到 40 秒：不催（更短是正常节奏）', () => {
  assert.equal(该催他了吗(40000 - 1, 0), '', '39.999 秒就被催了')
})

test('W2 正好 40 秒：开始催，并且要写出秒数', () => {
  const s = 该催他了吗(40000, 0)
  assert.ok(s.includes('40 秒'), '没写秒数：' + s)
  assert.ok(s.includes('还在等你'), '没点明他还在等：' + s)
})

test('W3 10 分钟整：还在窗口内', () => {
  assert.ok(该催他了吗(10 * 60e3, 0) !== '', '10 分钟整被挡掉了')
})

test('W4 10 分钟零 1 毫秒：不催（那已经不是「他在等」）', () => {
  assert.equal(该催他了吗(10 * 60e3 + 1, 3), '', '超窗口还在催 —— 她主动搭话后的续跑会凭空道歉')
})

test('W5 没有来信时间就别催', () => {
  for (const v of [null, undefined, 0, -1, NaN, Infinity, 'abc']) {
    assert.equal(该催他了吗(v, 2), '', '输入 ' + String(v) + ' 不该催')
  }
})

test('W6 第 0 轮不喊「别再查了」，第 1 轮之后才喊', () => {
  const 首 = 该催他了吗(60000, 0)
  assert.ok(!首.includes('别再往下查了'), '第 0 轮就喊停，太急：' + 首)
  for (const n of [1, 2, 5]) {
    assert.ok(该催他了吗(60000, n).includes('别再往下查了'), '第 ' + n + ' 轮没喊停')
  }
})

test('W7 轮次缺失/非法也不能崩，按首轮处理', () => {
  const s = 该催他了吗(60000, undefined)
  assert.ok(s.includes('还在等你'), '没有内容：' + s)
  assert.ok(!s.includes('别再往下查了'), '非法轮次被当成老轮次')
})

// ---------------- 真的拼进注入了吗 ----------------

// BEHAVIOR 2026-11-16（批次521d）：文案抽进了 续跑提示()，这条也从源码断言改成行为断言。
// 原来找的是 `+ 等待句` 这行字 —— 抽了函数就找不到了，而「拼没拼进去」本来就该看输出。
test('W8 等待句必须真的拼进续跑那句话里，不是只算不用', () => {
  const 句 = 该催他了吗(65000, 1)
  assert.ok(句 !== '', '等待句没生成')
  const 话 = 续跑提示(句)
  assert.ok(话.includes(句), '等待句没拼进去：' + 话.slice(-80))
  assert.equal(话.split(句).length - 1, 1, '等待句被拼了不止一次')
})

test('W9 键必须用 targetKey（private:<uin>），不能手拼别的格式', () => {
  const 源码 = readFileSync(LIB + '/实时续跑.js', 'utf8')
  assert.ok(源码.includes('incomingAgeMs(targetKey(entry?.target))'),
    '取来信时间没用 targetKey —— 键对不上就永远是 null，等于没接')
})

// ---------------- 台账路径 ----------------

test('W10 system 里必须给出台账的直达命令', () => {
  const s = sys()
  assert.ok(s.includes('待办.mjs'), '没告诉她台账是哪个文件：' + s.slice(0, 120))
  assert.ok(s.includes('--加'), '没给写入参数，她还得自己猜')
  assert.ok(s.includes('台账'), '没把「台账」这个词和那个文件对上')
})

test('W11 台账规则在反客服腔之后（顺序固定才有缓存）', () => {
  const s = sys()
  const a = s.indexOf('客服腔')
  const b = s.indexOf('待办.mjs')
  assert.ok(a > 0 && b > 0, '有一条没注入')
  assert.ok(a < b, '顺序变了 —— 会打掉前缀缓存')
})

test('W12 同一轮内两次调用逐字相同（这条是静态的，不许带时间）', () => {
  const f = buildVoiceText(造('{{OWNER_UIN}}', true), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  assert.equal(f(), f(), '两次不一样，前缀缓存会被击穿')
})

test('W13 静音时仍然一个字都不注入', () => {
  assert.equal(sys('{{OWNER_UIN}}', true, true), '', 'mute 时被台账规则顶开了')
})

test('W14 群聊也有（群里同样会「记一下」）', () => {
  assert.ok(sys('1051483012', false).includes('待办.mjs'), '群聊没注入台账路径')
})
