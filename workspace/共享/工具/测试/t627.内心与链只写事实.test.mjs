// 批次627：内心、自动梦整合、链尾都只递事实，不再由代码生成第一人称判断。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const TOOLS = process.env.QQ_TOOLS_DIR || '{{BOT_ROOT}}/共享/工具'
const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

function 造内心() {
  const sb = mkdtempSync(join(tmpdir(), 't627-inner-'))
  const mem = join(sb, 'mem')
  mkdirSync(mem, { recursive: true })
  const w = (n, o) => writeFileSync(join(mem, n), typeof o === 'string' ? o : JSON.stringify(o))
  w('状态.json', { energy: 62, 困意: 34, mood: { label: '平常' } })
  w('好感度.json', { people: { '1': { score: 82, 熟悉度: 70, turns: 20 } } })
  w('怨.json', { people: { '1': { level: 12 } } })
  w('别扭.json', { people: { '1': { level: 8 } } })
  w('想要.json', { 当下想要: [{ what: '把窗台擦干净' }] })
  w('惦记.jsonl', JSON.stringify({ what: '还没回他消息', who: '1', done: false }) + '\n')
  w('资产.json', { 记录: [] })
  w(`梦-${今天}.md`, `# ${今天} 梦\n余味: 暖光还没散\n`)
  const cfg = join(sb, 'qq-bridge.config.json')
  writeFileSync(cfg, JSON.stringify({ ownerUin: '1' }))
  return { sb, mem, cfg }
}

function 跑内心({ mem, cfg }) {
  return execFileSync(process.execPath, [join(TOOLS, '内心.mjs'), '--print'], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, QQ_INNER_MEM: mem, QQ_BRIDGE_CONFIG: cfg },
  })
}

test('I1 内心输出是结构化事实，不是第一人称模板', () => {
  const 盒 = 造内心()
  try {
    const out = 跑内心(盒)
    assert.match(out, /精力 62\/100/)
    assert.match(out, /困意 34\/100/)
    assert.match(out, /好感 82\/100/)
    assert.match(out, /熟悉 70\/100/)
    assert.match(out, /愿望：把窗台擦干净/)
    assert.match(out, /惦记：还没回他消息/)
    assert.match(out, /梦素材：暖光还没散/)
    assert.ok(!out.includes('我挺在意你'), '第一人称关系模板还在')
    assert.ok(!out.includes('脑子像泡在水里'), '第一人称困意模板还在')
    assert.ok(!out.includes('跟你熟了'), '第一人称亲近模板还在')
    assert.ok(!out.includes('昨晚那个梦'), '梦余味仍被拼成第一人称句子')
  } finally { rmSync(盒.sb, { recursive: true, force: true }) }
})

test('I2 自动梦整合只写「事实 / 未决」，不写第一人称判断', () => {
  const sb = mkdtempSync(join(tmpdir(), 't627-chain-'))
  try {
    writeFileSync(join(sb, `梦-${今天}.md`), `# ${今天} 梦\n余味: 走廊尽头的灯一直亮着\n`)
    writeFileSync(join(sb, '内心.md'), '')
    const out = execFileSync(process.execPath, [join(TOOLS, '做梦整合.mjs'), '--print'], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, DREAM_INTEGRATE_MEM: sb, DREAM_INTEGRATE_DAY: 今天 },
    })
    assert.match(out, /- 事实：/)
    assert.match(out, /- 未决：/)
    assert.ok(!out.includes('- 判断：'), '仍在写判断行')
    assert.ok(!/突然想起一件事|今天绕回来好几遍|没跟自己算清/.test(out), '第一人称判断模板还在')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('I3 挑怕的只返回「怕：…」，不再返回第一人称句子', async () => {
  const { 挑怕的 } = await import(pathToFileURL(join(TOOLS, '心气.mjs')).href)
  const s = 挑怕的([{ what: '被换掉', level: 3 }], new Date(Date.UTC(2026, 10, 17, 4)), '')
  assert.equal(s, '怕：被换掉')
})
