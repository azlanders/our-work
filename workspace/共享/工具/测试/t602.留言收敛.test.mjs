// t602.留言收敛.test.mjs —— 批次602：留言链路不再替她说话、多个写方不互相覆盖、投递不重发
//
// 覆盖：
//   M1 早间简报只写事实（md + 手账），不再产生 谁:"她" 的留言
//   M2 日报只写系统记录（不投递），同一天重跑不重复
//   M3 两个并发生产者各写一条，锁内重读后两条都在
//   M4 投递器只送该送的：系统记录/fresh 租约跳过；发送期间别人新增的留言不丢
//   M5 过期租约（>2 分钟）允许重试
//   M6 两个投递器同时跑，同一条只发一次
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import http from 'node:http'

const 测试目录 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(测试目录, '..')
const 根 = mkdtempSync(join(tmpdir(), 't602-'))

// _锁.mjs 在模块加载时读 QQ_LOCK_DIR，所以必须在动态 import 之前设好，
// 绝不能让它落到生产 {{BOT_ROOT}}/记忆/.locks。
process.env.QQ_LOCK_DIR = join(根, '.locks')
const { 改档 } = await import(pathToFileURL(join(工具, '_底层.mjs')).href)

const 北京戳 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 读 = (p, d = {}) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const 写 = (p, v) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(v, null, 2)) }

function 沙盒(名) {
  const 基 = join(根, 名)
  const 记忆 = join(基, '记忆')
  mkdirSync(记忆, { recursive: true })
  return { 基, 记忆, 留言: join(记忆, '留言.json') }
}

function 跑(脚本, 参数, env, timeout = 20000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [脚本, ...参数], {
      cwd: 工具,
      env: { ...process.env, ...env },
    })
    let out = '', err = ''
    p.stdout.on('data', (d) => { out += d })
    p.stderr.on('data', (d) => { err += d })
    const t = setTimeout(() => { try { p.kill() } catch {} }, timeout)
    p.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
}

async function 假协议端(处理) {
  const 收到 = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', async () => {
      let j = {}
      try { j = JSON.parse(body || '{}') } catch {}
      收到.push(j)
      if (处理) await 处理(j, 收到.length)
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ retcode: 0, data: { message_id: 9000 + 收到.length } }))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { srv, 收到, 口: srv.address().port }
}

function 配置(口, 基) {
  const p = join(基, 'qq.json')
  写(p, { onebotHttp: 'http://127.0.0.1:' + 口, token: '', peerUin: '{{OWNER_UIN}}' })
  return p
}

// 批次608 起统一走发送口：3001 风格是 {action,params}，message 是分段数组。
// 这个测试只关心正文，不把旧的内联 payload 当成协议契约。
const 正文 = (j) => {
  const 段 = j?.params?.message ?? j?.message
  if (Array.isArray(段)) return 段.map((x) => String(x?.data?.text ?? '')).join('')
  return String(段 ?? '')
}

test('M1 早间简报只写事实，不再产生「她」的留言', async () => {
  const s = 沙盒('m1')
  写(join(s.记忆, '状态.json'), { energy: 62, layers: { physical: 61, emotional: 55, cognitive: 70, existential: 50 }, 困意: 44 })
  写(join(s.记忆, '资产.json'), { 钱: 559 })
  写(join(s.记忆, '睡眠.json'), { segments: [{ start: '2026-11-17 01:10', end: '2026-11-17 07:40' }] })
  写(join(s.记忆, '计划.json'), { days: { '2026-11-17': { goals: [{ id: '看点书' }] } } })
  const r = await 跑(join(工具, '早间简报.mjs'), ['--tick'], {
    BRIEF_BASE: s.基,
    BRIEF_NOW_MS: String(Date.parse('2026-11-17T08:00:00+08:00')),
  })
  assert.equal(r.code, 0, r.err)
  assert.match(r.out, /早间事实已记录/)
  const md = readFileSync(join(s.记忆, '早间简报-2026-11-17.md'), 'utf8')
  assert.match(md, /昨晚睡眠：6\.5 小时/)
  assert.doesNotMatch(md, /她说的话：/)
  const 账 = readFileSync(join(s.记忆, '手账-2026-11-17.md'), 'utf8')
  assert.match(账, /## 早间（系统记录）/)
  // 不再写留言；即使有，也不允许 谁:"她"
  const 留 = existsSync(s.留言) ? 读(s.留言, { items: [] }) : { items: [] }
  assert.equal((留.items || []).filter((x) => x && x.谁 === '她').length, 0)
})

test('M2 日报只写系统记录，不投递，同一天重跑不重复', async () => {
  const s = 沙盒('m2')
  写(join(s.记忆, '资产.json'), { 记录: [] })
  写(join(s.记忆, '活动台账.json'), { log: [] })
  写(join(s.记忆, '计划.json'), { days: { '2026-11-17': { goals: [{ id: '看点书' }], done: [] } } })
  写(join(s.记忆, '状态.json'), { mood: { intensity: -0.2 } })
  const env = { QQ_AUTONOMY_MEM: s.记忆, DAILY_NOW_MS: String(Date.parse('2026-11-17T21:00:00+08:00')) }
  const r1 = await 跑(join(工具, '日报.mjs'), ['--tick'], env)
  assert.equal(r1.code, 0, r1.err)
  const r2 = await 跑(join(工具, '日报.mjs'), ['--tick'], env)
  assert.equal(r2.code, 0, r2.err)
  const 留 = 读(s.留言, { items: [] })
  const 报 = (留.items || []).filter((x) => x && x.kind === '日报')
  assert.equal(报.length, 1, '同一天只能有一条日报记录')
  assert.equal(报[0].谁, '系统')
  assert.equal(报[0].不投递, true)
  assert.match(报[0].话, /^【记录】/)
  assert.doesNotMatch(报[0].话, /就这样吧|没什么大事/)
  const 手 = readFileSync(join(s.记忆, '手账-2026-11-17.md'), 'utf8')
  assert.equal((手.match(/## 晚上（系统记录）/g) || []).length, 1)
})

test('M3 两个并发生产者各写一条，锁内重读后两条都在', async () => {
  const s = 沙盒('m3')
  const lib = pathToFileURL(join(工具, '_底层.mjs')).href
  const 代码 = `const {改档}=await import(process.env.LIB); 改档(process.env.P,(nb)=>{ if(!Array.isArray(nb.items))nb.items=[]; nb.items.push({id:process.env.ID,at:'2026-11-17 22:00',kind:'测试',话:process.env.ID}) },{items:[]})`
  const 起 = (id) => new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', 代码], {
      cwd: 工具,
      env: { ...process.env, LIB: lib, P: s.留言, ID: id, QQ_LOCK_DIR: join(s.记忆, '.locks') },
    })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('close', (code) => resolve({ code, err }))
  })
  const [a, b] = await Promise.all([起('p1'), 起('p2')])
  assert.equal(a.code, 0, a.err)
  assert.equal(b.code, 0, b.err)
  const ids = (读(s.留言, { items: [] }).items || []).map((x) => x.id).sort()
  assert.deepEqual(ids, ['p1', 'p2'])
})

