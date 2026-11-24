import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 脚本 = join(工具, '印象更新.mjs')

test('I625 印象更新只写线索和数值，不拼第一人称印象句', () => {
  const d = mkdtempSync(join(tmpdir(), 't626-'))
  try {
    writeFileSync(join(d, '印象素材.json'), JSON.stringify({
      people: [{ qq: '1', turns: 20, favor: 60, familiarity: 55, log: [{ kind: '日常', clue: '一起吃过面' }] }],
    }))
    const out = execFileSync(process.execPath, [脚本, '印象素材.json', '--force', '--print'], {
      env: { ...process.env, QQ_MEM: d },
      encoding: 'utf8',
    })
    const j = JSON.parse(out)
    assert.match(j['1'], /^素材：/)
    assert.match(j['1'], /档位：/)
    assert.match(j['1'], /聊过 20 轮/)
    assert.ok(!/说起你|我还记着|我总会想起|早把你当自己人/.test(j['1']))
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('I625 旧的第一人称值会在到期时迁移成事实摘要', () => {
  const d = mkdtempSync(join(tmpdir(), 't626-old-'))
  try {
    writeFileSync(join(d, '印象.json'), JSON.stringify({ 1: '说起你，我先想到一起吃过面' }))
    writeFileSync(join(d, '印象素材.json'), JSON.stringify({
      people: [{ qq: '1', turns: 1, favor: 60, familiarity: 55, log: [] }],
    }))
    const out = execFileSync(process.execPath, [脚本, '印象素材.json', '--force', '--print'], {
      env: { ...process.env, QQ_MEM: d },
      encoding: 'utf8',
    })
    assert.match(JSON.parse(out)['1'], /^素材：/)
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
