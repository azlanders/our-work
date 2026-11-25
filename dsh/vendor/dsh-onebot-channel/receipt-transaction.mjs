import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const UNKNOWN_TTL_MS = 30 * 60e3

export class ProactiveReceiptStore {
  constructor({ file, beforePersist = () => {} }) {
    if (typeof file !== 'string' || file === '') throw new TypeError('a receipt file is required')
    this.file = file
    this.beforePersist = beforePersist
    this.entries = {}
  }

  loadForUse() {
    if (this.loaded) return this.entries
    if (!existsSync(this.file)) {
      this.loaded = true
      return this.entries
    }
    const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new TypeError('invalid receipt file')
    let changed = false
    const now = Date.now()
    for (const entry of Object.values(parsed)) {
      if (entry?.status === 'sending') {
        changed = true
        entry.status = 'unknown'
        entry.unknownAt = Number(entry.finishedAt) || Number(entry.stagedAt) || now
      }
      // UNKNOWN_TTL 2026-11-23: a send whose platform outcome is unknown must not
      // block the same target forever. OneBot offline leaves a permanent unknown
      // entry, so every later proactive tick says "cooldown" with until=0.
      if (entry?.status === 'unknown') {
        const at = Number(entry.unknownAt) || Number(entry.stagedAt) || 0
        if (at > 0 && now >= at + UNKNOWN_TTL_MS) {
          changed = true
          entry.status = 'not-sent'
          entry.finishedAt = now
          entry.cooldownUntil = now
        }
      }
    }
    if (changed) this.persist(parsed)
    this.entries = parsed
    this.loaded = true
    return this.entries
  }

  persist(entries = this.entries) {
    this.beforePersist(entries)
    mkdirSync(dirname(this.file), { recursive: true })
    const temporary = `${this.file}.tmp-${process.pid}-${randomUUID()}`
    try {
      writeFileSync(temporary, JSON.stringify(entries, null, 2), 'utf8')
      renameSync(temporary, this.file)
    } catch (error) {
      try { unlinkSync(temporary) } catch (_err) { console.error('[onebot:receipt-transaction]', _err?.message || _err) }
      throw error
    }
    this.entries = entries
    this.loaded = true
  }

  record(token) {
    const entry = this.loadForUse()[String(token)]
    return entry === undefined ? null : structuredClone(entry)
  }

  recordsForSource(sessionId, messageId) {
    if (!isStableIdentity(messageId)) return []
    return Object.values(this.loadForUse()).filter((entry) => entry.sessionId === String(sessionId)
      && entry.sourceMessageId === String(messageId)).map((entry) => structuredClone(entry))
  }

  acceptedAwaitingEffects() {
    return Object.values(this.loadForUse()).filter((entry) => entry.status === 'accepted' && entry.complete === true
      && !['quota', 'topics', 'later'].every((step) => entry.reconciliation?.[step] === true))
      .sort((left, right) => left.acceptedAt - right.acceptedAt).map((entry) => structuredClone(entry))
  }

  expirePending(now, ttlMs) {
    for (const entry of Object.values(this.loadForUse())) {
      if (entry.status === 'pending' && now >= entry.stagedAt + ttlMs) this.cancelNotSent({ ...entry, now })
    }
  }

  unresolvedForSession(sessionId) {
    this.loadForUse()
    return Object.values(this.entries)
      .filter((entry) => entry?.sessionId === String(sessionId)
        && ['pending', 'sending', 'unknown'].includes(entry?.status))
      .sort((left, right) => Number(right.stagedAt) - Number(left.stagedAt))[0] ?? null
  }

  hasSessionRecords(sessionId) {
    return Object.values(this.loadForUse()).some((entry) => entry.sessionId === String(sessionId))
  }

  nudgeAccepted(token) {
    return this.record(token)?.status === 'accepted'
  }

