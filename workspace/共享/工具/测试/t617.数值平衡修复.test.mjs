// 批次617：数值审计 P0-2/P0-3 + P1-1/P1-2/P1-5 的沙盒回归。
// 只写 os.tmpdir() 下的临时记忆；不启动服务、不碰 /data。
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 根 = mkdtempSync(join(tmpdir(), 't617-'))
const 沙 = join(根, '记忆')
mkdirSync(沙, { recursive: true })

// 模块在 import 时固化环境变量，先指向沙盒再加载。
for (const k of ['BAOKE_MEM', 'HUNGER_MEM', 'ITEM_MEM', 'GAP_MEM', 'QQ_ACT_MEM', 'QQ_AUTONOMY_MEM']) {
  process.env[k] = 沙
}
process.env.QUIET_NOTE = '1'
process.env.LOG_PREFIX_OFF = '1'

const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 整分 = () => Math.floor(Date.now() / 60000) * 60000
const 写json = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2), 'utf8')
const 满态 = (now, 改 = {}) => ({
  血糖: 5.0, 血At: 北京(now),
  水: 2000, 水At: 北京(now), 卡: 2000, 卡At: 北京(now),
  胃: 0, 胃At: 北京(now), 欠: 0, 欠At: 北京(now), 账: [], ...改,
})
const 重置饱渴 = (now, 改 = {}) => 写json(join(沙, '饱渴.json'), 满态(now, 改))
const 近似 = (实, 期, 容差 = 1e-9, 话 = '') => {
  assert.ok(Math.abs(Number(实) - Number(期)) <= 容差,
    `${话 || '数值不等'}：期望 ${期}，实际 ${实}`)
}

写json(join(沙, '物品总表.json'), {
  分组: {
    测试: {
      大饭: { 类别: '吃', 价: 10, 吃: { kcal: 640, 顶胃: 448, 补水: 100 } },
      巨饭: { 类别: '吃', 价: 20, 吃: { kcal: 2400, 顶胃: 100, 补水: 0 } },
      别名饭: { 类别: '吃', 价: 9, 吃: { 千卡: 400, 顶胃: 448, 补水: 0 } },
    },
  },
})

const { 心情修正, 饱腹感, 吃, 吃部分, 读 } = await import(pathToFileURL(join(工具, '饱渴.mjs')).href)
const { 精力 } = await import(pathToFileURL(join(工具, '恢复目标.mjs')).href)

function 读奖惩映射() {
  const 源 = readFileSync(join(工具, '奖惩.mjs'), 'utf8')
  const 激素表 = 源.match(/const __hjMap = (\{[^\n]+\})/)
  const 关系表 = 源.match(/const __relMap = (\{[^\n]+\})/)
  assert.ok(激素表 && 关系表, '找不到奖惩映射表')
  return {
    激素: Function(`"use strict"; return (${激素表[1]})`)(),
    关系: Function(`"use strict"; return (${关系表[1]})`)(),
  }
}

test('P0-2 空胃只经饱腹感扣一次，饿得难受仍在', () => {
  const now = 整分()
  重置饱渴(now, { 胃: 0, 血糖: 3.0 })
  const r = 心情修正(now)
  // 饱腹感 = 0；旧逻辑还会再叠加胃百<=10 的 -1.2（会变成 -2.8）。
  assert.equal(饱腹感(0, 3.0), 0)
  assert.equal(r.即时, -1.6)
  assert.equal(r.长期, 0.3)
  assert.ok(r.即时 < 0, '空胃 + 低血糖必须仍然难受')
})

test('P0-2 低血糖比正常血糖更难受，但没有第二笔胃空扣分', () => {
  const now = 整分()
  重置饱渴(now, { 胃: 0, 血糖: 5.5 })
  const 正常 = 心情修正(now)
  重置饱渴(now, { 胃: 0, 血糖: 3.0 })
  const 低糖 = 心情修正(now)
  assert.equal(正常.即时, -1.0)
  assert.equal(低糖.即时, -1.6)
  assert.ok(低糖.即时 < 正常.即时, '血糖低应当更难受')
})

