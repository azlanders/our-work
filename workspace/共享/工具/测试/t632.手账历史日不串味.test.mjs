// t632 —— 补写历史手账时，不许把“现在”的位置/钱/精力/心气/病情写进过去。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const SRC = process.env.HANDZHAO_SOURCE || '{{BOT_ROOT}}/共享/工具/手账.mjs'
const 今天 = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
const 历史日 = '2026-11-10'

function 造() {
  const sb = mkdtempSync(join(tmpdir(), 't632-'))
  const mem = join(sb, '记忆')
  mkdirSync(mem, { recursive: true })
  const anchor = "const 根 = '{{BOT_ROOT}}/记忆';"
  const src = readFileSync(SRC, 'utf8')
  assert.equal(src.split(anchor).length - 1, 1, '手账根路径锚点必须唯一')
  const script = join(sb, '手账-t632.mjs')
  writeFileSync(script, src.replace(anchor, `const 根 = ${JSON.stringify(mem)};`))
  writeFileSync(join(mem, '资产.json'), JSON.stringify({
    记录: [
      { at: `${历史日} 08:00`, what: '历史早饭' },
      { at: `${今天} 08:00`, what: '今天的早饭' },
    ],
    位置: '客厅', 钱: 123, 包: ['伞'],
  }))
  writeFileSync(join(mem, '状态.json'), JSON.stringify({ energy: 77 }))
  writeFileSync(join(mem, '内心.md'), '现在心里很乱')
  writeFileSync(join(mem, '疾病.json'), JSON.stringify({
    史: [], 当前: [{ 名: '感冒', 重: 0.3, 症状: ['咳'] }],
  }))
  return { sb, script }
}

function 跑(script, day) {
  const r = spawnSync(process.execPath, [script, '--day', day, '--print'], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout
}

test('B1 历史日只写当时的事实，不写当前位置/钱/精力/心气/病情', () => {
  const { sb, script } = 造()
  try {
    const out = 跑(script, 历史日)
    assert.match(out, /^# 2026-11-10 手账/)
    assert.match(out, /历史早饭/)
    assert.doesNotMatch(out, /客厅|钱 123|精力 77|现在心里很乱|还病着/)
    assert.match(out, /历史补记/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('B2 今天照旧写当前状态与心气', () => {
  const { sb, script } = 造()
  try {
    const out = 跑(script, 今天)
    assert.match(out, /今天的早饭/)
    assert.match(out, /位置 客厅/)
    assert.match(out, /钱 123/)
    assert.match(out, /精力 77/)
    assert.match(out, /现在心里很乱/)
    assert.match(out, /还病着/)
    assert.doesNotMatch(out, /历史补记/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('B3 状态.json 缺失时今天照常生成，精力写 ? 而不是整份失败', () => {
  const { sb, script } = 造()
  try {
    rmSync(join(sb, '记忆', '状态.json'))
    const out = 跑(script, 今天)
    assert.match(out, /今天的早饭/)
    assert.match(out, /精力 \?/)
    assert.match(out, /位置 客厅/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('B4 历史文件里原本真实的“今天：/那天的心气：”要保住，不能被补记覆盖', () => {
  const { sb, script } = 造()
  try {
    const 旧 = [
      `# ${历史日} 手账`,
      '',
      '- 08:00 · 历史早饭',
      '',
      '今天：位置 老客厅 · 钱 999 · 包里有 2 件 · 精力 44',
      '',
      '那天的心气：那天是真的有点开心',
      '',
    ].join('\n')
    writeFileSync(join(sb, '记忆', `手账-${历史日}.md`), 旧)
    const out = 跑(script, 历史日)
    assert.match(out, /位置 老客厅/)
    assert.match(out, /钱 999/)
    assert.match(out, /那天是真的有点开心/)
    assert.doesNotMatch(out, /历史补记/)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})
