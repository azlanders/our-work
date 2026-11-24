// t551 —— 她连喊两次「我要睡了」，清醒起点就被清零（批次550）
//
// 事故：2026-11-16 主人叫她回家睡，她 08:21:35 调了一次 `qq_sleep 睡`、08:23:14 又调一次，
// **两次都返回 ok=true**。查下来两条链都漏了：
//
// ① `作息.mjs --想睡` 里 `flag.since = stamp` 是**无条件**写的。
//    而 `睡醒.json` 的 `since` 正是 `困意.mjs` 算「清醒多久」的起点（它决定腺苷那一项）。
//    于是她每多喊一次「我要睡了」，清醒时长就被清零一次 ——
//    实测那两次之后 `since` 从 07:59（她真醒来的时刻）变成了 08:23，24 分钟的清醒账凭空消失。
//    这正是「她熬了一夜、困意却算得很低」的一个来源。
//
// ② `sleep.js` 的 `睡整觉()` 从没看过 `startSleep()` 的返回值。
//    它有防重入（`if (data.sleeping) return fail()`），返回 ok:false 时**不写 睡醒.json**，
//    可紧接着 `作息 --想睡` 会把 sleeping 无条件写成 true —— 工具那条判据就过了，
//    于是「已经在睡」也报「去睡了」。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// NO_PROD_LOG：t453 的 A1 要求「凡碰插件 lib 的测试都先静音」。这里只 readFileSync，按约定一律关上。
process.env.QUIET_NOTE = '1'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造({ 有开着段 }) {
  const b = mkdtempSync(join(tmpdir(), 't551-'))
  const now = Date.now()
  const segs = [{ start: bj(now - 120 * 60e3), end: bj(now - 60 * 60e3), hours: 1 }]
  if (有开着段) segs.push({ start: bj(now - 8 * 60e3), end: null })
  writeFileSync(join(b, '睡眠.json'), JSON.stringify({
    segments: segs, sleeping: 有开着段,
    live: 有开着段 ? { start: bj(now - 8 * 60e3), startMs: now - 8 * 60e3 } : null,
  }))
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ sleeping: 有开着段, since: bj(now - 24 * 3600e3) }))
  writeFileSync(join(b, '状态.json'), JSON.stringify({ layers: { physical: 30 }, energy: 30, body: { 渴: 60 } }))
  writeFileSync(join(b, '资产.json'), JSON.stringify({ 钱: 621, 位置: '家' }))
  return b
}
const 跑想睡 = (b) => {
  try {
    return execFileSync(process.execPath, [join(工具, '作息.mjs'), '--想睡'], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_SLEEP_MEM: b },
    })
  } catch (e) { return String(e.stdout || '') + String(e.stderr || '') }
}
const 读 = (b, f) => JSON.parse(readFileSync(join(b, f), 'utf8'))

test('A1 已经在睡（有开着的段）→ since 一个字节都不许动', () => {
  const b = 造({ 有开着段: true })
  const 前 = 读(b, '睡醒.json').since
  const out = 跑想睡(b)
  const 后 = 读(b, '睡醒.json').since
  assert.equal(后, 前, `since 被重置了：${前} → ${后}（清醒时长会凭空少一截）`)
  assert.match(out, /已经在睡了/, '没说清楚「已经在睡」')
  assert.equal(/去睡了/.test(out), false, '已经在睡还在说「去睡了」——她调两次会以为自己刚躺下')
  assert.equal(读(b, '睡眠.json').segments.length, 2, '不许再推一条段')
  rmSync(b, { recursive: true, force: true })
})

test('A2 从醒到睡（没有开着的段）→ since 必须重置成现在，段 +1', () => {
  const b = 造({ 有开着段: false })
  const 前 = 读(b, '睡醒.json').since
  跑想睡(b)
  const d = 读(b, '睡醒.json')
  assert.notEqual(d.since, 前, 'since 没重置 —— 睡下去还按上次醒来的时间算清醒')
  assert.equal(d.sleeping, true, 'sleeping 没写成 true')
  assert.equal(读(b, '睡眠.json').segments.length, 2, '该新推一条段')
  rmSync(b, { recursive: true, force: true })
})

test('A3 判据只认「开着的段」，不认 sleeping 标记（那个标记自己会分叉）', () => {
  // sleeping=true 但段全关了 = 分叉状态。这时该当「从醒到睡」处理，把 since 重置。
  const b = 造({ 有开着段: false })
  const f = 读(b, '睡醒.json')
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ ...f, sleeping: true }))
  const 前 = 读(b, '睡醒.json').since
  跑想睡(b)
  assert.notEqual(读(b, '睡醒.json').since, 前, 'sleeping=true 但没有段时，应该重置 since（它是分叉，不是真在睡）')
  rmSync(b, { recursive: true, force: true })
})

test('B1 sleep.js 必须看 startSleep 的返回值', () => {
  const s = readFileSync(join(插件, 'sleep.js'), 'utf8')
  assert.ok(s.includes('let __开成 = null'), '没接返回值')
  assert.ok(s.includes('__开成 = m.startSleep()'), 'startSleep 的返回值还是没接')
  assert.ok(s.includes('__开成 && __开成.ok === false'), '没判 ok')
  assert.match(s, /已经在睡了/, '没告诉她已经睡着了')
})

test('B1b 作息 的短觉日志不许用 fs.* —— 它只有 named import', () => {
  // `node --check` 只查语法，**不查未定义变量**。批次550b 我写 `fs.existsSync(...)`，
  // 语法检查一路绿，真跑起来 ReferenceError 被 catch 吞掉，日志一行都写不出来。
  // 这个文件 import 的是 `{ readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync }`，
  // 上面根本没有 `fs` 这个命名空间。
  const s = readFileSync(join(工具, '作息.mjs'), 'utf8')
  const 用了命名空间 = /\bfs\.(existsSync|mkdirSync|appendFileSync|readFileSync|writeFileSync)\b/.test(s)
  assert.equal(用了命名空间, false, '作息.mjs 里出现了 fs.xxx，但它只 import 了具名函数 —— 运行时会 ReferenceError')
  assert.match(s, /import \{[^}]*appendFileSync[^}]*\} from 'node:fs'/, 'appendFileSync 没 import')
})

test('B1c 两条关段路径都要写短觉调用栈（endSleep + 作息--醒了）', () => {
  const 阶段 = readFileSync(join(工具, '睡眠阶段.mjs'), 'utf8')
  const 作 = readFileSync(join(工具, '作息.mjs'), 'utf8')
  assert.match(阶段, /SHORT_WAKE_TRACE/, 'endSleep 那条路的栈没了')
  assert.match(作, /WAKE_TRACE/, '作息--醒了 那条路的栈没了')
  assert.match(作, /__记短觉/, '短觉记录函数没了')
  // 两条路写同一个文件，才能一眼看出是谁关的
  assert.match(作, /醒来\.log/, '作息 没写 醒来.log')
  assert.match(阶段, /醒来\.log/, 'endSleep 没写 醒来.log')
})

test('B2 两处判据都要在（作息 的幂等 + 工具的返回值）', () => {
  const 作 = readFileSync(join(工具, '作息.mjs'), 'utf8')
  assert.ok(作.includes('const __已在睡 = !!(找开着的段(sleep.segments) || {}).段'), '作息的幂等判据没了')
  assert.ok(作.includes('if (!__已在睡) {'), 'if 结构变了')
  assert.match(作, /flag\.since = stamp\s+\/\/ 只有真的从醒到睡才重置清醒起点/, 'since 的注释/位置变了')
})