test('P0-3 整份吃按真实 kcal 还欠，不把顶胃量 448 当热量', () => {
  const now = 整分()
  重置饱渴(now, { 欠: 10 })
  const r = 吃('大饭', now)
  assert.equal(r.kcal, 640)
  assert.equal(r.顶, 448)
  近似(读(now).欠, 6.8, 1e-9, '640 kcal 应还 3.2 点')
  assert.notEqual(读(now).欠, 7.76, '不能按顶胃 448/200 算还账')
})

test('P0-3 分十五口吃完整餐，与整份吃还欠一致', () => {
  const now = 整分()
  重置饱渴(now, { 欠: 10 })
  assert.ok(吃('大饭', now))
  const 整份 = 读(now).欠

  重置饱渴(now, { 欠: 10 })
  for (let i = 0; i < 15; i++) assert.ok(吃部分('大饭', 1 / 15, now))
  const 分口 = 读(now).欠
  近似(分口, 整份, 0.01, '十五口与整份不一致')
  近似(分口, 6.8, 0.01, '十五口应还 3.2 点')
})

test('P0-3 单餐还欠封顶 6 点，且仍然只认 kcal', () => {
  const now = 整分()
  重置饱渴(now, { 欠: 10 })
  const r = 吃('巨饭', now)
  assert.equal(r.顶, 100)
  assert.equal(读(now).欠, 4)
  // 顶胃只有 100；若误用顶胃，欠会几乎不动。
})

test('P0-3 千卡别名在整份和分口都按同一单位结算', () => {
  const now = 整分()
  重置饱渴(now, { 欠: 10 })
  assert.ok(吃('别名饭', now))
  assert.equal(读(now).欠, 8)
  重置饱渴(now, { 欠: 10 })
  for (let i = 0; i < 4; i++) assert.ok(吃部分('别名饭', 0.25, now))
  assert.equal(读(now).欠, 8)
})

function 造推进盒({ 病重 = 0, 疾病值 = 0, 自主态 = '待着', 体温 = 37, physical = 80 } = {}) {
  const d = mkdtempSync(join(tmpdir(), 't617推进-'))
  mkdirSync(join(d, '.locks'), { recursive: true })
  const now = Date.now()
  写json(join(d, '状态.json'), {
    energy: 80, 困意: 30, hoursAwake: 6, 更新时间: 北京(now - 40 * 60e3),
    layers: { physical, cognitive: 82, emotional: 51, existential: 52 },
    mood: { intensity: 0, label: '还算有精神' }, body: {}, place: '家',
  })
  写json(join(d, '自主.json'), {
    state: 自主态, since: now - 3600e3, doneAt: now - 3600e3,
    nextAt: now + 7200e3, log: [], place: '家',
  })
  写json(join(d, '疾病.json'), {
    当前: 病重 > 0 ? [{
      名: '发烧', 起: 北京(now - 2 * 3600e3), 重: 病重,
      重At: 北京(now - 3600e3), 症状: ['浑身发烫'], 诱因: 't617',
    }] : [],
    史: [], 上月: { 月: '', 次: 0 },
    值: 疾病值, 值At: 北京(now - 3600e3), 上次判At: 北京(now),
  })
  写json(join(d, '体温.json'), { 体温, 测At: 北京(now) })
  写json(join(d, '天气.json'), { 温度: 23 })
  写json(join(d, '资产.json'), { 位置: '家' })
  写json(join(d, '睡醒.json'), { last_sleep: { 结束: 北京(now - 6 * 3600e3) } })
  写json(join(d, '激素.json'), {
    v: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
    B: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
  })
  写json(join(d, '饱渴.json'), {
    水: 2000, 水At: 北京(now), 卡: 2000, 卡At: 北京(now),
    胃: 500, 血糖: 5.2, 血At: 北京(now), 欠: 0, 欠At: 北京(now),
  })
  return d
}

