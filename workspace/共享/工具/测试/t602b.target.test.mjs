// 批次 602B：出站目标校验 + 队列只出队一次。
// 只 import 纯函数模块，不碰 outbound 的发送链，不会真发 QQ。
import test from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

process.env.QUIET_NOTE = '1'

const LIB = process.env.QQ_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const mod = await import(pathToFileURL(join(LIB, 'target.js')).href)
const { normalizeQqId, resolvePrivateUin, newDequeueState, dequeueOnce, DeadLetterBox } = mod

test('T1 合法 QQ 号：字符串/数字都规范化成十进制字符串', () => {
  assert.deepEqual(normalizeQqId('{{OWNER_UIN}}'), { ok: true, id: '{{OWNER_UIN}}' })
  assert.deepEqual(normalizeQqId({{OWNER_UIN}}), { ok: true, id: '{{OWNER_UIN}}' })
  assert.deepEqual(normalizeQqId(' 123 '), { ok: true, id: '123' })
})

test('T2 显式非法值全部拒绝：空串/0/负数/小数/字母/科学计数法', () => {
  for (const bad of ['', '0', '-1', 'abc', '12.5', '1e3', '+123', '  ', 0, -5, 12.5, NaN, Infinity]) {
    const r = normalizeQqId(bad)
    assert.equal(r.ok, false, `应拒绝 ${String(bad)}`)
  }
})

test('T3 私聊 target 带 id 就必须合法，非法直接抛错，不回落默认对象', () => {
  for (const bad of ['', '0', '-1', 'abc', '12.5']) {
    assert.throws(() => resolvePrivateUin({ kind: 'private', id: bad }, '999999'), /私聊目标非法/)
  }
  assert.equal(resolvePrivateUin({ kind: 'private', id: '123456' }, '999999'), 123456)
})

test('T4 完全没带 id 才允许回落 peerUin；peerUin 也非法时报错', () => {
  assert.equal(resolvePrivateUin({ kind: 'private' }, '999999'), 999999)
  assert.throws(() => resolvePrivateUin({ kind: 'private' }, ''), /默认私聊对象无效/)
  assert.throws(() => resolvePrivateUin({ kind: 'private' }, 'abc'), /默认私聊对象无效/)
})

test('T5 队列项只出队一次：A 发送失败后 B 仍在队头', () => {
  const queue = [{ text: 'A' }, { text: 'B' }]
  const state = newDequeueState()
  // 模拟旧 bug：发送失败时 try/catch 各出队一次
  try {
    throw new Error('send fail')
  } catch {
    assert.equal(dequeueOnce(queue, state), true)
    assert.equal(dequeueOnce(queue, state), false)
  }
  assert.equal(queue.length, 1)
  assert.equal(queue[0].text, 'B')
})

test('T6 死信盒有界，保留最近 N 条，可清空', () => {
  const box = new DeadLetterBox(3)
  for (let i = 0; i < 5; i += 1) box.push({ n: i })
  assert.deepEqual(box.list().map((x) => x.n), [2, 3, 4])
  box.clear()
  assert.equal(box.list().length, 0)
})
