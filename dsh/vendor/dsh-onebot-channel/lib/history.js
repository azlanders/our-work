/**
 * history.js —— 消息历史检索（群 + 好友）。
 *
 * ⚠️ 范围说明：这里**只做「读历史」**，不做群信息检索（get_group_info 之类）、
 * 也不做撤回（delete_msg）、也不做表情回应 —— 这三项是 C 档，用户明确排除。
 *
 * 协议端参数（实测 SnowLuma 2.2.0）：
 *   get_group_msg_history  { group_id(必填,>=1), message_id(默认0), count(默认20), reverse_order(默认true) }
 *   get_friend_msg_history { user_id(必填,>=1),  message_id(默认0), count(默认20), reverse_order(默认true) }
 *   → { retcode:0, data:{ messages:[ { time, message_id, message_seq, user_id, group_id,
 *                                  message:[段], raw_message, sender:{nickname,card,role} } ] } }
 *
 * 注意 message_id 可能是负数（SnowLuma 的真实行为），所以做锚点比较要用绝对值比较大小，
 * 不能直接比大小。
 */
import { callOneBot } from './onebot.js'
import { textOf } from './onebot.js'
import { getConfig } from './config.js'

/** 协议端返回的一条消息 → 内部统一形状。 */
function normMessage(item, kind) {
  const segments = Array.isArray(item?.message) ? item.message : []
  const sender = item?.sender ?? {}
  return {
    kind,
    time: Number(item?.time ?? 0),
    messageId: Number(item?.message_id ?? 0),
    messageSeq: Number(item?.message_seq ?? 0),
    userId: String(item?.user_id ?? '').trim(),
    groupId: kind === 'group' ? String(item?.group_id ?? '').trim() : '',
    nickname: String(sender?.nickname ?? '').trim(),
    card: String(sender?.card ?? '').trim(),
    role: String(sender?.role ?? '').trim(),
    text: textOf(segments),
    segments
  }
}

/**
 * 拉群消息历史。
 *
 * @param {string|number} groupId 群号
 * @param {number} count 条数（默认 20，上限 100 —— 协议端也是这个量级）
 * @param {number} [beforeMessageId] 只取这条消息之前的（锚点）
 */
export async function getGroupHistory(groupId, count = 20, beforeMessageId = 0) {
  const gid = Number(groupId)
  if (!Number.isSafeInteger(gid) || gid <= 0) throw new Error(`群号不合法：${String(groupId)}`)
  const params = {
    group_id: gid,
    count: Math.min(100, Math.max(1, Number(count) || 20)),
    message_id: Number(beforeMessageId) || 0
  }
  const result = await callOneBot({ action: 'get_group_msg_history', params })
  if (result?.retcode !== 0) {
    throw new Error(`拉群消息历史失败：retcode=${result?.retcode} ${result?.wording ?? result?.message ?? ''}`)
  }
  const list = Array.isArray(result?.data?.messages) ? result.data.messages : []
  return enrichReplies(list.map((item) => normMessage(item, 'group')))
}

/**
 * 拉好友（私聊）消息历史。
 *
 * @param {string|number} userId 对方 QQ 号
 * @param {number} count 条数
 * @param {number} [beforeMessageId] 锚点
 */
export async function getFriendHistory(userId, count = 20, beforeMessageId = 0) {
  const uid = Number(userId)
  if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`QQ 号不合法：${String(userId)}`)
  const params = {
    user_id: uid,
    count: Math.min(100, Math.max(1, Number(count) || 20)),
    message_id: Number(beforeMessageId) || 0
  }
  const result = await callOneBot({ action: 'get_friend_msg_history', params })
  if (result?.retcode !== 0) {
    throw new Error(`拉好友消息历史失败：retcode=${result?.retcode} ${result?.wording ?? result?.message ?? ''}`)
  }
  const list = Array.isArray(result?.data?.messages) ? result.data.messages : []
  return enrichReplies(list.map((item) => normMessage(item, 'private')))
}

/**
 * 统一入口：传了群号拉群历史，否则拉好友历史。
 */
export async function getHistory(target, count = 20, beforeMessageId = 0) {
  const kind = String(target?.kind ?? '').trim()
  if (kind === 'group') return getGroupHistory(target?.id, count, beforeMessageId)
  return getFriendHistory(target?.id, count, beforeMessageId)
}


async function enrichReplies(list) {
  const byId = new Map()
  for (const m of list) {
    if (m.messageId) byId.set(String(m.messageId), m)
    if (m.messageSeq) byId.set(String(m.messageSeq), m)
  }
  for (const m of list) {
    const replySeg = (m.segments || []).find((s) => s?.type === 'reply')
    const rid = String(replySeg?.data?.id ?? replySeg?.data?.message_id ?? '').trim()
    if (!rid) continue
    let qWho = '', qBody = ''
    // QUOTE_SELF 2026-11-15（批次504）：引用的是她自己时写「你自己」。
    // 原来只写昵称「大肥鱼」，她查历史时认不出那是自己发的，会把话当成别人说的。
    const selfUin = String(getConfig().selfUin ?? '')
    let qSelf = false
    const localHit = byId.get(rid)
    if (localHit) {
      qSelf = selfUin !== '' && String(localHit.userId ?? '') === selfUin
      qWho = qSelf ? '你自己' : (localHit.card || localHit.nickname || localHit.userId || '')
      qBody = String(localHit.text || '').replace(/^\[回复[^\]]*\]\s*/, '').trim()
    } else if (/^-?\d+$/.test(rid)) {
      try {
        const r = await callOneBot({ action: 'get_msg', params: { message_id: Number(rid) } })
        if (r?.retcode === 0 && r?.data) {
          const qm = r.data
          qSelf = selfUin !== '' && String(qm.sender?.user_id ?? '') === selfUin
          qWho = qSelf ? '你自己' : String(qm.sender?.card || qm.sender?.nickname || qm.sender?.user_id || '').trim()
          qBody = textOf(Array.isArray(qm.message) ? qm.message : []).replace(/^\[回复[^\]]*\]\s*/, '').trim()
        }
      } catch (_err) { console.error('[onebot:history]', _err?.message || _err) }
    }
    if (qBody !== '' || qWho !== '') {
      const snippet = (qBody || '[媒体消息]').slice(0, 80)
      const tag = qSelf
        ? `[回复 你自己：「${snippet}」（这是你发的）] `
        : `[回复${qWho ? ' ' + qWho : ''}：「${snippet}」] `
      m.text = m.text.includes('[回复]') ? m.text.replace('[回复]', tag) : (tag + m.text)
    }
  }
  return list
}
