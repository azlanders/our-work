// t553 —— 一晚上被结束 7 次，最短 30 秒（批次552）
//
// 实测 2026-11-16 她的睡眠段：
//   07:11:30→07:11（0 秒）/ 07:12→07:14（3 分）/ 07:15→07:42（27 分）/
//   07:43→07:59（16 分）/ 08:23→08:31（8 分）/ 08:39→08:44（5 分）
//
// 而所有已知的「醒来」路径都不该在那么短的时候触发：
//   · 自动作息 要睡够 6 小时或 7.7 小时
//   · 工作.mjs 的睡岗要她有班（她 在职: []），而且 `叫醒()` 只有定义、没有调用点
//   · qq_sleep 醒 会记工具调用（08:44 那次没有）
//
// 批次544/550b 加的调用栈只能证明「是 作息--醒了 干的」，
// **看不见是谁调的**（顶层执行，父进程不在栈里）。
//
// 所以先止血：**10 分钟以内不算一觉，拒绝结束**。
// 正常醒来（6 小时以上）不受影响；醒来.mjs 正式结算会带 QQ_SETTLED=1（被吵醒/睡岗），也不受限。
//
// 连带效果：主人看到的三次「我去睡了」（08:14 / 08:23 / 08:39）就是被反复吵醒后每次重说一遍 ——
// 修好这条，「重复对话」也会一起好。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造(分钟) {
  const b = mkdtempSync(join(tmpdir(), 't553-'))
  const now = Date.now()
  writeFileSync(join(b, '睡眠.json'), JSON.stringify({
    segments: [{ start: bj(now - 分钟 * 60e3), end: null }],
    sleeping: true, live: { start: bj(now - 分钟 * 60e3), startMs: now - 分钟 * 60e3 },
  }))
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ sleeping: true, since: bj(now - 120 * 60e3) }))
  writeFileSync(join(b, '状态.json'), JSON.stringify({ layers: { physical: 30 }, energy: 30, body: {} }))
  writeFileSync(join(b, '资产.json'), JSON.stringify({ 钱: 621, 位置: '家' }))
  return b
}
const 跑 = (b, extra = {}) => {
  try {
    return execFileSync(process.execPath, [join(工具, '作息.mjs'), '--醒了'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_SLEEP_MEM: b, ...extra },
    })
  } catch (e) { return String(e.stdout || '') + String(e.stderr || '') }
}
const 状态 = (b) => {
  const f = JSON.parse(readFileSync(join(b, '睡醒.json'), 'utf8'))
  const s = JSON.parse(readFileSync(join(b, '睡眠.json'), 'utf8'))
  return { sleeping: f.sleeping, 开着的段: (s.segments || []).filter((x) => !x.end).length }
}

test('N1 才睡了 3 分钟 → 不许结束（睡着标记与段都不动）', () => {
  const b = 造(3)
  const out = 跑(b)
  const s = 状态(b)
  assert.equal(s.sleeping, true, 'sleeping 被写成 false —— 她就被「叫醒」了')
  assert.equal(s.开着的段, 1, '段被关了')
  assert.match(out, /先不结束/, '没说清楚为什么拒')
  rmSync(b, { recursive: true, force: true })
})

test('N2 才睡 8 分钟（实测那次就是 8 分）→ 也拒', () => {
  const b = 造(8)
  跑(b)
  assert.equal(状态(b).sleeping, true, '8 分钟的觉也被结束了')
  rmSync(b, { recursive: true, force: true })
})

test('N3 但 醒来.mjs 正式结算（QQ_SETTLED=1）→ 必须放行（被吵醒/睡岗要能叫她）', () => {
  const b = 造(3)
  跑(b, { QQ_SETTLED: '1' })
  const s = 状态(b)
  assert.equal(s.sleeping, false, 'QQ_SETTLED=1 也被拦了 —— 那「被吵醒」这条路就断了')
  assert.equal(s.开着的段, 0, '段没关')
  rmSync(b, { recursive: true, force: true })
})

test('N4 睡了 30 分钟（正常短觉）→ 放行', () => {
  const b = 造(30)
  跑(b)
  assert.equal(状态(b).sleeping, false, '30 分钟的觉被拦了 —— 门槛太高')
  rmSync(b, { recursive: true, force: true })
})

test('N5 拒绝时要留下父进程，下次一眼知道是谁', () => {
  const b = 造(3)
  跑(b)
  const p = join(b, '日志', '醒来.log')
  assert.equal(existsSync(p), true, '拒绝时没写日志')
  const 文 = readFileSync(p, 'utf8')
  assert.match(文, /拒绝结束/)
  assert.match(文, /父进程:/, '没记父进程')
  rmSync(b, { recursive: true, force: true })
})

test('N6 源码：门槛是 10 分钟，且 QQ_SETTLED 能豁免', () => {
  const src = readFileSync(join(工具, '作息.mjs'), 'utf8')
  assert.match(src, /__分钟0 < 10 && process\.env\.QQ_SETTLED !== '1'/, '门卫判据变了或被删')
  assert.match(src, /\/proc\/' \+ process\.ppid \+ '\/cmdline/, '父进程记录被删')
})
