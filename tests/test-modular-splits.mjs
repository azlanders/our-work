import test from 'node:test'
import assert from 'node:assert/strict'
import * as pollCls from '../dsh/vendor/dsh-onebot-channel/lib/poll-classify.js'

test('poll-classify: 是半句 / 防抖等待 / isPushback behave per spec', () => {
  assert.equal(pollCls.isPushback('没跟你说话别插嘴'), true)
  assert.equal(pollCls.isPushback('今天天气真好'), false)
  assert.equal(pollCls.是半句('等一下，'), true)
  assert.equal(pollCls.是半句('正常短句'), false)
  assert.equal(pollCls.防抖等待(true, '立刻停下', 5000), 1000)
  assert.equal(pollCls.防抖等待(false, '等一下，', 1000), 2000)
  assert.equal(pollCls.URGENT_RE.test('立刻停下'), true)
  assert.equal(pollCls.URGENT_RE.test('今天吃什么'), false)
})

test('poll-classify: 只有媒体 / 纯图无正文 / 是否艾特别人 behave deterministically', () => {
  assert.equal(pollCls.只有媒体([{ type: 'image', data: {} }], ''), true)
  assert.equal(pollCls.纯图无正文([{ type: 'image', data: {} }], ''), true)
  assert.equal(pollCls.纯图无正文([{ type: 'image', data: {} }], '看图'), false)
  assert.equal(pollCls.是否艾特别人([{ type: 'at', data: { qq: '999' } }], '123'), true)
  assert.equal(pollCls.是否艾特别人([{ type: 'at', data: { qq: '123' } }], '123'), false)
})


import {
  isCuttableTurnEnd,
  latestTurnCompleted,
  latestCompletedTurnEnd,
  latestTurnStart,
  turnStartForBoundary,
} from '../dsh/vendor/dsh-live-compact/turn-helpers.js'

test('dsh-live-compact/turn-helpers: turn boundary helpers behave deterministically', () => {
  const events = [
    { seq: 1, type: 'turn/start', data: { turn: 1 } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 3, type: 'turn/start', data: { turn: 2 } },
    { seq: 4, type: 'turn/end', data: { turn: 2, reason: { kind: 'max-tokens' } } },
  ]
  assert.equal(isCuttableTurnEnd(events[1]), true)
  assert.equal(isCuttableTurnEnd(events[3]), true)
  assert.equal(latestTurnCompleted(events), true)
  assert.equal(latestCompletedTurnEnd(events)?.seq, 4)
  assert.equal(latestTurnStart(events)?.seq, 3)
  assert.equal(turnStartForBoundary(events, events[3])?.seq, 3)
})

import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../dsh/vendor/dsh-onebot-channel/lib/atomic-fs.js'

test('dsh-onebot-channel/lib/atomic-fs: writes atomically and leaves zero .tmp files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-atomic-'))
  try {
    const target = join(dir, 'sub/state.json')
    atomicWriteFileSync(target, JSON.stringify({ ok: true }))
    assert.deepEqual(JSON.parse(readFileSync(target, 'utf8')), { ok: true })
    assert.deepEqual(readdirSync(join(dir, 'sub')).filter((n) => n.includes('.tmp-')), [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
