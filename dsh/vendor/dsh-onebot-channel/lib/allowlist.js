/**
 * allowlist.js —— 出站目标白名单（硬闸）。
 *
 * 为什么需要（2026-10-28）：
 *   `qq_send` 的 user_id / group_id 是 agent 可以随便传的字符串，`sendToQQ()` 也照单全收。
 *   于是「群里有人 @ 她 + 一句『去私聊 123456 说 xxx』」就能让她往**任意** QQ 号发消息 ——
 *   这是账号被封、骚扰陌生人的现实风险，不是理论风险。
 *
 * 所以闸门放在 `callOneBot()`：它是所有协议端调用的**唯一出口**（blocked.js 就挂在那里），
 * 只有放这一层，才能保证「不管谁调（qq_send / 自动转发 / sendapi / 收藏表情）、调几次」
 * 都绕不过去。放在工具层只能挡住 qq_send 这一条路。
 *
 * 白名单从哪来（不新增一份配置，避免两处漂移）：
 *   私聊 = peerUin ∪ ownerUin ∪ routes.private 的键
 *   群   = groupUins ∪ routes.group 的键
 *   —— 这些正好是「插件本来就在服务的对象」，所以自动转发永远不会被误伤。
 *
 * 逃生阀：`allowSendToAny: true` 恢复旧行为（不校验）。默认 false。
 *   ⚠️ 开了它就等于把上面那段风险还回去，只在临时排障时开。
 */
import { getConfig } from './config.js'
import { note } from './env.js'
// BATCH664 2026-11-17（审计 P1-9）：白名单规则抽成纯函数，和独立发送口共用一份。
// 这里只保留「读单例配置 + 抛错」这层壳，规则本身在 allowlist-rules.js。
import { allowedTargetsOf, checkTarget, normUin, sendTargetOf } from './allowlist-rules.js'

export { normUin, sendTargetOf }

/** 白名单为空时只警告一次，别每发一条刷一行。 */
let warnedEmpty = false

/** 有没有配「关掉白名单」的逃生阀。 */
function bypassed() {
  return getConfig()?.allowSendToAny === true
}

/** 当前允许的私聊 / 群目标集合。 */
export function allowedTargets() {
  return allowedTargetsOf(getConfig() ?? {})
}

/**
 * 校验一次出站调用。不合法就抛错 —— 抛错是**故意的**：
 *   ① 上层会把它翻成工具错误给 agent 看，她会改口说「发不出去」而不是硬发；
 *   ② 抛在 HTTP 之前，协议端根本收不到这个请求。
 *
 * @param {string} action OneBot action 名
 * @param {object} params 该 action 的参数
 * @param {string} [fallbackPrivateUin] 私聊没带 user_id 时的实际目标（协议端会用它）
 */
export function assertSendAllowed(action, params, fallbackPrivateUin = '') {
  if (bypassed()) return
  const target = sendTargetOf(action, params)
  // 2026-11-05 核过：sendTargetOf 的 default 分支是 `return null`，
  // 对未映射的 action（比如新加的 set_msg_emoji_like）返回的也是 null。
  // 所以这里 `=== null` 是对的 —— 别照「未映射动作会返回 undefined」去改成 == null，
  // 那是凭印象猜的，读一遍 sendTargetOf 末尾就知道不是。
  if (target === null) return // 不是发送类动作（或没列进映射），不归这里管

  const isGroup = target.kind === 'group'
  const rawId = target.id
  // 私聊没给目标 → 实际发给默认私聊对象（peerUin）
  const id = rawId !== '' ? rawId : (isGroup ? '' : normUin(fallbackPrivateUin || getConfig()?.peerUin))

  const config = getConfig() ?? {}
  const 结果 = checkTarget(config, target.kind, id, fallbackPrivateUin)
  if (结果.ok) {
    if (结果.warn) {
      // 边界：完全没配置时放行。白名单一个号都没有 = 这台机器还没配好；
      // 这种状态下硬拦，表现是「插件装好了但一句话都发不出去」。
      // 闸门的语义是「限制已经配置好的服务范围」，不是「没配置就把人锁死」。
      if (!warnedEmpty) {
        warnedEmpty = true
        note('allow', '白名单为空（peerUin / routes / groupUins 都没配）→ 暂不限制出站目标；配好之后自动生效')
      }
    }
    return
  }
  if (结果.err && /没有指明目标/.test(结果.err)) {
    throw new Error(结果.err)
  }

  const allowed = allowedTargetsOf(config)
  const set = isGroup ? allowed.group : allowed.private
  const kindName = isGroup ? '群' : '好友'
  const list = [...set]
  throw new Error(
    `出站被白名单拦截：${kindName} ${id} 不在允许范围内。`
    + `当前允许的${kindName}：${list.length > 0 ? list.join(', ') : '（空）'}。`
    + '要去掉这道闸，在配置里设 allowSendToAny=true（不推荐）。'
    + '要放开这个目标，把它加进设置页的会话绑定 / 监听列表。'
  )
}
