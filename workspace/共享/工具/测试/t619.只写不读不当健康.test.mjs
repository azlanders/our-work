// 批次619：只写不读的产物不再按“健康链路”计。
// 只读 全套验收.mjs 源码，不运行体检、不碰 /data。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 源 = readFileSync(join(工具, '全套验收.mjs'), 'utf8')

const 段 = (起, 止) => {
  const i = 源.indexOf(起)
  const j = 源.indexOf(止)
  assert.ok(i >= 0 && j > i, `找不到源码段：${起}`)
  return 源.slice(i, j)
}

test('A1 奖惩账不在必查文件列表里，只作为历史留档', () => {
  const 必查 = 段('const files = [', 'for (const [f, name] of files)')
  const 留档 = 段('const archives = [', 'for (const [f, name] of archives)')
  assert.ok(!必查.includes('奖惩.json'), '奖惩.json 仍被当成必查健康链路')
  assert.ok(留档.includes('奖惩.json'), '奖惩.json 没进历史留档清单')
  assert.ok(源.includes('只写不读'), '没有标明“只写不读”')
})

test('A2 发送标签按投递审计留档，不当业务链路', () => {
  const 留档 = 段('const archives = [', 'for (const [f, name] of archives)')
  assert.ok(留档.includes('发送标签.jsonl'), '发送标签没进审计留档清单')
  assert.ok(!段('const files = [', 'for (const [f, name] of files)').includes('发送标签'),
    '发送标签被误列为必查业务文件')
})
