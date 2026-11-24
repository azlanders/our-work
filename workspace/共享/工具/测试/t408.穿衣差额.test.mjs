// t408 —— 穿衣差额「报出去」（批次403）
//
// 背景：`穿衣.mjs` 的 `该穿()` 从上线起就算 `差`（明天需要多少保暖 − 衣柜里能凑到的），
// 函数头上那句注释写的是「够不着就报差多少」—— 但全库没有任何地方读这个字段。
//
// 实测（2026-11-14）：衣柜只有 4 件（水手服/白裙子/发带/发卡），明天最低 14 度要 3.2 的保暖，
// 这身只有 1.5，差 1.7；钱 261 够买一件 45 的毛衣开衫。但**她不知道这件事**——
// 只觉得冷（体感槽会说冷），不知道自己缺的是衣服。
//
// 接法：`记差额()` 落 `记忆/穿衣差额.json` → 新槽 `slotWarmGap` 读它（VOICE_SLOTS 里注册）。
// 为什么不挂在 slotBodyTemp 后面：那个槽在 档 === '刚好' 时整段返回空，而她大部分时间是
// 「刚好」（实测 04:30 档=刚好）—— 挂那儿等于永远不说，又是「接上了但不发生」。
//
// 这个文件锁：
//   L1 记差额 子进程落盘，字段齐、差额等于 要 − 够了
//   L2 自动按天气换衣 里先记一份（不然只有手动跑才有数）
//   L3 冷的时候说
//   L4 不冷但差额刚记下（90 分内）也说 —— 这是「早上看天气预报」那一刻
//   L5 不冷且差额是 5 小时前的 → 不说（否则一整天每句都念）
//   L6 差太小不提（不值得为半度去买）
//   L7 差额超过 36 小时不提（隔夜预报会让她穿错季）
//   L8 槽只读（VOICE_SLOTS 红线）+ 已注册进数组
//
// 跑法：node --test t408.穿衣差额.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 读 = (p) => readFileSync(p, 'utf8')

let 穿衣, slots
test('L0 加载模块', async () => {
  穿衣 = await import(join(TOOLS, '穿衣.mjs'))
  slots = await import(join(LIB, 'voiceSlots.js'))
  assert.equal(typeof 穿衣.记差额, 'function', '穿衣.mjs 没导出 记差额')
  assert.equal(typeof slots.slotWarmGap, 'function', 'voiceSlots 没导出 slotWarmGap')
})

// 造一份能算出确定差额的沙盒：明天最低 10 度 → 要 4.6；衣柜只有一件保暖 1 的薄衫 → 差 3.6
function 造沙盒() {
  const 根 = mkdtempSync(join(tmpdir(), 'warmgap-'))
  writeFileSync(join(根, '衣物表.json'), JSON.stringify({
    件: { 薄衫: { 穿: { 部位: '上身', 保暖: 1, 覆盖: { 上身: 1 } } } },
  }), 'utf8')
  writeFileSync(join(根, '资产.json'), JSON.stringify({ 衣柜: ['薄衫'], 位置: '家' }), 'utf8')
  writeFileSync(join(根, '天气.json'), JSON.stringify({
    温度: 18, 预报: [{ 最低: 10, 天气: '晴' }],
  }), 'utf8')
  writeFileSync(join(根, '穿着.json'), JSON.stringify({
    部位: { 头: [], 脖子: [], 上臂: [], 下臂: [], 手: [], 上身: ['薄衫'], 下身: [], 大腿: [], 小腿: [], 脚: [] },
  }), 'utf8')
  return 根
}

