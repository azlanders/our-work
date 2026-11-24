// t680 —— 批次680：困意的分项必须能把总分加回来
//
// 旧账：面板显示「困意 71」，可 `parts` 只有 腺苷/节律/情绪/存在/身体/睡眠债 六项，
// 加起来 55。漏了三类真在改总分的项：
//   · 唤醒（advPart，本来就在 parts 里，但文本输出没列）
//   · 熬夜 +12（`熬夜.json.until` 还没到）
//   · 憋着（awakePressure）与 账（困意账 / 压制 / 待结算）
// 主人看到 71 和 55 对不上，没法判断是哪一项在推高。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 键 = ['腺苷', '节律', '情绪', '存在', '身体', '唤醒', '睡眠债', '熬夜', '憋着', '账']

function 造({ hoursAwake = 10, 熬夜 = false, 压制 = false } = {}) {
  const 根 = mkdtempSync(join(tmpdir(), 't680-'))
  const mem = join(根, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  const 写 = (n, o) => writeFileSync(join(mem, n), JSON.stringify(o), 'utf8')
  写('状态.json', {
    energy: 67, hoursAwake,
    layers: { physical: 61, emotional: 55, cognitive: 72, existential: 57 },
    mood: { intensity: 0 },
  })
  写('睡醒.json', { sleeping: false, since: bj(now - hoursAwake * 3600e3).slice(0, 16) })
  写('睡眠.json', {
    sleeping: false, live: null, sleepSince: 0,
    awakeSince: now - hoursAwake * 3600e3,
    segments: [], records: [], 欠: 6,
  })
  写('激素.json', { v: { dopamine: 45, cortisol: 22, oxytocin: 47, gaba: 50, adrenaline: 18 } })
  写('自主.json', { state: '待命', since: now - 30 * 60e3, nextAt: 0, doneAt: 0, note: '', place: '家' })
  if (熬夜) 写('熬夜.json', { until: bj(now + 2 * 3600e3).slice(0, 16) })
  if (压制) 写('压制.json', { 当前: { at: now, 事: '看B站' }, 待结算: [] })
  return { 根, mem }
}

const 环境 = (mem) => ({
  ...process.env,
  QQ_SLEEPY_MEM: mem, ST_BASE: mem, QQ_SLEEP_MEM: mem,
  QQ_AUTONOMY_MEM: mem, NAP_MEM: mem, LOG_PREFIX_OFF: '1',
})

function 跑(opt) {
  const s = 造(opt)
  try {
    const out = execFileSync(process.execPath, [join(工具, '困意.mjs'), '--json'], {
      encoding: 'utf8', timeout: 60000, env: 环境(s.mem),
    })
    return JSON.parse(out)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
}

test('E1 parts 十项齐全，分项和能加回总分', () => {
  const r = 跑({})
  for (const k of 键) assert.equal(typeof r.parts[k], 'number', `缺 ${k}`)
  const 和 = 键.reduce((a, k) => a + r.parts[k], 0)
  assert.equal(r.分项和, 和, '分项和字段要等于各项相加')
  assert.ok(Math.abs(r.闭合差) <= 3, `闭合差 ${r.闭合差} 太大，说明还有项没进 parts`)
})

test('E2 熬夜 +12 必须单独列出来，不能只藏在总分里', () => {
  const r = 跑({ 熬夜: true })
  assert.equal(r.parts.熬夜, 12)
  assert.ok(Math.abs(r.闭合差) <= 3)
})

test('E3 压制期间「账」为负，且分项仍然闭合', () => {
  const r = 跑({ 压制: true })
  assert.ok(r.parts.账 < 0, `压制时应扣分，实际 ${r.parts.账}`)
  assert.ok(Math.abs(r.闭合差) <= 3)
})
