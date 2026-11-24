// t402 —— 刷手机（批次392）
//
// 为什么测这些：主人 11-13 问她「怎么不看 b 站」，她答「没坏呀，就是这两天轮到的全是
// 打瞌睡、喝水、洗澡，困得没劲儿看片」—— 根因是「看B站」一天只有一票、权重还低。
// 这一批把「刷」（只划标题，0 成本）和「看」（学习轮）拆开，并把上限参数化。
//
// 这个文件锁三件事：
//   A 判据：睡着 / 洗澡 / 吃饭 / 没劲儿 / 刷太多次 / 没到点，六种情况都必须真的不刷
//   B 接口契约：学习轮先看她刷到过的那条，再退回热门候选（顺序被改回去就不能放）
//   C 参数与面板：新加的 8 个键在 参数.json 里，也在面板可调项白名单里
//
// 跑法：node --test t402.刷手机.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 脚本 = join(TOOLS, '刷一刷.mjs')
const 京今天 = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

function 造沙盒(文件们) {
  const d = mkdtempSync(join(tmpdir(), 't399-'))
  for (const [名, 内容] of Object.entries(文件们)) {
    writeFileSync(join(d, 名), typeof 内容 === 'string' ? 内容 : JSON.stringify(内容, null, 2), 'utf8')
  }
  return d
}

/** 跑一次，返回 stdout（stdout+stderr 合并，报错看得见）。 */
function 跑(目录, argv) {
  try {
    return execFileSync(process.execPath, [脚本, ...argv], {
      encoding: 'utf8',
      timeout: 45e3,
      env: { ...process.env, QQ_AUTONOMY_MEM: 目录, QQ_BROWSE_MEM: 目录 },
    })
  } catch (e) {
    return String((e.stdout || '') + (e.stderr || '') + (e.message || ''))
  }
}

