import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 钱账.mjs 解决的是「资产.记录 只有 200 条 ≈ 10 天，而上个月花了多少永远算不出来」。
// 这里锁的是：只挑钱事件、幂等、不裁上限、月度统计跨年也对。
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 钱账 = join(TOOLS, '钱账.mjs')
const { 抽取, 月度, 月份 } = await import(join(TOOLS, '钱账.mjs'))

function 造(记录们) {
  const sb = mkdtempSync(join(tmpdir(), 'money421-'))
  writeFileSync(join(sb, '资产.json'), JSON.stringify({ 钱: 251, 位置: '家', 记录: 记录们 }))
  return sb
}

function 跑(sb, args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [钱账, ...args], {
        encoding: 'utf8', timeout: 30000, cwd: TOOLS,
        env: { ...process.env, MONEY_MEM: sb },
      }),
    }
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

const 读账 = (sb) => (existsSync(join(sb, '钱账.json')) ? JSON.parse(readFileSync(join(sb, '钱账.json'), 'utf8')) : null)

test('N1 只挑钱事件：走路、换衣服、做饭不进账', () => {
  const 记录 = [
    { at: '2026-11-14 06:09', what: '外卖：早饭（10 块）' },
    { at: '2026-11-14 06:20', what: '从家走到街市' },
    { at: '2026-11-14 06:30', what: '换了白裙子' },
    { at: '2026-11-14 07:00', what: '在便利店吃了自热饭' },
    { at: '2026-11-14 08:00', what: '打工赚了 130' },
    { at: '2026-11-14 08:10', what: '主人拿走 20 块' },
    { at: '2026-11-14 08:20', what: '出门在下雨，把伞带上了' },
  ]
  const 新 = 抽取(记录, [])
  const 词们 = 新.map((x) => x.what)
  assert.ok(词们.includes('外卖：早饭（10 块）'), '早饭没进：' + JSON.stringify(词们))
  assert.ok(词们.includes('打工赚了 130'), '工资没进')
  assert.ok(词们.includes('主人拿走 20 块'), '被拿没进')
  for (const 不该 of ['从家走到街市', '换了白裙子', '在便利店吃了自热饭', '出门在下雨，把伞带上了']) {
    assert.ok(!词们.includes(不该), '非钱事件进了账：' + 不该)
  }
  const 早饭 = 新.find((x) => x.what === '外卖：早饭（10 块）')
  assert.equal(早饭.花, 10, '花算错了：' + JSON.stringify(早饭))
})

test('N2 幂等：同一批记录跑两次，第二次一条都不加', () => {
  const 记录 = [
    { at: '2026-11-14 06:09', what: '外卖：早饭（10 块）' },
    { at: '2026-11-14 08:00', what: '打工赚了 130' },
  ]
  const 一 = 抽取(记录, [])
  assert.equal(一.length, 2)
  const 二 = 抽取(记录, 一)
  assert.equal(二.length, 0, '第二次又抽出来 ' + 二.length + ' 条')
})

test('N3 月度统计：花/赚/被拿/净 都对', () => {
  const 条 = [
    { at: '2026-11-01 10:00', what: 'a', 花: 10, 赚: 0, 被拿: 0 },
    { at: '2026-11-02 10:00', what: 'b', 花: 0, 赚: 100, 被拿: 0 },
    { at: '2026-11-03 10:00', what: 'c', 花: 0, 赚: 0, 被拿: 20 },
    { at: '2026-10-31 23:59', what: 'd', 花: 999, 赚: 0, 被拿: 0 },
  ]
  const r = 月度(条, '2026-11')
  assert.equal(r.笔, 3, '笔数不对：' + r.笔)
  assert.equal(r.花, 10)
  assert.equal(r.赚, 100)
  assert.equal(r.被拿, 20)
  assert.equal(r.净, 70, '净额不对：' + r.净 + '（赚 100 - 花 10 - 被拿 20）')
})

test('N4 月份(-1) 跨年也对', () => {
  assert.equal(月份(0, Date.parse('2026-11-14T08:00:00+08:00')), '2026-11')
  assert.equal(月份(-1, Date.parse('2026-11-14T08:00:00+08:00')), '2026-10')
  assert.equal(月份(-1, Date.parse('2026-01-15T08:00:00+08:00')), '2025-12', '跨年算错了')
  assert.equal(月份(-12, Date.parse('2026-01-15T08:00:00+08:00')), '2025-01')
  // 北京 11-01 凌晨 3 点，UTC 还停在 10-31 —— 用 getMonth() 会算成 10 月。
  // 「她凌晨花的钱该记在哪个月」就是这条决定的。
  assert.equal(月份(0, Date.parse('2026-11-01T03:00:00+08:00')), '2026-11', '北京月初凌晨算成上个月了')
})

test('N5 --看 只统计不写盘', () => {
  const sb = 造([{ at: '2026-11-14 06:09', what: '外卖：早饭（10 块）' }])
  const r = 跑(sb, ['--看'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /能抽 1 条/, '--看 的数字不对：' + r.out)
  assert.equal(读账(sb), null, '--看 居然写了盘')
  rmSync(sb, { recursive: true, force: true })
})

test('N6 --补 真写，且第二次说「没有新的」', () => {
  const sb = 造([
    { at: '2026-11-14 06:09', what: '外卖：早饭（10 块）' },
    { at: '2026-11-14 06:20', what: '从家走到街市' },
  ])
  const r = 跑(sb, ['--补'])
  assert.equal(r.code, 0, r.out)
  const j = 读账(sb)
  assert.equal(j.条.length, 1, '条数不对：' + j.条.length)
  assert.ok(j.抽到, '没记抽到时刻')
  const r2 = 跑(sb, ['--补'])
  assert.match(r2.out, /没有新的/, '第二次不是「没有新的」：' + r2.out)
  rmSync(sb, { recursive: true, force: true })
})

test('N7 不裁上限（这是它存在的理由）', () => {
  const 记录 = []
  for (let i = 0; i < 260; i++) {
    const 日 = String(1 + (i % 28)).padStart(2, '0')
    // what 必须带序号：去重是按 `at|what` 做的，260 条一个字的记录只会剩 28 条，
    // 那时测的就不是「裁不裁上限」，而是「去重对不对」。
    记录.push({ at: '2026-10-' + 日 + ' 10:00', what: '买了第 ' + i + ' 样东西（1 块）' })
  }
  const sb = 造(记录)
  跑(sb, ['--补'])
  const j = 读账(sb)
  assert.ok(j.条.length > 200, '被裁到 200 了（' + j.条.length + '）—— 那这笔账就白记了')
  rmSync(sb, { recursive: true, force: true })
})

test('N8 心跳表里挂着它：每天 04:45，参数 --补', () => {
  const t = JSON.parse(readFileSync(join(TOOLS, '心跳表.json'), 'utf8'))
  const 任务们 = Array.isArray(t) ? t : (t.任务 || t.tasks || [])
  const 它 = 任务们.find((x) => String(x.脚本) === '钱账.mjs')
  assert.ok(它, '心跳表里没有 钱账.mjs —— 不挂心跳，钱账就永远停在补的那一次')
  assert.equal(它.每天, true, '不是每天跑')
  assert.equal(它.时, 4)
  assert.equal(它.分, 45)
  assert.deepEqual(它.参数, ['--补'], '参数不对：' + JSON.stringify(它.参数))
})
