// t616b.CLI参数安全B.test.mjs —— 批次616B
//
// 审计 P0-4/P0-5/P0-6：
//   本子同步.mjs   --help / 未知参数：不建暂存区、不刷新、不调网盘
//   写日记.mjs     --help / 未知参数 / --day 缺值：不取锁、不调模型、不写盘
//   自动作息.mjs   --help / 未知参数；--dry 不写状态、不写该睡了.json、
//                  不推进 tickSleep、不调手账/状态推进/作息/走路/打盹
//
// 所有路径都在临时目录；子进程用桩；不触碰生产记忆。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具 = path.join(测试目录, '..')
const 本子脚本 = path.join(工具, '本子同步.mjs')
const 日记脚本 = path.join(工具, '写日记.mjs')
const 作息脚本 = path.join(工具, '自动作息.mjs')

const 根 = fs.mkdtempSync(path.join(os.tmpdir(), 't616b-'))
test.after(() => {
  try { fs.rmSync(根, { recursive: true, force: true }) } catch {}
})

const 临时 = (名) => fs.mkdtempSync(path.join(根, 名 + '-'))
const 北京 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 写文件(p, 内容) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 内容)
}

function 写JSON(p, 值) {
  写文件(p, JSON.stringify(值, null, 2) + '\n')
}

function 读文本(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return '' }
}

// 路径、内容、大小、mtime 一起比；只读分支不应让目录树有任何变化。
function 树快照(目录) {
  const 行 = []
  const 走 = (d, rel) => {
    const 项 = fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
    for (const ent of 项) {
      const p = path.join(d, ent.name)
      const r = rel ? rel + '/' + ent.name : ent.name
      if (ent.isDirectory()) {
        行.push('D ' + r)
        走(p, r)
      } else if (ent.isFile()) {
        const st = fs.statSync(p)
        const h = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
        行.push('F ' + r + ' ' + st.size + ' ' + Math.round(st.mtimeMs) + ' ' + h)
      } else {
        行.push('O ' + r)
      }
    }
  }
  if (fs.existsSync(目录)) 走(目录, '')
  return 行.join('\n')
}

function 跑(脚本, 参数, env = {}, timeout = 30_000) {
  const 环境 = { ...process.env, ...env }
  delete 环境.NODE_OPTIONS
  const r = spawnSync(process.execPath, [脚本, ...参数], {
    cwd: 工具,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    env: 环境,
  })
  return {
    code: r.status,
    out: r.stdout || '',
    err: r.stderr || '',
    signal: r.signal,
    error: r.error,
  }
}

// ---------- 本子同步 ----------

function 建本子夹(基) {
  const 记忆 = path.join(基, '记忆')
  const 日记 = path.join(基, '日记')
  const 群聊 = path.join(基, '群聊日志')
  const 暂存 = path.join(基, '共享', '网盘本子')
  fs.mkdirSync(记忆, { recursive: true })
  fs.mkdirSync(日记, { recursive: true })
  fs.mkdirSync(群聊, { recursive: true })
  写文件(path.join(记忆, '内心.md'), '# 内心\n')
  写文件(path.join(记忆, '手账-2026-11-17.md'), '# 手账\n')
  写文件(path.join(日记, '2026-11-17.md'), '# 日记\n')
  写文件(path.join(群聊, '群聊-2026-11-17.md'), '群里的话\n')
  return { 记忆, 日记, 群聊, 暂存 }
}

function 建本子桩(基) {
  const 目录 = path.join(基, 'tools-book')
  fs.mkdirSync(目录, { recursive: true })
  fs.writeFileSync(path.join(目录, '网盘.mjs'), [
    "import fs from 'node:fs'",
    "fs.appendFileSync(process.env.T616B_SENTINEL, '网盘 ' + process.argv.slice(2).join(' ') + '\\n')",
    "console.log('[sync] 测试上传')",
  ].join('\n'))
  return 目录
}

function 本子环境(基, 桩目录) {
  return {
    QQ_MEM: path.join(基, '记忆'),
    QQ_DIARY: path.join(基, '日记'),
    QQ_GROUP_LOG: path.join(基, '群聊日志'),
    QQ_BOOK_STAGE: path.join(基, '共享', '网盘本子'),
    QQ_BOOK_DIR: 'test-book',
    QQ_TOOLS: 桩目录,
    T616B_SENTINEL: path.join(基, 'upload-called.log'),
    QUIET_NOTE: '1',
  }
}

