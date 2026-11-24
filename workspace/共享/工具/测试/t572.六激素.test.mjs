// t572 —— 六个激素（新增肾上腺素）+ 事件表全审（批次572）
//
// 主人 2026-11-16 拍的三条：
//   ① 下游三层全接（身体反应 / 行为倾向 / 说话方式）
//   ② 上游 22 条事件全审重写
//   ③ **全部归基线重开**
//
// 为什么必须先修上游（不是参数问题，是 bug）：
//   今天「晒太阳」发了 **84 次**，全部来自 `activity:...便利店:买:晒太阳`。
//   `活动.mjs` 把 逛街 / 散心 / 逛店 统统映射成 `晒太阳`，而它是 `cortisol: -6`。
//   84 × -6 把皮质醇打到 **2.2**（平常 24.7）—— 她在便利店站着也叫晒太阳，半夜也叫。
//
// 为什么肾上腺素要单列（文献依据）：
//   · 血中半衰期 2~3 分钟，功能效应 20~60 分钟 —— 跟皮质醇（3 小时）差一个量级，
//     所以它**不能有「设定点漂移」**（那是「受体适应」，是体质层面的事）。今天看三部恐怖片，
//     设定点不该被永久抬高。
//   · 恐怖片是 肾上腺素 + 皮质醇 + 多巴胺 **三者齐上**（安全的恐惧，事后多巴胺补偿才「爽」）。
//   · 急性效应：心跳快、呼吸急、肌肉紧、食欲降、睡不着、易烦躁/冲动。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))
const 今天 = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

process.env.QUIET_NOTE = '1'

const 五层 = () => ({ dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 })

function 造盒(v, B, lastTick) {
  const d = mkdtempSync(join(tmpdir(), 't572-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  writeFileSync(join(d, '激素.json'), JSON.stringify({
    v: v || 五层(),
    B: B || 五层(),
    lastTick: lastTick === undefined ? Date.now() : lastTick,
    repeats: {}, 测试标记: 't572',
    daily: { date: 今天(), used: {} },
  }, null, 2))
  return d
}

const 跑 = (d, args) => spawnSync(process.execPath, [工具 + '/激素.mjs', ...args], {
  encoding: 'utf8', timeout: 30e3,
  env: { ...process.env, HJ_BASE: d, QUIET_NOTE: '1' },
})

