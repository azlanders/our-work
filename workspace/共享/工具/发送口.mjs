#!/usr/bin/env node
// 发送口.mjs —— 独立脚本（cron / 心跳 / 手动）往 QQ 发东西的唯一出口（2026-11-17，批次608）
//
// 为什么需要：
//   投递留言 / 发表情 / 发卡片 原来各自 fetch 协议端，绕过了插件 callOneBot() 的三道闸：
//     · blocked.js   封禁 action（凭据类、账号接管类）——这些脚本只发消息，风险低但规则要一致
//     · allowlist.js 目标白名单（只发给 peerUin / ownerUin / routes / groupUins）
//     · sensitive.js 出站内容审计（本机路径抹除、凭据特征拦截）
//   2026-11-17 审计把这条列为 P1-8：一条 `--谁 陌生人` 的手测命令就能绕过白名单。
//
// 为什么不去 import 插件的 callOneBot()：
//   独立进程没有 loadConfig() 的单例，getConfig() 会是空的，白名单等于失效；
//   而且插件升级换路径时，cron 脚本会整条断掉。这里自己读同一份配置文件，
//   规则与 lib 保持一致（内容审计优先用 lib 的实现，文件不在时退回内置同源正则）。
//
// 传输：配置里的 onebotHttp 默认是 3001 onebot-proxy，只认 body 里的 {action, params}，
//   并且会把 send_* 记进 {{DSH_ROOT}}/onebot-proxy-actions.jsonl —— 走这条路顺带补上动作审计。
//   如果哪天配置改回 3000 直连，这里自动切成 /{action} + 扁平参数。
//
// 用法（给其他脚本）：
//   import { 载配置, 发私聊, 发群, 审计文本, 抹路径 } from './发送口.mjs'
//   const cfg = 载配置()
//   const r = await 发私聊(cfg, '{{OWNER_UIN}}', '早', { requireMsgId: true })
//   // r = { ok, msgId, retcode, fatal, err, raw }
//   // fatal=true 表示重试也没用（目标不在白名单 / 内容审计拦截 / 目标号非法）
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

const CONFIG_FILE = process.env.QQ_BRIDGE_CFG || '{{DSH_ROOT}}/qq-bridge.config.json'
const LIB_SENSITIVE = process.env.DSH_LIB_SENSITIVE
  || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/sensitive.js'
const LIB_RULES = process.env.DSH_LIB_ALLOWLIST
  || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/allowlist-rules.js'

// ---- 内容审计：与 lib/sensitive.js 同源的内置副本（lib 不可用时兜底） ----
// 改规则时两边一起改；t608 会拿同一批样本对比两边判定是否一致。
const ASSIGN_CHARS = '[A-Za-z0-9_\\-./+]'
const ASSIGN_VALUE = `${ASSIGN_CHARS}{4,}`
const SENSITIVE_RE = new RegExp(
  '('
  + '(?<![A-Za-z0-9])[A-Za-z]:[\\\\/][^\\s"\'<>|]+'
  + '|\\\\\\\\[^\\\\\\s"\'<>|]+\\\\[^\\s"\'<>|]+'
  + '|(?<![A-Za-z0-9])(?:/home/|/Users/|/etc/|/var/|/root/|/data/)[^\\s"\'<>|]*'
  + '|(?:token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential)'
  + '["\']?(?:\\s*(?:[:=：]|是|为)\\s*["\']?' + ASSIGN_VALUE
  + '|\\s+(?=' + ASSIGN_CHARS + '{6,}))'
  + ')',
  'i'
)
const CREDENTIAL_RE = /token|密码|密钥|口令|password|passwd|secret|api[_-]?key|authorization|bearer|access[_-]?key|credential/i
const PATH_SCRUB_RE = /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|]+|\\\\[^\\\s"'<>|]+\\[^\s"'<>|]+|(?<![A-Za-z0-9])(?:\/home\/|\/Users\/|\/etc\/|\/var\/|\/root\/|\/data\/)[^\s"'<>|]*/gi

const 打码 = (hit) => {
  const t = String(hit ?? '')
  if (t.length <= 6) return '***'
  return `${t.slice(0, 3)}***${t.slice(-2)}（共 ${t.length} 字符）`
}

function 内置查敏感(text) {
  const body = String(text ?? '')
  if (body === '') return null
  const m = SENSITIVE_RE.exec(body)
  if (m === null) return null
  const hit = String(m[0] ?? '')
  return { kind: CREDENTIAL_RE.test(hit) ? 'credential' : 'path', sample: 打码(hit) }
}

