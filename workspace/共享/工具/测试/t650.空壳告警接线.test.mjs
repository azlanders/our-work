// 批次649 接线：647 的「跳过纯工具 folder」必须在宿主里真的打出来
//
// 647 只改了 engine：把空壳 folder 塞进 result.warnings。宿主 `lib/plugin.js`
// 拿到结果从来不打印，所以线上 grep 永远是 0 —— 等于跳过这件事不可观测。
// 这条用例锁死三件事：①取的是 tool-only 告警；②有 5 分钟节流；③位置在 engine.recall() 之后。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROFM = process.env.QQ_ROFM_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm'
const 读 = (p) => readFileSync(p, 'utf8')

test('H1 plugin.js 把 tool-only 告警打出来（带 5 分钟节流）', () => {
  const s = 读(join(ROFM, 'lib', 'plugin.js'))
  assert.match(s, /includes\('tool-only'\)/, '没有按 tool-only 过滤告警')
  // BATCH655：空壳改成建索引前排除，engine 改发一条中文汇总。
  // 宿主必须两种都认，否则换了实现告警就静默 —— 647 的教训。
  assert.match(s, /只有工具回执/, '没有认中文汇总告警（655 换实现后会静默）')
  assert.match(s, /__lastToolOnlyLog/, '没有节流变量（会每轮刷屏）')
  assert.match(s, /5 \* 60e3/, '节流窗口不是 5 分钟')
})

test('H2 打印点在 engine.recall() 之后，不在之前', () => {
  const s = 读(join(ROFM, 'lib', 'plugin.js'))
  const 召回 = s.indexOf('const result = engine.recall(')
  const 打印 = s.indexOf("includes('tool-only')")
  assert.ok(召回 > 0, '找不到 engine.recall 调用')
  assert.ok(打印 > 召回, '告警取在召回之前 —— 拿不到 result.warnings')
})

test('H3 engine 仍然会产出这条告警（647 的判据还在）', () => {
  const s = 读(join(ROFM, 'engine', 'recall.js'))
  assert.match(s, /skipped tool-only folder/, 'engine 不再写这条告警，宿主就永远打不出来')
  assert.match(s, /only-tool-receipts/, 'engine 没引用判据模块')
})

test('H4 655：空壳在建索引前就被排除，不再只是装填时跳过', () => {
  const s = 读(join(ROFM, 'engine', 'engine.js'))
  assert.match(s, /只有工具回执/, 'engine.js 没引用判据模块')
  assert.match(s, /_recallToolOnlyIds/, '没有记录空壳 id 集合')
  const 建索引 = s.indexOf('buildRecallIndex(可召回')
  assert.ok(建索引 > 0, '没有在建索引时排除空壳（647 只做了装填时跳过）')
  assert.ok(s.indexOf('_recallToolOnlyIds') < 建索引, '空壳集合在排除之后才取，顺序反了')
})

test('H5 655：排除后仍有一条汇总告警，不是彻底静默', () => {
  const s = 读(join(ROFM, 'engine', 'engine.js'))
  assert.match(s, /已排除 .* 个只有工具回执的 folder/, '没有汇总告警，排除了多少就看不见了')
})