  stage({ token = randomUUID(), sessionId, sourceMessageId, target, materialIds, laterId, guardToken, chargeDailyQuota = true, cooldownMs = 15 * 60e3, now = Date.now() }) {
    this.loadForUse()
    const key = String(token)
    if (key === '' || !isStableIdentity(sessionId) || !isStableIdentity(sourceMessageId) || !validTarget(target)) {
      throw new TypeError('invalid proactive receipt identity')
    }
    const existing = this.entries[key]
    if (existing) return { ...structuredClone(existing), duplicate: true }
    const targetKey = JSON.stringify(normalizedTarget(target))
    const active = Object.values(this.entries).find((entry) => JSON.stringify(entry.target) === targetKey
      && (['pending', 'sending', 'unknown'].includes(entry.status) || (entry.status === 'accepted' && entry.complete === true
        && !['quota', 'topics', 'later'].every((step) => entry.reconciliation?.[step] === true))))
    if (active) return { ...structuredClone(active), blocked: true }
    const cooldown = Object.values(this.entries).find((entry) => JSON.stringify(entry.target) === targetKey
      && ['not-sent', 'rejected'].includes(entry.status)
      && Number(entry.cooldownUntil) > Number(now))
    if (cooldown) return { ...structuredClone(cooldown), blocked: true }
    const entries = structuredClone(this.entries)
    entries[key] = {
      token: key,
      status: 'pending',
      sessionId: String(sessionId),
      sourceMessageId: String(sourceMessageId),
      target: normalizedTarget(target),
      materialIds: [...new Set((Array.isArray(materialIds) ? materialIds : []).map(String).filter(Boolean))],
      laterId: String(laterId ?? ''),
      ...(guardToken ? { guardToken: String(guardToken) } : {}),
      ...(chargeDailyQuota === false ? { chargeDailyQuota: false } : {}),
      stagedAt: Number(now) || Date.now(),
      cooldownMs: Math.max(0, Number(cooldownMs) || 0),
    }
    this.persist(entries)
    return { ...structuredClone(this.entries[key]), duplicate: false }
  }

  /**
   * Read-only: whether this target is currently blocked by receipt state.
   * Stage() would reject with blocked/duplicate for the same reasons; the proactive
   * tick uses this to skip composing a nudge that is guaranteed to be rejected.
   */
  blockOf(target, now = Date.now()) {
    this.loadForUse()
    if (!validTarget(target)) return null
    const targetKey = JSON.stringify(normalizedTarget(target))
    const active = Object.values(this.entries).find((entry) => JSON.stringify(entry.target) === targetKey
      && (['pending', 'sending', 'unknown'].includes(entry.status) || (entry.status === 'accepted' && entry.complete === true
        && !['quota', 'topics', 'later'].every((step) => entry.reconciliation?.[step] === true))))
    if (active) return { status: active.status, until: 0 }
    const cooldown = Object.values(this.entries).find((entry) => JSON.stringify(entry.target) === targetKey
      && ['not-sent', 'rejected'].includes(entry.status)
      && Number(entry.cooldownUntil) > Number(now))
    if (cooldown) return { status: cooldown.status, until: Number(cooldown.cooldownUntil) }
    return null
  }

  recordCurrent(token, update) {
    this.loadForUse()
    const key = String(token ?? '')
    if (!Object.prototype.hasOwnProperty.call(this.entries, key)) return false
    const next = structuredClone(this.entries)
    const current = next[key]
    if (typeof update === 'function') update(current)
    else Object.assign(current, update)
    this.persist(next)
    return true
  }

