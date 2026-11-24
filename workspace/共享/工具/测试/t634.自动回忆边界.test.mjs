// t634 —— 自动回忆的日期/来源边界：大前天、只认事实、作废/路径不入私聊。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 自动回忆段 } = await import(pathToFileURL(join(LIB, '自动回忆.mjs')).href + '?t634=1')

const 今 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const 减 = (n) => new Date(Date.parse(今 + 'T00:00:00Z') - n * 86400e3).toISOString().slice(0, 10)
const 昨 = 减(1)
const 前 = 减(2)
const 大前 = 减(3)

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 't634-'))
  const mem = join(sb, 'mem')
  const diary = join(sb, 'diary')
  mkdirSync(mem, { recursive: true })
  mkdirSync(diary, { recursive: true })
  return { sb, mem, diary }
}

test('A1 大前天是三天前，不会被“前天”截成两天前', () => {
  const { sb, mem, diary } = 造()
  try {
    writeFileSync(join(mem, `手账-${昨}.md`), '- 09:00 · 昨天的事\n')
    writeFileSync(join(mem, `手账-${前}.md`), '- 09:00 · 前天的事\n')
    writeFileSync(join(mem, `手账-${大前}.md`), '- 09:00 · 大前天的事\n')
    const out = 自动回忆段('大前天干了什么', { mem, diary })
    assert.match(out, /大前天的事/)
    assert.match(out, new RegExp(`手账 · ${大前}`))
    assert.doesNotMatch(out, new RegExp(`手账 · ${前}|手账 · ${昨}`))
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('A2 链只认“事实”：判断、作废、路径/编号都不进私聊回忆', () => {
  const { sb, mem, diary } = 造()
  try {
    writeFileSync(join(mem, '链.md'), [
      `## ${昨} 10:00`,
      '- 事实：事实甲',
      '- 未决：（没有）',
      '',
      `## ${昨} 10:05`,
      '- 事实：事实甲',
      '- 未决：（没有）',
      '',
      `## ${昨} 10:10`,
      '- 判断：这是判断不该出现',
      '- 未决：（没有）',
      '',
      `## ${昨} 10:15`,
      '- 事实：作废的事实不该出现',
      '- 未决：（没有）',
      '',
      `## ${昨} 10:20`,
      '- 事实：路径 {{BOT_ROOT}}/秘密 不该出现',
      '- 未决：（没有）',
      '',
    ].join('\n'))
    writeFileSync(join(mem, '链-作废.json'), JSON.stringify({
      条目: [{ at: `${昨} 10:15` }],
    }))
    const out = 自动回忆段('上次事实甲那件事', { mem, diary })
    assert.match(out, /事实甲/)
    assert.equal((out.match(/事实甲/g) || []).length, 1, '重复事实只出现一次')
    assert.doesNotMatch(out, /判断不该出现|作废的事实|秘密/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('A3 问“昨天的梦”时优先梦来源，不被同日日记挤掉', () => {
  const { sb, mem, diary } = 造()
  try {
    writeFileSync(join(diary, `${昨}.md`), '今天去图书馆坐了很久，翻了几页书。\n')
    writeFileSync(join(mem, `梦-${昨}.md`), '余味: 安静\n场景：海边\n')
    const out = 自动回忆段('昨天的梦是什么', { mem, diary })
    assert.match(out, /海边/)
    assert.doesNotMatch(out, /图书馆/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})
