// 批次668：自动切官方不能把路由清空。
//
// 事故（2026-11-17 11:30）：探测脚本连续失败 2 次后自动切官方，写了 `路由 = []`。
// 中转把空路由定义成「退回老行为 = 只试当前这把 + fallback」，而切换后当前和兜底
// 是同一把官方 key，按 `base|key` 去重后整条链只剩 1 项 ——
// 面板「换的顺序」只剩官方一条，主人以为其余两把密钥丢了（候选档一直是好的）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const { 置顶官方, 建链 } = await import(工具 + '/路由.mjs')

const 候选 = [
  { id: 'kmw7vb3qr', 名: 'deepseek 官方', base: '', key: 'sk-74b9...21ef' },
  { id: 'kmw7vbqwk', 名: '0.2倍率中转站', base: 'https://portdan.com', key: 'sk-9cda...e004' },
  { id: 'kmw7vbz6q', 名: '0.4倍率中转站', base: 'https://portdan.com', key: 'sk-9162...ee14' },
]
const 兜底 = { base: 'https://api.deepseek.com/anthropic', key: 'sk-74b9...21ef' }

test('R1 置顶官方：官方排到第一位，其余顺序原样保留', () => {
  const r = 置顶官方(['kmw7vbqwk', 'kmw7vbz6q'], 候选, 兜底.key)
  assert.equal(r.找到, true, '候选档里明明有官方那把，却没找到')
  assert.deepEqual(r.路由, ['kmw7vb3qr', 'kmw7vbqwk', 'kmw7vbz6q'],
    '置顶后顺序不对（官方该在最前，其余保持原序）')
})

test('R2 官方本来就是第一个时，不重复、不重排', () => {
  const r = 置顶官方(['kmw7vb3qr', 'kmw7vbqwk', 'kmw7vbz6q'], 候选, 兜底.key)
  assert.deepEqual(r.路由, ['kmw7vb3qr', 'kmw7vbqwk', 'kmw7vbz6q'], '幂等性坏了')
  assert.equal(new Set(r.路由).size, r.路由.length, '出现了重复 id')
})

test('R3 候选档里没有官方 key 时，保留旧路由不动（宁可切换无效也不丢链）', () => {
  const r = 置顶官方(['a', 'b'], [], 兜底.key)
  assert.equal(r.找到, false)
  assert.deepEqual(r.路由, ['a', 'b'], '找不到官方时竟然把路由改掉了')
})

test('R4 事故复现：路由清空后建链只剩 1 条；置顶官方后仍是 3 条', () => {
  const 事故配置 = {
    名: 'deepseek 官方（自动切的 2026-11-17 11:30）',
    base: 兜底.base, key: 兜底.key, map: {}, 路由: [],
  }
  const 坏 = 建链(事故配置, 候选, {})
  assert.equal(坏.length, 1, '空路由 + 当前=兜底 竟然不是 1 条？事故机理变了')
  assert.equal(坏[0].base, 兜底.base, '塌下去的那条不是官方')

  // 按修法切一次：官方置顶、其余保留
  const { 路由: 新路 } = 置顶官方(['kmw7vbqwk', 'kmw7vbz6q'], 候选, 兜底.key)
  const 好 = 建链({ ...事故配置, 路由: 新路 }, 候选, {})
  assert.equal(好.length, 3, '修完链长还是不对 —— 其余两把还是会丢')
  assert.equal(好[0].base, 兜底.base, '官方没有排到最前，自动切官方等于没生效')
  assert.deepEqual(好.map((x) => x.id), ['kmw7vb3qr', 'kmw7vbqwk', 'kmw7vbz6q'], '链顺序不对')
})

test('R5 探测脚本里不再有清空路由的赋值（源码层锁死）', () => {
  const 源 = readFileSync(工具 + '/探测上游.mjs', 'utf8')
  // 剥掉注释再匹配：自己的说明注释里会引用那句旧代码
  const 净 = 源.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.ok(!/j\.路由\s*=\s*\[\s*\]/.test(净), '探测脚本又把路由清空了 —— 668 的 bug 会复发')
  assert.ok(/置顶官方/.test(净), '探测脚本没接 置顶官方()，切换时还是会丢链')
})
