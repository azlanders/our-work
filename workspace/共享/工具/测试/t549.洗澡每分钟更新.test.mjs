// t549 —— 洗澡时清洁度要每分钟往上走（批次549）
//
// 主人 08:22 的要求：「洗澡机制改成洗的时候每分钟更新一次清洁度」。
//
// 原来：`--开始` 记下「到 92」，`--tick` 只在**到点**那一秒一次性 `卫生.清洁 = 到`。
// 中间十几二十分钟面板上一直是进浴室前的 15.2，看不出她在洗；
// 更糟的是这段时间 `补衰减` 还在按「在家闲着 1.1/h」继续往下扣。
//
// 现在：按时间线性插值（洗前 → 到），算的是真实经过时间，心跳晚了也不会错。
// 顺带：清洁度精度 0.1 → 0.01（心跳改成 1 分钟后每次只掉 0.018，0.1 精度会被抹成 0）。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造({ 起 = 0, 止 = 20, 清洁 = 15.2, 到 = 92, 洗澡中 = true }) {
  const b = mkdtempSync(join(tmpdir(), 't549-'))
  const now = Date.now()
  const 卫 = { 清洁, 上次洗: '2026-11-14 00:37', 次数: 7, 上次更新: bj(now) }
  if (洗澡中) 卫.洗澡中 = {
    开始: bj(now + 起 * 60e3), 开始毫秒: now + 起 * 60e3,
    结束: bj(now + 止 * 60e3), 结束毫秒: now + 止 * 60e3,
    到, 洗前: 清洁, 为什么: '测试', 在哪: '家',
  }
  writeFileSync(join(b, '卫生.json'), JSON.stringify(卫))
  writeFileSync(join(b, '状态.json'), JSON.stringify({
    layers: { physical: 22.2, emotional: 51, cognitive: 75, existential: 52 }, energy: 36,
  }))
  writeFileSync(join(b, '自主.json'), JSON.stringify({ state: '洗澡', since: 0, doneAt: 0, nextAt: 0, log: [] }))
  writeFileSync(join(b, '资产.json'), JSON.stringify({ 钱: 621, 位置: '家', 记录: [] }))
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj(now - 7200e3) }))
  return b
}
const 跑 = (b, ...args) => {
  try {
    return execFileSync(process.execPath, [join(工具, '洗澡.mjs'), ...args], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_AUTONOMY_MEM: b },
    })
  } catch (e) { return String(e.stdout || '') + String(e.stderr || '') }
}
const 读卫 = (b) => JSON.parse(readFileSync(join(b, '卫生.json'), 'utf8'))
// 造数据到跑脚本之间会过几秒，按「分钟」算的期望值要留一点余量
const 近 = (a, b, tol = 1.6) => Math.abs(Number(a) - Number(b)) <= tol

test('S1 洗到一半（-10 → +10 分钟）→ 清洁度在中间，不是还停在洗前、也不是已经到 92', () => {
  const b = 造({ 起: -10, 止: 10 })
  const out = 跑(b, '--tick')
  const 清 = 读卫(b).清洁
  assert.ok(近(清, 53.6), `期望 ≈53.6（15.2 + 76.8×50%），实际 ${清}｜${out.slice(0, 60)}`)
  assert.ok(清 > 15.2 && 清 < 92, '必须落在洗前和到之间')
  rmSync(b, { recursive: true, force: true })
})

test('S2 刚开始洗 → 几乎不动；洗了 3 分钟 → 涨一小截', () => {
  const b1 = 造({ 起: 0, 止: 20 })
  const 清1 = (跑(b1, '--tick'), 读卫(b1).清洁)
  assert.ok(近(清1, 15.2, 2), `刚开始洗就跳到 ${清1}`)
  rmSync(b1, { recursive: true, force: true })

  const b2 = 造({ 起: -3, 止: 17 })
  const 清2 = (跑(b2, '--tick'), 读卫(b2).清洁)
  assert.ok(近(清2, 26.7), `洗 3 分钟（15%）期望 ≈26.7，实际 ${清2}`)
  assert.ok(清2 > 清1, '洗得越久越干净')
  rmSync(b2, { recursive: true, force: true })
})

test('S3 洗澡期间不许再往下掉（人在水里）', () => {
  // 上次更新故意设成 2 小时前：如果走了「按小时衰减」那条，会掉 2.2 点
  const b = 造({ 起: 0, 止: 20 })
  const 卫 = 读卫(b)
  卫.上次更新 = bj(Date.now() - 7200e3)
  writeFileSync(join(b, '卫生.json'), JSON.stringify(卫))
  跑(b, '--tick')
  const 清 = 读卫(b).清洁
  assert.ok(清 >= 15.2, `洗澡时还在掉：${清} < 15.2`)
  rmSync(b, { recursive: true, force: true })
})

