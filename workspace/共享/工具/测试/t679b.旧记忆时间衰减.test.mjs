// t679b —— rofm 旧记忆时间衰减（批次 679，审计 P1-6）
//
// 只改权重：α 乘一个按事件结束时间/归档时间计算的软衰减系数。
// 不改正文、不生成台词、不删旧记忆；关掉 recency.enabled 就回到原权重。
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 源目录 = path.resolve(本目录, '..', '..')
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0)

// ROFM_NAMES 2026-11-17（批次 679 上线修正）：本地镜像是 rofm-engine-*.js 扁平命名，
// 线上是 engine/recency.js、engine/recall-index.js。两种都认，测试才能既在本地跑也在线上跑。
const 引擎目录 = process.env.ROFM_ENGINE_DIR || 源目录
const 找 = (...名) => {
  for (const n of 名) { const p = path.join(引擎目录, n); if (existsSync(p)) return p }
  // 线上默认位置：工具目录旁边没有引擎文件，真实包在 dsh-rofm/engine。
  const 默认 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm/engine'
  for (const n of 名) { const p = path.join(默认, n); if (existsSync(p)) return p }
  return path.join(引擎目录, 名[0])
}
const recSrc = 找('rofm-engine-recency.js', 'recency.js')
const idxSrc = 找('rofm-engine-recall-index.js', 'recall-index.js')

const rec = await import(pathToFileURL(recSrc).href + '?t679b=1')

// 本地镜像没有 engine/tokenize.js / keyword-match.js；用最小桩把真正的
// recall-index.js 跑起来，至少验证 buildRecallIndex/comparePriority 的接线。
const 桩目录 = mkdtempSync(path.join(tmpdir(), 't679b-'))
copyFileSync(idxSrc, path.join(桩目录, 'recall-index.js'))
copyFileSync(recSrc, path.join(桩目录, 'recency.js'))
writeFileSync(path.join(桩目录, 'tokenize.js'), [
  'export function normalizeText(value) { return String(value ?? "").toLowerCase().replace(/[\\s\\p{P}\\p{S}]+/gu, "") }',
  'export function tokenize(value) { const text = normalizeText(value); return text ? [text] : [] }',
  'export function extractKeywords(value) { const text = normalizeText(value); return text ? [text] : [] }',
].join('\n'), 'utf8')
writeFileSync(path.join(桩目录, 'keyword-match.js'), [
  'export function matchKeywords(text, keywords) { const value = String(text ?? ""); const hit = (keywords || []).some((word) => value.includes(String(word ?? ""))); return { matchCount: hit ? 1 : 0 } }',
].join('\n'), 'utf8')
const fairLocal = await import(pathToFileURL(path.join(桩目录, 'recall-index.js')).href + '?t679b=local')

const 近似 = (actual, expected, eps = 1e-9) => {
  assert.ok(Math.abs(actual - expected) < eps, `期望 ${expected}，实际 ${actual}`)
}

test('A1 默认参数：180 天半衰、0.35 地板', () => {
  const cfg = rec.recencyConfig({})
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.halfLifeDays, 180)
  assert.equal(cfg.floor, 0.35)
})

test('A2 刚发生/未来/没时间都保持满权重', () => {
  const cfg = rec.recencyConfig({})
  assert.equal(rec.recencyFactor(NOW, NOW, cfg), 1)
  assert.equal(rec.recencyFactor(NOW + 3 * DAY, NOW, cfg), 1)
  assert.equal(rec.recencyFactor(0, NOW, cfg), 1)
  assert.equal(rec.recencyFactor(undefined, NOW, cfg), 1)
})

test('A3 半年前明显低于昨天，一年后接近地板', () => {
  const cfg = rec.recencyConfig({})
  const 昨天 = rec.recencyFactor(NOW - DAY, NOW, cfg)
  const 半年 = rec.recencyFactor(NOW - 180 * DAY, NOW, cfg)
  const 一年 = rec.recencyFactor(NOW - 365 * DAY, NOW, cfg)
  assert.ok(昨天 > 0.99, `昨天应接近 1，实际 ${昨天}`)
  近似(半年, 0.675)
  assert.ok(一年 > 0.5 && 一年 < 0.52, `一年应约 0.51，实际 ${一年}`)
  assert.ok(半年 < 昨天, '半年前不该和昨天同权')
})

