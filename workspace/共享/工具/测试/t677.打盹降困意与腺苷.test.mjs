// t677 —— 批次677：打盹要真的解困，而且打盹期间不继续累计腺苷
//
// 旧账：打盹只回体力/认知；困意.mjs 只认 睡眠.json.segments，
// 打盹不写段，于是「眯 30 分钟」腺苷反而继续涨。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const bj秒 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))

function 环境(mem) {
  const e = {
    ...process.env, NAP_MEM: mem, QQ_AUTONOMY_MEM: mem, ST_BASE: mem,
    QQ_SLEEPY_MEM: mem, QQ_SLEEP_MEM: mem, BAOKE_MEM: mem, QQ_LOCK_DIR: join(mem, '.locks'),
    QUIET_NOTE: '1', LOG_PREFIX_OFF: '1',
  }
  delete e.NODE_OPTIONS
  return e
}

function 盒() {
  const 根 = mkdtempSync(join(tmpdir(), 't677-nap-'))
  const mem = join(根, '记忆')
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, '状态.json'), JSON.stringify({
    energy: 60, 困意: 60,
    layers: { physical: 50, cognitive: 50, emotional: 60, existential: 60 },
  }), 'utf8')
  writeFileSync(join(mem, '自主.json'), JSON.stringify({
    state: '打瞌睡', since: Date.now() - 30 * 60e3, log: [],
  }), 'utf8')
  return { 根, mem }
}

function 放盹(mem, 起毫秒, 止毫秒, 分钟) {
  writeFileSync(join(mem, '打盹.json'), JSON.stringify({
    开始: bj(起毫秒), 到: bj(止毫秒), 分钟,
    开始毫秒: 起毫秒, 到毫秒: 止毫秒, 为什么: 't677',
  }), 'utf8')
}

test('C1 --醒 按实际 20 分钟记 -3.0，半衰 90', () => {
  const s = 盒()
  try {
    const now = Date.now()
    放盹(s.mem, now - 20 * 60e3, now + 5 * 60e3, 20)
    const out = execFileSync(process.execPath, [join(工具, '打盹.mjs'), '--醒'], {
      encoding: 'utf8', timeout: 20000, env: 环境(s.mem),
    })
    assert.match(out, /困意账 -3（20 分钟/)
    const 账 = 读(join(s.mem, '状态.json')).困意账 || []
    assert.equal(账.length, 1)
    assert.equal(账[0].kind, '打盹')
    assert.equal(账[0].值, -3)
    assert.equal(账[0].半衰, 90)
    assert.equal(读(join(s.mem, '自主.json')).state, '待命')
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('C2 --tick 到点醒也按实际 25 分钟记 -3.8', () => {
  const s = 盒()
  try {
    const now = Date.now()
    放盹(s.mem, now - 26 * 60e3, now - 60e3, 25)
    const out = execFileSync(process.execPath, [join(工具, '打盹.mjs'), '--tick'], {
      encoding: 'utf8', timeout: 20000, env: 环境(s.mem),
    })
    assert.match(out, /困意账 -3.8（25 分钟/)
    const st = 读(join(s.mem, '状态.json'))
    assert.equal(st.困意账[0].值, -3.8)
    assert.equal(读(join(s.mem, '自主.json')).state, '待命')
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

function 睡盒(withNap) {
  const s = 盒()
  const now = Date.now()
  const 醒 = now - 10 * 3600e3
  writeFileSync(join(s.mem, '状态.json'), JSON.stringify({
    energy: 60, 困意: 40,
    layers: { physical: 60, cognitive: 60, emotional: 60, existential: 60 },
  }), 'utf8')
  writeFileSync(join(s.mem, '睡眠.json'), JSON.stringify({
    records: [], segments: [{ start: bj秒(now - 12 * 3600e3), end: bj秒(醒), hours: 2 }], 欠: 0,
  }), 'utf8')
  writeFileSync(join(s.mem, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj秒(醒) }), 'utf8')
  if (withNap) 放盹(s.mem, now - 1 * 3600e3, now + 10 * 60e3, 60)
  return s
}

const 跑困 = (mem) => JSON.parse(execFileSync(process.execPath, [join(工具, '困意.mjs'), '--json'], {
  encoding: 'utf8', timeout: 30000, env: 环境(mem),
}))

test('C3 打盹 1 小时：腺苷清醒账少 1 小时，困意低约 4.5', () => {
  const a = 睡盒(false)
  const b = 睡盒(true)
  try {
    const 没盹 = 跑困(a.mem)
    const 有盹 = 跑困(b.mem)
    assert.ok(没盹.awakeHours - 有盹.awakeHours > 0.8, `清醒账没扣掉：${没盹.awakeHours} → ${有盹.awakeHours}`)
    assert.ok(没盹.awakeHours - 有盹.awakeHours < 1.2)
    const 差 = 没盹.sleepy - 有盹.sleepy
    // NAP_TWO_PARTS 2026-11-17（批次 680 收尾）：打盹少的不只是腺苷。
    // 清醒账少 1 小时 → 腺苷约 -4.5~5，同时 awakePressure 也跟着降约 -2，
    // 合计 6~8 才是对的。原来上限写 6，只在清醒账刚好 10 小时时才过；
    // 线上实测 20.4→19.4 小时时差 7（腺苷 5 + 憋着 2），是正确行为。
    assert.ok(差 >= 3.5 && 差 <= 8, `困意只差 ${差}，腺苷没暂停`)
  } finally {
    rmSync(a.根, { recursive: true, force: true })
    rmSync(b.根, { recursive: true, force: true })
  }
})

test('C4 参数与源码：0.15/分钟、90 分半衰、腺苷暂停比例 1 都有代码读', () => {
  const 参数 = 读(join(工具, '参数.json'))
  assert.equal(参数.打盹['每分钟降困意'], 0.15)
  assert.equal(参数.打盹['困意半衰分钟'], 90)
  assert.equal(参数.打盹['腺苷暂停比例'], 1)
  assert.match(readFileSync(join(工具, '打盹.mjs'), 'utf8'), /每分钟降困意/)
  assert.match(readFileSync(join(工具, '打盹.mjs'), 'utf8'), /困意半衰分钟/)
  assert.match(readFileSync(join(工具, '困意.mjs'), 'utf8'), /腺苷暂停比例/)
})
