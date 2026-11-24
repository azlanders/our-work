// t538 —— 三个「她生活里的小判据」（批次537）
//
//   · 水点.mjs    哪儿接得到水。判错就是她渴着却一直以为自己能接。
//   · 睡在哪.mjs  困了该不该先回家。判错就是「在便利店床上睡着了」那种账（批次107）。
//   · 快递.mjs    到点送货。判错就是东西没进家、包裹没了、账上还写「到了」。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// env 必须在 await import() 之前：水点.mjs 顶层就 `const MEM = process.env.QQ_AUTONOMY_MEM || …`
const 盒 = mkdtempSync(join(tmpdir(), 't538-'))
process.env.QQ_AUTONOMY_MEM = 盒

const { 能接水, 杯态 } = await import('{{BOT_ROOT}}/共享/工具/水点.mjs')
const { 睡在哪, 读资产再判 } = await import('{{BOT_ROOT}}/共享/工具/睡在哪.mjs')

const 写物品 = (o) => writeFileSync(join(盒, '物品.json'), JSON.stringify(o))

// ══════════ 水点 ══════════
test('W1 室内就有水：家 / 便利店 / 图书馆', () => {
  for (const d of ['家', '便利店', '图书馆']) assert.equal(能接水(d), true, d)
})

test('W2 显式「接水:false」压过「能逛能吃能买」—— 街市/公园/游乐园都是露天的', () => {
  // 这三个 `能` 数组里都有「坐」「逛」「吃」「买」，光看那是会判成能接水的
  for (const d of ['街市', '公园', '游乐园']) assert.equal(能接水(d), false, d)
})

test('W3 显式「接水:true」压过「室内:false」—— 打工点是露天工地，但备了水', () => {
  assert.equal(能接水('打工点'), true)
})

test('W4 不认识的地方接不到水（不猜）', () => {
  for (const d of ['', '火星', null, undefined]) assert.equal(能接水(d), false, JSON.stringify(d))
})

test('W5 没杯子时也返回形状，调用方不用判空', () => {
  写物品({ items: [] })
  assert.deepEqual(杯态(), { 有杯: false, 在包: false, 毫升: 0, 容量: 1000, 成分: [] })
})

test('W6 杯里有成分就按成分累加，在包里要能看出来', () => {
  写物品({ items: [{ n: '水杯', 在: '包', 容器: { 容量: 800, 成分: [{ 名: '水', 量: 300 }, { 名: '咖啡', 量: 200 }] } }] })
  const c = 杯态()
  assert.equal(c.有杯, true)
  assert.equal(c.在包, true)
  assert.equal(c.容量, 800)
  assert.equal(c.毫升, 500, '300 + 200')
  assert.equal(c.成分.length, 2)
})

test('W7 只有「装」没有成分时用 装；容量缺省 1000', () => {
  写物品({ items: [{ n: '水杯', 在: '手', 容器: { 装: 420 } }] })
  const c = 杯态()
  assert.equal(c.毫升, 420)
  assert.equal(c.容量, 1000)
  assert.equal(c.在包, false, '在手上不算在包里')
})

// ══════════ 睡在哪 ══════════
test('S1 在家就不用走', () => {
  const r = 睡在哪({ 位置: '家' })
  assert.equal(r.走, false); assert.equal(r.在路上, false); assert.equal(r.话, '')
})

test('S2 人在外面：先往家走，话里带得出地名', () => {
  const r = 睡在哪({ 位置: '便利店' })
  assert.equal(r.走, true)
  assert.match(r.话, /人在便利店/)
  assert.match(r.话, /先往家走/)
})

test('S3 已经在路上就别再喊一次 —— 半路开始睡才是真的怪', () => {
  const now = Date.now()
  const r = 睡在哪({ 位置: '便利店', 在途: { to: '家', arriveAt: now + 60000 } }, now)
  assert.equal(r.走, false)
  assert.equal(r.在路上, true)
  assert.equal(r.去哪, '家')
  assert.match(r.话, /到了再睡/)
})

test('S4 在路上但去的是别处，也先别睡', () => {
  const now = Date.now()
  const r = 睡在哪({ 位置: '家', 在途: { to: '街市', arriveAt: now + 60000 } }, now)
  assert.equal(r.走, false)
  assert.match(r.话, /正在去街市的路上/)
})

test('S5 在途时间已经过了就不算在路上（该由 走路 搬人，不该让睡觉卡住）', () => {
  const now = Date.now()
  const r = 睡在哪({ 位置: '便利店', 在途: { to: '家', arriveAt: now - 1000 } }, now)
  assert.equal(r.在路上, false)
  assert.equal(r.走, true, '过期在途 + 人还在外面 = 该走了')
})

