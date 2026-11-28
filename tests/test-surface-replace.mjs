import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import test from 'node:test'

import {
  pruneStaleNudges,
  pruneStaleSystemNodes,
  pruneSupersededContext,
} from '../dsh/vendor/dsh-mnemonic/index.js'

const HOST = process.env.DSH_SESSION_MODULE
  || '/usr/local/lib/nodejs/node-v22.23.4-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js'

const msg = (role, text, source) => ({
  id: randomUUID(),
  role,
  content: text === '' ? [] : [{ type: 'text', text }],
  source,
})

test('surface 替换对宿主 Session 合法，且旧内容不再进入派生消息', { skip: !existsSync(HOST) }, async () => {
  const { Session } = await import(HOST)
  const s = Session.create('surface-test')
  s.append('system/message', { message: msg('system', 'S1', { kind: 'system-prompt' }) }, { surfaceOp: 'append' })
  s.append('system/message', { message: msg('system', 'S2', { kind: 'system-prompt' }) }, { surfaceOp: 'append' })
  s.append('user/message', msg('user', 'CTX-ONE', { kind: 'runtime-context', form: 'snapshot' }), { surfaceOp: 'append' })
  s.append('user/message', msg('user', 'CTX-TWO', { kind: 'runtime-context', form: 'snapshot' }), { surfaceOp: 'append' })
  for (let i = 1; i <= 7; i += 1) {
    s.append('user/message', msg('user', `NUDGE-${i}`, { kind: 'nudge', qq: { chatKind: 'private', chatId: '1' } }), { surfaceOp: 'append' })
  }

  const replace = (type, data) => (seq) => s.append(type, data, {
    surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq },
    sourceEventSeqs: [seq],
  })
  const rc = pruneSupersededContext(s, replace('user/message', msg('user', 'CTX-OLD', { kind: 'runtime-context', form: 'pruned' })))
  const sys = pruneStaleSystemNodes(s, replace('system/message', { message: msg('system', '', { kind: 'system-prompt' }) }))
  const nudge = pruneStaleNudges(s, replace('user/message', msg('user', 'NUDGE-OLD', { kind: 'nudge', form: 'pruned' })))

  const text = JSON.stringify(s.deriveMessages().map((m) => m.content))
  assert.equal(rc, 1)
  assert.equal(sys, 1)
  assert.equal(nudge, 2)
  assert.ok(!text.includes('CTX-ONE'))
  assert.ok(text.includes('CTX-TWO'))
  assert.ok(!text.includes('NUDGE-1'))
  assert.ok(text.includes('NUDGE-7'))
  assert.ok(!text.includes('S1'))
  assert.ok(text.includes('S2'))
})
