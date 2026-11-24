// t611.死信持久化.test.mjs —— 批次611（审计 P1-7）
//
// 出站失败的正文原来只在进程内（重启清空）。现在落 JSONL，并且能读、能补发。
// 测试只碰沙盒文件（DSH_DEAD_LETTER_FILE），不写线上。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.QUIET_NOTE = '1'

const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
const lib = [
  path.join(测试目录, '..', '..', 'plugin-lib'),          // 本地审计副本 _src/plugin-lib
  '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib',
].find((p) => fs.existsSync(path.join(p, 'deadletter.js')))
assert.ok(lib, '找不到 lib/deadletter.js')

function 沙盒() {
  const b = mkdtempSync(path.join(tmpdir(), 't611-'))
  return b
}

async function 装入(b) {
  process.env.DSH_DEAD_LETTER_FILE = path.join(b, 'dead.jsonl')
  return import(pathToFileURL(path.join(lib, 'deadletter.js')).href + '?s=' + Math.random().toString(36).slice(2))
}

test('E1 记录 → 读回：顺序、字段、id 都在', async () => {
  const b = 沙盒()
  try {
    const D = await 装入(b)
    const a = D.记录死信({ sessionId: 's1', target: { kind: 'private', id: '1' }, text: '第一句', error: 'boom' })
    const c = D.记录死信({ sessionId: 's1', target: { kind: 'group', id: '2' }, text: '第二句', error: 'timeout' })
    const items = D.读死信(10)
    assert.equal(items.length, 2)
    assert.equal(items[0].text, '第一句')
    assert.equal(items[1].text, '第二句')
    assert.equal(items[0].id, a.id)
    assert.equal(items[1].id, c.id)
    assert.notEqual(items[0].id, items[1].id)
    assert.equal(items[0].target.kind, 'private')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('E2 补发标记后不再出现在未补发列表', async () => {
  const b = 沙盒()
  try {
    const D = await 装入(b)
    const a = D.记录死信({ target: { kind: 'private', id: '1' }, text: 'A' })
    D.记录死信({ target: { kind: 'private', id: '1' }, text: 'B' })
    assert.equal(D.标记补发(a.id), true)
    const items = D.读死信(10)
    assert.equal(items.length, 1)
    assert.equal(items[0].text, 'B')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('E3 只返回最近 N 条；坏行不影响读取', async () => {
  const b = 沙盒()
  try {
    const D = await 装入(b)
    for (let i = 0; i < 205; i++) D.记录死信({ target: { kind: 'private', id: '1' }, text: '第' + i })
    const items = D.读死信(200)
    assert.equal(items.length, 200)
    assert.equal(items[0].text, '第5')
    assert.equal(items[199].text, '第204')
    appendFileSync(D.死信文件(), '{这不是JSON\n')
    assert.equal(D.读死信(200).length, 200)
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('E4 空文件返回空数组；文件目录不存在也能写', async () => {
  const b = 沙盒()
  try {
    const D = await 装入(b)
    assert.deepEqual(D.读死信(10), [])
    // 指向一个还不存在的子目录
    process.env.DSH_DEAD_LETTER_FILE = path.join(b, '深', '一层', 'dead.jsonl')
    const D2 = await import(pathToFileURL(path.join(lib, 'deadletter.js')).href + '?s2=' + Math.random().toString(36).slice(2))
    D2.记录死信({ target: { kind: 'private', id: '1' }, text: '深层' })
    assert.equal(D2.读死信(10).length, 1)
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('E5 源码回归：outbound 失败落盘、sendapi 暴露读取/补发', () => {
  const out = fs.readFileSync(path.join(lib, 'outbound.js'), 'utf8')
  assert.match(out, /import \{ 记录死信 \}/)
  assert.match(out, /记录死信\(\{ sessionId, target: entry\.target/, '发送失败要落盘')

  const api = fs.readFileSync(path.join(lib, 'sendapi.js'), 'utf8')
  assert.match(api, /url === '\/dead-letters'/)
  assert.match(api, /url === '\/dead-letters\/replay'/)
  assert.match(api, /读死信\(200\)\.find/)
  assert.match(api, /标记补发\(id\)/)
})
