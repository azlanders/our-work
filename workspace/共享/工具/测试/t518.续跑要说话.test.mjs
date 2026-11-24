// 批次518 加、批次521d 改成行为测试：续跑那句提示
//
// 为什么改：原来 R1–R5 全是 `readFileSync(实时续跑.js).includes(...)`。
// 把「想说的话必须调 qq_send」删掉、或者把「不要发任何消息」加回来，源码断言可能漏。
// 现在 续跑提示() 是纯函数，直接喂参数看它吐出什么。
//
// 背景（2026-11-16 03:56）：她 qq_watch_video 看完，把点评写在正文里没调 qq_send，
// 主人干等 5 分钟。而当时续跑那句话写的是「这一轮**不要发任何消息**，直接调 qq_pass」。
import test from 'node:test'
import assert from 'node:assert/strict'

// t453 A1：文件里出现插件路径就要静音
process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 续跑提示, 该催他了吗 } = await import(LIB + '/实时续跑.js')
const { markVoiceTarget, buildVoiceText } = await import(LIB + '/stateVoice.js')

test('R1 想说的话必须走 qq_send（这就是「接不上话」的根因）', () => {
  const s = 续跑提示('')
  assert.ok(s.includes('想说的话必须调 qq_send'), '没这句，她还会把话写在正文里：' + s)
  assert.ok(s.includes('只写正文'), '没说明「只写正文收不到」这个后果')
})

test('R2 绝不能再出现「不要发任何消息」（就是它把她的话压住的）', () => {
  for (const 等待 of ['', '（他最后那句到现在已经 65 秒了，还在等你。）']) {
    assert.ok(!续跑提示(等待).includes('不要发任何消息'), '又把它写回去了')
  }
})

test('R3 仍要挡住「我不出声了」这类元话术', () => {
  assert.ok(续跑提示('').includes('我不出声了'), '反元话术那句被删了')
})

test('R4 收尾仍然走 qq_pass，不能改成「发消息收尾」', () => {
  const s = 续跑提示('')
  assert.ok(s.includes('qq_pass'), '没写清收尾调什么：' + s)
  assert.ok(s.includes('收尾'), '没提「收尾」这个动作')
})

test('R5 等待句必须拼在末尾（拼中间会把「收尾说明」挤到后面）', () => {
  const 句 = 该催他了吗(65000, 1)
  assert.ok(句 !== '', '等待句没生成')
  assert.ok(续跑提示(句).endsWith(句), '等待句不在末尾：' + 续跑提示(句).slice(-70))
})

test('R6 等待句为空/undefined 时不许拼出 "undefined" / "null"', () => {
  for (const v of ['', undefined, null]) {
    const s = 续跑提示(v)
    assert.ok(!s.includes('undefined'), '拼出 undefined：' + s.slice(-40))
    assert.ok(!s.includes('null'), '拼出 null：' + s.slice(-40))
  }
})

test('R7 提示总长要压在 260 字以内（每轮续跑都注入，别越堆越长）', () => {
  const s = 续跑提示(该催他了吗(65000, 1))
  assert.ok(s.length < 260, '太长了（' + s.length + ' 字），以后别往里堆规则')
})

// ---------------- 通用规则：正文不发 ----------------
const 造 = (peer, isPrivate, mute = false) => {
  const a = {}
  markVoiceTarget(a, { peer, isPrivate, mute, at: Date.now() })
  return a
}
const sys = (mute = false) =>
  buildVoiceText(造('{{OWNER_UIN}}', true, mute), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })()

test('B1 通用规则必须说清「正文只有自己看得见」', () => {
  const s = sys()
  assert.ok(s.includes('正文只有你自己看得见'), '没这句，她还会把话写在正文里')
  assert.ok(s.includes('一个字都收不到'), '没说明后果')
})

test('B2 必须指名 qq_send（不说工具名等于没说）', () => {
  const s = sys()
  const i = s.indexOf('正文只有你自己看得见')
  assert.ok(i > 0)
  assert.ok(s.slice(i, i + 200).includes('qq_send'), '这一段没提 qq_send')
})

test('B3 顺序固定：这条在「还没回话」之后（顺序变会打掉前缀缓存）', () => {
  const s = sys()
  const a = s.indexOf('还没回话')
  const b = s.indexOf('正文只有你自己看得见')
  assert.ok(a > 0 && b > a, '顺序变了：' + a + ',' + b)
})

test('B4 静音时仍然一个字都不注入', () => {
  assert.equal(sys(true), '')
})

test('B5 同一轮两次调用逐字相同', () => {
  const f = buildVoiceText(造('{{OWNER_UIN}}', true), { ownerUin: '{{OWNER_UIN}}', 状态进正文: true })
  assert.equal(f(), f())
})
