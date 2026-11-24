/**
 * phone.mjs —— 「她闲着才偶尔看手机，在做事就得 @ 才叫得出来」（批次95）
 *
 * 主人原话：「她闲着的时候会偶尔看手机来看消息，如果在做事就需要 @ 来把她 @ 出来，
 * 这样子还能省点 token。」
 *
 * 为什么需要这个：普通群消息只有看手机节流放行时才会进入完整回合；显式叫起仍可立即打断。
 * 轮询/WS 两条通路都使用同一闸门，持续窗口只对同群同人短时开放并有轮数上限。
 *
 * 判据三层，每层都能对着状态说出理由：
 *   1. 被叫了（@ / 喊名字 / 紧急词 / 戳一戳）—— 主人不在豁免名单里，跟群友一样（批次235）
 *      → 一定出来。「叫得出来」这条不能破，否则这个功能就是把人关起来。
 *   2. 她在做事（自主.json 的 state 是具体动作，或者睡着）→ 不看手机。
 *   3. 她闲着 → 隔一会儿看一次。间隔按群独立、随机 phoneLookMin~phoneLookMax 分钟，
 *      免得冷清群的消息永远抢不过热闹群。
 *
 * 「忙不忙」跟面板上那个「状态词」是同一套判据：doneAt 过了 3 分钟就算做完了；
 * 发呆/摸鱼/闲着/待命 不算在做事。两边要是判得不一样，就会出现「面板说她闲着、
 * 群里却怎么喊都不理」这种说不清的事。
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'

// 测试用：QQ_AUTONOMY_MEM 指到临时目录、QQ_PHONE_FILE 指到临时文件，就能整段真跑
const 自主文件 = process.env.QQ_AUTONOMY_MEM
  ? String(process.env.QQ_AUTONOMY_MEM).replace(/\/+$/, '') + '/自主.json'
  : `${QQ_WS}/记忆/自主.json`
const 手机文件 = process.env.QQ_PHONE_FILE || '{{DSH_ROOT}}/qq-phone.json'

// 这些不是「在做事」—— 她本来就闲着，闲着才会想起看手机
const 闲词 = /^(发呆|摸鱼|闲着|待命|闲着没事|闲着发呆|没事干)$/
const 做完就算完 = 3 * 60e3
const 默认持续上限 = 4
const 默认群每小时看手机上限 = 6
const 结束词 = /^(好|好的|行|嗯|嗯嗯|知道了|明白了|先这样|就这样|回头聊|晚点聊|不用回|没事了|结束了)[。！!？?，, ]*$/

// 缓存按 mtime 走：自主.json 一变就重读，没变就不碰磁盘。
// 不用「每 N 秒有效」那套 —— 那样改完状态要等一秒才生效，测试也得 sleep。
// 不做缓存。
// 试过两版：只看 mtime（同一毫秒两次写会读到上一份）、mtime+size（「发呆」和「打工」
// 字节数一样，照样撞）、再压一秒上限 —— 测试还是偶发读到旧状态。
// 实际调用频率是「一条群消息一次」，一天几百次，读个几百字节的文件根本不值得缓存。
// 少一层缓存就少一种「面板说她闲着、群里却不理人」的怪事。
export function 读自主() {
  try { return JSON.parse(readFileSync(自主文件, 'utf8')) } catch { return {} }
}

/**
 * 她在忙什么？
 * @returns {string} 空字符串 = 闲着；否则是动作名（「看B站」「睡着了」），能直接拼进日志
 */
export function 她在忙(aut, now = Date.now()) {
  const 完 = Number(aut?.doneAt || 0)
  if (完 > 0 && now - 完 > 做完就算完) return ''
  const s = String(aut?.state || '').trim()
  if (s === '') return ''
  if (/睡/.test(s)) return '睡着了'
  if (闲词.test(s)) return ''
  return s
}

function 读手机() {
  try {
    const v = JSON.parse(readFileSync(手机文件, 'utf8'))
    if (!v || typeof v !== 'object') return { groups: {}, lookTimes: [] }
    if (!v.groups || typeof v.groups !== 'object') v.groups = {}
    if (!Array.isArray(v.lookTimes)) v.lookTimes = []
    return v
  } catch { return { groups: {}, lookTimes: [] } }
}

function 写手机(v) {
  try {
    const tmp = 手机文件 + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(v, null, 2))
    renameSync(tmp, 手机文件)
    return true
  } catch {
    // 写失败时普通消息不进入完整回合；显式叫起不依赖这个节流状态。
    return false
  }
}

function 持续上限(config) {
  const c = config || {}
  return {
    idleMs: Math.min(3, Math.max(0, Number(c.phoneThreadMin ?? 3))) * 60e3,
    replies: Math.min(默认持续上限, Math.max(0, Math.floor(Number(c.phoneThreadMax ?? 默认持续上限)))),
    durationMs: Math.min(10, Math.max(1, Number(c.phoneThreadMaxDurationMin ?? 10))) * 60e3,
  }
}

/** 同群同发送者的有限续接窗口；空闲、总时长、轮数任一超限就关闭。 */
export function 是持续对话(groupId, senderUin, now = Date.now(), config = {}) {
  const 群 = String(groupId ?? '')
  const 人 = String(senderUin ?? '')
  if (群 === '' || 人 === '') return false
  const 这 = 读手机().groups[群] || {}
  const 上限 = 持续上限(config)
  const 开始 = Number(这.threadStartedAt || 0)
  const 最近 = Number(这.lastReplyAt || 0)
  return String(这.lastReplyFrom ?? '') === 人
    && 开始 > 0 && 最近 > 0
    && now >= 最近 && now - 最近 < 上限.idleMs
    && now >= 开始 && now - 开始 < 上限.durationMs
    && Number(这.threadReplies || 0) < 上限.replies
}

