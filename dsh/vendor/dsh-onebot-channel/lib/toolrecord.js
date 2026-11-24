// toolrecord.js —— 工具调用账本（批次243，主人 2026-11-08 03:11 点头）
//
// 为什么要有：工具调用原来只在 session jsonl 里，跟着对话一起压、跨不了会话。
// 想查「今天 qq_send 失败几次」「qq_listen 空手率多少」「哪个工具最慢」
// 得 zstd -dc session.xxx | grep，慢而且只能一个会话一个会话翻。
//
// 设计边界（很重要）：
//   · 纯旁路：不改任何工具的行为、不吞异常、不改返回值；记账失败一律静默。
//   · 不动原 def：用 {...def} 复制一份再换 execute —— 原对象被 freeze 也不会炸。
//   · 参数只留 80 字摘要，图片引用/base64 脱敏，别把聊天原文全量落盘。
//   · 4MB 轮转，保留后一半。
//
// ⚠ SCOPE 2026-11-14（批次396）：**这个账本不完整，别拿它判「工具零调用」。**
//   它靠劫持 tools.register 记账，只能包到「劫持之后、走同一个 tools 服务」注册的工具。
//   实测（11-14）：会话流里 56 种工具，这里只记了 26 种，漏掉 30 种 ——
//   包括使用量最大的 memory_update 533 次、memory_remember 449、memory_judge 435，
//   以及 web_search / web_fetch / read_animation / search_meme_wiki 全部没记。
//   要判「用没用过」去读 记忆/工具用量.json（共享/工具/工具用量.mjs 从 stream.jsonl 派生）。
//   这里继续负责它擅长的：参数摘要、耗时、成败。
import fs from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'

const 账 = process.env.TOOL_LOG || `${QQ_WS}/记忆/工具调用.jsonl`
const 上限 = 4 * 1024 * 1024

const 北京 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

function 摘要(v, 上限字 = 80) {
  try {
    if (v === undefined || v === null) return ''
    let s = typeof v === 'string' ? v : JSON.stringify(v)
    if (typeof s !== 'string') return ''
    s = s.replace(/"ref":\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '"ref":…')
      .replace(/base64,[A-Za-z0-9+/=]{20,}/g, 'base64,…')
      .replace(/https?:\/\/[^\s"]{40,}/g, (m) => m.slice(0, 40) + '…')
    return s.length > 上限字 ? s.slice(0, 上限字) + '…' : s
  } catch { return '' }
}

function 记(行) {
  try {
    fs.appendFileSync(账, JSON.stringify(行) + '\n')
    if (fs.statSync(账).size > 上限) {
      const 全 = fs.readFileSync(账, 'utf8').split('\n').filter(Boolean)
      fs.writeFileSync(账, 全.slice(Math.floor(全.length / 2)).join('\n') + '\n')
    }
  } catch { /* 记账是旁路，绝不影响工具本身 */ }
}

// 判成败 2026-11-08（批次255）：工具用返回值表达成败时，账本要跟着它。
//   有 boolean 的 ok 字段 → 以它为准（这是插件的约定）
//   有 isError:true      → 失败（宿主风格）
//   其余（字符串/undefined/普通对象）→ 算成功，跟原来一致
function 判成败(r) {
  try {
    if (r && typeof r === 'object') {
      if (typeof r.ok === 'boolean') {
        return r.ok
          ? { ok: true }
          : { ok: false, why: 摘要(r.why ?? 'rejected', 40), msg: 摘要(r.message ?? r.msg ?? '', 120) }
      }
      if (r.isError === true) return { ok: false, why: 'isError', msg: 摘要(r.message ?? '', 120) }
    }
  } catch { /* 判不出来就按成功记，绝不能因为记账把工具搞挂 */ }
  return { ok: true }
}

const 已包 = new WeakSet()

/** 给一个工具定义套上记账。返回新对象；已套过或结构不对就原样返回。 */
export function 包(def) {
  if (!def || typeof def.execute !== 'function') return def
  if (已包.has(def)) return def
  const 名 = String(def.name || '')
  const 原 = def.execute
  const 新 = { ...def }
  新.execute = async function (args, ...rest) {
    const 起 = Date.now()
    try {
      const r = await 原.call(this, args, ...rest)
      // OK_BY_RETURN 2026-11-08（批次255）：ok 不能只看「没抛异常」。
      // 插件的失败是用返回值表达的 —— qq_item/qq_money 被拒时返回
      // {ok:false, why:'rejected', message:'你手上没有「水」'}，
      // 原来一律记 ok:true，账本等于把失败洗白（实测 11:44「用 水」被拒记成成功）。
      const 判 = 判成败(r)
      if (判.ok) 记({ at: 北京(), tool: 名, ok: true, ms: Date.now() - 起, args: 摘要(args) })
      else 记({ at: 北京(), tool: 名, ok: false, ms: Date.now() - 起, args: 摘要(args), why: 判.why, msg: 判.msg })
      return r
    } catch (e) {
      记({ at: 北京(), tool: 名, ok: false, ms: Date.now() - 起, args: 摘要(args), err: 摘要(e && e.message ? e.message : e, 120) })
      throw e
    }
  }
  已包.add(新)
  return 新
}

/**
 * 在注册任何工具之前调一次，把 tools.register 包起来。
 * 返回 true = 劫持成功（之后所有工具自动记账）；false = 宿主服务不可写，需要退回去手工包。
 */
export function 挂上记录(ctx, serviceOf) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (!tools || typeof tools.register !== 'function') return false
    if (tools.__toolRecorded) return true
    const 原 = tools.register.bind(tools)
    tools.register = (def) => 原(包(def))
    tools.__toolRecorded = true
    return true
  } catch { return false }
}
