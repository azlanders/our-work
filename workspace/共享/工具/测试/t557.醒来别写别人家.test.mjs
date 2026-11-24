// t557 —— 醒来.mjs 硬编码读线上真档，任何测试 spawn 它都会写真档（批次556）
//
// 追「谁在半夜叫醒她」时在这个坑里绕了很久：
//   `醒来.mjs` 里有 **7 处**写死的 `{{BOT_ROOT}}/记忆/...` —— 它根本不走 ST_BASE。
//   而 `t353` 正是 spawn 它来测「醒来加衣」的（设了 QQ_SLEEP_MEM，可这个脚本一个字都不看）。
//   更糟的是 `t353` 的「真档指纹」只盯 资产/穿着/天气/状态 四个文件，
//   **没盯 睡醒.json / 睡眠.json**，写真档了也看不见。
//
// 第二处泄漏更隐蔽：`醒来.mjs` 调 `作息.mjs --醒了` 时只传了 QQ_SETTLED，
// 而 `作息` 的 base 是 `QQ_SLEEP_MEM || 真档`（它**不认 ST_BASE**）。
// 于是「设了 ST_BASE 的调用方」以为在沙盒里，`作息` 那一句却写真档 ——
// 实测 09:09 跑一次沙盒验证，真档 睡醒.json 的 since 就从 08:39:34 被改成了 09:09。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const 工具 = '{{BOT_ROOT}}/共享/工具'

test('R1 醒来.mjs 不许再有硬编码的记忆路径（只许留在 MEM 的定义里）', () => {
  const s = readFileSync(工具 + '/醒来.mjs', 'utf8')
  const 行们 = s.split('\n')
  const 违规 = 行们
    .map((ln, i) => ({ ln, i: i + 1 }))
    .filter(({ ln }) => !ln.trim().startsWith('//') && !ln.trim().startsWith('*'))
    // 注意**不带末尾斜杠** —— 第一版写的是 `记忆/`，于是 `const 目录 = '{{BOT_ROOT}}/记忆'`
    // 这种（正好以记忆结尾、没有斜杠）漏过去了，反向验证当场没红。
    .filter(({ ln }) => ln.includes("'{{BOT_ROOT}}/记忆"))
  // MEM 的定义那一行本身允许
  const 真违规 = 违规.filter(({ ln }) => !ln.includes('process.env.ST_BASE'))
  assert.deepEqual(真违规, [], '这些行还写死真档路径：\n' +
    真违规.map((x) => x.i + ': ' + x.ln.trim().slice(0, 70)).join('\n'))
})

test('R2 MEM 的优先级：ST_BASE → QQ_SLEEP_MEM → 真档（两个沙盒变量都要认）', () => {
  const s = readFileSync(工具 + '/醒来.mjs', 'utf8')
  assert.match(s, /const MEM = process\.env\.ST_BASE \|\| process\.env\.QQ_SLEEP_MEM \|\| '\/data\/bot-workspace\/记忆'/,
    'MEM 的定义变了')
  // 并且要顺手把 ST_BASE 对齐 —— 睡眠阶段.mjs 读的是它
  assert.match(s, /if \(MEM !== '\/data\/bot-workspace\/记忆' && !process\.env\.ST_BASE\) process\.env\.ST_BASE = MEM/,
    '没把 ST_BASE 对齐，endSleep 会读写两套目录')
})

test('R3 调 作息 --醒了 时必须把 QQ_SLEEP_MEM 传下去', () => {
  const s = readFileSync(工具 + '/醒来.mjs', 'utf8')
  // 别按「离 --醒了 多少字符」去截 —— 那段注释很长，窗口一开就截不到。
  // 直接认那一行（两个变量必须同一个 env 里传下去）。
  assert.match(s, /env: \{ \.\.\.process\.env, QQ_SETTLED: '1', QQ_SLEEP_MEM: MEM \}/,
    '没在同一次调用里传 QQ_SLEEP_MEM —— 作息 会写真档（这个漏点实测污染过一次）')
  // 而且真的调了 作息 --醒了（别写复杂正则，字符串够了）
  assert.ok(s.includes("'--醒了'"), '没有调 作息 --醒了？')
})

test('R4 提前写镜像必须排在 endSleep 之前（否则「叫醒」又被做梦/激素拖几十秒）', () => {
  const s = readFileSync(工具 + '/醒来.mjs', 'utf8')
  const i镜像 = s.indexOf('提前醒于')
  const i结束 = s.indexOf("endSleep('woken')")
  assert.ok(i镜像 > 0, '提前写镜像那段没了')
  assert.ok(i结束 > 0)
  assert.ok(i镜像 < i结束, '提前写镜像写在了 endSleep 之后 —— 那等于没提前')
})

test('R5 提前写的是镜像（睡醒.json），不许碰 睡眠.json', () => {
  const s = readFileSync(工具 + '/醒来.mjs', 'utf8')
  const i = s.indexOf('WAKE_EARLY_FLAG')
  const 段 = s.slice(i, i + 1800)
  assert.match(段, /睡醒\.json/, '提前写的不是镜像')
  assert.equal(/写档\([^)]*睡眠\.json/.test(段), false, '提前写了 睡眠.json —— 那是批次418 明确避开的半截盘')
})