let 查敏感实现 = 内置查敏感
try {
  const m = await import(pathToFileURL(LIB_SENSITIVE).href)
  if (typeof m.findSensitive === 'function') 查敏感实现 = m.findSensitive
} catch {
  // lib 不在（本机测试 / 插件换路径）→ 用内置同源正则
}

export function 查敏感(text) {
  return 查敏感实现(text)
}

/** 本机路径抹成占位符；凭据不在这里处理（交给 查敏感 拦截整条）。 */
export function 抹路径(value) {
  const body = String(value ?? '')
  if (body === '') return body
  return body.replace(PATH_SCRUB_RE, '（地址略）')
}

// ---- 配置 / 目标白名单 ----

export function 载配置(file = CONFIG_FILE) {
  let c = {}
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { c = {} }
  if (!c || typeof c !== 'object') c = {}
  return c
}

/**
 * BATCH664 2026-11-17（审计 P1-9）：白名单规则只有一份。
 *
 * 608 在这里复制了 `normUin / 允许目标 / 校验目标`，和插件 `allowlist.js`
 * 各算一套。插件以后加 routes 形态、改空名单边界、加发送类 action，
 * 走 cron/心跳的这条路径会静默分叉。
 *
 * 现在优先 import `allowlist-rules.js`（纯函数，无单例配置，不写盘）；
 * lib 不在（本机测试 / 插件换路径）才退回内置同源副本，并在启动日志标注。
 */
let 规则实现 = null
let 规则来源 = 'builtin'
try {
  const m = await import(pathToFileURL(LIB_RULES).href)
  if (typeof m.normUin === 'function' && typeof m.checkTarget === 'function') {
    规则实现 = m
    规则来源 = 'lib'
  }
} catch {
  // lib 不在 → 用内置副本
}

/** 与 lib/allowlist-rules.js 的 normUin 同义：0 / 负数 / 非数字 → 空串。 */
export function normUin(value) {
  if (规则实现) return 规则实现.normUin(value)
  const text = String(value ?? '').trim()
  if (text === '') return ''
  const num = Number(text)
  return Number.isSafeInteger(num) && num > 0 ? String(num) : ''
}

export function 允许目标(cfg) {
  if (规则实现) return 规则实现.allowedTargetsOf(cfg)
  const privateSet = new Set()
  const groupSet = new Set()
  const add = (set, v) => { const id = normUin(v); if (id !== '') set.add(id) }
  add(privateSet, cfg.peerUin)
  add(privateSet, cfg.ownerUin)
  for (const k of Object.keys(cfg.routes?.private ?? {})) add(privateSet, k)
  for (const k of Object.keys(cfg.routes?.group ?? {})) add(groupSet, k)
  for (const gid of Array.isArray(cfg.groupUins) ? cfg.groupUins : []) add(groupSet, gid)
  return { private: privateSet, group: groupSet }
}

/**
 * 校验一次出站目标。返回 { ok, fatal, err }，不抛错 —— 独立脚本要能自己决定
 * 「这条永久跳过」还是「这次网络失败，等下一轮」。
 */
export function 校验目标(cfg, kind, id, fallbackUin = '') {
  if (规则实现) return 规则实现.checkTarget(cfg, kind, id, fallbackUin)
  if (cfg.allowSendToAny === true) return { ok: true }
  const allowed = 允许目标(cfg)
  const 总数 = allowed.private.size + allowed.group.size
  // 白名单全空 = 还没配置好，放行（与 lib/allowlist.js 同一条边界）
  if (总数 === 0) return { ok: true, warn: '白名单为空，未限制目标' }
  const isGroup = kind === 'group'
  const real = normUin(id) || (isGroup ? '' : normUin(fallbackUin || cfg.peerUin))
  if (real === '') {
    return { ok: false, fatal: true, err: '没有指明目标，也没有配置默认私聊对象（peerUin）' }
  }
  const set = isGroup ? allowed.group : allowed.private
  if (set.has(real)) return { ok: true }
  const 名称 = isGroup ? '群' : '好友'
  return {
    ok: false,
    fatal: true,
    err: `出站被白名单拦截：${名称} ${real} 不在允许范围内。当前允许：`
      + ([...set].join(', ') || '（空）')
  }
}

/** 本次进程用的是哪套白名单规则（lib = 与插件共用；builtin = 内置副本）。 */
export function 规则来源是() {
  return 规则来源
}

// ---- 消息规整 + 审计 ----

