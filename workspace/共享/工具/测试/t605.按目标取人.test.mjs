// 批次605：别扭/怨必须按目标 QQ 取，不能拿 people 的第一条。
// 跟 A 私聊时读到 B 的别扭，会让 A 莫名其妙被冷落；群聊没有单一对象，按“没有”处理。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

process.env.QUIET_NOTE = '1'

const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
const lib = [
  process.env.QQ_LIB,
  path.join(测试目录, '..', '..', 'plugin-lib'),          // 本地审计副本 _src/plugin-lib
  '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib',
].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'target.js')))
assert.ok(lib, '找不到插件 lib 目录（可用 QQ_LIB 指定）')
const { personKeyOf, personRecordOf } = await import(pathToFileURL(path.join(lib, 'target.js')).href)

test('personKeyOf：私聊按目标 id，缺 id 才用默认私聊对象', () => {
  assert.equal(personKeyOf({ kind: 'private', id: '111' }, '999'), '111')
  assert.equal(personKeyOf({ kind: 'private', id: 222 }, '999'), '222')
  assert.equal(personKeyOf({ kind: 'private' }, '999'), '999')
  assert.equal(personKeyOf({ kind: 'private', id: '' }, '999'), '999')
})

test('personKeyOf：群聊没有单一对象，返回空串', () => {
  assert.equal(personKeyOf({ kind: 'group', id: '123456' }, '999'), '')
  assert.equal(personKeyOf(null, '999'), '')
})

test('personRecordOf：A 的记录不能串给 B', () => {
  const db = { people: { 111: { level: 60 }, 222: { level: 10 } } }
  assert.equal(personRecordOf(db, { kind: 'private', id: '111' }).level, 60)
  assert.equal(personRecordOf(db, { kind: 'private', id: '222' }).level, 10)
  assert.equal(personRecordOf(db, { kind: 'private', id: '333' }), null)
  assert.equal(personRecordOf(db, { kind: 'group', id: '111' }), null)
})

test('源码回归：插件 lib 里不再有 Object.values(...people)[0]', () => {
  const 文件 = fs.readdirSync(lib).filter((n) => n.endsWith('.js'))
  const 命中 = []
  for (const n of 文件) {
    const s = fs.readFileSync(path.join(lib, n), 'utf8')
    if (/Object\.values\([^\n]*people[^\n]*\)\[0\]/.test(s)) 命中.push(n)
  }
  assert.deepEqual(命中, [], '这些文件还在按“第一个人”读档案：' + 命中.join('、'))
})
