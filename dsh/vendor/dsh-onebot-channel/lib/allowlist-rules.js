/**
 * allowlist-rules.js —— 出站目标白名单的**纯规则**（2026-11-17，批次 664，审计 P1-9）。
 *
 * 为什么单独一份：
 *   608 给独立脚本（cron / 心跳 / 手动）加了 `发送口.mjs`，但它把
 *   `normUin / 允许目标 / 校验目标` 又实现了一遍，和这里的 `allowlist.js`
 *   各算一套。插件以后新增 routes 形态、改空名单边界、加发送类 action，
 *   走脚本的那条路会静默分叉。
 *
 * 这里只放不依赖单例配置的纯函数：传进来什么 config，就算什么。
 *   - `allowlist.js`（插件内）用 `getConfig()` 调它们；
 *   - `发送口.mjs`（独立进程）读同一份 JSON 后调它们；
 *   - lib 不可用时，发送口才退回内置副本，并在启动日志里标注「使用内置规则」。
 */

/**
 * QQ 号归一：'003001' 和 '3001' 在协议端是同一个号。
 * 统一成字符串数字，避免「白名单里写 3001、工具传来 ' 3001 '」这种假阴性。
 *
 * ⚠️ 0 / 负数 / 非数字一律归成空串：`peerUin: 0` 在配置里表示「还没配」，
 *   如果这里把 0 当成合法号塞进白名单，白名单就永远不为空 ——
 *   「完全没配置时放行」那条边界会失效，插件装好就一句话都发不出去。
 */
export function normUin(value) {
  const text = String(value ?? '').trim()
  if (text === '') return ''
  const num = Number(text)
  return Number.isSafeInteger(num) && num > 0 ? String(num) : ''
}

/**
 * 从一份配置算允许的私聊 / 群目标集合。
 *
 * 白名单从哪来（不新增一份配置，避免两处漂移）：
 *   私聊 = peerUin ∪ ownerUin ∪ routes.private 的键
 *   群   = groupUins ∪ routes.group 的键
 *   —— 这些正好是「插件本来就在服务的对象」，所以自动转发永远不会被误伤。
 */
export function allowedTargetsOf(config) {
  const cfg = config && typeof config === 'object' ? config : {}
  const privateSet = new Set()
  const groupSet = new Set()
  const addPrivate = (value) => { const uin = normUin(value); if (uin !== '') privateSet.add(uin) }
  const addGroup = (value) => { const gid = normUin(value); if (gid !== '') groupSet.add(gid) }

  addPrivate(cfg.peerUin)
  addPrivate(cfg.ownerUin)
  for (const key of Object.keys(cfg.routes?.private ?? {})) addPrivate(key)
  for (const key of Object.keys(cfg.routes?.group ?? {})) addGroup(key)
  for (const gid of Array.isArray(cfg.groupUins) ? cfg.groupUins : []) addGroup(gid)

  return { private: privateSet, group: groupSet }
}

/**
 * 从一次协议端调用里提取出站目标。
 *
 * 只认明确的发送类 action —— 不认识的 action 一律返回 null（不拦），
 * 宁可漏拦也不要把 get_login_info 这类只读动作误判成发送。
 *
 * @returns {{kind:'private'|'group', id:string} | null}
 */
export function sendTargetOf(action, params) {
  const name = String(action ?? '')
  const p = params ?? {}
  const pick = (...keys) => {
    for (const key of keys) {
      const value = normUin(p[key])
      if (value !== '') return value
    }
    return ''
  }

  switch (name) {
    case 'send_private_msg':
    case 'send_priv_forward_msg': {
      const id = pick('user_id')
      // 私聊没给 user_id 时 sendOneToQQ 会退到 peerUin，这里同样返回空串交给下游补
      return { kind: 'private', id }
    }
    case 'send_group_msg':
    case 'send_group_forward_msg':
      return { kind: 'group', id: pick('group_id') }
    case 'send_msg': {
      const type = String(p.message_type ?? p.type ?? '').trim()
      if (type === 'group') return { kind: 'group', id: pick('group_id') }
      if (type === 'private') return { kind: 'private', id: pick('user_id') }
      // message_type 没写时按「有 group_id 就是群」猜，跟 qq_send 的优先级一致
      const gid = pick('group_id')
      return gid !== '' ? { kind: 'group', id: gid } : { kind: 'private', id: pick('user_id') }
    }
    // 2026-11-04 修：这四类是「真能把东西送到目标那儿」的动作，原来没进白名单，
    // 等于一句「把文件传给 123456」就能绕过这道闸。补上映射，泛化不到的一律不拦。
    case 'upload_group_file':
      return { kind: 'group', id: pick('group_id') }
    case 'upload_private_file':
      return { kind: 'private', id: pick('user_id') }
    case 'send_custom_face': {
      const faceGid = pick('group_id')
      if (faceGid !== '') return { kind: 'group', id: faceGid }
      return { kind: 'private', id: pick('user_id') }
    }
    case 'send_poke':
    case 'friend_poke':
    case 'group_poke': {
      const gid = pick('group_id')
      if (gid !== '') return { kind: 'group', id: gid }
      return { kind: 'private', id: pick('user_id', 'target_id') }
    }
    default:
      return null
  }
}

/**
 * 校验一次出站目标。不抛错，返回结果对象 ——
 * 插件侧把它翻成 throw（让 agent 看到工具错误），
 * 独立脚本侧用它决定「永久跳过」还是「下轮重试」。
 *
 * @param {object} config 完整配置
 * @param {'private'|'group'} kind
 * @param {string} id 目标号（可为空，私聊会退到 fallbackUin / peerUin）
 * @param {string} [fallbackUin]
 * @returns {{ok:boolean, fatal?:boolean, err?:string, warn?:string}}
 */
export function checkTarget(config, kind, id, fallbackUin = '') {
  const cfg = config && typeof config === 'object' ? config : {}
  if (cfg.allowSendToAny === true) return { ok: true }
  const allowed = allowedTargetsOf(cfg)
  const total = allowed.private.size + allowed.group.size
  // 白名单全空 = 这台机器还没配好（peerUin / routes / groupUins 全空）。
  // 这种状态下硬拦，表现是「插件装好了但一句话都发不出去」。
  // 闸门的语义是「限制已经配置好的服务范围」，不是「没配置就把人锁死」。
  if (total === 0) return { ok: true, warn: '白名单为空，未限制目标' }

  const isGroup = kind === 'group'
  const real = normUin(id) || (isGroup ? '' : normUin(fallbackUin || cfg.peerUin))
  if (real === '') {
    return { ok: false, fatal: true, err: '出站被白名单拦截：没有指明目标，也没有配置默认私聊对象（peerUin）' }
  }
  const set = isGroup ? allowed.group : allowed.private
  if (set.has(real)) return { ok: true }
  const kindName = isGroup ? '群' : '好友'
  return {
    ok: false,
    fatal: true,
    err: `出站被白名单拦截：${kindName} ${real} 不在允许范围内。当前允许的${kindName}：`
      + (set.size > 0 ? [...set].join(', ') : '（空）'),
  }
}
