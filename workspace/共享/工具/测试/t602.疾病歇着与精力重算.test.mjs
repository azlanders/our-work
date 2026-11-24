// 批次602：数值审计 P1
//   1) 疾病.累 的「歇着」参数一直传 0 —— 在家躺着仍按 -8/h，歇着 -10/h 从未生效
//   2) 疾病/体温段改了 layers 之后没重算 energy —— 病重封顶体力，精力却还是旧值
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 装入 = (p) => import(pathToFileURL(p).href)
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造疾病档(值 = 100) {
  const b = mkdtempSync(join(tmpdir(), 't602-'))
  writeFileSync(join(b, '疾病.json'), JSON.stringify({
    当前: [], 史: [], 上月: { 月: '', 次: 0 }, 值, 值At: 北京(Date.now() - 3600e3), 上次判At: '',
  }))
  return b
}

test('疾病.累：歇着 1 小时比不歇多回落 2 点', async () => {
  const a = 造疾病档()
  const b = 造疾病档()
  process.env.QQ_AUTONOMY_MEM = a
  const 疾A = await 装入(join(工具, '疾病.mjs'))
  const now = Date.now()
  const 不歇 = 疾A.累({ 体温: 37, 体感: 23 }, now, 0, 0)
  process.env.QQ_AUTONOMY_MEM = b
  const 疾B = await import(pathToFileURL(join(工具, '疾病.mjs')).href + '?歇=1')
  const 歇着 = 疾B.累({ 体温: 37, 体感: 23 }, now, 0, 1)
  assert.equal(不歇, 92)
  assert.equal(歇着, 90)
  rmSync(a, { recursive: true, force: true })
  rmSync(b, { recursive: true, force: true })
})

function 造状态(病重) {
  const b = mkdtempSync(join(tmpdir(), 't602s-'))
  const now = Date.now()
  writeFileSync(join(b, '状态.json'), JSON.stringify({
    energy: 80, 困意: 30, hoursAwake: 6, 更新时间: 北京(now - 40 * 60e3),
    layers: { physical: 80, cognitive: 82, emotional: 51, existential: 52 },
    mood: { intensity: 0, label: '还算有精神' }, body: {}, place: '家',
  }))
  writeFileSync(join(b, '自主.json'), JSON.stringify({
    state: '待着', since: now - 3600e3, doneAt: now - 40 * 60e3, nextAt: now + 7200e3, log: [], place: '家',
  }))
  writeFileSync(join(b, '疾病.json'), JSON.stringify({
    当前: 病重 > 0 ? [{ 名: '发烧', 起: 北京(now - 2 * 3600e3), 重: 病重, 重At: 北京(now - 3600e3), 症状: ['浑身发烫'], 诱因: 'test' }] : [],
    史: [], 上月: { 月: '', 次: 0 }, 值: 病重 > 0 ? 800 : 0, 值At: 北京(now), 上次判At: 北京(now),
  }))
  writeFileSync(join(b, '体温.json'), JSON.stringify({ 体温: 37, 测At: 北京(now) }))
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ last_sleep: { 结束: 北京(now - 6 * 3600e3) } }))
  writeFileSync(join(b, '激素.json'), JSON.stringify({ v: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 }, B: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 } }))
  writeFileSync(join(b, '饱渴.json'), JSON.stringify({ 水: 1800, 卡: 1600, 胃: 500, 血糖: 5.2, 欠: 0 }))
  return b
}

const 跑 = (b) => execFileSync(process.execPath, [join(工具, '状态推进.mjs')], {
  encoding: 'utf8', timeout: 30000,
  env: {
    ...process.env, ST_BASE: b, QQ_AUTONOMY_MEM: b, QQ_SLEEPY_MEM: b,
    BAOKE_MEM: b, HUNGER_MEM: b, ITEM_MEM: b, TEMP_MEM: b,
  },
})

test('病重封顶体力后，落盘的 energy 必须按新 layers 重算', async () => {
  const b = 造状态(0.8)
  const 前 = JSON.parse(readFileSync(join(b, '状态.json'), 'utf8'))
  跑(b)
  const 后 = JSON.parse(readFileSync(join(b, '状态.json'), 'utf8'))
  const { 精力 } = await 装入(join(工具, '恢复目标.mjs'))
  assert.ok(后.layers.physical <= 60, `病重 0.8 应把体力压到 60 以下，实际 ${后.layers.physical}`)
  assert.equal(后.energy, 精力(后.layers), 'energy 还是封顶前的旧值')
  assert.ok(后.energy < 前.energy, `从 ${前.energy} 变成 ${后.energy}`)
  if (/^(还算有精神|平常|有点乏)$/.test(后.mood.label)) {
    const 该 = 后.energy >= 60 ? '还算有精神' : 后.energy >= 35 ? '平常' : '有点乏'
    assert.equal(后.mood.label, 该, '标签没跟着重算后的精力走')
  }
  rmSync(b, { recursive: true, force: true })
})

test('接线：状态推进必须把 resting 传给 疾病.累', () => {
  const src = readFileSync(join(工具, '状态推进.mjs'), 'utf8')
  assert.match(src, /疾病\.累\(__快照, __t, sleeping \? 1 : 0, resting \? 1 : 0\)/)
})