  markAttempted({ token, sessionId, sourceMessageId, target, turn, callId, expectedSegments = 1, selectedMaterialIds = [], now = Date.now() }) {
    this.loadForUse()
    const entry = this.findMatching({ token, sessionId, target })
    if (!entry || entry.status !== 'pending' || entry.sourceMessageId !== String(sourceMessageId ?? '')
      || !Number.isSafeInteger(Number(turn)) || Number(turn) < 1 || !isStableIdentity(callId)
      || !Number.isSafeInteger(expectedSegments) || expectedSegments < 1) {
      return { accepted: false, reason: 'no-matching-pending-attempt' }
    }
    if (!Array.isArray(selectedMaterialIds) || selectedMaterialIds.some((id) => !entry.materialIds.includes(id)
      && (!entry.laterId || id !== `later:${entry.laterId}`))) return { accepted: false, reason: 'material-not-offered' }
    const entries = structuredClone(this.entries)
    const attempted = entries[String(token)]
    attempted.status = 'sending'
    attempted.turn = Number(turn)
    attempted.callId = String(callId)
    attempted.expectedSegments = expectedSegments
    attempted.selectedMaterialIds = [...new Set(selectedMaterialIds)]
    attempted.attemptedAt = Number(now) || Date.now()
    this.persist(entries)
    return { accepted: true }
  }

  confirmAccepted({ token, sessionId, sourceMessageId, target, turn, callId, ok, messageId, now = Date.now() }) {
    this.loadForUse()
    const entry = this.findMatching({ token, sessionId, target })
    if (!entry || entry.sourceMessageId !== String(sourceMessageId ?? '')) return { accepted: false, reason: 'no-matching-pending-attempt' }
    const numericMessageId = positiveMessageId(messageId)
    if (ok !== true || numericMessageId === 0) {
      return { accepted: false, reason: 'platform-receipt-unconfirmed' }
    }
    if (entry.status === 'accepted') {
      return entry.turn === Number(turn) && entry.callId === String(callId ?? '') && entry.messageId === numericMessageId
        ? { accepted: true, duplicate: true }
        : { accepted: false, reason: 'different-accepted-attempt' }
    }
    if (entry.status !== 'sending' && entry.status !== 'unknown') return { accepted: false, reason: 'attempt-not-open' }
    if (entry.turn !== Number(turn) || entry.callId !== String(callId ?? '')) return { accepted: false, reason: 'different-attempt' }
    if (entry.expectedSegments !== 1 || (entry.messageIds?.length && entry.messageIds[0] !== numericMessageId)) {
      return { accepted: false, reason: 'incomplete-platform-receipts' }
    }
    const entries = structuredClone(this.entries)
    const accepted = entries[String(token)]
    if (!Array.isArray(accepted.messageIds)) accepted.messageIds = []
    if (!accepted.messageIds.includes(numericMessageId)) accepted.messageIds.push(numericMessageId)
    accepted.status = 'accepted'
    accepted.messageId = numericMessageId
    accepted.acceptedAt = Number(now) || Date.now()
    this.persist(entries)
    return { accepted: true, duplicate: false }
  }

  confirmCompleteAccepted(input, messageIds) {
    const ids = Array.isArray(messageIds) ? messageIds.map(positiveMessageId) : []
    if (input.ok !== true || ids.length === 0 || ids.includes(0) || new Set(ids).size !== ids.length) {
      return { accepted: false, reason: 'incomplete-platform-receipts' }
    }
    this.loadForUse()
    const entry = this.findMatching(input)
    if (!entry || entry.sourceMessageId !== String(input.sourceMessageId ?? '')
      || entry.turn !== Number(input.turn) || entry.callId !== String(input.callId ?? '')) {
      return { accepted: false, reason: 'attempt-not-open' }
    }
    if (ids.length !== entry.expectedSegments || ids.some((id, index) => entry.messageIds?.[index] !== id)) {
      return { accepted: false, reason: 'incomplete-platform-receipts' }
    }
    if (entry.status === 'accepted' && entry.complete === true) return { accepted: true, duplicate: true, messageId: ids.at(-1) }
    if (entry.status !== 'sending') return { accepted: false, reason: 'attempt-not-open' }
    const entries = structuredClone(this.entries)
    Object.assign(entries[String(input.token)], {
      status: 'accepted',
      messageId: ids.at(-1),
      messageIds: ids,
      acceptedAt: Number(input.now) || Date.now(),
      complete: true,
    })
    this.persist(entries)
    return { accepted: true, duplicate: false, messageId: ids.at(-1) }
  }

