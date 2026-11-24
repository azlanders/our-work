// t502 —— 困意多段累加 + 打盹升级整觉（批次496/498/500 的判据）
// 为什么要这一份：这几处改动全靠手动沙盒验，没有回归保护。
// 一旦有人回退或重写，至少这里能红。
import test from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const NODE = '/usr/local/bin/node'

const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

function 造(opt = {}) {
  const d = mkdtempSync(join(tmpdir(), 't502-'))
  const mem = join(d, '记忆')
  mkdirSync(mem, { recursive: true })
  const now = Date.now()
  const 写 = (n, o) => writeFileSync(join(mem, n), JSON.stringify(o), 'utf8')
  写('状态.json', {
    困意: opt.困意 ?? 99, energy: 60, hoursAwake: opt.hoursAwake ?? 24,
    layers: { physical: 60, emotional: 50, cognitive: 60, existential: 50 },
    mood: { intensity: 0 },
  })
  写('自主.json', { state: opt.state ?? '待命', since: now - 30 * 60e3, nextAt: 0, doneAt: 0, note: '', place: '家' })
  写('睡眠.json', {
    sleeping: opt.sleeping ?? false, live: null, sleepSince: 0,
    awakeSince: now - (opt.hoursAwake ?? 24) * 3600e3,
    segments: opt.segments ?? [], records: [], 欠: 10,
  })
  写('睡醒.json', { sleeping: !!opt.sleeping, since: bj(now - (opt.hoursAwake ?? 24) * 3600e3).slice(0, 16) })
  写('资产.json', { 位置: '家', 钱: 500, 记录: [] })
  写('工作.json', { 班次: [], 在职: [] })
  写('物品.json', { items: [] })
  写('心气.md', '')
  if (opt.打盹) {
    写('打盹.json', {
      开始: bj(now - 20 * 60e3), 到: bj(now + 20 * 60e3), 分钟: 40,
      开始毫秒: now - 20 * 60e3, 到毫秒: now + 20 * 60e3, 为什么: '困了',
    })
  }
  return { 根: d, mem, now, 读: (n) => JSON.parse(readFileSync(join(mem, n), 'utf8')) }
}

const 环境 = (mem) => {
  const e = {
    ...process.env,
    QQ_AUTONOMY_MEM: mem, QQ_AUTONOMY_TOOLS: 工具,
    NAP_MEM: mem, ST_BASE: mem, QQ_SLEEP_MEM: mem, QQ_SLEEPY_MEM: mem,
    QQ_LOCK_DIR: join(mem, '.locks'), QQ_MEM: mem, LOG_PREFIX_OFF: '1',
  }
  delete e.NODE_OPTIONS
  return e
}

