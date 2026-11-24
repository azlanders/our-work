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

/** 关键词兜底：取查询里最长的几个二元组/词，供关键词命中做一次低价加分。 */
export function queryGrams(text) {
  const map = new Map()
  for (const t of tokens(text)) map.set(t, (map.get(t) || 0) + 1)
  return map
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
