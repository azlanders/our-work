// 批次521e：出站闸门不许误吞真话
//
// 背景：`outbound.js` 的出站闸门现在串了 7 道判据
//   isSilenceStub || isStageDirection || isMetaSkipNote || isMetaReasoning
//   || isStubPlaceholder || isEnglishMetaNote || isSelfTalkNote
// 任何一道判错就把她**真要说的话**吞掉 —— 那是「说了没发」的另一种形态，
// 而且比漏吞更难受：她以为说了，主人一个字没收到。
//
// 实测风险：SELF_TALK_RES 第 3 条 `/^(我)?(先)?安静(待着|收着)/` 没有结尾锚，
// 「我先安静一会儿，等下再跟你说」会被整条吞掉。
//
// 原则：宁可漏吞（多发一句废话，主人看得见），不可误吞（丢一句真话，谁都不知道）。
import test from 'node:test'
import assert from 'node:assert/strict'

// t453 A1：文件里出现插件路径就要静音
process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { isSelfTalkNote, isEnglishMetaNote, isSilenceStub, isStageDirection } = await import(LIB + '/outbound.js')

const 该吞 = (t) => isSelfTalkNote(t)
const 不该吞 = (t) => !isSelfTalkNote(t)

test('S1 实测过的三条心里话，必须吞掉', () => {
  for (const t of [
    '这一轮我不发消息，安静待着。',
    '我这边没有新消息，就不打扰主人了。',
    '没有新消息，这轮不用开口。',
  ]) {
    assert.ok(该吞(t), '漏吞了：' + t)
  }
})

test('S2 「我先安静一会儿，等下再跟你说」是真话，不许吞', () => {
  assert.ok(不该吞('我先安静一会儿，等下再跟你说'), '把真话吞了')
})

test('S3 「安静待着也挺好的，不用管我」不许吞', () => {
  assert.ok(不该吞('安静待着也挺好的，不用管我'), '把真话吞了')
})

test('S4 「没有新消息，你不用管我，我先睡了」不许吞', () => {
  assert.ok(不该吞('没有新消息，你不用管我，我先睡了'), '把真话吞了')
})

test('S5 「今天就到此」这种短句不许吞（可能是正常收尾话）', () => {
  assert.ok(不该吞('今天就到此'), '吞了带前缀的正常短句')
})

test('S6 纯「安静待着」这种整条元话术，仍然要吞', () => {
  for (const t of ['安静待着', '安静待着。', '我先安静待着']) {
    assert.ok(该吞(t), '漏吞了：' + t)
  }
})

test('S7 「不打扰你了，去忙吧」一直是真话，从批次513 起就不许吞', () => {
  assert.ok(不该吞('不打扰你了，去忙吧'))
})

test('S8 长度上限还在（超过 80 字一律不算心里话，防止长段落被吞）', () => {
  assert.ok(!该吞('这一轮我不发消息' + '，'.repeat(2) + '啊'.repeat(80)), '超长段落被吞了')
})

test('S9 空/空白/非字符串都不许崩', () => {
  for (const v of ['', '   ', null, undefined, 0, {}]) {
    assert.equal(typeof isSelfTalkNote(v), 'boolean')
    assert.equal(isSelfTalkNote(v), false, '输入 ' + String(v) + ' 被判成了心里话')
  }
})

test('S10 英文元话术仍然要吞，正常英文不许吞（两个函数别互相影响）', () => {
  assert.ok(isEnglishMetaNote('Nothing to send this turn.'), '英文元话术漏了')
  assert.ok(isEnglishMetaNote('Done — nothing sent.'), '英文元话术漏了')
  assert.ok(!isEnglishMetaNote('Done, that was fun.'), '正常英文被吞了')
  assert.ok(!isEnglishMetaNote('这一轮我不发消息'), '带中文的不该走英文判据')
})

test('S11 三道判据不许互相抢：同一句话最多只该被一道抓', () => {
  const 样本 = ['这一轮我不发消息，安静待着。', '（安静待着）', '不打扰你了，去忙吧']
  for (const t of 样本) {
    const 命中 = [isSelfTalkNote(t), isSilenceStub(t), isStageDirection(t)].filter(Boolean).length
    assert.ok(命中 <= 2, '「' + t + '」被 ' + 命中 + ' 道同时命中，判据重叠太厉害')
  }
})
