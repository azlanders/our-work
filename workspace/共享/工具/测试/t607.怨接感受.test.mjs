// 批次607：负向 qq_feel 接上「怨」，并把怨的所有写点改成 改档() 锁内重读。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

process.env.QUIET_NOTE = '1'

const 工具 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const 怨 = path.join(工具, '怨.mjs')
const 临时 = () => fs.mkdtempSync(path.join(os.tmpdir(), 't607-'))
const 跑 = (mem, args) => execFileSync(process.execPath, [怨, ...args], {
  encoding: 'utf8', timeout: 15000, env: { ...process.env, QQ_YUAN_MEM: mem, YUAN_NO_RECUR: '1' },
}).trim()
const 读 = (mem) => JSON.parse(fs.readFileSync(path.join(mem, '怨.json'), 'utf8'))
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

test('负向感受按强度记账：被骂+20 / 被冷落+10 / 被打断+5', () => {
  const mem = 临时()
  assert.match(跑(mem, ['--from-feel', '被骂', '--who', '111', '--why', '骂我废物']), /怨 20/)
  assert.match(跑(mem, ['--from-feel', '被冷落', '--who', '111']), /怨 30/)
  assert.match(跑(mem, ['--from-feel', '被打断', '--who', '111']), /怨 35/)
  assert.equal(读(mem).people['111'].level, 35)
  assert.equal(读(mem).people['111'].why, '骂我废物', 'why 不该被空字符串覆盖')
  fs.rmSync(mem, { recursive: true, force: true })
})

test('正向/未知感受不记怨', () => {
  const mem = 临时()
  assert.match(跑(mem, ['--from-feel', '被夸', '--who', '111']), /不用记怨/)
  assert.equal(fs.existsSync(path.join(mem, '怨.json')), false)
  fs.rmSync(mem, { recursive: true, force: true })
})

test('修复/想岔了会降怨：--settle 每档 -10，到 0 删除', () => {
  const mem = 临时()
  fs.writeFileSync(path.join(mem, '怨.json'), JSON.stringify({ people: { 111: { level: 25, why: '旧账', at: 北京(Date.now()) } } }))
  assert.match(跑(mem, ['--settle', '--who', '111', '--by', '1']), /降到 15/)
  assert.match(跑(mem, ['--settle', '--who', '111', '--by', '2']), /消了/)
  assert.equal(读(mem).people['111'], undefined)
  fs.rmSync(mem, { recursive: true, force: true })
})

test('tick：小怨按天淡，且不熟的人停在 10', () => {
  const mem = 临时()
  const daysAgo = 北京(Date.now() - 2 * 864e5)
  fs.writeFileSync(path.join(mem, '怨.json'), JSON.stringify({ people: {
    111: { level: 28, why: '小怨', at: daysAgo },
    222: { level: 15, why: '不熟', at: daysAgo, familiar: 0 },
  } }))
  跑(mem, ['--tick'])
  const p = 读(mem).people
  assert.equal(p['111'].level, 18, '28 - 2天*5 = 18')
  assert.equal(p['222'].level, 10, '不熟的人最低停在 10')
  fs.rmSync(mem, { recursive: true, force: true })
})

test('源码：所有写点都走 改档，不再整档写回', () => {
  const s = fs.readFileSync(怨, 'utf8')
  assert.match(s, /import \{ 改档 \} from '\.\/_底层\.mjs'/)
  assert.doesNotMatch(s, /写档\(|writeFileSync\(/, '还在裸写怨.json')
  const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
  const lib = [
    process.env.QQ_LIB,
    path.join(测试目录, '..', '..', 'plugin-lib'),
    '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib',
  ].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'tool.js')))
  assert.ok(lib, '找不到插件 lib')
  const tool = fs.readFileSync(path.join(lib, 'tool.js'), 'utf8')
  assert.match(tool, /YUAN, '--from-feel', k/)
  assert.match(tool, /YUAN, '--settle'/)
})
