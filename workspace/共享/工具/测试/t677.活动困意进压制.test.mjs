// t677 —— 批次677：活动对困意的增量写进 压制.json 的待结算，不直接改 状态.困意
//
// 旧账：活动.mjs 直接写 st.困意；15 分钟后 状态推进.mjs:513 用 困意.mjs 现算值覆盖，
// +5/+4/-3 最多活 15 分钟。现在走 压制.json 的半衰账，和「硬扛」用同一套回弹机制。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 环境(mem) {
  const e = {
    ...process.env, QQ_ACT_MEM: mem, QQ_AUTONOMY_MEM: mem, ST_BASE: mem,
    QQ_SLEEPY_MEM: mem, BAOKE_MEM: mem, QQ_ACT_TOOLS: 工具, QQ_LOCK_DIR: join(mem, '.locks'),
    QUIET_NOTE: '1', LOG_PREFIX_OFF: '1',
  }
  delete e.NODE_OPTIONS
  return e
}

function 造() {
  const 根 = mkdtempSync(join(tmpdir(), 't677-press-'))
  const mem = join(根, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  writeFileSync(join(mem, '状态.json'), JSON.stringify({
    energy: 60, 困意: 33, mood: { intensity: 0.4 },
    layers: { physical: 70, cognitive: 70, emotional: 60, existential: 60 },
  }), 'utf8')
  writeFileSync(join(mem, '资产.json'), JSON.stringify({ 钱: 1000, 位置: '咖啡店', 记录: [] }), 'utf8')
  writeFileSync(join(mem, '自主.json'), JSON.stringify({
    state: '打工', since: now - 30 * 60e3, doneAt: 0, nextAt: now + 2 * 3600e3,
    place: '咖啡店', log: [],
  }), 'utf8')
  // 真班次：A5 修完后，只有 工作.json 里在岗的班才算干活/守店。
  writeFileSync(join(mem, '工作.json'), JSON.stringify({ 班次: [{
    状态: '在岗', 点: '咖啡店', 活: '咖啡店帮工',
    起: bj(now - 30 * 60e3), 止: bj(now + 2 * 3600e3), 打卡At: bj(now - 30 * 60e3),
  }] }), 'utf8')
  writeFileSync(join(mem, '活动台账.json'), JSON.stringify({ log: [] }), 'utf8')
  writeFileSync(join(mem, '压制.json'), JSON.stringify({
    当前: { at: now - 10 * 60e3, 值: 5, 半衰: 40, 啥: '自主:硬扛', kind: '自主' },
    待结算: [],
  }), 'utf8')
  return { 根, mem }
}

test('C1 活动生效：st.困意 不动，压制.当前 不动，待结算多一条 +4/半衰30', () => {
  const s = 造()
  try {
    const 前困 = 读(join(s.mem, '状态.json')).困意
    const 前压 = 读(join(s.mem, '压制.json')).当前
    for (let i = 0; i < 20; i += 1) {
      execFileSync(process.execPath, [join(工具, '活动.mjs'), '--tick'], {
        encoding: 'utf8', timeout: 20000, env: 环境(s.mem),
      })
      const 压 = 读(join(s.mem, '压制.json'))
      if ((压.待结算 || []).some((x) => x.kind === '活动')) break
    }
    const st = 读(join(s.mem, '状态.json'))
    assert.equal(st.困意, 前困, '活动又直接改 状态.困意 了')
    const 压 = 读(join(s.mem, '压制.json'))
    assert.deepEqual(压.当前, 前压, '活动覆盖了 压制.当前')
    const 活 = (压.待结算 || []).filter((x) => x.kind === '活动')
    assert.equal(活.length, 1, '该有且只有一条活动账')
    // 批次685：守店 +4 → +2.5（干活 +5 → +3），别让稳态困意是腺苷的两倍多。
    assert.equal(活[0].值, 2.5)
    assert.equal(活[0].半衰, 30)
    assert.match(活[0].啥, /^活动:守店/)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C2 同一份状态：有这条待结算比没有时困意高 2~4 分', () => {
  const s = 造()
  const 根2 = s.根 + '-对照'
  try {
    for (let i = 0; i < 20; i += 1) {
      execFileSync(process.execPath, [join(工具, '活动.mjs'), '--tick'], {
        encoding: 'utf8', timeout: 20000, env: 环境(s.mem),
      })
      const 压 = 读(join(s.mem, '压制.json'))
      if ((压.待结算 || []).some((x) => x.kind === '活动')) break
    }
    const 压 = 读(join(s.mem, '压制.json'))
    assert.ok((压.待结算 || []).some((x) => x.kind === '活动'), '活动没生效，无法对照')
    cpSync(s.mem, 根2, { recursive: true })
    writeFileSync(join(根2, '压制.json'), JSON.stringify({ 当前: 压.当前, 待结算: [] }), 'utf8')

    const 有 = JSON.parse(execFileSync(process.execPath, [join(工具, '困意.mjs'), '--json'], {
      encoding: 'utf8', timeout: 30000, env: 环境(s.mem),
    }))
    const 无 = JSON.parse(execFileSync(process.execPath, [join(工具, '困意.mjs'), '--json'], {
      encoding: 'utf8', timeout: 30000, env: 环境(根2),
    }))
    const 差 = 有.sleepy - 无.sleepy
    assert.ok(差 >= 2 && 差 <= 4, `待结算 +2.5 只带来 ${差} 分差`)
  } finally {
    rmSync(s.根, { recursive: true, force: true })
    rmSync(根2, { recursive: true, force: true })
  }
})

test('C3 源码：活动不再写 st.困意，只追加 压制.待结算', () => {
  const 源 = readFileSync(join(工具, '活动.mjs'), 'utf8')
  assert.match(源, /压\.待结算 = 留\.slice\(-12\)/)
  assert.equal(/st\.困意\s*=/.test(源), false, '活动.mjs 还在直接写 st.困意')
  const 赋值 = [...源.matchAll(/压\.当前 = ([^\n]*)/g)].map((m) => m[1].trim())
  assert.deepEqual(赋值, ['null'], '活动.mjs 不该用非空值覆盖 压制.当前')
})
