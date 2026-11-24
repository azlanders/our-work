// t677 —— 批次677：体力按「她正在干什么」扣，不按「她站在哪类地方」扣
//
// 旧账：咖啡店 kind=打工，state=看B站 也按干活 -5/30min；图书馆看B站按学习 -2。
// 现在地点只决定 p（这里有没有机会）、门票、自动吃饭和地点激素；身体增量按活动类型。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))

function 环境(mem) {
  const e = {
    ...process.env, QQ_ACT_MEM: mem, QQ_AUTONOMY_MEM: mem, ST_BASE: mem,
    QQ_ACT_TOOLS: 工具, QQ_LOCK_DIR: join(mem, '.locks'),
    QUIET_NOTE: '1', LOG_PREFIX_OFF: '1',
  }
  delete e.NODE_OPTIONS
  return e
}

function 造(地点, state, 班 = null) {
  const 根 = mkdtempSync(join(tmpdir(), 't677-act-'))
  const mem = join(根, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  writeFileSync(join(mem, '状态.json'), JSON.stringify({
    energy: 60, 困意: 33, mood: { intensity: 0.4 },
    layers: { physical: 70, cognitive: 70, emotional: 60, existential: 60 },
  }), 'utf8')
  writeFileSync(join(mem, '资产.json'), JSON.stringify({ 钱: 1000, 位置: 地点, 记录: [] }), 'utf8')
  writeFileSync(join(mem, '自主.json'), JSON.stringify({
    state, since: now - 30 * 60e3, doneAt: 0, nextAt: now + 2 * 3600e3,
    place: 地点, log: [],
  }), 'utf8')
  if (班) {
    writeFileSync(join(mem, '工作.json'), JSON.stringify({ 班次: [{
      状态: '在岗', 点: 地点, 活: '咖啡店帮工',
      起: 班.起 || new Date(now - 30 * 60e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
      止: 班.止 || new Date(now + 2 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
      打卡At: new Date(now - 30 * 60e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
    }] }), 'utf8')
  }
  writeFileSync(join(mem, '活动台账.json'), JSON.stringify({ log: [] }), 'utf8')
  return { 根, mem }
}

const 跑看 = (mem) => execFileSync(process.execPath, [join(工具, '活动.mjs'), '--看'], {
  encoding: 'utf8', timeout: 20000, env: 环境(mem),
})
const 跑Tick = (mem) => execFileSync(process.execPath, [join(工具, '活动.mjs'), '--tick'], {
  encoding: 'utf8', timeout: 20000, env: 环境(mem),
})
const 体力 = (mem) => 读(join(mem, '状态.json')).layers.physical

test('C1 咖啡店 + 看B站 → 活动是「待着」，体力 +0（地点类别仍是打工）', () => {
  const s = 造('咖啡店', '看B站')
  try {
    const out = 跑看(s.mem)
    assert.match(out, /地点类别：打工/)
    assert.match(out, /活动：待着/)
    assert.match(out, /体力 \+0/)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C2 咖啡店 + state=打工、但没有工作.json 班次 → 只能「待着 +0」', () => {
  const s = 造('咖啡店', '打工')
  try {
    const out = 跑看(s.mem)
    assert.match(out, /活动：待着/)
    assert.match(out, /体力 \+0/)
    assert.equal(/活动：干活/.test(out), false, '又凭 state 字样记干活了')
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C3 咖啡店 + 真实在岗班次 → 才记「守店 -2.5」', () => {
  const s = 造('咖啡店', '打工', {})
  try {
    const out = 跑看(s.mem)
    assert.match(out, /活动：守店/)
    assert.match(out, /体力 -2.5/)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C4 图书馆 + 看B站 → 活动是「待着」，不再按学习 -2', () => {
  const s = 造('图书馆', '看B站')
  try {
    const out = 跑看(s.mem)
    assert.match(out, /地点类别：学习/)
    assert.match(out, /活动：待着/)
    assert.match(out, /体力 \+0/)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C5 沙盒真跑 20 次看B站：台账每一条都是待着，physical 一点不掉', () => {
  const s = 造('咖啡店', '看B站')
  try {
    const 前 = 体力(s.mem)
    for (let i = 0; i < 20; i += 1) 跑Tick(s.mem)
    const 账 = 读(join(s.mem, '活动台账.json')).log || []
    assert.equal(账.length, 20)
    assert.ok(账.every((x) => x.活动 === '待着'), '还有条目按地点类别干活')
    assert.ok(账.every((x) => x.kind === '打工'), 'kind 要保留地点类别，别把别处的判断弄坏')
    const 有效 = 账.filter((x) => x.生效)
    assert.ok(有效.length > 0, '20 次都没生效，随机序列异常')
    assert.ok(有效.every((x) => x.体力 === 0), '待着不该扣体力')
    assert.equal(体力(s.mem), 前, `physical 从 ${前} 变成了 ${体力(s.mem)}`)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C6 线上案例复现：咖啡店 + state=打工、无班次，20 次都不掉体力', () => {
  const s = 造('咖啡店', '打工')
  try {
    const 前 = 体力(s.mem)
    for (let i = 0; i < 20; i += 1) 跑Tick(s.mem)
    const 账 = 读(join(s.mem, '活动台账.json')).log || []
    assert.ok(账.every((x) => x.活动 === '待着'), '没有班次却还在记干活')
    assert.ok(账.filter((x) => x.生效).every((x) => x.体力 === 0))
    assert.equal(体力(s.mem), 前, `线上案例复发：${前} → ${体力(s.mem)}`)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C7 真实在岗班次：生效那条是「守店 -2.5」，physical 真的下降', () => {
  const s = 造('咖啡店', '打工', {})
  try {
    const 前 = 体力(s.mem)
    for (let i = 0; i < 20; i += 1) {
      跑Tick(s.mem)
      const 账 = 读(join(s.mem, '活动台账.json')).log || []
      if (账.some((x) => x.生效)) break
    }
    const 账 = 读(join(s.mem, '活动台账.json')).log || []
    const 干 = 账.find((x) => x.生效)
    assert.ok(干, '20 次都没生效，随机序列异常')
    assert.equal(干.活动, '守店')
    assert.equal(干.体力, -2.5)
    assert.ok(体力(s.mem) < 前, `physical 没降：${前} → ${体力(s.mem)}`)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C8 真实班次优先：state=打工 且 doneAt 旧了，也不能被 __待着 覆盖', () => {
  const s = 造('咖啡店', '打工', {})
  try {
    const 自 = 读(join(s.mem, '自主.json'))
    自.doneAt = Date.now() - 10 * 60e3
    writeFileSync(join(s.mem, '自主.json'), JSON.stringify(自), 'utf8')
    const out = 跑看(s.mem)
    assert.match(out, /活动：守店/)
    assert.match(out, /体力 -2.5/)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C9 走动有自己的档：-1.5/30 分钟，不再落到待着 +0', () => {
  const s = 造('海边', '从家走到海边')
  try {
    const out = 跑看(s.mem)
    assert.match(out, /活动：走动/)
    assert.match(out, /体力 -1.5/)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C10 在家休息：活动不再额外 +2（恢复归状态推进一本账）', () => {
  const s = 造('家', '看B站')
  try {
    const out = 跑看(s.mem)
    assert.match(out, /活动：在家待着/)
    assert.match(out, /体力 \+0/)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})