// ══════════ A 肾上腺素本身 ══════════
test('A1 空档跑 tick，五个激素都建出来（肾上腺素从 18 起）', () => {
  const d = mkdtempSync(join(tmpdir(), 't572-'))
  try {
    const r = 跑(d, ['--tick'])
    assert.equal(r.status, 0, 'tick 失败：' + r.stderr)
    const j = 读(join(d, '激素.json'))
    assert.equal(j.v.adrenaline, 18, '肾上腺素初值 ' + j.v.adrenaline)
    assert.equal(j.B.adrenaline, 18, '肾上腺素设定点 ' + j.B.adrenaline)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A2 肾上腺素**不漂设定点**（它是急性状态，不是体质）', () => {
  // 造一个越界的设定点 30，跑 tick —— 其余四个会走 EMA，它必须被拉回 b0
  const d = 造盒(五层(), { ...五层(), adrenaline: 30 })
  try {
    跑(d, ['--tick'])
    const j = 读(join(d, '激素.json'))
    assert.equal(j.B.adrenaline, 18, '肾上腺素的设定点漂到 ' + j.B.adrenaline + ' —— 急性激素不该有受体适应')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A3 恐怖片：肾上腺素 + 皮质醇 + 多巴胺 三者齐上（"安全的恐惧"）', () => {
  const d = 造盒()
  try {
    const r = 跑(d, ['--event', '看恐怖片'])
    assert.equal(r.status, 0, r.stderr)
    const j = 读(join(d, '激素.json')).v
    assert.ok(j.adrenaline > 30, '肾上腺素只到 ' + j.adrenaline + '，吓不到人')
    assert.ok(j.cortisol > 25, '皮质醇没升：' + j.cortisol)
    assert.ok(j.dopamine > 45, '多巴胺没升（事后那股"爽"）：' + j.dopamine)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A4 肾上腺素是急性的：1 小时后基本回落（半衰期 < 1 小时）', () => {
  const v = { ...五层(), adrenaline: 60 }
  const d = 造盒(v, 五层(), Date.now() - 60 * 60e3)
  try {
    跑(d, ['--tick'])
    const a = 读(join(d, '激素.json')).v.adrenaline
    assert.ok(a < 26, '1 小时后还有 ' + a + ' —— 半衰期太长，不是急性激素了')
    assert.ok(a >= 18, '掉到基线以下了：' + a)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════ B 上游：活动 ↔ 事件 不能再一个标签通吃 ══════════
test('B1 逛店不再当成「晒太阳」（84 次 -6 就是这么来的）', () => {
  const 源 = readFileSync(join(工具, '活动.mjs'), 'utf8')
  const 行 = 源.split('\n').find((l) => /^\s*买:\s*\{/.test(l))
  assert.ok(行, '找不到 买 那一行 —— 活动表改了写法，这条要跟着改')
  assert.ok(!/晒太阳/.test(行), '「逛店」还是映射成 晒太阳：' + 行)
})

test('B2 逛街 / 散心 / 逛店 各自成事件，不再共用晒太阳', () => {
  const 源 = readFileSync(join(工具, '活动.mjs'), 'utf8')
  const 取行 = (k) => 源.split('\n').find((l) => new RegExp('^\\s*' + k + ':\\s*\\{').test(l)) || ''
  for (const k of ['逛街', '散心', '买']) {
    const 行 = 取行(k)
    assert.ok(行, '活动表里没有 ' + k)
    assert.ok(!/晒太阳/.test(行), k + ' 还挂在 晒太阳 上：' + 行)
  }
  // 散心在海边仍然是「看海」（这个是对的，别一起删了）
  assert.match(取行('散心'), /看海/, '海边散心不再是看海了')
})

test('B3 「晒太阳」这件事本身还在（真在户外晒太阳，不是删掉）', () => {
  const d = 造盒()
  try {
    const r = 跑(d, ['--event', '晒太阳'])
    assert.equal(r.status, 0, '晒太阳 事件没了：' + r.stderr)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B4 新事件都认得（看恐怖片 / 被吓到 / 差点出事 / 逛街 / 逛店 / 散心）', () => {
  const d = 造盒()
  try {
    for (const k of ['看恐怖片', '被吓到', '差点出事', '逛街', '逛店', '散心']) {
      const r = 跑(d, ['--event', k])
      assert.equal(r.status, 0, k + ' 不认识：' + r.stderr)
      assert.ok(!/未知事件/.test(r.stdout), k + ' 未知：' + r.stdout)
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B5 负面的权重不低于正面（正负都要考虑到，不是只加好听的）', () => {
  const 源 = readFileSync(join(工具, '激素.mjs'), 'utf8')
  const 表 = 源.slice(源.indexOf('const EVENTS_TABLE'), 源.indexOf('const PAIN_KINDS'))
  const 正 = (表.match(/dopamine:\s*\d+|oxytocin:\s*\d+/g) || []).length
  const 负 = (表.match(/cortisol:\s*[1-9]\d*|oxytocin:\s*-\d+/g) || []).length
  assert.ok(负 >= 10, '负面事件只有 ' + 负 + ' 条 —— 一张只有好事的表不叫真实')
  assert.ok(正 >= 10, '正面事件只有 ' + 正 + ' 条')
})

// ══════════ C 归基线重开 ══════════
test('C1 --reset-all：五个值 + 五个设定点全部归基线', () => {
  const 乱 = { dopamine: 71, cortisol: 2.2, oxytocin: 88, gaba: 12, adrenaline: 90 }
  const d = 造盒(乱, 乱)
  try {
    const r = 跑(d, ['--reset-all'])
    assert.equal(r.status, 0, r.stderr)
    const j = 读(join(d, '激素.json'))
    assert.deepEqual(
      { d: j.v.dopamine, c: j.v.cortisol, o: j.v.oxytocin, g: j.v.gaba, a: j.v.adrenaline },
      { d: 45, c: 25, o: 40, g: 50, a: 18 },
      '当前值没归位：' + JSON.stringify(j.v))
    assert.deepEqual(
      { d: j.B.dopamine, c: j.B.cortisol, o: j.B.oxytocin, g: j.B.gaba, a: j.B.adrenaline },
      { d: 45, c: 25, o: 40, g: 50, a: 18 },
      '设定点没归位：' + JSON.stringify(j.B))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('C2 --reset-all 也清掉重复计数和预算账本（不然"重开"还是旧账）', () => {
  const d = 造盒()
  try {
    const p = join(d, '激素.json')
    const j = 读(p)
    j.repeats = { 'dopamine:被夸': { n: 5, at: Date.now() } }
    j.used = { dopamine: [{ at: Date.now(), d: 18 }] }
    j.daily = { date: 今天(), used: { dopamine: 18 } }
    writeFileSync(p, JSON.stringify(j, null, 2))
    跑(d, ['--reset-all'])
    const 后 = 读(p)
    assert.deepEqual(后.repeats, {}, '重复计数没清：' + JSON.stringify(后.repeats))
    assert.deepEqual(后.used, {}, '预算账本没清：' + JSON.stringify(后.used))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════ D 面板 ══════════
test('D1 面板认得五个激素（含肾上腺素）', () => {
  const 源 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  assert.match(源, /adrenaline/, '面板里没有肾上腺素')
  assert.match(源, /肾上腺素/, '面板没有肾上腺素的中文名')
  // 设置项也要有，不然只能看不能改
  assert.match(源, /hor\.adrenaline/, '面板缺 hor.adrenaline 设置项')
})

test('D2 面板「最近事件」不再显示裸时间戳', () => {
  const 源 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  // 按「块」查，不按行：格式化以后 j.at 和 j.kind 分开在几行里了
  const i = 源.indexOf('const 近事件')
  assert.ok(i > 0, '找不到 近事件 那段')
  const 块 = 源.slice(i, i + 900)
  assert.ok(!/\+\s*\(j\.at \|\| ''\)\s*\+/.test(块), '还是直接拼裸时间戳')
  assert.ok(/好看\(/.test(块), '没有把时间格式化（好看()）：' + 块.slice(0, 200))
})

test('D3 面板文案不再说「四个值」', () => {
  const 源 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  const 行 = 源.split('\n').find((l) => l.includes("g('hormone'"))
  assert.ok(行, '找不到激素那一段')
  assert.ok(!/四个值/.test(行), '文案还是「四个值」：' + 行)
})

// ══════════ E 真档防线 ══════════
// HERE 2026-11-17（批次619）：心跳会合法写生产 激素.json，整档前后比对会周期性假红。
// 改成：证明这一轮确实写进了沙盒、沙盒标记没漏进真档；不再要求真档内容冻结。
test('E1 跑了六轮沙盒，激素写的是沙盒档', () => {
  const p = join(真档, '激素.json')
  const 真前 = readFileSync(p, 'utf8')
  assert.ok(!真前.includes('测试标记'), '真档本来就有测试标记')
  const d = 造盒()
  try {
    const 盒p = join(d, '激素.json')
    const 盒前 = readFileSync(盒p, 'utf8')
    跑(d, ['--tick'])
    跑(d, ['--event', '看恐怖片'])
    跑(d, ['--reset-all'])
    const 盒后 = readFileSync(盒p, 'utf8')
    assert.notEqual(盒后, 盒前, '沙盒档没被写，命令可能指错了目录')
    assert.ok(盒后.includes('测试标记'), '沙盒标记丢了，写出路径可能不是沙盒档')
    assert.ok(!readFileSync(p, 'utf8').includes('测试标记'), '沙盒标记漏进了真档')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
