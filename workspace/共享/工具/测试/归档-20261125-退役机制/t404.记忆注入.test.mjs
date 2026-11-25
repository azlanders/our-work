// t404 —— 记忆注入 + 梗知识并入黑话（批次394）
//
// 两件事，主人分别说的：
//   1「然后她真的有在维护自己的记忆模块啊 自诉啊 soul啊 梗知识啊什么的吗」
//     → 查出来：记忆卡存在 8 条 609 字，但注入只取 4 条再一刀切到 180 字，
//       实际给她 196 字，最近记的两条（inm / sdy）根本没进上下文。
//   2「然后梗知识合并到黑话」
//     → 16 个梗搬进 圈子黑话.json，梗知识.md 只剩一句说明。
//
// 这个文件锁四件事：
//   A 装填规则：存多少注多少、整条进不切半句、超长单条才截
//   B 真实效果：卡里的每一条都能在注入文本里找到完整原文（不是半句）
//   C 黑话库：词条够、有义有接、梗表没覆盖的那几条真的能命中
//   D 收口：梗知识.md 不再被读、面板改成编辑「黑话本」
//
// 跑法：node --test t404.记忆注入.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const LIB = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const TOOLS = '/data/hajimi-workspace/共享/工具'
const 黑话 = '/data/hajimi-workspace/记忆/圈子黑话.json'
const 梗文件 = '/data/hajimi-workspace/梗知识.md'

const 读 = (p) => readFileSync(p, 'utf8')

// ── A/B 记忆卡装填 ────────────────────────────────────────────────
const mem = await import(join(LIB, 'memory.js'))

test('A1 存多少就注多少（MAX_FACTS 必须等于 INJECT_FACTS）', () => {
  const 源 = 读(join(LIB, 'memory.js'))
  const 存 = Number(/const MAX_FACTS = (\d+)/.exec(源)[1])
  const 注 = Number(/const INJECT_FACTS = (\d+)/.exec(源)[1])
  assert.equal(存, 注, `存 ${存} 条却只注 ${注} 条 —— 剩下的永远用不上，这就是「记了记不住」的根`)
  assert.ok(注 >= 8, `只注 ${注} 条太少`)
  const 字 = Number(/const INJECT_CHARS = (\d+)/.exec(源)[1])
  assert.ok(字 >= 800, `注入字数上限只有 ${字}，10 条平均才 ${Math.round(字 / 注)} 字/条，又会被切`)
})

function 沙盒卡(条们) {
  const d = mkdtempSync(join(tmpdir(), 't404-'))
  const p = join(d, 'mem.json')
  writeFileSync(p, JSON.stringify({ 'private:1': { nick: '主人', facts: 条们.map((t, i) => ({ at: 1794500000000 + i, text: t })) } }), 'utf8')
  mem.useMemoryFile(p)
  return { d, p }
}

// QUIET_NOTE 2026-11-14（批次440）：B2 故意造「装不下」来验装填逻辑，
// 但 describeMemory 里的 note() 会往**真** load.log 写「关系卡装不下：10 条只进了 8 条」，
// 跟真报警无法区分。这个文件不测日志，整个静音。
process.env.QUIET_NOTE = '1'

test('B1 10 条中等长度的事实，一条不少地全进注入', () => {
  const 条们 = Array.from({ length: 10 }, (_, i) => `第${i + 1}条：${'记得这件事。'.repeat(5)}`)
  const { d } = 沙盒卡(条们)
  try {
    const out = mem.describeMemory('private:1', { ownerKey: 'private:1' })
    for (const t of 条们) assert.ok(out.includes(t), '这条没进注入：' + t.slice(0, 20))
  } finally { mem.useMemoryFile(''); rmSync(d, { recursive: true, force: true }) }
})