function 跑推进(d) {
  return execFileSync(process.execPath, [join(工具, '状态推进.mjs')], {
    encoding: 'utf8', timeout: 30000,
    env: {
      ...process.env, ST_BASE: d, QQ_MEM: d, QQ_AUTONOMY_MEM: d,
      QQ_SLEEPY_MEM: d, BAOKE_MEM: d, HUNGER_MEM: d, ITEM_MEM: d,
      GAP_MEM: d, QQ_ACT_MEM: d, TEMP_MEM: d, QQ_LOCK_DIR: join(d, '.locks'),
    },
  })
}

test('P1-1 疾病/体温段改完 layers 后，落盘 energy 重算且同拍', () => {
  const d = 造推进盒({ 病重: 0.8, 疾病值: 800 })
  try {
    const 前 = JSON.parse(readFileSync(join(d, '状态.json'), 'utf8'))
    跑推进(d)
    const 后 = JSON.parse(readFileSync(join(d, '状态.json'), 'utf8'))
    assert.ok(后.layers.physical < 前.layers.physical, '病重应压低体力')
    assert.equal(后.energy, 精力(后.layers), 'energy 必须按落盘 layers 重算')
    assert.ok(后.energy < 前.energy, '病中 energy 应立即下降')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('P1-1 高热体温罚压体力后，energy 也按新 layers 重算', () => {
  const d = 造推进盒({ 体温: 39.5, physical: 100 })
  try {
    const 前 = JSON.parse(readFileSync(join(d, '状态.json'), 'utf8'))
    跑推进(d)
    const 后 = JSON.parse(readFileSync(join(d, '状态.json'), 'utf8'))
    assert.ok(后.layers.physical < 前.layers.physical, '中暑档应压低体力')
    assert.equal(后.energy, 精力(后.layers), '高热后 energy 必须按新 layers 重算')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('P1-2 状态推进把在家歇着传给疾病值（-10/h，对比 -8/h）', () => {
  const 歇 = 造推进盒({ 疾病值: 100, 自主态: '待着' })
  const 走 = 造推进盒({ 疾病值: 100, 自主态: '走路' })
  try {
    跑推进(歇)
    跑推进(走)
    const 歇后 = JSON.parse(readFileSync(join(歇, '状态.json'), 'utf8'))
    const 走后 = JSON.parse(readFileSync(join(走, '状态.json'), 'utf8'))
    assert.equal(歇后['疾病值'], 90, '在家歇着 1 小时应回落 10')
    assert.equal(走后['疾病值'], 92, '走路 1 小时应只回落 8')
  } finally {
    rmSync(歇, { recursive: true, force: true })
    rmSync(走, { recursive: true, force: true })
  }
})

test('P1-5 被忽视的激素账改成被冷落，和被催/迟到分开', () => {
  const { 激素, 关系 } = 读奖惩映射()
  assert.equal(激素['被忽视'], '被冷落')
  assert.equal(关系['被忽视'], '被冷落', '两本账必须同义')
  assert.equal(激素['被催'], '被打断')
  assert.equal(激素['迟到'], '被打断')
})

test('P1-5 被冷落事件在沙盒里可结算，预算变化可观测', () => {
  const d = mkdtempSync(join(tmpdir(), 't617hj-'))
  try {
    const { 激素 } = 读奖惩映射()
    const 映射后 = 激素['被忽视']
    assert.equal(映射后, '被冷落')
    const out = execFileSync(process.execPath, [
      join(工具, '激素.mjs'), '--event', 映射后, '--id', 't617-冷落',
    ], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, HJ_BASE: d, QUIET_NOTE: '1' },
    })
    assert.match(out, /催产素/)
    assert.match(out, /皮质醇/)
    assert.match(out, /多巴胺/)
    assert.doesNotMatch(out, /肾上腺素/, '被冷落不应触发急性肾上腺素')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test.after(() => {
  try { rmSync(根, { recursive: true, force: true }) } catch {}
})
