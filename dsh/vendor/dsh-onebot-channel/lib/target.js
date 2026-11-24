/**
 * target.js —— 出站目标校验与队列小工具（批次 602B）。
 *
 * 为什么单独抽出来：
 *   qq_send、/send、outbound 三处原来各写一套「没给 id 就退回 peerUin」，
 *   显式传空串/0/abc 时会被静默当成「没传」，消息发给主人而不是报错。
 *   规则必须只有一份，而且能脱离整条出站链单测。
 */

const QQ_ID_RE = /^[1-9]\d{0,11}$/

/**
 * QQ 号 / 群号 → 规范化的十进制字符串。
 * 只接受 1–12 位正整数；空串、0、负数、小数、科学计数法、前后缀一律拒绝。
 */
export function normalizeQqId(raw) {
  if (raw === undefined || raw === null) return { ok: false, error: '缺少号码' }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw) || !QQ_ID_RE.test(String(raw))) {
      return { ok: false, error: `必须是 1–12 位正整数：${raw}` }
    }
    return { ok: true, id: String(raw) }
  }
  if (typeof raw !== 'string') return { ok: false, error: `类型不对：${typeof raw}` }
  const s = raw.trim()
  if (s === '') return { ok: false, error: '不能为空' }
  if (!QQ_ID_RE.test(s)) return { ok: false, error: `必须是 1–12 位正整数：${s}` }
  return { ok: true, id: s }
}

/** target 上是否真的带了 id 字段（undefined/null 视为没带）。 */
export function hasExplicitId(target) {
  return target !== null
    && typeof target === 'object'
    && Object.prototype.hasOwnProperty.call(target, 'id')
    && target.id !== undefined
    && target.id !== null
}

/**
 * 私聊 target → 实际 user_id。
 * - 带了 id：必须合法，非法直接抛错（绝不静默回落）。
 * - 没带 id：才允许退回默认私聊对象 peerUin。
 */
export function resolvePrivateUin(target, fallbackPeerUin) {
  if (hasExplicitId(target)) {
    const n = normalizeQqId(target.id)
    if (!n.ok) throw new Error(`私聊目标非法（${n.error}）`)
    return Number(n.id)
  }
  const f = normalizeQqId(fallbackPeerUin)
  if (!f.ok) throw new Error(`没有指定私聊目标，且默认私聊对象无效（${f.error}）`)
  return Number(f.id)
}

export function resolveSendTarget(target, fallbackPeerUin) {
  if (target?.kind !== 'group') {
    return { kind: 'private', id: String(resolvePrivateUin(target, fallbackPeerUin)) }
  }
  const group = normalizeQqId(target.id)
  if (!group.ok) throw new Error(`群聊目标非法（${group.error}）`)
  return { kind: 'group', id: group.id }
}

/**
 * people 档案（别扭/怨/好感）的键：只有私聊有单一对象。
 * 群聊没有「这一个人」，返回空串 —— 绝不能拿 Object.values(...)[0] 顶替，
 * 否则跟 A 私聊时会读到 B 的别扭/怨（批次605 修的就是这个）。
 */
export function personKeyOf(target, fallbackPeerUin = '') {
  if (!target || target.kind !== 'private') return ''
  const raw = target.id
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return String(fallbackPeerUin ?? '').trim()
  }
  return String(raw).trim()
}

/** 从 people 结构的档案里取目标的记录；群聊/无目标返回 null。 */
export function personRecordOf(db, target, fallbackPeerUin = '') {
  const key = personKeyOf(target, fallbackPeerUin)
  if (key === '') return null
  const rec = (db && db.people) ? db.people[key] : null
  return rec && typeof rec === 'object' ? rec : null
}

/**
 * 「这条队列项只出队一次」的守卫。
 * 出站发送异常时，旧代码在发送前 shift 一次、catch 里又 shift 一次，
 * 第二次会把下一条尚未发送的消息一起丢掉。所有出队点都必须经过这里。
 */
export function newDequeueState() {
  return { done: false }
}

export function dequeueOnce(queue, state) {
  if (state?.done === true) return false
  if (!Array.isArray(queue) || queue.length === 0) {
    if (state !== undefined && state !== null) state.done = true
    return false
  }
  queue.shift()
  if (state !== undefined && state !== null) state.done = true
  return true
}

/** 有界死信盒：发送失败的正文留最近 N 条，方便面板/日志补发与定位。 */
export class DeadLetterBox {
  constructor(limit = 50) {
    const n = Number(limit)
    this.limit = Number.isFinite(n) && n > 0 ? Math.floor(n) : 50
    this.items = []
  }

  push(item) {
    this.items.push(item)
    while (this.items.length > this.limit) this.items.shift()
    return this.items.length
  }

  list() {
    return this.items.slice()
  }

  clear() {
    this.items.length = 0
  }
}