test('B2 整条装填：宁可少给一条，也不切半句', () => {
  // 10 条 × 120 字 = 1200 字 > INJECT_CHARS(1000)，必然装不下全部
  const 条们 = Array.from({ length: 10 }, (_, i) => `【${i + 1}】` + '啊'.repeat(116))
  const { d } = 沙盒卡(条们)
  try {
    const out = mem.describeMemory('private:1', { ownerKey: 'private:1' })
    // 注入里出现的每一条，都必须是完整的原条文（或整条被截断带 …）
    const 段们 = out.replace(/^（关于他：/, '').replace(/）$/, '').replace(/称呼：主人；/g, '').replace(/^记得：/, '').split('；')
    for (const s of 段们) {
      if (s.trim() === '') continue
      const 完整 = 条们.includes(s)
      const 截断 = s.endsWith('…')
      assert.ok(完整 || 截断, '出现了半句话（既不是完整条目也没标截断）：' + s.slice(0, 30) + '…' + s.length)
    }
    // 而且完整的那几条，条数应该少于 10（装不下）
    const 完整条 = 段们.filter((s) => 条们.includes(s))
    assert.ok(完整条.length < 10, '1000 字装得下 1200 字？装填逻辑没生效')
    assert.ok(完整条.length >= 7, `只装了 ${完整条.length} 条，太保守`)
  } finally { mem.useMemoryFile(''); rmSync(d, { recursive: true, force: true }) }
})

test('B3 新记的优先：容量不够时挤掉的是最老的', () => {
  const 条们 = Array.from({ length: 10 }, (_, i) => `【${i + 1}】` + '啊'.repeat(116))
  const { d } = 沙盒卡(条们)
  try {
    const out = mem.describeMemory('private:1', { ownerKey: 'private:1' })
    assert.ok(out.includes('【10】'), '最新那条没进')
    assert.ok(out.includes('【9】'), '次新那条没进')
    assert.ok(!out.includes('【1】'), '最老的那条反而进去了 —— 装填方向反了')
  } finally { mem.useMemoryFile(''); rmSync(d, { recursive: true, force: true }) }
})

test('B4 单条就超上限时，才截它自己（并带 …）', () => {
  const 超长 = '超'.repeat(1500)
  const { d } = 沙盒卡([超长])
  try {
    const out = mem.describeMemory('private:1', { ownerKey: 'private:1' })
    assert.ok(out.includes('…'), '超长单条没标截断')
    assert.ok(out.length < 1800, '超长单条没被截，注入会长到离谱：' + out.length)
  } finally { mem.useMemoryFile(''); rmSync(d, { recursive: true, force: true }) }
})

test('B5 真实卡去重后的代表条，现在一条不少', () => {
  const 真 = '/data/hajimi-dsh/qq-bridge-memory.json'
  if (!existsSync(真)) return   // 换机器就没有，跳过
  mem.useMemoryFile(真)
  try {
    const 卡 = mem.loadMemory('private:3439411062')
    const 事实 = (卡?.facts || []).map((x) => x.text)
    if (!事实.length) return
    const out = mem.describeMemory('private:3439411062', { ownerKey: 'private:3439411062' })
    // FACT_MERGE（批次637）：同义旧条会被最新说法替代，不再要求旧条也出现；
    // 但仍要求每个「没有被后文同义覆盖」的代表条完整进上下文。
    const 代表 = 事实.filter((t, i) => !事实.some((u, j) => j > i && mem.事实相近(t, u)))
    const 漏 = 代表.filter((t) => !out.includes(t))
    assert.deepEqual(漏, [], '这些条目还是没进上下文：' + 漏.map((s) => s.slice(0, 18)).join(' / '))
  } finally { mem.useMemoryFile('') }
})

// ── C 黑话库 ──────────────────────────────────────────────────────
const 表 = JSON.parse(读(黑话))

test('C1 黑话库够厚，每条都有词', () => {
  assert.ok(Array.isArray(表), '圈子黑话.json 不是数组')
  assert.ok(表.length >= 15, `只有 ${表.length} 条，梗知识那 16 个梗没搬进来？`)
  for (const x of 表) assert.ok(String(x?.词 || '').trim() !== '', '有条目没有「词」')
})

test('C2 从梗知识搬来的必须有「义」，最好有「接」', () => {
  const 搬 = 表.filter((x) => String(x?.源 || '') === '梗知识')
  assert.ok(搬.length >= 10, `只搬来 ${搬.length} 条`)
  const 无义 = 搬.filter((x) => !String(x?.义 || '').trim())
  assert.deepEqual(无义.map((x) => x.词), [], '这些搬过来却没有释义，槽还是只会说「你不知道」')
  const 无接 = 搬.filter((x) => !String(x?.接 || '').trim())
  assert.deepEqual(无接.map((x) => x.词), [], '这些没有「怎么接」—— 光知道是什么意思，接不住话')
})