test('S4 到点了 → 正好到，洗澡中 清掉，记一笔', () => {
  const b = 造({ 起: -21, 止: -1 })
  const out = 跑(b, '--tick')
  const d = 读卫(b)
  assert.equal(d.清洁, 92)
  assert.equal(d.洗澡中, undefined, '洗澡中没清掉，会一直算在洗')
  assert.match(out, /洗完了/)
  assert.equal(d.次数, 8)
  assert.ok(d.头发湿到, '没记头发湿到')
  rmSync(b, { recursive: true, force: true })
})

test('S5 精度 0.01：洗到一半的值不许被四舍五入成一位小数', () => {
  const b = 造({ 起: -7, 止: 13, 清洁: 60, 到: 95 })
  跑(b, '--tick')
  const 清 = 读卫(b).清洁
  assert.ok(近(清, 72.25, 2), `期望 ≈72.25，实际 ${清}`)
  const 小数位 = String(清).split('.')[1] || ''
  assert.ok(小数位.length <= 2, '小数位超过 2 位：' + 清)
  rmSync(b, { recursive: true, force: true })
})

test('S6 --开始 要记「洗前」，否则插值没有起点', () => {
  const b = 造({ 洗澡中: false, 清洁: 15.2 })
  跑(b, '--开始')
  const 洗 = 读卫(b).洗澡中
  assert.ok(洗, '--开始 没写 洗澡中')
  // `--开始` 会先跑一次 补衰减（造数据到跑脚本之间过了几十毫秒 → 15.2 掉成 15.19），
  // 所以这儿要留容差，不能拿字面 15.2 去比。
  assert.ok(Math.abs(Number(洗.洗前) - 15.2) < 0.2, '洗前 没记或记错了：' + JSON.stringify(洗))
  assert.ok(Number(洗.到) >= 40, '到 不合理：' + 洗.到)
  rmSync(b, { recursive: true, force: true })
})

test('S7 没在洗澡时 tick 不许出声（心跳 1 分钟，一天 1440 行会刷满日志）', () => {
  const b = 造({ 洗澡中: false, 清洁: 50 })
  const out = 跑(b, '--tick').trim()
  assert.equal(out, '', '不洗澡也在输出：' + JSON.stringify(out))
  rmSync(b, { recursive: true, force: true })
})

test('S8 心跳表：洗澡必须 1 分钟一次', () => {
  const 表 = JSON.parse(readFileSync(join(工具, '心跳表.json'), 'utf8'))
  const 条 = (表['任务'] || []).find((t) => (t['名'] || '') === '洗澡')
  assert.ok(条, '心跳表里没有洗澡')
  assert.equal(条['间隔分'], 1, '还是 ' + 条['间隔分'] + ' 分钟 —— 清洁度不会每分钟更新')
  assert.deepEqual(条['参数'], ['--tick'])
})

test('S8b 老记录只有分钟字段（没有毫秒）也要能算，不许崩', () => {
  // 线上可能留着批次549 之前开的洗澡记录：只有 开始/结束 两个分钟串。
  const b = 造({ 洗澡中: false, 清洁: 15.2 })
  const 卫 = 读卫(b)
  const now = Date.now()
  卫.洗澡中 = { 开始: bj(now - 10 * 60e3), 结束: bj(now + 10 * 60e3), 到: 92, 为什么: '老记录', 在哪: '家' }
  writeFileSync(join(b, '卫生.json'), JSON.stringify(卫))
  const out = 跑(b, '--tick')
  const 清 = 读卫(b).清洁
  // 走 parseBj 回落；分钟截断最多偏 1 分钟 → 容差按 4 算
  assert.ok(Math.abs(Number(清) - 53.6) <= 4, `老记录算出来 ${清}（期望 ≈53.6±4）｜${out.slice(0, 60)}`)
  assert.equal(读卫(b).洗澡中 !== undefined, true, '老记录被清掉了')
  rmSync(b, { recursive: true, force: true })
})

test('S9 --看看 要报进度（在洗的时候）', () => {
  const b = 造({ 起: -10, 止: 10 })
  const out = 跑(b, '--看看')
  assert.match(out, /正在家洗澡/)
  assert.match(out, /个百分点|%/, '没报百分比：' + out)
  rmSync(b, { recursive: true, force: true })
})
