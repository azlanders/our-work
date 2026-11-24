// t554 —— 三条叫醒的路，都要留下「是我干的」（批次553）
//
// 她一晚上被结束 7 次（最短 30 秒），批次544/550b 加的调用栈只能证明
// 「是 作息--醒了 干的」，**看不见是谁调的** —— 因为那是顶层执行，
// 父进程不在 JS 栈里，`/proc/<ppid>/cmdline` 也只能到「是谁 exec 的」那一层。
//
// 所以每一条能叫醒她的路都自己报一声。三条：
//   1. `endSleep`（睡眠阶段.mjs）—— SHORT_WAKE_TRACE（批次544）
//   2. `作息 --醒了` —— WAKE_TRACE + 父进程 + 拒绝结束（批次550b/552）
//   3. `工作.mjs` 的 `醒一次()` 和 `自动作息.mjs` 调 `--醒了` 之前 —— WHO_WAKE（批次553）
//
// 四条都写同一个 `日志/醒来.log`，格式都以北京时间开头，一眼能排时间线。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const 工具 = '{{BOT_ROOT}}/共享/工具'

test('W1 工作.mjs 的 醒一次 要留痕（它是「工作」那条路唯一的叫醒口）', () => {
  const s = readFileSync(工具 + '/工作.mjs', 'utf8')
  assert.match(s, /WHO_WAKE/, '注释头没了')
  assert.match(s, /工作\.mjs 要叫醒她/, '没写日志')
  assert.match(s, /动作: ' \+ 动作名/, '日志里没有「是哪个动作触发的」')
  // 位置必须在对 叫醒() 的调用之前
  const i = s.indexOf('工作.mjs 要叫醒她')
  const j = s.indexOf('return 叫醒()', i)
  assert.ok(i > 0 && j > i, '日志写在了 叫醒() 之后 —— 那样失败时不落盘')
})

test('W2 自动作息 调 --醒了 之前也要留痕', () => {
  const s = readFileSync(工具 + '/自动作息.mjs', 'utf8')
  assert.match(s, /自动作息 要叫醒她/, '没写日志')
  const i = s.indexOf('自动作息 要叫醒她')
  const j = s.indexOf("'--醒了'", i)
  assert.ok(i > 0 && j > i, '日志写在了调 --醒了 之后')
})

test('W3 自动作息 里不许出现 bj(now) —— 那个文件没有 bj', () => {
  // node --check 只查语法不查未定义变量；这段又包在 try/catch 里，
  // ReferenceError 会被吞成「日志一辈子不写」。批次553 我第一次就写错了。
  const s = readFileSync(工具 + '/自动作息.mjs', 'utf8')
  const 真调用 = s.split('\n').filter((ln) => /[^/]*\bbj\s*\(/.test(ln) && !ln.trim().startsWith('//'))
  assert.deepEqual(真调用, [], '自动作息 里出现了 bj(...)，但它没有这个函数：\n' + 真调用.join('\n'))
})

test('W4 四条叫醒路径都写同一个 醒来.log', () => {
  const 阶段 = readFileSync(工具 + '/睡眠阶段.mjs', 'utf8')
  const 作 = readFileSync(工具 + '/作息.mjs', 'utf8')
  const 工 = readFileSync(工具 + '/工作.mjs', 'utf8')
  const 自 = readFileSync(工具 + '/自动作息.mjs', 'utf8')
  for (const [名, s] of [['睡眠阶段', 阶段], ['作息', 作], ['工作', 工], ['自动作息', 自]]) {
    assert.ok(s.includes('醒来.log'), 名 + ' 不写 醒来.log')
  }
})

test('W5 作息 --醒了 的门卫还在（10 分钟 + QQ_SETTLED 豁免）', () => {
  const s = readFileSync(工具 + '/作息.mjs', 'utf8')
  assert.match(s, /__分钟0 < 10 && process\.env\.QQ_SETTLED !== '1'/, '门卫没了')
  assert.match(s, /拒绝结束/, '拒绝时没留痕')
})
