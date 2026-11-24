/**
 * 批次 642：印象线索不再取残句。
 *
 * 线上 印象.json 13 条全是旧的第一人称模板（「我私下想起你，还是聊起『灵异事件』，
 * 早把你当自己人」），而 626 已经把生成端改成只写事实 —— 迁移之所以没发生，
 * 是因为线索质量太差：干跑出来的新值是「素材：聊起『这是接近的。。。』」。
 *
 * 这里锁两件事：
 * ① 取线索时跳过残句、纯标点、复读（「哈哈哈」「。。。」）；
 * ② 生成的条目只有「素材/档位/熟悉/好感/轮数」，不出现第一人称印象句。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 脚本 = path.join(本目录, '..', '印象更新.mjs')

const 跑 = (盒, 参数 = []) => {
  const 出 = execFileSync(process.execPath, [脚本, '印象素材.json', '--force', '--print', ...参数], {
    encoding: 'utf8',
    env: { ...process.env, QQ_MEM: 盒 },
  })
  return JSON.parse(出)
}

const 造 = (log) => {
  const 盒 = mkdtempSync(path.join(tmpdir(), 't642-'))
  writeFileSync(path.join(盒, '印象素材.json'), JSON.stringify({
    people: [{ qq: '1', turns: 30, favor: 62, familiarity: 58, log }],
  }))
  return 盒
}

test('T1 残句不当线索：挑同一段里像话的那半句', () => {
  const 盒 = 造([{ kind: '日常', text: '这是接近的。。。其实上次说的那个鲸鱼视频挺有意思' }])
  try {
    const 值 = 跑(盒)['1']
    assert.ok(!值.includes('这是接近的'), 值)
    assert.ok(值.includes('鲸鱼视频'), 值)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T2 纯标点/复读不当线索', () => {
  const 盒 = 造([{ kind: '日常', text: '。。。。' }, { kind: '日常', text: '哈哈哈哈' }])
  try {
    const 值 = 跑(盒)['1']
    assert.ok(!值.includes('。。。'), 值)
    assert.ok(!值.includes('哈哈哈哈'), 值)
    assert.ok(值.startsWith('素材：'), 值)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T3 正常一句话照常进线索', () => {
  const 盒 = 造([{ kind: '日常', text: '一起去看了鲸鱼纪录片' }])
  try {
    assert.ok(跑(盒)['1'].includes('鲸鱼纪录片'))
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T4 生成的条目里没有第一人称印象句', () => {
  const 盒 = 造([{ kind: '日常', text: '一起去看了鲸鱼纪录片' }])
  try {
    const 值 = 跑(盒)['1']
    assert.ok(!/说起你|我还记着|我总会想起|早把你当自己人|让我记住你/.test(值), 值)
    assert.match(值, /^素材：/)
    assert.match(值, /档位：/)
    assert.match(值, /聊过 30 轮/)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T5 旧的第一人称值会被迁成事实格式', () => {
  const 盒 = 造([{ kind: '日常', text: '一起去看了鲸鱼纪录片' }])
  try {
    writeFileSync(path.join(盒, '印象.json'), JSON.stringify({ 1: '我私下想起你，还是聊起「灵异事件」，早把你当自己人了' }))
    const 值 = 跑(盒)['1']
    assert.ok(值.startsWith('素材：'), 值)
    assert.ok(!值.includes('早把你当自己人'), 值)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T6 好感度 log 的 why 字段才是有内容的线索（不是群聊残句）', () => {
  // CLUE_FIELD 2026-11-17（批次645）：线上 log 只有 why，没有 text/内容/clue。
  // 原来三个字段都不认 → 每次都掉进群聊日志兜底 → 印象里全是残句。
  const 盒 = 造([
    { kind: '日结', why: '今天说了几百句', n: 542 },
    { kind: '自评', why: '陪伴：他说「虽然我陪不了你 但是至少能跟你聊聊天」——人不在也愿意陪着说话。' },
  ])
  try {
    const 值 = 跑(盒)['1']
    assert.ok(!/今天说了/.test(值), '日结不该当线索：' + 值)
    // 线索按 14 字截断（长期印象不该塞整段），所以只钉开头是不是自评那条。
    assert.ok(值.includes('陪伴'), '自评里的 why 没被用上：' + 值)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T7 只有日结时也用它兜底（不至于完全没线索）', () => {
  // 线索取词会去掉数字（数字当线索没意义），所以这里用不含数字的说法。
  const 盒 = 造([{ kind: '日结', why: '今天说了好几句', n: 62 }])
  try {
    // 645：日结也属于账本（「今天说了 N 句」），不该进印象；
    // 真的没有任何事件时宁可写「暂无」，也不要拿一句计数冒充「聊起过什么」。
    assert.ok(跑(盒)['1'].includes('暂无'))
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})

test('T8 迁移账本不当线索（v1→v2 框架重置）', () => {
  const 盒 = 造([
    { kind: '迁移', why: 'v1→v2 框架重置（按原分反推，原档留在 legacy）' },
    { kind: '日结', why: '今天说了好几句' },
    { kind: '自评', why: '被夸：他说「我真的觉得你很好」' },
  ])
  try {
    const 值 = 跑(盒)['1']
    assert.ok(!/框架重置|按原分反推/.test(值), '迁移账本进了印象：' + 值)
    assert.ok(值.includes('被夸'), '真正的自评被跳过：' + 值)
  } finally {
    rmSync(盒, { recursive: true, force: true })
  }
})
