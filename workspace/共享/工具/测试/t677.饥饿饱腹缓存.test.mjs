// t677 —— 批次677：所有会改饱腹的路径都刷新 饥饿.json.饱腹 缓存
//
// 现场：tick 只推进衰减不回写；面板直接改千卡后缓存停在旧值；
// poll.stateFastHintOf 读的是 饥饿.读()（现算），不是裸缓存。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync  } from 'node:fs'

import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
// 线上 plugin-lib 不在工具目录旁边，用 QQ_LIB_DIR 显式指（同 t676/t678）。
const 线上lib = (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/profiles/web/node_modules/dsh-onebot-channel/lib'
const 插件 = process.env.QQ_LIB_DIR || (existsSync(join(工具, '..', 'plugin-lib')) ? join(工具, '..', 'plugin-lib') : 线上lib)
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))

function 造(卡 = 1000) {
  const 根 = mkdtempSync(join(tmpdir(), 't677-cache-'))
  const mem = join(根, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  writeFileSync(join(mem, '饱渴.json'), JSON.stringify({
    水: 1200, 水At: bj(now), 卡, 卡At: bj(now),
    胃: 0, 胃At: bj(now), 欠: 0, 欠At: bj(now),
    血糖: 5, 血At: bj(now), 账: [],
  }), 'utf8')
  writeFileSync(join(mem, '饥饿.json'), JSON.stringify({
    今天: { 日期: bj(now).slice(0, 10), 顿: 0, 钱: 0, 零食: 0 }, 饱腹: 5,
  }), 'utf8')
  return { 根, mem, now }
}

function 环境(mem) {
  const e = {
    ...process.env, HUNGER_MEM: mem, BAOKE_MEM: mem, GAP_MEM: mem, ITEM_MEM: mem,
    QQ_AUTONOMY_MEM: mem, QQ_ACT_MEM: mem, QQ_LOCK_DIR: join(mem, '.locks'),
    QUIET_NOTE: '1', LOG_PREFIX_OFF: '1',
  }
  delete e.NODE_OPTIONS
  return e
}

function 跑(s, body) {
  const run = join(s.根, 'run-' + Math.random().toString(36).slice(2) + '.mjs')
  writeFileSync(run, [
    `import { readFileSync } from 'node:fs'`,
    `import { tick, 吃, 记一顿, 刷新饱腹, 读 } from ${JSON.stringify(pathToFileURL(join(工具, '饥饿.mjs')).href)}`,
    `const saved = () => JSON.parse(readFileSync(${JSON.stringify(join(s.mem, '饥饿.json'))}, 'utf8')).饱腹`,
    `let extra = null`,
    body,
    `console.log(JSON.stringify({ 现算: 读(${s.now}).饱腹, saved: saved(), extra }))`,
  ].join('\n'), 'utf8')
  return JSON.parse(execFileSync(process.execPath, [run], {
    encoding: 'utf8', timeout: 60000, env: 环境(s.mem),
  }))
}

test('C1 tick 推进后把缓存写回，且重复刷新不会二次扣卡', () => {
  const s = 造(1000)
  try {
    const out = 跑(s, `const t = tick(${s.now}); const a = 刷新饱腹(${s.now}); const b = 刷新饱腹(${s.now}); extra = { a: a.饱腹, b: b.饱腹, tick: t.饱腹 };`)
    assert.ok(out.现算 >= 45 && out.现算 <= 55, `现算应约 50，实际 ${out.现算}`)
    assert.equal(out.saved, out.现算)
    assert.equal(out.extra.a, out.extra.b)
    assert.equal(out.extra.tick, out.现算)
    assert.equal(读(join(s.mem, '饱渴.json')).卡, 1000, '重复刷新不该改千卡')
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C2 吃() 后缓存跟现算一致（真实物品 950 千卡）', () => {
  const s = 造(600)
  try {
    writeFileSync(join(s.mem, '物品总表.json'), JSON.stringify({
      分组: { 吃喝: { 正餐: {
        '一顿正经饭': { 类别: '吃', 价: 28, 吃: { kcal: 950, 顶胃: 850, 补水: 0 } },
      } } },
    }), 'utf8')
    const out = 跑(s, `const r = 吃({ 名: '一顿正经饭', 价: 0, 类别: '吃', at: ${s.now} });`)
    assert.equal(out.现算, out.saved)
    assert.ok(out.现算 > 75, `950 千卡后应约 77.5，实际 ${out.现算}`)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C3 记一顿() 后缓存跟现算一致', () => {
  const s = 造(1000)
  try {
    const out = 跑(s, `const r = 记一顿({ 名: '米饭', 类别: '吃', 价: 10, at: ${s.now} });`)
    assert.equal(out.现算, out.saved)
    assert.ok(out.现算 >= 45 && out.现算 <= 55, `现算应约 50，实际 ${out.现算}`)
    assert.equal(读(join(s.mem, '饥饿.json')).今天.顿, 1)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C4 面板改千卡接刷新；poll 读现算，不读裸缓存', () => {
  const 面板源 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  assert.match(面板源, /刷新饱腹 as 刷新饥饿饱腹/)
  const i = 面板源.indexOf("if (项.id === 'kcal')")
  assert.ok(i > 0, '面板没有按 kcal 分支')
  assert.match(面板源.slice(i, i + 240), /刷新饥饿饱腹\(\)/)

  const poll = readFileSync(join(插件, 'poll.js'), 'utf8')
  const p0 = poll.indexOf('function observableStateOf')
  const p = p0 >= 0 ? p0 : poll.indexOf('export function stateFastHintOf')
  assert.ok(p > 0, 'poll.js 里找不到 stateFastHintOf')
  const 段 = poll.slice(p, p + 2000)
  assert.match(段, /饥饿\.读\(\)/, 'stateFastHintOf 没走 饥饿.读()')
  assert.equal(/快读Json\(`\$\{MEM\}\/饥饿\.json`\)/.test(段), false, 'stateFastHintOf 又在读裸缓存')

  const 饥饿源 = readFileSync(join(工具, '饥饿.mjs'), 'utf8')
  assert.ok((饥饿源.match(/记账\.饱腹 =/g) || []).length >= 3, '吃/记一顿/刷新 三条路径没都写缓存')
  assert.match(饥饿源, /return 刷新饱腹\(now\)/, 'tick 没接刷新')

  const 吃饭源 = readFileSync(join(工具, '吃饭.mjs'), 'utf8')
  assert.match(吃饭源, /饥饿\.刷新饱腹\(\)/, '吃饭分分钟结算没刷新缓存')
  const 疾病源 = readFileSync(join(工具, '疾病.mjs'), 'utf8')
  assert.match(疾病源, /import \* as 饥饿 from '\.\/饥饿\.mjs'/, '疾病没接饥饿')
  assert.match(疾病源, /饥饿\.刷新饱腹\(now\)/, '挂水加卡后没刷新缓存')
})

test('C5 吃饭.mjs --tick 分分钟结算也把缓存刷新', () => {
  const s = 造(600)
  try {
    const now = Date.now()
    writeFileSync(join(s.mem, '物品总表.json'), JSON.stringify({
      分组: { 吃喝: { 正餐: {
        '一顿正经饭': { 类别: '吃', 价: 28, 吃: { kcal: 950, 顶胃: 850, 补水: 0 } },
      } } },
    }), 'utf8')
    writeFileSync(join(s.mem, '吃饭.json'), JSON.stringify({
      吃啥: '一顿正经饭', 在哪: '餐厅', 类别: '吃',
      开始: bj(now - 5 * 60e3), 到: bj(now + 20 * 60e3),
      分钟: 25, 已给: 0,
    }), 'utf8')
    execFileSync(process.execPath, [join(工具, '吃饭.mjs'), '--tick'], {
      encoding: 'utf8', timeout: 30000,
      env: { ...环境(s.mem), QQ_WORKSPACE: s.根 },
    })
    const 饥 = 读(join(s.mem, '饥饿.json'))
    const 饱 = 读(join(s.mem, '饱渴.json'))
    assert.ok(Number(读(join(s.mem, '吃饭.json')).已给) > 0, '这顿饭没推进')
    assert.ok(饥.饱腹 > 5, `缓存没涨：${饥.饱腹}`)
    assert.ok(Math.abs(饥.饱腹 - 饱.卡 / 20) < 1, `缓存 ${饥.饱腹} 与现算 ${饱.卡 / 20} 不一致`)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})
