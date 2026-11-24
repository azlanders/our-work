// t637 —— 关系卡同义合并（批次637）
//
// 线上两组真实重复：
//   ① 「别解释表情包」vs「别描述表情包 / 别配解说」
//   ② 「自己找话题主动开口」vs「他没主动时自己去找他聊」
// 只按整句文本去重，会把同一件事的不同措辞当成两条新事实，吃掉 10 条配额和注入字数。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

process.env.QUIET_NOTE = '1'

const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const mem = await import(pathToFileURL(join(LIB, 'memory.js')).href + '?t637=1')

function 沙盒(条们) {
  const d = mkdtempSync(join(tmpdir(), 't637-'))
  const p = join(d, 'mem.json')
  writeFileSync(p, JSON.stringify({
    'private:1': { facts: 条们.map((t, i) => ({ at: 1794500000000 + i, text: t })) },
  }), 'utf8')
  mem.useMemoryFile(p)
  return { d, p }
}

function 清理(d) {
  mem.useMemoryFile('')
  rmSync(d, { recursive: true, force: true })
}

const 旧表情 = '2026-11-14 夜里说：有时候不用解释表情包是什么——发了就让它自己接，别一上来给表情配解说。'
const 新表情 = '2026-11-15 18:07 主人说「你也不用老是在聊天解释你看到的表情包了」——收到表情包别描述画面、别配解说，直接接或直接收着就行。'
const 旧话题 = '2026-11-15 15:52 他说「{{BOT_DISPLAY}}你也可以没事找找话题跟我聊天」——要我主动开口，别等他发话；自己刷到的、想做的都可以拿去开场。'
const 新话题 = '2026-11-15：他说的「找找话题聊天」是指他没主动时我也要自己去找他聊，不是等他递话；另外他基本不看游戏比赛（电竞话题别当开场）。'

test('A1 表情包旧条与后来说法只留最新一条', () => {
  const { d } = 沙盒([旧表情, 新表情])
  try {
    const out = mem.describeMemory('private:1')
    assert.ok(out.includes(新表情), '最新说法没进注入')
    assert.ok(!out.includes(旧表情), '旧说法还在占配额')
  } finally { 清理(d) }
})

test('A2 找话题旧条与新说法只留最新一条', () => {
  const { d } = 沙盒([旧话题, 新话题])
  try {
    const out = mem.describeMemory('private:1')
    assert.ok(out.includes(新话题), '最新说法没进注入')
    assert.ok(!out.includes(旧话题), '旧说法还在占配额')
  } finally { 清理(d) }
})

test('A3 不同事实不合并', () => {
  const 甲 = '他打游戏的时候别拍照，等他有空再说。'
  const 乙 = '他喜欢二次元，kigurumi 头套也想换软材料。'
  const { d } = 沙盒([甲, 乙])
  try {
    const out = mem.describeMemory('private:1')
    assert.ok(out.includes(甲), '不同事实甲被误合并')
    assert.ok(out.includes(乙), '不同事实乙被误合并')
  } finally { 清理(d) }
})

test('A4 数字不同不合并（第1条/第2条不是同一条）', () => {
  const { d } = 沙盒(['第1条事实', '第2条事实'])
  try {
    const out = mem.describeMemory('private:1')
    assert.ok(out.includes('第1条事实'), '第1条被数字规则误合并')
    assert.ok(out.includes('第2条事实'), '第2条被数字规则误合并')
  } finally { 清理(d) }
})

test('B1 remember 合并时替换旧条，并把旧条落进可回捞日志', () => {
  const { d } = 沙盒([旧表情])
  const 旧QQMem = process.env.QQ_MEM
  process.env.QQ_MEM = d
  try {
    assert.equal(mem.remember('private:1', { fact: 新表情 }), true)
    const 卡 = mem.loadMemory('private:1')
    assert.equal(卡.facts.length, 1, '同义事实没有合并成一条')
    assert.equal(卡.facts[0].text, 新表情)
    const 日志 = join(d, '关系卡同义合并.jsonl')
    assert.ok(existsSync(日志), '合并旧条没有日志，丢了就捞不回来')
    assert.match(readFileSync(日志, 'utf8'), /解释表情包/)
  } finally {
    mem.flushMemoryPersist()
    if (旧QQMem === undefined) delete process.env.QQ_MEM
    else process.env.QQ_MEM = 旧QQMem
    清理(d)
  }
})

test('B2 完全同文仍不重复记', () => {
  const { d } = 沙盒(['他喜欢二次元'])
  try {
    mem.remember('private:1', { fact: '他喜欢二次元' })
    assert.equal(mem.loadMemory('private:1').facts.length, 1)
  } finally {
    mem.flushMemoryPersist()
    清理(d)
  }
})
