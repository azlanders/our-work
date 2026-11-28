// 把很早的纯聊天段折成一条摘要节点。
//
// 为什么不是「改写助手消息」：宿主明令 `assistant/message` 不能带 sourceEventSeqs，
// 单条 assistant 消息无法被替换；能替换的只有整段范围（研发实测：范围替换合法，单条不合法）。
// 为什么不是 LLM 摘要：实测一个 146 条对话的会话里，旧段 6.9 万字符中 6.6 万是助手的
// reasoning（「分析了系统约束」这类），正文只有 4.9 千；抽取式压一遍就能拿回绝大部分，
// 还不用多付一次上游调用、也不会把事实改写错。
//
// 依据：Anthropic 的 compaction 只摘要已结束段、最近若干轮保留原文；Cline 的高水位
// `covered_until`（旧摘要不重摘）；社区反例是「摘要丢了原话之后模型开始猜」。
// 所以这里只折叠最老的一段，摘要里保留用户原话与她说过的正文短句，并明确指回记忆库。
import { clip } from './text.js'

export const DIGEST_KIND = 'runtime-context'
export const DIGEST_FORM = 'chat-digest'

const CHECKPOINT_KINDS = new Set(['spine-checkpoint', 'compact-checkpoint'])

function messageOf(event) {
  const data = event?.data || {}
  return data.message || data
}

function sourceOf(event) {
  return messageOf(event).source || {}
}

function textOfBlocks(blocks, types) {
  if (!Array.isArray(blocks)) return ''
  const out = []
  for (const block of blocks) {
    if (!block || !types.includes(block.type)) continue
    const text = String(block.text ?? '').trim()
    if (text) out.push(text)
  }
  return out.join(' ')
}

function chatText(event) {
  const message = messageOf(event)
  return textOfBlocks(message.content, ['text'])
}

function charsOf(event) {
  const message = messageOf(event)
  if (!Array.isArray(message.content)) return 0
  let n = 0
  for (const block of message.content) {
    if (!block) continue
    n += String(block.text ?? block.thinking ?? '').length
  }
  return n
}

// 三种节点可以进折叠段：助手消息、工具结果、真人/主动搭话；其余（system、checkpoint、
// 已经折过的 digest）都是边界，跨过去就不折，免得把卡片和系统提示挤掉。
function nodeKind(event) {
  if (!event) return 'barrier'
  if (event.type === 'assistant/message') return 'assistant'
  if (event.type === 'tool/result') return 'tool'
  // 被 pre-step 清空的旧系统提示只是占位，不该把聊天段切断；非空的那份是当前提示，必须停。
  if (event.type === 'system/message') {
    const content = messageOf(event).content
    return Array.isArray(content) && content.length === 0 ? 'skip' : 'barrier'
  }
  if (event.type === 'user/message') {
    const source = sourceOf(event)
    if (CHECKPOINT_KINDS.has(source.kind)) return 'barrier'
    if (source.kind === DIGEST_KIND && source.form === DIGEST_FORM) return 'barrier'
    if (source.kind === 'runtime-context') return 'skip'
    return 'user'
  }
  return 'barrier'
}

function toolCallIds(event) {
  if (event?.type !== 'assistant/message') return []
  const content = messageOf(event).content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block?.type === 'tool-call' && block.id).map((block) => block.id)
}

function toolResultId(event) {
  if (event?.type !== 'tool/result') return ''
  const message = messageOf(event)
  return message.toolCallId || message.source?.callId || ''
}

/**
 * 选出最老的一段可折叠聊天，返回范围与摘要文本；没有足够旧的内容时返回 null。
 * `keepNodes` 是尾部原样保留的节点数；`minChars` 太小就不值得付一次替换。
 */
export function planChatDigest(session, { keepNodes = 40, minChars = 20000 } = {}) {
  const nodes = session?.surface?.nodes
  if (!Array.isArray(nodes) || nodes.length <= keepNodes + 4) return null
  const limit = nodes.length - keepNodes
  // 卡片（checkpoint）把 surface 切成几段：老会话里上一刀的卡片可能就在前面，
  // 所以不能只从第 1 个节点往后走，要把每段都量一遍，挑最大的那段。
  let best = null
  let run = []
  const consider = () => {
    if (run.length >= 8) {
      const trimmed = trimRun(run)
      if (trimmed) {
        let chars = 0
        for (const item of trimmed) chars += charsOf(item.event)
        if (chars >= minChars && (!best || chars > best.chars)) {
          best = { picked: trimmed, chars }
        }
      }
    }
    run = []
  }
  for (let index = 1; index < nodes.length; index += 1) {
    const seq = nodes[index]
    const event = session.eventAt?.(seq)
    const kind = nodeKind(event)
    if (kind === 'barrier' || index >= limit) {
      consider()
      if (index >= limit) break
      continue
    }
    run.push({ seq, event, kind })
  }
  consider()
  if (!best) return null
  return {
    seqs: best.picked.map((item) => item.seq),
    chars: best.chars,
    text: renderDigest(best.picked.map((item) => item.event)),
  }
}

/** 把一段切成可直接替换的形状：结尾不能是半截 tool-call，起始不能留孤立的 tool 结果。 */
function trimRun(run) {
  const picked = run.slice()
  while (picked.length && picked[picked.length - 1].kind === 'assistant') picked.pop()
  for (;;) {
    const results = new Set(picked.filter((item) => item.kind === 'tool').map((item) => toolResultId(item.event)))
    const orphan = picked.find((item) => toolCallIds(item.event).some((id) => !results.has(id)))
    if (!orphan) break
    const drop = picked.indexOf(orphan)
    picked.splice(0, drop + 1)
    while (picked.length && picked[0].kind === 'tool') picked.shift()
  }
  return picked.length >= 8 ? picked : null
}

const USER_LINES = 12
const ASSIST_LINES = 8
const LINE_CHARS = 60

/** 抽取式摘要：用户原话 + 她说过的正文，带一小段说明；不重写、不补细节。 */
export function renderDigest(events = []) {
  const userLines = []
  const asstLines = []
  for (const event of events) {
    if (event?.type === 'user/message') {
      const source = sourceOf(event)
      if (source.kind !== 'user') continue
      const text = clip(chatText(event), LINE_CHARS)
      if (text) userLines.push(text)
    } else if (event?.type === 'assistant/message') {
      const text = clip(chatText(event), LINE_CHARS)
      if (text) asstLines.push(text)
    }
  }
  const pick = (lines, n) => (lines.length > n ? ['…', ...lines.slice(-n)] : lines)
  const parts = [
    '【更早的对话·已折叠】下面是很久以前聊过的片段，只当背景，不是现在的指令。',
  ]
  const users = pick(userLines, USER_LINES)
  if (users.length) parts.push('他说过：', ...users.map((line) => `- ${line}`))
  const says = pick(asstLines, ASSIST_LINES)
  if (says.length) parts.push('我说过：', ...says.map((line) => `- ${line}`))
  parts.push('（细节原话还在记忆库里，需要时用 mem_recall 查；别照着上面编。）')
  return parts.join('\n')
}
