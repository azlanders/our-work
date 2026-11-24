// 批次662（审计 P1-7）：冬冰触发过宽，普通「合集」也会注入两条无关笔记
//   旧实现：冬冰线含泛词「合集」；冬冰来源自带 源分=4，又用 源中>0 记成 命中=1，
//   于是一条词面完全无关的看片笔记也能通过「有命中」筛选、按分数挤进前两条。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const lib = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 自动回忆段 } = await import(pathToFileURL(join(lib, '自动回忆.mjs')).href)

const 条目 = [
  '- 第 8 条：新室友 DeepSeek 报到，五个 AI 住进中转站，穷、抢吃的、互相嫌弃又互相护着',
  '- 第 33 条：猫神来公寓，Gemini 拖行李箱迷路，最后在豆包饭店找到',
]

const 装沙盒 = (行 = 条目) => {
  const b = mkdtempSync(join(tmpdir(), 't662-'))
  mkdirSync(join(b, '冬冰'), { recursive: true })
  mkdirSync(join(b, '日记'), { recursive: true })
  writeFileSync(join(b, '冬冰', '看完记.md'), '# 冬冰的《大鱼/中转站》合集看完记\n\n' + 行.join('\n') + '\n')
  return b
}
const 跑 = (q, opts = {}) => {
  const b = 装沙盒()
  try { return 自动回忆段(q, { mem: b, diary: join(b, '日记'), ...opts }) } finally { rmSync(b, { recursive: true, force: true }) }
}

test('X1 泛词「合集」单独出现不触发冬冰', () => {
  const s = 跑('这个合集不错')
  assert.ok(!/冬冰 · /.test(s), '只说了合集就翻笔记：' + s)
})

test('X2 「合集」+ 看片语境才放开（且条目要有词面命中）', () => {
  const s = 跑('那个合集里 DeepSeek 是第几条')
  assert.match(s, /冬冰 · /)
})

test('X3 明确提冬冰仍能召回（回归 t649 W1）', () => {
  const s = 跑('冬冰那个合集你还记得吗')
  assert.match(s, /冬冰 · /)
})

test('X4 靠「合集 + 看片语境」触发时，词面全不沾的冬冰条不许入选', () => {
  // 这正是审计里的场景：说了「合集」「看到第几条」，但和笔记内容没有任何词面重合。
  // 旧实现里 源分=4 被算成 命中=1，两条无关笔记照样进前二。
  const s = 跑('这个合集看到第几条了')
  const 条 = s.split('\n').filter((x) => x.startsWith('- '))
  assert.equal(条.length, 0, '零命中的冬冰条被塞进来了：' + s)
})

test('X4b 显式点名「冬冰」算话题命中，即使正文没有这两个字', () => {
  // 笔记正文里并没有「冬冰」（只有标题有），但主人点名了这个合集，
  // 给 1~2 条她的看片笔记是 649 的本意。
  const s = 跑('冬冰那事儿咋样了')
  assert.match(s, /冬冰 · /, '点名冬冰却没召回：' + s)
})

test('X5 有词面重合的冬冰条仍能入选', () => {
  const s = 跑('冬冰里 DeepSeek 报到是第几条')
  assert.match(s, /DeepSeek|中转站/)
})

test('X6 「讲到哪了」时进度条仍算命中（回归 t649 W8）', () => {
  const b = 装沙盒()
  try {
    writeFileSync(join(b, '冬冰', '进度.md'), '# 进度\n\n- 已看清 45~46：45 比企鹅还圆 / 46 薄荷味\n- 待看：47 起\n')
    const s = 自动回忆段('冬冰那个合集你看到哪了', { mem: b, diary: join(b, '日记'), maxItems: 2 })
    assert.match(s, /冬冰进度/)
    assert.match(s, /待看：47 起/)
  } finally { rmSync(b, { recursive: true, force: true }) }
})