test('A4 再老也只落到地板，不会归零', () => {
  const cfg = rec.recencyConfig({})
  const 十年 = rec.recencyFactor(NOW - 3650 * DAY, NOW, cfg)
  assert.ok(十年 >= 0.35 && 十年 < 0.36, `十年应接近地板 0.35，实际 ${十年}`)
})

test('A5 事件结束时间优先于归档时间（旧归档、新事件不误伤）', () => {
  const cfg = rec.recencyConfig({})
  const 归档 = NOW - 730 * DAY
  const 事件结束 = NOW - DAY
  const at = rec.memoryTimestamp(归档, 事件结束)
  assert.equal(at, 事件结束)
  assert.ok(rec.recencyFactor(at, NOW, cfg) > 0.99)
})

test('A6 关闭衰减回到原权重（回滚开关）', () => {
  const cfg = rec.recencyConfig({ recall: { recency: { enabled: false } } })
  assert.equal(rec.recencyFactor(NOW - 3650 * DAY, NOW, cfg), 1)
  assert.equal(rec.recencyAdjustedAlpha(0.8, NOW - 3650 * DAY, NOW, cfg), 0.8)
})

test('A7 新近的普通事实能压过一年前的高分事实', () => {
  const cfg = rec.recencyConfig({})
  const 新 = rec.recencyAdjustedAlpha(0.5, NOW - DAY, NOW, cfg)
  const 旧 = rec.recencyAdjustedAlpha(0.8, NOW - 365 * DAY, NOW, cfg)
  assert.ok(新 > 旧, `新 0.5 应压过旧 0.8：${新} vs ${旧}`)
})

test('B1 fair 索引与 legacy 路都接线到同一份衰减函数', () => {
  const fair = readFileSync(idxSrc, 'utf8')
  const legacy = readFileSync(找('rofm-engine-recall.js', 'recall.js'), 'utf8')
  const engine = readFileSync(找('rofm-engine-engine.js', 'engine.js'), 'utf8')
  assert.match(fair, /from '\.\/recency\.js'/, 'fair 索引没接 recency')
  assert.match(fair, /rankAlpha/, 'fair 索引没算衰减权重')
  assert.match(legacy, /from '\.\/recency\.js'/, 'legacy 召回没接 recency')
  assert.match(legacy, /scale \* rankAlpha/, 'legacy 概率没用衰减权重')
  assert.match(engine, /recencyCacheBucket/, '索引缓存不会随时间桶重建')
})

test('C0 本地真跑 buildRecallIndex：一年前的 0.95 排到昨天的 0.8 后面', () => {
  const cfg = { recall: { recency: { enabled: true, halfLifeDays: 180, floor: 0.35 }, fairness: { thetaHigh: 0.6 } } }
  const index = fairLocal.buildRecallIndex([
    { id: 'old', alpha: 0.95, createdAt: NOW - 365 * DAY, keywords: ['猫'], scored: true },
    { id: 'new', alpha: 0.8, createdAt: NOW - DAY, keywords: ['猫'], scored: true },
  ], cfg, { now: NOW })
  const old = index.entries.find((entry) => entry.id === 'old')
  const fresh = index.entries.find((entry) => entry.id === 'new')
  assert.ok(fresh.rankAlpha > old.rankAlpha, `新 ${fresh.rankAlpha} 应高于旧 ${old.rankAlpha}`)
  assert.ok(fairLocal.comparePriority(fresh, old) < 0, 'comparePriority 没按衰减权重排')
})

