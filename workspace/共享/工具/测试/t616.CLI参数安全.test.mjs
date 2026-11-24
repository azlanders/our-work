// t616.CLI参数安全.test.mjs —— 批次616
//
// 三个入口的帮助/拼错/缺值都必须在读状态、取锁、联网、发送之前退出。
// 所有子进程都指向临时目录；目录卫生还会把扫描根收窄到临时目录。
//
// 覆盖：
//   投递留言.mjs   --help / 未知参数 / --谁 缺值：不发私聊、不写留言状态
//   目录卫生.mjs   --help / 未知参数 / --dry：不建目录、不移动/归档/删除
//   同步QQ状态.mjs --help / 未知参数 / --设 缺值：不调 set_diy_online_status、不写 qq状态.json
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具 = path.join(测试目录, '..')
const 根 = fs.mkdtempSync(path.join(os.tmpdir(), 't616-'))
process.env.QQ_LOCK_DIR = path.join(根, '.locks')

test.after(() => {
  try { fs.rmSync(根, { recursive: true, force: true }) } catch {}
})

const 北京戳 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 临时 = (名) => fs.mkdtempSync(path.join(根, 名 + '-'))

function 写文件(p, 内容, mtimeMs) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, 内容)
  if (mtimeMs) fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
}

function 写JSON(p, 值, mtimeMs) {
  写文件(p, JSON.stringify(值, null, 2) + '\n', mtimeMs)
}

function 读JSON(p, 兜底 = {}) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return 兜底 }
}

function 跑(脚本, 参数, env = {}, timeout = 30_000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [脚本, ...参数], {
      cwd: 工具,
      env: { ...process.env, ...env },
      windowsHide: true,
    })
    let out = '', err = ''
    p.stdout.setEncoding('utf8')
    p.stderr.setEncoding('utf8')
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    const timer = setTimeout(() => { try { p.kill() } catch {} }, timeout)
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err })
    })
  })
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

async function 假协议端() {
  const 收到 = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let j = {}
      try { j = JSON.parse(body || '{}') } catch {}
      收到.push({ url: String(req.url || ''), body: j })
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ retcode: 0, data: { message_id: 9000 + 收到.length } }))
    })
  })
  await new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => resolve())
  })
  return {
    srv,
    收到,
    口: srv.address().port,
    关: () => new Promise((resolve) => srv.close(resolve)),
  }
}

const 正文 = (项) => {
  const 段 = 项?.body?.params?.message ?? 项?.body?.message
  if (Array.isArray(段)) return 段.map((x) => String(x?.data?.text ?? '')).join('')
  return String(段 ?? '')
}

function 投递环境(基, 配置, 额外 = {}) {
  return {
    MSG_BASE: 基,
    MSG_CFG: 配置,
    MSG_LOG: path.join(基, '投递.log'),
    QQ_BRIDGE_CFG: 配置,
    DSH_LIB_SENSITIVE: path.join(基, 'missing-sensitive.js'),
    QQ_LOCK_DIR: path.join(基, '.locks'),
    QUIET_NOTE: '1',
    ...额外,
  }
}

function 建留言(基, 话 = '测试留言') {
  const 记忆 = path.join(基, '记忆')
  const 留言 = path.join(记忆, '留言.json')
  写JSON(留言, { items: [{ id: 't616', at: 北京戳(), kind: '测试', 话 }] })
  return { 记忆, 留言 }
}

function 建协议配置(基, 口) {
  const p = path.join(基, 'qq.json')
  写JSON(p, { onebotHttp: 'http://127.0.0.1:' + 口, token: '', peerUin: '{{OWNER_UIN}}' })
  return p
}

function 卫生环境(基, 额外 = {}) {
  return {
    DIRHY_BASE: 基,
    DIRHY_BAK2: path.join(基, 'bak2'),
    DIRHY_SCAN_ROOTS: [基, path.join(基, '记忆')].join(path.delimiter),
    QUIET_NOTE: '1',
    ...额外,
  }
}

