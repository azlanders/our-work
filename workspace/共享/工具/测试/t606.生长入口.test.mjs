// 批次606：「生长」补运行时入口（qq_grow），并改成锁内读改写。
// 1) 生长.mjs 真能长：数组追加、字符串接、空路径新建、每笔带来历；
// 2) 只允许 偏好/人味/想要 三个文件，别的文件一根手指不动；
// 3) 插件侧确实注册了 qq_grow，且白名单里有它。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

process.env.QUIET_NOTE = '1'

const 工具 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const 生长 = path.join(工具, '生长.mjs')
const 临时 = () => fs.mkdtempSync(path.join(os.tmpdir(), 't606-'))
const 跑 = (mem, args) => execFileSync(process.execPath, [生长, ...args], {
  encoding: 'utf8', timeout: 15000, env: { ...process.env, GROW_MEM: mem },
}).trim()
const 读 = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))

test('能长：新路径新建数组、已有数组追加、字符串用分号接', () => {
  const mem = 临时()
  fs.writeFileSync(path.join(mem, '偏好.json'), JSON.stringify({ 讨厌: ['被催'], 口头禅: '嗯' }))
  assert.match(跑(mem, ['--path', '人味.怕与要.怕', '--value', '被当成工具使唤', '--why', '被问才发现']), /^长出来了/)
  assert.match(跑(mem, ['--path', '偏好.讨厌', '--value', '被晾着']), /^长出来了/)
  assert.match(跑(mem, ['--path', '偏好.口头禅', '--value', '让我想想']), /^长出来了/)
  assert.deepEqual(读(path.join(mem, '偏好.json')), { 讨厌: ['被催', '被晾着'], 口头禅: '嗯；让我想想' })
  assert.deepEqual(读(path.join(mem, '人味.json')), { 怕与要: { 怕: ['被当成工具使唤'] } })
  const log = 读(path.join(mem, '长出来的.json'))
  assert.equal(log.items.length, 3)
  assert.equal(log.items[0].why, '被问才发现')
  fs.rmSync(mem, { recursive: true, force: true })
})

test('不许长：状态.json 这类不属于她的文件直接拒绝', () => {
  const mem = 临时()
  fs.writeFileSync(path.join(mem, '状态.json'), JSON.stringify({ energy: 80 }))
  const out = 跑(mem, ['--path', '状态.energy', '--value', '100'])
  assert.match(out, /不归她长/)
  assert.deepEqual(读(path.join(mem, '状态.json')), { energy: 80 })
  assert.equal(fs.existsSync(path.join(mem, '长出来的.json')), false)
  fs.rmSync(mem, { recursive: true, force: true })
})

test('长不进去：路径中间是字符串时拒绝，不写坏原档', () => {
  const mem = 临时()
  fs.writeFileSync(path.join(mem, '偏好.json'), JSON.stringify({ 口头禅: '嗯' }))
  const out = 跑(mem, ['--path', '偏好.口头禅.新的', '--value', 'x'])
  assert.match(out, /不是对象/)
  assert.deepEqual(读(path.join(mem, '偏好.json')), { 口头禅: '嗯' })
  fs.rmSync(mem, { recursive: true, force: true })
})

test('接线：tool.js 有 registerGrowTool，index.js 调用，白名单有 qq_grow', () => {
  const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
  const lib = [
    process.env.QQ_LIB,
    path.join(测试目录, '..', '..', 'plugin-lib'),
    '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib',
  ].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'tool.js')))
  assert.ok(lib, '找不到插件 lib')
  const tool = fs.readFileSync(path.join(lib, 'tool.js'), 'utf8')
  assert.match(tool, /name: 'qq_grow'/)
  const index = fs.readFileSync(path.join(lib, 'index.js'), 'utf8')
  assert.match(index, /registerGrowTool\(ctx\)/)
  // 本机没有线上配置时跳过白名单那一段；线上跑必须真查。
  const cfgP = process.env.QQ_CONFIG || '{{DSH_ROOT}}/qq-bridge.config.json'
  if (fs.existsSync(cfgP)) {
    const cfg = JSON.parse(fs.readFileSync(cfgP, 'utf8'))
    assert.ok(cfg.工具白名单.includes('qq_grow'), '白名单没放 qq_grow')
  }
})
