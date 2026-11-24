// t561 —— 「醒」这条路，批次558 只修了整觉那一半（批次561）
//
// `sleep.js` 文件头自己写着「判成功只看 睡醒.json / 打盹.json，不看脚本打印了什么」，
// 可 `醒过来()` 的打盹分支恰恰只看打印：
//
//   if (盹 && 解析(盹.到) > Date.now()) {
//     const out = await 跑脚本('打盹.mjs', ['--醒'], opt)
//     return { ok: true, message: out || '醒了' }        // ← 无条件
//   }
//
// 三个漏点：
//   1. `解析` 只认 16 字符的 `到`，**不认 `到毫秒`** —— 而 `到毫秒` 是 打盹.mjs save 时
//      必写的字段、`睡态.打盹中()` 认的正是它。同一个 打盹.json 三个答案。
//   2. 打盹醒没醒不看文件，`--醒` 在「没在打盹 / 写档失败」时都 exit 0 输出一句话。
//   3. 那条 `return` 让整觉分支根本没机会跑 —— 而批次499 说整觉和打盹会**并排开着**。
import { test, after } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => readFileSync(p, 'utf8')
const 指纹 = (p) => { try { const s = statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return '(无)' } }

/** 假工具目录：脚本只打印、不碰档 —— 专门用来证明「只看打印」会报假成功。 */
function 假工具(名字, 输出) {
  const d = mkdtempSync(join(tmpdir(), 't561tools-'))
  writeFileSync(join(d, 名字), `console.log(${JSON.stringify(输出)})\nprocess.exit(0)\n`)
  return d
}

