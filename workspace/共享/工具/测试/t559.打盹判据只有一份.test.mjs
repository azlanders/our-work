// t559 —— 同一个 打盹.json，两处判据给出了相反的答案（批次559）
//
// 追「08:00 眯到 08:33 → 08:03 又眯到 08:36」时发现的：
//   · `睡态.mjs` 的 打盹中() 读 `Number(n.到毫秒) || 解析北京(n.到, 0)` —— 认 到毫秒
//   · `打盹.mjs` 的 `--tick` 只认 `到`，而且是 16 字符的 `YYYY-MM-DD HH:MM`
// 两处判据分叉。更糟的是 `--tick` 拿到 NaN 时**直接 unlinkSync** ——
// `到` 里多一个 `:00`（带秒）她就在第 0 分钟「醒了」，而且一个字都不记。
//
// 全项目的其他时间解析（_底层.解析北京 / 作息.toMs / 自动作息.toMs）都认带秒，
// 只有这里不认。批次413 的「元」被静默丢是同一类：解析器只认一种写法，另一种静默失效。
import { test, after } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => readFileSync(p, 'utf8')
const 指纹 = (p) => { try { const s = statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return '(无)' } }
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const bj分 = (ms) => bj(ms).slice(0, 16)

function 沙盒() {
  const d = mkdtempSync(join(tmpdir(), 't559-'))
  writeFileSync(join(d, '自主.json'), JSON.stringify({ state: '打瞌睡', since: Date.now() }))
  return d
}

function 跑(d, argv) {
  const r = spawnSync(process.execPath, [join(工具, '打盹.mjs'), ...argv], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, NAP_MEM: d, QQ_AUTONOMY_MEM: d, ST_BASE: d, QQ_SLEEP_MEM: d, QQ_SLEEPY_MEM: d },
  })
  return String((r.stdout || '') + (r.stderr || '')).trim()
}

test('A1 带秒的时间要认 —— 用 _底层.解析北京，不许自己再写一份只认 16 字符的', () => {
  const 底 = 读(工具 + '/_底层.mjs')
  assert.match(底, /else if \(\/\^\\d\{4\}-\\d\{2\}-\\d\{2\}T\\d\{2\}:\\d\{2\}\$\/\.test\(t\)\) t \+= ':00'/,
    '解析北京 不再认 16 字符（补 :00）')
  const 睡 = 读(工具 + '/睡态.mjs')
  // 判据搬家之后是「睡态 用 解析北京」，不是「打盹 自己写正则」。
  // 这条别写成找某个正则字符串 —— 再搬一次家就同时红（t539/t550 的坑）。
  assert.match(睡, /const 到 = 解析北京\(n\['到'\], 0\)/, '盹到点 没用 解析北京')
})

test('A2 「到点」按三级取：到毫秒 → 到 → 开始+分钟，判据只有 睡态.盹到点 一份', () => {
  const 睡 = 读(工具 + '/睡态.mjs')
  const i = 睡.indexOf('export function 盹到点')
  assert.ok(i > 0, '睡态.mjs 里没有 盹到点')
  const 段 = 睡.slice(i, i + 800)
  assert.match(段, /Number\(n\['到毫秒'\]\)/, '没优先认 到毫秒（打盹中 一直认它）')
  assert.match(段, /解析北京\(n\['到'\], 0\)/, '没认 到')
  assert.match(段, /解析北京\(n\['开始'\], 0\)/, '没拿 开始+分钟 兜底')
  // 打盹.mjs 不许再留一份本地的
  const 盹 = 读(工具 + '/打盹.mjs')
  assert.ok(!盹.includes('const 盹到 ='), '打盹.mjs 又留了一份本地判据')
  assert.ok(!盹.includes('const parseBJ'), '打盹.mjs 又自己解析时间了（解析器只认一种写法就会静默失效）')
})

