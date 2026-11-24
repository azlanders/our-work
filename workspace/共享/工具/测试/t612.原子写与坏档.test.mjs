// t612.原子写与坏档.test.mjs —— 批次612（审计 P2-7）
//
// proactive.js 原来直接 writeFileSync：半截写 + 读坏后空表覆盖，会把主动账整份丢掉。
// 现在临时文件 + rename 原子替换；坏档改名留证。唯一写方仍是 dsh-bot 单实例，不需要跨实例锁。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.QUIET_NOTE = '1'

const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
const lib = [
  path.join(测试目录, '..', '..', 'plugin-lib'),
  '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib',
].find((p) => fs.existsSync(path.join(p, 'atomic.js')))
assert.ok(lib, '找不到 lib/atomic.js')

const A = await import(pathToFileURL(path.join(lib, 'atomic.js')).href)

test('A1 原子写：内容一致、没有残留临时文件', () => {
  const b = mkdtempSync(path.join(tmpdir(), 't612-'))
  try {
    const f = path.join(b, '状态.json')
    assert.equal(A.原子写JSON(f, { a: 1, 嵌套: { b: [1, 2, 3] } }), true)
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { a: 1, 嵌套: { b: [1, 2, 3] } })
    const 残留 = fs.readdirSync(b).filter((n) => n.includes('.tmp-'))
    assert.deepEqual(残留, [])
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('A2 写入失败不破坏原文件（父路径是文件时）', () => {
  const b = mkdtempSync(path.join(tmpdir(), 't612b-'))
  try {
    const 挡路 = path.join(b, '挡路')
    writeFileSync(挡路, 'x')
    const f = path.join(挡路, '状态.json')
    assert.throws(() => A.原子写JSON(f, { a: 1 }))
    assert.equal(fs.readFileSync(挡路, 'utf8'), 'x')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('A3 坏档备份：改名留证，原路径腾空', () => {
  const b = mkdtempSync(path.join(tmpdir(), 't612c-'))
  try {
    const f = path.join(b, 'proactive.json')
    writeFileSync(f, '{半截 JSON')
    const 新 = A.备份坏档(f, 'corrupt')
    assert.notEqual(新, '')
    assert.equal(fs.existsSync(f), false)
    assert.equal(fs.readFileSync(新, 'utf8'), '{半截 JSON')
  } finally { rmSync(b, { recursive: true, force: true }) }
})

test('A4 源码回归：proactive 不再直写状态文件，坏档走备份', () => {
  const p = fs.readFileSync(path.join(lib, 'proactive.js'), 'utf8')
  assert.doesNotMatch(p, /writeFileSync\(proactiveFile/)
  assert.match(p, /原子写JSON\(proactiveFile, table\)/)
  assert.match(p, /备份坏档\(proactiveFile, 'corrupt'\)/)
})