function 建卫生夹具(基, { 建日志目录 = true } = {}) {
  const 记忆 = path.join(基, '记忆')
  fs.mkdirSync(记忆, { recursive: true })
  const 旧 = Date.now() - 10 * 86400e3
  写文件(path.join(记忆, '手账-2020-01-01.md'), '# 旧手账\n', 旧)
  写文件(path.join(记忆, '旧.log'), 'old log\n', 旧)
  写文件(path.join(记忆, '坏.bak'), 'backup\n', 旧)

  const 视频 = path.join(记忆, '视频画面')
  fs.mkdirSync(视频, { recursive: true })
  写文件(path.join(视频, '旧.mp4'), 'video', Date.now() - 4 * 86400e3)

  const 截图 = path.join(基, '屏幕', 'history')
  fs.mkdirSync(截图, { recursive: true })
  for (let i = 0; i < 51; i++) {
    写文件(path.join(截图, 'shot-' + String(i).padStart(2, '0') + '.png'), 'shot-' + i, Date.now() - i * 1000)
  }

  const 下载 = path.join(基, '下载')
  fs.mkdirSync(下载, { recursive: true })
  写文件(path.join(下载, '旧.tmp'), 'tmp', Date.now() - 3 * 86400e3)

  if (建日志目录) {
    const 日志 = path.join(记忆, '日志')
    fs.mkdirSync(日志, { recursive: true })
    const 行 = []
    for (let i = 0; i < 6000; i++) 行.push('line ' + i + ' ' + 'x'.repeat(90))
    写文件(path.join(日志, '大.log'), 行.join('\n'), 旧)
  }

  return {
    记忆,
    日志: path.join(记忆, '日志'),
    归档: path.join(记忆, '归档'),
    bak2: path.join(基, 'bak2'),
  }
}

function 建状态(基) {
  const 记忆 = path.join(基, '记忆')
  写JSON(path.join(记忆, 'qq状态.json'), {
    wording: '旧状态',
    at: '2026-11-17 04:00',
    source: 'auto',
    manualUntil: 0,
    位: '家',
    在途: false,
  })
  写JSON(path.join(记忆, '资产.json'), { 位置: '家' })
  写JSON(path.join(记忆, '睡眠.json'), { live: null })
  写JSON(path.join(记忆, '睡醒.json'), { sleeping: false })
  写JSON(path.join(记忆, '自主.json'), { state: '待命' })
  return { 记忆, 状态: path.join(记忆, 'qq状态.json') }
}

function 状态环境(基, 配置, 口, 额外 = {}) {
  return {
    STATUS_BASE: 基,
    STATUS_CFG: 配置,
    STATUS_OMNI_CFG: path.join(基, 'missing-omni.json'),
    ONEBOT_API: 'http://127.0.0.1:' + 口,
    QQ_LOCK_DIR: path.join(基, '.locks'),
    QUIET_NOTE: '1',
    ...额外,
  }
}

// ---------- 目录卫生 ----------

test('H1 目录卫生 --help 不建目录、不移动、不归档、不删除', async () => {
  const 基 = 临时('hyg-help')
  const 夹 = 建卫生夹具(基, { 建日志目录: false })
  const 前 = 树快照(基)
  const r = await 跑(path.join(工具, '目录卫生.mjs'), ['--help'], 卫生环境(基))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /用法：/)
  assert.equal(树快照(基), 前)
  assert.equal(fs.existsSync(夹.日志), false)
  assert.equal(fs.existsSync(夹.归档), false)
  assert.equal(fs.existsSync(夹.bak2), false)
})

test('H2 目录卫生 未知参数退出 2，原目录树一字节不变', async () => {
  const 基 = 临时('hyg-unknown')
  const 夹 = 建卫生夹具(基, { 建日志目录: false })
  const 前 = 树快照(基)
  const r = await 跑(path.join(工具, '目录卫生.mjs'), ['--dryy'], 卫生环境(基))
  assert.equal(r.code, 2)
  assert.match(r.err, /未知参数：--dryy/)
  assert.equal(树快照(基), 前)
  assert.equal(fs.existsSync(夹.归档), false)
  assert.equal(fs.existsSync(夹.bak2), false)
})

