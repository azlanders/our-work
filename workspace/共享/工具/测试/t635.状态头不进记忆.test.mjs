// t635 —— 快状态头必须走 rofm 已识别的「你现在的状态」前缀，别被归档成用户正文。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const POLL = join(LIB, 'poll.js')
const SURFACE = process.env.ROFM_SURFACE || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm/lib/surface.js'

test('S1 快状态头以「你现在的状态：此刻」开头，且不超过 100 字', async () => {
  const poll = await import(pathToFileURL(POLL).href + '?t635=1')
  const s = String(poll.stateFastHintOf({}) || '')
  assert.match(s, /^（你现在的状态：此刻 \d{2}:\d{2}｜/)
  assert.ok(s.length > 0 && s.length <= 100, `fast state is 1-100 chars (got ${s.length})`)
})

test('S2 rofm 的注入头剥离规则认这个前缀', () => {
  const s = readFileSync(SURFACE, 'utf8')
  assert.match(s, /你现在的状态/)
  assert.match(s, /stripInjectedHeaders/)
})

test('S3 源码里不再有裸的「（此刻」状态头', () => {
  const s = readFileSync(POLL, 'utf8')
  assert.doesNotMatch(s, /const 核 = `（此刻 /)
  assert.match(s, /const 核 = `（你现在的状态：此刻 /)
})
