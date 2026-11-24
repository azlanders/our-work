// t540 —— 「喝完水站着」不该按干活扣体力（批次539）
//
// 批次538 只修了 活动.mjs 那一份（不再记「逛店 -2」），但 状态推进.mjs 那条曲线
// 仍然只看 `自主.json` 的 state 字面：`是歇着('喝点水')` = false → 按「起身干活」扣 -2.4/h。
// 同一件事两个账。实测 11-16 凌晨她 physical 12.6、再待下去会一路掉到 energy=4 才被强制睡。
//
// 改法：状态推进 也读 doneAt —— 一次性动作 + 超过 5 分钟 → state 当「待着」（= 歇着，回血）。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const { 档, 是歇着 } = await import('{{BOT_ROOT}}/共享/工具/在干嘛.mjs')

test('T1 「待着」要落在「歇」那一档（不是「轻」）', () => {
  assert.equal(档('待着'), '歇')
  assert.equal(是歇着('待着'), true, '待着不回血的话，这次改动就白做了')
})

function 造(state, done) {
  const b = mkdtempSync(join(tmpdir(), 't540-'))
  const now = Date.now()
  const upd = new Date(now - 40 * 60e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  writeFileSync(join(b, '状态.json'), JSON.stringify({
    energy: 27, 困意: 33, hoursAwake: 19, 更新时间: upd,
    layers: { physical: 12.6, cognitive: 83, emotional: 51, existential: 52 },
    mood: { intensity: 0.26, label: '有点困' }, body: { 困: 33 }, birth: { at: '2026-10-01 00:00' },
  }))
  writeFileSync(join(b, '自主.json'), JSON.stringify({
    state,
    since: now - 3600e3,
    doneAt: done === 'past' ? now - 40 * 60e3 : done === 'just' ? now - 60e3 : 0,
    nextAt: now + 7200e3, log: [], place: '便利店',
  }))
  return b
}
const 跑 = (b) => execFileSync(process.execPath, [join(工具, '状态推进.mjs')], {
  encoding: 'utf8', timeout: 30000,
  // QQ_SLEEPY_MEM 也要指过去：状态推进 会 spawn 困意.mjs，它默认读真档
  env: { ...process.env, ST_BASE: b, QQ_SLEEPY_MEM: b },
})
const 体力 = (b) => JSON.parse(readFileSync(join(b, '状态.json'), 'utf8')).layers.physical

test('T2 喝完水待着（doneAt 40 分钟前）→ 体力要涨', () => {
  const b = 造('喝点水', 'past')
  const 前 = 体力(b)
  跑(b)
  const 后 = 体力(b)
  assert.ok(后 > 前, `从 ${前} 变成 ${后} —— 待着还在掉血，说明判据没生效`)
  rmSync(b, { recursive: true, force: true })
})

test('T3 真逛街（doneAt=0）→ 体力照掉，别把真活动也当歇着', () => {
  const b = 造('逛街', 0)
  const 前 = 体力(b)
  跑(b)
  const 后 = 体力(b)
  assert.ok(后 < 前, `从 ${前} 变成 ${后} —— 真逛街被当成了待着，这个方向错更糟`)
  rmSync(b, { recursive: true, force: true })
})

test('T4 刚喝完 1 分钟 → 还没到 5 分钟门槛，仍按原来算', () => {
  const b = 造('喝点水', 'just')
  const 前 = 体力(b)
  跑(b)
  const 后 = 体力(b)
  assert.ok(后 < 前, `从 ${前} 变成 ${后} —— 门槛被拿掉了`)
  rmSync(b, { recursive: true, force: true })
})

test('T5 源码：状态推进 用的是同一份清单和同一个门槛', () => {
  const src = readFileSync(join(工具, '状态推进.mjs'), 'utf8')
  assert.match(src, /import \{ 是歇着, 一次性动作 \} from '\.\/在干嘛\.mjs'/)
  assert.match(src, /一次性动作\.has\(act\)/, 'doneAt 判据被删了')
  assert.match(src, /5 \* 60e3/, '5 分钟门槛跟 活动.mjs 必须是同一个数')
  const 活动 = readFileSync(join(工具, '活动.mjs'), 'utf8')
  assert.match(活动, /5 \* 60e3/, '活动.mjs 那边的门槛变了？两边要一起改')
})
