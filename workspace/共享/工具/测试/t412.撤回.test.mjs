// t412 —— 撤回：一个写好了两个月、一次都没被调过的能力（批次407）
//
// 病根三条，全是「只写了功能，没有系统接入」：
//   1) 共享/工具/撤回.mjs 是 2026-11-01 写的：撤 --last、记 撤回.json、按原因往
//      状态.json 写一笔余波。可全仓 grep 下来**它一次都没被任何人调过**，
//      29 个 qq_* 工具里也没有撤回 —— 她说完「我这条撤了」的时候手上没有这条腿。
//      （2026-11-14 05:12 私聊里就是这么说的，那条消息一直挂着。）
//   2) 它 --last 传的是 `group_id: Number(...)`，而 HTTP 那条路走 NapCat 的 JSON schema，
//      实测直接 400「Schema compilation error: Expected string」—— 群里 --last 从来没通过。
//      （WS 的 callOneBot 两种都收，所以 poll.js 传 Number 一直没事，容易照抄错。）
//   3) 只有群历史，私聊没写。她最常想撤的恰恰是私聊里说错的那句。
//
// 这个文件锁：
//   R1 私聊分支能走通（不存在的号 → 明说「没跟他说过话」，不是崩）
//   R2 群的 group_id 必须是 string（假群号也不许出 schema 错）
//   R3 --list 在空账上说人话
//   R4 RECALL_MEM 沙盒：单测不许碰真实 撤回.json / 状态.json
//   R5 余波强度按原因定（说错了 3 / 说重了 2 / 发错地方 1 / 手滑了 1）
//   R6 线上真的接上了：qq_unsend 注册 + index.js 调用 + qq_send 描述指路
//   R7 qq_unsend 的三种 argv（--id / --group / --私聊）
//
// 跑法：node --test t412.撤回.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const CLI = join(TOOLS, '撤回.mjs')
const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/'
const 读 = (p) => readFileSync(p, 'utf8')
const 沙 = mkdtempSync(join(tmpdir(), 'recall412-'))

function 跑(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, RECALL_MEM: 沙 },
    timeout: 20000,
  }).trim()
}

test('R1 私聊分支能走通（不存在的号 → 明说没说过话）', () => {
  const out = 跑(['--last', '--私聊', '999999'])
  // 「桥没连上」也算走通：NapCat 挂着的时候（二号机现在就是静音）不该甩一段 undici 堆栈给她。
  assert.ok(/没跟他说过话|没得撤|桥没连上/.test(out), '私聊分支没走到该走的话上：' + out)
  assert.ok(!/TypeError|at node:|undici/.test(out), '私聊分支崩了：' + out)
})

test('R2 群的 group_id 必须是 string（假群号也不许出 schema 错）', () => {
  // 用不存在的群号：这条路径撤不了任何东西，只验 schema。
  const out = 跑(['--last', '--group', '100000001'])
  assert.ok(!/Schema compilation/.test(out), 'group_id 又传成 Number 了：' + out)
  assert.ok(/没说过话|没得撤|没撤成|桥没连上/.test(out), '假群号的回话看不懂：' + out)

  const 源 = 读(CLI)
  assert.ok(/get_group_msg_history', \{ group_id: String\(groupId\)/.test(源),
    'group_id 不是 String（HTTP 的 schema 要 string）')
  assert.ok(!/get_group_msg_history', \{ group_id: Number\(/.test(源),
    '还留着 Number 的写法')
})

test('R3 --list 在空账上说人话', () => {
  const out = 跑(['--list'])
  assert.equal(out, '还没撤回过')
})

test('R4 RECALL_MEM 沙盒：不碰真实的 撤回.json / 状态.json', () => {
  // 文件不存在（二号机从没撤过）时拿 null 比对 —— null === null 也算「没被改」。
  const m = (p) => { try { return statSync(p).mtimeMs } catch { return null } }
  const 真1 = '{{BOT_ROOT}}/记忆/撤回.json'
  const 真2 = '{{BOT_ROOT}}/记忆/状态.json'
  const m1 = m(真1)
  const m2 = m(真2)
  跑(['--last', '--私聊', '999999'])
  跑(['--list'])
  assert.equal(m(真1), m1, '真实 撤回.json 被测试改了')
  assert.equal(m(真2), m2, '真实 状态.json 被测试改了')
})

test('R5 余波强度按原因定，不按字面猜', () => {
  const 源 = 读(CLI)
  assert.ok(/余波表 = \{ 说错了: 3, 说重了: 2, 发错地方: 1, 手滑了: 1 \}/.test(源),
    '余波表不见了或者被改乱了 —— 四个 reason 必须是 3/2/1/1')
  // 「说重了」是伤到人，不该跟「手滑」一样轻；「发错地方」是手滑，不该跟「说错了」一样重。
  // 老那套按字面 includes('错') 猜的兜底留着没坏，但必须先查表 —— 查表在前才算数。
  assert.ok(/const strength = 余波表\[why\] \?\?/.test(源),
    'strength 还是纯按字面猜 —— 说重了会被判成 1（跟手滑一样），说错地方会被判成 3')
})

test('R6 线上真的接上了', () => {
  const tool = 读(插件 + 'tool.js')
  const idx = 读(插件 + 'index.js')
  assert.ok(/name: 'qq_unsend'/.test(tool), 'tool.js 里没有 qq_unsend')
  assert.ok(/export async function registerUnsendTool/.test(tool), '没有 registerUnsendTool')
  // import 里后来还加了别的工具（registerSelfTool 等），所以不能钉死「registerUnsendTool }」
  // 这个结尾 —— 只要那个 import 语句的花括号里包含它就算接上了。
  assert.ok(/import\s*\{[^}]*\bregisterUnsendTool\b[^}]*\}\s*from '\.\/tool\.js'/.test(idx), 'index.js 没 import')
  // ^ + m：防止「注释掉也算接上了」—— 反测时就是这么漏过一次
  assert.ok(/^\s*void registerUnsendTool\(ctx\)/m.test(idx), 'index.js 没真的调用（可能被 // 注释掉了）')
  // 新能力必须进提示：她得知道有这条腿，也不知道就永远想不起来
  assert.ok(/两分钟/.test(tool) && /只撤你自己的/.test(tool), 'qq_unsend 的描述没说清时限和范围')
  assert.ok(/(两分钟内调 qq_unsend 撤|调 qq_unsend 两分钟内撤)/.test(tool), 'qq_send 的描述没指路 —— 她说完才想起来就晚了')
})

test('R7 qq_unsend 的三种 argv', () => {
  const 源 = 读(插件 + 'tool.js')
  assert.ok(/if \(id !== ''\) argv\.push\('--id', id\)/.test(源), '--id 分支不见了')
  assert.ok(/else if \(gid !== ''\) argv\.push\('--last', '--group', gid\)/.test(源), '--group 分支不见了')
  assert.ok(/else argv\.push\('--last', '--私聊', uid !== '' \? uid : String\(getConfig\(\)\.ownerUin/.test(源),
    '--私聊 分支不见了（默认该落到主人）')
  // 理由必须给，且只能是那四个之一
  assert.ok(/required: \['why'\]/.test(源), 'why 不是必填')
  assert.ok(/enum: \['说错了', '说重了', '发错地方', '手滑了'\]/.test(源), 'why 的枚举跟 撤回.mjs 的余波表对不上')
})
