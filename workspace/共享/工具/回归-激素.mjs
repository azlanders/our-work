#!/usr/bin/env node
// 回归-激素.mjs —— 激素/关系模块的行为用例（2026-11-04）
//
// 用法：node 回归-激素.mjs           # 全过退出码 0，失败退出码 1
// 思路：全部在 /tmp 沙盒里跑（HJ_BASE 指过去），绝不碰线上 记忆/ 目录。
// 断言只说「方向 + 范围」，不锁死具体数值——参数会调，锁死就会天天变红。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const NODE = '/usr/local/bin/node'
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'hj-'))
const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail })

const run = (script, args) => execFileSync(NODE, [script === '激素.mjs' && process.env.HORMONE_SOURCE ? process.env.HORMONE_SOURCE : path.join(TOOLS, script), ...args], {
  encoding: 'utf8', timeout: 20000, env: { ...process.env, HJ_BASE: SB },
})

const writeState = (v, B) => fs.writeFileSync(path.join(SB, '激素.json'), JSON.stringify({
  v, B, lastTick: Date.now(), repeats: {},
  daily: { date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), used: {} },
}, null, 2))

const readState = () => JSON.parse(fs.readFileSync(path.join(SB, '激素.json'), 'utf8'))

const base = { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50 }

for (const [name, needle] of [
  ['活动', '"--event", e.激素, "--id", eventId'],
  ['计划', '"--event", ev, "--id", \'plan:'],
  ['缺口', '"--event", "饿", "--id", \'gap:resist:'],
  ['花钱', '"--event", kind, "--id", eventId'],
]) {
  const source = fs.readFileSync(path.join(TOOLS, name + '.mjs'), 'utf8')
  ok(`事件ID：${name}调用激素带id`, source.includes(needle), needle)
}

// 用例 1：衰减必须动（设定点等于基线时也要动）
{
  const f = path.join(SB, '激素.json')
  fs.writeFileSync(f, JSON.stringify({
    v: { ...base, dopamine: 80 }, B: base, lastTick: Date.now() - 1.5 * 3600e3, repeats: {},
    daily: { date: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10), used: {} },
  }, null, 2))
  run('激素.mjs', ['--tick'])
  const v = readState().v.dopamine
  ok('衰减：80 放 1.5 小时应落到 50±10', v > 45 && v < 65, String(v))
}

// 用例 2：新事件必须先结算自上次推进后的自然衰减。
{
  writeState({ ...base, dopamine: 80 }, base)
  const state = readState()
  state.lastTick = Date.now() - 1.5 * 3600e3
  fs.writeFileSync(path.join(SB, '激素.json'), JSON.stringify(state, null, 2))
  run('激素.mjs', ['--event', '被夸', '--id', 'event-after-idle'])
  const dopamine = readState().v.dopamine
  ok('事件前衰减：久未推进时先向基线回落再响应新事件', dopamine > 55 && dopamine < 75, String(dopamine))
}

// 用例 3：重复夸奖要递减（第 3 次增量明显小于第 1 次）
{
  writeState(base, base)
  const deltas = []
  for (let i = 1; i <= 3; i++) {
    const out = run('激素.mjs', ['--event', '被夸', '--id', 'p' + i])
    const m = out.match(/多巴胺 45→([\d.]+)/) || out.match(/多巴胺 [\d.]+→([\d.]+)/)
    deltas.push(Number(m ? m[1] : NaN))
  }
  const inc = [deltas[0] - 45, deltas[1] - deltas[0], deltas[2] - deltas[1]]
  ok('重复衰减：第 3 次增量 < 第 1 次的一半', inc[2] < inc[0] / 2, JSON.stringify(inc))
}

// 用例 4：重复事件仍推进经过时间的衰减，但不再叠加事件增量。
{
  writeState({ ...base, dopamine: 80 }, base)
  const state = readState()
  state.lastTick = Date.now() - 1.5 * 3600e3
  fs.writeFileSync(path.join(SB, '激素.json'), JSON.stringify(state, null, 2))
  const out = run('激素.mjs', ['--event', '被夸', '--id', 'p3'])
  const dopamine = readState().v.dopamine
  ok('去重：重复事件按时衰减但不叠加增量', out.includes('重复') && dopamine > 50 && dopamine < 60, `${out.trim().slice(0, 20)}；D=${dopamine}`)
}

// 用例 5：互相抑制——皮质醇高时被夸给的多巴胺增量要明显变小
{
  writeState({ ...base, cortisol: 80 }, { ...base, cortisol: 25 })
  const out = run('激素.mjs', ['--event', '被夸', '--id', 'c1'])
  const v = readState().v.dopamine
  ok('互相抑制：皮质醇 80 时多巴胺增量 < 8', v - 45 < 8 && v > 45, String(v))
}

// 用例 6：HPA 自限——皮质醇已高时，争吵给的增量低于基线一半
{
  writeState({ ...base, cortisol: 80 }, base)
  const out = run('激素.mjs', ['--event', '争吵', '--id', 'h1'])
  const v = readState().v.cortisol
  ok('HPA 自限：已 80 时争吵只加不到 7', v - 80 > 0 && v - 80 < 7, String(v))
}

// 用例 7：关系——bond 每天只涨一次，越界让 safety 大跌
{
  run('关系.mjs', ['--who', '999', '--事件', '陪伴'])
  run('关系.mjs', ['--who', '999', '--事件', '陪伴'])
  const j1 = JSON.parse(fs.readFileSync(path.join(SB, '关系.json'), 'utf8')).people['999']
  ok('关系：bond 当天最多 +0.01', j1.bond <= 0.0101, String(j1.bond))
  run('关系.mjs', ['--who', '999', '--事件', '越界'])
  const j2 = JSON.parse(fs.readFileSync(path.join(SB, '关系.json'), 'utf8')).people['999']
  ok('关系：越界后 safety 明显下降', j1.safety - j2.safety > 0.2, `${j1.safety}→${j2.safety}`)
}

// 用例 8：痛苦后补偿——60 分钟前被骂，被夸的催产素增量应略大
{
  fs.writeFileSync(path.join(SB, '激素痛苦.json'), JSON.stringify({ at: Date.now() - 60 * 60e3, kind: '被骂' }))
  writeState(base, base)
  run('激素.mjs', ['--event', '被夸', '--id', 'r1'])
  const v = readState().v.oxytocin
  ok('痛苦补偿：催产素增量 > 4', v - 40 > 4, String(v))
}

const bad = results.filter((r) => !r.pass)
for (const r of results) console.log((r.pass ? '[ok] ' : '[!!] ') + r.name + (r.detail ? '  ' + r.detail : ''))
console.log('----')
console.log(bad.length === 0 ? '激素回归：全部通过' : '激素回归：' + bad.length + ' 条失败')
fs.rmSync(SB, { recursive: true, force: true })
process.exit(bad.length === 0 ? 0 : 1)
