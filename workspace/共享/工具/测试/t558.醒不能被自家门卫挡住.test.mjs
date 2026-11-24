// t558 —— 她自己说要醒，不能被「防误调」的门卫挡住；每次醒来都要留痕（批次558）
//
// 批次552 给 `作息.mjs --醒了` 加了「不到 10 分钟不许结束」的门卫，只放行 `QQ_SETTLED=1`
// （那是 `醒来.mjs` 的正式结算）。可桥上的 `qq_sleep` 醒走的是同一个入口，**不带** QQ_SETTLED
// —— 她睡 5 分钟说「我醒了」，门卫把她挡回去、exit 0 输出「这一觉才 N 分钟，先不结束」，
// 而 `sleep.js` 的 `醒过来()` 原来**无条件 return ok:true**。
// 于是她被告知「醒了」，`睡醒.json.sleeping` 还是 true —— 又一个「说醒了可她还睡着」。
//
// 同一批还补了审计：日志原来只在「短觉（<60 分钟）」和「自动作息 自家叫醒」时写，
// 于是 08:44 那次 5 分钟被结束，至今查不出是谁调的。现在**每一次** --醒了 都留一行。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

// NOTE_OFF 2026-11-16（批次558）：这个文件 import 插件的 sleep.js，
// import 时 env.js 的 note() 会往 {{DSH_ROOT}}/qq-bridge-load.log 写「registered」。
// 全套跑一遍几千行，真信号（照片到货之类）直接被冲没（批次452 的事故）。
// 必须在**顶层、import 之前**设 —— t453 A1 认的就是这一行。
process.env.QUIET_NOTE = '1'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 真档 = '{{BOT_ROOT}}/记忆'

const 读 = (p) => readFileSync(p, 'utf8')
const 指纹 = (p) => {
  try { const s = statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return '(无)' }
}

/** 造一个「3 分钟前开始、还开着」的觉。 */
function 造沙盒(分钟前 = 3) {
  const d = mkdtempSync(join(tmpdir(), 't558-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  const 起 = new Date(Date.now() - 分钟前 * 60000 + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({
    records: [], segments: [{ start: 起, phases: [] }], live: { start: 起 },
    sleeping: true, todayTotalHours: 0,
  }, null, 2))
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: true, since: 起 }, null, 2))
  writeFileSync(join(d, '状态.json'), JSON.stringify({ energy: 40, layers: { physical: 30 } }, null, 2))
  return { d, 起 }
}

function 跑醒(d, extraEnv = {}) {
  const r = spawnSync(process.execPath, [join(工具, '作息.mjs'), '--醒了'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, QQ_SLEEP_MEM: d, ST_BASE: d, QQ_AUTONOMY_MEM: d, NAP_MEM: d, QQ_SLEEPY_MEM: d, ...extraEnv },
  })
  return String((r.stdout || '') + (r.stderr || '')).trim()
}