test('H3 目录卫生 --dry 有日志目录时零写入', async () => {
  const 基 = 临时('hyg-dry')
  const 夹 = 建卫生夹具(基, { 建日志目录: true })
  const 前 = 树快照(基)
  const r = await 跑(path.join(工具, '目录卫生.mjs'), ['--dry'], 卫生环境(基))
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /dry-run/)
  assert.match(r.out, /归位\/归档 [1-9]/)
  assert.match(r.out, /裁剪日志 [1-9]/)
  assert.match(r.out, /清理过期缓存 [1-9]/)
  assert.equal(树快照(基), 前)
  assert.equal(fs.existsSync(夹.归档), false)
  assert.equal(fs.existsSync(夹.bak2), false)
})

test('H4 目录卫生 --dry 不创建缺失的日志/归档/bak2 目录', async () => {
  const 基 = 临时('hyg-dry-nodir')
  const 夹 = 建卫生夹具(基, { 建日志目录: false })
  const 前 = 树快照(基)
  const r = await 跑(path.join(工具, '目录卫生.mjs'), ['--dry'], 卫生环境(基))
  assert.equal(r.code, 0, r.err)
  assert.equal(树快照(基), 前)
  assert.equal(fs.existsSync(夹.日志), false, '--dry 不该创建 记忆/日志')
  assert.equal(fs.existsSync(夹.归档), false, '--dry 不该创建 记忆/归档')
  assert.equal(fs.existsSync(夹.bak2), false, '--dry 不该创建 bak2')
})

// ---------- 投递留言 ----------

test('M1 投递留言 --help 有积压也不发、不写留言状态', async () => {
  const 基 = 临时('msg-help')
  const 夹 = 建留言(基, '这条不该被发出去')
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    const r = await 跑(path.join(工具, '投递留言.mjs'), ['--help'], 投递环境(基, 配置))
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /用法：/)
    assert.equal(端.收到.length, 0, '--help 不能发私聊')
    assert.equal(树快照(基), 前)
    assert.equal(fs.existsSync(path.join(夹.记忆, '我说过.jsonl')), false)
    assert.equal(fs.existsSync(path.join(基, '投递.log')), false)
  } finally {
    await 端.关()
  }
})

test('M2 投递留言 未知参数退出 2，零发送零写入', async () => {
  const 基 = 临时('msg-unknown')
  const 夹 = 建留言(基, '拼错也不该发')
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    const r = await 跑(path.join(工具, '投递留言.mjs'), ['--hep'], 投递环境(基, 配置))
    assert.equal(r.code, 2)
    assert.match(r.err, /未知参数：--hep/)
    assert.equal(端.收到.length, 0)
    assert.equal(树快照(基), 前)
    assert.equal(fs.existsSync(path.join(夹.记忆, '我说过.jsonl')), false)
  } finally {
    await 端.关()
  }
})

test('M3 投递留言 --谁 缺值退出 2，零发送零写入', async () => {
  const 基 = 临时('msg-missing')
  const 夹 = 建留言(基, '缺值也不该发')
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    for (const 参数 of [['--谁'], ['--谁', '--force'], ['--谁', '   ']]) {
      const r = await 跑(path.join(工具, '投递留言.mjs'), 参数, 投递环境(基, 配置))
      assert.equal(r.code, 2, JSON.stringify(参数))
      assert.match(r.err, /参数缺少值：--谁/, JSON.stringify(参数))
      assert.equal(端.收到.length, 0, JSON.stringify(参数))
      assert.equal(树快照(基), 前, JSON.stringify(参数))
    }
    assert.equal(fs.existsSync(path.join(夹.记忆, '我说过.jsonl')), false)
  } finally {
    await 端.关()
  }
})