test('C0b 本地真跑 selectRecall：高优先级车道先选新记忆', () => {
  const cfg = {
    recall: {
      recency: { enabled: true, halfLifeDays: 180, floor: 0.35 },
      fairness: { thetaHigh: 0.6, exploreRatio: 0.2 },
    },
  }
  const index = fairLocal.buildRecallIndex([
    { id: 'old', alpha: 0.95, createdAt: NOW - 365 * DAY, keywords: ['猫'], scored: true },
    { id: 'new', alpha: 0.8, createdAt: NOW - DAY, keywords: ['猫'], scored: true },
  ], cfg, { now: NOW })
  const result = fairLocal.selectRecall(index, '猫', {
    cfg,
    lanes: fairLocal.emptyLanes(),
    round: 1,
    k: 3,
  })
  assert.equal(result.picks[0]?.id, 'new', `高优先级车道先选了 ${result.picks[0]?.id}`)
})

test('C0c 关闭开关后 buildRecallIndex 的 rankAlpha 回到原始 α', () => {
  const cfg = { recall: { recency: { enabled: false } } }
  const index = fairLocal.buildRecallIndex([
    { id: 'old', alpha: 0.95, createdAt: NOW - 3650 * DAY, keywords: ['猫'], scored: true },
  ], cfg, { now: NOW })
  assert.equal(index.entries[0].rankAlpha, 0.95)
})

test('C0d trimBlock 按衰减权重淘汰：一年前高分不再永久压住新记忆', () => {
  const cfg = { recall: { recency: { enabled: true, halfLifeDays: 180, floor: 0.35 }, fairness: { thetaHigh: 0.6 } } }
  const index = fairLocal.buildRecallIndex([
    { id: 'old', alpha: 0.95, createdAt: NOW - 365 * DAY, keywords: ['猫'], scored: true },
    { id: 'new', alpha: 0.8, createdAt: NOW - DAY, keywords: ['猫'], scored: true },
  ], cfg, { now: NOW })
  const trimmed = fairLocal.trimBlock([{ id: 'old' }, { id: 'new' }], {
    index,
    cfg,
    maxBlocks: 1,
    maxChars: 100000,
  })
  assert.deepEqual(trimmed.keep.map((item) => item.id), ['new'])
})

after(() => rmSync(桩目录, { recursive: true, force: true }))

// 有完整 dsh-rofm 包时再跑一次真集成；本地镜像没有 engine/config.js 等依赖时跳过。
const 根 = (() => {
  const 指定 = String(process.env.QQ_ROFM_DIR ?? '').trim()
  if (指定 !== '') return 指定
  const 默认 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm'
  return existsSync(path.join(默认, 'engine', 'recency.js')) ? 默认 : ''
})()
const 可用 = 根 !== '' && existsSync(path.join(根, 'engine', 'recall-index.js'))
const 跳过 = '找不到完整 dsh-rofm（engine/recall-index.js + engine/recency.js）'
const fairMod = 可用 ? await import(pathToFileURL(path.join(根, 'engine', 'recall-index.js')).href) : null

test('C1 buildRecallIndex：一年前的 0.95 排序低于昨天的 0.8', { skip: 可用 ? false : 跳过 }, () => {
  const cfg = { recall: { recency: { enabled: true, halfLifeDays: 180, floor: 0.35 }, fairness: { thetaHigh: 0.6 } } }
  const index = fairMod.buildRecallIndex([
    { id: 'old', alpha: 0.95, createdAt: NOW - 365 * DAY, keywords: ['猫'], scored: true },
    { id: 'new', alpha: 0.8, createdAt: NOW - DAY, keywords: ['猫'], scored: true },
  ], cfg, { now: NOW })
  const old = index.entries.find((entry) => entry.id === 'old')
  const fresh = index.entries.find((entry) => entry.id === 'new')
  assert.ok(fresh.rankAlpha > old.rankAlpha, `新 ${fresh.rankAlpha} 应高于旧 ${old.rankAlpha}`)
  assert.ok(fairMod.comparePriority(fresh, old) < 0, 'comparePriority 没按衰减权重排')
})
