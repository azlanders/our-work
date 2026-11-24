// t543 —— 多把钥匙的故障转移（批次324 写的，一直零测试）（批次541）
//
// 这套判据错了，她**就说不了话**：该换的没换 → 哑到主人发现；不该换的换了 → 白烧一次上游。
// 全是纯函数（`路由.mjs` 开头就写着「纯函数，无 IO，方便单测」），却一条测试都没有。
import { test } from 'node:test'
import assert from 'node:assert'
const R = await import('{{BOT_ROOT}}/共享/工具/路由.mjs')

// ══════════ 判失败 ══════════
test('P1 余额的话优先于钥匙失效 —— 有的站用 401/400 表达没钱', () => {
  // 按「钥匙失效」处理会白冷 30 分钟，主人充了值也不恢复
  assert.deepEqual(R.判失败(401, 'insufficient balance'), { 换: true, 因: '余额不足' })
  assert.deepEqual(R.判失败(400, '{"error":"Insufficient Balance"}'), { 换: true, 因: '余额不足' })
  assert.deepEqual(R.判失败(429, '余额不足，请充值'), { 换: true, 因: '余额不足' })
})

test('P2 状态码直判：402/401/403/429/5xx/0', () => {
  assert.deepEqual(R.判失败(402, ''), { 换: true, 因: '余额不足' })
  assert.deepEqual(R.判失败(401, ''), { 换: true, 因: '钥匙失效' })
  assert.deepEqual(R.判失败(403, ''), { 换: true, 因: '拒绝访问' })
  assert.deepEqual(R.判失败(429, ''), { 换: true, 因: '限流' })
  assert.deepEqual(R.判失败(500, ''), { 换: true, 因: '上游故障' })
  assert.deepEqual(R.判失败(503, ''), { 换: true, 因: '上游故障' })
  assert.deepEqual(R.判失败(0, ''), { 换: true, 因: '连不上' })
})

test('P3 普通 400 不许换 —— 换一把 key 会得到同样的 400，白烧一次', () => {
  assert.deepEqual(R.判失败(400, 'invalid request: missing model'), { 换: false, 因: '' })
  assert.deepEqual(R.判失败(400, ''), { 换: false, 因: '' })
})

test('P4 400 但确实是限流 → 换', () => {
  assert.deepEqual(R.判失败(400, 'rate limit exceeded'), { 换: true, 因: '限流' })
  assert.deepEqual(R.判失败(400, '请求过于频繁'), { 换: true, 因: '限流' })
})

test('P5 200 / 3xx / 404 不换（404 是路径写错，换 key 没用）', () => {
  for (const s of [200, 201, 301, 404, 422]) {
    assert.equal(R.判失败(s, '').换, false, s + ' 不该换')
  }
})

test('P6 quota 归「限流」不归「没钱」—— 有的站用它表示这一小时用完', () => {
  // 这条第一版写成了自己跟自己比（`'余额不足' === '余额不足'`），永远为真 —— 假通过，已改死
  assert.deepEqual(R.判失败(429, 'quota exceeded for this hour'), { 换: true, 因: '限流' })
  assert.equal(R.判失败(429, 'quota exceeded').因, '限流')
  assert.equal(R.判失败(400, 'quota exhausted').因, '限流')
})

test('P7 需要读文：只在「读掉就没了」的那几个状态码上读', () => {
  for (const s of [400, 401, 402, 403, 429]) assert.equal(R.需要读文(s), true, String(s))
  for (const s of [200, 404, 500, 503]) assert.equal(R.需要读文(s), false, String(s))
})

// ══════════ 成项 ══════════
test('O1 官方那把 base 是空串 → 要补 官方BASE，否则整条被丢', () => {
  const 项 = R.成项({ id: 'a', key: 'k', base: '' }, {}, Date.now(), 0.5)
  assert.equal(项.base, R.官方BASE)
  assert.equal(项.key, 'k')
  assert.equal(项.跳过, '')
})

test('O2 base 尾部斜杠去掉（不然拼 URL 会出 //）', () => {
  assert.equal(R.成项({ id: 'a', key: 'k', base: 'https://x.com/v1//' }, {}, 0, 0.5).base, 'https://x.com/v1')
})