test('A1 sleep.js 的醒要带「本人在醒」的标记', () => {
  const s = 读(LIB + '/sleep.js')
  assert.match(s, /QQ_WAKE_EXPLICIT: '1'/, '醒过来 没传 QQ_WAKE_EXPLICIT，门卫会把她挡回去')
  // 标记必须落在 作息 那一次调用里，不能只是写在别处
  // 别写 `\{[^}]*` —— opt 里还有一个对象字面量（env: {...}），第一个 `}` 就撞上了，
  // 改前的代码本来是对的，是断言把「只有一个花括号」当成前提（t539/t550 同一个坑）。
  assert.match(s, /跑脚本\('作息\.mjs', \['--醒了'\], \{[^\n]*QQ_WAKE_EXPLICIT: '1'/, '标记没传到 作息 的 env 里')
})

test('A2 sleep.js 醒完要复查标记，没落下去不许报成功', () => {
  const s = 读(LIB + '/sleep.js')
  // 别写成恒真的 `'余额不足' === '余额不足'`（t543 P6 就是这么假通过的）
  const 段 = s.slice(s.indexOf('export async function 醒过来'), s.indexOf('export async function 醒过来') + 2200)
  assert.ok(段.length > 200, '找不到 醒过来 函数体')
  assert.match(段, /读档\(join\(mem, '睡醒\.json'\)/, '没有回头读 睡醒.json')
  // 别写死「同一行 return」—— 批次561 把这一句拆成了 `if (…) {` + `return { ok: false … }`，
  // 同一个意思换个排版断言就红（t539/t550 同一个坑）。跨行找，中间允许注释。
  assert.match(段, /后\.sleeping === true\)[\s\S]{0,400}?ok: false/, '没落下去还报 ok:true')
  // 失败文案必须自带「没醒成」：`作息 --醒了` 拒绝时的输出是「先不结束」，
  // 而成功时的输出是「去睡了…」—— 拿脚本输出当失败文案，她读到会以为自己醒了（批次561）。
  assert.match(段, /没醒成/, '失败文案没用「没醒成」')
})

test('A3 跑脚本 要能接附加 env（不改其它调用方的行为）', () => {
  const s = 读(LIB + '/sleep.js')
  assert.match(s, /\.\.\.\(\(opt && opt\.env\) \|\| \{\}\)/, '跑脚本 没有透传 opt.env')
  // 原来的五个沙盒变量一个都不能少
  for (const k of ['QQ_AUTONOMY_MEM', 'NAP_MEM', 'QQ_SLEEPY_MEM', 'ST_BASE', 'QQ_SLEEP_MEM']) {
    assert.ok(s.includes(k + ': mem'), '跑脚本 少了 ' + k)
  }
})

test('A4 作息 的门卫要给 QQ_WAKE_EXPLICIT 放行', () => {
  const s = 读(工具 + '/作息.mjs')
  assert.match(s, /__分钟0 < 10 && process\.env\.QQ_SETTLED !== '1' && process\.env\.QQ_WAKE_EXPLICIT !== '1'/,
    '门卫条件变了 —— 要么漏了 EXPLICIT（她的醒被挡），要么连 SETTLED 也没了')
})

test('A5 作息 每次 --醒了 都要留一行审计', () => {
  const s = 读(工具 + '/作息.mjs')
  assert.ok(s.includes('[醒了调用]'), '没有无条件审计日志')
  // 这一行必须在门卫**之前**（门卫拒绝的那次也要留痕，否则查不到谁在乱调）
  const i审计 = s.indexOf('[醒了调用]')
  const i门卫 = s.indexOf('if (__分钟0 < 10 &&')
  assert.ok(i审计 > 0 && i门卫 > 0 && i审计 < i门卫, '审计写在门卫后面了 —— 被拒的那次还是查不到是谁')
  // 父进程命令行要抄下来（栈里看不见调用方）
  assert.ok(s.includes("'/proc/' + process.ppid + '/cmdline'"), '没抄父进程命令行')
})

test('B1 沙盒：不带标记、才睡 3 分钟 → 拒绝结束，段还开着', () => {
  const { d, 起 } = 造沙盒(3)
  try {
    const out = 跑醒(d)
    assert.match(out, /先不结束/, '没走门卫（输出：' + out.slice(0, 120) + '）')
    const 后 = JSON.parse(读(join(d, '睡醒.json')))
    assert.equal(后.sleeping, true, '门卫没生效，标记被改成醒了')
    const 睡 = JSON.parse(读(join(d, '睡眠.json')))
    assert.equal(睡.segments[0].end, undefined, '门卫没生效，段被关掉了')
    assert.ok(睡.segments[0].start === 起, '段起点被动了')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B2 沙盒：带 QQ_WAKE_EXPLICIT=1、同样 3 分钟 → 放行，是真醒', () => {
  const { d } = 造沙盒(3)
  try {
    const out = 跑醒(d, { QQ_WAKE_EXPLICIT: '1' })
    assert.ok(!/先不结束/.test(out), '还是被门卫挡了（输出：' + out.slice(0, 120) + '）')
    const 后 = JSON.parse(读(join(d, '睡醒.json')))
    assert.equal(后.sleeping, false, '放行了却没写 sleeping=false')
    const 睡 = JSON.parse(读(join(d, '睡眠.json')))
    assert.ok(睡.segments[0].end, '放行了却没关段')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B3 沙盒：被拒的那次也要留审计，且能看出是谁调的和当时开着哪一段', () => {
  const { d, 起 } = 造沙盒(3)
  try {
    跑醒(d)
    const log = 读(join(d, '日志', '醒来.log'))
    assert.ok(log.includes('[醒了调用]'), '被拒的那次没留审计：\n' + log)
    assert.ok(log.includes('EXPLICIT='), '没记标记')
    assert.ok(log.includes('开着的段: ' + 起) || log.includes('开着的段: ' + 起.slice(0, 16)),
      '没记当时开着哪一段（实际：' + log.split('\n')[0].slice(0, 160) + '）')
    assert.ok(/父进程: node .*作息\.mjs/.test(log) || log.includes('父进程: '), '没记父进程')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B4 沙盒：sleep.js 的醒过来 在短睡里能真醒（走通整条链）', async () => {
  const { d } = 造沙盒(3)
  const 守 = ['睡醒.json', '睡眠.json', '状态.json'].map((f) => [f, 指纹(join(真档, f))])
  try {
    // import 前把沙盒变量都摆好 —— sleep.js 顶层的 记忆目录() 会读它们
    process.env.QQ_AUTONOMY_MEM = d
    process.env.NAP_MEM = d
    process.env.QQ_SLEEPY_MEM = d
    process.env.ST_BASE = d
    process.env.QQ_SLEEP_MEM = d
    const { 醒过来 } = await import(LIB + '/sleep.js')
    const r = await 醒过来({ mem: d })
    assert.equal(r.ok, true, '短睡里自己说要醒却失败了：' + r.message)
    const 后 = JSON.parse(读(join(d, '睡醒.json')))
    assert.equal(后.sleeping, false, '报了成功但标记还是睡着（这就是批次558 要修的那个账）')
  } finally {
    // GUARD_BY_VALUE 2026-11-16（批次564）：**别再拿 mtime 当真档防线。**
    // 线上「睡眠心跳」每分钟写 状态.json（批次564 新加的心跳任务），mtime 必然变 ——
    // t563/t564 已经因为这个红过（10 次红 1 次）。这里同样改成查特征值：
    // 本测试的沙盒是 physical 30 + energy 40，真档不会是这个组合。
    {
      const st = JSON.parse(readFileSync(join(真档, '状态.json'), 'utf8'))
      const 撞 = Number(st.layers?.physical) === 30 && Number(st.energy) === 40
      assert.ok(!撞, '真档 状态.json 出现 t558 的特征值（体力 30 / 精力 40）—— 沙盒变量漏了')
    }
    rmSync(d, { recursive: true, force: true })
  }
})

test('B5 沙盒：本来就醒着时，醒过来 要如实说「本来就醒着」', async () => {
  const d = mkdtempSync(join(tmpdir(), 't558b-'))
  try {
    writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: '2026-11-16 08:00' }))
    writeFileSync(join(d, '睡眠.json'), JSON.stringify({ records: [], segments: [], sleeping: false }))
    process.env.QQ_AUTONOMY_MEM = d
    process.env.NAP_MEM = d
    process.env.ST_BASE = d
    process.env.QQ_SLEEP_MEM = d
    const { 醒过来 } = await import(LIB + '/sleep.js')
    const r = await 醒过来({ mem: d })
    assert.equal(r.ok, false, '醒着还说醒成了')
    assert.match(r.message, /本来就醒着/, '文案变了：' + r.message)
  } finally { rmSync(d, { recursive: true, force: true }) }
})
