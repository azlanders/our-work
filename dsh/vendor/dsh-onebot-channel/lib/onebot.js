/**
 * onebot.js —— OneBot HTTP 调用 + 消息段解析。
 */
import { getConfig } from './config.js'
import { note } from './env.js'
import { emojiTextOf } from './emoticons.js'
import { assertNotBlocked } from './blocked.js'
import { assertSendAllowed } from './allowlist.js'
import { sendTargetOf } from './allowlist-rules.js'
import { setTimeout as delay } from 'node:timers/promises'
import { HUMAN_PART_GAP_MIN_MS } from './split.js'

const 发送节奏 = new Map()

function 发送目标键(payload) {
  if (!['send_group_msg', 'send_private_msg'].includes(payload?.action)) return ''
  const target = sendTargetOf(payload.action, payload.params)
  return target?.id ? `${target.kind}:${target.id}` : ''
}

async function 按目标间隔发送(key, send) {
  if (key === '') return send()
  const state = 发送节奏.get(key) ?? { tail: null, lastAt: -Infinity }
  发送节奏.set(key, state)
  const previous = state.tail
  let release
  const current = new Promise((resolve) => { release = resolve })
  state.tail = current
  if (previous) await previous
  try {
    while (performance.now() - state.lastAt < HUMAN_PART_GAP_MIN_MS) {
      await delay(Math.max(1, Math.ceil(HUMAN_PART_GAP_MIN_MS - (performance.now() - state.lastAt))))
    }
    const receipt = await send()
    if (receipt?.retcode === 0) state.lastAt = performance.now()
    return receipt
  } finally {
    release()
    if (state.tail === current) {
      setTimeout(() => {
        if (state.tail === current) 发送节奏.delete(key)
      }, HUMAN_PART_GAP_MIN_MS).unref()
    }
  }
}

export async function callOneBot(payload, { beforeSend } = {}) {
  const config = getConfig()
  // 封禁检查放在最前面，在发 HTTP 之前 —— 这是所有协议端调用的唯一出口，
  // 放这里才能保证「不管谁调、调几次」都绕不过去。
  assertNotBlocked(payload?.action)
  // 出站目标白名单，同样挂在唯一出口上（2026-10-28）：
  //   qq_send 的 user_id / group_id 是 agent 随便填的，只有在这一层拦，
  //   才能覆盖 qq_send / 自动转发 / sendapi / 收藏表情所有路径。
  //   不合法直接抛错 → 上层翻成工具错误给 agent 看，HTTP 根本不会发出去。
  assertSendAllowed(payload?.action, payload?.params)
  // 必须带超时：SnowLuma 的历史接口会突然挂死（实测 >20 秒不回），
  // 没有超时的话轮询会永久卡在这一句，后面永远不再拉消息。
  const timeoutMs = Math.max(1000, Number(config.requestTimeoutMs) || 8000)
  return 按目标间隔发送(发送目标键(payload), async () => {
    if (typeof beforeSend === 'function' && beforeSend() !== true) {
      throw Object.assign(new Error('主动搭话已取消，未调用协议端'), { proactiveNotSent: true })
    }
    const response = await fetch(config.onebotHttp, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs)
    })
    if (!response.ok) throw new Error(`OneBot HTTP ${response.status}`)
    return await response.json()
  })
}

export const DELIVERY_REJECTED = 'ONEBOT_DELIVERY_REJECTED'

function messageIdOf(receipt) {
  for (const raw of [receipt.data?.message_id, receipt.data?.message_id_str, receipt.message_id, receipt.message_id_str]) {
    if (typeof raw !== 'number' && !(typeof raw === 'string' && /^-?\d+$/.test(raw.trim()))) continue
    const messageId = Number(raw)
    if (Number.isSafeInteger(messageId) && messageId !== 0) return messageId
  }
  return 0
}

export async function deliverOneBot(payload, options) {
  const receipt = await callOneBot(payload, options)
  const retcode = receipt?.retcode
  const status = receipt?.status
  if (Number.isInteger(retcode) && retcode !== 0 && retcode !== 1 && status !== 'async') {
    const detail = String(receipt.wording || receipt.message || '').slice(0, 180)
    throw Object.assign(new Error(`协议端拒绝发送（retcode=${retcode}）${detail ? '：' + detail : ''}`), { code: DELIVERY_REJECTED })
  }
  if (retcode !== 0 || (status && status !== 'ok')) throw new Error('协议端未确认投递结果')

  const messageId = messageIdOf(receipt)
  if (messageId !== 0) return { ...receipt, data: { ...receipt.data, message_id: messageId } }
  if (payload.action === 'upload_private_file' || payload.action === 'upload_group_file') return receipt
  throw new Error('协议端缺少有效 message_id，送达未确认')
}

/** 拉好友或群列表（拿昵称/群名，用于 UI 显示和自动命名）。 */
export async function oneBotList(action, idKey, nameKey) {
  try {
    const result = await callOneBot({ action })
    if (result?.retcode !== 0) return []
    return (result.data ?? [])
      .map((item) => ({ id: String(item?.[idKey] ?? ''), name: String(item?.[nameKey] ?? '') }))
      .filter((item) => item.id !== '')
  } catch (error) {
    note('api', `${action} failed: ${error instanceof Error ? error.message : error}`)
    return []
  }
}