  appendSegmentReceipt(input, messageId) {
    this.loadForUse()
    const entry = this.findMatching(input)
    const numericId = positiveMessageId(messageId)
    if (!entry || entry.status !== 'sending' || entry.turn !== Number(input.turn)
      || entry.sourceMessageId !== String(input.sourceMessageId ?? '')
      || entry.callId !== String(input.callId ?? '') || numericId === 0) return false
    const ids = [...(entry.messageIds ?? [])]
    if (ids.includes(numericId) || ids.length >= entry.expectedSegments) return false
    ids.push(numericId)
    return this.recordCurrent(input.token, { messageIds: ids })
  }

  reconcileAccepted(token, { noteNudge, rememberTopicUse, completeLater }) {
    this.loadForUse()
    const entry = this.entries[String(token ?? '')]
    if (!entry || entry.status !== 'accepted' || entry.complete !== true) return { reconciled: false, reason: 'not-complete-accepted' }
    const outstanding = ['quota', 'topics', 'later'].filter((step) => entry.reconciliation?.[step] !== true)
    for (const step of outstanding) {
      const handler = { quota: noteNudge, topics: rememberTopicUse, later: completeLater }[step]
      if (typeof handler !== 'function') return { reconciled: false, reason: `${step}-handler-missing` }
      if (handler(structuredClone(entry)) !== true) return { reconciled: false, reason: `${step}-commit-failed` }
      const updated = this.entries[String(token)]
      this.recordCurrent(token, { reconciliation: { ...(updated.reconciliation ?? {}), [step]: true } })
    }
    return { reconciled: true }
  }

  cancelNotSent({ token, sessionId, target, turn, now = Date.now(), cooldownMs }) {
    this.loadForUse()
    const entry = this.findMatching({ token, sessionId, target })
    if (!entry || entry.status !== 'pending') return { cancelled: false, reason: 'attempt-not-open' }
    if (turn != null && entry.turn !== undefined && entry.turn !== Number(turn)) return { cancelled: false, reason: 'different-attempt' }
    const entries = structuredClone(this.entries)
    const cancelled = entries[String(token)]
    cancelled.status = 'not-sent'
    cancelled.cancelledAt = Number(now) || Date.now()
    cancelled.cooldownUntil = cancelled.cancelledAt + Math.max(0, Number(cooldownMs ?? entry.cooldownMs) || 0)
    this.persist(entries)
    return { cancelled: true, accepted: false }
  }

  /**
   * 这个 target 连续「开了回合但一句没发」了几次。
   * 主动搭话的冷却靠它指数拉长：一次没说出口就每 15 分钟再烧 28k 上下文，
   * 一晚几十轮全是空转。
   */
  quietStreak(target, now = Date.now(), skipToken = '') {
    if (!validTarget(target)) return 0
    const targetKey = JSON.stringify(normalizedTarget(target))
    const rows = Object.values(this.loadForUse())
      .filter((entry) => String(entry.token ?? '') !== String(skipToken ?? ''))
      .filter((entry) => JSON.stringify(entry.target) === targetKey)
      .filter((entry) => Number(entry.stagedAt) <= Number(now))
      .sort((left, right) => Number(right.stagedAt) - Number(left.stagedAt))
    let streak = 0
    for (const entry of rows) {
      if (entry.status === 'not-sent' && !(Array.isArray(entry.messageIds) && entry.messageIds.length > 0)) {
        streak += 1
        continue
      }
      break
    }
    return streak
  }

