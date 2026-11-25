import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { 截围绕, 解析日 } from '../workspace/共享/工具/回忆.mjs'
import { remember, recall, describeMemory } from '../dsh/vendor/dsh-video-storyboard/src/storyboard/memory.js'
import { useMemoryFile, remember as obRemember, loadMemory as obLoad, describeMemory as obDescribe, flushMemoryPersist } from '../dsh/vendor/dsh-onebot-channel/lib/memory.js'

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

test('回忆.mjs: ENTRY_GUARD prevents CLI execution on import, 截围绕 centers matched keyword', () => {
  assert.equal(解析日('2026-11-20'), '2026-11-20')
  const longText = '前缀铺垫'.repeat(40) + '关键词AlphaBeta在这里' + '后缀补充'.repeat(30)
  const clipped = 截围绕(longText, 'alphabeta')
  assert.ok(clipped.length <= 104, `clipped too long: ${clipped.length}`)
  assert.match(clipped, /AlphaBeta/, 'centered clip must preserve matched keyword')
})

test('回忆.mjs: supports case-insensitive --词, dream-only days, and --日 + --词 combo in sandbox', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recall-opt-'))
  try {
    const mem = join(dir, '记忆')
    const diary = join(dir, '日记')
    mkdirSync(join(mem, '梦'), { recursive: true })
    mkdirSync(diary, { recursive: true })
    writeFileSync(join(mem, '梦', '梦-2026-11-18.md'), '场景：在海边看到 AlphaBeta 发光\n', 'utf8')
    writeFileSync(join(mem, '手账-2026-11-19.md'), '- 12:00 · 吃火锅\n- 15:00 · 修 DSH 插件\n', 'utf8')

    const script = join(REPO_ROOT, 'workspace/共享/工具/回忆.mjs')
    const env = { ...process.env, QQ_RECALL_MEM: mem, QQ_RECALL_DIARY: diary }

    // 1. Dream-only day + case-insensitive keyword
    const out1 = JSON.parse(execFileSync(process.execPath, [script, '--词', 'alphabeta', '--json'], { env, encoding: 'utf8' }))
    assert.equal(out1.ok, true)
    assert.equal(out1.条数, 1)
    assert.equal(out1.条目[0].来源, '梦')
    assert.equal(out1.条目[0].日, '2026-11-18')

    // 2. --日 + --词 combo filters within that day
    const out2 = JSON.parse(execFileSync(process.execPath, [script, '--日', '2026-11-19', '--词', 'dsh', '--json'], { env, encoding: 'utf8' }))
    assert.equal(out2.ok, true)
    assert.equal(out2.条数, 1)
    assert.match(out2.条目[0].文, /DSH 插件/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('storyboard/memory.js: creates missing dir, writes atomically, and formats UTC+8 Beijing time', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sb-mem-'))
  try {
    const env = { DSH_VIDEO_CACHE_DIR: join(dir, 'nested-cache') }
    const utcTs = Date.UTC(2026, 10, 24, 17, 30, 0) // 2026-11-25 01:30 Beijing
    await remember({ path: '/tmp/demo.mp4', duration: 60 }, { from: 0, to: 30, cells: 4, cuts: 2 }, { env, at: utcTs })
    const r = await recall({ path: '/tmp/demo.mp4' }, { env })
    assert.equal(r.windows, 1)
    const desc = await describeMemory({ path: '/tmp/demo.mp4' }, { env })
    assert.match(desc, /2026-11-25 01:30/, 'must format deterministic Beijing UTC+8 time')
    const leftovers = readdirSync(join(dir, 'nested-cache')).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(leftovers, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('onebot/lib/memory.js: atomic write leaves no fixed .tmp file and merges near-duplicate facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ob-mem-'))
  try {
    const f = join(dir, 'qq-bridge-memory.json')
    useMemoryFile(f)
    assert.equal(obRemember('private:100', { fact: '喜欢在半坡酒馆喝桂花乌龙茶' }), true)
    assert.equal(obRemember('private:100', { fact: '很喜欢在半坡酒馆喝桂花乌龙茶' }), true)
    flushMemoryPersist()
    const leftovers = readdirSync(dir).filter((n) => n.includes('.tmp'))
    assert.deepEqual(leftovers, [])
    const card = obLoad('private:100')
    assert.equal(card.facts.length, 1, 'near-duplicate facts should merge into 1 active entry')
    const desc = obDescribe('private:100')
    assert.match(desc, /半坡酒馆/)
  } finally {
    useMemoryFile('')
    rmSync(dir, { recursive: true, force: true })
  }
})