test('S6 读不到资产就当在家 —— 别因为读文件失败不让她睡', () => {
  const r = 读资产再判(join(盒, '不存在的目录'))
  assert.equal(r.走, false); assert.equal(r.位, '家')
})

// ══════════ 快递 ══════════
function 造包裹盒(rc) {
  const b = mkdtempSync(join(tmpdir(), 't538k-'))
  mkdirSync(join(b, 'mem'), { recursive: true })
  mkdirSync(join(b, 'tools'), { recursive: true })
  writeFileSync(join(b, 'tools', '物品.mjs'), `process.exit(${rc})\n`)
  writeFileSync(join(b, 'mem', '包裹.json'), JSON.stringify({
    件: [{ 名: '洗发水', 类: '日用品', 价: 30, 到At: '2026-11-16 05:00' }],
  }))
  writeFileSync(join(b, 'mem', '资产.json'), JSON.stringify({ 钱: 600, 位置: '家', 记录: [] }))
  return b
}
const 跑快递 = (b) => execFileSync(process.execPath, ['{{BOT_ROOT}}/共享/工具/快递.mjs', '--tick'], {
  encoding: 'utf8', timeout: 20000,
  env: { ...process.env, QQ_AUTONOMY_MEM: join(b, 'mem'), QQ_AUTONOMY_TOOLS: join(b, 'tools') },
})
const 读沙 = (b, f) => JSON.parse(readFileSync(join(b, 'mem', f), 'utf8'))

test('K1 入库失败：包裹一件都不能少，账上一个字都不能记', () => {
  const b = 造包裹盒(1)
  const out = 跑快递(b)
  assert.equal(读沙(b, '包裹.json').件.length, 1, '入库没成，包裹被抹掉了 —— 这东西就永远补不回来')
  assert.deepEqual(读沙(b, '资产.json').记录, [], '没进家却记「快递到了」，是假账')
  assert.equal(/已放进家里/.test(out), false, '没进家却说放进家里了')
  assert.match(out, /一件都没入成/)
  rmSync(b, { recursive: true, force: true })
})

test('K2 入库成功：包裹清空、账上记一条、话也说到了', () => {
  const b = 造包裹盒(0)
  const out = 跑快递(b)
  assert.equal(读沙(b, '包裹.json').件.length, 0)
  const 记 = 读沙(b, '资产.json').记录
  assert.equal(记.length, 1)
  assert.match(记[0].what, /快递到了：洗发水/)
  assert.match(out, /已放进家里/)
  rmSync(b, { recursive: true, force: true })
})

test('K1b 部分成功：入成的那件走、没入成的那件留在包裹里', () => {
  // 这条才是 `写档(...件.filter(!成.includes))` 那行的把手。
  // K1 走的是「一件都没成 → 提前 exit」，它压根到不了写档 —— 只改那行不会让 K1 红，
  // 反向验证时就是这么发现的（我第一版只验了 K1，以为覆盖到了）。
  const b = mkdtempSync(join(tmpdir(), 't538p-'))
  mkdirSync(join(b, 'mem'), { recursive: true })
  mkdirSync(join(b, 'tools'), { recursive: true })
  // 名字里带「坏」就失败，其余成功
  writeFileSync(join(b, 'tools', '物品.mjs'),
    "process.exit(process.argv.some((a) => String(a).includes('坏')) ? 1 : 0)\n")
  writeFileSync(join(b, 'mem', '包裹.json'), JSON.stringify({
    件: [
      { 名: '好货', 类: '零食', 价: 10, 到At: '2026-11-16 05:00' },
      { 名: '坏货', 类: '零食', 价: 20, 到At: '2026-11-16 05:00' },
    ],
  }))
  writeFileSync(join(b, 'mem', '资产.json'), JSON.stringify({ 钱: 600, 位置: '家', 记录: [] }))
  const out = 跑快递(b)
  const 剩 = 读沙(b, '包裹.json').件
  assert.deepEqual(剩.map((x) => x.名), ['坏货'], '没入成的那件必须留在包裹里')
  const 记 = 读沙(b, '资产.json').记录
  assert.equal(记.length, 1)
  assert.match(记[0].what, /快递到了：好货/)
  assert.equal(/坏货/.test(记[0].what), false, '没进家的不许记账')
  assert.equal(/坏货/.test(out), false, '没进家的不许说「到了」')
  rmSync(b, { recursive: true, force: true })
})

test('K3 沙盒真的生效（真档包裹与资产一个字没动）', () => {
  // 这条是给上面两条兜底的：如果把 env 写错了地方，上面两条会「过」但改的是真档
  assert.equal(process.env.QQ_AUTONOMY_MEM, 盒, 'env 被别处改了')
  assert.ok(盒.includes('t538-'), '沙盒目录名不对：' + 盒)
})

test.after(() => { try { rmSync(盒, { recursive: true, force: true }) } catch {} })