/**
 * 这条群消息要不要投给她。显式叫起直接放行；普通消息必须过看手机节流。
 * 续接只在同群同发送者的短窗口内有效，睡着或忙碌时不能续。
 */
export function 看手机(config, opt = {}, now = Date.now()) {
  const c = config || {}
  const 群 = String(opt.groupId ?? '')
  const 人 = String(opt.senderUin ?? '')
  const st = 读手机()
  const 这 = st.groups[群] || {}
  const 同一人 = 人 !== '' && String(这.lastReplyFrom ?? '') === 人
  const 收尾词 = /^(?:(?:好|好的|行|嗯|嗯嗯)[，, ]*)?(?:知道了|明白了|先这样|就这样|回头聊|晚点聊|不用回|没事了|结束了|我先走了)[。！!？?，, ]*$|^(?:好|好的|行|嗯|嗯嗯)[。！!？? ]*$/.test(String(opt.text ?? '').trim())
  const 显式叫起 = Boolean(opt.poke || opt.urgent || opt.atMe || opt.named || opt.replyToMe)

  if (!显式叫起 && 收尾词 && 同一人 && Number(这.lastReplyAt || 0) > 0) {
    st.groups[群] = { ...这, lastReplyAt: 0, threadStartedAt: 0, lastReplyFrom: '', threadReplies: 0 }
    写手机(st)
    return { ok: false, why: '对方已收尾，持续对话窗口关闭', closed: true }
  }

  if (opt.poke) return { ok: true, why: '被戳一戳', explicit: true }
  if (opt.urgent) return { ok: true, why: '紧急消息', explicit: true }
  if (opt.atMe) return { ok: true, why: '被 @', explicit: true }
  if (opt.named) return { ok: true, why: '被喊名字', explicit: true }
  if (opt.replyToMe) return { ok: true, why: '回复了她', explicit: true }

  const 忙 = 她在忙(读自主(), now)
  const 上限 = 持续上限(c)
  const 持续中 = Number(这.threadStartedAt || 0) > 0
    && Number(这.lastReplyAt || 0) > 0
    && now >= Number(这.lastReplyAt)
    && now - Number(这.lastReplyAt) < 上限.idleMs
    && now >= Number(这.threadStartedAt)
    && now - Number(这.threadStartedAt) < 上限.durationMs
  if (持续中) {
    if (忙) return { ok: false, why: '她在' + 忙 }
    if (!同一人) return { ok: false, why: '她正在和另一位群友对话，这条只留上下文' }
    if (Number(这.threadReplies || 0) >= 上限.replies) return { ok: false, why: '本轮持续对话已到续接上限' }
    return { ok: true, why: '同一个人还在和她对话（续接 ' + (Number(这.threadReplies || 0) + 1) + '/' + 上限.replies + '）', continuation: true }
  }
  if (忙) return { ok: false, why: '她在' + 忙 }
  // 缺失或关闭 phoneGate 时 fail-closed，旧配置不可退回「每条群消息都进完整回合」。
  if (c.phoneGate !== true) return { ok: false, why: '看手机闸未启用，普通群消息只保留上下文' }

  const 下次 = Number(这.nextLookAt || 0)
  if (now < 下次) {
    const 差 = Math.max(1, Math.ceil((下次 - now) / 60e3))
    return { ok: false, why: '刚看过这个群，还差 ' + 差 + ' 分钟' }
  }

  const 一小时前 = now - 60 * 60e3
  st.lookTimes = st.lookTimes.filter((at) => Number.isFinite(Number(at)) && Number(at) > 一小时前)
  const 全局上限 = Math.min(默认群每小时看手机上限, Math.max(0, Math.floor(Number(c.phoneGroupMaxPerHour ?? 默认群每小时看手机上限))))
  if (st.lookTimes.length >= 全局上限) return { ok: false, why: '本小时看手机次数已到上限' }

  const 最短 = Math.min(60, Math.max(1, Number(c.phoneLookMin ?? 5)))
  const 最长 = Math.min(60, Math.max(最短, Number(c.phoneLookMax ?? 8)))
  const 等 = Math.round((最短 + Math.random() * (最长 - 最短)) * 60e3)
  st.lookTimes.push(now)
  st.groups[群] = { ...这, lastLookAt: now, nextLookAt: now + 等, looks: Number(这.looks || 0) + 1 }
  if (!写手机(st)) return { ok: false, why: '看手机状态没写成功，普通消息留在上下文' }
  return { ok: true, why: '她闲着，看了一眼手机（下次 ' + Math.round(等 / 60e3) + ' 分钟后）', phoneCheck: true }
}

/** 她在群里成功回话后，开/更新同人窗口；未过窗口或上限的回复不自动续期。 */
export function 记回话(groupId, now = Date.now(), senderUin = '', options = {}) {
  const 群 = String(groupId ?? '')
  const 人 = String(senderUin ?? '')
  if (群 === '') return
  const st = 读手机()
  const 这 = st.groups[群] || {}
  const 开窗 = options?.explicit === true || options?.phoneCheck === true
  const 可续 = options?.continuation === true && 是持续对话(群, 人, now, options?.config || {})
  st.groups[群] = {
    ...这,
    lastReplyAt: now,
    threadStartedAt: 开窗 || !可续 ? now : Number(这.threadStartedAt || now),
    lastReplyFrom: 人,
    threadReplies: 开窗 ? 0 : (可续 ? Number(这.threadReplies || 0) + 1 : 0),
  }
  写手机(st)
}

/** 只读：这个群下一次什么时候「看手机」。面板/排查用。 */
export function 下次看手机(groupId) {
  const st = 读手机()
  return Number((st.groups || {})[String(groupId ?? '')]?.nextLookAt || 0)
}