/**
 * 没专门处理的段类型，给个中文标签。
 * 直接渲染原始类型名（[forward]、[record]）的话，agent 看到的是协议字段不是人话；
 * 但也别瞎猜内容 —— 只做类型翻译，内容一概不展开。
 */
const SEGMENT_LABELS = {
  forward: '[转发消息]',
  record: '[语音]',
  video: '[视频]',
  file: '[文件]',
  location: '[位置]',
  json: '[卡片消息]',
  xml: '[卡片消息]',
  share: '[分享链接]',
  contact: '[名片]',
  music: '[音乐]',
  poke: '[戳一戳]',
  gift: '[礼物]',
  markdown: '',
  node: '',
  grayTip: ''
}

function segmentTypeName(type) {
  const key = String(type ?? '')
  if (key === '') return '[未知段]'
  if (key in SEGMENT_LABELS) return SEGMENT_LABELS[key]
  return `[${key}]`
}

/** message 段数组 → 纯文本；@ 保留成 @qq，方便我在会话里看出是谁被叫。 */
/** 从 QQ 卡片段里抠出标题与跳转链接；抠不到就退化成一个可读标签。 */
function 卡片文本(segment) {
  try {
    const raw = String(segment?.data?.data ?? segment?.data?.content ?? '')
    if (!raw) return '[卡片消息]'
    const o = JSON.parse(raw)
    const meta = o?.meta || {}
    const detail = meta.detail_1 || meta.detail_4 || meta.news || meta.news_1 || {}
    const title = String(detail.title || detail.desc || meta.news?.title || '').slice(0, 60)
    const url = String(detail.qqdocurl || detail.jumpUrl || detail.url || meta.news?.jumpUrl || '')
    if (title && url) return `[卡片：${title} ${url}]`
    if (title) return `[卡片：${title}]`
    if (url) return `[卡片 ${url}]`
    return '[卡片消息]'
  } catch {
    return '[卡片消息]'
  }
}
export function textOf(message, resolveName) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message)) return ''
  return message
    .map((segment) => {
      switch (segment?.type) {
        case 'text':
          return String(segment?.data?.text ?? '')
        case 'at': {
          const qq = String(segment?.data?.qq ?? '')
          if (qq === 'all') return '@全体成员'
          // NAME_AT 2026-11-05：能拿到昵称就显示昵称，别让她对着一串 QQ 号猜是谁
          const name = typeof resolveName === 'function' ? String(resolveName(qq) ?? '') : ''
          return name !== '' ? `@${name}` : `@${qq}`
        }
        case 'image':
          return '[图片]'
        case 'face':
        case 'mface':
          // 表情交给 emoticons.js 渲染：经典表情查中文名，商城大表情报 summary。
          // 不在 switch 里直接写死，是因为 mface 的字段名和 face 完全不同。
          return emojiTextOf(segment)
        case 'json':
        case 'xml':
          // CARD_TEXT 2026-11-06：QQ 卡片（B站视频/公众号/小程序）原来只变成「[卡片消息]」，
          // 标题和链接全丢了，她当然「看不了卡片」。这里把标题与跳转链接抽出来。
          return 卡片文本(segment)
        case 'reply':
          // REPLY_MARK 2026-11-05：原来返回 ''，她分不清「新话题」和「回复我之前的话」。
          // 只标一句，不把被回复内容塞进来（那会重复一遍原文）。
          return '[回复]'
        default:
          return segmentTypeName(segment?.type)
      }
    })
    .join('')
    .trim()
}

/** 这条群消息有没有 @ 到本号。 */
export function isAtMe(message, selfUin) {
  if (!Array.isArray(message)) return false
  return message.some((segment) => segment?.type === 'at' && String(segment?.data?.qq ?? '') === String(selfUin))
}

/**
 * 消息的单调序号。
 *
 * 2026-11-01 小肥鱼改：实测同一群最近八条，message_id / message_seq 完全不单调
 * （633202974 → 2021824317 → 1469001392 …），只有 real_seq 是 5334/5335/5336 这样连续走的。
 * 所以判新旧一律用 real_seq；没有 real_seq 的（私聊老事件）退回 message_seq。
 */
export function seqOf(message) {
  const real = Number(message?.real_seq)
  if (Number.isFinite(real) && real > 0) return real
  const value = Number(message?.message_seq)
  // 2026-11-04 修：message_seq === 0 也是「number」，原来会被当成有效游标返回 0。
  // 群路径拿 0 去比 seq <= lastSeq 恒真 → 这条消息被当旧的直接吞掉。0 一律当没有。
  return Number.isFinite(value) && value !== 0 ? value : null
}

export function timeOf(message) {
  return Number(message?.time) || 0
}

export function qqTimeMs(value) {
  const timestamp = Number(value)
  if (!Number.isFinite(timestamp) || timestamp <= 0) return 0
  const millis = timestamp > 1e12 ? timestamp : timestamp * 1000
  return millis < 8.64e15 - 8 * 3600e3 ? millis : 0
}

export function originalTextOf(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  return message
    .filter((segment) => segment?.type === 'text' && typeof segment.data?.text === 'string')
    .map((segment) => segment.data.text)
    .join('')
    .trim()
}

export function 读QQ原话批次(messages) {
  return messages.map((message) => ({
    text: originalTextOf(message?.message ?? message?.segments),
    at: qqTimeMs(message?.time),
  }))
}