  findMatching({ token, sessionId, target }) {
    const entry = this.entries[String(token ?? '')]
    if (!entry || entry.sessionId !== String(sessionId ?? '') || !validTarget(target)) return null
    const checkedTarget = normalizedTarget(target)
    return entry.target.kind === checkedTarget.kind && entry.target.id === checkedTarget.id ? entry : null
  }
}

function isStableIdentity(value) {
  return typeof value === 'string' || typeof value === 'number'
    ? String(value).trim() !== ''
    : false
}

function validTarget(value) {
  return ['private', 'group'].includes(String(value?.kind ?? '')) && /^\d+$/.test(String(value?.id ?? ''))
}

function normalizedTarget(target) {
  return { kind: String(target.kind), id: String(target.id) }
}

function positiveMessageId(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value.trim()))) return 0
  const messageId = Number(value)
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : 0
}

function liveEvents(session) {
  if (!isStableIdentity(session?.id) || typeof session.snapshotEvents !== 'function' || typeof session.isOwnSeq !== 'function') return null
  const end = Number(session.seq)
  if (!Number.isSafeInteger(end) || end < 1) return null
  try {
    const events = session.snapshotEvents(Number(session.firstLiveSeq) || 0, end)
    return Array.isArray(events) ? events.filter((event) => event?.seq < end && session.isOwnSeq(event.seq)) : null
  } catch { return null }
}

function proactiveMarker(message) {
  return String(message?.source?.qq?.proactiveReceiptToken ?? '')
}

function currentHostCall(session, exec, toolName) {
  const events = liveEvents(session)
  if (!events) return null
  const index = events.findLastIndex((event) => event.type === 'turn/start')
  const turn = Number(events[index]?.data?.turn)
  if (index < 0 || !Number.isSafeInteger(turn) || turn < 1) return null
  const turnEvents = events.slice(index + 1)
  const ended = turnEvents.some((event) => event.type === 'turn/end')
  const messages = turnEvents.filter((event) => event.type === 'user/message').map((event) => event.data)
  const callId = String(exec?.callId ?? '')
  const calls = turnEvents.filter((event) => event.type === 'tool/call')
  const matchingCalls = calls.filter((event) => event.data?.callId === callId)
  const call = matchingCalls.length === 1 ? matchingCalls[0] : null
  const stepStart = turnEvents.findLast((event) => event.type === 'step/start')
  const step = Number(stepStart?.data?.step)
  const stepEnded = stepStart && turnEvents.some((event) => event.seq > stepStart.seq && event.type === 'step/end')
  const hasResult = turnEvents.some((event) => event.type === 'tool/result'
    && (event.data?.message?.toolCallId ?? event.data?.callId) === callId)
  const matches = !ended && !hasResult && !stepEnded && exec?.agent?.session === session && exec.name === toolName && exec.parent == null
    && callId !== '' && exec.rootCallId === callId && call?.data?.name === toolName && Number(call.data.turn) === turn
    && Number.isSafeInteger(step) && step >= 0 && Number(stepStart?.data?.turn) === turn
    && Number(call.data.step) === step && call.seq > stepStart.seq
    && !turnEvents.some((event) => event.type === 'user/message' && event.seq > call.seq && event.data?.source?.kind !== 'runtime-context')
  return { messages, turn, callId, call, matches }
}

