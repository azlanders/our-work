import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次422：`想要.json` 里「独处的时候在想」这一节 2026-11-01 就在，但没有任何代码读它。
// 这里锁的是：只在真独处时提、空的不提、不撑爆注入；顺便锁住「删掉的那四段别再悄悄加回来」。
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 记忆 = '{{BOT_ROOT}}/记忆'
const { slotAlone } = await import(join(LIB, 'voiceSlots.js'))

function 造(独处, 上次说话) {
  const sb = mkdtempSync(join(tmpdir(), 'alone422-'))
  writeFileSync(join(sb, '想要.json'), JSON.stringify({ 当下想要: [], 独处的时候在想: 独处 }))
  writeFileSync(join(sb, '最近说话.json'), JSON.stringify({ 123: 上次说话 }))
  return sb
}

test('A1 一个人待着超过 40 分钟 → 提一句', () => {
  const sb = 造(['想养一只猫', '想再去一次海边'], Date.now() - 60 * 60e3)
  const s = slotAlone({ memDir: sb, peer: '123' })
  assert.match(s, /想养一只猫/, '没带内容：' + s)
  assert.match(s, /想再去一次海边/, '只带了一条：' + s)
  assert.match(s, /别念出这条提示/, '没堵「念出来」：' + s)
  assert.ok(s.length <= 140, '注入太长（' + s.length + ' 字）：' + s)
  rmSync(sb, { recursive: true, force: true })
})

test('A2 刚才还在聊（5 分钟前）→ 一个字都不提', () => {
  const sb = 造(['想养一只猫'], Date.now() - 5 * 60e3)
  assert.equal(slotAlone({ memDir: sb, peer: '123' }), '', '热聊时插一句「你独处时想这些」是穿帮')
  rmSync(sb, { recursive: true, force: true })
})

test('A3 过线 41 分钟就该提了（边界另一边）', () => {
  const sb = 造(['想养一只猫'], Date.now() - 41 * 60e3)
  assert.notEqual(slotAlone({ memDir: sb, peer: '123' }), '', '41 分钟还不提，门槛就是 40 分钟')
  rmSync(sb, { recursive: true, force: true })
})

test('A4 空的 / 没文件 / 坏档 都返回空，不抛', () => {
  const 空 = 造([], Date.now() - 60 * 60e3)
  assert.equal(slotAlone({ memDir: 空, peer: '123' }), '')
  const 没 = mkdtempSync(join(tmpdir(), 'alone422-无-'))
  assert.equal(slotAlone({ memDir: 没, peer: '123' }), '')
  const 坏 = mkdtempSync(join(tmpdir(), 'alone422-坏-'))
  writeFileSync(join(坏, '想要.json'), '{ 不是 json')
  assert.equal(slotAlone({ memDir: 坏, peer: '123' }), '')
  rmSync(空, { recursive: true, force: true })
  rmSync(没, { recursive: true, force: true })
  rmSync(坏, { recursive: true, force: true })
})

test('A5 没记录过这个人 → 当成很久没说话，还是提', () => {
  const sb = 造(['想养一只猫'], 0)
  assert.notEqual(slotAlone({ memDir: sb, peer: '999' }), '', '从没说过话的人，更该是「独处」')
  rmSync(sb, { recursive: true, force: true })
})

test('A6 那四段别悄悄加回来（加了就得有代码读）', () => {
  const w = JSON.parse(readFileSync(join(记忆, '想要.json'), 'utf8'))
  for (const k of ['想约的', '对未来的想象', '第一次', '承诺']) {
    assert.equal(w[k], undefined, '「' + k + '」被加回来了 —— 加回来就得接上读方，否则又是「写了没接」')
  }
  assert.ok(Array.isArray(w['独处的时候在想']), '独处的时候在想 不见了')
})

test('A7 人味的「自省」按设计不注入（它自带「不每轮注入」用法标注）', () => {
  // SELF_NOTE 2026-11-24：旧断言写 `assert.equal(r['自省'], undefined)`，注释说
  // 「批次422 把自省删了」。实测：自省**一直在** 人味.json 里，它自带
  //   { 节奏: '每月重写一次自述…', 用法: '不每轮注入，写自述时才翻' }
  // —— 它不是「没接」，是**按设计不每轮注入**。conclusion 与数据不一致，红的不是代码。
  // 现在断言真实约定：这一节必须在、必须保留「不每轮注入」的使用说明，
  // 并且 poll.js 的注入代码不许引用它（引用了就等于每轮都注入，违反它自己的用法）。
  const r = JSON.parse(readFileSync(join(记忆, '人味.json'), 'utf8'))
  assert.ok(r['自省'], '自省 这一节不见了；删掉的话要同步本测试与契约第 23 条的豁免表')
  assert.match(String(r['自省']['用法'] || ''), /不每轮注入/,
    '自省的「用法」必须仍写着「不每轮注入」，否则它就该被接进注入、豁免不再成立')
  const poll源 = readFileSync(join(LIB, 'poll.js'), 'utf8')
  assert.ok(!poll源.includes("rw['自省']") && !poll源.includes('rw["自省"]'),
    'poll.js 引用了 人味.自省 —— 违反它自己写的「不每轮注入」')
})

test('A8 qq_self 的描述里得告诉她这个槽是干什么的', () => {
  const 工具 = readFileSync(join(LIB, 'tool.js'), 'utf8')
  // 两处都要：path 的写法示例（她照着敲）和用途说明（她写得对不对）。
  // 只断言「文件里出现过这个词」是不够的 —— 另一处还在，删了这处也绿（反测时踩到的）。
  assert.match(工具, /想要\.当下想要 \/ 想要\.独处的时候在想/, 'path 的写法示例里没有它，她不知道能往这写')
  assert.match(工具, /安静下来会想起来的事/, '没解释这一节是干什么的，她会写成像待办清单一样的句子')
  assert.match(工具, /安静下来会想起来的事/, '没解释这一节是干什么的，她会写成像待办清单一样的句子')
})
