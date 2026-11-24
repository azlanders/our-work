import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

// 批次 687：打工的体力原来被扣两遍 —— 活动.mjs -5/30min，状态推进再按倍率 1.8 × -2.4/小时。
// 40 分钟内有打工/值班的活动账时，状态推进只留睡眠压力/夜里那点。

const 工具 = process.env.QQ_TEST_TOOLS || join(dirname(fileURLToPath(import.meta.url)), '..')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造(带活动账) {
  const b = mkdtempSync(join(tmpdir(), 't687-'))
  const now = Date.now()
  writeFileSync(join(b, '状态.json'), JSON.stringify({
    energy: 27, 困意: 33, hoursAwake: 19, 更新时间: bj(now - 40 * 60e3),
    layers: { physical: 70, cognitive: 83, emotional: 51, existential: 52 },
    mood: { intensity: 0.26, label: '有点困' }, body: { 困: 33 }, birth: { at: '2026-10-01 00:00' },
  }))
  writeFileSync(join(b, '自主.json'), JSON.stringify({
    state: '打工', since: now - 3600e3, doneAt: 0, nextAt: now + 7200e3, log: [], place: '咖啡店',
  }))
  writeFileSync(join(b, '工作.json'), JSON.stringify({ 班次: [{
    状态: '在岗', 点: '咖啡店', 活: '咖啡店帮工',
    起: bj(now - 3600e3), 止: bj(now + 7200e3), 打卡At: bj(now - 3600e3),
  }] }))
  writeFileSync(join(b, '活动台账.json'), JSON.stringify(带活动账
    ? { log: [{ at: bj(now - 5 * 60e3), 地点: '咖啡店', kind: '打工', 活动: '干活', 名: '干活', 生效: true }] }
    : { log: [] }))
  return b
}

const 跑 = (b) => execFileSync(process.execPath, [join(工具, '状态推进.mjs')], {
  encoding: 'utf8', timeout: 30000,
  // HUNGER_MEM：状态推进 里问 饱渴.倍率()，默认读生产记忆；不指过去就退回 1，L2 测不到倍率。
  env: { ...process.env, ST_BASE: b, QQ_SLEEPY_MEM: b, HUNGER_MEM: b },
})
const 体力 = (b) => JSON.parse(readFileSync(join(b, '状态.json'), 'utf8')).layers.physical

test('L1 有活动账：40 分钟只掉睡眠压力那点（< 3）', () => {
  const b = 造(true)
  try {
    const 前 = 体力(b)
    跑(b)
    const 掉 = 前 - 体力(b)
    assert.ok(掉 < 2.6, `有活动账还掉了 ${掉.toFixed(2)}，说明状态推进又按倍率扣了一遍`)
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('L2 没有活动账：照旧按倍率扣（> 3），别把干活改成歇着', () => {
  const b = 造(false)
  try {
    const 前 = 体力(b)
    跑(b)
    const 掉 = 前 - 体力(b)
    assert.ok(掉 > 3.0, `没有活动账只掉 ${掉.toFixed(2)}，倍率账丢了`)
  } finally { rmSync(b, { recursive: true, force: true }) }
})
