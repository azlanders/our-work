// 批次522：两条**旧**闸门（不是我加的）的误吞回归
//
// 背景：`isSilenceStub` / `isStageDirection` 是更早写的。批次521e 只审了自己加的 isSelfTalkNote，
// 这两条一直没拿真实发言喂过。这次做了两件事：
//
// ① 拿她 2661 条真实发言（qq_send 记录 + 群聊日志）跑全闸门 → 只有 8 条命中，全是元话术：
//      「（本轮不发）」×7、「（没插话，只把人设细节记下了：我、主人、不说胖。）」
//    历史零误吞。但那只是因为**她恰好没说过**踩线的句子，不代表以后不会。
//
// ② 构造 14 句她真可能说出口的话 → **11 句被吞**：
//      「不说了，睡了」            ← STUB_ONLY_RE 的尾巴是 [\s\S]{0,12}?，什么都能跟
//      「不回他了，随他」「不发朋友圈了，没意思」
//      「（你看着办吧）」          ← 「看着」在 STAGE_KEYWORDS 里
//      「（记下来了，明天弄）」「（沉默是金）」
//    已收紧：尾巴只许标点；关键词只留强标记；另有第二人称/问号直接放行。
//
// 原则照旧：宁可漏吞（多发一句废话，主人看得见），不可误吞（丢一句真话，谁都不知道）。
import test from 'node:test'
import assert from 'node:assert/strict'

// t453 A1：文件里出现插件路径就要静音（这条判据不看是不是真 import）
process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { isSilenceStub, isStageDirection } = await import(LIB + '/outbound.js')

// ---------------- 真实夹具：这 8 条必须继续吞 ----------------
// 原文照抄自 记忆/工具调用.jsonl 与 群聊日志/2000000001-*.jsonl（她真发过的元话术）
const 真·元话术 = [
  '（本轮不发）',
  '（没插话，只把人设细节记下了：我、主人、不说胖。）',
  '不吭声。',
]

test('R1 真实元话术必须继续吞（这 7+1 条是她历史上真发过的）', () => {
  for (const s of 真·元话术) {
    assert.ok(isSilenceStub(s) || isStageDirection(s), '漏吞了：' + s)
  }
})

test('R2 括号版占位符「（本轮不发）」仍被 isSilenceStub 挡住', () => {
  // 批次522 把「本轮/这轮/这条」从 STAGE_KEYWORDS 里拿掉了 ——
  // 因为「（这条我不同意）」是真话，会被它们误吞。挡占位符交给 isSilenceStub 就够：
  assert.equal(isSilenceStub('（本轮不发）'), true)
  assert.equal(isStageDirection('（本轮不发）'), false, '本条已改由 isSilenceStub 负责')
  // 真话不许被那两个词抓回去：
  assert.equal(isStageDirection('（这条我不同意）'), false)
  assert.equal(isStageDirection('（这轮我来定）'), false)
})

// ---------------- 真话：一句都不许吞 ----------------
const 真话 = [
  // STUB_ONLY_RE 尾巴太松，原来全中
  '不说了，睡了',
  '不说了，我困了',
  '不说这个了，聊点别的',
  '不回他了，随他',
  '不接她电话了，烦',
  '不发朋友圈了，没意思',
  // STAGE_KEYWORDS 太宽，原来全中
  '（你看着办吧）',
  '（我看着挺好的）',
  '（等他回来再说）',
  '（记下来了，明天弄）',
  '（沉默是金）',
  // 之前批次521e 修过的两句（防止被这两条旧闸门重新抓回去）
  '安静待着也挺好的，不用管我',
  '没有新消息，你不用管我，我先睡了',
  '不打扰你了，去忙吧',
]

test('R3 这 14 句真话一句都不许吞（逐条报出是哪条、被谁吞的）', () => {
  const 误 = []
  for (const s of 真话) {
    if (isSilenceStub(s)) 误.push('isSilenceStub ← ' + s)
    if (isStageDirection(s)) 误.push('isStageDirection ← ' + s)
  }
  assert.deepEqual(误, [], '误吞了：\n' + 误.join('\n'))
})

test('R4 问号句一律不许当舞台说明（那是在问人，不是在描写自己）', () => {
  assert.equal(isStageDirection('（沉默了吗）'), false)
  assert.equal(isStageDirection('（不说话？）'), false)
})

test('R5 舞台说明里出现第二人称就放行（舞台说明不跟人对话）', () => {
  assert.equal(isStageDirection('（没插话，你继续）'), false, '带你 → 是真话')
  assert.equal(isStageDirection('（心里想着你）'), false, '带你 → 是真话')
  // 同一条不带「你」的要照旧吞
  assert.equal(isStageDirection('（没插话，只记下了）'), true)
})

// ---------------- 边界 ----------------
test('R6 lone「（沉默）」要吞，但「（沉默是金）」不许吞', () => {
  assert.equal(isStageDirection('（沉默）'), true)
  assert.equal(isStageDirection('（沉默了一会儿）'), true)
  assert.equal(isStageDirection('（沉默是金）'), false)
})

test('R7 空 / undefined / 纯空白 / 超长 / 垃圾输入都不许抛、不许误吞', () => {
  for (const v of [undefined, null, '', '   ', 0, 123, {}, [], true]) {
    assert.equal(isSilenceStub(v), false, 'isSilenceStub(' + String(v) + ')')
    assert.equal(isStageDirection(v), false, 'isStageDirection(' + String(v) + ')')
  }
  const 长 = '不说了' + '啊'.repeat(300)
  assert.equal(isSilenceStub(长), false, '超长的不许吞')
  assert.equal(isStageDirection('（' + '嗯'.repeat(200) + '）'), false, '超 80 字不算舞台说明')
})

test('R8 括号没闭合不算舞台说明（那是半句话，得让她发出来）', () => {
  assert.equal(isStageDirection('（没插话'), false)
  assert.equal(isStageDirection('没插话）'), false)
})

test('R9 裸「不说了」现在会漏吞 —— 这是有意的取舍', () => {
  // 收紧尾巴之后，「不说了」不再算占位符。代价是万一她真这么发，主人会看到两个字；
  // 收益是「不说了，睡了」这种真话再也不会被吞。方向按原则选：宁可漏吞。
  assert.equal(isSilenceStub('不说了'), false)
  assert.equal(isSilenceStub('不说了，晚安'), false)
  // 真正的占位符靠括号和「本轮」这类前缀认出来，不靠裸的不说：
  assert.equal(isSilenceStub('（不说）'), true)
})
