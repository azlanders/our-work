// t556 —— 第四条叫醒路径：主人私聊 spawn 醒来.mjs（批次555）
//
// 之前我只数了三条（endSleep / 作息--醒了 / 工作.mjs），漏了这条：
//
//   poll.js:2688   spawn('/usr/local/bin/node', [`${TOOLS}/醒来.mjs`], { detached: true, stdio: 'ignore' })
//
// 它 **不带参数、detached、stdio ignore、没有超时** —— 外面完全看不见它跑到哪一步，
// 也看不见它什么时候才真的执行到 `作息 --醒了`。
//
// 实测线索：她 08:39:34 睡下、08:44:22 就被结束（5 分钟），而 `最近说话.json` 里
// 主人最后一次开口是 08:39:13 —— 中间隔了 5 分钟。spawn 是异步的，
// `醒来.mjs` 要跑 计划/穿衣/早间简报 一串，慢起来几分钟才走到关段那一步。
//
// 这一批不判断它对不对（主人找她、她该醒来，是批次110 定的），
// 只让**它报自己的名字**：spawn 时传 QQ_WAKE_BY，`作息 --醒了` 写进 醒来.log。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'

const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 工具 = '{{BOT_ROOT}}/共享/工具'

test('P1 poll.js 私聊叫醒要传 QQ_WAKE_BY', () => {
  const s = readFileSync(插件 + '/poll.js', 'utf8')
  assert.match(s, /QQ_WAKE_BY: '主人私聊 '/, '没传叫醒人')
  // spawn 的选项里必须有 env，否则就是继承一个干净环境、什么都看不到
  assert.match(s, /const c = spawn\('\/usr\/local\/bin\/node', \[`\$\{TOOLS\}\/醒来\.mjs`\], \{\s*\n\s*detached: true,\s*\n\s*stdio: 'ignore',\s*\n\s*env:/,
    'spawn 没有 env')
})

test('P2 作息 --醒了 要把「叫醒人」写进日志', () => {
  const s = readFileSync(工具 + '/作息.mjs', 'utf8')
  assert.match(s, /叫醒人=/, '日志里没有叫醒人')
  assert.match(s, /process\.env\.QQ_WAKE_BY/, '没读 QQ_WAKE_BY')
})

test('P3 醒来.mjs 传给 作息 的是 process.env 的副本（QQ_WAKE_BY 不能丢）', () => {
  const s = readFileSync(工具 + '/醒来.mjs', 'utf8')
  // 别按「离 --醒了 多少字符」截 —— 批次556 给那段加了长注释，窗口一开就截不到（当场红过）。
  // 直接认那一行：它必须带 ...process.env（不然 QQ_WAKE_BY 传不下去）。
  assert.match(s, /env: \{ \.\.\.process\.env, QQ_SETTLED: '1', QQ_SLEEP_MEM: MEM \}/,
    '没继承 process.env —— 叫醒人会丢')
})

test('P4 四条叫醒路径现在都有名字了', () => {
  // 1. endSleep       → SHORT_WAKE_TRACE
  // 2. 作息 --醒了    → WAKE_TRACE + 父进程 + 叫醒人
  // 3. 工作.mjs       → WHO_WAKE
  // 4. 自动作息       → WHO_WAKE
  // 5. poll.js 私聊   → QQ_WAKE_BY（这一批）
  const 检查 = [
    ['睡眠阶段.mjs', /SHORT_WAKE_TRACE/],
    ['作息.mjs', /WAKE_TRACE/],
    ['工作.mjs', /WHO_WAKE/],
    ['自动作息.mjs', /WHO_WAKE/],
  ]
  for (const [f, re] of 检查) {
    assert.match(readFileSync(工具 + '/' + f, 'utf8'), re, f + ' 的留痕没了')
  }
  assert.match(readFileSync(插件 + '/poll.js', 'utf8'), /QQ_WAKE_BY/, 'poll.js 的留痕没了')
})
