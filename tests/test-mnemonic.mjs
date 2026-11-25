import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply, isHumanUserMessage } from '../dsh/vendor/dsh-mnemonic/index.js'
import { renderRecallBlock } from '../dsh/vendor/dsh-mnemonic/lib/card.js'
import { diversify } from '../dsh/vendor/dsh-mnemonic/lib/diversify.js'
import { buildIndex, search } from '../dsh/vendor/dsh-mnemonic/lib/recall.js'
import { Store } from '../dsh/vendor/dsh-mnemonic/lib/store.js'

test('isHumanUserMessage filters host synthetic and plugin messages', () => {
  assert.equal(isHumanUserMessage({ role: 'user', content: '你好呀', source: { kind: 'user' } }), true)
  assert.equal(isHumanUserMessage({ role: 'user', content: '普通消息' }), true)
  assert.equal(isHumanUserMessage({ role: 'assistant', content: '我回你' }), false)
  assert.equal(isHumanUserMessage({ role: 'user', content: '快照', source: { kind: 'runtime-context' } }), false)
  assert.equal(isHumanUserMessage({ role: 'user', content: '回忆', source: { kind: 'plugin:dsh-mnemonic', form: 'recall' } }), false)
  assert.equal(isHumanUserMessage({ role: 'user', content: 'Current runtime context. This snapshot supersedes...' }), false)
  assert.equal(isHumanUserMessage({ role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }), false)
})

test('recall supports multi-char keywords, mixed-case keywords, tags, and local synonym expansion', () => {
  const now = Date.parse('2026-06-15T12:00:00+08:00')
  const records = [
    { id: 'm1', text: '用户叫沈知夏，年龄24。', keywords: ['沈知夏', '姓名', '年龄'], tags: ['基本信息'], importance: 0.6, createdAt: now, uses: 1 },
    { id: 'm2', text: '平时喜欢喝桂花乌龙和冰美式。', keywords: ['桂花乌龙', 'SnowLuma'], tags: ['饮品偏好'], importance: 0.7, createdAt: now, uses: 1 },
    { id: 'm3', text: '周末在半坡酒馆做晚班调酒师。', keywords: ['半坡酒馆', '调酒师'], tags: ['职业'], importance: 0.6, createdAt: now, uses: 1 },
  ]
  const idx = buildIndex(records)

  const h1 = search(idx, records, '填个表我全名咋写多大来着', { limit: 3, minScore: 1.0, now })
  assert.equal(h1[0]?.rec.id, 'm1', 'local synonym expansion should find name/age card')

  const h2 = search(idx, records, 'snowluma 还是桂花乌龙好喝', { limit: 3, minScore: 1.0, now })
  assert.equal(h2[0]?.rec.id, 'm2', 'mixed-case and 4-char keywords should match')

  const h3 = search(idx, records, '最近饮品偏好是啥', { limit: 3, minScore: 1.0, now })
  assert.equal(h3[0]?.rec.id, 'm2', 'tags should be searchable')

  const h4 = search(idx, records, '今天天气真不错写个正则', { limit: 3, minScore: 1.2, now })
  assert.equal(h4.length, 0, 'unrelated chitchat must not false-trigger')
})

test('diversify prevents redundant near-duplicate hits from crowding out distinct records', () => {
  const hits = [
    { rec: { id: 'a1', text: '周三下午去图书馆借了一本算法书', keywords: ['图书馆', '算法书'] }, score: 10 },
    { rec: { id: 'a2', text: '周三下午去图书馆借了一本算法书回来', keywords: ['图书馆', '算法书'] }, score: 9.8 },
    { rec: { id: 'a3', text: '周三下午去图书馆借了一本算法书看', keywords: ['图书馆', '算法书'] }, score: 9.6 },
    { rec: { id: 'b1', text: '周六晚上约了老陈在南滨路吃火锅', keywords: ['南滨路', '火锅'] }, score: 7.5 },
  ]
  const out = diversify(hits, { limit: 2, lambda: 0.75 })
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((h) => h.rec.id), ['a1', 'b1'])
})

test('renderRecallBlock preserves full date, head/tail discipline, and avoids awkward micro-truncation', () => {
  const now = Date.parse('2026-06-20T10:00:00+08:00')
  const hits = [
    { rec: { text: '约好下周二（2026-06-23）下午三点去复查牙齿。', eventAt: Date.parse('2026-06-15T10:00:00+08:00') } },
    { rec: { text: '第二条很长的背景补充'.repeat(20), eventAt: Date.parse('2026-06-16T10:00:00+08:00') } },
    { rec: { text: '第三条补充信息', eventAt: Date.parse('2026-06-17T10:00:00+08:00') } },
  ]
  const block = renderRecallBlock(hits, { maxChars: 340, itemChars: 180, now })
  assert.ok(block.includes('2026-06-15'), 'must include full YYYY-MM-DD date')
  assert.ok(block.includes('别补这里没有的日期'), 'tail discipline must never be truncated')
  assert.ok(!block.includes('第三条补充信息'), 'overflow items should stop cleanly once budget fills')
})

