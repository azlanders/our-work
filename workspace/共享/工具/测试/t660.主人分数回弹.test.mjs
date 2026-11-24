// 批次660（审计 P1-2）：面板改「主人分数」必须真的落到目标，且不能被下一轮结算吃掉
//   旧实现只按比例缩放三维，某一维贴 0/100 时残差被丢掉，重算回到原分
//   面板也没更新 lastTick，下一次 好感度.mjs 结算会把刚写的值按天数衰减一遍
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const { 缩放四维, 写主人分数 } = await import(pathToFileURL(path.join(工具, '关系调试.mjs')).href)

const 加权 = (d) => 0.5 * d['亲近'] + 0.3 * d['安全'] + 0.2 * d['兴致']

// 好感度.mjs 是 CLI 脚本（import 就会跑主流程写盘），不能直接引。
// 这里按 好感度.mjs:74-98 的公式做一份只读镜像，用来验「下一轮结算会不会回弹」。
const 日常 = { 亲近: 40, 安全: 55, 兴致: 45 }
const 半衰 = { 亲近: 30, 安全: 45, 兴致: 10 }
const 上限 = { 亲近: 100, 安全: 100, 兴致: 100 }
const r1 = (v) => Math.round(v * 10) / 10
const 数 = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }
const 回落 = (v, 日常值, 天, halfLife) => (天 > 0 ? 日常值 + (v - 日常值) * Math.exp(-天 / halfLife) : v)
function 结算镜像(p, now) {
  const dt = Math.max(0, (now - 数(p.lastTick, now)) / 86400e3)
  if (dt > 0) {
    for (const k of ['亲近', '安全', '兴致']) p.dims[k] = r1(回落(数(p.dims[k], 日常[k]), 日常[k], dt, 半衰[k]))
    p.lastTick = now
  }
  for (const k of ['亲近', '安全', '兴致']) {
    let v = 数(p.dims[k], 日常[k])
    if (v > 92) v = 92 + (v - 92) * 0.4
    p.dims[k] = r1(Math.max(0, Math.min(上限[k], v)))
  }
  p.score = r1(0.5 * p.dims['亲近'] + 0.3 * p.dims['安全'] + 0.2 * p.dims['兴致'])
  return p
}

test('R1 四维饱和：亲近/安全已满、兴致 0，目标 100 仍能落到 100', () => {
  const d = 缩放四维({ 亲近: 100, 安全: 100, 兴致: 0, 思念: 0 }, 100)
  assert.ok(Math.abs(加权(d) - 100) < 0.1, `实际 ${加权(d)}`)
  assert.ok(Object.values(d).every((v) => v >= 0 && v <= 100), '不许越界')
})

test('R2 单维为 0：目标 60 不能被 0 权重拖住', () => {
  const d = 缩放四维({ 亲近: 0, 安全: 80, 兴致: 80 }, 60)
  assert.ok(Math.abs(加权(d) - 60) < 0.1, `实际 ${加权(d)}`)
})

test('R3 目标低于当前值：往下调也要真的降下来', () => {
  const d = 缩放四维({ 亲近: 100, 安全: 100, 兴致: 100 }, 20)
  assert.ok(Math.abs(加权(d) - 20) < 0.1, `实际 ${加权(d)}`)
})

test('R4 目标 0 / 100 仍分别清空与封顶（回归 t604）', () => {
  assert.equal(加权(缩放四维({ 亲近: 60, 安全: 60, 兴致: 60 }, 0)), 0)
  assert.equal(加权(缩放四维({ 亲近: 100, 安全: 100, 兴致: 100 }, 100)), 100)
})

test('R5 写主人分数会同步 lastTick，结算不再按旧时间衰减（92 以上走既有软上限）', () => {
  const now = 1_700_000_000_000
  const p = 写主人分数({ dims: { 亲近: 100, 安全: 100, 兴致: 0 }, lastTick: now - 30 * 86400e3 }, 100, now)
  assert.equal(p.lastTick, now, 'lastTick 必须推到当下')
  assert.ok(Math.abs(p.score - 100) < 0.1, `score 实际 ${p.score}`)
  const 结 = 结算镜像(p, now)
  // 好感度.mjs:91-95 的软上限是刻意设计：92 以上只留四成余量，100 → 95.2。
  // 这里要证的是「不再回弹到原来的 80」，而不是绕开软上限。
  assert.ok(加权(结.dims) >= 95, `结算后实际 ${加权(结.dims)}`)
})

test('R6 写主人分数：四维饱和 + 旧 lastTick，下一轮结算仍贴着目标', () => {
  const now = 1_700_000_000_000
  const 旧 = { dims: { 亲近: 92, 安全: 92, 兴致: 92 }, lastTick: now - 7 * 86400e3, score: 92 }
  const p = 写主人分数(旧, 70, now)
  const 结 = 结算镜像(p, now)
  assert.ok(Math.abs(加权(结.dims) - 70) < 1.5, `结算后实际 ${加权(结.dims)}`)
})

test('R7 反证：不更新 lastTick 的话，旧时间会把刚写的值衰减掉', () => {
  const now = 1_700_000_000_000
  const 未写 = { dims: { 亲近: 100, 安全: 100, 兴致: 100 }, lastTick: now - 7 * 86400e3, score: 100 }
  const 结 = 结算镜像(未写, now)
  assert.ok(加权(结.dims) < 95, `应被衰减，实际 ${加权(结.dims)}`)
})