function 规整消息(message) {
  const segments = Array.isArray(message)
    ? message
    : [{ type: 'text', data: { text: String(message ?? '') } }]
  return segments.map((seg) => {
    if (!seg || typeof seg !== 'object') return seg
    const type = String(seg.type ?? '')
    if (type === 'text') {
      return { ...seg, data: { ...(seg.data ?? {}), text: 抹路径(seg.data?.text) } }
    }
    if (type === 'json' && typeof seg.data?.data === 'string') {
      // 卡片正文是 JSON 字符串：同样抹路径，避免标题/摘要里带出本机目录
      return { ...seg, data: { ...seg.data, data: 抹路径(seg.data.data) } }
    }
    return seg
  })
}

function 消息全文(segments) {
  return segments.map((seg) => {
    const type = String(seg?.type ?? '')
    if (type === 'text') return String(seg?.data?.text ?? '')
    if (type === 'json') return String(seg?.data?.data ?? '')
    return ''
  }).join('\n')
}

/** 出站前审计：命中就返回 fatal，不发送。 */
export function 审消息(segments, where = '出站') {
  const hit = 查敏感(消息全文(segments))
  if (hit === null) return { ok: true }
  const what = hit.kind === 'credential' ? '凭据特征' : '本机路径'
  return {
    ok: false,
    fatal: true,
    err: `${where}内容被审计拦截：${what}（${hit.sample}）。这条没有发出去。`
  }
}

// ---- 协议调用 ----

/**
 * 调一次 OneBot action。
 * 3001 代理风格：POST {action, params}；3000 直连风格：POST /{action} + 扁平参数。
 */
export async function 调用(cfg, action, params, options = {}) {
  const rawBase = String(cfg.onebotHttp || 'http://127.0.0.1:3001/').replace(/\/$/, '')
  const 直连 = !/:3001(\/|$)/.test(rawBase)
  const url = 直连 ? `${rawBase}/${action}` : `${rawBase}/`
  const payload = 直连 ? (params ?? {}) : { action, params: params ?? {} }
  const timeoutMs = Math.max(1000, Number(options.timeoutMs ?? cfg.requestTimeoutMs) || 8000)
  const headers = { 'Content-Type': 'application/json' }
  if (cfg.token) headers.Authorization = 'Bearer ' + cfg.token
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await r.text()
    let j = null
    try { j = JSON.parse(text) } catch { j = null }
    if (!r.ok) {
      return {
        ok: false, retcode: null, data: null, raw: text.slice(0, 200),
        err: `OneBot HTTP ${r.status}：${text.slice(0, 120)}`,
      }
    }
    if (j === null) {
      return {
        ok: false, retcode: null, data: null, raw: text.slice(0, 200),
        err: `协议端回了非 JSON（可能打到了健康检查）：${text.slice(0, 120)}`,
      }
    }
    const retcode = j.retcode ?? null
    return {
      ok: retcode === 0,
      retcode,
      data: j.data ?? null,
      raw: j,
      err: retcode === 0 ? '' : `retcode ${retcode} ${String(j.wording ?? j.message ?? '')}`,
    }
  } catch (e) {
    return { ok: false, retcode: null, data: null, raw: null, err: String(e?.message || e) }
  }
}

function msgIdOf(data) {
  const id = data?.message_id ?? data?.message_id_str ?? null
  return id === null || id === undefined ? null : id
}

async function 发(kind, cfg, id, message, options = {}) {
  const 目标 = 校验目标(cfg, kind, id, options.fallbackUin)
  if (!目标.ok) return { ...目标, msgId: null, retcode: null }
  const segments = 规整消息(message)
  const 审计 = 审消息(segments, options.where || (kind === 'group' ? '群消息' : '私聊消息'))
  if (!审计.ok) return { ...审计, msgId: null, retcode: null }
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
  const params = kind === 'group'
    ? { group_id: Number(normUin(id)), message: segments }
    : { user_id: Number(normUin(id) || normUin(options.fallbackUin || cfg.peerUin)), message: segments }
  const r = await 调用(cfg, action, params, options)
  if (!r.ok) return { ok: false, fatal: false, msgId: null, retcode: r.retcode, err: r.err, raw: r.raw }
  const msgId = msgIdOf(r.data)
  if (options.requireMsgId === true && msgId === null) {
    return {
      ok: false, fatal: false, msgId: null, retcode: r.retcode,
      err: '没有 message_id（可能打到了代理的健康检查）：' + JSON.stringify(r.raw ?? '').slice(0, 100),
      raw: r.raw,
    }
  }
  return { ok: true, fatal: false, msgId, retcode: r.retcode, err: '', raw: r.raw }
}

export function 发私聊(cfg, uin, message, options = {}) {
  return 发('private', cfg, uin, message, options)
}

export function 发群(cfg, gid, message, options = {}) {
  return 发('group', cfg, gid, message, options)
}
