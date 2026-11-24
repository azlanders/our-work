/**
 * 批次 639：翻旧账的 12 条上限不再静默。
 *
 * 原来 回忆.mjs 超过 12 条直接 slice，说明一个字不提；qq_recall 的渲染也只看
 * 「翻到 N 条」。她翻到 12 条就会当成「只有 12 条」照实说出去。
 * 现在：JSON 带 总数、说明写「只列前 12 条」，渲染把这句话拼在正文末尾。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

// 本文件会 import onebot 的 lib（recall.js）：按 t453 的规矩先闭嘴，
// 免得 register/note 往生产 qq-bridge-load.log 里写「registered」。
process.env.QUIET_NOTE = '1'

const 跑 = promisify(execFile)
const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具目录 = path.join(本目录, '..')
const 库目录 = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

const 造记忆 = (n) => {
  const 根 = mkdtempSync(path.join(tmpdir(), 't639-'))
  const 记忆 = path.join(根, '记忆')
  const 日记 = path.join(根, '日记')
  mkdirSync(记忆)
  mkdirSync(日记)
  const 行 = []
  for (let i = 0; i < n; i += 1) {
    const 时 = String(9 + Math.floor(i / 60)).padStart(2, '0')
    const 分 = String(i % 60).padStart(2, '0')
    行.push(`- ${时}:${分} · 去超市买第${i + 1}样东西`)
  }
  writeFileSync(path.join(记忆, '手账-2026-11-17.md'), `# 2026-11-17\n\n${行.join('\n')}\n`)
  return { 根, 记忆, 日记 }
}

const 翻 = async (沙盒, 参) => {
  const r = await 跑(process.execPath, [path.join(工具目录, '回忆.mjs'), ...参], {
    encoding: 'utf8',
    env: { ...process.env, QQ_RECALL_MEM: 沙盒.记忆, QQ_RECALL_DIARY: 沙盒.日记 },
  })
  return String(r.stdout || '')
}

test('T1 超过 12 条：JSON 带总数，说明写明只列前 12', async () => {
  const 沙盒 = 造记忆(20)
  try {
    const 出 = JSON.parse(await 翻(沙盒, ['--词', '超市', '--json']))
    assert.equal(出.总数, 20, '总数要如实给出')
    assert.equal(出.条数, 12, '明细仍然最多 12 条')
    assert.ok(出.说明.includes('只列前 12 条'), `说明要写清楚截断（实际：${出.说明}）`)
  } finally {
    rmSync(沙盒.根, { recursive: true, force: true })
  }
})

test('T2 没超上限：说明里不出现截断字样', async () => {
  const 沙盒 = 造记忆(5)
  try {
    const 出 = JSON.parse(await 翻(沙盒, ['--词', '超市', '--json']))
    assert.equal(出.总数, 5)
    assert.equal(出.条数, 5)
    assert.ok(!出.说明.includes('只列前'), '没截断就不要吓自己')
  } finally {
    rmSync(沙盒.根, { recursive: true, force: true })
  }
})

test('T3 纯文本模式也带总数', async () => {
  const 沙盒 = 造记忆(20)
  try {
    const 出 = await 翻(沙盒, ['--词', '超市'])
    assert.ok(出.includes('共 12 条（匹配 20 条，只列了前 12 条）'), 出.slice(-120))
  } finally {
    rmSync(沙盒.根, { recursive: true, force: true })
  }
})

test('T4 渲染：有明细时把说明拼在正文末尾', async () => {
  const { renderRecall } = await import(pathToFileURL(path.join(库目录, 'recall.js')).href)
  const 块 = renderRecall({
    ok: true,
    count: 1,
    total: 20,
    note: '匹配 20 条，这里只列前 12 条',
    items: [{ source: '手账', day: '2026-11-17', text: '去超市' }],
  })
  const 文 = 块[0].text
  assert.ok(文.includes('翻到 1 条'))
  assert.ok(文.includes('匹配 20 条'), '正文里必须能看见总数')
})

test('T5 渲染：一条没有时用说明兜底', async () => {
  const { renderRecall } = await import(pathToFileURL(path.join(库目录, 'recall.js')).href)
  const 块 = renderRecall({ ok: false, count: 0, items: [], note: '2026-11-01 没有手账也没有梦' })
  assert.equal(块[0].text, '2026-11-01 没有手账也没有梦')
})
