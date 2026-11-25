import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 /data/hajimi-dsh/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 自改.mjs 的 --drift 2026-11-01 就写好了（限频 30/90 天、步长 1/2 分、1~10 边界、留痕），
// 14 天零调用 —— 因为 qq_self 的 op 只有 set/log/list，她自己既不知道性格能挪，也没有入口。
// 批次423 接上：op:drift + --list 带当前分。
// 这里锁六件事：分数看得见、漂能生效、窗口挡得住、核心要理由、核心步长是 1、撞边界不漏出去。
const TOOLS = '/data/hajimi-workspace/共享/工具'
const LIB = '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const 自改 = join(TOOLS, '自改.mjs')

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 'drift423-'))
  writeFileSync(join(sb, '性格-16PF.json'), JSON.stringify({ Q3_自律性: 4, C_稳定性: 5, G_有恒性: 4 }))
  writeFileSync(join(sb, '自改日志.json'), JSON.stringify({ items: [] }))
  return sb
}

function 跑(sb, args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [自改, ...args], {
        encoding: 'utf8', timeout: 30000, cwd: TOOLS,
        env: { ...process.env, SELF_MEM: sb },
      }),
    }
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

const 读 = (sb, f) => JSON.parse(readFileSync(join(sb, f), 'utf8'))

test('D1 --list 能看到每个因子现在几分', () => {
  const sb = 造()
  const r = 跑(sb, ['--list'])
  try {
    assert.equal(r.code, 0, r.out)
    // 给的三项按沙盒值，没给的默认 5 —— 两个都要对，否则「读的是哪份档」没锁住
    assert.match(r.out, /Q3_自律性 4/, r.out)
    assert.match(r.out, /G_有恒性 4/, r.out)
    assert.match(r.out, /C_稳定性 5/, r.out)
    // 十六个因子一个都不能少（少了就是白名单漏了，她会以为自己只能漂那几个）
    const 名 = ['A_乐群性', 'B_聪慧性', 'C_稳定性', 'E_恃强性', 'H_敢为性', 'I_敏感性', 'L_怀疑性', 'M_幻想性', 'O_忧虑性', 'Q4_紧张性', 'Q3_自律性', 'G_有恒性', 'F_兴奋性', 'N_世故性', 'Q2_独立性', 'Q1_实验性']
    for (const k of 名) assert.ok(r.out.includes(k), '缺 ' + k)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('D2 边缘因子一次能漂 2 分，而且记下了为什么', () => {
  const sb = 造()
  const r = 跑(sb, ['--drift', 'Q3_自律性', '--value', '-2', '--why', '连着三天没按说的做'])
  try {
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /4 → 2/, r.out)
    assert.equal(读(sb, '性格-16PF.json').Q3_自律性, 2)
    const it = 读(sb, '自改日志.json').items
    assert.equal(it.length, 1)
    assert.match(it[0].what, /Q3_自律性 4 → 2/)
    assert.equal(it[0].why, '连着三天没按说的做')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('D3 一个月内漂不动第二次（分数和日志都不该变）', () => {
  const sb = 造()
  try {
    assert.equal(跑(sb, ['--drift', 'Q3_自律性', '--value', '-1']).code, 0)
    const r = 跑(sb, ['--drift', 'Q3_自律性', '--value', '+1'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /已经动过.*得等/, r.out)
    assert.equal(读(sb, '性格-16PF.json').Q3_自律性, 3)
    assert.equal(读(sb, '自改日志.json').items.length, 1)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('D4 核心因子没写为什么就是不动', () => {
  const sb = 造()
  try {
    const r = 跑(sb, ['--drift', 'C_稳定性', '--value', '-1'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /要写清楚为什么/, r.out)
    assert.equal(读(sb, '性格-16PF.json').C_稳定性, 5)
    assert.equal(读(sb, '自改日志.json').items.length, 0)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('D5 核心因子给了 5 也只挪 1（步长不是她说了算）', () => {
  const sb = 造()
  try {
    const r = 跑(sb, ['--drift', 'C_稳定性', '--value', '5', '--why', '这半年糟心事太多'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /5 → 6/, r.out)
    assert.equal(读(sb, '性格-16PF.json').C_稳定性, 6)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('D6 到底了不会掉到 0 以下，也不许记一笔假账', () => {
  // 撞边界必须「什么都不发生」：原来无条件 save+noteIt，会写一条「1 → 1」把 30 天窗口白占掉。
  // 所以这里不只断分数，还要断日志条数 —— 只断分数的话，旧实现照样绿。
  const sb = 造()
  writeFileSync(join(sb, '性格-16PF.json'), JSON.stringify({ Q3_自律性: 1 }))
  try {
    const r = 跑(sb, ['--drift', 'Q3_自律性', '--value', '-2'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /到底了/, r.out)
    assert.doesNotMatch(r.out, /漂了/, r.out)
    assert.equal(读(sb, '性格-16PF.json').Q3_自律性, 1)
    assert.equal(读(sb, '自改日志.json').items.length, 0, '撞边界不该记账')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('D7 qq_self 真的暴露了 drift，而且不再说「你的性格改不了」', () => {
  // 只测脚本不测入口 = 白测：批次 414 之前 --set 也是「能用」的，她照样一次没调过。
  const s = readFileSync(join(LIB, 'tool-interact.js'), 'utf8')
  assert.match(s, /enum: \['set', 'log', 'list', 'drift'\]/, 'op enum 里没有 drift')
  assert.match(s, /op === 'drift'/, 'execute 里没有 drift 分支')
  assert.match(s, /argv\.push\('--drift', k, '--value'/, 'drift 参数没搬到脚本')
  assert.match(s, /先 op:list 看看自己现在什么脾气/, '描述里没告诉她怎么先看')
  // 老描述原句「别人怎么看你、你的性格、密码、代码」——留着就跟新加的 drift 自相矛盾
  assert.doesNotMatch(s, /别人怎么看你、你的性格、密码、代码/, '旧描述还在，自相矛盾')
})

test('D8 跑这一整套没有碰真档案', () => {
  const 真 = join('/data/hajimi-workspace/记忆', '性格-16PF.json')
  const 日志 = join('/data/hajimi-workspace/记忆', '自改日志.json')
  const a = readFileSync(真, 'utf8')
  const b = readFileSync(日志, 'utf8')
  const sb = 造()
  try {
    const r = 跑(sb, ['--list'])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(r.out, /A_乐群性 7/, '读到真档了（真档 A 是 7，沙盒默认 5）')
    assert.equal(readFileSync(真, 'utf8'), a)
    assert.equal(readFileSync(日志, 'utf8'), b)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})
