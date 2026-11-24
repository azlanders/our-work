import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// ⑭「昵称缓存一直是空的」查了三次都只能靠猜 —— 因为 refreshNicknames 的 catch 是空的：
// 失败一点痕迹都不留。批次430 加了三处 note + 一个可观测出口 nicknameStats()。
// 同批还发现：冒烟1b 是把每个 .mjs 当 CLI 真跑一遍，做梦.mjs 因此往**真档**写日志
// （批次415 加 ppid 留痕后才看清「07:02 谁在调」是我自己跑全套）。
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const POLL = LIB + '/poll.js'
const CONFIG = LIB + '/config.js'
const 冒烟 = '{{BOT_ROOT}}/共享/工具/测试/冒烟1b.加载.test.mjs'
const LOAD_LOG = '{{DSH_ROOT}}/qq-bridge-load.log'

test('N1 昵称刷新失败必须留痕，不能再是空 catch', () => {
  const s = readFileSync(POLL, 'utf8')
  // 昵称那一段：从 refreshNicknames 开始到 nicknameStats 之前
  const 起 = s.indexOf('export async function refreshNicknames')
  const 止 = s.indexOf('function nicknameStats')
  assert.ok(起 > 0 && 止 > 起, '昵称那两段不见了')
  const 段 = s.slice(起, 止)
  assert.match(段, /note\('api', '昵称刷新失败/, '外层 catch 又没留痕了')
  assert.match(段, /note\('api', 'group_member_list 失败/, '群成员那层又没留痕了')
  // 返回 retcode 0 但列表为空 —— 最难查的一种，也要有痕迹
  assert.match(段, /一条好友都没有/, '「拿到 0 条」这种情况没留痕')
})

test('N2 刷新完还是 0 条也要留痕（原来这里是动态判据，删了）', () => {
  // 第一版这条是「跑一次真实刷新，读日志新增，断言里面没有失败」——**判据天生是错的**：
  // qq-bridge-load.log 是所有进程共享的一个文件，并行跑测试时别人写的一条 403 会被算到自己头上
  // （批次433 就是这么红的：t433 的 voiceHintOf 触发了一次空 token 刷新）。
  // 而且失败本身不一定是问题（NapCat 抖动、重启窗口都会 403），真正要钉的是「不许静默」——
  // 那条已经由 N1 的静态断言覆盖。这里只补一件事：刷新完还是 0 条时，finally 里得说一句。
  const s = readFileSync(POLL, 'utf8')
  const 起2 = s.indexOf('function maybeRefreshNicknames')
  const 段 = s.slice(起2, 起2 + 1200)
  assert.match(段, /昵称刷新完还是 0 条/, '刷新完 0 条时又不出声了')
  assert.match(段, /if \(st\.size === 0\)/, '判断写丢了')
})

test('N3 冒烟1b 跑脚本时，做梦.mjs 的日志必须落在沙盒里', () => {
  // 冒烟是「把每个 .mjs 当 CLI 跑一遍」，做梦.mjs 的 main 会写真档 记忆/日志/做梦.log。
  // 不设 DREAM_MEM，跑一次全套就往真档塞一行 —— 真档日志是她的账，不该被测试改写。
  const s = readFileSync(冒烟, 'utf8')
  assert.match(s, /环境\.DREAM_MEM = 沙/, '冒烟没把做梦的记忆目录指到沙盒')
  assert.match(s, /环境\.DREAM_LOGS = /, '冒烟的群聊日志目录没设（默认会去读真档）')
})

test('N4 睡眠阶段 spawn 做梦时不该动 DREAM_LOGS（那是群聊日志目录，只读）', () => {
  // 批次431 第一版就在这里改错了：以为 DREAM_LOGS 是「写日志的地方」，
  // 实际它是做梦读群聊记录的目录 —— 改了指到沙盒，梦就没有群聊素材了。
  const s = readFileSync('{{BOT_ROOT}}/共享/工具/睡眠阶段.mjs', 'utf8')
  assert.doesNotMatch(s, /DREAM_LOGS:/, '又把 DREAM_LOGS 传进去了（它是只读的群聊日志目录）')
})
