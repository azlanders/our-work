/**
 * 批次 640：链不会把同一条判断连落三次。
 *
 * 线上链尾出现过连续三条「老鼠到底是什么意思」：不是她判断了三次，是同一句
 * 被相邻回合又落了一遍，链尾注入就变成「A，还有 A」。
 * 现在 —— 判断和未决都一模一样（归一化空白后）且在这三条之内 —— 不重复落；
 * 措辞差一个字、或未决换了内容，照落。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const 跑 = promisify(execFile)
const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具目录 = path.join(本目录, '..')

const 造沙盒 = () => mkdtempSync(path.join(tmpdir(), 't640-'))
const 落 = async (沙盒, ...参) => {
  const r = await 跑(process.execPath, [path.join(工具目录, '链.mjs'), '--落', ...参], {
    encoding: 'utf8',
    env: { ...process.env, QQ_CHAIN_MEM: 沙盒 },
  })
  return String(r.stdout || '')
}
const 链 = (沙盒) => readFileSync(path.join(沙盒, '链.md'), 'utf8')
const 条数 = (沙盒) => (链(沙盒).match(/^- 判断：/gm) || []).length

test('T1 同一条判断连落两次：只留一条', async () => {
  const 盒 = 造沙盒()
  try {
    await 落(盒, '老鼠大概是个暗号')
    const 二 = await 落(盒, '老鼠大概是个暗号')
    assert.ok(二.includes('不重复落'), 二)
    assert.equal(条数(盒), 1)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T2 空白不同也算同一条', async () => {
  const 盒 = 造沙盒()
  try {
    await 落(盒, '老鼠大概是个暗号')
    await 落(盒, '  老鼠大概是个暗号  ')
    assert.equal(条数(盒), 1)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T3 判断相同但未决换了：照落（没吞新信息）', async () => {
  const 盒 = 造沙盒()
  try {
    await 落(盒, '老鼠大概是个暗号', '--未决', '要不要问')
    await 落(盒, '老鼠大概是个暗号', '--未决', '还是先别问')
    assert.equal(条数(盒), 2)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T4 措辞不同不是重复', async () => {
  const 盒 = 造沙盒()
  try {
    await 落(盒, '老鼠大概是个暗号')
    await 落(盒, '老鼠可能是个暗号')
    assert.equal(条数(盒), 2)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T5 只和最近三条比：隔远了同样的判断能再落', async () => {
  const 盒 = 造沙盒()
  try {
    await 落(盒, '同一句')
    await 落(盒, '第二句')
    await 落(盒, '第三句')
    await 落(盒, '第四句')
    await 落(盒, '同一句')
    assert.equal(条数(盒), 5, '超出最近三条就不算连写')
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})
