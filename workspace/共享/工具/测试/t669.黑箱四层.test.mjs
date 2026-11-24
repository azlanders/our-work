// 批次669：黑箱四层视图（供应商 / 路由 / 路由组 / 网关）的派生逻辑。
//
// 事故背景：批次668 自动切官方把 `路由` 写成 `[]`，面板「换的顺序」只剩官方一条，
// 主人以为另两把 key 丢了。候选档其实一直是好的 —— 问题在于这套东西**没有层级**，
// 看不出「key 还在、只是没进链」。四层视图要能一眼回答这个。
//
// 这里只测纯函数 `派生四层()`，不启动面板、不读生产文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const { 派生四层 } = await import(pathToFileURL(join(工具, '黑箱四层.mjs')).href)

const 候选 = [
  { id: 'kmw7vb3qr', 名: 'deepseek 官方', 上游: '（deepseek 官方）', map: {}, 备注: '兜底用', 查: { ok: true } },
  { id: 'kmw7vbqwk', 名: '0.2倍率中转站', 上游: 'portdan.com', map: { 'deepseek-flash': 'deepseek-v4.1-flash' }, 备注: '主号' },
  { id: 'kmw7vbz6q', 名: '0.4倍率中转站', 上游: 'portdan.com', map: { 'deepseek-flash': 'deepseek-v4.1-flash' }, 备注: '备用' },
]
const 现 = {
  名: '0.2倍率中转站',
  路由: ['kmw7vbqwk', 'kmw7vbz6q', 'kmw7vb3qr'],
  fallback: { base: 'https://api.deepseek.com/anthropic' },
}

test('L1 供应商按 base 归并：同站两把 key 是一家、两条路由', () => {
  const L = 派生四层({ 候选, 现, health: null, 康: { ok: true } })
  assert.equal(L.供应商.length, 2, '应归并成 2 家（官方 + portdan）')
  const 中 = L.供应商.find((p) => p.上游 === 'portdan.com')
  assert.equal(中.钥匙数, 2, '同站两把 key 必须都算进这家供应商')
  assert.deepEqual(中.钥匙, ['kmw7vbqwk', 'kmw7vbz6q'])
  assert.equal(L.路由.length, 3, '路由是每条候选一条，不能被供应商归并掉')
})

test('L2 路由组：成员是有序 id 引用，顺序跟中转给的一致', () => {
  const L = 派生四层({
    候选, 现, health: { 路由: [{ id: 'kmw7vbz6q' }, { id: 'kmw7vbqwk' }, { id: 'kmw7vb3qr' }] }, 康: { ok: true },
  })
  assert.deepEqual(L.路由组.成员, ['kmw7vbz6q', 'kmw7vbqwk', 'kmw7vb3qr'], '链顺序应以中转为准')
  assert.equal(L.路由组.策略, 'rate')
  assert.equal(L.路由组.空链, false)
})

test('L3 事故复现：路由被清空时，四层仍显示 3 条路由，只有 1 条在链里', () => {
  const L = 派生四层({ 候选, 现: { ...现, 路由: [] }, health: null, 康: { ok: true } })
  assert.equal(L.路由.length, 3, 'key 没丢，路由层必须还看得到 3 条')
  assert.equal(L.路由.filter((r) => r.在链里).length, 0, '空链时没有任何路由在链里')
  assert.equal(L.路由组.空链, true, '空链必须显式标出来')
  assert.match(L.路由组.说明, /未排顺序/)
})

test('L4 中转挂了就退回配置里排的意图，而不是显示空链', () => {
  const L = 派生四层({ 候选, 现, health: null, 康: { ok: false } })
  assert.deepEqual(L.路由组.成员, ['kmw7vbqwk', 'kmw7vbz6q', 'kmw7vb3qr'], 'health 拉不到时要用配置里的顺序')
  assert.equal(L.网关.活着, false)
})

test('L5 网关层：当前指针、兜底域名（去掉协议）', () => {
  const L0 = 派生四层({ 候选, 现, health: null, 康: { ok: true } })
  assert.equal(L0.网关.活着, true)
  assert.equal(L0.网关.当前, '', '没有 /health 先试时不能编造当前槽')
  const L = 派生四层({
    候选,
    现,
    health: { 先试: 'kmw7vbqwk', 路由: [{ id: 'kmw7vbqwk', 名: '0.2倍率中转站' }] },
    康: { ok: true },
  })
  assert.equal(L.网关.活着, true)
  assert.equal(L.网关.当前, '0.2倍率中转站')
  assert.equal(L.网关.兜底, 'api.deepseek.com/anthropic', '兜底要给人看，不能带 https://')
})

test('L6 健康未知不编造：没有探测结果时 健康 是空串，不是 bad', () => {
  const L = 派生四层({ 候选, 现, health: null, 康: null })
  assert.equal(L.路由.find((r) => r.id === 'kmw7vbqwk').健康, '', '没探测过就说不知道，不能标红')
  assert.equal(L.网关.活着, false)
})

test('L7 空候选不炸：返回空四层而不是抛错', () => {
  const L = 派生四层({ 候选: [], 现: {}, health: null, 康: null })
  assert.deepEqual(L.供应商, [])
  assert.deepEqual(L.路由, [])
  assert.equal(L.路由组.空链, true)
})
