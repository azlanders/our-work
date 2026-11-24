// 批次593：主动搭话起的那一轮，不许再排「12 分钟后补一句」
//
// 真风险：主动开口 → 纯聊天收尾 → 排续话 → 12 分钟后又补一句。
// 一条搭话变两条，还能一轮接一轮串下去。这里钉住这条闸。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? `${process.env.DSH_HOME}/profiles/web/node_modules/dsh-onebot-channel/lib` : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const 续跑 = readFileSync(LIB + '/实时续跑.js', 'utf8')
const 主动 = readFileSync(LIB + '/proactive.js', 'utf8')

test('Q1 续跑导出「标记主动轮」', () => {
  assert.match(续跑, /export function 标记主动轮\(sessionId, at = Date\.now\(\)\)/)
})

test('Q2 主动投递成功后要打标记', () => {
  assert.match(主动, /标记主动轮\(item\.sessionId, now\)/)
})

test('Q3 纯聊天收尾先看是不是主动轮起的，是就不排队', () => {
  assert.match(续跑, /if \(是主动轮起的\(sessionId, Date\.now\(\)\)\) \{[\s\S]{0,600}排续话\(ctx, sessionId, entry\)/)
})

test('Q4 收尾聊一句/补一句自己也要打标记，避免二级串联', () => {
  const hits = 续跑.match(/await 投递续话[\s\S]{0,250}标记主动轮\(sessionId\)/g) ?? []
  assert.equal(hits.length, 2)
})
