// 批次671：路由组拓扑卡下半段 —— 「最近一个请求」怎么挑、怎么压。
//
// 为什么不能直接取流水最后一行：里面混着 omni（听/说）、探针，以及 466 记的
// 「0 token + 十几毫秒」测试噪音。取错一行，卡上就显示 0 / 0ms，看着像坏了。
//
// 只测纯函数，不起服务、不读生产文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const { 最近一个请求 } = await import(pathToFileURL(join(工具, '黑箱四层.mjs')).href)

const 行 = (o) => ({ at: '2026-11-17 17:00:00', 用途: '对话', 入: 100, 出: 10, 毫秒: 2000, ...o })

test('Q1 取最后一条真的调过模型的对话，跳过末尾的 0 token 噪音', () => {
  const rows = [
    行({ at: '2026-11-17 16:00:00', 入: 500, 出: 50, 摘要: '真对话' }),
    行({ at: '2026-11-17 17:00:00', 入: 0, 出: 0, 毫秒: 12, 摘要: '测试噪音' }),
  ]
  const q = 最近一个请求(rows, (r) => r.上游 || '')
  assert.equal(q.at, '2026-11-17 16:00:00', '取到了 0 token 的噪音行，卡上会显示 0/0ms')
  assert.equal(q.摘要, '真对话')
})

test('Q2 omni（听/说）不算对话，跳过', () => {
  const rows = [
    行({ 入: 300, 出: 30, 摘要: '对话' }),
    行({ at: '2026-11-17 18:00:00', omni: true, 入: 300, 出: 30 }),
  ]
  const q = 最近一个请求(rows, (r) => r.上游 || '')
  assert.equal(q.摘要, '对话', 'omni 记录没有 首字/路由，混进卡里会显示空白')
})

test('Q3 老记录首字为 0 时给 null（前端显示「—」，不假装 0ms）', () => {
  const q = 最近一个请求([行({ 首字: 0 })], (r) => r.上游 || '')
  assert.equal(q.首字, null)
})

test('Q4 新记录首字照原样带出，并带上口径', () => {
  const q = 最近一个请求([行({ 首字: 4663, 首字口径: '流式首字', 流式: true })], (r) => r.上游 || '')
  assert.equal(q.首字, 4663)
  assert.equal(q.首字口径, '流式首字')
  assert.equal(q.流式, true)
})

test('Q5 路由轨迹规整成 {名,命中,状态,因}，不把原始字段漏出去', () => {
  const q = 最近一个请求([
    行({ 路由: [{ 名: 'A', 状态: 502, 因: '上游故障' }, { 名: 'B', 命中: true }] }),
  ], (r) => r.上游 || '')
  assert.equal(q.路由.length, 2)
  assert.deepEqual(q.路由[0], { 名: 'A', 命中: false, 状态: 502, 因: '上游故障' })
  assert.deepEqual(q.路由[1], { 名: 'B', 命中: true, 状态: 0, 因: '' })
})

test('Q6 缓存率按 缓读/入 算，入为 0 时不出 NaN', () => {
  assert.equal(最近一个请求([行({ 入: 1000, 缓读: 900 })], (r) => r.上游 || '').缓存率, 90)
  const 零 = 最近一个请求([行({ 入: 0, 出: 5, 缓读: 0 })], (r) => r.上游 || '')
  assert.equal(零.缓存率, 0, '入为 0 时缓存率必须是 0，不是 NaN')
})

test('Q7 一条可用记录都没有时返回 null，不编造', () => {
  assert.equal(最近一个请求([], () => ''), null)
  assert.equal(最近一个请求([行({ 入: 0, 出: 0 })], () => ''), null)
  assert.equal(最近一个请求(null, () => ''), null)
})
