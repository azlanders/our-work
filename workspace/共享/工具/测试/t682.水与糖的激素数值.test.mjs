// t682 —— 批次682：喝水不该拿一顿饭的多巴胺；糖的提神不该被食困盖过
//
// 两条都是「事件 → 数值」对照表里查出来的（40-文档/机制-大白话.md「可疑项」第 5、6 条）：
//   · 水/矿泉水/气泡水 的效果.激素写着「吃饭」→ 多巴胺 +6，和一顿饭一样；
//   · 糖 提神 -2，却因为「甜」拿 40 分钟食困峰 +2.5，净效果约 +0.5，越吃越困。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
const 记忆 = process.env.QQ_PROD_MEM || '{{BOT_ROOT}}/记忆'
const 名 = ['水', '矿泉水', '气泡水']

const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('G1 源码：糖的食困峰固定 1，不再按价格算到 2.5', () => {
  const 源 = readFileSync(join(工具, '花钱.mjs'), 'utf8')
  assert.match(源, /SUGAR_DROWSY/, '缺少批次682 注释锚点')
  assert.match(源, /const 峰 = __甜 \? 1 :/)
})

test('G2 商店表：三件水的激素不再是「吃饭」', () => {
  const p = join(工具, '商店-生活.json')
  if (!existsSync(p)) return
  const s = 读(p).商品 || {}
  for (const k of 名) {
    if (!s[k]) continue
    assert.notEqual(String((s[k].效果 || {}).激素 || ''), '吃饭', `${k} 还在挂「吃饭」`)
  }
})

test('G3 物品总表：三件水的激素不再是「吃饭」', () => {
  const p = join(记忆, '物品总表.json')
  if (!existsSync(p)) return
  const 喝 = (读(p).分组 || {}).吃喝?.喝 || {}
  for (const k of 名) {
    if (!喝[k]) continue
    assert.notEqual(String((喝[k].效果 || {}).激素 || ''), '吃饭', `${k} 还在挂「吃饭」`)
  }
})

test('G4 真跑一次：糖写进困意账的食困峰 ≤ 1', () => {
  const 根 = mkdtempSync(join(tmpdir(), 't682-'))
  try {
    writeFileSync(join(根, '状态.json'), JSON.stringify({ 困意: 40, 困意账: [] }), 'utf8')
    const e = { ...process.env, QQ_AUTONOMY_MEM: 根 }
    delete e.NODE_OPTIONS
    execFileSync(process.execPath, [join(工具, '花钱.mjs'), '--生效', '糖'], {
      encoding: 'utf8', timeout: 20000, env: e,
    })
    const st = 读(join(根, '状态.json'))
    const 账 = Array.isArray(st.困意账) ? st.困意账 : []
    const 饭 = 账.find((x) => String(x.kind) === '饭后')
    if (饭) assert.ok(Number(饭.峰) <= 1, `食困峰 ${饭.峰}，应该 ≤ 1`)
    const 提 = 账.find((x) => String(x.kind) === '提神')
    assert.ok(提 && Number(提.值) === -2, '糖的提神 -2 应该还在')
  } finally { rmSync(根, { recursive: true, force: true }) }
})