test('K1 连续短觉不丢账：13 分钟小觉 + 3.8 小时间隔，清醒时长仍在 20 小时以上', () => {
  const s = 造()
  try {
    const now = s.now
    // 一次 20 小时清醒前的短觉，然后 13 分钟小觉，再醒 3.8 小时
    const segs = [
      { start: bj(now - 24.5 * 3600e3), end: bj(now - 24 * 3600e3), hours: 0.5 },
      { start: bj(now - 24 * 3600e3), end: bj(now - 23.5 * 3600e3), hours: 0.5 },
    ]
    // 覆盖成真实形状：前段 end 早，末段 start 在 3.8 小时前、end 3.6 小时前
    segs.length = 0
    segs.push({ start: bj(now - 23.8 * 3600e3), end: bj(now - 23.3 * 3600e3), hours: 0.5 })
    segs.push({ start: bj(now - 4.0 * 3600e3), end: bj(now - 3.8 * 3600e3), hours: 0.2 })
    writeFileSync(join(s.mem, '睡眠.json'), JSON.stringify({
      sleeping: false, live: null, awakeSince: now - 4 * 3600e3, segments: segs, records: [], 欠: 10,
    }), 'utf8')
    const out = execFileSync(NODE, [join(工具, '困意.mjs'), '--json'], { encoding: 'utf8', timeout: 60000, env: 环境(s.mem) })
    const j = JSON.parse(out)
    assert.ok(j.awakeHours >= 20, `清醒时长被丢了：${j.awakeHours} 小时（应 ≥20）`)
    assert.ok(j.sleepy >= 80, `困意过低：${j.sleepy}`)
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('K2 困意过 95：抽中打瞌睡时是整觉（不是眯一会儿）', () => {
  const s = 造({ 困意: 99, 打盹: true, state: '打瞌睡' })
  try {
    // QUADRANT（批次563）：**不再清池硬推**。困意过线只是票多（约 14/47），
    // 抽不中她就去做别的 —— 这是主人的「倾向于」。所以这里跑到抽中为止，
    // 再检查**那一次**的类型。判据本身没变，变的是「必定抽中」这个旧前提。
    let 抽中 = ''
    for (let i = 0; i < 40 && !抽中; i += 1) {
      const out = execFileSync(NODE, [join(工具, '自主行动.mjs'), '--dry'], { encoding: 'utf8', timeout: 120000, env: 环境(s.mem) })
      if (/现在去「打瞌睡」/.test(out)) 抽中 = out
    }
    assert.ok(抽中, '跑了 40 次都没抽中打瞌睡（困意 99 应该有票）')
    assert.ok(/会去睡整觉/.test(抽中), '没升级成整觉：' + 抽中.slice(-200))
    assert.ok(!/会眯 \d+ 分钟/.test(抽中), '还在按打盹处理：' + 抽中.slice(-200))
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('K3 困意 80、体力 60：抽中打瞌睡时只打盹，不升级整觉', () => {
  const s = 造({ 困意: 80, 打盹: true, state: '打瞌睡' })
  try {
    let 抽中 = ''
    for (let i = 0; i < 40 && !抽中; i += 1) {
      const out = execFileSync(NODE, [join(工具, '自主行动.mjs'), '--dry'], { encoding: 'utf8', timeout: 120000, env: 环境(s.mem) })
      if (/现在去「打瞌睡」/.test(out)) 抽中 = out
    }
    assert.ok(抽中, '跑了 40 次都没抽中打瞌睡')
    assert.ok(!/会去睡整觉/.test(抽中), '困意 80 + 体力 60 不该升级整觉：' + 抽中.slice(-200))
    assert.ok(/会眯 \d+ 分钟/.test(抽中), '也不是打盹？：' + 抽中.slice(-200))
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('K4 熬夜线是 48 小时：困意 97、清醒 24 小时 → 不强制睡', () => {
  const s = 造({ 困意: 97, hoursAwake: 24 })
  try {
    const out = execFileSync(NODE, [join(工具, '自动作息.mjs'), '--dry'], { encoding: 'utf8', timeout: 120000, env: 环境(s.mem) })
    assert.ok(/还不用睡/.test(out), '24 小时不该触发强制睡（主人定的是 48）：' + out.slice(-300))
    assert.ok(!/熬穿了/.test(out), '误判成熬穿：' + out.slice(-300))
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})

test('K5 困意过线时不再被「连续两次同动作降权」掐死（票数 ≥1）', () => {
  const s = 造({ 困意: 99, 打盹: true, state: '打瞌睡' })
  try {
    // 自主.json 的 log 里连着两条打瞌睡 → push 的连续降权会归零
    const aut = s.读('自主.json')
    aut.log = [
      { at: bj(Date.now() - 90 * 60e3).slice(0, 16), state: '打瞌睡', note: '眯 24 分钟' },
      { at: bj(Date.now() - 30 * 60e3).slice(0, 16), state: '打瞌睡', note: '眯 24 分钟' },
    ]
    writeFileSync(join(s.mem, '自主.json'), JSON.stringify(aut), 'utf8')
    const out = execFileSync(NODE, [join(工具, '自主行动.mjs'), '--dry'], { encoding: 'utf8', timeout: 120000, env: 环境(s.mem) })
    const m = out.match(/打瞌睡票 (\d+)/)
    assert.ok(m && Number(m[1]) >= 1, '票数被降成 0（会落到发呆）：' + out.slice(-200))
  } finally { rmSync(s.根, { recursive: true, force: true }) }
})
