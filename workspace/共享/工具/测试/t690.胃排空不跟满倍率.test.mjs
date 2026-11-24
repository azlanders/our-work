import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 批次 690：胃排空原来直接乘活动倍率，打工 1.8 时一顿饭两小时就空。
// 现在基础 3.2/分钟、倍率封 1.3；静着约 4.4 小时、打工约 3.4 小时。

const 工具 = process.env.QQ_TEST_TOOLS || join(dirname(fileURLToPath(import.meta.url)), '..')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

async function 造(state) {
  const mem = mkdtempSync(join(tmpdir(), 't690-'))
  const now = Date.now()
  writeFileSync(join(mem, '自主.json'), JSON.stringify({ state, since: now - 3600e3, doneAt: 0, nextAt: now + 7200e3 }))
  writeFileSync(join(mem, '饱渴.json'), JSON.stringify({
    血糖: 6.5, 血At: bj(now - 60 * 60e3), 水: 1500, 水At: bj(now - 60 * 60e3),
    卡: 1500, 卡At: bj(now - 60 * 60e3), 胃: 850, 胃At: bj(now - 60 * 60e3),
    欠: 0, 欠At: bj(now - 60 * 60e3), 账: [],
  }))
  process.env.BAOKE_MEM = mem
  process.env.HUNGER_MEM = mem
  const m = await import(pathToFileURL(join(工具, '饱渴.mjs')).href + '?t=' + Math.random())
  return { mem, m, now }
}

test('G1 打工 1 小时：胃掉 ~240（1.25 倍，没被额外放大）', async () => {
  const s = await 造('打工')
  try {
    const r = s.m.读(s.now)
    // 3.2 × 1.25 × 60 = 240
    assert.ok(r.胃 >= 606 && r.胃 <= 614, `打工一小时胃剩 ${r.胃}（应约 610）`)
  } finally { rmSync(s.mem, { recursive: true, force: true }) }
})

test('G2 待着 1 小时：胃掉 ~192（3.2/分钟）', async () => {
  const s = await 造('待着')
  try {
    const r = s.m.读(s.now)
    assert.ok(r.胃 >= 654 && r.胃 <= 662, `待着一小时胃剩 ${r.胃}（应约 658）`)
  } finally { rmSync(s.mem, { recursive: true, force: true }) }
})

test('G3 跑步 1 小时：倍率封在 1.3，胃掉 ~250 而不是 ~384', async () => {
  const s = await 造('跑步')
  try {
    const r = s.m.读(s.now)
    assert.ok(r.胃 >= 596 && r.胃 <= 604, `跑步一小时胃剩 ${r.胃}（应约 600）`)
  } finally { rmSync(s.mem, { recursive: true, force: true }) }
})
