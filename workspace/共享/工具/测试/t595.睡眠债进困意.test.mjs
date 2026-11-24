// t595 —— 睡眠债必须进「困意」（批次595）
//
// 现场：她 11-16 09:20 睡到 16:00，欠觉 12.78 小时，
// 02:24 时 awakeHours 10.25、困意只有 34 —— 体力已经被欠觉封顶压到 63，
// 主观困意却像没事人。根因不是数值没填，是 困意.mjs 从来没读 睡眠.json 的「欠」。
//
// 这份测试只钉三件事：
//   ① 没欠觉时不许多加；
//   ② 欠得越多越困，且有封顶；
//   ③ --json 里能看到「睡眠债」这一项，面板/日志能定位。
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const NODE = '/usr/local/bin/node'

const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

function 造({ 欠 = 0, hoursAwake = 10 } = {}) {
  const d = mkdtempSync(join(tmpdir(), 't595-'))
  const mem = join(d, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  const 写 = (n, o) => writeFileSync(join(mem, n), JSON.stringify(o), 'utf8')
  写('状态.json', {
    energy: 67,
    hoursAwake,
    layers: { physical: 61, emotional: 51.5, cognitive: 75, existential: 57 },
    mood: { intensity: 0 },
  })
  写('睡醒.json', { sleeping: false, since: bj(now - hoursAwake * 3600e3).slice(0, 16) })
  写('睡眠.json', {
    sleeping: false, live: null, sleepSince: 0,
    awakeSince: now - hoursAwake * 3600e3,
    segments: [], records: [], 欠,
  })
  写('激素.json', { v: { dopamine: 45, cortisol: 22, oxytocin: 47, gaba: 50, adrenaline: 18 } })
  写('自主.json', { state: '待命', since: now - 30 * 60e3, nextAt: 0, doneAt: 0, note: '', place: '家' })
  return { 根: d, mem }
}

const 环境 = (mem) => ({
  ...process.env,
  QQ_SLEEPY_MEM: mem, ST_BASE: mem, QQ_SLEEP_MEM: mem,
  QQ_AUTONOMY_MEM: mem, NAP_MEM: mem, LOG_PREFIX_OFF: '1',
})

function 跑(opt) {
  const s = 造(opt)
  try {
    const out = execFileSync(NODE, [join(工具, '困意.mjs'), '--json'], {
      encoding: 'utf8', timeout: 60000, env: 环境(s.mem),
    })
    return JSON.parse(out)
  } finally {
    rmSync(s.根, { recursive: true, force: true })
  }
}

test('D1 没欠觉：睡眠债不额外加困意', () => {
  const r = 跑({ 欠: 0 })
  assert.equal(r.睡眠债, 0)
  assert.equal(r.parts.睡眠债, 0)
})

test('D2 欠 4 小时：按 1.6 的系数加，约 +6', () => {
  const 零 = 跑({ 欠: 0 })
  const 四 = 跑({ 欠: 4 })
  const 差 = 四.sleepy - 零.sleepy
  assert.ok(差 >= 5 && 差 <= 8, `欠 4 小时应加约 6，实际 ${差}（${零.sleepy}→${四.sleepy}）`)
  assert.equal(四.parts.睡眠债, 6)
})

test('D3 欠 12 小时：加到封顶 18，不再线性上涨', () => {
  const 十二 = 跑({ 欠: 12 })
  const 二十 = 跑({ 欠: 20 })
  assert.equal(十二.parts.睡眠债, 18)
  assert.equal(二十.parts.睡眠债, 18)
  assert.equal(十二.sleepy, 二十.sleepy)
})

test('D4 欠觉必须显著抬高困意：12 小时债至少 +15', () => {
  const 零 = 跑({ 欠: 0 })
  const 十二 = 跑({ 欠: 12 })
  assert.ok(十二.sleepy - 零.sleepy >= 15, `欠 12 小时只涨了 ${十二.sleepy - 零.sleepy}`)
})
