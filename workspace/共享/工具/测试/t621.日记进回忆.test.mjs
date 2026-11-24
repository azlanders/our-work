// 批次621：日记接进 qq_recall（日 / 词 / 最近），不再只写不读。
// 全部在临时目录里跑，不碰生产记忆。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 根 = mkdtempSync(join(tmpdir(), 't621-'))
const 记忆 = join(根, '记忆')
const 日记 = join(根, '日记')
mkdirSync(记忆, { recursive: true })
mkdirSync(日记, { recursive: true })

writeFileSync(join(记忆, '手账-2026-11-10.md'), [
  '# 2026-11-10',
  '- 08:06 · 去便利店买咖啡',
].join('\n'))
writeFileSync(join(日记, '2026-11-10.md'), [
  '# 2026-11-10',
  '',
  '八点零六分，我去买咖啡，二十二块。便利店里的冷气还没散。',
  '',
  '回到家，九点二十，我躺下了。',
].join('\n'))
writeFileSync(join(日记, '2026-11-11.md'), [
  '# 2026-11-11',
  '',
  '今天在窗边坐了很久，楼下有人在推车。',
].join('\n'))

const 跑 = (...args) => {
  const r = spawnSync(process.execPath, [join(工具, '回忆.mjs'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, QQ_RECALL_MEM: 记忆, QQ_RECALL_DIARY: 日记, QUIET_NOTE: '1' },
  })
  assert.equal(r.status, 0, r.stderr)
  return JSON.parse(r.stdout)
}

test('D1 --日 能翻到当天日记', () => {
  const j = 跑('--日', '2026-11-10', '--json')
  const 日记条 = j.条目.filter((x) => x.来源 === '日记')
  assert.ok(日记条.length >= 1, '没有日记条目：' + JSON.stringify(j.条目))
  assert.ok(日记条.some((x) => x.文.includes('冷气')), '日记正文没进来')
})

test('D2 --词 能搜到日记里的词', () => {
  const j = 跑('--词', '冷气', '--json')
  assert.ok(j.条目.some((x) => x.来源 === '日记' && x.文.includes('冷气')),
    '关键词没命中日记：' + JSON.stringify(j.条目))
})

test('D3 --最近 会把只有日记的那天也算进来', () => {
  const j = 跑('--最近', '2', '--json')
  assert.ok(j.条目.some((x) => x.来源 === '日记' && x.日 === '2026-11-11'),
    '只有日记的 11-11 没被算进最近：' + JSON.stringify(j.条目))
})

test.after(() => rmSync(根, { recursive: true, force: true }))