test('B1 本子同步 --help/-h 只读：不建暂存区、不刷新、不上传', () => {
  const 基 = 临时('book-help')
  const 夹 = 建本子夹(基)
  const 桩 = 建本子桩(基)
  const 前 = 树快照(基)
  for (const 参数 of ['--help', '-h']) {
    const r = 跑(本子脚本, [参数], 本子环境(基, 桩))
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /用法：/)
  }
  assert.equal(树快照(基), 前, '--help/-h 不该改动任何文件')
  assert.equal(fs.existsSync(夹.暂存), false, '--help 不该创建暂存区')
  assert.equal(fs.existsSync(path.join(基, 'upload-called.log')), false, '--help 不该调用网盘')
})

test('B2 本子同步 未知参数退出 2，零复制零上传', () => {
  const 基 = 临时('book-unknown')
  const 夹 = 建本子夹(基)
  const 桩 = 建本子桩(基)
  const 前 = 树快照(基)
  for (const 参数 of ['--bogus', '--dry']) {
    const r = 跑(本子脚本, [参数], 本子环境(基, 桩))
    assert.equal(r.code, 2, r.err)
    assert.match(r.err, new RegExp('未知参数：' + 参数))
  }
  assert.equal(树快照(基), 前, '未知参数不该改动任何文件')
  assert.equal(fs.existsSync(夹.暂存), false, '未知参数不该创建暂存区')
  assert.equal(fs.existsSync(path.join(基, 'upload-called.log')), false, '未知参数不该调用网盘')
})

test('B3 本子同步 裸跑仍按原路径刷新并上传', () => {
  const 基 = 临时('book-normal')
  const 夹 = 建本子夹(基)
  const 桩 = 建本子桩(基)
  const r = 跑(本子脚本, [], 本子环境(基, 桩))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /暂存区已刷新/)
  assert.match(r.out, /\[sync\] 测试上传/)
  assert.equal(fs.readFileSync(path.join(夹.暂存, '内心.md'), 'utf8'), '# 内心\n')
  assert.equal(fs.readFileSync(path.join(夹.暂存, '手账', '手账-2026-11-17.md'), 'utf8'), '# 手账\n')
  assert.equal(fs.readFileSync(path.join(夹.暂存, '日记', '2026-11-17.md'), 'utf8'), '# 日记\n')
  assert.equal(fs.readFileSync(path.join(夹.暂存, '群聊日志', '群聊-2026-11-17.md'), 'utf8'), '群里的话\n')
  const 上传 = 读文本(path.join(基, 'upload-called.log'))
  assert.match(上传, /--tree-sync/)
  assert.match(上传, /test-book/)
})

// ---------- 写日记 ----------

function 建日记夹(基) {
  const 记忆 = path.join(基, '记忆')
  const 日记 = path.join(基, '日记')
  const 桩 = path.join(基, 'tools-diary')
  fs.mkdirSync(记忆, { recursive: true })
  fs.mkdirSync(日记, { recursive: true })
  fs.mkdirSync(桩, { recursive: true })
  return { 记忆, 日记, 桩 }
}

function 日记环境(基, 桩) {
  return {
    QQ_MEM: path.join(基, '记忆'),
    QQ_DIARY: path.join(基, '日记'),
    QQ_TOOLS: 桩,
    T616B_SENTINEL: path.join(基, 'model-called.log'),
    QUIET_NOTE: '1',
  }
}

test('B4 写日记 --help/-h 在锁和模型之前退出，零写入', () => {
  const 基 = 临时('diary-help')
  const 夹 = 建日记夹(基)
  const 前 = 树快照(基)
  for (const 参数 of ['--help', '-h']) {
    const r = 跑(日记脚本, [参数], 日记环境(基, 夹.桩))
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /用法：/)
  }
  assert.equal(树快照(基), 前, '--help/-h 不该创建锁、日志或日记')
  assert.equal(fs.existsSync(path.join(夹.记忆, '.写日记.lock')), false)
  assert.equal(fs.existsSync(path.join(夹.记忆, '日志', '写日记.log')), false)
})

