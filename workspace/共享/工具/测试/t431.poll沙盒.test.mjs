import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// poll.js 4500 行、69 处记忆路径 + 9 处共享路径原来全是字面量，一个沙盒变量都没有 ——
// 想单测注入逻辑就只能读她真档，「测过」和「没测过」看起来一样。
// 批次427 收敛成 QQ_MEM / QQ_TOOLS / QQ_SHARED 三根根路径。
// 这里锁三件事：记忆目录真的指得动、指不动时不会偷读真档、源码里没有新的硬编码。
const POLL = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
const 真记忆 = '{{BOT_ROOT}}/记忆'

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 'poll427-'))
  return sb
}

/** 独立进程：MEM/TOOLS/SHARED 都是模块顶层求值，同进程里换 env 换不掉。 */
function 跑(mem, 代码) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QQ_MEM: mem },
  })
  return out.trim().split('\n').pop()
}

test('P1 记忆目录指到沙盒，sleepFactsOf 读的是沙盒那份', () => {
  const sb = 造()
  try {
    // 用 sleeping:false + since —— 这一支才会把 since 原样读出来（sleeping:true 只说「你正在睡着」，
    // 断言它读的是哪份文件就没戏了）。第一版写成 true，红了一次才发现是断言钉错了实现。
    writeFileSync(join(sb, '睡醒.json'), JSON.stringify({ sleeping: false, since: '2026-11-14 03:00' }))
    const 代码 = `
      const m = await import(${JSON.stringify(POLL)})
      console.log(JSON.stringify({ t: m.sleepFactsOf() }))
    `
    const r = JSON.parse(跑(sb, 代码))
    assert.match(r.t, /你从 2026-11-14 03:00 起一直醒着/, r.t)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('P2 沙盒里没有记录时，不许偷读真档补一句', () => {
  // 这一条是「沙盒真的隔离」的反证：如果 MEM 还是硬编码，真档里的睡醒记录就会漏进来
  const sb = 造()
  try {
    const 代码 = `
      const m = await import(${JSON.stringify(POLL)})
      console.log(JSON.stringify({ t: m.sleepFactsOf() }))
    `
    const r = JSON.parse(跑(sb, 代码))
    assert.match(r.t, /作息记录里没有你最近的睡觉记录/, r.t)
    let 真 = ''
    try { 真 = readFileSync(join(真记忆, '睡醒.json'), 'utf8') } catch { /* 没有就算了 */ }
    const 真since = (真.match(/"since"\s*:\s*"([^"]+)"/) || [])[1]
    if (真since) assert.ok(!r.t.includes(真since), '真档的 since 漏进沙盒了：' + 真since)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('P3 源码里只允许根定义还带着老路径（业务与动态 import 全部走 QQ_WS/三根）', () => {
  const s = readFileSync(POLL, 'utf8')
  const 行 = s.split('\n')
  const 带 = 行.map((l, i) => [i + 1, l]).filter(([, l]) => l.includes('{{BOT_ROOT}}/'))
  for (const [n, l] of 带) {
    const ok = /^\s*import\s/.test(l)
      || /process\.env\.QQ_(WORKSPACE|MEM|TOOLS|SHARED)/.test(l)
    assert.ok(ok, `第 ${n} 行又写死了路径：${l.trim().slice(0, 90)}`)
  }
  assert.match(s, /process\.env\.QQ_WORKSPACE \|\|/)
  assert.match(s, /process\.env\.QQ_MEM \|\|/)
  assert.match(s, /process\.env\.QQ_TOOLS \|\|/)
  assert.match(s, /process\.env\.QQ_SHARED \|\|/)
  assert.match(s, /await import\(`\$\{QQ_WS\}\/共享\/工具\/惦记\.mjs`\)/, '惦记.mjs 必须走 QQ_WS 动态导入')
})

test('P4 不设 env 时的兜底值还是真实记忆目录', () => {
  const s = readFileSync(POLL, 'utf8')
  assert.ok(s.includes("process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'"), 'QQ_WORKSPACE 的兜底值变了')
  assert.ok(s.includes('process.env.QQ_MEM || `${QQ_WS}/记忆`'), 'QQ_MEM 的兜底值变了')
  assert.ok(s.includes('process.env.QQ_TOOLS || `${QQ_WS}/共享/工具`'), 'QQ_TOOLS 的兜底值变了')
  assert.ok(s.includes('process.env.QQ_SHARED || `${QQ_WS}/共享`'), 'QQ_SHARED 的兜底值变了')
})