test('M4 投递器跳过系统记录与 fresh 租约，发送期间新增的留言不丢', async () => {
  const s = 沙盒('m4')
  const 甲 = 北京戳()
  写(s.留言, {
    items: [
      { at: 甲, kind: '要钱', 话: '测试甲' },
      { id: 'sys', at: 甲, kind: '日报', 谁: '系统', 话: '【记录】系统记录', 不投递: true },
      { id: 'lease', at: 甲, kind: '要钱', 话: '测试乙', 寄: { ok: false, sending: 北京戳() } },
    ],
  })
  const 端 = await 假协议端(async (j) => {
    if (正文(j) === '测试甲') {
      await new Promise((r) => setTimeout(r, 80))
      改档(s.留言, (nb) => {
        if (!Array.isArray(nb.items)) nb.items = []
        nb.items.push({ id: 'later', at: 北京戳(), kind: '要钱', 话: '后来者' })
      }, { items: [] })
    }
  })
  try {
    const cfg = 配置(端.口, s.基)
    const r = await 跑(join(工具, '投递留言.mjs'), ['--force'], {
      MSG_BASE: s.基, MSG_CFG: cfg, MSG_LOG: join(s.基, '投递.log'), QQ_LOCK_DIR: process.env.QQ_LOCK_DIR,
    })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(端.收到.map(正文), ['测试甲'], '系统记录和 fresh 租约都不该发')
    const 留 = 读(s.留言, { items: [] })
    const 找到 = (id) => (留.items || []).find((x) => x.id === id)
    assert.equal(找到('later')?.话, '后来者', '发送期间新增的留言不能被旧快照覆盖')
    assert.equal(找到('lease')?.寄?.ok, false, 'fresh 租约这条不该被改')
    assert.match(String(找到('lease')?.寄?.sending || ''), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'fresh 租约的 sending 应保持原样')
    const 已送 = (留.items || []).find((x) => x.话 === '测试甲')
    assert.equal(已送?.寄?.ok, true)
    assert.ok(existsSync(join(s.记忆, '我说过.jsonl')))
  } finally { 端.srv.close() }
})

test('M5 过期租约允许重试', async () => {
  const s = 沙盒('m5')
  writeFileSync(join(s.基, 'x'), '')
  const 旧 = 北京戳(Date.now() - 3 * 60e3)
  写(s.留言, { items: [{ id: 'stale', at: 北京戳(), kind: '要钱', 话: '重试我', 寄: { ok: false, sending: 旧 } }] })
  const 端 = await 假协议端()
  try {
    const cfg = 配置(端.口, s.基)
    const r = await 跑(join(工具, '投递留言.mjs'), ['--force'], {
      MSG_BASE: s.基, MSG_CFG: cfg, MSG_LOG: join(s.基, '投递.log'), QQ_LOCK_DIR: process.env.QQ_LOCK_DIR,
    })
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(端.收到.map(正文), ['重试我'])
    assert.equal((读(s.留言).items || [])[0]?.寄?.ok, true)
  } finally { 端.srv.close() }
})

test('M6 两个投递器同时跑，同一条只发一次', async () => {
  const s = 沙盒('m6')
  写(s.留言, { items: [{ id: 'one', at: 北京戳(), kind: '要钱', 话: '只发一次' }] })
  const 端 = await 假协议端(async () => { await new Promise((r) => setTimeout(r, 600)) })
  try {
    const cfg = 配置(端.口, s.基)
    const env = { MSG_BASE: s.基, MSG_CFG: cfg, MSG_LOG: join(s.基, '投递.log'), QQ_LOCK_DIR: process.env.QQ_LOCK_DIR }
    const [a, b] = await Promise.all([
      跑(join(工具, '投递留言.mjs'), ['--force'], env),
      跑(join(工具, '投递留言.mjs'), ['--force'], env),
    ])
    assert.equal(a.code, 0, a.err)
    assert.equal(b.code, 0, b.err)
    assert.equal(端.收到.length, 1, '两个投递器不能把同一条发两遍')
    assert.equal((读(s.留言).items || [])[0]?.寄?.ok, true)
  } finally { 端.srv.close() }
})