test('B5 写日记 未知参数退出 2，零写入', () => {
  const 基 = 临时('diary-unknown')
  const 夹 = 建日记夹(基)
  const 前 = 树快照(基)
  for (const 参数 of [['--bogus'], ['--dryy'], ['--help=x']]) {
    const r = 跑(日记脚本, 参数, 日记环境(基, 夹.桩))
    assert.equal(r.code, 2, r.err)
    assert.match(r.err, /未知参数：/, JSON.stringify(参数))
  }
  assert.equal(树快照(基), 前, '未知参数不该写盘')
})

test('B6 写日记 --day 缺值退出 2，零写入', () => {
  const 基 = 临时('diary-missing')
  const 夹 = 建日记夹(基)
  const 前 = 树快照(基)
  for (const 参数 of [['--day'], ['--day', '--force'], ['--day', '']]) {
    const r = 跑(日记脚本, 参数, 日记环境(基, 夹.桩))
    assert.equal(r.code, 2, JSON.stringify(参数))
    assert.match(r.err, /参数缺少值：--day/, JSON.stringify(参数))
  }
  assert.equal(树快照(基), 前, '--day 缺值不该写盘')
})

test('B7 写日记 --day 格式不对也在写盘前退出 2', () => {
  const 基 = 临时('diary-bad-day')
  const 夹 = 建日记夹(基)
  const 前 = 树快照(基)
  const r = 跑(日记脚本, ['--day', '2026-1-1'], 日记环境(基, 夹.桩))
  assert.equal(r.code, 2)
  assert.match(r.err, /--day 要写成 YYYY-MM-DD/)
  assert.equal(树快照(基), 前)
})

// ---------- 自动作息 ----------

function 建作息夹(基, opt = {}) {
  const 记忆 = path.join(基, '记忆')
  fs.mkdirSync(记忆, { recursive: true })
  const now = Date.now()
  const sleeping = !!opt.sleeping
  const 睡小时 = opt.睡小时 ?? 1
  const 睡始 = now - 睡小时 * 3600e3
  const live = sleeping
    ? { phase: 'N2', cycle: 1, deep_min: 0, light_min: 0, rem_min: 0, start: 北京(睡始), startMs: 睡始, lastTick: now - 5 * 60e3 }
    : null
  写JSON(path.join(记忆, '状态.json'), {
    困意: opt.困意 ?? 50,
    energy: opt.energy ?? 60,
    hoursAwake: opt.hoursAwake ?? 20,
    mood: { intensity: 0 },
    layers: { physical: 60, emotional: 50, cognitive: 60, existential: 50 },
  })
  写JSON(path.join(记忆, '睡眠.json'), {
    sleeping,
    live,
    sleepSince: sleeping ? 睡始 : 0,
    awakeSince: now - (opt.hoursAwake ?? 20) * 3600e3,
    segments: sleeping ? [{ start: 北京(睡始), phases: [] }] : [],
    records: [],
    欠: 0,
  })
  写JSON(path.join(记忆, '睡醒.json'), {
    sleeping,
    since: 北京(now - (opt.flagMinutes ?? 20) * 60e3),
  })
  写JSON(path.join(记忆, '资产.json'), { 位置: opt.位置 ?? '家' })
  写JSON(path.join(记忆, '自主.json'), { state: '待命' })
  return { 记忆, now }
}

function 建作息桩(基, opt = {}) {
  const 目录 = path.join(基, 'tools-sleep')
  fs.mkdirSync(目录, { recursive: true })
  const sleepy = opt.sleepy ?? 99
  const awake = opt.awake ?? 20
  fs.writeFileSync(path.join(目录, '困意.mjs'), [
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    `const sleepy = ${JSON.stringify(sleepy)}`,
    `const awake = ${JSON.stringify(awake)}`,
    'if (process.env.T616B_SLEEPY_WRITE === "1" && process.env.QQ_SLEEPY_MEM) {',
    '  fs.mkdirSync(process.env.QQ_SLEEPY_MEM, { recursive: true })',
    '  fs.writeFileSync(path.join(process.env.QQ_SLEEPY_MEM, "困意写入.txt"), "stub")',
    '}',
    'console.log(`困意 ${sleepy}/100（清醒 ${awake} 小时）`)',
  ].join('\n'))
  for (const 名 of ['作息', '状态推进', '手账', '走路', '打盹']) {
    fs.writeFileSync(path.join(目录, 名 + '.mjs'), [
      "import fs from 'node:fs'",
      `fs.appendFileSync(process.env.T616B_SENTINEL, ${JSON.stringify(名)} + ' ' + process.argv.slice(2).join(' ') + '\\n')`,
      `console.log(${JSON.stringify(名 + ' 不应被调用')})`,
    ].join('\n'))
  }
  写文件(path.join(目录, '参数.json'), '{}\n')
  return 目录
}