// ── A 判据 ────────────────────────────────────────────────────────
test('A1 睡着不刷', () => {
  const d = 造沙盒({ '睡醒.json': { sleeping: true, since: '2026-11-13 23:40' } })
  try {
    const out = 跑(d, ['--bili'])
    assert.match(out, /睡着/)
    assert.equal(existsSync(join(d, '刷手机.json')), false, '睡着了还写了刷手机.json')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A2 在洗澡不刷', () => {
  const d = 造沙盒({
    '睡醒.json': { sleeping: false },
    '卫生.json': { 洗澡中: { 结束: '2099-01-01 00:00' } },
  })
  try {
    const out = 跑(d, ['--bili'])
    assert.match(out, /在洗澡/)
    assert.equal(existsSync(join(d, '刷手机.json')), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A3 在吃饭不刷', () => {
  const d = 造沙盒({
    '睡醒.json': { sleeping: false },
    '吃饭.json': { 到毫秒: Date.now() + 10 * 60e3, 吃啥: '泡面' },
  })
  try {
    const out = 跑(d, ['--bili'])
    assert.match(out, /在吃饭/)
    assert.equal(existsSync(join(d, '刷手机.json')), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A4 精力见底不刷（她自己说过「困得没劲儿看片」）', () => {
  const d = 造沙盒({
    '睡醒.json': { sleeping: false },
    '状态.json': { energy: 5 },
  })
  try {
    const out = 跑(d, ['--bili'])
    assert.match(out, /没劲儿/)
    assert.equal(existsSync(join(d, '刷手机.json')), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A8 打瞌睡的时候不刷（打盹不算睡，睡态.睡着 是 false，要单独拦一道）', () => {
  const d = 造沙盒({
    '睡醒.json': { sleeping: false },
    '打盹.json': { 到毫秒: Date.now() + 30 * 60e3 },
  })
  try {
    const out = 跑(d, ['--bili'])
    assert.match(out, /在打瞌睡/)
    assert.equal(existsSync(join(d, '刷手机.json')), false)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A5 今天刷满 30 次就不再刷', () => {
  const d = 造沙盒({
    '睡醒.json': { sleeping: false },
    '状态.json': { energy: 80 },
    '刷手机.json': { 今天: 京今天(), 次数: 30, 今日条数: 240, nextAt: 0 },
  })
  try {
    const out = 跑(d, ['--tick'])
    assert.match(out, /今天已经刷了30次/)
    const 档 = JSON.parse(readFileSync(join(d, '刷手机.json'), 'utf8'))
    assert.equal(档.次数, 30, '被拦了还加次数')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A6 没到点静默退出（不写日志、不动文件）', () => {
  const d = 造沙盒({
    '睡醒.json': { sleeping: false },
    '状态.json': { energy: 80 },
    '刷手机.json': { 今天: 京今天(), 次数: 1, 今日条数: 8, nextAt: 9876543210000 },
  })
  const 前 = readFileSync(join(d, '刷手机.json'), 'utf8')
  try {
    const out = 跑(d, ['--tick', '--verbose'])
    assert.match(out, /还没到点/)
    assert.equal(readFileSync(join(d, '刷手机.json'), 'utf8'), 前, '没到点却改了文件')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A7 换天了次数要归零（不是永久卡在昨天的 30 次）', () => {
  // 纯源码断言：真跑的话它就会去联网，而这条要锁的只是「按日期分桶」这一件事。
  const 源码 = readFileSync(脚本, 'utf8')
  assert.ok(/刷\.今天 === 今 \? \(Number\(刷\.次数\) \|\| 0\) : 0/.test(源码),
    '次数没按「今天」分桶 —— 过了零点她会一直卡在昨天的上限上，再也不刷')
})

// ── B 接口契约（读源码，防「顺序被改回去」）──────────────────────
const 自主源码 = readFileSync(join(TOOLS, '自主行动.mjs'), 'utf8')

test('B1 学习轮先看她刷到过的那条，再退回热门候选', () => {
  const i刷到 = 自主源码.indexOf('const 刷到 = browsedBiliPick()')
  const i热门 = 自主源码.indexOf("[cli, 'candidates', '3']")
  assert.ok(i刷到 > 0, 'browsedBiliPick 的调用点没了')
  assert.ok(i热门 > 0, '热门候选那行没了')
  assert.ok(i刷到 < i热门, '刷过池必须在热门候选之前试 —— 否则「刷完点进去看」这条腿断了')
})

test('B2 看B站/逛贴吧 的上限不再写死 < 1', () => {
  assert.ok(自主源码.includes("countToday('看B站') < Number(H('自主_看B站每天上限', 3))"),
    '看B站 上限没参数化（一天只有一票就是 11-13 那种「两天没看」的根因）')
  assert.ok(自主源码.includes("countToday('逛贴吧') < Number(H('自主_逛贴吧每天上限', 2))"),
    '逛贴吧 上限没参数化')
})

test('B3 标记「看过」的写入必须原子（临时文件 + rename）', () => {
  const i = 自主源码.indexOf('function 标看过了')
  assert.ok(i > 0, '标看过了 没了')
  const 段 = 自主源码.slice(i, i + 900)
  assert.ok(段.includes('renameSync'), '刷过.jsonl 是边读边写的大文件，必须 tmp + rename')
})

// ── C 参数与面板 ──────────────────────────────────────────────────
const 参数 = JSON.parse(readFileSync(join(TOOLS, '参数.json'), 'utf8'))
const 拟人 = 参数['拟人'] || {}

test('C1 八个刷手机阈值都在 参数.json', () => {
  for (const k of ['刷_间隔分钟', '刷_浮动分钟', '刷_每天上限', '刷_每次条',
    '刷_B站占比', '刷_精力下限', '自主_看B站每天上限', '自主_逛贴吧每天上限']) {
    assert.equal(typeof 拟人[k], 'number', `${k} 不在 参数.json 的拟人段`)
  }
})

test('C2 面板可调项里能改这几个值（主人要求「能改的都要能在面板上改」）', () => {
  const 面板 = readFileSync(join(TOOLS, '面板.mjs'), 'utf8')
  for (const k of ['刷_间隔分钟', '刷_浮动分钟', '刷_每天上限', '刷_每次条',
    '刷_B站占比', '刷_精力下限', '自主_看B站每天上限', '自主_逛贴吧每天上限']) {
    assert.ok(面板.includes(k), `面板可调项里没有 ${k}`)
  }
  assert.ok(面板.includes("g('browse', '刷手机'"), '调试页少了「刷手机」这一屏')
})

test('C3 心跳表里有 刷一刷，且睡着不跑', () => {
  const 表 = JSON.parse(readFileSync(join(TOOLS, '心跳表.json'), 'utf8'))
  const 条 = (表.任务 || []).find((x) => x.脚本 === '刷一刷.mjs')
  assert.ok(条, '心跳表里没有 刷一刷')
  assert.equal(条.睡着跑, false, '她睡着的时候不该刷手机')
  assert.ok(Number(条.间隔分) >= 1 && Number(条.间隔分) <= 60, '间隔分 只能 1~60')
})

test('C4 判据单源：睡着只问 睡态.mjs，不自己读 睡醒.json', () => {
  const 源码 = readFileSync(脚本, 'utf8')
  assert.ok(/import \{[^}]*睡着[^}]*\} from '\.\/睡态\.mjs'/.test(源码), '睡着 判据必须从 睡态.mjs 来')
  assert.ok(!/读档\([^)]*睡醒\.json/.test(源码), '不许自己读 睡醒.json —— 判据只有一份')
  assert.ok(源码.includes("import { 在吃饭, 在洗澡 } from './占用.mjs'"), '占用态只能问 占用.mjs')
})
