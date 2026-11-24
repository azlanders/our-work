// 批次507：延迟补偿 + 时差提示的回归
//
// 主人要的语义：
//   「如果卡的时间少于打字时间，就是打字时间减去卡的时间；超过就直接发」
//   「一句话断成多句，在第一条发出去之后再算」
//   「她要知道自己回的是 20 点那条」
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? (process.env.DSH_HOME + '/profiles/web/node_modules/dsh-onebot-channel/lib') : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const { 补偿毫秒 } = await import(LIB + '/outbound.js')
const { incomingAgeMs, markIncoming } = await import(LIB + '/rhythm.js')
const { 回话时差提示 } = await import(LIB + '/poll.js')

const 源码 = readFileSync(LIB + '/outbound.js', 'utf8')
const 轮询 = readFileSync(LIB + '/poll.js', 'utf8')

test('L1 卡得少 → 只补差额', () => {
  assert.equal(补偿毫秒(3000, 0), 3000)
  assert.equal(补偿毫秒(3000, 1000), 2000)
  assert.equal(补偿毫秒(3000, 2999), 1)
})

test('L2 卡够了 → 一秒都不补（这是这次要的核心）', () => {
  assert.equal(补偿毫秒(3000, 3000), 0)
  assert.equal(补偿毫秒(3000, 12000), 0, '卡 12 秒还要再等 3 秒，就是主人抱怨的「十几秒」')
  assert.equal(补偿毫秒(6500, 99999), 0)
})

test('L3 没收到过消息（主动搭话）→ 保持原样，不凭空补也不跳', () => {
  assert.equal(补偿毫秒(3000, null), 3000)
  assert.equal(补偿毫秒(3000, undefined), 3000)
})

test('L4 只减不加：任何输入都不会算出比目标更大', () => {
  for (const 已等 of [0, 1, 500, 2999, 3000, 3001, 60000, -5]) {
    const r = 补偿毫秒(3000, 已等)
    assert.ok(r >= 0 && r <= 3000, `已等=${已等} 算出 ${r}`)
  }
  assert.equal(补偿毫秒(0, 1000), 0, '目标为 0 不该等')
  assert.equal(补偿毫秒(NaN, 100), 0)
})

test('L5 incomingAgeMs：没记录返回 null，记录过按毫秒算', () => {
  assert.equal(incomingAgeMs('group:不存在'), null, '没收到过消息必须是 null，不能是 0')
  markIncoming('group:test507', Date.now() - 1500)
  const age = incomingAgeMs('group:test507')
  assert.ok(age !== null && age >= 1500 && age < 3000, '算出来 ' + age)
  assert.equal(incomingAgeMs(''), null)
})

test('L6 发送前用的是补偿值，不是原来的 waitMs（防回退）', () => {
  assert.ok(源码.includes('const 实等Ms = 补偿毫秒(目标Ms, 已等Ms)'), '没调用补偿函数')
  assert.ok(源码.includes('if (实等Ms > 0) await new Promise'), '等待那里没换成补偿值')
  assert.ok(!/await new Promise\(\(resolve\) => setTimeout\(resolve, waitMs\)\)/.test(源码), '还在拿 waitMs 直接等')
})

test('L7 补偿只作用于第一段：那段 wait 必须在分段循环之前', () => {
  const 补偿位 = 源码.indexOf('const 实等Ms = 补偿毫秒(')
  const 循环位 = 源码.indexOf('for (let i = 0; i < markedParts.length')
  assert.ok(补偿位 > 0 && 循环位 > 0, '没找到锚点')
  assert.ok(补偿位 < 循环位, '补偿落在了分段循环里面 —— 会被每一段各算一次')
})

test('L8 时差提示：6 秒以内不出现（秒回不该被这句话占地方）', () => {
  const now = Date.now()
  assert.equal(回话时差提示(Math.floor((now - 3000) / 1000), now), '')
  assert.equal(回话时差提示(Math.floor((now - 5000) / 1000), now), '')
})

test('L9 时差提示：真的变旧了就说清楚「不是刚发生的」', () => {
  const now = Date.now()
  // 注意别写死 30：Math.floor 会把毫秒抹掉，gap 可能是 30000~30999，取整后是 30 或 31。
  const 三十 = 回话时差提示(now / 1000 - 30, now)
  const m = 三十.match(/(\d+) 秒前/)
  assert.ok(m, '没写出秒数：' + 三十)
  assert.ok(Number(m[1]) >= 30 && Number(m[1]) <= 31, '秒数不对：' + m[1])
  assert.ok(三十.includes('不是刚发生'), 三十)
  const 五分 = 回话时差提示(Math.floor((now - 300000) / 1000), now)
  assert.ok(五分.includes('5 分钟前'), 五分)
  assert.equal(回话时差提示(0, now), '')
})

test('L10 时差提示两条路都接上了（群 + 私聊）', () => {
  assert.ok(轮询.includes('+ 回话时差提示(timeOf(message))'), '群聊没接')
  assert.ok(/回话时差提示\(timeOf\((last|messages\[messages\.length - 1\])\)\)/.test(轮询), '私聊没接')
})
