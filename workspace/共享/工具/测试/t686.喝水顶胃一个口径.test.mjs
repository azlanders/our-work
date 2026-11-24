import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 批次 686：同一瓶水，杯子喝（0.25/毫升）和买来喝（物品表约 1.1/毫升）差 4 倍。
// 统一成 1 毫升 = 1 胃单位；挂水走静脉，不进胃。

const 工具 = process.env.QQ_TEST_TOOLS || join(dirname(fileURLToPath(import.meta.url)), '..')

async function 开(mem) {
  process.env.BAOKE_MEM = mem
  const m = await import(pathToFileURL(join(工具, '饱渴.mjs')).href + '?t=' + Math.random())
  return m
}

const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

test('S1 杯子喝 450ml：胃 +450', async () => {
  const mem = mkdtempSync(join(tmpdir(), 't686-'))
  try {
    writeFileSync(join(mem, '饱渴.json'), JSON.stringify({
      血糖: 5.2, 血At: bj(), 水: 1000, 水At: bj(),
      卡: 1000, 卡At: bj(), 胃: 0, 胃At: bj(),
      欠: 0, 欠At: bj(), 账: [],
    }))
    const m = await 开(mem)
    m.喝(450)
    const 胃 = Number(读(join(mem, '饱渴.json')).胃)
    assert.ok(胃 >= 448 && 胃 <= 452, `喝 450ml 胃变成 ${胃}`)
  } finally { rmSync(mem, { recursive: true, force: true }) }
})

test('S2 和物品表同一个量级（450ml 水 顶胃 500，允许 15%）', (t) => {
  const 候选 = [
    join(工具, '..', '..', '记忆', '物品总表.json'),
    join(工具, '..', '记忆', '物品总表.json'),
    '{{BOT_ROOT}}/记忆/物品总表.json',
  ]
  const p = 候选.find((x) => existsSync(x))
  if (!p) return t.skip('本地镜像没有物品总表，线上跑')
  const 表 = JSON.parse(readFileSync(p, 'utf8'))
  const 水 = (表?.分组?.吃喝?.喝 || 表?.分组?.喝 || 表?.喝)?.水?.吃
  assert.ok(水, '物品表里要有水')
  const 顶 = Number(水.顶胃)
  const 毫升 = Number(水.补水)
  assert.ok(Math.abs(毫升 - 顶) / 顶 <= 0.15, `${毫升}ml→顶胃 ${顶}，按 1:1 差得太多`)
})

test('S3 挂水不进胃', async () => {
  const mem = mkdtempSync(join(tmpdir(), 't686-'))
  try {
    writeFileSync(join(mem, '饱渴.json'), JSON.stringify({
      血糖: 5.2, 血At: bj(), 水: 1000, 水At: bj(),
      卡: 1000, 卡At: bj(), 胃: 200, 胃At: bj(),
      欠: 0, 欠At: bj(), 账: [],
    }))
    const m = await 开(mem)
    m.补液(500, 100, 0.1)
    const 后 = 读(join(mem, '饱渴.json'))
    assert.ok(Number(后.胃) <= 202, `挂水后胃变成 ${后.胃}`)
    assert.ok(Number(后.水) >= 1490, '挂水还是要补水')
  } finally { rmSync(mem, { recursive: true, force: true }) }
})
