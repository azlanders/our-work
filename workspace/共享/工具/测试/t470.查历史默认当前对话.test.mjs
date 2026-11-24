// t470 qq_msg_history 不给号时要默认查「当前这段对话」
//
// 起因（批次470）：工具里原来是
//   if (groupId === '' && userId === '') throw new Error('要查历史，得给 group_id…')
// 她 5 次调用全踩这个（`{"count":12}` / `{"count":15}`）—— 她以为「查历史」默认就是当前对话。
// 而 targetOf() 早就有兜底（这一回合刚投给谁 → 配置里的默认私聊），别的工具都在用。
//
// 跑法：node --test t470.查历史默认当前对话.test.mjs
// 每个场景起**子进程**：config.js 是模块级单例、DATA_DIR 在 import 时就定了，
// 同一进程里换配置必须靠"新进程 + 先设 DSH_DATA"，用 query 破缓存只会让 tool.js
// 和它 import 的 config.js 变成两个实例（第一版就这么红的）。
//
// 全程 DSH_DATA 指到沙盒，不碰她的 qq-bridge.config.json。

process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 源 = readFileSync(join(LIB, 'tool.js'), 'utf8')

const 子进程脚本 = `
const L = ${JSON.stringify(LIB)}
const cfg = await import(L + '/config.js')
if (typeof cfg.loadConfig === 'function') cfg.loadConfig()
const tool = await import(L + '/tool.js')
const defs = []
const tools = { register(d) { defs.push(d); return () => {} } }
const ctx = { tools, get: (k) => (k === 'tools' ? tools : undefined), effect() {}, log() {} }
await tool.registerHistoryTool(ctx)
const d = defs.find((x) => x && x.name === 'qq_msg_history')
if (!d) { console.log(JSON.stringify({ ok: false, msg: 'NO_TOOL' })); process.exit(0) }
try {
  const r = await d.execute({ count: 2 })
  console.log(JSON.stringify({ ok: true, 条数: (r && r.count) || 0 }))
} catch (e) {
  console.log(JSON.stringify({ ok: false, msg: String((e && e.message) || e) }))
}
`

/** 造沙盒配置并跑一次 execute，返回 {ok, msg?} */
function 跑一次(配置) {
  const 沙 = mkdtempSync(join(tmpdir(), 't470-'))
  try {
    writeFileSync(join(沙, 'qq-bridge.config.json'), JSON.stringify(配置), 'utf8')
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', 子进程脚本], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, DSH_DATA: 沙, QUIET_NOTE: '1' },
    })
    const i = out.lastIndexOf('{"')
    return JSON.parse(out.slice(i))
  } finally { rmSync(沙, { recursive: true, force: true }) }
}

test('A1 源码：不再自己 throw「必须给号」，改用 targetOf 兜底', () => {
  assert.ok(/const target = targetOf\(args\)/.test(源), '没走 targetOf —— 不给号还是会直接报错')
  assert.ok(!/'要查历史，得给 group_id/.test(源), '旧的严格报错还在')
})

test('A2 描述要说清「不传号就翻当前这段对话」', () => {
  const i = 源.indexOf("name: 'qq_msg_history'")
  assert.ok(i > 0, '没找到 qq_msg_history')
  const 段 = 源.slice(i, i + 800)
  assert.match(段, /(省略即可|不传号就翻)/, '描述没告诉她可以不传号')
})

test('A3 端到端：只给 count、配置里有默认私聊 → 必须过了那道闸', () => {
  const r = 跑一次({ selfUin: 3556352474, ownerUin: 1000000001, peerUin: 1000000001 })
  if (!r.ok) {
    assert.ok(!/不知道要查哪个会话/.test(r.msg),
      '配置里写着默认私聊，却还说不知道查哪个会话：' + r.msg)
  }
})

test('A4 端到端：配置里没有默认对象、也没给号 → 报错要说清怎么给', () => {
  const r = 跑一次({ selfUin: 3556352474 })
  assert.equal(r.ok, false, '什么都没给却成功了，说明它在乱查某个会话')
  assert.match(String(r.msg), /(未绑定 QQ 对话|group_id)/, '报错没说清原因：' + r.msg)
})