export function classifyProactiveCall(session, exec, store, toolName = 'qq_send') {
  const host = currentHostCall(session, exec, toolName)
  if (!host) return { kind: store.hasSessionRecords(session?.id) ? 'blocked' : 'normal' }
  const tagged = host.messages.filter((message) => proactiveMarker(message) !== '' || store.recordsForSource(session.id, message?.id).length > 0)
  if (tagged.length === 0) {
    const ambiguousNudge = host.messages.some((message) => message?.source?.kind === 'nudge') && store.unresolvedForSession(session.id)
    return { kind: ambiguousNudge || (!host.matches && store.hasSessionRecords(session.id)) ? 'blocked' : 'normal' }
  }
  if (!host.matches || tagged.length !== 1
    || host.messages.filter((message) => message?.source?.kind !== 'runtime-context').length !== 1) return { kind: 'blocked' }
  const message = tagged[0]
  const qq = message?.source?.qq
  const token = proactiveMarker(message)
  const target = { kind: qq?.chatKind, id: qq?.chatId }
  const record = token === '' ? null : store.record(token)
  if (message?.role !== 'user' || message?.source?.kind !== 'nudge' || !validTarget(target)
    || !record || record.sessionId !== String(session.id) || record.sourceMessageId !== String(message.id)
    || record.target.kind !== target.kind || record.target.id !== String(target.id)) return { kind: 'blocked' }
  return { kind: 'verified', attempt: { ...record, turn: host.turn, callId: host.callId, toolCallSeq: host.call.seq } }
}

export function isProactiveTurnClosed(session, record) {
  const events = liveEvents(session)
  if (!events || record.sessionId !== String(session.id)) return false
  let turn
  let foundSource = false
  for (const event of events) {
    if (event.type === 'turn/start') {
      turn = event.data?.turn
      foundSource = false
    } else if (event.type === 'user/message' && String(event.data?.id ?? '') === record.sourceMessageId) {
      foundSource = turn !== undefined
    } else if (event.type === 'turn/end' && event.data?.turn === turn && foundSource) {
      return true
    }
  }
  return false
}

export async function sendWithProactiveReceipt({ store, attempt, parts, sendPart, selectedMaterialIds = [], signal, now = () => Date.now() }) {
  if (!store || !attempt || !Array.isArray(parts) || parts.length === 0 || typeof sendPart !== 'function') {
    return { accepted: false, reason: 'missing-verified-attempt' }
  }
  if (signal?.aborted) return { accepted: false, reason: 'host-call-aborted' }
  const armed = store.markAttempted({ ...attempt, expectedSegments: parts.length, selectedMaterialIds, now: now() })
  if (!armed.accepted) return { accepted: false, reason: armed.reason || 'attempt-not-open' }
  const messageIds = []
  try {
    for (const part of parts) {
      if (signal?.aborted) throw Object.assign(new Error('host call aborted before next QQ part'), { proactiveNotSent: true })
      const receipt = await sendPart(part)
      if (receipt?.muted === true || receipt?.reason) {
        throw Object.assign(new Error(String(receipt.reason || 'QQ sending muted')), { proactiveNotSent: true })
      }
      const messageId = positiveMessageId(receipt?.data?.message_id)
      if (receipt?.retcode !== 0 || (receipt.status != null && receipt.status !== 'ok')
        || receipt.failedParts > 0 || receipt.ok === false || messageId === 0) {
        throw new Error(String(receipt?.reason || 'QQ part receipt missing'))
      }
      messageIds.push(messageId)
      if (!store.appendSegmentReceipt(attempt, messageId)) throw new Error('segment receipt persistence failed')
    }
    const result = store.confirmCompleteAccepted({ ...attempt, ok: true, now: now() }, messageIds)
    if (!result.accepted) throw new Error(result.reason)
    return result
  } catch (error) {
    const reason = String(error?.message ?? error).slice(0, 180)
    const rejected = messageIds.length === 0 && error?.code === 'ONEBOT_DELIVERY_REJECTED'
    const notSent = messageIds.length === 0 && error?.proactiveNotSent === true
    const at = now()
    store.recordCurrent(attempt.token, {
      status: rejected ? 'rejected' : notSent ? 'not-sent' : 'unknown',
      ...(rejected || notSent ? { finishedAt: at, cooldownUntil: at + (Number(store.record(attempt.token)?.cooldownMs) || 0) } : { unknownAt: at }),
      failureReason: reason,
    })
    return { accepted: false, unknown: !rejected && !notSent, messageIds, reason }
  }
}