test('Store merges duplicate metadata and writes atomically without fixed .tmp file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemonic-store-'))
  try {
    const file = join(dir, 'memories.jsonl')
    const store = new Store(file).load()
    const r1 = store.add({ text: '喜欢喝冰美式少冰', keywords: ['冰美式'], importance: 0.35, source: { kind: 'auto' } })
    const r2 = store.add({ text: '喜欢喝冰美式少冰', keywords: ['咖啡'], tags: ['饮品'], importance: 0.85, source: { kind: 'tool' } })
    assert.equal(r1.id, r2.id)
    assert.deepEqual(r2.keywords, ['冰美式', '咖啡'])
    assert.deepEqual(r2.tags, ['饮品'])
    assert.equal(r2.importance, 0.85)
    assert.equal(r2.source.kind, 'tool')
    store.flush()

    const files = readdirSync(dir)
    assert.ok(!files.includes('memories.jsonl.tmp'), 'must not use fixed .tmp name')

    assert.equal(store.remove(r1.id), true)
    store.flush()
    const reloaded = new Store(file).load()
    assert.equal(reloaded.records.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('apply integration deduplicates tool-loop pre-steps, wires diversify limit, and ignores runtime-context', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mnemonic-plugin-'))
  try {
    const registeredTools = new Map()
    let preStepHandler = null
    let rewriteCalls = 0
    const ctx = {
      logger: { warn() {}, info() {} },
      get(name) {
        if (name === 'llm') {
          return {
            async *stream() {
              rewriteCalls += 1
              yield { type: 'text-delta', text: '火锅 南滨路 聚餐' }
            },
          }
        }
        if (name === 'defaultModel') {
          return { currentSelection: () => ({ provider: 'mock', model: 'flash' }) }
        }
        return null
      },
      inject(deps, fn) {
        if (deps.includes('tools')) {
          fn({
            effect: (cb) => cb(),
            tools: {
              register(t) { registeredTools.set(t.name, t); return () => {} },
            },
          })
        }
      },
      on(evt, handler) {
        if (evt === 'agent/pre-step') preStepHandler = handler
      },
    }

    const dispose = apply(ctx, { storePath: join(dir, 'memories.jsonl'), limit: 2, injectChars: 900 })
    try {
      const saveTool = registeredTools.get('mem_save')
      const recallTool = registeredTools.get('mem_recall')
      await saveTool.execute({ text: '约定周六在南滨路吃老火锅', keywords: ['南滨路', '火锅'], importance: 0.8 })
      await saveTool.execute({ text: '南滨路吃老火锅的时候别点太辣', keywords: ['南滨路', '火锅'], importance: 0.7 })
      await saveTool.execute({ text: '家里的猫叫半两喜欢冻干', keywords: ['半两', '冻干'], importance: 0.8 })

      const recallRes = await recallTool.execute({ query: '半两爱吃啥', limit: 2 })
      assert.equal(recallRes.hits, 1)
      assert.ok(recallRes.text.includes('冻干'))

      // Step 1: real user turn + trailing runtime-context must select real user turn and ignore runtime-context
      const msgs = [
        { id: 'u1', role: 'user', content: '周六去南滨路吃火锅要记住什么', source: { kind: 'user' } },
        { id: 'rc1', role: 'user', content: 'Current runtime context. Policy...', source: { kind: 'runtime-context' } },
      ]
      const d1 = await preStepHandler({}, async () => ({ kind: 'enter', messages: msgs }))
      assert.equal(d1.messages.filter((m) => m.source?.kind === 'plugin:dsh-mnemonic').length, 1)
      assert.equal(rewriteCalls, 1)

      // Step 2 in same tool loop: must not call rewriteQuery or archive again
      const d2 = await preStepHandler({}, async () => ({ kind: 'enter', messages: d1.messages }))
      assert.equal(rewriteCalls, 1)
      assert.equal(d2.messages.filter((m) => m.source?.kind === 'plugin:dsh-mnemonic').length, 1)

      const storeCheck = new Store(join(dir, 'memories.jsonl')).load()
      assert.equal(storeCheck.records.some((r) => r.text.includes('Current runtime context')), false)
    } finally {
      dispose()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
