// t630 —— 长期记忆库（hippocampus）只读召回接入白名单：recall/trace 可用，remember 不放。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const CFG = process.env.QQ_BRIDGE_CONFIG || '/data/hajimi-dsh/qq-bridge.config.json'
const HIPPO = process.env.HIPPO_INDEX || '/data/hajimi-dsh/profiles/web/node_modules/dsh-hippocampus/index.js'

function 白名单() {
  const d = JSON.parse(readFileSync(CFG, 'utf8'))
  const w = d['工具白名单']
  assert.ok(Array.isArray(w) && w.length > 0, '工具白名单必须是非空数组')
  return w
}

test('H1 白名单接入 recall/trace，但不放写入型 remember', () => {
  const w = 白名单()
  assert.ok(w.includes('recall'), 'recall 不在白名单')
  assert.ok(w.includes('trace'), 'trace 不在白名单')
  assert.ok(!w.includes('remember'), 'remember 是写入型工具，不该下发给 QQ 回合')
})

test('H2 原有 qq_recall / qq_msg_history 仍在，白名单没有被缩水', () => {
  const w = 白名单()
  assert.ok(w.includes('qq_recall'))
  assert.ok(w.includes('qq_msg_history'))
  assert.ok(w.length >= 39, `白名单只剩 ${w.length} 个`)
})

// DEFAULTS_MATCH 2026-11-17（批次656，审计 P1-10）：
// 630 只往线上 qq-bridge.config.json 加了 recall/trace，代码里的 DEFAULTS 没加。
// 配置文件丢失或换机器时，她会突然失去「翻自己记忆」的能力 —— 而线上明明是开的。
// 默认值和线上不一致，这种偏差只在出事那天才暴露。
test('H3 DEFAULTS 里的工具白名单也有 recall/trace，且仍不含 remember', async () => {
  const LIB = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const { pathToFileURL } = await import('node:url')
  const mod = await import(pathToFileURL(LIB + '/config.js').href + '?t630=1')
  const def = mod.DEFAULTS ?? mod.default?.DEFAULTS
  assert.ok(Array.isArray(def?.工具白名单), 'config.js 里找不到 DEFAULTS.工具白名单')
  assert.ok(def.工具白名单.includes('recall'), 'DEFAULTS 缺 recall（配置一丢就翻不了记忆）')
  assert.ok(def.工具白名单.includes('trace'), 'DEFAULTS 缺 trace')
  assert.ok(!def.工具白名单.includes('remember'), 'DEFAULTS 不该下发写入型 remember')
})

test('H3 hippocampus 里注册的正是 recall/trace/remember 三个，名字没漂', () => {
  const s = readFileSync(HIPPO, 'utf8')
  assert.match(s, /name:\s*'recall'/, 'recall 工具名漂了')
  assert.match(s, /name:\s*'trace'/, 'trace 工具名漂了')
  assert.match(s, /name:\s*'remember'/, 'remember 工具名漂了')
})

test('H4 两个只读工具的说明分工明确：recall 按意思/日期，trace 按字', () => {
  const s = readFileSync(HIPPO, 'utf8')
  assert.match(s, /想起以前的事。给一句话、一个日期或一个编号/, 'recall 说明变了')
  assert.match(s, /一字不差地查，不问意思/, 'trace 说明变了')
})

test('H5 白名单没有重复项，配置文件仍是合法 JSON', () => {
  const w = 白名单()
  assert.equal(new Set(w).size, w.length, '白名单有重复项')
})
