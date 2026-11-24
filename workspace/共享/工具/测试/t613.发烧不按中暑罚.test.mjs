// t613.发烧不按中暑罚.test.mjs —— 批次613（数值审计 P2-2）
//
// 文档一直写「发烧不算中暑，只按轻的罚」，但体温.档() 只看绝对体温：
// 39.3 度一律进「中暑」档，状态推进按罚 3 给体力上限加 12。
// 现在把「其中有多少是发烧」传进档位：病理热封顶在「很热」（罚 2）。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 测试目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具 = path.join(测试目录, '..')
const 温 = await import(pathToFileURL(path.join(工具, '体温.mjs')).href + '?t613')

test('T1 环境热 39.5 仍是中暑（罚 3）；发烧 39.5 封顶在发烧（罚 2）', () => {
  assert.equal(温.档(39.5).名, '中暑')
  assert.equal(温.档(39.5).罚, 3)
  assert.equal(温.档(39.5, 0.8).名, '发烧')
  assert.equal(温.档(39.5, 0.8).罚, 2)
})

test('T2 发烧不改变中低档：38.0 仍是热（罚 1），36.8 仍是刚好（罚 0）', () => {
  assert.equal(温.档(38.0, 0.8).名, '热')
  assert.equal(温.档(38.0, 0.8).罚, 1)
  assert.equal(温.档(36.8, 0.8).罚, 0)
  // 39.0 本来就在「很热」，加了发烧也还是 2，不额外加罚
  assert.equal(温.档(39.0, 0.8).罚, 2)
})

test('T3 源码回归：状态推进把发烧偏移传进档位', () => {
  const 体 = fs.readFileSync(path.join(工具, '体温.mjs'), 'utf8')
  assert.match(体, /export function 档\(温, 发烧 = 0\)/)
  assert.match(体, /名: '发烧', 冷热: '热', 罚: 2/)
  const 状 = fs.readFileSync(path.join(工具, '状态推进.mjs'), 'utf8')
  assert.match(状, /体温\.档\(__温读\.体温, __病\.发烧偏移\)/)
})
