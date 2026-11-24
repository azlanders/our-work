/**
 * BATCH661 2026-11-17（审计 P1-6）：工具回执的唯一一份「压成一行预览」实现。
 *
 * 638 只在**新归档**时把 `role:'tool'` 正文压成 40 字预览，旧 folder 里
 * 还躺着当时的报错栈、搜索结果、网页正文（线上 2645 个混合 folder）。
 * 647 只跳过「一句人话都没有」的纯工具 folder，混合 folder 照样整段召回。
 *
 * 这里把截断规则抽出来，写入侧（lib/surface.js）和读侧（engine/recall.js）
 * 共用同一份，避免两边各写一套、改一边忘一边。
 */

/** 预览最多保留多少字符。 */
export const TOOL_RECEIPT_PREVIEW_CHARS = 40

/** 回执消息里携带的工具名（best effort，没有就返回空串）。 */
export function toolNameOfMessage(message) {
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block === null || typeof block !== 'object') continue
    const name = typeof block.toolName === 'string' ? block.toolName : typeof block.tool_name === 'string' ? block.tool_name : ''
    if (name !== '') return name
  }
  return typeof message?.toolName === 'string' ? message.toolName : ''
}

/**
 * 工具结果的归档替身：工具名 + 一行预览。
 * 预览有上限，召回一个 folder 时不会把搜索结果或两万字报错栈带进模型历史。
 */
export function toolReceiptText(message, rawText) {
  const name = toolNameOfMessage(message)
  const label = name === '' ? '工具' : name
  const flat = String(rawText ?? '').replace(/\s+/g, ' ').trim()
  if (flat === '') return `（${label} 回执，没有正文）`
  const preview = flat.slice(0, TOOL_RECEIPT_PREVIEW_CHARS)
  const tail = flat.length > TOOL_RECEIPT_PREVIEW_CHARS ? '…' : ''
  return `（${label} 回执：${preview}${tail}；正文不入长期记忆）`
}
