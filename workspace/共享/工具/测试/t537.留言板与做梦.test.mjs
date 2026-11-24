// t537 —— 留言板（主人给她留话的那块板）与做梦整合（梦进链 = 进回忆池）（批次536）
//
// 留言板的规矩是主人定的：全部人看同一块板、不能重叠、**只能贴到今天**、
// 撕只能撕自己的。这些全是「错了会让她/他看见怪东西」的判据，一条都没测过。
//
// 做梦整合是把「今天心里剩下什么」写进 链.md，而 链.md 是 翻旧账 的池子之一。
// 它顶层就执行（import 一次就写一次盘），所以只能子进程 + `--print` 测。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = process.env.QQ_TOOLS_DIR || '{{BOT_ROOT}}/共享/工具'

// ISOLATE_FIRST 2026-11-16（批次536）：**env 必须在 await import() 之前设**。
// 留言板.mjs 顶层就 `const 根 = process.env.BOARD_DIR || 真档路径`。
// 第一版我把这两行写在 import 之后 —— 结果 B1-B10 八张便签全贴到了她**真实的**留言板上
// （2026-11-16.json，8 条，已删；证据留 /root/bak2/留言板-2026-11-16-测试污染-20261116.json）。
// 教训跟 MEMORY 里那条一字不差：import 顶层求值 env 的模块，先设 env 再 import。
const 盒 = mkdtempSync(join(tmpdir(), 't537-'))
const 板 = join(盒, '板')
const 已 = join(盒, '已读.json')
process.env.BOARD_DIR = 板
process.env.BOARD_READ = 已

const { 贴, 评论, 移动, 撕, 读, 找位, 日表, 未读, 今天, 颜色 } = await import('{{BOT_ROOT}}/共享/工具/留言板.mjs')

const 今 = 今天()

test('B1 贴一张：能读回来，字段齐', () => {
  const r = 贴({ date: 今, by: '客人', color: 'blue', text: '今天也辛苦啦' })
  assert.equal(r.ok, true, r.msg)
  assert.equal(r.note.by, '客人')
  assert.equal(r.note.color, 'blue')
  assert.equal(r.note.text, '今天也辛苦啦')
  assert.match(r.note.id, /^n-/)
  assert.equal(读(今).notes.length, 1)
})

test('B2 空便签不许贴', () => {
  assert.equal(贴({ date: 今, text: '   ' }).ok, false)
  assert.equal(贴({ date: 今, text: '' }).ok, false)
})

test('B3 可以补贴过去的板子，但不能贴未来', () => {
  const 昨 = new Date(Date.now() + 8 * 3600e3 - 24 * 3600e3).toISOString().slice(0, 10)
  const r = 贴({ date: 昨, text: '昨天忘了说' })
  assert.equal(r.ok, true, r.msg)
  assert.equal(读(昨).notes.length, 1)

  const 明 = new Date(Date.now() + 8 * 3600e3 + 24 * 3600e3).toISOString().slice(0, 10)
  const 未 = 贴({ date: 明, text: '明天的话' })
  assert.equal(未.ok, false)
  assert.match(未.msg, /未来|还没到/)
})

test('B4 同一块地方不许重叠：第二张会被挪开', () => {
  const a = 贴({ date: 今, by: '客人', text: 'A', x: 10, y: 10 })
  const b = 贴({ date: 今, by: '客人', text: 'B', x: 10, y: 10 })
  assert.equal(a.ok, true); assert.equal(b.ok, true, b.msg)
  const 交叠 = (p, q) => {
    const iw = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x)
    const ih = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y)
    return iw > 0 && ih > 0
  }
  assert.equal(交叠(a.note, b.note), false, '两张便签压在一起了')
})

test('B5 颜色不认识的回落成 yellow，不是写个野值让前端渲染不出来', () => {
  const r = 贴({ date: 今, by: '客人', color: 'rainbow', text: '野颜色', x: 60, y: 60 })
  assert.equal(r.ok, true, r.msg)
  assert.equal(r.note.color, 'yellow')
  assert.deepEqual(颜色, ['yellow', 'pink', 'blue', 'green', 'orange', 'purple'])
})

test('B6 评论：能挂上去；空话不收；便签不在了要拒', () => {
  const n = 贴({ date: 今, by: '客人', text: '给我留个言', x: 60, y: 10 }).note
  const c = 评论({ date: 今, id: n.id, by: '{{BOT_DISPLAY}}', text: '看到了' })
  assert.equal(c.ok, true, c.msg)
  assert.equal(评论({ date: 今, id: n.id, text: ' ' }).ok, false)
  assert.equal(评论({ date: 今, id: 'n-不存在', text: 'x' }).ok, false)
  assert.equal(读(今).notes.find((z) => z.id === n.id).comments.length, 1)
})