test('C3 梗表没覆盖的 6 条，槽真的能命中并带上「怎么接」', async () => {
  const vs = await import(join(LIB, 'voiceSlots.js'))
  const 例 = [
    ['老鼠牌摩托车又来了', '老鼠'],
    ['今晚打绝地潜兵2吗', '绝地潜兵2'],
    ['他潜渊症又沉船了', '潜渊症'],
    ['僵毁里我又死了', '僵毁'],
    ['说好一辈子组乐队', '一辈子'],
    ['你是不是急了', '急了'],
  ]
  for (const [话, 词] of 例) {
    const out = vs.slotMemeCue({ lastText: 话, memDir: '/data/hajimi-workspace/记忆' })
    assert.ok(out.includes(词), `「${话}」没命中「${词}」`)
    assert.ok(out.includes('怎么接'), `「${词}」命中了但没给「怎么接」`)
  }
})

test('C4 日常话不许被误触发（主人/在干嘛 不是梗）', async () => {
  const vs = await import(join(LIB, 'voiceSlots.js'))
  for (const 话 of ['你在干嘛', '主人今天在不在', '我要去睡觉了', '今天好累']) {
    const out = vs.slotMemeCue({ lastText: 话, memDir: '/data/hajimi-workspace/记忆' })
    assert.equal(out, '', `「${话}」被当成梗触发了：` + out.slice(0, 40))
  }
})

// ── D 收口 ────────────────────────────────────────────────────────
test('D1 梗知识.md 只剩说明，不再是一份知识库', () => {
  const 文 = 读(梗文件)
  assert.ok(文.length < 600, `还有 ${文.length} 字 —— 内容没搬走？`)
  assert.ok(文.includes('圈子黑话.json'), '说明里没写搬到哪了')
})

test('D2 没有任何代码再读 梗知识.md（注释里提名字不算，要的是真的 readFileSync）', () => {
  // 不能断言「这串字不出现」—— 注释里要写明「已并到哪」才说得清。
  // 要查的是「有没有真的把它当数据源读」。
  for (const [名, 路] of [['自主行动.mjs', join(TOOLS, '自主行动.mjs')],
    ['voiceSlots.js', join(LIB, 'voiceSlots.js')],
    ['面板.mjs', join(TOOLS, '面板.mjs')]]) {
    const 源 = 读(路)
    assert.ok(!/readFileSync\([^)]*梗知识\.md/.test(源), `${名} 还在 readFileSync 梗知识.md`)
  }
})

test('D3 面板编辑入口从「梗知识」换成「黑话本」', () => {
  const 面板 = 读(join(TOOLS, '面板.mjs'))
  assert.ok(面板.includes('黑话本:'), '面板文档白名单里没有黑话本')
  assert.ok(!/梗知识: \{ 名: '梗知识'/.test(面板), '梗知识还在可编辑白名单里（改一个废弃文件）')
  const 页 = 读(join(TOOLS, '简洁页.html'))
  assert.ok(页.includes('data-doc="黑话本"'), '人格页没有「黑话本」按钮')
  assert.ok(!页.includes('data-doc="梗知识"'), '人格页还有「梗知识」按钮')
})

test('D5 群聊上限不许跟着私聊一起涨（隐私边界，t353 的 D1 锁的就是这个）', () => {
  const 源 = 读(join(LIB, 'memory.js'))
  const 私 = Number(/const INJECT_FACTS = (\d+)/.exec(源)[1])
  const 群 = Number(/const INJECT_FACTS_GROUP = (\d+)/.exec(源)[1])
  assert.ok(群 <= 4, `群聊上限被提到 ${群} 条 —— 他的私聊细节会在群里铺开`)
  assert.ok(群 < 私, '群聊上限应该比私聊紧')
  assert.ok(源.includes("key.startsWith('group:') ? INJECT_FACTS_GROUP : INJECT_FACTS"),
    '没有按 key 分流 —— 两个数值摆设，实际还是走同一个')
})

test('D4 SOUL.md 指向黑话本，不再指向梗知识.md', () => {
  const 灵魂 = 读('/data/hajimi-workspace/SOUL.md')
  assert.ok(灵魂.includes('圈子黑话.json'), 'SOUL 里没提黑话本')
  assert.ok(!灵魂.includes('梗知识.md'), 'SOUL 里还写着梗知识.md')
})
