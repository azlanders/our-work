// 批次523：三道**从来没被测试碰过**的闸门
//
// 它们原来写在 `sendToQQ` **函数体内**（所以没法 export、也没法测），批次523 搬到顶层并导出。
// 一导出、拿她 2661 条真实发言喂进去，立刻抓到一条已经在线上踩过的误吞：
//
//   [isMetaReasoning] "@{{SELF_UIN}} 定时我挂好了，每天八点一张，抓出来发黑就重试，
//                      三次还空当天就不发，只记一笔。台账也写了"
//
// 她在汇报正经事，只因为句子里有「当天就不发」，整条会被吞。
// 同型的还有 isMetaSkipNote：只要有「不回」开头就整条吞，「不回了，睡了」也中。
//
// 原则不变：宁可漏吞（多发一句废话，主人看得见），不可误吞（丢一句真话，谁都不知道）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'

const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? (process.env.DSH_HOME + '/profiles/web/node_modules/dsh-onebot-channel/lib') : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const { isMetaReasoning, isMetaSkipNote, isStubPlaceholder } = await import(LIB + '/outbound.js')

// ---------------- 真实夹具 ----------------
// 原文照抄 群聊日志/2000000001-*.jsonl
const 真实_该吞 = [
  '这条我不接，数据我先报过了。',
  '这条我不接。主人说除了那三张图什么都别发，我这边已经交完了。',
  '这条我不接。他也发了一条，我这边已经交完了。',
  '（没有发言。）',
]
const 真实_不该吞 = [
  '@{{SELF_UIN}} 定时我挂好了，每天八点一张，抓出来发黑就重试，三次还空当天就不发，只记一笔。台账也写了',
]

test('P1 真实夹具：4 条「我不接 / 没有发言」必须吞（主人 11-01 要求不发这类通报）', () => {
  for (const s of 真实_该吞) {
    assert.ok(isMetaSkipNote(s) || isStubPlaceholder(s), '漏吞：' + s)
  }
})

test('P2 真实误吞回归：汇报定时任务那句，不许因为「当天就不发」被吞', () => {
  for (const s of 真实_不该吞) {
    assert.equal(isMetaReasoning(s), false, '这是正经汇报，被当成元话术了：' + s)
    assert.equal(isMetaSkipNote(s), false)
    assert.equal(isStubPlaceholder(s), false)
  }
})

// ---------------- 构造：真话 ----------------
const 真话 = [
  '不回了，睡了',
  '不接这活了，太累',
  '那就不说了，晚安',
  '那我先不打扰你了，你忙',
  '这次不发照片了，下次吧',
  '不参与，你们定',
]
test('P3 这 6 句真话不许吞', () => {
  const 误 = []
  for (const s of 真话) {
    if (isMetaReasoning(s)) 误.push('isMetaReasoning ← ' + s)
    if (isMetaSkipNote(s)) 误.push('isMetaSkipNote ← ' + s)
    if (isStubPlaceholder(s)) 误.push('isStubPlaceholder ← ' + s)
  }
  assert.deepEqual(误, [], '误吞了：\n' + 误.join('\n'))
})

// ---------------- 构造：元话术 ----------------
test('P4 真正的自述仍要吞', () => {
  assert.equal(isMetaReasoning('这轮就不发了'), true)
  assert.equal(isMetaReasoning('我不插话，你们聊'), true)
  assert.equal(isMetaReasoning('我先不说，等他问'), true)
  assert.equal(isMetaReasoning('没有新内容，不重复发了'), true)
})

test('P5 元话术只认第一句：埋在从句里的不算', () => {
  // 首句没有自述、后面才有 → 放行（真在说事）
  assert.equal(isMetaReasoning('数据我报完了，这轮就不发了这事儿回头说'), false)
  // 首句就是自述 → 吞
  assert.equal(isMetaReasoning('这轮就不发了，数据我报完了'), true)
})

test('P6 「不接」整条立着才吞；带「这条」才允许解释尾巴', () => {
  assert.equal(isMetaSkipNote('我不回'), true, '整条就是「我不回」→ 元说明')
  assert.equal(isMetaSkipNote('不参与'), true)
  assert.equal(isMetaSkipNote('不回了，睡了'), false, '多了内容就是真话')
  assert.equal(isMetaSkipNote('这条我不接，数据我先报过了。'), true)
})

test('P7 占位符只认那几个词，且必须短', () => {
  assert.equal(isStubPlaceholder('（没有发言）'), true)
  assert.equal(isStubPlaceholder('沉默'), true)
  assert.equal(isStubPlaceholder('略'), true)
  assert.equal(isStubPlaceholder('沉默是金'), false, '带内容就不是占位')
  assert.equal(isStubPlaceholder('没有发言但是我有意见'), false)
})

// ---------------- 边界 ----------------
test('P8 垃圾输入与长度上限都不许抛', () => {
  for (const v of [undefined, null, '', '   ', 0, 123, {}, [], true]) {
    assert.equal(isMetaReasoning(v), false)
    assert.equal(isMetaSkipNote(v), false)
    assert.equal(isStubPlaceholder(v), false)
  }
  assert.equal(isMetaReasoning('这轮不' + '啊'.repeat(200)), false, 'isMetaReasoning 超 120 字不判')
  assert.equal(isMetaSkipNote('这条我不接' + '啊'.repeat(60)), false, 'isMetaSkipNote 超 40 字不判')
  assert.equal(isStubPlaceholder('沉默' + '啊'.repeat(30)), false, 'isStubPlaceholder 超 20 字不判')
})

test('P9 三道闸门都真的导出了（搬出 sendToQQ 函数体之后才可能）', () => {
  // 这条是给「以后有人把它们挪回函数体」准备的：挪回去 export 就没了，这里立刻红。
  assert.equal(typeof isMetaReasoning, 'function')
  assert.equal(typeof isMetaSkipNote, 'function')
  assert.equal(typeof isStubPlaceholder, 'function')
})

// ---------------- 统一入口 元话术命中() ----------------
const { 元话术命中 } = await import(LIB + '/outbound.js')

test('P10 统一入口：真话返回空数组，元话术返回命中的闸门名', () => {
  assert.deepEqual(元话术命中('今天风好大，你出门多穿点'), [])
  assert.deepEqual(元话术命中('不说了，睡了'), [], '真话不许有任何闸门命中')
  const 中 = 元话术命中('（本轮不发）')
  assert.ok(中.includes('isSilenceStub'), '没报出 isSilenceStub：' + 中.join(','))
  assert.ok(元话术命中('（沉默）').includes('isStageDirection'))
})

test('P11 统一入口：垃圾输入不抛，也不许返回「命中」', () => {
  for (const v of [undefined, null, '', '   ', 0, 123, {}, [], true]) {
    assert.deepEqual(元话术命中(v), [], '输入 ' + String(v) + ' 不该命中')
  }
})

test('P12 统一入口真的接在发送路径上（不是只导出个函数没人用）', () => {
  const 源码 = readFileSync(LIB + '/outbound.js', 'utf8')
  const i = 源码.indexOf('const 命中 = 元话术命中(text)')
  assert.ok(i > 0, '发送路径里没调 元话术命中')
  const 段 = 源码.slice(i, i + 400)
  assert.ok(段.includes('命中.length > 0'), '调了却没用结果')
  assert.ok(/return\s*\{[^}]*\}/.test(段), '命中了却没拦')
  // 日志必须带内容，否则事后查不出吞了什么
  assert.ok(段.includes('.slice(0, 40)'), '日志没记被吞的原文')
})
