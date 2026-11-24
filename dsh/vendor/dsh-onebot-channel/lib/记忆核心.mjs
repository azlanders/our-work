/** 肥鱼记忆的回合契约。OneBot、ROFM 和海马体共用这份判定，数据由原提供方管理。 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getConfig } from './config.js'
import { DATA_DIR } from './env.js'

const QQ号 = (值) => (typeof 值 === 'string' || Number.isSafeInteger(值)) && /^[1-9]\d{0,11}$/.test(String(值)) ? String(值) : ''
const 绑定目录 = join(DATA_DIR, 'fish-qq-memory-v1')
const 最近可信投递 = new WeakMap()
const 私聊入站 = new WeakSet()
const 消息正文 = (msg) => typeof msg?.content === 'string' ? msg.content : (Array.isArray(msg?.content)
  ? msg.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n') : '')
const 发言消息 = (msg) => msg?.role === 'user' && msg.source?.kind !== 'runtime-context' && msg.source?.kind !== 'compact-checkpoint' && msg.source?.kind !== 'spine-checkpoint'
const 初始化事件 = new Set(['permission/preset', 'sandbox/mode', 'approval/policy'])
const 收据令牌 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function 同范围历史(msg, key) {
  if (!发言消息(msg) || msg.source?.kind === 'repeat-tool-reminder' || QQ消息键(msg) === key) return true
  const qq = msg?.source?.qq
  if (msg.source?.kind === 'nudge' && QQ聊天键(qq?.chatKind, qq?.chatId) === key) {
    if (typeof qq.proactiveReceiptToken === 'string' && 收据令牌.test(qq.proactiveReceiptToken)) return true
    // LEGACY_NUDGE 2026-11-23: 2026-11-21 之前的主动搭话没有回执 token 字段
    return qq.proactiveReceiptToken === undefined
  }
  if (msg.source?.kind === 'user' && !msg.source?.qq && 消息正文(msg).trim().startsWith('/')) return true
  if (!msg.source && 消息正文(msg).trim().startsWith('Perform a web search for the query:')) return true
  return false
}

function 无旧事件(session) {
  const seq = Number(session.seq)
  if (seq === 0) return true
  if (!Number.isSafeInteger(seq) || seq < 0) return false
  const events = session.snapshotEvents?.()
  return Array.isArray(events) && events.length === seq && events.every((event) => 初始化事件.has(event?.type)
    || (event?.type === 'session/end-seed' && event.data && Object.keys(event.data).length === 0))
}

export function 可首次绑定的空会话(session, messages = session?.deriveMessages?.()) {
  return !!session && !session.header?.isSeeded && Array.isArray(messages) && messages.length === 0 && 无旧事件(session)
}

export function QQ聊天键(kind, id) {
  const 号码 = QQ号(id)
  return 号码 && (kind === 'private' || kind === 'group') ? `${kind}-${号码}` : ''
}

function 会话路由(sessionId, config) {
  if (typeof sessionId !== 'string' || !sessionId) return []
  const 裸会话号 = (value) => value.replace(/^session-/, '')
  return ['private', 'group'].flatMap((kind) => Object.entries(config?.routes?.[kind] ?? {})
    .filter(([, route]) => typeof route?.sessionId === 'string' && 裸会话号(route.sessionId) === 裸会话号(sessionId))
    .map(([id, route]) => route.sessionId === sessionId ? QQ聊天键(kind, id) : ''))
}

function 是退役会话(id, config) {
  const retired = config?.memoryRetiredSessions
  if (retired === undefined) return false
  if (!Array.isArray(retired)) return true
  const 去前缀 = (value) => value.replace(/^session-/, '')
  return retired.some((saved) => typeof saved === 'string' && 去前缀(saved) === 去前缀(id))
}

function 绑定路径(id) {
  return join(绑定目录, `${createHash('sha256').update(id).digest('hex')}.txt`)
}

function 读绑定(id) {
  try { return readFileSync(绑定路径(id), 'utf8') }
  catch (error) { return error?.code === 'ENOENT' ? null : '' }
}

/** 仅桥可建立绑定。未审计的旧会话不可自动继承；独占路由移走后也不能换绑。 */
export function 绑定QQ会话(session, target, config = getConfig()) {
  const id = session?.id
  const key = QQ聊天键(target?.kind, target?.id)
  const routes = 会话路由(id, config)
  if (!key || routes.length !== 1 || routes[0] !== key || config.fallbackToLiveSession !== false || 是退役会话(id, config)) return false
  try {
    const messages = session.deriveMessages()
    if (!Array.isArray(messages)) return false
    const bound = 读绑定(id)
    if (bound !== null) return bound === key && messages.every((msg) => 同范围历史(msg, key))
    if (!可首次绑定的空会话(session, messages)) return false
    mkdirSync(绑定目录, { recursive: true, mode: 0o700 })
    try { writeFileSync(绑定路径(id), key, { flag: 'wx', mode: 0o600 }) }
    catch (error) { if (error?.code !== 'EEXIST') return false }
    return 读绑定(id) === key
  } catch { return false }
}

