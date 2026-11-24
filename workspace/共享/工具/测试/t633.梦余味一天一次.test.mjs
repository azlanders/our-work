// t633 —— 梦余味提示每天每会话只提一次；写不上不吞提示。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 梦余味提示去重 } = await import(pathToFileURL(join(LIB, 'poll.js')).href + '?t633=1')

// 665 起梦余味槽直接递标签，不再翻译成「还有点暖」。
const 梦 = '[梦] 今早的梦，余味：暖｜沙发、吸管、尾巴搭在手柄上'
const 冷 = '[冷] 屋里有点凉'

function 造() {
  return mkdtempSync(join(tmpdir(), 't633-'))
}

test('D1 第一次给梦余味，第二次同一会话不再给', () => {
  const mem = 造()
  try {
    const a = 梦余味提示去重(冷 + '\n' + 梦, { memDir: mem, scope: 'private', now: 1000 })
    assert.match(a, /\[梦\]/)
    const b = 梦余味提示去重(冷 + '\n' + 梦, { memDir: mem, scope: 'private', now: 2000 })
    assert.doesNotMatch(b, /\[梦\]/)
    assert.match(b, /\[冷\]/, '其他槽不能被梦余味去重连坐')
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('D2 不同会话各自有一次，不互相吃掉', () => {
  const mem = 造()
  try {
    assert.match(梦余味提示去重(梦, { memDir: mem, scope: 'private', now: 1000 }), /\[梦\]/)
    assert.match(梦余味提示去重(梦, { memDir: mem, scope: 'group:123', now: 1000 }), /\[梦\]/)
    assert.doesNotMatch(梦余味提示去重(梦, { memDir: mem, scope: 'group:123', now: 2000 }), /\[梦\]/)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('D3 第二天重新给一次', () => {
  const mem = 造()
  try {
    const day = 24 * 3600e3
    assert.match(梦余味提示去重(梦, { memDir: mem, scope: 'private', now: 1000 }), /\[梦\]/)
    assert.doesNotMatch(梦余味提示去重(梦, { memDir: mem, scope: 'private', now: 1000 + 1000 }), /\[梦\]/)
    assert.match(梦余味提示去重(梦, { memDir: mem, scope: 'private', now: 1000 + day }), /\[梦\]/)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('D4 没有梦余味时不建去重档，也不改正文', () => {
  const mem = 造()
  try {
    const s = 冷 + '\n[屏幕] 主人电脑刚有新截图'
    assert.equal(梦余味提示去重(s, { memDir: mem, scope: 'private', now: 1000 }), s)
    assert.equal(existsSync(join(mem, '梦余味-提示.json')), false)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('D5 去重档坏了：照常给提示，并重写成合法档', () => {
  const mem = 造()
  try {
    writeFileSync(join(mem, '梦余味-提示.json'), '{坏的')
    assert.match(梦余味提示去重(梦, { memDir: mem, scope: 'private', now: 1000 }), /\[梦\]/)
    const db = JSON.parse(readFileSync(join(mem, '梦余味-提示.json'), 'utf8'))
    assert.equal(db.scopes.private, 1000)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})
