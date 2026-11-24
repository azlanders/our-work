// t683 —— 批次683：关系卡「载入没完成 / 表为空」时不许落盘
//
// 679 事故：新版 memory.js 在重启时把 qq-bridge-memory.json 从 3113 字节写成 `{}`，
// 10 条事实全空。直接原因是 `flushMemoryPersist()` 在 `table` 还没载入时照样写盘。
// 这一批加保护：载入未完成、或 table 为空而原文件非空，一律不写。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// QUIET_NOTE 2026-11-17（批次684）：H2 故意造一份坏 JSON 验「不落盘」，
// memory.js 会往**真**日志写一行「关系卡读坏了」。全套一跑，重启闸门就把这行
// 当成了桥接活动，判定「在忙」而不许重启。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
// 本地镜像在工具目录旁边；线上在 dsh-onebot-channel/lib。两种都认，测试才能两边跑。
const 本地插件 = join(工具, '..', 'plugin-lib')
const 插件 = process.env.QQ_LIB_DIR
  || (existsSync(join(本地插件, 'memory.js')) ? 本地插件 : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('H1 源码：载入标志 + 可安全落盘 + 两处守卫都在', () => {
  const 源 = readFileSync(join(插件, 'memory.js'), 'utf8')
  assert.match(源, /PERSIST_GUARD/, '缺少批次683 注释锚点')
  assert.match(源, /let __载入完成 = false/)
  assert.match(源, /function 可安全落盘\(\)/)
  assert.match(源, /if \(!__载入完成\) return false/)
  // persist 与 flush 两处都必须先问
  const 守卫 = (源.match(/if \(!可安全落盘\(\)\) \{ 落盘被拦/g) || []).length
  assert.equal(守卫, 2, 'persist 与 flushMemoryPersist 都要有守卫')
})

test('H2 正常载入后写入：原事实不丢，新事实追加', async () => {
  const 根 = mkdtempSync(join(tmpdir(), 't683-'))
  try {
    const 档 = join(根, 'memory.json')
    writeFileSync(档, JSON.stringify({
      'private:1': { nick: '主人', facts: [{ at: 1, text: '旧事实一' }, { at: 2, text: '旧事实二' }] },
    }), 'utf8')
    const m = await import(pathToFileURL(join(插件, 'memory.js')).href + '?t683=a')
    m.useMemoryFile(档)
    const 前 = m.loadMemory('private:1')
    assert.equal(前.facts.length, 2)
    m.remember('private:1', { fact: '新事实三' })
    m.flushMemoryPersist()
    const 后 = 读(档)
    assert.equal(后['private:1'].facts.length, 3, '原有两条 + 新一条')
    assert.ok(后['private:1'].facts.some((f) => f.text === '旧事实一'))
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('H3 文件读坏时不拿空表覆盖它', async () => {
  const 根 = mkdtempSync(join(tmpdir(), 't683-'))
  try {
    const 档 = join(根, 'memory.json')
    const 坏 = '{这不是合法 JSON'
    writeFileSync(档, 坏, 'utf8')
    const m = await import(pathToFileURL(join(插件, 'memory.js')).href + '?t683=b')
    m.useMemoryFile(档)
    assert.equal(m.loadMemory('private:1'), null, '坏档应该读不出来')
    m.flushMemoryPersist()
    assert.equal(readFileSync(档, 'utf8'), 坏, '坏档必须原样留着，不能写成空表')
  } finally { rmSync(根, { recursive: true, force: true }) }
})