export function QQ记忆来源(target, senderId, queryText, lifeHit = false) {
  const chatKind = target?.kind
  const chatId = QQ号(target?.id)
  if (!chatId || (chatKind !== 'private' && chatKind !== 'group')) return null
  return {
    chatKind,
    chatId,
    senderId: chatKind === 'private' ? chatId : QQ号(senderId),
    queryText: typeof queryText === 'string' ? queryText.trim().slice(0, 6000).toWellFormed() : '',
    lifeHit: chatKind === 'private' && lifeHit === true,
  }
}

export function 投递QQ记忆来源(session, sessionId, target, options, config = getConfig()) {
  const incoming = options?.memorySource
  const kind = target?.kind
  const id = QQ号(target?.id)
  if (!id || !incoming || incoming.chatKind !== kind || QQ号(incoming.chatId) !== id
    || (kind !== 'private' && kind !== 'group') || typeof incoming.queryText !== 'string'
    || (options.sourceKind !== undefined && options.sourceKind !== 'user') || options.proactive === true
    || session?.id !== sessionId || config.fallbackToLiveSession !== false || 是退役会话(sessionId, config)) return null
  const senderId = QQ号(incoming.senderId)
  if (!senderId || (kind === 'private' ? senderId !== id : senderId !== QQ号(options.voicePeer))) return null
  const routes = 会话路由(sessionId, config)
  if (routes.length !== 1 || routes[0] !== QQ聊天键(kind, id)) return null
  return QQ记忆来源({ kind, id }, senderId, incoming.queryText, options.lifeMemoryHit === true)
}

export function 可继续旧私聊(session, source, config) {
  const legacy = config.legacyPrivateChat
  if (source?.chatKind !== 'private' || legacy?.chatId !== source.chatId || legacy.sessionId !== session.id
    || 主人专属会话({ kind: 'private', id: source.chatId }, config) !== session.id
    || session.header?.isSeeded !== false || session.header.delegationDepth > 0 || 读绑定(session.id) !== null) return false
  return session.deriveMessages().every((message) => !发言消息(message)
    || (message.source?.kind === 'user' && !Object.hasOwn(message.source, 'qq'))
    || 同范围历史(message, QQ聊天键('private', source.chatId)))
}

export function 标记QQ私聊入站(source) {
  if (source) 私聊入站.add(source)
  return source
}

export function 登记QQ来源投递(session, message, { bound, incoming, config }) {
  const source = message.source.qq
  if (!bound && (config.enableLegacyPrivateKnowledgeLookup !== true || !私聊入站.delete(incoming))) return
  最近可信投递.set(session, { id: message.id, source: { ...source }, fromSeq: session.seq, bound })
}

export function 召回输入(message, text = '') {
  const qq = message?.source?.qq
  const 已知QQ = Object.hasOwn(message?.source ?? {}, 'qq') || text.trimStart().startsWith('（你现在的状态：本批投递时间 ')
  if (!已知QQ) return { channel: 'other', query: text }
  const 来源 = QQ消息键(message) ? QQ记忆来源({ kind: qq.chatKind, id: qq.chatId }, qq.senderId, qq.queryText, qq.lifeHit) : null
  return { channel: 'qq', query: 来源?.queryText.slice(0, 1200).toWellFormed() ?? '', target: 来源 }
}

function QQ消息键(message) {
  const source = message?.source
  const qq = source?.qq
  if (!['user', 'nudge'].includes(source?.kind) || typeof qq?.queryText !== 'string') return ''
  if (qq.chatKind === 'private' && qq.senderId != null && QQ号(qq.senderId) !== QQ号(qq.chatId)) return ''
  if (qq.chatKind === 'group' && qq.senderId != null && qq.senderId !== '' && !QQ号(qq.senderId)) return ''
  return QQ聊天键(qq.chatKind, qq.chatId)
}

/** QQ 必须同时符合当前路由、持久绑定和本轮来源。独立 Web 走不同的新库；不读旧共库。 */
export function 记忆范围(session, incoming, config = getConfig()) {
  const id = session?.id
  if (typeof id !== 'string' || !id || 是退役会话(id, config)) return null
  try {
    const routes = 会话路由(id, config)
    const bound = 读绑定(id)
    const rawMessages = session.deriveMessages?.()
    const messages = Array.isArray(rawMessages) ? rawMessages : []
    const msg = incoming ?? messages.findLast(发言消息)
    if (routes.length || bound !== null) {
      if (!Array.isArray(rawMessages)) return null
      const key = QQ消息键(msg)
      if (!key || key !== bound || routes.length !== 1 || routes[0] !== key || config.fallbackToLiveSession !== false) return null
      if (!messages.every((item) => 同范围历史(item, key))) return null
      return { channel: 'qq', key, target: 召回输入(msg).target }
    }
    if (/^(?:onebot-|qqb-)/i.test(id) || [...messages, msg].some((item) => 发言消息(item)
      && (item.source?.kind === 'relay' || 召回输入(item, 消息正文(item)).channel === 'qq'))) return null
    return { channel: 'web', key: createHash('sha256').update(id).digest('hex') }
  } catch { return null }
}