test('M4 投递留言 --看 仍只读，正常 --force 仍会发送', async () => {
  const 基 = 临时('msg-normal')
  const 夹 = 建留言(基, '正常发送回归')
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    const 看 = await 跑(path.join(工具, '投递留言.mjs'), ['--看'], 投递环境(基, 配置))
    assert.equal(看.code, 0, 看.err)
    assert.match(看.out, /待送 1 条/)
    assert.match(看.out, /正常发送回归/)
    assert.equal(端.收到.length, 0)
    assert.equal(树快照(基), 前)

    const 发 = await 跑(path.join(工具, '投递留言.mjs'), ['--force'], 投递环境(基, 配置))
    assert.equal(发.code, 0, 发.err)
    assert.equal(端.收到.length, 1)
    assert.match(正文(端.收到[0]), /正常发送回归/)
    const 留言 = 读JSON(夹.留言, { items: [] })
    assert.equal(留言.items?.[0]?.寄?.ok, true)
    assert.equal(fs.existsSync(path.join(夹.记忆, '我说过.jsonl')), true)
  } finally {
    await 端.关()
  }
})

// ---------- 同步QQ状态 ----------

test('Q1 同步QQ状态 --help 不调接口、不写状态文件', async () => {
  const 基 = 临时('qq-help')
  const 夹 = 建状态(基)
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    const r = await 跑(path.join(工具, '同步QQ状态.mjs'), ['--help'], 状态环境(基, 配置, 端.口))
    assert.equal(r.code, 0, r.err)
    assert.match(r.out, /用法：/)
    assert.equal(端.收到.length, 0, '--help 不能调 set_diy_online_status')
    assert.equal(树快照(基), 前)
  } finally {
    await 端.关()
  }
})

test('Q2 同步QQ状态 未知参数退出 2，零请求零写入', async () => {
  const 基 = 临时('qq-unknown')
  const 夹 = 建状态(基)
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    const r = await 跑(path.join(工具, '同步QQ状态.mjs'), ['--hep'], 状态环境(基, 配置, 端.口))
    assert.equal(r.code, 2)
    assert.match(r.err, /未知参数：--hep/)
    assert.equal(端.收到.length, 0)
    assert.equal(树快照(基), 前)
  } finally {
    await 端.关()
  }
})

test('Q3 同步QQ状态 --设 缺值退出 2，零请求零写入', async () => {
  const 基 = 临时('qq-missing')
  const 夹 = 建状态(基)
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    for (const 参数 of [['--设'], ['--设', '--清'], ['--设', '   ']]) {
      const r = await 跑(path.join(工具, '同步QQ状态.mjs'), 参数, 状态环境(基, 配置, 端.口))
      assert.equal(r.code, 2, JSON.stringify(参数))
      assert.match(r.err, /参数缺少值：--设/, JSON.stringify(参数))
      assert.equal(端.收到.length, 0, JSON.stringify(参数))
      assert.equal(树快照(基), 前, JSON.stringify(参数))
    }
  } finally {
    await 端.关()
  }
})

test('Q4 同步QQ状态 --看 仍只读，--设 正常路径仍会写状态', async () => {
  const 基 = 临时('qq-normal')
  const 夹 = 建状态(基)
  const 端 = await 假协议端()
  try {
    const 配置 = 建协议配置(基, 端.口)
    const 前 = 树快照(基)
    const 看 = await 跑(path.join(工具, '同步QQ状态.mjs'), ['--看'], 状态环境(基, 配置, 端.口))
    assert.equal(看.code, 0, 看.err)
    assert.match(看.out, /会写成：/)
    assert.equal(端.收到.length, 0)
    assert.equal(树快照(基), 前)

    const 设 = await 跑(path.join(工具, '同步QQ状态.mjs'), ['--设', '在窗边发呆'], 状态环境(基, 配置, 端.口))
    assert.equal(设.code, 0, 设.err)
    assert.equal(端.收到.length, 1)
    assert.match(端.收到[0].url, /set_diy_online_status/)
    assert.equal(端.收到[0].body.wording, '在窗边发呆')
    const 状态 = 读JSON(夹.状态, {})
    assert.equal(状态.wording, '在窗边发呆')
    assert.equal(状态.source, 'self')
  } finally {
    await 端.关()
  }
})