function 沙盒() {
  const d = mkdtempSync(join(tmpdir(), 't561-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: '2026-11-16 08:39:34' }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({ records: [], segments: [], sleeping: false }))
  return d
}

test('A1 解析要认带秒（班次时间、endSleep 的段起点都可能是带秒的）', () => {
  const s = 读(LIB + '/sleep.js')
  assert.ok(!/if \(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\} \\d\{2\}:\\d\{2\}\$\/\.test\(t\)\) return Date\.parse/.test(s),
    '解析 还是只认 16 字符')
  assert.match(s, /const m = t\.match\(\/\^\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\[ T\]\(\\d\{2\}:\\d\{2\}\)\(:\\d\{2\}\)\?\$\/\)/,
    '解析 没改成认带秒')
})

test('A2 打盹的到点问共享工具，不许再自己解析', () => {
  const s = 读(LIB + '/sleep.js')
  assert.ok(s.includes('async function 盹到点(n)'), '没有 盹到点')
  assert.ok(/import\('file:\/\/' \+ join\(工具目录\(\), '睡态\.mjs'\)/.test(s), '没去问共享工具的 睡态.mjs')
  // 三处调用全改掉（睡整觉升级 / 眯一会儿复查 / 醒过来）
  const n = (s.match(/await 盹到点\(/g) || []).length
  assert.ok(n >= 4, 'await 盹到点 只用了 ' + n + ' 处（至少 4：睡整觉 1 + 眯 1 + 醒 2）')
  // 查「不许有」必须先去掉注释行 —— 我自己的注释里就写着「原来有三处 解析(盹.到)」，
  // 直接扫全文会把注释当成代码（t555 F1 同一个坑）。
  const 码 = s.split('\n').filter((ln) => !ln.trim().startsWith('//') && !ln.trim().startsWith('*')).join('\n')
  assert.ok(!/解析\(盹\.到\)|解析\(__盹\.到\)/.test(码), '还有地方直接用 解析(…到) 绕过 盹到点')
})

test('A3 醒过来 要把打盹和整觉都收掉，不许收完打盹就 return', () => {
  const s = 读(LIB + '/sleep.js')
  const i = s.indexOf('export async function 醒过来')
  assert.ok(i > 0)
  const 段 = s.slice(i, s.indexOf('/**', i + 10))
  assert.match(段, /const 在盹 = Boolean\(盹\)/, '没有 在盹')
  assert.match(段, /const 在睡 = Boolean\(flag\)/, '没有 在睡')
  // 打盹分支里不许出现「跑完 --醒 直接 return ok:true」
  const i盹 = 段.indexOf('if (在盹)')
  const i睡 = 段.indexOf('if (在睡)')
  assert.ok(i盹 > 0 && i睡 > i盹, '整觉分支不在打盹之后 —— 结构变了')
  const 盹段 = 段.slice(i盹, i睡)
  assert.ok(!/return \{ ok: true/.test(盹段), '打盹分支里还是直接报成功，整觉收不到了')
  assert.match(盹段, /后盹 && \(await 盹到点\(后盹\)\) > Date\.now\(\)/, '打盹醒完没复查文件')
})

test('B1 沙盒：打盹档只有 到毫秒 → 真能醒（改之前会报「本来就醒着」）', async () => {
  const d = 沙盒()
  const 守 = ['打盹.json', '睡醒.json', '睡眠.json'].map((f) => [f, 指纹(join(真档, f))])
  try {
    const 将来 = Date.now() + 20 * 60e3
    // 只写 到毫秒 —— 打盹.mjs save 会同时写 到，但面板/自检/老版本可能只写这个
    writeFileSync(join(d, '打盹.json'), JSON.stringify({ 开始: '2026-11-16 09:20:00', 到毫秒: 将来, 分钟: 20 }))
    process.env.QQ_AUTONOMY_MEM = d
    process.env.NAP_MEM = d
    process.env.ST_BASE = d
    process.env.QQ_SLEEP_MEM = d
    const { 醒过来 } = await import(LIB + '/sleep.js')
    const r = await 醒过来({ mem: d })
    assert.equal(r.ok, true, '只有 到毫秒 时醒不过来：' + r.message)
    assert.ok(!existsSync(join(d, '打盹.json')), '打盹.json 没被收掉')
  } finally {
    for (const [f, v] of 守) assert.equal(指纹(join(真档, f)), v, f + ' 被写真档了')
    rmSync(d, { recursive: true, force: true })
  }
})

test('B2 沙盒：整觉和打盹并排开着 → 两条都要收（改之前只收打盹就 return）', async () => {
  const d = 沙盒()
  const 守 = ['打盹.json', '睡醒.json', '睡眠.json', '状态.json'].map((f) => [f, 指纹(join(真档, f))])
  try {
    const 将来 = Date.now() + 20 * 60e3
    writeFileSync(join(d, '打盹.json'), JSON.stringify({ 开始: '2026-11-16 09:20:00', 到: '2026-11-16 09:40', 到毫秒: 将来, 分钟: 20 }))
    writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: true, since: '2026-11-16 09:20:16' }))
    writeFileSync(join(d, '睡眠.json'), JSON.stringify({
      records: [], segments: [{ start: '2026-11-16 09:20:16', phases: [] }],
      live: { start: '2026-11-16 09:20:16', phase: 'N1', cycle: 1, deep_min: 0, light_min: 0, rem_min: 0 },
      sleeping: true,
    }))
    writeFileSync(join(d, '状态.json'), JSON.stringify({ energy: 44, layers: { physical: 30 } }))
    process.env.QQ_AUTONOMY_MEM = d
    process.env.NAP_MEM = d
    process.env.ST_BASE = d
    process.env.QQ_SLEEP_MEM = d
    const { 醒过来 } = await import(LIB + '/sleep.js')
    const r = await 醒过来({ mem: d })
    assert.equal(r.ok, true, '并排时醒不过来：' + r.message)
    assert.ok(!existsSync(join(d, '打盹.json')), '打盹没收掉')
    const flag = JSON.parse(读(join(d, '睡醒.json')))
    assert.equal(flag.sleeping, false, '整觉没收掉（睡醒.json 还是 true）—— 打盹分支里一定是早 return 了')
  } finally {
    for (const [f, v] of 守) assert.equal(指纹(join(真档, f)), v, f + ' 被写真档了')
    rmSync(d, { recursive: true, force: true })
  }
})

test('B3 沙盒：「--醒」只打印不删档 → 必须报失败，不许说醒了', async () => {
  const d = 沙盒()
  const 守 = ['打盹.json', '睡醒.json'].map((f) => [f, 指纹(join(真档, f))])
  const 假 = 假工具('打盹.mjs', '醒了')
  try {
    writeFileSync(join(d, '打盹.json'), JSON.stringify({ 开始: '2026-11-16 09:20:00', 到毫秒: Date.now() + 20 * 60e3, 分钟: 20 }))
    process.env.QQ_AUTONOMY_MEM = d
    process.env.NAP_MEM = d
    process.env.ST_BASE = d
    process.env.QQ_SLEEP_MEM = d
    const { 醒过来 } = await import(LIB + '/sleep.js')
    const r = await 醒过来({ mem: d, tools: 假 })
    assert.equal(r.ok, false, '档还在却报了 ok:true —— 这就是「说醒了可她还睡着」')
    // 断言必须写到「为什么失败」上。只查 ok:false 是假通过：
    // 改之前的代码在「只有 到毫秒」时压根进不了打盹分支，落到「本来就醒着」也是 ok:false，
    // 反向验证时这一条当场绿了 —— 就是「断言取了改错也会一样的值」。
    assert.match(r.message, /没醒成|打盹还在/, '失败原因不对（' + r.message + '）—— 说明它根本没进打盹分支')
    assert.ok(existsSync(join(d, '打盹.json')), '测试前提被破坏：档不该被删')
  } finally {
    for (const [f, v] of 守) assert.equal(指纹(join(真档, f)), v, f + ' 被写真档了')
    rmSync(d, { recursive: true, force: true })
    rmSync(假, { recursive: true, force: true })
  }
})

// 这一条锁的是批次558 加的复查不许被回退（在 .pre-561 上也是绿的，属回归保护）。
// 561 的新增在 B1/B2/B3。
test('B4 沙盒：「作息 --醒了」只打印不改标记 → 必须报失败', async () => {
  const d = 沙盒()
  const 守 = ['睡醒.json', '睡眠.json'].map((f) => [f, 指纹(join(真档, f))])
  const 假 = 假工具('作息.mjs', '去睡了')
  try {
    writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: true, since: '2026-11-16 09:20:16' }))
    process.env.QQ_AUTONOMY_MEM = d
    process.env.NAP_MEM = d
    process.env.ST_BASE = d
    process.env.QQ_SLEEP_MEM = d
    const { 醒过来 } = await import(LIB + '/sleep.js')
    const r = await 醒过来({ mem: d, tools: 假 })
    assert.equal(r.ok, false, '标记还是 true 却报了 ok:true')
  } finally {
    for (const [f, v] of 守) assert.equal(指纹(join(真档, f)), v, f + ' 被写真档了')
    rmSync(d, { recursive: true, force: true })
    rmSync(假, { recursive: true, force: true })
  }
})

test('B5 沙盒：本来就没睡也没打盹 → 如实说「本来就醒着」', async () => {
  const d = 沙盒()
  try {
    process.env.QQ_AUTONOMY_MEM = d
    process.env.NAP_MEM = d
    process.env.ST_BASE = d
    process.env.QQ_SLEEP_MEM = d
    const { 醒过来 } = await import(LIB + '/sleep.js')
    const r = await 醒过来({ mem: d })
    assert.equal(r.ok, false)
    assert.match(r.message, /本来就醒着/, '文案变了：' + r.message)
  } finally { rmSync(d, { recursive: true, force: true }) }
})
