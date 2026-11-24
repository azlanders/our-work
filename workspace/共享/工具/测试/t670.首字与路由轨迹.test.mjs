// 批次670：流水补两个真数据缺口 —— 首字耗时、成功请求的路由轨迹。
//
// 事故：面板要画「最近一个请求怎么路由的」「首字耗时」，但流水里
//   ① 2790 条 `首字` 全是 0 —— 判据只认 OpenAI 的 `"content":"…"`，
//      而 dsh 走 Anthropic `/v1/messages`（流式字段叫 `text`，非流式 content 是数组）；
//   ② `路由` 只在失败时记（`试过.length ? 试过 : undefined`），
//      2911 条里只有 38 条有，且全是失败。
//
// 这里只测两个纯函数，不起服务、不读生产文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const { 见到正文, 路由轨迹 } = await import(pathToFileURL(join(工具, 'usage-解析.mjs')).href)

test('F1 Anthropic 流式 text_delta 能认出正文（原来这里漏判）', () => {
  const s = 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你"}}\n\n'
  assert.equal(见到正文(s), true, 'Anthropic 流式正文没认出来，首字会永远是 0')
})

test('F2 OpenAI 兼容流式的 content 也能认（老口径不能丢）', () => {
  assert.equal(见到正文('data: {"choices":[{"delta":{"content":"好"}}]}'), true)
})

test('F3 空 text / 只有 role / keep-alive 不算开口', () => {
  assert.equal(见到正文('data: {"delta":{"type":"text_delta","text":""}}'), false, '空串是块边界，不是正文')
  assert.equal(见到正文('data: {"type":"message_start","message":{"role":"assistant"}}'), false)
  assert.equal(见到正文(': keep-alive\n\n'), false)
  assert.equal(见到正文(''), false)
})

test('F4 非流式响应体里的 text 块也算正文', () => {
  const s = '{"id":"msg_1","content":[{"type":"text","text":"在的"}]}'
  assert.equal(见到正文(s), true)
})

test('F5 路由轨迹：第一条就成功时补一条命中，且标命中', () => {
  const r = 路由轨迹([], { 名: '0.2倍率中转站' })
  assert.equal(r.length, 1)
  assert.equal(r[0].名, '0.2倍率中转站')
  assert.equal(r[0].命中, true, '成功的请求必须标出命中，否则面板还是画不出走了谁')
})

test('F6 路由轨迹：前一条失败、后一条成功，两条都在且只有一条命中', () => {
  const r = 路由轨迹(
    [{ 名: '0.2倍率中转站', 状态: 502, 因: '上游故障' }],
    { 名: '0.4倍率中转站' },
  )
  assert.equal(r.length, 2)
  assert.equal(r[0].命中, undefined, '失败的那条不该被标命中')
  assert.equal(r[1].名, '0.4倍率中转站')
  assert.equal(r[1].命中, true)
})

test('F7 路由轨迹：命中项已在试过里（重试同一条成功）不重复追加', () => {
  const r = 路由轨迹([{ 名: 'A' }], { 名: 'A' })
  assert.equal(r.length, 1)
  assert.equal(r[0].命中, true)
})

test('F8 路由轨迹：没有选中项时原样返回，不编造命中', () => {
  const 原 = [{ 名: 'A', 状态: 502, 因: '上游故障' }]
  const r = 路由轨迹(原, null)
  assert.deepEqual(r, 原)
  assert.equal(r.some((x) => x.命中), false)
})

test('F9 路由轨迹不污染入参（面板/测试可能复用同一份）', () => {
  const 原 = [{ 名: 'A', 状态: 502, 因: '上游故障' }]
  路由轨迹(原, { 名: 'B' })
  assert.equal(原.length, 1, '入参被追加了，调用方会看到脏数据')
  assert.equal(原[0].命中, undefined)
})