test('A3 打盹.mjs 的三个入口都走 睡态.盹到点', () => {
  const 盹 = 读(工具 + '/打盹.mjs')
  assert.ok(盹.includes("import { 盹到点 } from './睡态.mjs'"), '没 import 盹到点')
  // --开始 的防重入、--tick（判 + 记日志里的起）、--看看
  const n = (盹.match(/盹到点\(/g) || []).length
  assert.ok(n >= 4, '盹到点 只用了 ' + n + ' 处（import 那行不算，至少 开始 1 + tick 2 + 看看 1）')
})

test('A4 删 打盹.json 之前必须留一行原值（查重复打盹只靠它）', () => {
  const s = 读(工具 + '/打盹.mjs')
  const i = s.indexOf("args.includes('--tick')")
  assert.ok(i > 0)
  const 段 = s.slice(i, i + 2600)
  assert.ok(段.includes('打盹.log'), '--tick 删档前没写日志')
  assert.ok(段.includes('原值 到='), '没记原值')
  // 日志必须在 unlink 之前（删完再记就晚了）
  assert.ok(段.indexOf('打盹.log') < 段.indexOf('unlinkSync(P)'), '日志写在 unlink 之后了')
})

test('B1 沙盒：只有 到毫秒、没有 到 → 还在打盹，不许删', () => {
  const d = 沙盒()
  try {
    const 将来 = Date.now() + 20 * 60e3
    // 只写 到毫秒（面板/自检/老版本都可能这么写）
    writeFileSync(join(d, '打盹.json'), JSON.stringify({ 开始: bj分(Date.now()), 到毫秒: 将来, 分钟: 20 }))
    const out = 跑(d, ['--tick'])
    assert.match(out, /还在打盹/, '只有 到毫秒 就被判到点了（输出：' + out + '）')
    assert.ok(existsSync(join(d, '打盹.json')), '打盹.json 被删了')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B2 沙盒：到 带秒且没过期 → 还在打盹（改之前这条会在第 0 分钟就醒）', () => {
  const d = 沙盒()
  try {
    const 将来 = Date.now() + 20 * 60e3
    writeFileSync(join(d, '打盹.json'), JSON.stringify({ 开始: bj(Date.now()), 到: bj(将来), 到毫秒: 将来, 分钟: 20 }))
    const out = 跑(d, ['--tick'])
    assert.match(out, /还在打盹/, '带秒的 到 被判成到点了（输出：' + out + '）')
    assert.ok(existsSync(join(d, '打盹.json')), '打盹.json 被删了')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B3 沙盒：真到点 → 删档、把 自主.state 从「打瞌睡」扶正、日志写出眯了多久', () => {
  const d = 沙盒()
  try {
    const 起 = Date.now() - 22 * 60e3
    writeFileSync(join(d, '打盹.json'), JSON.stringify({ 开始: bj(起), 到: bj(Date.now() - 60e3), 分钟: 21, 开始毫秒: 起, 到毫秒: Date.now() - 60e3 }))
    const out = 跑(d, ['--tick'])
    assert.match(out, /打盹到点/, '没醒（输出：' + out + '）')
    assert.ok(!existsSync(join(d, '打盹.json')), '打盹.json 没删')
    const 自 = JSON.parse(读(join(d, '自主.json')))
    assert.equal(自.state, '待命', '自主.state 还挂着打瞌睡（她会被判「在打盹」卡住）')
    const log = 读(join(d, '日志', '打盹.log'))
    assert.match(log, /眯了 2[12] 分钟/, '日志没写眯了多久：' + log)
    assert.match(log, /原值 到=/, '日志没记原值')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B4 沙盒：到 带秒且还没到 → --开始 必须挡住（不许把到点往后推）', () => {
  const d = 沙盒()
  try {
    const 将来 = Date.now() + 20 * 60e3
    writeFileSync(join(d, '打盹.json'), JSON.stringify({ 开始: bj(Date.now()), 到: bj(将来), 到毫秒: 将来, 分钟: 20 }))
    const out = 跑(d, ['--开始', '33', '测试'])
    assert.match(out, /已经在打盹/, '没挡住，又把到点往后推了（输出：' + out + '）')
    const 后 = JSON.parse(读(join(d, '打盹.json')))
    assert.equal(后.分钟, 20, '分钟被改成 ' + 后.分钟 + ' —— 到点被重写了')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B5 沙盒：打盹.mjs 和 睡态.mjs 对同一份文件必须同口径（4 组边界）', async () => {
  const { 打盹中 } = await import(工具 + '/睡态.mjs')
  const d = 沙盒()
  const 组 = [
    ['只有 到毫秒（未来）', { 开始: bj分(Date.now()), 到毫秒: Date.now() + 15 * 60e3, 分钟: 15 }, true],
    ['到 带秒（未来）', { 开始: bj(Date.now()), 到: bj(Date.now() + 15 * 60e3), 分钟: 15 }, true],
    ['只有 开始+分钟（未来）', { 开始: bj分(Date.now() - 60e3), 分钟: 15 }, true],
    ['真过期', { 开始: bj(Date.now() - 40 * 60e3), 到: bj(Date.now() - 60e3), 分钟: 30 }, false],
  ]
  try {
    for (const [名, 档, 应打盹] of 组) {
      writeFileSync(join(d, '打盹.json'), JSON.stringify(档))
      const 睡态说 = 打盹中(d)
      const 脚本说 = 跑(d, ['--看看'])
      const 脚本打盹 = /^打盹中：/.test(脚本说)
      assert.equal(睡态说, 应打盹, '睡态.打盹中 对「' + 名 + '」判成 ' + 睡态说)
      assert.equal(脚本打盹, 应打盹, '打盹.mjs --看看 对「' + 名 + '」判成 ' + 脚本打盹 + '（输出：' + 脚本说 + '）')
    }
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A5 自主行动 的到点必须从 打盹.json 读回，不许自己 Date.now()+分钟', () => {
  const s = 读(工具 + '/自主行动.mjs')
  assert.ok(s.includes("import { 盹到点 } from './睡态.mjs'"), '没 import 盹到点')
  const i = s.indexOf("'--开始'")
  assert.ok(i > 0, '找不到打盹 --开始 的调用')
  const 段 = s.slice(i, i + 1800)
  assert.match(段, /盹到点\(__盹\)/, '没读回真实到点')
  // 顺序：先读回、再赋值。反过来的话 napUntil 还是自己算的那个数
  const i读回 = 段.indexOf('盹到点(__盹)')
  const i赋 = 段.indexOf('napUntil =')
  assert.ok(i读回 > 0 && i赋 > 0 && i读回 < i赋, '顺序反了：先给 napUntil 赋值、再读回')
  // 撞上「已经在打盹」要留痕，否则 aut.log 里两条「打瞌睡」分不出是重开还是撞上
  assert.match(段, /已经在打盹/, '撞上已在打盹的情况没留痕')
})

test('A6 用到的 node:fs 具名函数必须都在 import 列表里（node --check 查不出这种）', () => {
  // 记忆里的坑：`node --check` 只查语法，`mkdirSync` 没 import 照样「语法 OK」，
  // 运行到那一行才 ReferenceError。批次560 我自己就在同一个文件上踩了一次。
  const s = 读(工具 + '/自主行动.mjs')
  const m = s.match(/import \{([^}]+)\} from 'node:fs'/)
  assert.ok(m, '找不到 node:fs 的 import')
  const 名单 = m[1].split(',').map((x) => x.trim())
  const 用 = new Set()
  const 候选 = ['readFileSync', 'writeFileSync', 'existsSync', 'appendFileSync', 'unlinkSync',
    'readdirSync', 'renameSync', 'mkdirSync', 'rmSync', 'statSync', 'copyFileSync']
  const re = new RegExp('\\b(' + 候选.join('|') + ')\\s*\\(', 'g')
  for (const x of s.matchAll(re)) 用.add(x[1])
  const 缺 = [...用].filter((x) => !名单.includes(x))
  assert.deepEqual(缺, [], '这些符号用了但没 import：' + 缺.join('、'))
})

// 真档防线：B1~B5 全靠 NAP_MEM / QQ_AUTONOMY_MEM，哪个 env 忘了设就会写她真档。
// 放在 after 里（不是在某个 test 里写 assert.ok(true) —— 那种恒真断言等于没有）。
const 真档守 = ['打盹.json', '自主.json', '睡醒.json', '睡眠.json'].map((f) => [f, 指纹(join(真档, f))])
after(() => {
  for (const [f, v] of 真档守) {
    assert.equal(指纹(join(真档, f)), v, f + ' 被写真档了 —— 沙盒变量漏了一个')
  }
})