export function 自动召回提供方(input) {
  if (!input.query) return []
  if (input.channel !== 'qq') return ['rofm', 'hippocampus']
  return !input.target || input.target.lifeHit ? [] : ['rofm']
}

export function QQ允许原生记忆工具(name) {
  return (name === 'recall' || name === 'trace') && getConfig().工具白名单?.includes(name) === true
}

const 查询提供方 = new Map()

export function 注册记忆查询(name, execute) {
  查询提供方.set(name, execute)
  return () => {
    if (查询提供方.get(name) === execute) 查询提供方.delete(name)
  }
}

export async function 查询记忆提供方(name, args, exec) {
  return 查询提供方.get(name)?.(args, exec)
}

export function 生活记忆角色(target, config) {
  const 主人 = QQ号(config?.ownerUin ?? config?.peerUin)
  return 主人 && target?.kind === 'private' && QQ号(target.id) === 主人 ? 'owner' : 'guest'
}

export function 主人专属会话(target, config) {
  if (生活记忆角色(target, config) !== 'owner') return ''
  const sessionId = config?.routes?.private?.[target.id]?.sessionId
  if (!sessionId || config.fallbackToLiveSession !== false) return ''
  return 会话路由(sessionId, config).length === 1 ? sessionId : ''
}

export function 工具回合角色(session, config) {
  const target = 记忆范围(session, undefined, config)?.target
  return 生活记忆角色({ kind: target?.chatKind, id: target?.chatId }, config)
}

export function B站主人查询授权({ sessionId, exec } = {}, agents, config = getConfig()) {
  const tool = 'bili_humanism_lookup_review'
  const agent = exec?.agent
  const session = agent?.session
  if (config?.enableKnowledgeReviewLookup !== true || !Array.isArray(config.工具白名单)
    || !config.工具白名单.includes(tool) || exec?.name !== tool || exec.parent !== undefined
    || typeof exec.callId !== 'string' || !exec.callId || exec.rootCallId !== exec.callId
    || exec.signal?.aborted !== false || typeof exec.token !== 'symbol' || session?.id !== sessionId
    || typeof sessionId !== 'string' || !sessionId) return null
  try {
    if (agents?.get?.(sessionId) !== agent || session.header?.isSeeded || !Number.isSafeInteger(session.seq)) return null
    const end = session.seq
    const events = session.snapshotEvents(Math.max(0, end - 512), end)
    if (!Array.isArray(events)) return null
    const start = events.findLastIndex((event) => event?.type === 'turn/start' || event?.type === 'turn/end')
    const startEvent = events[start]
    const turn = startEvent?.data?.turn
    if (startEvent?.type !== 'turn/start' || !Number.isSafeInteger(turn) || turn < 1 || !session.isOwnSeq(startEvent.seq)) return null
    const inTurn = events.slice(start + 1)
    const stepEvent = inTurn.findLast((event) => event?.type === 'step/start' || event?.type === 'step/end')
    const step = stepEvent?.data?.step
    if (stepEvent?.type !== 'step/start' || stepEvent.data.turn !== turn || !session.isOwnSeq(stepEvent.seq)
      || !Number.isSafeInteger(step) || step < 0) return null
    const inputs = inTurn.filter((event) => event?.type === 'user/message' && 发言消息(event.data))
    const calls = inTurn.filter((event) => event?.type === 'tool/call' && event.data?.callId === exec.callId)
    if (inputs.length !== 1 || calls.length !== 1) return null
    const [input] = inputs
    const [call] = calls
    if (!session.isOwnSeq(input.seq) || !session.isOwnSeq(call.seq) || input.seq >= call.seq || stepEvent.seq >= call.seq
      || call.data.name !== tool || call.data.turn !== turn || call.data.step !== step
      || inTurn.some((event) => event?.type === 'tool/result' && event.data?.message?.toolCallId === exec.callId)) return null
    const message = input.data
    const source = message?.source?.qq
    const chatId = QQ号(source?.chatId)
    if (message?.role !== 'user' || message.source?.kind !== 'user' || source?.chatKind !== 'private'
      || !chatId || QQ号(source.senderId) !== chatId || typeof source.queryText !== 'string' || !source.queryText.trim()) return null
    const 入站 = 最近可信投递.get(session)
    if (!入站 || typeof message.id !== 'string' || message.id !== 入站.id
      || Object.keys(入站.source).some((key) => source[key] !== 入站.source[key])) return null
    const first = session.snapshotEvents(入站.fromSeq, input.seq + 1)
      .find((event) => event.type === 'user/message' && event.data.id === 入站.id)
    if (first?.seq !== input.seq) return null
    const target = { kind: 'private', id: chatId }
    if (主人专属会话(target, config) !== sessionId) return null
    if (入站.bound ? 记忆范围(session, message, config)?.key !== QQ聊天键(target.kind, target.id)
      : config.enableLegacyPrivateKnowledgeLookup !== true || !可继续旧私聊(session, source, config)) return null
    return { sessionId, chatKind: 'private', chatId, role: 'owner', turnId: `${sessionId}:${turn}`, callId: exec.callId }
  } catch {
    return null
  }
}
