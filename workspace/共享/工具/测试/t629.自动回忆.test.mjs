// t629 —— 自动回忆只递事实：线索命中才翻，找不到不硬凑。
// 从插件 lib 取模块，按 t453 的规矩先闭嘴，别往生产日志写 registered。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 自动回忆段 } = await import(pathToFileURL(join(LIB, '自动回忆.mjs')).href)

const 今 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const 昨 = new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10)

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 'recall629-'))
  const mem = join(sb, 'mem')
  const diary = join(sb, 'diary')
  mkdirSync(mem, { recursive: true })
  mkdirSync(diary, { recursive: true })
  writeFileSync(join(mem, `手账-${昨}.md`), [
    `# 手账 ${昨}`,
    '- 20:10 · 在群里聊北卡，记下了这个词',
    '- 21:00 · 回家路上买了热牛奶',
  ].join('\n'))
  writeFileSync(join(diary, `${今}.md`), `# ${今}\n\n今天去图书馆坐了很久，翻了几页书。\n`)
  writeFileSync(join(mem, '链.md'), [
    `## ${今} 12:00`,
    '- 事实：图书馆的窗边位置还空着',
  ].join('\n'))
  return { sb, mem, diary }
}

test('R1 记得/北卡：只从记录里抽一条事实，不写第一人称', () => {
  const { sb, mem, diary } = 造()
  try {
    const out = 自动回忆段('你还记得北卡吗', { mem, diary })
    assert.match(out, /\[旧事素材\]/)
    assert.match(out, /北卡/)
    assert.doesNotMatch(out, /我想起来|你一说|忽然想起/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R2 日记也进入自动回忆，不只看手账', () => {
  const { sb, mem, diary } = 造()
  try {
    const out = 自动回忆段('上次去图书馆是什么时候', { mem, diary })
    assert.match(out, /日记|图书馆/)
    assert.doesNotMatch(out, /我想起来|你一说/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R3 不是回忆问题就不扫，也不追加噪音', () => {
  const { sb, mem, diary } = 造()
  try {
    assert.equal(自动回忆段('今天天气怎么样', { mem, diary }), '')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R4 有线索但记录里没有，就不硬凑', () => {
  const { sb, mem, diary } = 造()
  try {
    assert.equal(自动回忆段('你还记得火星吗', { mem, diary }), '')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R5 明确问昨天：即使没有关键词，也给昨天的事实', () => {
  const { sb, mem, diary } = 造()
  try {
    const out = 自动回忆段('昨天我都干什么了', { mem, diary })
    assert.match(out, new RegExp(昨))
    assert.match(out, /热牛奶|北卡/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R6 条数和字符预算有上限', () => {
  const { sb, mem, diary } = 造()
  try {
    writeFileSync(join(mem, `手账-${今}.md`), Array.from({ length: 12 }, (_, i) =>
      `- ${String(i).padStart(2, '0')}:00 · 今天的事第 ${i} 条，写得很长很长，用来压预算`).join('\n'))
    const out = 自动回忆段('今天都做了什么', { mem, diary, maxItems: 2, maxChars: 260 })
    const lines = out.split('\n').filter((x) => x.startsWith('- '))
    assert.ok(lines.length <= 2, '超过条数上限：' + out)
    assert.ok(out.length <= 260, '超过字符预算：' + out.length)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

