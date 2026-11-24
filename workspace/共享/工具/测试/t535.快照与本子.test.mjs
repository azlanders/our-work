// t535 —— 快照.mjs 的沙盒行为 + 「本子同步」到底接没接上（批次534）
//
// 两件事：
//   ① 快照.mjs 里有一段死代码（两个一模一样的 `if (args.includes("--看"))`，
//      第一个写成 `args.includes("--看") || args.length === 0 && false`）。
//      行为没坏，但改一处忘另一处就会「看起来改了、其实走的是死的那段」。
//      本批删掉第一个，并把硬编码 {{BOT_ROOT}} 换成 FISH_SANDBOX_DIR 才测得了。
//   ② 本子同步.mjs 是批次486 写的：她 11-14 自己记下「每天凌晨自动抄一份上去」。
//      脚本写了，但**心跳表 54 条里没有它** —— 等于没抄。本批接上（北京 04:50）。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 盒 = mkdtempSync(join(tmpdir(), 't535-'))
const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const 写 = (名, o) => writeFileSync(join(盒, 名), JSON.stringify(o))
const 快照P = join(盒, '每日快照.json')

mkdirSync(盒, { recursive: true })
写('状态.json', { energy: 32, 困意: 31, mood: { intensity: 0.259 }, layers: { physical: 16.8, emotional: 51.2 } })
写('资产.json', { 钱: 621, 位置: '家', 记录: [
  { at: 今天 + ' 09:00', what: '买了糖（6 块）' },
  { at: '2020-01-01 09:00', what: '买了台灯（40 块）' },
] })
写('活动台账.json', { log: [
  { at: 今天 + ' 05:00', 地点: '便利店' },
  { at: 今天 + ' 05:30', 地点: '便利店' },
  { at: '2020-01-01 05:00', 地点: '图书馆' },
] })
写('计划.json', { days: { [今天]: { goals: ['a', 'b'], done: ['a'] } } })
写('好感度.json', { people: { '{{OWNER_UIN}}': { score: 12 } } })

const 跑 = (参数) => execFileSync(process.execPath, [join(工具, '快照.mjs'), ...参数], {
  encoding: 'utf8', env: { ...process.env, FISH_SANDBOX_DIR: 盒 }, timeout: 20000,
})

test('S1 --tick 在沙盒里写得出来，字段齐', () => {
  const out = 跑(['--tick'])
  assert.match(out, new RegExp(今天), '输出里得有今天的日期')
  const d = JSON.parse(readFileSync(快照P, 'utf8'))
  assert.equal(d.days.length, 1)
  const 条 = d.days[0]
  assert.equal(条.date, 今天)
  assert.equal(条.money, 621)
  assert.equal(条.energy, 32)
  assert.equal(条.困意, 31)
  assert.equal(条.mood, 0.259)
  assert.equal(条.layers.physical, 16.8, 'layers 要原样带过来，不能只剩体力')
  assert.equal(条.花, 6, '只算今天的；2020 那笔不在今天')
  assert.equal(条.赚, 0)
  assert.equal(条.被拿, 0)
  assert.deepEqual(条.去过, { 便利店: 2 }, '只统计今天的活动，而且数次数')
  assert.deepEqual(条.计划, { 定了: 2, 做成: 1 })
  assert.equal(条.好感, 12)
})

test('S2 同一天再跑一次是覆盖，不是追加', () => {
  跑(['--tick'])
  跑(['--tick'])
  const d = JSON.parse(readFileSync(快照P, 'utf8'))
  assert.equal(d.days.length, 1, '一天只能有一条，否则「看最近七天」全被今天挤掉')
})

test('S3 --看 打得出今天那一条', () => {
  const out = 跑(['--看'])
  assert.match(out, new RegExp(今天 + '｜钱 621'), '格式：日期｜钱 N｜…')
  assert.match(out, /体力 32/)
})

test('S4 死代码不许回来', () => {
  const src = readFileSync(join(工具, '快照.mjs'), 'utf8')
  assert.equal(src.includes('args.length === 0 && false'), false,
    '那个被 && false 关掉的 if 又回来了 —— 它跟后面那个 if 是同一段代码')
  const n = (src.match(/args\.includes\("--看"\)/g) || []).length
  assert.equal(n, 1, '`--看` 只该有 1 个分支，实际 ' + n + ' 个')
})

test('S5 路径不许再硬编码（否则沙盒测不了）', () => {
  const src = readFileSync(join(工具, '快照.mjs'), 'utf8')
  assert.equal(src.includes('const DIR = "{{BOT_ROOT}}"'), false, '硬编码 DIR 又回来了')
  assert.match(src, /process\.env\.FISH_SANDBOX_DIR/)
})

test('S6 本子同步已经在心跳表里，北京 04:50，超时够长', () => {
  const 表 = JSON.parse(readFileSync(join(工具, '心跳表.json'), 'utf8'))
  const 条 = (表['任务'] || []).find((t) => (t['名'] || '') === '本子同步')
  assert.ok(条, '心跳表里没有「本子同步」—— 脚本写了没人调，等于没抄')
  assert.equal(条['脚本'], '本子同步.mjs')
  assert.equal(条['每天'], true)
  assert.equal(条['时'], 4, '时是北京时刻（心跳.mjs 的 北京时刻() 已经 +8）')
  assert.equal(条['分'], 50)
  assert.equal(条['睡着跑'], true, '凌晨四点她当然在睡')
  assert.ok(Number(条['超时毫秒'] || 0) >= 60000,
    '默认超时是 25 秒，上传一次网盘会被杀 —— 得单独放宽')
})

test('S7 端到端：04:50 那一刻真的会调它', () => {
  const out = execFileSync(process.execPath, [join(工具, '心跳.mjs'), '--dry', '--at', '2026-11-16 04:50'],
    { encoding: 'utf8', timeout: 20000 })
  assert.match(out, /\[命中\] 本子同步/, '04:50 没命中本子同步')
  // 12:50 不该命中 —— 证明「时」是北京时间，不是 UTC
  const out2 = execFileSync(process.execPath, [join(工具, '心跳.mjs'), '--dry', '--at', '2026-11-16 12:50'],
    { encoding: 'utf8', timeout: 20000 })
  assert.equal(/\[命中\] 本子同步/.test(out2), false, '12:50 也命中了 → 时区判错了')
})

test.after(() => { try { rmSync(盒, { recursive: true, force: true }) } catch {} })