test('O3 冷却中 → 跳过，话说清还要等多久', () => {
  const now = 1000000
  const 项 = R.成项({ id: 'a', key: 'k', base: 'b' }, { a: { 冷却到: now + 42000, 因: '限流' } }, now, 0.5)
  assert.match(项.跳过, /限流/)
  assert.match(项.跳过, /42 秒/)
})

test('O4 余额低 → 跳过；但余额数据超过 10 分钟就不算数（可能已经充值了）', () => {
  const now = 1000000
  const 低 = R.成项({ id: 'a', key: 'k', base: 'b' }, { a: { 余额: 0.2, 余额于: now - 60000 } }, now, 0.5)
  assert.match(低.跳过, /余额只剩 0\.2/)
  const 过期 = R.成项({ id: 'a', key: 'k', base: 'b' }, { a: { 余额: 0.2, 余额于: now - 11 * 60e3 } }, now, 0.5)
  assert.equal(过期.跳过, '', '11 分钟前的余额还拿去拦，会让她一直不用这把')
})

// ══════════ 建链 ══════════
const 候选 = [
  { id: 'a', 名: 'A站', base: 'https://a', key: 'ka' },
  { id: 'b', 名: 'B站', base: 'https://b', key: 'kb' },
  { id: 'c', 名: '官方', base: '', key: 'kc' },
]

test('B1 顺序就是 conf.路由 的顺序', () => {
  const 链 = R.建链({ 路由: ['b', 'a'] }, 候选, {}, 0)
  assert.deepEqual(链.map((x) => x.id), ['b', 'a'])
})

test('B2 路由里写了不存在的 id → 跳过，不报错（删钥匙不用同步改路由）', () => {
  const 链 = R.建链({ 路由: ['zzz', 'a'] }, 候选, {}, 0)
  assert.deepEqual(链.map((x) => x.id), ['a'])
})

test('B3 同一个 base+key 只留一条 —— 否则第一把挂了会拿同一把再试一次', () => {
  const 链 = R.建链({
    路由: ['a'],
    fallback: { base: 'https://a', key: 'ka' },
  }, 候选, {}, 0)
  assert.equal(链.length, 1, '重复通道没去重：' + JSON.stringify(链.map((x) => x.id)))
})

test('B4 空路由 + 老配置（base/key）→ 只走当前这把，跟改之前一样', () => {
  const 链 = R.建链({ base: 'https://a', key: 'ka' }, 候选, {}, 0)
  assert.deepEqual(链.map((x) => x.id), ['当前'])
})

test('B5 fallback 永远追加在末尾', () => {
  const 链 = R.建链({ 路由: ['a'], fallback: { base: 'https://f', key: 'kf' } }, 候选, {}, 0)
  assert.equal(链.length, 2)
  assert.match(链[1].id, /^兜底:/)
})

test('B6 没有 key 的条目直接丢', () => {
  const 链 = R.建链({ 路由: ['nokey'] }, [{ id: 'nokey', base: 'https://x' }], {}, 0)
  assert.equal(链.length, 0)
})

// ══════════ 挑顺序 ══════════
test('S1 有活的就只试活的', () => {
  const 链 = [{ id: 'a', 跳过: '' }, { id: 'b', 跳过: '限流，还等 30 秒' }]
  const r = R.挑顺序(链)
  assert.deepEqual(r.试.map((x) => x.id), ['a'])
  assert.equal(r.全冷却, false)
})

test('S2 全冷却时硬按原顺序试一遍 —— 宁可打一把可能已经恢复的，也不能让她彻底哑', () => {
  const 链 = [{ id: 'a', 跳过: 'x' }, { id: 'b', 跳过: 'y' }]
  const r = R.挑顺序(链)
  assert.deepEqual(r.试.map((x) => x.id), ['a', 'b'])
  assert.equal(r.全冷却, true)
})

test('S3 空链不炸', () => {
  assert.deepEqual(R.挑顺序([]), { 试: [], 全冷却: false })
  assert.deepEqual(R.挑顺序(null), { 试: [], 全冷却: false })
})

test('T1 时刻串是北京时间，不是 UTC', () => {
  // 2026-11-16 00:00 UTC = 北京 08:00
  assert.equal(R.时刻串(Date.UTC(2026, 10, 16, 0, 0, 0)), '11-16 08:00')
})
