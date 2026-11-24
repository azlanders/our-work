// t547 —— 思考流：把每一轮的 thinking 旁路记下来（批次547）
//
// 它旁边不参与任何决策，但它是「她当时在想什么」的唯一记录，面板的「实时思考」页读的就是它。
// 三条硬约束，一条测试都没有：
//   · **逐 chunk 原样透传**（这个 Transform 不能改流，否则她就哑了或说错话）
//   · 只认 SSE 的 thinking_delta，别把正文当思考记下来
//   · 单条最多 4000 字，长的截断
//
// 原来 `输出` 路径写死，测它等于往真档里灌假思考。批次547 加了 QQ_THINK_OUT。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const 盒 = mkdtempSync(join(tmpdir(), 't547-'))
const OUT = join(盒, '思考流.jsonl')
process.env.QQ_THINK_OUT = OUT      // 必须在 import 之前：模块顶层就求值

const { 造记思流, 读思考, 记思考 } = await import('{{BOT_ROOT}}/共享/工具/思考流.mjs')

const SSE = (o) => 'data: ' + JSON.stringify(o) + '\n\n'
const 想 = (t) => SSE({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: t } })

// 喂一串 chunk，返回「透传出来的字节」和「是否正常 end」
function 喂(chunks, 谁 = '她') {
  return new Promise((res) => {
    const t = 造记思流(谁)
    const 透 = []
    t.on('data', (c) => 透.push(Buffer.from(c)))
    t.on('end', () => res(Buffer.concat(透).toString('utf8')))
    for (const c of chunks) t.write(Buffer.isBuffer(c) ? c : Buffer.from(c, 'utf8'))
    t.end()
  })
}
const 读行 = () => (existsSync(OUT) ? readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])

test('T1 逐 chunk 原样透传 —— 一个字节都不许改（改了她就不说话或说错话）', async () => {
  rmSync(OUT, { force: true })
  const 原 = ['abc', '中文', '{"type":"x"}', '\n\n']
  const 回 = await 喂(原)
  assert.equal(回, 原.join(''), '透传的内容被改了')
})

test('T2 多个 thinking_delta 拼成一条，正文（text_delta）不记', async () => {
  rmSync(OUT, { force: true })
  await 喂([
    想('我在想'),
    想('一件事'),
    SSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: '这是我嘴上说的' } }),
  ])
  const 行 = 读行()
  assert.equal(行.length, 1, '该只落一条')
  assert.equal(行[0].文, '我在想一件事')
  assert.equal(行[0].谁, '她')
  assert.equal(/这是我嘴上说的/.test(行[0].文), false, '正文被当思考记下来了')
})

test('T3 跨 chunk 断在半截的 SSE 也要接得上（真实场景就是一截一截来的）', async () => {
  rmSync(OUT, { force: true })
  const 全 = 'data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"断点续上"}}\n\n'
  const 断 = [全.slice(0, 20), 全.slice(20, 45), 全.slice(45)]
  await 喂(断)
  const 行 = 读行()
  assert.equal(行.length, 1)
  assert.equal(行[0].文, '断点续上')
})

test('T4 单条最多 4000 字，长了截断并留痕', async () => {
  rmSync(OUT, { force: true })
  await 喂([想('长'.repeat(5000))])
  const 行 = 读行()
  assert.equal(行.length, 1)
  assert.equal(行[0].文.length, 4000 + '…（截断）'.length)
  assert.match(行[0].文, /…（截断）$/)
})

test('T5 读思考：新的在前，按「谁」筛，n 夹在 1~200', async () => {
  rmSync(OUT, { force: true })
  writeFileSync(OUT, [
    JSON.stringify({ at: '2026-11-16 08:00:00', 谁: '她', 文: '第一条' }),
    JSON.stringify({ at: '2026-11-16 08:00:01', 谁: '她', 文: '第二条' }),
    JSON.stringify({ at: '2026-11-16 08:00:02', 谁: 'agent', 文: '别人的' }),
  ].join('\n') + '\n')
  const 她 = 读思考(10)
  assert.deepEqual(她.map((x) => x.文), ['第二条', '第一条'], '新的要在前，而且只给她')
  const 全部 = 读思考(10, '全部')
  assert.equal(全部.length, 3)
  assert.equal(读思考(0).length, 1, 'n=0 应该夹成 1')
})

test('T6 文件不存在时读思考返回空数组，不抛', () => {
  rmSync(OUT, { force: true })
  assert.deepEqual(读思考(10), [])
})

test('T7 开关：读不到当开着；显式 false 才关', () => {
  const p = join(盒, 'leak.json')
  assert.equal(记思考(p), true, '没文件时该默认开（只读功能，默认开比默认关好）')
  writeFileSync(p, JSON.stringify({ 记录思考: false }))
  assert.equal(记思考(p), false)
  writeFileSync(p, JSON.stringify({ 记录思考: true }))
  assert.equal(记思考(p), true)
  writeFileSync(p, '{ 坏的')
  assert.equal(记思考(p), true, '坏 JSON 也该当开着')
})

test('T8 没有思考（只有正文）时一条都不落', async () => {
  rmSync(OUT, { force: true })
  await 喂([SSE({ type: 'content_block_delta', delta: { type: 'text_delta', text: '只说了一句话' } })])
  assert.equal(读行().length, 0, '没有 thinking 却落了空记录')
})

test.after(() => { try { rmSync(盒, { recursive: true, force: true }) } catch {} })
