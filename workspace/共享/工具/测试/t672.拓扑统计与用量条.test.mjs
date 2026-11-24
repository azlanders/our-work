// 批次672：拓扑卡补 magpie 那套「成员用量条 + 底部请求/改道/错误统计」。
//
// 为什么要单独测：这三个数是**从流水推出来的**，不是上游给的。
// 口径错了会比不显示更糟 —— 比如把 omni 的听/说算成请求，或者把 0 token 的探针
// 噪音算成一次成功，主人会以为「今天请求暴涨」。
//
// 只测纯函数，不起服务、不读生产文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const { 派生四层, 路由统计 } = await import(pathToFileURL(join(工具, '黑箱四层.mjs')).href)

const 行 = (o) => ({ at: '2026-11-17 17:00:00', 用途: '对话', 入: 100, 出: 10, 毫秒: 2000, ...o })

test('S1 正常一次请求：1 请求、0 改道、0 错误', () => {
  const s = 路由统计([行({ 路由: [{ 名: 'A', 命中: true }] })])
  assert.deepEqual(s, { 请求: 1, 改道: 0, 错误: 0 })
})

test('S2 第一把挂了换第二把：1 请求、1 改道、1 错误', () => {
  const s = 路由统计([行({ 路由: [{ 名: 'A', 状态: 502, 因: '上游故障' }, { 名: 'B', 命中: true }] })])
  assert.equal(s.请求, 1, '一次对话只能算一次请求')
  assert.equal(s.改道, 1, '轨迹长度 2 表示换了 1 次')
  assert.equal(s.错误, 1, '502 是一次真实发生过的上游错误')
})

test('S3 连跳两把：改道 2、错误 2', () => {
  const s = 路由统计([行({ 路由: [
    { 名: 'A', 状态: 429, 因: '限流' }, { 名: 'B', 状态: 403, 因: 'WAF' }, { 名: 'C', 命中: true },
  ] })])
  assert.equal(s.改道, 2)
  assert.equal(s.错误, 2)
})

test('S4 omni（听/说）不算请求', () => {
  const s = 路由统计([行({}), 行({ omni: '说', 入: 0, 出: 0, 字: 30 })])
  assert.equal(s.请求, 1, 'omni 没有路由轨迹，混进来会把改道率算低')
})

test('S5 0 token 的探针噪音不算请求', () => {
  const s = 路由统计([行({ 入: 0, 出: 0, 毫秒: 12 })])
  assert.deepEqual(s, { 请求: 0, 改道: 0, 错误: 0 })
})

test('S6 空输入 / null 不抛', () => {
  assert.deepEqual(路由统计([]), { 请求: 0, 改道: 0, 错误: 0 })
  assert.deepEqual(路由统计(null), { 请求: 0, 改道: 0, 错误: 0 })
})

test('S7 老记录没有 路由 字段：算请求，但不算改道/错误', () => {
  const s = 路由统计([行({})])
  assert.deepEqual(s, { 请求: 1, 改道: 0, 错误: 0 })
})

test('S8 四层带出成员今日用量与余额，缺了就是 null 不编', () => {
  const 候选 = [
    { id: 'a', 名: '0.2倍率中转站', 上游: 'portdan.com', map: {}, 查: { ok: true }, 用量: { calls: 328, tok: 5403000 } },
    { id: 'b', 名: 'deepseek 官方', 上游: '（deepseek 官方）', map: {}, 查: { ok: true, 余额: 12.5, 币: 'CNY' } },
  ]
  const L = 派生四层({ 候选, 现: { 路由: ['a', 'b'] }, health: null, 康: { ok: true } })
  const a = L.路由.find((r) => r.id === 'a')
  const b = L.路由.find((r) => r.id === 'b')
  assert.equal(a.今日.tok, 5403000)
  assert.equal(a.余额, null, '中转站没给余额时必须是 null，前端才不会显示 ¥null')
  assert.equal(b.余额, 12.5)
  assert.equal(b.币, 'CNY')
})

test('S10 上游探测 / 标题生成不算「聊天请求」', () => {
  const s = 路由统计([行({ 用途: '上游探测' }), 行({ 用途: '标题生成' }), 行({ 用途: '对话' })])
  assert.equal(s.请求, 1, '探测和标题不是她开口触发的，混进来会让请求数虚高')
})

test('S9 路由组说明写清真实规则（按倍率、同倍率按面板顺序、失败或余额低才换）', () => {
  const L = 派生四层({ 候选: [{ id: 'a', 名: 'A', 上游: 'x.com', map: {} }], 现: { 路由: ['a'] }, 康: { ok: true } })
  assert.match(L.路由组.说明, /倍率/)
  assert.match(L.路由组.说明, /面板顺序/)
  assert.match(L.路由组.说明, /失败或余额低/)
  assert.equal(L.路由组.启用, 1)
})
