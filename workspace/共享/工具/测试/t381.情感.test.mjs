// 挑情感切片（语音合成.mjs）。它决定这一句用哪条参考音频 —— 换 ref 能让同一句话
// 从 4.64 秒变 8.88 秒，比权重影响还大，所以判定顺序必须逐条钉住。
// USAGE_LOG_SANDBOX 2026-11-14（批次466）：碰 语音合成.mjs 的测试一律先把用量流水指到沙盒。
// 这个文件只调 挑情感切片（纯函数，不写流水），但规则统一 —— 哪天有人在这里加一条真合成，
// 就不会悄悄往 {{DSH_ROOT}}/fish-usage-log.jsonl 里塞假记录。
process.env.FISH_USAGE_LOG = (await import('node:path')).join(
  (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 't381-usage-')),
  'usage.jsonl')
const { 挑情感切片, GSV_SCENES } = await import('{{BOT_ROOT}}/共享/工具/语音合成.mjs')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])
const k = (话, 指定) => 挑情感切片(话, 指定).key

// ── 显式指定：绕开内容判断 ──
加('指定 soft', k('随便什么', 'soft'), 'soft')
加('指定大写 SOFT', k('随便什么', 'SOFT'), 'soft')
加('指定带空格', k('随便什么', '  soft  '), 'soft')
加('指定的不存在 → 回到内容判断', k('我饿了', 'nope'), 'food')
加('指定 auto → 内容判断', k('我饿了', 'auto'), 'food')
加('指定空串 → 内容判断', k('我饿了', ''), 'food')
加('指定 null → 内容判断', k('我饿了', null), 'food')
加('八个档都能显式指定', Object.keys(GSV_SCENES).filter((x) => k('随便', x) !== x).length, 0)
加('返回值带 file', typeof 挑情感切片('我饿了').file, 'string')
加('返回值带 prompt', typeof 挑情感切片('我饿了').prompt, 'string')

// ── 早安（第一个关键词组，优先级最高）──
加('早安', k('早安'), 'morning')
加('早上好呀', k('早上好呀'), 'morning')
加('刚醒', k('刚醒，还有点懵'), 'morning')
加('你好', k('你好'), 'morning')
加('嗨', k('嗨'), 'morning')
加('哈喽', k('哈喽在不在'), 'morning')
加('在吗', k('在吗'), 'morning')
加('★ 早安压过饥饿：「你好，我饿了」', k('你好，我饿了'), 'morning')

// ── 亲密（第二组）──
加('晚安', k('晚安'), 'intimate')
加('去睡了', k('我去睡了'), 'intimate')
加('抱抱', k('抱抱'), 'intimate')
加('我累了', k('我累了'), 'intimate')
加('好困', k('好困啊'), 'intimate')
加('★ 亲密压过饥饿：「晚安，我饿了」', k('晚安，我饿了'), 'intimate')

// ── 吃喝（第三组）──
加('吃了吗', k('吃了吗'), 'food')
加('我饿了', k('我饿了'), 'food')
加('想喝奶茶', k('想喝奶茶'), 'food')
加('火锅', k('晚上吃火锅'), 'food')
加('★ 吃喝压过疑问：「吃了吗？」', k('吃了吗？'), 'food')

// ── 撒娇（第四组）──
加('好不好', k('陪我说说话好不好'), 'romantic')
加('想你', k('我想你了'), 'romantic')
加('求求', k('求求你了'), 'romantic')
加('陪我', k('陪我一会儿'), 'romantic')

// ── 感叹（第五组）──
加('好耶', k('好耶'), 'exclaim')
加('太棒了', k('太棒了'), 'exclaim')
加('哈哈', k('哈哈哈哈哈'), 'exclaim')
加('★ 批次373 修的：「真的假的！」不能再走 morning', k('真的假的！'), 'exclaim')
// 批次373 只修好了「带感叹/疑问词」的短句；这句不含任何关键词，仍然落到 <=6 兜底 = morning。
// 不是回归，是修复没覆盖到 —— 记在清单「待议」里，代码不动。
加('★ 「好，我知道了」6 字无关键词 → 仍然 morning（批次373 未覆盖）', k('好，我知道了'), 'morning')
加('感叹号', k('走开！'), 'exclaim')
加('6 字感叹', k('太棒了吧！'), 'exclaim')

// ── 疑问（第六组）──
加('末尾问号', k('你看外面下雨了，伞带了吗？'), 'question')
加('为什么', k('为什么呀'), 'question')
加('是不是', k('是不是这样'), 'question')
加('★ 单个问号：长度 1 但疑问在长度兜底之前', k('？'), 'question')
加('★ 半角问号（不含「真的假的」四字）', k('真的?'), 'question')

// ── 长度兜底（第七、八组，在所有关键词之后）──
加('1 字无关键词 → morning', k('嗯'), 'morning')
加('2 字 → morning', k('好的'), 'morning')
加('6 字 → morning', k('一二三四五六'), 'morning')
加('7 字 → lively', k('一二三四五六七'), 'lively')
加('12 字 → lively', k('一二三四五六七八九十一二'), 'lively')
加('13 字 → soft', k('一二三四五六七八九十一二三'), 'soft')
加('30 字叙述 → soft', k('我今天下午在店里忙到四点多才歇下来后厨那孩子又贴反单子了', ), 'soft')
加('空字符串 → morning', k(''), 'morning')
加('null → morning', k(null), 'morning')
加('undefined → morning', k(), 'morning')
加('全是空格 → morning', k('   '), 'morning')

// ── 「话说一半」不该被关键词吃掉 ──
加('「我好渴」→ food', k('我好渴'), 'food')
加('「这水真甜」5 字无关键词 → 同样落到 morning', k('这水真甜'), 'morning')

// ── 判定顺序的整体校验：每个关键词组的代表句都命中自己 ──
{
  const 代表 = [
    ['早安', 'morning'], ['晚安', 'intimate'], ['饿了', 'food'],
    ['好不好', 'romantic'], ['好耶', 'exclaim'], ['为什么', 'question'],
  ]
  const 错 = 代表.filter(([话, 期]) => k(话) !== 期)
  加('六组代表句各归各位', 错.length, 0)
}

let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (JSON.stringify(实) === JSON.stringify(期)) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
