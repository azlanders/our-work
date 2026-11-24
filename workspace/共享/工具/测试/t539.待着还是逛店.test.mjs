// t539 —— 她是在逛店，还是喝完水站在这儿（批次538）
//
// 事故：2026-11-16 03:30–07:00，她在便利店连续 8 次被记成「逛店」，每次体力 -2，共 -16，
// physical 从 28 掉到 12。可那两个多小时她只是**喝完水在店里站着**：
// `自主.json` 里 state='喝点水'（只是「最近做过什么」的标签）、doneAt=06:27 早过了、nextAt=08:39 还有两小时。
// 根因：`活动.mjs` 只按地点类别算（人在便利店 → kind='买' → 逛店 -2/半小时），完全不看 doneAt。
//
// 改法：一次性动作 + doneAt 已过 5 分钟 → 记「待着」，体力不动。
// 清单只留一份，在 在干嘛.mjs 的 `一次性动作`（原来是 自主行动.mjs 的 ONE_SHOT，活动读不到）。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const { 一次性动作 } = await import('{{BOT_ROOT}}/共享/工具/在干嘛.mjs')

test('C1 一次性动作清单只留一份，而且它真的是一次性的那些', () => {
  for (const x of ['喝点水', '吃点东西', '拍张照', '翻旧账', '看B站']) {
    assert.equal(一次性动作.has(x), true, x + ' 该在清单里')
  }
  // 这几个是「正在做」的，doneAt=0，不能算一次性 —— 算了就会把真逛街当待着
  for (const x of ['逛街', '发呆', '摸鱼', '待命', '洗澡']) {
    assert.equal(一次性动作.has(x), false, x + ' 不该在一次性清单里')
  }
  assert.equal(一次性动作.size, 16, '清单长度变了就要想一想：新加的是不是真「几十秒做完」')
})

test('C2 自主行动.mjs 不许再写第二份清单', () => {
  const src = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.equal(/new Set\(\['逛贴吧'/.test(src), false, '又手写了一份 ONE_SHOT —— 两份一定分叉')
  assert.match(src, /const ONE_SHOT = 一次性动作/)
  assert.match(src, /import \{[^}]*一次性动作[^}]*\} from '\.\/在干嘛\.mjs'/, '没从 在干嘛.mjs import 一次性动作')
})

test('C3 活动.mjs 必须问 在干嘛 要清单', () => {
  const src = readFileSync(join(工具, '活动.mjs'), 'utf8')
  assert.match(src, /import \{[^}]*一次性动作[^}]*\} from '\.\/在干嘛\.mjs'/, '没从 在干嘛.mjs import 一次性动作')
  assert.match(src, /__待着/, '待着判据被删了')
  assert.match(src, /待着:   \{ p: 1,/, '待着 这一档被删了')
})

// ── env 同源（批次574）──
test('C5 活动.mjs 调 激素.mjs 必须把 HJ_BASE 指到同一个目录（漏了会污染真档）', () => {
  // 实测事故：这条漏了以后，沙盒跑 6 次把「逛店」写进真档激素事件，dopamine 45 → 60.8。
  const src = readFileSync(join(工具, '活动.mjs'), 'utf8')
  const 行 = src.split('\n').find((l) => l.includes('激素.mjs') && l.includes('--event'))
  assert.ok(行, '找不到调 激素.mjs 那行 —— 写法变了，这条要跟着改')
  assert.ok(/HJ_BASE/.test(行), '调 激素.mjs 时没传 HJ_BASE —— 沙盒会写进真档：' + 行.trim())
})

// ── 沙盒：真跑 活动.mjs --tick ──
function 造盒(state, doneAt) {
  const b = mkdtempSync(join(tmpdir(), 't539-'))
  const m = join(b, 'mem')
  mkdirSync(m, { recursive: true })
  const now = Date.now()
  writeFileSync(join(m, '状态.json'), JSON.stringify({
    energy: 27, 困意: 33, mood: { intensity: 0.26 },
    layers: { physical: 12.6, emotional: 51, cognitive: 83, existential: 52 },
  }))
  writeFileSync(join(m, '资产.json'), JSON.stringify({ 钱: 621, 位置: '便利店', 记录: [] }))
  writeFileSync(join(m, '自主.json'), JSON.stringify({
    state, since: now, doneAt: doneAt === 'past' ? now - 40 * 60e3 : doneAt === 'just' ? now - 60e3 : 0,
    nextAt: now + 7200e3, log: [], place: '便利店',
  }))
  writeFileSync(join(m, '活动台账.json'), JSON.stringify({ log: [] }))
  return m
}
const 跑 = (m) => execFileSync(process.execPath, [join(工具, '活动.mjs'), '--tick'], {
  encoding: 'utf8', timeout: 20000, env: { ...process.env, QQ_ACT_MEM: m },
})
const 台账末条 = (m) => {
  const d = JSON.parse(readFileSync(join(m, '活动台账.json'), 'utf8'))
  return (d.log || []).slice(-1)[0] || {}
}
const physical = (m) => JSON.parse(readFileSync(join(m, '状态.json'), 'utf8')).layers.physical

test('C4 喝完水站着 → 记「待着」，体力一点不掉', () => {
  const m = 造盒('喝点水', 'past')
  const 前 = physical(m)
  跑(m)
  const r = 台账末条(m)
  assert.equal(r.kind, '待着')
  assert.equal(r.名, '待着')
  assert.equal(r.体力, 0)
  assert.equal(physical(m), 前, 'physical 不该动')
  rmSync(join(m, '..'), { recursive: true, force: true })
})

test('C5 真的在逛街（doneAt=0）→ 照样按逛店扣', () => {
  const m = 造盒('逛街', 0)
  const 前 = physical(m)
  // FLAKY_FIX 2026-11-17（批次644）：原来跑 6 次就断言「必然生效」，
  // 而逛店 p=0.6 —— 连续 6 次都不中的概率 0.4^6 ≈ 0.4%，全套并发跑时真的偶发红过
  // （单独跑 7/7，全量跑 C5 掉）。改成：跑 20 次（漏判概率 1e-8），
  // 断言「这 20 次里至少有一次按买扣」，而不是钉死最后一条 —— 末条是什么取决于随机序列，
  // 那不是这条要守的东西。
  for (let i = 0; i < 20; i += 1) 跑(m)
  const 台账 = (JSON.parse(readFileSync(join(m, '活动台账.json'), 'utf8')).log || [])
  assert.ok(台账.some((x) => x.kind === '买'), '真逛街 20 次全被当成了待着 —— 这个方向错更糟')
  assert.ok(physical(m) < 前, '真逛街该掉体力')
  rmSync(join(m, '..'), { recursive: true, force: true })
})

test('C6 刚做完 1 分钟 → 还按原来的算（5 分钟门槛，别一做完就宣布她站着）', () => {
  const m = 造盒('喝点水', 'just')
  跑(m)
  assert.equal(台账末条(m).kind, '买', '刚放下杯子就判「待着」太急')
  rmSync(join(m, '..'), { recursive: true, force: true })
})