function 作息环境(基, 桩) {
  return {
    ST_BASE: path.join(基, '记忆'),
    TOOLS_DIR: 桩,
    NODE_BIN: process.execPath,
    QQ_LOCK_DIR: path.join(基, '.locks'),
    QQ_AUTONOMY_MEM: path.join(基, '记忆'),
    HUNGER_MEM: path.join(基, '记忆'),
    QQ_SLEEPY_MEM: path.join(基, '记忆'),
    FISH_SANDBOX_DIR: path.join(基, '记忆'),
    T616B_SENTINEL: path.join(基, 'side-effects.log'),
    QUIET_NOTE: '1',
    LOG_PREFIX_OFF: '1',
  }
}

test('B8 自动作息 --help/-h 只读：不读困意、不写状态、不调子脚本', () => {
  const 基 = 临时('sleep-help')
  const 夹 = 建作息夹(基)
  const 桩 = 建作息桩(基)
  const 前 = 树快照(基)
  for (const 参数 of ['--help', '-h']) {
    const r = 跑(作息脚本, [参数], 作息环境(基, 桩))
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /用法：/)
  }
  assert.equal(树快照(基), 前, '--help/-h 不该改动任何文件')
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
  assert.equal(fs.existsSync(path.join(夹.记忆, '该睡了.json')), false)
})

test('B9 自动作息 未知参数退出 2，零写入零子进程', () => {
  const 基 = 临时('sleep-unknown')
  const 夹 = 建作息夹(基)
  const 桩 = 建作息桩(基)
  const 前 = 树快照(基)
  for (const 参数 of ['--dryy', '--dry=1']) {
    const r = 跑(作息脚本, [参数], 作息环境(基, 桩))
    assert.equal(r.code, 2, r.err)
    assert.match(r.err, new RegExp('未知参数：' + 参数.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  }
  assert.equal(树快照(基), 前, '未知参数不该改动任何文件')
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
  assert.equal(fs.existsSync(path.join(夹.记忆, '该睡了.json')), false)
})

test('B10 自动作息 --dry 醒着：不写该睡了.json，也不让困意写进真档', () => {
  const 基 = 临时('sleep-dry-awake')
  const 夹 = 建作息夹(基, { sleeping: false, hoursAwake: 20, 困意: 99 })
  const 桩 = 建作息桩(基, { sleepy: 99, awake: 20 })
  const 前 = 树快照(基)
  const r = 跑(作息脚本, ['--dry'], { ...作息环境(基, 桩), T616B_SLEEPY_WRITE: '1' }, 60_000)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /困意 99\/100/)
  assert.match(r.out, /只是提醒/)
  assert.match(r.out, /dry：没写 该睡了\.json/)
  assert.equal(fs.existsSync(path.join(夹.记忆, '该睡了.json')), false)
  assert.equal(fs.existsSync(path.join(夹.记忆, '困意写入.txt')), false, 'dry 不该让困意写进真档')
  assert.equal(树快照(基), 前, 'dry 醒着分支不该改动任何文件')
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})

test('B11 自动作息 --dry 睡着 1 小时：不推进 tickSleep', () => {
  const 基 = 临时('sleep-dry-tick')
  const 夹 = 建作息夹(基, { sleeping: true, 睡小时: 1, 困意: 50 })
  const 桩 = 建作息桩(基, { sleepy: 50, awake: 0 })
  const 前 = 树快照(基)
  const r = 跑(作息脚本, ['--dry'], 作息环境(基, 桩), 60_000)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /dry：不推进睡眠阶段/)
  assert.match(r.out, /继续睡/)
  assert.equal(树快照(基), 前, 'dry 不该推进阶段或写状态')
  assert.equal(fs.existsSync(path.join(夹.记忆, '该睡了.json')), false)
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})