test('B7 移动：撞上别人的就拒绝，不自动替她挪别人', () => {
  const n1 = 贴({ date: 今, by: '客人', text: '固定', x: 2, y: 80, w: 20, h: 12 }).note
  const n2 = 贴({ date: 今, by: '客人', text: '可动', x: 40, y: 80, w: 20, h: 12 }).note
  const r = 移动({ date: 今, id: n2.id, x: 2, y: 80 })
  assert.equal(r.ok, false, '压到别人身上必须拒')
  const ok = 移动({ date: 今, id: n2.id, x: 60, y: 80 })
  assert.equal(ok.ok, true, ok.msg)
  assert.equal(读(今).notes.find((z) => z.id === n1.id).x, 2, '别人的便签一个像素都不许动')
})

test('B8 撕：只限自己的，撕不到别人的', () => {
  const 他的 = 贴({ date: 今, by: '客人', text: '他的', x: 2, y: 60 }).note
  const 她的 = 贴({ date: 今, by: '{{BOT_DISPLAY}}', text: '她的', x: 30, y: 60 }).note
  assert.equal(撕({ date: 今, id: 他的.id, 只限: '{{BOT_DISPLAY}}' }).ok, false, '撕到别人的了')
  assert.equal(撕({ date: 今, id: 她的.id, 只限: '{{BOT_DISPLAY}}' }).ok, true)
})

test('B9 未读：只算别人的，不算她自己贴的', () => {
  记时(已, '2020-01-01 00:00')
  const out = 未读(20)
  assert.ok(out.length > 0, '应该能数出没看的')
  assert.equal(out.every((x) => x.by !== '{{BOT_DISPLAY}}'), true, '她自己的不该提醒她')
  assert.equal(out.every((x) => ['note', 'comment'].includes(x.type)), true)
})

test('B10 日表：不许出现未来日期', () => {
  const 今t = Date.now() + 8 * 3600e3
  const 明 = new Date(今t + 24 * 3600e3).toISOString().slice(0, 10)
  // 手写一份「明天」的板子（模块自己不许贴，但文件可能存在）
  mkdirSync(板, { recursive: true })
  writeFileSync(join(板, 明 + '.json'), JSON.stringify({ date: 明, notes: [{ id: 'x', by: 'a', text: 't', x: 1, y: 1, w: 10, h: 10 }] }))
  const 表 = 日表()
  assert.equal(表.some((d) => d.date > 今), false, '板子本来就不许往后贴，日期选择器也不该给')
})

function 记时(p, at) { writeFileSync(p, JSON.stringify({ at })) }

// ══════════ 做梦整合 ══════════
const 梦盒 = mkdtempSync(join(tmpdir(), 't537d-'))
const 跑梦 = (额外 = ['--print']) => execFileSync(process.execPath, [join(工具, '做梦整合.mjs'), ...额外], {
  encoding: 'utf8', timeout: 20000,
  env: { ...process.env, DREAM_INTEGRATE_MEM: 梦盒, DREAM_INTEGRATE_DAY: '2026-11-16' },
})

test('D1 有余味就用余味，写出的块有「事实 / 未决」两行', () => {
  writeFileSync(join(梦盒, '梦-2026-11-16.md'), '# 2026-11-16 梦\n余味: 走廊尽头的灯一直亮着\n\n一些正文\n')
  writeFileSync(join(梦盒, '内心.md'), '')
  const out = 跑梦()
  assert.match(out, /^## 2026-11-16 \d{2}:\d{2}$/m)
  assert.match(out, /- 事实：/, '没写事实行')
  assert.match(out, /- 未决：/, '没写未决行')
  assert.match(out, /走廊尽头的灯一直亮着/, '余味没被用上')
})

test('D2 别扭里还堵着的事，优先于余味', () => {
  writeFileSync(join(梦盒, '别扭.json'), JSON.stringify({ people: { '1': { level: 2, why: '他今天没回我' } } }))
  const out = 跑梦()
  assert.match(out, /还堵着：他今天没回我/, '别扭优先于余味，这是一天里最占心的事')
  assert.match(out, /他今天没回我/, '事实行也该提它')
})

test('D3 今天已经落过就不再落（白天跑过一次也算）', () => {
  writeFileSync(join(梦盒, '链.md'), '## 2026-11-16 09:00\n- 事实：白天那次\n- 未决：（没有）\n')
  const out = 跑梦()
  assert.match(out, /今天已落/)
  assert.equal(/## 2026-11-16/.test(out.replace(/^## 2026-11-16 09:00[\s\S]*/, '')), false)
})

test('D4 只写事实，不再生成第一人称判断句', () => {
  writeFileSync(join(梦盒, '链.md'), '')
  for (let i = 0; i < 12; i += 1) {
    const out = 跑梦()
    const m = out.match(/- 事实：(.+)$/m)
    assert.ok(m, '没事实行')
    assert.ok(!/突然想起一件事|今天绕回来好几遍|没跟自己算清/.test(m[1]), '第一人称判断模板还在：' + m[1])
  }
})

test('B11 最后兜底：沙盒真的生效了（不然上面全写到她真实的板子上）', () => {
  assert.equal(existsSync(join(板, 今 + '.json')), true,
    'BOARD_DIR 没生效 —— 上面那些便签写进的是 {{BOT_ROOT}}/共享/留言板/')
})

test.after(() => { try { rmSync(盒, { recursive: true, force: true }) } catch {} ; try { rmSync(梦盒, { recursive: true, force: true }) } catch {} })
