// t677 —— 批次677：活动里的「自动吃一顿」必须走真实物品结算
//
// 旧账：活动.mjs 传 { 名: '在餐厅吃了一顿', 加: 42 }，这个名字不在物品总表，
// 饥饿.mjs 只能走兼容路：840 千卡、胃 0、水 0、血糖 0。
// 现改：直接点真实物品「一顿正经饭」，走 饥饿.吃() → 饱渴.吃() 同一条路。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))

function 环境(mem) {
  const e = {
    ...process.env,
    QQ_ACT_MEM: mem, QQ_AUTONOMY_MEM: mem, HUNGER_MEM: mem, BAOKE_MEM: mem,
    GAP_MEM: mem, ITEM_MEM: mem, ST_BASE: mem, QQ_SLEEPY_MEM: mem, QQ_SLEEP_MEM: mem,
    NAP_MEM: mem, HJ_BASE: mem, QQ_ACT_TOOLS: 工具, QQ_LOCK_DIR: join(mem, '.locks'),
    QUIET_NOTE: '1', LOG_PREFIX_OFF: '1',
  }
  delete e.NODE_OPTIONS
  return e
}

function 造() {
  const 根 = mkdtempSync(join(tmpdir(), 't677-meal-'))
  const mem = join(根, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  writeFileSync(join(mem, '饱渴.json'), JSON.stringify({
    水: 1200, 水At: bj(now), 卡: 600, 卡At: bj(now),
    胃: 100, 胃At: bj(now), 欠: 8, 欠At: bj(now),
    血糖: 5, 血At: bj(now), 账: [],
  }), 'utf8')
  writeFileSync(join(mem, '饥饿.json'), JSON.stringify({
    今天: { 日期: bj(now).slice(0, 10), 顿: 0, 钱: 0, 零食: 0 }, 饱腹: 30,
  }), 'utf8')
  writeFileSync(join(mem, '物品总表.json'), JSON.stringify({
    分组: { 吃喝: { 正餐: {
      '一顿正经饭': { 类别: '吃', 价: 28, 吃: { kcal: 950, 顶胃: 850, 补水: 0 } },
    } } },
  }), 'utf8')
  writeFileSync(join(mem, '状态.json'), JSON.stringify({
    energy: 60, 困意: 33, mood: { intensity: 0.4 },
    layers: { physical: 60, cognitive: 60, emotional: 60, existential: 60 },
  }), 'utf8')
  writeFileSync(join(mem, '资产.json'), JSON.stringify({ 钱: 100, 位置: '餐厅', 记录: [] }), 'utf8')
  writeFileSync(join(mem, '自主.json'), JSON.stringify({
    state: '吃饭', since: now - 10 * 60e3, doneAt: 0, nextAt: now + 2 * 3600e3,
    place: '餐厅', log: [],
  }), 'utf8')
  writeFileSync(join(mem, '活动台账.json'), JSON.stringify({ log: [] }), 'utf8')
  return { 根, mem, now }
}

test('C1 源码不再走「加: 42」的兼容路，而是点真实物品', () => {
  const 源 = readFileSync(join(工具, '活动.mjs'), 'utf8')
  assert.match(源, /饥饿\.吃\(\{ 名: "一顿正经饭", 价: 0, 类别: "吃" \}\)/)
  assert.equal(/加:\s*42/.test(源), false, '活动.mjs 还在走 840 千卡的兼容路')
})

test('C2 沙盒真跑：卡 +950、胃 +850、血糖 +2.6、欠 -4.75，且只记一顿', () => {
  const s = 造()
  try {
    const 前 = 读(join(s.mem, '饱渴.json'))
    for (let i = 0; i < 20; i += 1) {
      execFileSync(process.execPath, [join(工具, '活动.mjs'), '--tick'], {
        encoding: 'utf8', timeout: 30000, env: 环境(s.mem),
      })
      if (Number(读(join(s.mem, '饱渴.json')).卡) > Number(前.卡) + 100) break
    }
    const 后 = 读(join(s.mem, '饱渴.json'))
    assert.ok(后.卡 - 前.卡 > 900, `千卡只涨了 ${后.卡 - 前.卡}，没走真实物品`)
    assert.ok(后.胃 - 前.胃 > 800, `胃只涨了 ${后.胃 - 前.胃}，还是只加卡`)
    assert.ok(Math.abs(后.水 - 前.水) < 5, `这顿饭不该额外补水，水涨了 ${后.水 - 前.水}`)
    assert.ok(后.血糖 - 前.血糖 > 2.4 && 后.血糖 - 前.血糖 < 2.8, `血糖只涨了 ${后.血糖 - 前.血糖}`)
    assert.ok(后.欠 - 前.欠 < -4.5 && 后.欠 - 前.欠 > -5.0, `欠账只变了 ${后.欠 - 前.欠}`)

    const 饥 = 读(join(s.mem, '饥饿.json'))
    assert.equal(饥.今天.顿, 1, `只该记一顿，实际 ${饥.今天.顿}`)
    assert.equal(饥.最后吃了, '一顿正经饭')
    assert.ok(Math.abs(饥.饱腹 - 后.卡 / 20) < 1.5, `缓存 ${饥.饱腹} 与现算 ${后.卡 / 20} 不一致`)

    const 账 = 读(join(s.mem, '活动台账.json')).log || []
    const 吃了 = 账.filter((x) => x.生效 && x.kind === '吃')
    assert.ok(吃了.length >= 1, '活动台账里没有一次真的吃了')
    assert.equal(吃了[吃了.length - 1].活动, '吃饭')
    assert.equal(吃了[吃了.length - 1].体力, 6)
  } finally {
    rmSync(s.根, { recursive: true, force: true })
  }
})