test('B12 自动作息 --dry 自然醒：不结算、不写刚醒、不调手账/状态推进', () => {
  const 基 = 临时('sleep-dry-wake')
  const 夹 = 建作息夹(基, { sleeping: true, 睡小时: 8, 困意: 50 })
  const 桩 = 建作息桩(基, { sleepy: 50, awake: 0 })
  const 前 = 树快照(基)
  const r = 跑(作息脚本, ['--dry'], 作息环境(基, 桩), 60_000)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /该醒了/)
  assert.match(r.out, /dry：没真醒/)
  assert.equal(树快照(基), 前, 'dry 醒来分支不该结算睡眠或写状态')
  assert.equal(fs.existsSync(path.join(夹.记忆, '刚醒.json')), false)
  assert.equal(fs.existsSync(path.join(夹.记忆, '日志', '醒来.log')), false)
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})

test('B13 自动作息 非 dry 短睡仍推进阶段（夹具阳性对照）', () => {
  const 基 = 临时('sleep-normal-tick')
  const 夹 = 建作息夹(基, { sleeping: true, 睡小时: 1, 困意: 50 })
  const 桩 = 建作息桩(基, { sleepy: 50, awake: 0 })
  const 前状态 = 读文本(path.join(夹.记忆, '状态.json'))
  const 前睡眠 = 读文本(path.join(夹.记忆, '睡眠.json'))
  const r = 跑(作息脚本, [], 作息环境(基, 桩), 60_000)
  assert.equal(r.code, 0, r.err)
  assert.notEqual(读文本(path.join(夹.记忆, '状态.json')), 前状态, '非 dry 应推进状态')
  assert.notEqual(读文本(path.join(夹.记忆, '睡眠.json')), 前睡眠, '非 dry 应推进睡眠阶段')
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})

test('B14 自动作息 非 dry 醒着仍写该睡了.json（裸跑行为不变）', () => {
  const 基 = 临时('sleep-normal-remind')
  const 夹 = 建作息夹(基, { sleeping: false, hoursAwake: 20, 困意: 99 })
  const 桩 = 建作息桩(基, { sleepy: 99, awake: 20 })
  const r = 跑(作息脚本, [], 作息环境(基, 桩), 60_000)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /只是提醒/)
  assert.equal(fs.existsSync(path.join(夹.记忆, '该睡了.json')), true, '裸跑应保留提醒文件')
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})

test('B15 自动作息 --dry 体力见底：不调打盹/作息，不写状态', () => {
  const 基 = 临时('sleep-dry-force')
  const 夹 = 建作息夹(基, { sleeping: false, hoursAwake: 10, 困意: 50, energy: 4, flagMinutes: 60 })
  const 桩 = 建作息桩(基, { sleepy: 50, awake: 10 })
  const 前 = 树快照(基)
  const r = 跑(作息脚本, ['--dry'], 作息环境(基, 桩), 60_000)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /该睡了/)
  assert.match(r.out, /dry：没真睡/)
  assert.equal(树快照(基), 前, 'dry 强制睡分支不该写状态或启动子脚本')
  assert.equal(fs.existsSync(path.join(夹.记忆, '该睡了.json')), false)
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})

test('B16 自动作息 --dry 人在外面：不调走路，也不原地开睡', () => {
  const 基 = 临时('sleep-dry-away')
  const 夹 = 建作息夹(基, { sleeping: false, hoursAwake: 10, 困意: 50, energy: 4, flagMinutes: 60, 位置: '便利店' })
  const 桩 = 建作息桩(基, { sleepy: 50, awake: 10 })
  const 前 = 树快照(基)
  const r = 跑(作息脚本, ['--dry'], 作息环境(基, 桩), 60_000)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /先往家走/)
  assert.match(r.out, /dry：没真走/)
  assert.equal(树快照(基), 前, 'dry 不该调走路或写睡眠状态')
  assert.equal(fs.existsSync(path.join(夹.记忆, '该睡了.json')), false)
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})

test('B17 自动作息 --dry 睡超 24 小时：不调用 endSleep 结账', () => {
  const 基 = 临时('sleep-dry-long')
  const 夹 = 建作息夹(基, { sleeping: true, 睡小时: 25, 困意: 50 })
  const 桩 = 建作息桩(基, { sleepy: 50, awake: 0 })
  const 前 = 树快照(基)
  const r = 跑(作息脚本, ['--dry'], 作息环境(基, 桩), 60_000)
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /睡超过 24 小时，结账/)
  assert.equal(树快照(基), 前, 'dry 不该调用 endSleep 结账')
  assert.equal(fs.existsSync(path.join(基, 'side-effects.log')), false)
})