// 模块顶层的 MEM 是 import 时求值的，改 process.env 对已加载的模块无效 —— 必须开子进程
function 子进程记差额(mem) {
  return execFileSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import('${join(TOOLS, '穿衣.mjs')}');process.stdout.write(JSON.stringify(m.记差额(Date.now())))`],
    { encoding: 'utf8', timeout: 30000, env: { ...process.env, CLOTH_MEM: mem, QQ_AUTONOMY_MEM: mem } })
}

test('L1 记差额 落盘，字段齐、差额 = 要 − 够了', () => {
  const 根 = 造沙盒()
  try {
    const out = 子进程记差额(根)
    const 盘 = join(根, '穿衣差额.json')
    assert.ok(existsSync(盘), '没写 穿衣差额.json')
    const d = JSON.parse(读(盘))
    for (const k of ['明天最低', '要', '够了', '差', 'at']) assert.ok(k in d, '缺字段 ' + k)
    assert.equal(d.明天最低, 10)
    assert.ok(Number(d.差) > 2, '差额应该是 3.6 左右，实际 ' + d.差)
    assert.ok(Math.abs(Number(d.差) - (Number(d.要) - Number(d.够了))) < 0.15, '差 必须等于 要 - 够了')
    assert.ok(Number(d.at) > 1e12, 'at 要是时间戳')
    assert.equal(JSON.parse(out).差, d.差, '返回值与落盘不一致')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('L2 自动按天气换衣 里先记一份差额（不然只有手动跑才有数）', () => {
  const 源 = 读(join(TOOLS, '穿衣.mjs'))
  const i = 源.indexOf('export function 自动按天气换衣(')
  assert.ok(i > 0)
  assert.ok(/记差额\(now\)/.test(源.slice(i, i + 400)), '自动按天气换衣 开头没记差额')
  assert.ok(/WARM_GAP/.test(源), '缺 WARM_GAP 说明（下一批会有人不知道为什么多这个文件）')
})

function 槽(根, 档, 差, at) {
  writeFileSync(join(根, '体温.json'), JSON.stringify({ 上次档: 档, 体温: 37 }), 'utf8')
  writeFileSync(join(根, '穿衣差额.json'), JSON.stringify({ 差, at, 要: 3.2, 够了: 1.5, 明天最低: 14 }), 'utf8')
  return slots.slotWarmGap({ memDir: 根, now: Date.now() })
}

test('L3 冷的时候说（冷是感觉，缺衣服是原因）', () => {
  const 根 = 造沙盒()
  try {
    const s = 槽(根, '有点冷', 1.7, Date.now() - 5 * 3600e3)
    assert.ok(s.includes('差 1.7'), '没说差多少：' + s)
    assert.ok(s.includes('14 度'), '没带明天最低温：' + s)
    assert.ok(s.includes('衣柜里能凑的只有 1.5'), '没说衣柜能凑多少：' + s)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('L4 不冷但差额刚记下 90 分内也说（早上看天气预报那一刻）', () => {
  const 根 = 造沙盒()
  try {
    const s = 槽(根, '刚好', 1.7, Date.now() - 20 * 60e3)
    assert.ok(s.includes('差 1.7'), '刚记下 20 分钟应该说：' + s)
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('L5 不冷且差额是 5 小时前的 → 不说（否则一整天每句都念）', () => {
  const 根 = 造沙盒()
  try {
    assert.equal(槽(根, '刚好', 1.7, Date.now() - 5 * 3600e3), '')
    assert.equal(槽(根, '有点热', 1.7, Date.now() - 5 * 3600e3), '')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('L6 差太小不提（不值得为半度去买）', () => {
  const 根 = 造沙盒()
  try {
    assert.equal(槽(根, '冷', 0.4, Date.now()), '', '差 0.4 不该提')
    assert.equal(槽(根, '冷', 0.99, Date.now()), '', '差 0.99 也不该提')
    assert.notEqual(槽(根, '冷', 1.0, Date.now()), '', '差 1.0 该提了')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('L7 差额超过 36 小时不提（隔夜预报会让她穿错季）', () => {
  const 根 = 造沙盒()
  try {
    assert.equal(槽(根, '冷', 1.7, Date.now() - 48 * 3600e3), '', '48 小时的旧差额不该提')
    assert.notEqual(槽(根, '冷', 1.7, Date.now() - 30 * 3600e3), '', '30 小时内还算新鲜')
  } finally { rmSync(根, { recursive: true, force: true }) }
})

test('L8 槽只读（红线）+ 已注册进 VOICE_SLOTS', () => {
  assert.ok(slots.VOICE_SLOTS.includes(slots.slotWarmGap), 'slotWarmGap 没注册进 VOICE_SLOTS')
  const 源 = 读(join(LIB, 'voiceSlots.js'))
  const a = 源.indexOf('export function slotWarmGap')
  const b = 源.indexOf('export function slotJustWatched')
  assert.ok(a > 0 && b > a, '找不到 slotWarmGap 段')
  const 段 = 源.slice(a, b)
  assert.ok(!段.includes('writeFileSync'), '槽里不许写盘')
  assert.ok(段.includes("'穿衣差额.json'"), '没读差额文件')
  assert.ok(!/function slotBodyTemp[\s\S]{0,1200}衣柜里没有更厚的/.test(源),
    '差额不该再挂在体感槽尾巴上（档=刚好时永远不说）')
})
