/**
 * 边界：对方明确说过「别这么对我」的那类长期约束。
 *
 * 为什么单独做：事实、画像、未了的事都靠「检索命中」才出现，而边界一旦没命中就等于不存在。
 * 陪伴类产品的通行做法是把 boundary 当一等公民——chatbrat.ai 的偏好/边界类「每一次回复都带上」，
 * Charmi 的六类记忆里也单列 boundary。我们照这个口径做，但不照抄它们的四态审核流程。
 *
 * 不做的事：不猜、不概括、不改写。只认祈使句，原文摘出来，最多 18 字。
 * 宁可不记，也不能把「别客气」当成长期禁令。
 */

import { userPartOf } from './text.js'

// 「别担心」「别客气」这类是安慰，不是约束。落在这些词上的祈使句一律丢掉。
const SOFT_RE = /^(?:担心|客气|急|慌|忙|累|在意|介意|生气|难过|自责|想太多|想多|害怕|紧张|怕|不好意思|谢|道歉|放心|太拼|熬夜|硬撑|勉强|惯着)/

// 「别记」「别告诉别人」「别老提」是操作指令，已经由别的机制处理，不该再进边界。
const OP_RE = /记|说出去|告诉别人|往外说|老提|再提|翻旧账/

// 问句里的「别……」不是约束（「你别生气了好不好」）。
const ASK_RE = /[?？]|吗|呢|好不好|行不行|可以吗/

const LEAD_RE = /^(?:以后|以后都|以后你|你以后|你|请你|麻烦你)?\s*(?:别再|不要再|不许再|不准再|别|不要|不许|不准)\s*/

const MAX_LEN = 18

/**
 * 从用户原话里抽一条边界；抽不到返回 ''。
 * 只处理短句（≤40 字）：长段落里的「别……」多半是在讲别人的事。
 */
export function boundaryOf(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw || raw.length > 40) return ''
  if (ASK_RE.test(raw)) return ''
  const m = raw.match(/^(?:以后|以后都|以后你|你以后|你|请你|麻烦你)?\s*(?:别再|不要再|不许再|不准再|别|不要|不许|不准)(.+)$/)
  if (!m) return ''
  let body = m[1].replace(/[\s，,。.、；;：:！!？?~～]+$/g, '').trim()
  if (!body || body.length < 2) return ''
  if (SOFT_RE.test(body) || OP_RE.test(body)) return ''
  if (body.length > MAX_LEN) body = body.slice(0, MAX_LEN)
  return body
}

const TAG_NAMES = new Set(['禁忌', '边界', 'boundary'])

/** 一条记录是不是边界：规则抽出来的，或 mem_save 明确打了边界标签。 */
export function isBoundaryRecord(rec) {
  if (!rec) return false
  if (rec.boundary) return true
  return Array.isArray(rec.tags) && rec.tags.some((t) => TAG_NAMES.has(String(t || '').trim()))
}

/**
 * 渲染成常驻 system 段。边界是「每轮都要生效」的东西，所以放在固定前缀里
 * （prompt cache 命中时几乎不花钱），不塞进每轮新的回忆块。
 * 全部作用域都收：约束的是「怎么对我」，跨会话仍然成立；大肥鱼与哈基米是两套库，不会串。
 */
export function renderBoundaries(records, { maxChars = 70, limit = 3 } = {}) {
  const items = []
  const seen = new Set()
  const sorted = (records || [])
    .filter((r) => r && !r.supersededBy && !r.muted && isBoundaryRecord(r))
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  for (const rec of sorted) {
    const text = String(rec.boundary || '').trim() || boundaryOf(userPartOf(rec.text))
    if (!text || seen.has(text)) continue
    seen.add(text)
    items.push(text)
    if (items.length >= limit) break
  }
  if (!items.length) return ''
  // 规则抽出来的是「别」后面的部分，mem_save 存的是整句；两种都不能拼出「别别」。
  const body = items.map((t) => (/^(?:别|不要|不许|不准)/.test(t) ? t : `别${t}`)).join('；')
  const line = `【她说过不要】${body}`
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`
}
