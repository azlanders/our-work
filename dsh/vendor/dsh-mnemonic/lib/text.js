// 文本提取与切词：全部本地、确定性，不联网。

const TEXT_PARTS = new Set(['text', 'input_text', 'output_text'])

/** 从一条消息里取出纯文本；兼容 content 为字符串 / 数组两种形态。 */
export function messageText(message) {
  const content = message?.content ?? message?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (!part) continue
    if (typeof part === 'string') { out.push(part); continue }
    if (!TEXT_PARTS.has(part.type)) continue
    const text = part.text ?? part.value ?? ''
    if (text) out.push(String(text))
  }
  return out.join('\n').trim()
}

export function roleOf(message) {
  return message?.role ?? message?.message?.role ?? ''
}

/**
 * 切词：中文走二元组（bigram）+ 单字兜底，英文/数字走整词。
 * 不引入任何分词依赖——记忆检索要的是召回，不是语言学。
 */
export function tokens(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  const runs = s.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) || []
  for (const run of runs) {
    if (/^[a-z0-9_]/.test(run)) {
      if (run.length >= 2) out.push(run)
      continue
    }
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return out
}

export function tokenSet(text) {
  return new Set(tokens(text))
}

/** 关键词兜底：统计查询里各二元组/词的出现次数。 */
export function queryGrams(text) {
  const map = new Map()
  for (const t of tokens(text)) map.set(t, (map.get(t) || 0) + 1)
  return map
}

// 零延迟本地方言/同义词补充，作为 LLM 查询改写的保底与增强（权重低于原词）。
const LOCAL_EXPAND_RULES = [
  [/全名|叫什么|咋写|怎么称呼|叫啥|名字/, ['名字', '姓名', '称呼', '自称']],
  [/多大|几岁|年龄|年纪|生日/, ['年龄', '岁', '生日']],
  [/住哪|住的|住址|家在哪|哪个城市|什么地方|地址|搬家/, ['住址', '搬家', '搬到', '家']],
  [/欠|答应|约定|说好|承诺|保证/, ['约定', '答应', '欠', '承诺']],
  [/喜欢|讨厌|爱吃|爱喝|偏好|口味|忌口/, ['喜欢', '讨厌', '偏好', '爱', '忌口']],
  [/多少钱|价格|花了|买了|钱/, ['钱', '价格', '元', '买']],
  [/工作|上班|职业|干啥|干什么/, ['工作', '上班', '职业']],
  [/身体|病|疼|不舒服|医院|吃药/, ['身体', '病', '疼', '医院', '药']],
]

export function expandLocal(query) {
  const s = String(query || '')
  const extra = []
  for (const [re, words] of LOCAL_EXPAND_RULES) {
    if (re.test(s)) extra.push(...words)
  }
  return extra.length ? extra.join(' ') : ''
}

export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

export function hash32(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}
