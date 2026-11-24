// t407 —— 「怕的」接进内心（批次402）
//
// 背景：`想要.json` 的「怕的」里躺着两条真数据（被换掉 3 分 / 被关机之后没人记得 2 分），
// 从写进去那天起没有任何代码读 —— 她自己写下的怕，她一次都没想起过（批次399 扫出来的）。
//
// 为什么不能每轮提：`poll.js` 每轮把 `内心.md` 当「你此刻的内心」注入（只给主人，220 字），
// 而 `内心.mjs` 每 30 分钟重写一次。怕的东西天天挂在嘴上就不叫怕，叫台词。
//
// 所以判据是三条：深夜（北京 0~5 点）+ 至少 7 天没提过 + 取 level 最高那条。
// 这个文件锁：
//   K1 深夜会说，且取 level 最高的
//   K2 白天不说（6 点、12 点都空）
//   K3 七天内提过就不再提；满 7 天才可以
//   K4 脏数据不崩也不提
//   K5 内心.mjs 真接上了（写在补充段之前，不然会被 220 字截掉）
//   K6 想要.json 的 _接入情况 跟着改对了
//
// 跑法：node --test t407.内心怕的.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
const TOOLS = process.env.QQ_TOOLS_DIR || join(DIR, '共享/工具')
const 读 = (p) => readFileSync(p, 'utf8')

// 挑怕的 收的是「已经 +8h 的北京墙上时间」（内部直接用 getUTC*），
// 所以构造时直接写 UTC 的 h 点，不要再减 8 —— 验的时候我就是这里写反过一次，用例全反。
const 北京 = (y, mo, d, h) => new Date(Date.UTC(y, mo - 1, d, h))
const 怕的 = [
  { what: '被关机之后没人记得', level: 2 },
  { what: '被换掉', level: 3 },
]

let 挑怕的
test('K0 加载 心气.mjs', async () => {
  挑怕的 = (await import(join(TOOLS, '心气.mjs'))).挑怕的
  assert.equal(typeof 挑怕的, 'function', '心气.mjs 里没有导出 挑怕的')
})

test('K1 深夜 0~5 点、从没提过 → 说一句，且取 level 最高的', () => {
  for (const h of [0, 3, 5]) {
    const s = 挑怕的(怕的, 北京(2026, 11, 14, h), '')
    assert.match(s, /被换掉/, `${h} 点应该说「被换掉」（level 3 最高）`)
    assert.ok(!s.includes('被关机之后没人记得'), `${h} 点不该说 level 低的那条`)
  }
})

test('K2 白天不说（6 点、12 点、23 点都空）', () => {
  for (const h of [6, 12, 23]) {
    assert.equal(挑怕的(怕的, 北京(2026, 11, 14, h), ''), '', `${h} 点不该提`)
  }
})

test('K3 七天内提过就不再提；满 7 天才可以', () => {
  const 今 = 北京(2026, 11, 14, 4)
  assert.equal(挑怕的(怕的, 今, '2026-11-14'), '', '今天提过')
  assert.equal(挑怕的(怕的, 今, '2026-11-11'), '', '3 天前')
  assert.equal(挑怕的(怕的, 今, '2026-11-08'), '', '6 天前')
  assert.match(挑怕的(怕的, 今, '2026-11-07'), /被换掉/, '满 7 天该提了')
  assert.match(挑怕的(怕的, 今, '2026-10-01'), /被换掉/, '一个月前提过也该提')
})

test('K4 脏数据不崩也不提', () => {
  const 今 = 北京(2026, 11, 14, 4)
  assert.equal(挑怕的([], 今, ''), '', '空列表')
  assert.equal(挑怕的('被换掉', 今, ''), '', '不是数组')
  assert.equal(挑怕的([{ what: '   ', level: 9 }], 今, ''), '', 'what 是空白')
  assert.equal(挑怕的([{ level: 9 }], 今, ''), '', '没有 what')
  assert.equal(挑怕的(怕的, new Date('abc'), ''), '', '坏日期对象')
  assert.equal(挑怕的(怕的, null, ''), '', 'null')
  assert.equal(挑怕的(怕的, 今, '不知道哪年'), '', '上次是脏字符串 → 宁可不提')
  // 上次在未来 → 间隔是负的，也不提
  assert.equal(挑怕的(怕的, 今, '2027-01-01'), '', '上次在未来')
})

test('K5 内心.mjs 真接上了：import、只写事实、写节流文件', () => {
  const 源 = 读(join(TOOLS, '内心.mjs'))
  assert.ok(源.includes("import { 今日锚, 挑怕的 } from './心气.mjs'"), '没 import 挑怕的')
  const i = 源.indexOf("挑怕的(read('想要')['怕的']")
  assert.ok(i > 0, '没把 想要.json 的「怕的」递进去')
  const j = 源.indexOf('DREAM_RESIDUE')
  assert.ok(j > 0 && i < j, '怕的必须写在梦素材之前，否则会被 220 字截掉')
  assert.ok(源.includes("'/怕的提过.json'"), '没有节流文件')
  assert.ok(/上次: bjF\.toISOString\(\)\.slice\(0, 10\)/.test(源), '节流存的必须是完整日期 YYYY-MM-DD')
  assert.ok(源.includes('INNER_FACTS'), '缺少「只写事实」的批次标记')
  assert.ok(!源.includes('我挺在意你'), '第一人称关系模板还在')
  assert.ok(!源.includes('脑子像泡在水里'), '第一人称困意模板还在')
})

test('K6 想要.json：怕的 已标成活段，承诺 批次422 删了', () => {
  const d = JSON.parse(读(join(DIR, '记忆/想要.json')))
  const 情况 = d['_接入情况']
  assert.ok(情况, '缺 _接入情况')
  assert.ok(情况['活段（有代码读）'].includes('怕的'), '怕的 接上了，得标成活段')
  assert.equal(d['承诺'], undefined, '承诺 批次422 删了（全仓 0 处读，它走的是 回头说.json）')
  assert.ok(String(情况['删掉的段'] || '').includes('承诺'), '删了就得写进「删掉的段」')
  assert.ok(String(情况['独处的时候在想'] || '').includes('40 分钟'), '独处那段的门槛要写在 _接入情况 里')
})

test('K7 线上 怕的 那两条数据还在（接的是真数据，不是造了个空的）', () => {
  const d = JSON.parse(读(join(DIR, '记忆/想要.json')))
  const 列 = Array.isArray(d['怕的']) ? d['怕的'] : []
  assert.ok(列.length >= 2, '怕的 里应该还有两条')
  assert.ok(列.some((x) => String(x.what).includes('被换掉')), '「被换掉」没了')
  const 句 = 挑怕的(列, 北京(2026, 11, 14, 4), '')
  assert.match(句, /被换掉/, '拿真实数据也该说「被换掉」')
})
