// 事实句：给检索索引和画像补一层短句，正文照旧保留。
//
// 为什么用规则不用模型：归档在每轮在线链路里，多一次 LLM 调用就多一份延迟、费用和
// 失败面；SLICE-Mem 的结论是抽取式切分足够支撑记忆检索。模型抽取还会顺手改写、
// 补全没说过的话，事实一旦进库就会被当证据召回，幻觉的代价远高于漏抽一条。
//
// 为什么事实不替代正文：LongMemEval 的 document expansion 是「原文 + 扩展词」，
// 抽出的句子拼进索引提升召回，回答仍回原文核对；只留事实会丢掉语气、上下文和
// 数字精度。所以这里只产出附加字段，不碰 text。
//
// 不做的事：不改写、不总结、不跨句合并。宁可少一条，也不造一条原文没有的陈述。

import { userPartOf } from './text.js'

export const FACT_MAX = 3

const FACT_KEYWORD_MAX = 8
const BREAKS = new Set(['。', '！', '？', '；', '!', '?', ';', '\n', '\r'])

// 问句、反问和指令都不是可复用的事实；句末问号在切句时已经剥掉，靠词面兜底。
const QUESTION_RE = /什么|怎么|为什么|为啥|咋|哪(?:里|儿|个|些|天|年|位)|谁|多少|几点|几天|几个|多久|多大|多远|如何|是不是|有没有|能不能|要不要|可不可以|行不行|好不好|对不对|[吗嘛呢]\s*$/
const DIRECTIVE_RE = /帮我|帮忙|替我|告诉我|说一下|讲讲|聊聊|你觉得|你们|你说|你看|是不是|要不要|能不能|可不可以|行不行|好不好|对不对|懂吗|知道吗|记得吗|有没有/
const PURE_TONE_RE = /^(?:[嗯哦噢啊呀哈嘿唉哎诶欸]+|[好行对是]|好的?|行吧|ok|okay|哈哈+|嘿嘿+|呵呵+)$/i
const GREETING_RE = /^(?:早安|早上好|晚安|晚上好|午安|你好|您好|大家好|在吗|在不在|哈喽|哈啰|嗨|hi|hello|谢谢|多谢|辛苦了|再见|拜拜|回见|好久不见|睡了|困了|累了|无聊|生日快乐|新年快乐)/i
const ANAPHORA_RE = /他|她|它|那|这/

/** 只取用户说的那半段；判据统一在 `lib/text.js`，这里保留旧名字给调用方。 */
export const userSide = userPartOf

function rawSegments(text) {
  const out = []
  let buf = ''
  for (const ch of String(text ?? '')) {
    if (!BREAKS.has(ch)) {
      buf += ch
      continue
    }
    if (buf.trim()) out.push({ text: buf.trim(), mark: ch })
    buf = ''
  }
  if (buf.trim()) out.push({ text: buf.trim(), mark: '' })
  return out
}

function isQuestion(sentence, mark) {
  return mark === '？' || mark === '?' || QUESTION_RE.test(sentence)
}

function isPureTone(sentence) {
  const core = sentence.replace(/[\s\p{P}\p{S}]/gu, '')
  return PURE_TONE_RE.test(core)
}

function isGreeting(sentence) {
  return sentence.length <= 14 && GREETING_RE.test(sentence)
}

function isDirective(sentence) {
  return DIRECTIVE_RE.test(sentence) || /^(?:请|麻烦)/.test(sentence)
}

/**
 * 纯规则切句：按 。！？；换行 切开，过滤问句/语气/寒暄/指令/过短过长，
 * 再丢掉短句里带指代、离开上下文就说不清主语的句子。返回原文句子，不改写。
 */
export function factSentences(text, { max = FACT_MAX } = {}) {
  const cap = Math.max(0, Math.floor(Number(max) || 0))
  if (!cap) return []
  const out = []
  for (const seg of rawSegments(userSide(text))) {
    const s = seg.text.replace(/^[\s\p{P}\p{S}]+|[\s\p{P}\p{S}]+$/gu, '').trim()
    if (s.length < 6 || s.length > 80) continue
    if (isQuestion(s, seg.mark)) continue
    if (isPureTone(s) || isGreeting(s)) continue
    if (isDirective(s)) continue
    // 「她那句话」这类短句离开上下文指不明白是谁；宁缺勿错。
    if (s.length < 12 && ANAPHORA_RE.test(s)) continue
    out.push(s)
    if (out.length >= cap) break
  }
  return out
}

// 代词、虚词、疑问词和常见时间词不进检索：它们几乎每条都出现，只会拉低区分度。
const STOP_PHRASES = [
  '为什么', '什么', '怎么', '我们', '你们', '他们', '她们', '它们', '咱们',
  '这个', '那个', '这些', '那些', '这样', '那样', '这里', '那里',
  '因为', '所以', '但是', '然后', '而且', '如果', '虽然', '就是', '还是',
  '可以', '觉得', '知道', '时候', '现在', '今天', '昨天', '明天', '今年', '去年', '明年', '最近',
  '一下', '一点', '真的', '其实', '不过', '已经', '应该', '可能', '自己',
  '不是', '没有', '不会', '不能', '不要',
].sort((a, b) => b.length - a.length)
const STOP_PHRASE_RE = new RegExp(STOP_PHRASES.join('|'), 'g')
const STOP_CHARS = new Set('的得地了着过是在有和跟与同也都就还又很太更最不没别要把被让给对从到向于为吗呢吧啊呀哦噢嗯哈啦嘛呗么们这那哪谁几多少什怎我你他她它咱俺其之而或及等个条只件次些此该每各另'.split(''))
const STOP_CHAR_RE = new RegExp(`[${[...STOP_CHARS].join('')}]`, 'g')
const LATIN_STOP = new Set('a an the and or but is are was were to of in on at it this that i you he she we they my your me do did not no yes ok hi hello'.split(' '))
const WORD_RE = /[A-Za-z][A-Za-z0-9_+#]*(?:[.-][A-Za-z0-9_+#]+)*|\d+(?:\.\d+)?|[\u4e00-\u9fff]+/g

function keywordCandidates(fact) {
  const s = String(fact ?? '')
    .replace(/[，,、：:；;。！？!?…—|/()（）【】\[\]「」“”"'《》\s]+/g, ' ')
    .replace(STOP_PHRASE_RE, ' ')
    .replace(STOP_CHAR_RE, ' ')
  const out = []
  for (const m of s.matchAll(WORD_RE)) {
    const w = m[0]
    if (/^[A-Za-z0-9]/.test(w)) {
      if (w.length >= 2 && !LATIN_STOP.has(w.toLowerCase())) out.push(w)
      continue
    }
    // 长块按 6 字切段，只控制单条关键词长度，不改顺序也不改写原文。
    for (let i = 0; i < w.length; i += 6) {
      const piece = w.slice(i, i + 6)
      if (piece.length >= 2) out.push(piece)
    }
  }
  return out
}

/** 从事实句里抽能进检索的词：停用词后的中文块（≤6 字）+ 拉丁词/数字，去重，最多 8 个。 */
export function factKeywords(facts) {
  const out = []
  const seen = new Set()
  const list = Array.isArray(facts) ? facts : [facts]
  for (const fact of list) {
    for (const w of keywordCandidates(fact)) {
      const key = w.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      out.push(w)
      if (out.length >= FACT_KEYWORD_MAX) return out
    }
  }
  return out
}
