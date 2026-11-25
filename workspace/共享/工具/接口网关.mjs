import { 原子写 } from './_底层.mjs'
// 多模型接口网关（127.0.0.1:39401）
//
// 核心能力：
//   1. 有序接口列表（{{DSH_ROOT}}/fish-fleet.json）：按顺序优先尝试，停用的跳过，改完下一句生效；
//   2. 原生双协议双向无损转译：
//      - anthropic 协议：直通 /v1/messages + 自动注入 4 锚点 cache_control: ephemeral；
//      - openai    协议：自动将 DSH 的 Anthropic 请求（含图文/tools/tool_use/tool_result）转为 OpenAI /v1/chat/completions，
//                        并将上游 OpenAI SSE 流（含 reasoning_content / text / 并发 tool_calls）实时转回标准 Anthropic SSE 流！
//   3. 自动故障降级（某条接口没 Key 或 5xx/429 时，按列表顺序继续试下一条）；
//   4. 本地管理端 /__fleet/state 与 /__fleet/action（仅 127.0.0.1 回环可调，所有响应严格脱敏 API Key）。

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { 记思考, 记一条 } from './思考流.mjs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { 有效倍率 } from './接口时段.mjs'

const PORT = Number(process.env.HAJIMI_UPSTREAM_PORT || 39401)
const HOST = '127.0.0.1'
const FLEET_PATH = process.env['FISH_FLEET_CONFIG'] || '{{DSH_ROOT}}/fish-fleet.json'
const SHARED_KEYS_PATH = process.env.HAJIMI_KEYS_FILE || '{{DSH_ROOT}}/fish-api-keys.json'
const USAGE_LOG = process.env.HAJIMI_USAGE_LOG || '{{DSH_ROOT}}/fish-usage-log.jsonl'
// CONTEXT_GUARD 2026-11-24：上游按字符数算 token（实测 208 万字计成 150.5 万入），
// 单张 1.5MB 的视频分镜图 base64 就 204 万字。这里是整形后的整包上限，默认 20 万字。
const 输入上限 = Number(process.env.DSH_MAX_INPUT_CHARS || 200000)
// 单块上限：工具结果留头留尾，图片太大直接跳过（新图由 attachment-local 压到 100KB）。
const 工具结果上限字 = Number(process.env.DSH_TOOL_RESULT_MAX_CHARS || 40000)
const 图片上限字 = Number(process.env.DSH_IMAGE_MAX_CHARS || 300000)
// FLEET_AUTH 2026-11-24-2：同一台机器上两个 bot 共用回环端口，谁都能问 /__fleet/*。
// 设了 token 就要求面板带同一枚头，别的实例读不到这家舰队。
// TOKEN_NAME_FIX 2026-11-24：原注释写 HAJIMI_FLEET_TOKEN、代码读 FLEET_TOKEN —— 名字对不上，
// 照注释配的人会发现「设了没生效」。现在两个名字都认（后者优先），
// 并且在没设 token 时**打一条启动告警**（回环上本来就只有本机，不算漏洞，但要说清）。
const FLEET_TOKEN = process.env.HAJIMI_FLEET_TOKEN || process.env.FLEET_TOKEN || ''
const RELAY_LOG = process.env.HAJIMI_RELAY_LOG || '{{BOT_ROOT}}/记忆/日志/接口中转.log'

const 京刻 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 京分 = (ms = Date.now()) => 京刻(ms).slice(0, 16)

function 记日志(obj) {
  try {
    mkdirSync(dirname(RELAY_LOG), { recursive: true })
    appendFileSync(RELAY_LOG, JSON.stringify({ at: 京刻(), ...obj }) + '\n')
  } catch (e) { console.error('[接口网关]', e && e.message) }
}

// TOKENS 2026-11-23：把请求体拆成系统/对话/工具三块记进用量日志。
// 没有这个，日志里只有「入」，看不出 34k 是花在工具说明、历史还是回忆块上。
function 请求体量(parsed) {
  const sys = parsed?.system
  const 系统字 = typeof sys === 'string'
    ? sys.length
    : Array.isArray(sys) ? sys.map((x) => (typeof x === 'string' ? x : String(x?.text || ''))).join('\n').length : 0
  const tools = Array.isArray(parsed?.tools) ? parsed.tools : []
  const msgs = Array.isArray(parsed?.messages) ? parsed.messages : []
  let 对话字 = 0
  for (const m of msgs) {
    const c = m?.content
    if (typeof c === 'string') 对话字 += c.length
    else if (Array.isArray(c)) for (const b of c) 对话字 += typeof b?.text === 'string' ? b.text.length : JSON.stringify(b || '').length
  }
  const 量 = {
    系统字,
    对话字,
    工具字: tools.length ? JSON.stringify(tools).length : 0,
    消息数: msgs.length,
    工具数: tools.length,
  }
  // REQ_DUMP 2026-11-23：排查「对话字 42k 从哪来」用。存在 /tmp/{{BOT_NAME}}-dump.on 时才写盘。
  if (existsSync('/tmp/{{BOT_NAME}}-dump.on')) {
    try {
      const rows = msgs.map((m, i) => {
        const c = m?.content
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (typeof b?.text === 'string' ? b.text : JSON.stringify(b || ''))).join('') : ''
        return { i, role: m?.role, len: text.length, head: text.slice(0, 60), text }
      })
      appendFileSync('/tmp/{{BOT_NAME}}-req.jsonl', JSON.stringify({ at: 京刻(), 量, rows }) + '\n')
      // DUMP_SYS_TOOLS 2026-11-24：只记 msgs 看不出固定开销（system + tools schema）占多少。
      try { 原子写('/tmp/{{BOT_NAME}}-req-full.json', JSON.stringify({ at: 京刻(), 量, system: parsed?.system, tools: parsed?.tools, msgs })) } catch (e) { console.error('[接口网关]', e && e.message) }
    } catch (e) { console.error('[接口网关]', e && e.message) }
  }
  return 量
}

function 记用量(row) {
  try {
    mkdirSync(dirname(USAGE_LOG), { recursive: true })
    appendFileSync(USAGE_LOG, JSON.stringify({ at: 京分(), ...row }) + '\n')
  } catch (e) { console.error('[接口网关]', e && e.message) }
}

function 读共享钥匙表() {
  try {
    const arr = JSON.parse(readFileSync(SHARED_KEYS_PATH, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch { return [] }
}

function 解析钥匙(rawKey) {
  const s = String(rawKey || '').trim()
  if (!s) return ''
  if (s.startsWith('@shared:')) {
    const id = s.slice(8).trim()
    const hit = 读共享钥匙表().find((x) => x && x.id === id)
    return String(hit?.key || '').trim()
  }
  return s
}

function 脱敏(rawKey) {
  const s = String(rawKey || '').trim()
  if (!s) return ''
  if (s.startsWith('@shared:')) {
    const id = s.slice(8).trim()
    const hit = 读共享钥匙表().find((x) => x && x.id === id)
    return hit ? `共享钥匙(${hit.名 || id})` : s
  }
  if (s.length <= 10) return s.slice(0, 2) + '***'
  return s.slice(0, 6) + '…' + s.slice(-4)
}

function 默认舰队() {
  const 共享 = 读共享钥匙表()
  const 稳站 = 共享.find((x) => x.base && String(x.名 || '').includes('0.4')) || 共享.find((x) => x.base) || 共享[0]
  const 省站 = 共享.find((x) => x.base && String(x.名 || '').includes('0.2')) || 稳站
  const 官站 = 共享.find((x) => !x.base || String(x.名 || '').includes('官方'))
  const 稳引 = 稳站 ? `@shared:${稳站.id}` : ''
  const 省引 = 省站 ? `@shared:${省站.id}` : 稳引
  const 官引 = 官站 ? `@shared:${官站.id}` : ''

  return {
    activeSlot: 'slot-2',
    fallbackSlot: 'slot-6',
    updatedAt: 京分(),
    slots: [
      {
        id: 'slot-1',
        codename: '{{BOT_DISPLAY}}本尊 · Gemini 4 Carbon',
        faction: 'gemini',
        badge: '🐱✨',
        roleTag: '主脑 · 极速全栈',
        protocol: 'openai',
        base: 'https://portdan.com',
        key: '',
        model: 'gemini-4-carbon',
        note: '填入你的 {{BOT_DISPLAY}}分组 API Key 即可唤醒本尊真身！未填时自动由替补顶班',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-2',
        codename: '月之暗面 · Kimi K3.1 Pro',
        faction: 'cn',
        badge: '🌙🐾',
        roleTag: '备用 · 现成可用',
        protocol: 'anthropic',
        base: 'https://portdan.com',
        key: 稳引,
        model: 'kimi-k3.1-pro',
        note: '已绑定 VPS 0.4x 稳定中转钥匙，开箱即用，文风灵动活人感极强',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-3',
        codename: '铁笼二妹 · Gemini 4 Argon',
        faction: 'gemini',
        badge: '🔮⚡',
        roleTag: '视觉多模态 · 超长百万上下文',
        protocol: 'openai',
        base: 'https://portdan.com',
        key: '',
        model: 'gemini-4-argon',
        note: '填入 {{BOT_DISPLAY}}分组 Key 可用，擅长长文深扒与多图理解',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-4',
        codename: '橙发学者 · Claude Opus 5',
        faction: 'claude',
        badge: '🧡📚',
        roleTag: '重装架构师 · 疑难杂症斩首',
        protocol: 'anthropic',
        base: 'https://portdan.com',
        key: '',
        model: 'claude-opus-5',
        note: '填入克劳德分组 Key 可用，适合复杂重构与精密推理',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-5',
        codename: '文学少女 · Claude Fable 5.2',
        faction: 'claude',
        badge: '🌸🖋️',
        roleTag: '细腻角色扮演 · 写日记大师',
        protocol: 'anthropic',
        base: 'https://portdan.com',
        key: '',
        model: 'claude-fable-5-2',
        note: '填入克劳德分组 Key 可用，语气自然细腻不端着',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-6',
        codename: '通义旗舰 · Qwen 3.8 Max',
        faction: 'cn',
        badge: '💠🚀',
        roleTag: '全能主力保底 · 现成可用',
        protocol: 'anthropic',
        base: 'https://portdan.com',
        key: 稳引,
        model: 'qwen3.8-max',
        note: '已绑定 VPS 0.4x 稳定钥匙，工具调用极稳，默认设为全舰队故障替补',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-7',
        codename: '银龙统帅 · GPT-6.1 Sol',
        faction: 'gpt',
        badge: '🐉❄️',
        roleTag: '直接给答案 · 严密工程逻辑',
        protocol: 'openai',
        base: 'https://portdan.com',
        key: '',
        model: 'gpt-6.1-sol',
        note: '填入 GPT 分组 Key 可用，执行复杂脚本滴水不漏',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-8',
        codename: '暗夜狂徒 · Grok 4.7',
        faction: 'grok',
        badge: '🖤⚡',
        roleTag: '毒舌冲浪手 · 玩梗接梗王',
        protocol: 'openai',
        base: 'https://portdan.com',
        key: '',
        model: 'grok-4.7',
        note: '填入 Grok 分组 Key 可用，冲浪吐槽攻击性拉满',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-9',
        codename: '智谱主脑 · GLM 5.3',
        faction: 'cn',
        badge: '🌿🔧',
        roleTag: '中文梗百科 · 现成可用',
        protocol: 'anthropic',
        base: 'https://portdan.com',
        key: 稳引,
        model: 'glm-5.3',
        note: '已绑定 VPS 0.4x 稳定钥匙，国产 Agent 工具链熟手',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
      {
        id: 'slot-10',
        codename: '深海替身 · DeepSeek V4.1 Flash',
        faction: 'deepseek',
        badge: '🐋💨',
        roleTag: '白菜价永动机 · 现成双保险',
        protocol: 'anthropic',
        base: 'https://portdan.com',
        key: 省引 || 官引,
        model: 'deepseek-v4.1-flash',
        note: '已绑定 VPS 0.2x 钥匙，省钱耐造不心疼',
        stats: { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      },
    ],
  }
}

function 读舰队() {
  try {
    if (existsSync(FLEET_PATH)) {
      const d = JSON.parse(readFileSync(FLEET_PATH, 'utf8'))
      if (d && Array.isArray(d.slots) && d.slots.length) return d
    }
  } catch (e) { console.error('[接口网关]', e && e.message) }
  const init = 默认舰队()
  写舰队(init)
  return init
}

function 写舰队(d) {
  mkdirSync(dirname(FLEET_PATH), { recursive: true })
  d.updatedAt = 京分()
  原子写(FLEET_PATH, JSON.stringify(d, null, 2) + '\n', { mode: 0o600 })
}

const 型名 = (s) => String((s && (s.别名 || s.model)) || '').trim()

/** 型号优先级：主人自填的型号名，排过的在前，新加的按出现顺序补到后面。 */
function 模型序(d) {
  const 现有 = [...new Set([
    ...(Array.isArray(d.customModels) ? d.customModels.map((x) => String(x)) : []),
    ...(d.slots || []).map((s) => 型名(s)),
  ].filter(Boolean))]
  const 排过 = Array.isArray(d.modelOrder) ? d.modelOrder.map((x) => String(x)).filter((m) => 现有.includes(m)) : []
  return [...排过, ...现有.filter((m) => !排过.includes(m))]
}

// SLOT_ORDER_2026：同一型号可能挂好几把钥匙（hydrogen 一排），型号优先级分不出先后，
// 上/下按钮只动 modelOrder 就等于没动。这里按 slotOrder 给同型号内部定序。
function 槽序(d) {
  const 现有 = (d.slots || []).map((s) => String(s.id))
  const 排过 = Array.isArray(d.slotOrder) ? d.slotOrder.map(String).filter((id) => 现有.includes(id)) : []
  return [...排过, ...现有.filter((id) => !排过.includes(id))]
}

function 舰队脱敏快照(d) {
  const 共享 = 读共享钥匙表().map((x) => ({ id: x.id, 名: x.名 || x.id, base: x.base || '官方' }))
  return {
    ok: true,
    port: PORT,
    activeSlot: (() => { const first = 路由候选(d)[0]; return first ? first.s.id : d.activeSlot })(),
    fallbackSlot: d.fallbackSlot,
    updatedAt: d.updatedAt || '',
    sharedKeys: 共享,
    modelOrder: 模型序(d),
    slotOrder: 槽序(d),
    customModels: Array.isArray(d.customModels) ? d.customModels : [],
    slots: (d.slots || []).map((s) => {
      const 实钥 = 解析钥匙(s.key)
      return {
        id: s.id,
        codename: s.codename || s.model || s.id,
        faction: s.faction || 'gemini',
        badge: s.badge || '🐾',
        roleTag: s.roleTag || '',
        protocol: s.protocol || 'anthropic',
        base: s.base || '',
        keyRef: String(s.key || '').startsWith('@shared:') ? s.key : '',
        keyMask: 脱敏(s.key),
        hasKey: Boolean(实钥),
        model: s.model || '',
        别名: 型名(s),
        note: s.note || '',
        停用: s.停用 === true,
        倍率: s.倍率 == null ? 1 : Number(s.倍率),
        峰谷: s.峰谷 === true,
        峰倍率: s.峰倍率 == null ? null : Number(s.峰倍率),
        谷倍率: s.谷倍率 == null ? null : Number(s.谷倍率),
        当前倍率: 有效倍率(s),
        stats: s.stats || { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      }
    }),
  }
}

// SLOT_COOLDOWN 2026-11-24：以前失败只记 err、下一句照样从死槽开始试。
// 实测 carbon/argon 额度耗尽时每条消息先白撞 3 次 429（各 5 秒），找工具那种带 tools 的
// 请求干脆卡到超时 —— 她「不回话 / 回得慢」有一半是这个。
// 现在按失败类型进冷却，冷却中的槽直接跳过；全都在冷却才退回原顺序。
const 冷却时长 = (err) => {
  const m = String(err || '')
  if (/model_downgraded|insufficient_quota|额度/.test(m)) return 30 * 60e3
  if (/HTTP 429/.test(m)) return 10 * 60e3
  // 超时不是瞬时故障：neon-thinking 实测一挂五分钟，2 分钟冷却等于下一条消息又撞上去。
  if (/超时|timeout|aborted|AbortError/i.test(m)) return 10 * 60e3
  if (/HTTP 5\d\d/.test(m)) return 60e3
  return 30e3
}

/** 智能路由候选：型号优先级 → 当前倍率 → 列表顺序；停用/无钥匙/冷却中的跳过。 */
function 路由候选(d, 现在 = Date.now()) {
  const 序 = 模型序(d)
  const 槽 = 槽序(d)
  const 全部 = (d.slots || [])
    .filter((s) => s.停用 !== true && s.key)
    .map((s, i) => ({
      s,
      i,
      位: (() => { const k = 序.indexOf(型名(s)); return k < 0 ? 999 : k })(),
      槽: (() => { const k = 槽.indexOf(String(s.id)); return k < 0 ? 999 : k })(),
      倍: 有效倍率(s, 现在),
    }))
    .sort((a, b) => a.位 - b.位 || a.倍 - b.倍 || a.槽 - b.槽 || a.i - b.i)
  const 热 = 全部.filter((x) => !(Number(x.s.coolUntil) > 现在))
  return 热.length ? 热 : 全部
}

// ── Anthropic 4锚点缓存注入 ──────────────────────────────────────────────
function 注入Anthropic缓存与模型(rawBody, targetModel) {
  try {
    const j = JSON.parse(rawBody)
    if (!j || typeof j !== 'object') return rawBody
    if (targetModel) j.model = targetModel
    let existing = 0
    const countCc = (arr) => {
      if (!Array.isArray(arr)) return
      for (const x of arr) if (x && typeof x === 'object' && x.cache_control) existing++
    }
    countCc(j.tools)
    countCc(j.system)
    if (Array.isArray(j.messages)) {
      for (const m of j.messages) {
        if (m && Array.isArray(m.content)) countCc(m.content)
      }
    }
    if (Array.isArray(j.tools) && j.tools.length > 0 && existing < 4) {
      const last = j.tools[j.tools.length - 1]
      if (last && typeof last === 'object' && !last.cache_control) {
        last.cache_control = { type: 'ephemeral' }
        existing++
      }
    }
    if (Array.isArray(j.system) && j.system.length > 0) {
      if (j.system.length >= 2 && existing < 4) {
        const s2 = j.system[j.system.length - 2]
        if (s2 && typeof s2 === 'object' && !s2.cache_control) {
          s2.cache_control = { type: 'ephemeral' }
          existing++
        }
      }
      const tail = j.system[j.system.length - 1]
      if (tail && typeof tail === 'object' && !tail.cache_control && existing < 3) {
        tail.cache_control = { type: 'ephemeral' }
        existing++
      }
    }
    if (Array.isArray(j.messages) && j.messages.length >= 4 && existing < 4) {
      const m = j.messages[j.messages.length - 2]
      if (m && typeof m === 'object') {
        if (typeof m.content === 'string' && m.content.length > 0) {
          m.content = [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
        } else if (Array.isArray(m.content) && m.content.length > 0) {
          const lb = m.content[m.content.length - 1]
          if (lb && typeof lb === 'object' && !lb.cache_control && lb.type !== 'thinking') {
            lb.cache_control = { type: 'ephemeral' }
          }
        }
      }
    }
    return JSON.stringify(j)
  } catch { return rawBody }
}

function 拼Anthropic地址(base) {
  const b = String(base || 'https://api.deepseek.com/anthropic').trim().replace(/\/+$/, '')
  if (b.endsWith('/v1/messages')) return b
  if (b.endsWith('/v1')) return b + '/messages'
  return b + '/v1/messages'
}

function 拼OpenAI地址(base) {
  const b = String(base || 'https://portdan.com').trim().replace(/\/+$/, '')
  if (b.endsWith('/chat/completions')) return b
  if (b.endsWith('/v1')) return b + '/chat/completions'
  return b + '/v1/chat/completions'
}

// ── 请求整形：砍历史里的死重，别让上游按字数吃额度 ──────────────────────
// THINKING_STRIP 2026-11-24：上游 thinking 块被转成文本塞回历史，每轮重发几百上千字
// 英文「Analyzed system instructions」，既费额度又污染人设。只剥开头的 thinking JSON。
function 去思考(t) {
  if (typeof t !== 'string' || t[0] !== '{') return t
  let s = t
  while (s.startsWith('{"type":"thinking"')) {
    let depth = 0, inStr = false, esc = false, end = -1
    for (let i = 0; i < s.length; i++) {
      const c = s[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\') esc = true
        else if (c === '"') inStr = false
      } else if (c === '"') inStr = true
      else if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end < 0) return s
    s = s.slice(end)
  }
  return s
}

function 截工具结果(t) {
  if (typeof t !== 'string' || t.length <= 工具结果上限字) return t
  const 头 = Math.floor(工具结果上限字 * 0.7)
  const 尾 = Math.floor(工具结果上限字 * 0.25)
  return t.slice(0, 头)
    + `\n\n…（中间省略 ${t.length - 头 - 尾} 字，原文在会话备份里，需要再读）…\n\n`
    + t.slice(-尾)
}

// 整形后仍超整包上限：从最老的整轮开始丢，保留 system 和最后两轮。
function 收口请求(reqObj, 上限) {
  if (JSON.stringify(reqObj).length <= 上限) return reqObj
  const msgs = Array.isArray(reqObj.messages) ? reqObj.messages : []
  const 头 = msgs[0] && msgs[0].role === 'system' ? [msgs[0]] : []
  const 组 = []
  for (let i = 头.length; i < msgs.length; i++) {
    if (msgs[i].role === 'user' || 组.length === 0) 组.push([])
    组[组.length - 1].push(msgs[i])
  }
  while (组.length > 2 && JSON.stringify({ ...reqObj, messages: [...头, ...组.flat()] }).length > 上限) 组.shift()
  const 留 = [...头, ...组.flat()]
  if (留.length > 头.length) 留.splice(头.length, 0, { role: 'user', content: '…（更早的往来已省略，接着最后一轮继续）…' })
  reqObj.messages = 留
  return reqObj
}

// ── Anthropic 请求体 → OpenAI Chat Completions 请求体 无损转译 ────────────
function 转OpenAI请求(anthJson, targetModel) {
  const outMsgs = []
  if (anthJson.system) {
    const sysTxt = typeof anthJson.system === 'string'
      ? anthJson.system
      : (Array.isArray(anthJson.system)
          ? anthJson.system.map((b) => (typeof b === 'string' ? b : (b?.text || ''))).filter(Boolean).join('\n\n')
          : '')
    if (sysTxt) outMsgs.push({ role: 'system', content: sysTxt })
  }

  for (const m of (anthJson.messages || [])) {
    if (!m || !m.role) continue
    if (typeof m.content === 'string') {
      outMsgs.push({ role: m.role, content: m.content })
      continue
    }
    if (!Array.isArray(m.content)) continue

    if (m.role === 'assistant') {
      let textAcc = ''
      const toolCalls = []
      for (const blk of m.content) {
        if (!blk || typeof blk !== 'object') continue
        if (blk.type === 'text' && blk.text) textAcc += 去思考(blk.text)
        else if (blk.type === 'tool_use') {
          toolCalls.push({
            id: String(blk.id || ('call_' + randomUUID().slice(0, 12))),
            type: 'function',
            function: {
              name: String(blk.name || ''),
              arguments: typeof blk.input === 'string' ? blk.input : JSON.stringify(blk.input || {}),
            },
          })
        }
      }
      const msgObj = { role: 'assistant', content: textAcc || (toolCalls.length ? null : '') }
      if (toolCalls.length) msgObj.tool_calls = toolCalls
      outMsgs.push(msgObj)
    } else {
      // user role: may mix tool_result blocks + text/image blocks
      const toolResults = []
      const parts = []
      for (const blk of m.content) {
        if (!blk || typeof blk !== 'object') continue
        if (blk.type === 'tool_result') {
          let cText = ''
          if (typeof blk.content === 'string') cText = blk.content
          else if (Array.isArray(blk.content)) {
            cText = blk.content.map((sub) => {
              if (typeof sub === 'string') return sub
              if (sub?.type === 'text') return sub.text || ''
              return JSON.stringify(sub)
            }).join('\n')
          } else if (blk.content != null) cText = JSON.stringify(blk.content)
          cText = 截工具结果(cText)
          toolResults.push({
            role: 'tool',
            tool_call_id: String(blk.tool_use_id || ''),
            content: cText || '(empty)',
          })
        } else if (blk.type === 'text' && blk.text) {
          parts.push({ type: 'text', text: blk.text })
        } else if (blk.type === 'image' && blk.source) {
          const url = blk.source.type === 'url'
            ? blk.source.url
            : `data:${blk.source.media_type || 'image/png'};base64,${blk.source.data || ''}`
          if (url.length > 图片上限字) {
            parts.push({ type: 'text', text: `[图片太大这轮略过：base64 ${Math.round(url.length / 1024)}KB。要看细节就重新发一张小图。]` })
          } else {
            parts.push({ type: 'image_url', image_url: { url } })
          }
        }
      }
      for (const tr of toolResults) outMsgs.push(tr)
      if (parts.length === 1 && parts[0].type === 'text') {
        outMsgs.push({ role: 'user', content: parts[0].text })
      } else if (parts.length > 0) {
        outMsgs.push({ role: 'user', content: parts })
      }
    }
  }

  const reqObj = {
    model: targetModel || anthJson.model || 'gemini-4-carbon',
    messages: outMsgs,
    stream: Boolean(anthJson.stream),
  }
  if (anthJson.max_tokens) reqObj.max_tokens = Number(anthJson.max_tokens)
  if (anthJson.temperature !== undefined) reqObj.temperature = anthJson.temperature
  if (anthJson.stream) reqObj.stream_options = { include_usage: true }

  if (Array.isArray(anthJson.tools) && anthJson.tools.length > 0) {
    reqObj.tools = anthJson.tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description || '',
        parameters: t.input_schema || { type: 'object', properties: {} },
      },
    }))
  }
  return reqObj
}

// ── 将 OpenAI 响应（流式或非流式）实时写回为标准 Anthropic 响应 ──────────
async function 桥接OpenAI响应(upRes, clientRes, isStream, modelName, onUsage) {
  const msgId = 'msg_' + randomUUID().replace(/-/g, '').slice(0, 24)
  if (!isStream) {
    const j = await upRes.json()
    const ch = (j.choices && j.choices[0]) || {}
    const msg = ch.message || {}
    const content = []
    if (msg.reasoning_content) {
      try { if (记思考()) 记一条(String(msg.reasoning_content), 0) } catch (e) { console.error('[接口网关]', e && e.message) }
      content.push({ type: 'thinking', thinking: String(msg.reasoning_content), signature: '' })
    }
    if (msg.content) {
      content.push({ type: 'text', text: String(msg.content) })
    }
    const tcs = Array.isArray(msg.tool_calls) ? msg.tool_calls : []
    for (const tc of tcs) {
      let inp = {}
      try { inp = JSON.parse(tc.function?.arguments || '{}') } catch (e) { console.error('[接口网关]', e && e.message) }
      content.push({
        type: 'tool_use',
        id: tc.id || ('toolu_' + randomUUID().slice(0, 12)),
        name: tc.function?.name || 'unknown',
        input: inp,
      })
    }
    if (!content.length) content.push({ type: 'text', text: '' })
    const u = j.usage || {}
    const inTok = Number(u.prompt_tokens || 0)
    const outTok = Number(u.completion_tokens || 0)
    const cacheRead = Number(u.prompt_cache_hit_tokens || u.prompt_tokens_details?.cached_tokens || 0)
    onUsage({ inTok, outTok, cacheRead })
    const anthOut = {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: modelName,
      content,
      stop_reason: tcs.length ? 'tool_use' : (ch.finish_reason === 'length' ? 'max_tokens' : 'end_turn'),
      stop_sequence: null,
      usage: { input_tokens: Math.max(0, inTok - cacheRead), output_tokens: outTok, cache_read_input_tokens: cacheRead },
    }
    const s = JSON.stringify(anthOut)
    clientRes.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    clientRes.end(s)
    return
  }

  // Stream mode: translate OpenAI SSE -> Anthropic SSE
  clientRes.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })
  const sendEvt = (event, data) => {
    clientRes.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  sendEvt('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      model: modelName,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  })

  let blockIdx = -1
  let curBlockType = '' // 'thinking' | 'text' | 'tool_use'
  const openTools = new Map() // oai tool index -> { anthIdx, id, name }
  let sawToolCall = false
  let finishReason = 'end_turn'
  let inTok = 0, outTok = 0, cacheRead = 0
  // USAGE_EST 2026-11-23：gemini-web2api 的流里常常只有 prompt_tokens，completion_tokens 是 0，
  // 用量页的「出」就一直显示 0。这里按实际吐出来的字数估一个值，并在流水里标「出估算」。
  let outChars = 0
  // THINK_LOG 2026-11-24：把 thinking 旁路写进 记忆/思考流.jsonl，面板「思考」页才有东西看。
  let thinkBuf = ''
  let thinkStart = 0

  const closeCurNonToolBlock = () => {
    if (curBlockType === 'thinking' || curBlockType === 'text') {
      sendEvt('content_block_stop', { type: 'content_block_stop', index: blockIdx })
      curBlockType = ''
    }
  }

  const dec = new TextDecoder()
  let buf = ''
  try {
  for await (const chunk of upRes.body) {
    buf += dec.decode(chunk, { stream: true })
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() || ''
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const raw = line.slice(5).trim()
      if (!raw || raw === '[DONE]') continue
      let pkt
      try { pkt = JSON.parse(raw) } catch { continue }
      if (pkt.usage) {
        inTok = Number(pkt.usage.prompt_tokens || inTok)
        outTok = Number(pkt.usage.completion_tokens || outTok)
        cacheRead = Number(pkt.usage.prompt_cache_hit_tokens || pkt.usage.prompt_tokens_details?.cached_tokens || cacheRead)
      }
      const ch = pkt.choices && pkt.choices[0]
      if (!ch) continue
      if (ch.finish_reason) {
        if (ch.finish_reason === 'tool_calls') finishReason = 'tool_use'
        else if (ch.finish_reason === 'length') finishReason = 'max_tokens'
      }
      const d = ch.delta || {}

      if (d.reasoning_content) {
        if (记思考()) { if (!thinkStart) thinkStart = Date.now(); thinkBuf += String(d.reasoning_content) }
        outChars += String(d.reasoning_content).length
        if (curBlockType !== 'thinking') {
          closeCurNonToolBlock()
          blockIdx++
          curBlockType = 'thinking'
          sendEvt('content_block_start', {
            type: 'content_block_start',
            index: blockIdx,
            content_block: { type: 'thinking', thinking: '' },
          })
        }
        sendEvt('content_block_delta', {
          type: 'content_block_delta',
          index: blockIdx,
          delta: { type: 'thinking_delta', thinking: String(d.reasoning_content) },
        })
      }

      if (d.content) {
        outChars += String(d.content).length
        if (curBlockType !== 'text') {
          closeCurNonToolBlock()
          blockIdx++
          curBlockType = 'text'
          sendEvt('content_block_start', {
            type: 'content_block_start',
            index: blockIdx,
            content_block: { type: 'text', text: '' },
          })
        }
        sendEvt('content_block_delta', {
          type: 'content_block_delta',
          index: blockIdx,
          delta: { type: 'text_delta', text: String(d.content) },
        })
      }

      if (Array.isArray(d.tool_calls)) {
        closeCurNonToolBlock()
        sawToolCall = true
        for (const tc of d.tool_calls) {
          const ti = Number(tc.index ?? 0)
          let meta = openTools.get(ti)
          if (!meta) {
            blockIdx++
            meta = {
              anthIdx: blockIdx,
              id: tc.id || ('toolu_' + randomUUID().slice(0, 12)),
              name: tc.function?.name || 'tool',
            }
            openTools.set(ti, meta)
            sendEvt('content_block_start', {
              type: 'content_block_start',
              index: meta.anthIdx,
              content_block: { type: 'tool_use', id: meta.id, name: meta.name, input: {} },
            })
          }
          if (tc.function?.arguments) {
            outChars += String(tc.function.arguments).length
            sendEvt('content_block_delta', {
              type: 'content_block_delta',
              index: meta.anthIdx,
              delta: { type: 'input_json_delta', partial_json: String(tc.function.arguments) },
            })
          }
        }
      }
    }
  }
  } catch (e) {
    // 上游流被超时或断开时，for-await 会抛 TimeoutError；以前没人接，整个网关进程直接退出。
    // 现在只收尾，给客户端一个 error 事件，让宿主按回合失败重试。
    try { sendEvt('error', { type: 'error', error: { type: 'upstream_aborted', message: String(e?.message || e).slice(0, 160) } }) } catch (e) { console.error('[接口网关]', e && e.message) }
    try { clientRes.end() } catch (e) { console.error('[接口网关]', e && e.message) }
    return
  }

  closeCurNonToolBlock()
  for (const meta of openTools.values()) {
    sendEvt('content_block_stop', { type: 'content_block_stop', index: meta.anthIdx })
  }
  if (blockIdx < 0) {
    blockIdx = 0
    sendEvt('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
    sendEvt('content_block_stop', { type: 'content_block_stop', index: 0 })
  }

  try { if (thinkBuf) 记一条(thinkBuf, thinkStart) } catch (e) { console.error('[接口网关]', e && e.message) }
  const 出估算 = !outTok && outChars > 0
  if (出估算) outTok = Math.max(1, Math.round(outChars / 1.6))
  onUsage({ inTok, outTok, cacheRead, 估算: 出估算 })
  sendEvt('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: sawToolCall ? 'tool_use' : finishReason, stop_sequence: null },
    usage: {
      input_tokens: Math.max(0, inTok - cacheRead),
      output_tokens: outTok,
      cache_read_input_tokens: cacheRead,
    },
  })
  sendEvt('message_stop', { type: 'message_stop' })
  clientRes.end()
}

// ── 单槽位请求派发 ────────────────────────────────────────────────────────
async function 请求槽位(slot, rawBody, parsedBody) {
  const key = 解析钥匙(slot.key)
  if (!key) return { ok: false, status: 0, err: '未配置 API Key' }
  const proto = slot.protocol === 'openai' ? 'openai' : 'anthropic'
  const t0 = Date.now()
  try {
    if (proto === 'openai') {
      const oaiReq = 收口请求(转OpenAI请求(parsedBody, slot.model), 输入上限)
      const url = 拼OpenAI地址(slot.base)
      // SLOT_TIMEOUT 2026-11-24：neon-thinking 实测 12s ~ 520s 都有，180s 的旧上限
      // 让她一句话能卡三分钟。聊天（不带 tools）90 秒还不回就别等了，换下一槽；
      // 带 tools 的请求放宽到 150 秒（视频/工具往返实测最长 35 秒，留够余量）。
      const 超时 = Number(process.env.DSH_SLOT_TIMEOUT_MS || (Array.isArray(parsedBody?.tools) && parsedBody.tools.length ? 150000 : 60000))
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + key,
        },
        body: JSON.stringify(oaiReq),
        signal: AbortSignal.timeout(超时),
      })
      if (!r.ok) {
        const errTxt = (await r.text().catch(() => '')).slice(0, 180)
        return { ok: false, status: r.status, err: `HTTP ${r.status}: ${errTxt}`, ms: Date.now() - t0 }
      }
      return { ok: true, proto: 'openai', res: r, ms: Date.now() - t0 }
    } else {
      const anthBody = 注入Anthropic缓存与模型(rawBody, slot.model)
      const url = 拼Anthropic地址(slot.base)
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': key,
          Authorization: 'Bearer ' + key,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'prompt-caching-2024-07-31',
        },
        body: anthBody,
        // SLOT_TIMEOUT_PARITY 2026-11-24：openai 分支早就能配（带 tools 150s / 裸聊 60s），
        // 这条 anthropic 却硬编码 180000 —— 注释里「180s 让她一句话能卡三分钟」的修复只做了一半。
        // 现在跟 openai 同一个算法，同一个环境变量。
        signal: AbortSignal.timeout(Number(process.env.DSH_SLOT_TIMEOUT_MS
          || (Array.isArray(parsedBody?.tools) && parsedBody.tools.length ? 150000 : 60000))),
      })
      if (!r.ok) {
        const errTxt = (await r.text().catch(() => '')).slice(0, 180)
        return { ok: false, status: r.status, err: `HTTP ${r.status}: ${errTxt}`, ms: Date.now() - t0 }
      }
      return { ok: true, proto: 'anthropic', res: r, ms: Date.now() - t0 }
    }
  } catch (e) {
    return { ok: false, status: 0, err: String(e?.message || e).slice(0, 160), ms: Date.now() - t0 }
  }
}

// ── 极小探针（面板「验活测速」按钮用） ──────────────────────────────────
async function 探针测槽位(slot) {
  const sample = {
    model: slot.model || 'deepseek-flash',
    max_tokens: 12,
    messages: [{ role: 'user', content: 'reply with 1 word: meow' }],
    stream: false,
  }
  const r = await 请求槽位(slot, JSON.stringify(sample), sample)
  if (!r.ok) return { ok: false, ms: r.ms || 0, msg: r.err || '失败' }
  try {
    const j = await r.res.json()
    let reply = ''
    if (r.proto === 'openai') reply = String(j?.choices?.[0]?.message?.content || '').trim()
    else reply = (j?.content || []).map((c) => c.text || '').join('').trim()
    return { ok: true, ms: r.ms || 0, msg: `${r.ms}ms · "${reply.slice(0, 24) || 'OK'}"` }
  } catch {
    return { ok: true, ms: r.ms || 0, msg: `${r.ms}ms · 连通` }
  }
}

function 发JSON(res, code, obj) {
  const s = JSON.stringify(obj)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(s)
}

const server = createServer(async (req, res) => {
  const url = String(req.url || '/')
  if (req.method === 'GET' && (url === '/health' || url === '/')) {
    const f = 读舰队()
    const 链 = 路由候选(f)
    const 首 = 链[0]
    return 发JSON(res, 200, {
      ok: true,
      service: process.env.HAJIMI_SERVICE_NAME || 'fish-upstream',
      activeSlot: f.activeSlot,
      model: 首 ? 首.s.model : '',
      顺序: 链.slice(0, 6).map((x) => 型名(x.s) + (x.倍 !== 1 ? ' ×' + x.倍 : '')),
    })
  }

  if (url.startsWith('/__fleet/')) {
    // 没配 token 时保持旧行为（只给回环）；配了就只认本实例面板的头。
    if (FLEET_TOKEN && req.headers['x-fleet-token'] !== FLEET_TOKEN) {
      return 发JSON(res, 403, { ok: false, msg: '这家网关的舰队接口只给本实例面板' })
    }
  }

  if (url === '/__fleet/state' && req.method === 'GET') {
    return 发JSON(res, 200, 舰队脱敏快照(读舰队()))
  }

  if (url === '/__fleet/action' && req.method === 'POST') {
    let raw = ''
    for await (const c of req) raw += c
    let body = {}
    try { body = JSON.parse(raw || '{}') } catch { return 发JSON(res, 400, { ok: false, msg: 'JSON 格式不对' }) }
    const d = 读舰队()
    const act = String(body.action || '')

    if (act === 'activate') {
      const target = (d.slots || []).find((s) => s.id === body.id)
      if (!target) return 发JSON(res, 404, { ok: false, msg: '找不到这个接口' })
      const m = 型名(target)
      d.modelOrder = [m, ...模型序(d).filter((x) => x !== m)]
      d.activeSlot = target.id
      target.停用 = false
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: `已把「${型名(target) || target.codename}」设为首选，下一句生效`, state: 舰队脱敏快照(d) })
    }

    if (act === 'setFallback') {
      const target = (d.slots || []).find((s) => s.id === body.id)
      if (!target) return 发JSON(res, 404, { ok: false, msg: '找不到这个接口' })
      d.fallbackSlot = target.id
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: `已把「${型名(target) || target.codename}」设为兜底`, state: 舰队脱敏快照(d) })
    }

    if (act === 'move') {
      const id = String(body.id || '')
      const dir = body.dir === 'up' ? -1 : 1
      const idx = (d.slots || []).findIndex((s) => s.id === id)
      if (idx < 0) return 发JSON(res, 404, { ok: false, msg: '找不到这个接口' })
      const to = idx + dir
      if (to < 0 || to >= d.slots.length) return 发JSON(res, 200, { ok: true, msg: '已经到头了', state: 舰队脱敏快照(d) })
      const [x] = d.slots.splice(idx, 1)
      d.slots.splice(to, 0, x)
      // 列表顺序就是尝试顺序；首选跟着它自己的位置走，不用手动重设
      d.activeSlot = (d.slots.find((s) => s.停用 !== true) || d.slots[0] || {}).id || d.activeSlot
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: '顺序已调整，下一句生效', state: 舰队脱敏快照(d) })
    }

    if (act === 'moveSlot') {
      const id = String(body.id || '')
      const 序 = 槽序(d)
      const from = 序.indexOf(id)
      if (from < 0) return 发JSON(res, 404, { ok: false, msg: '找不到这个接口' })
      const to = Math.max(0, Math.min(序.length - 1, Number.isInteger(body.to) ? Number(body.to) : from + 1))
      if (to === from) return 发JSON(res, 200, { ok: true, msg: '已经到头了', state: 舰队脱敏快照(d) })
      序.splice(from, 1)
      序.splice(to, 0, id)
      d.slotOrder = 序
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: '顺序已调整，下一句生效', state: 舰队脱敏快照(d) })
    }

    if (act === 'toggle') {
      const target = (d.slots || []).find((s) => s.id === body.id)
      if (!target) return 发JSON(res, 404, { ok: false, msg: '找不到这个接口' })
      target.停用 = !(target.停用 === true)
      if (target.停用 && d.activeSlot === target.id) {
        d.activeSlot = (d.slots.find((s) => s.停用 !== true) || {}).id || ''
      }
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: target.停用 ? '已停用，不再参与路由' : '已启用', state: 舰队脱敏快照(d) })
    }

    if (act === 'setModelOrder') {
      const 现有 = new Set(模型序(d))
      const 传入 = Array.isArray(body.order) ? body.order.map((x) => String(x)).filter((m) => 现有.has(m)) : []
      d.modelOrder = [...new Set(传入)]
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: '型号优先级已保存，下一句生效', state: 舰队脱敏快照(d) })
    }

    if (act === 'setModels') {
      const 名们 = Array.isArray(body.models) ? [...new Set(body.models.map((x) => String(x).trim()).filter(Boolean))] : []
      d.modelOrder = 名们
      d.customModels = 名们
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: '型号列表已保存', state: 舰队脱敏快照(d) })
    }

    if (act === 'saveSlot') {
      const incoming = body.slot || {}
      const id = String(incoming.id || ('slot-' + Date.now().toString(36)))
      let idx = (d.slots || []).findIndex((s) => s.id === id)
      const prev = idx >= 0 ? d.slots[idx] : {}
      const nextKey = incoming.key === undefined || incoming.key === '__KEEP__'
        ? (prev.key || '')
        : (incoming.key === '-' ? '' : String(incoming.key || '').trim())
      const merged = {
        id,
        codename: String(incoming.codename ?? prev.codename ?? incoming.model ?? prev.model ?? '').trim().slice(0, 48),
        faction: ['gemini', 'claude', 'gpt', 'grok', 'deepseek', 'cn'].includes(incoming.faction) ? incoming.faction : (prev.faction || 'gemini'),
        badge: String(incoming.badge ?? prev.badge ?? '🐾').trim().slice(0, 8),
        roleTag: String(incoming.roleTag ?? prev.roleTag ?? '特种打工人').trim().slice(0, 40),
        // 不传 protocol 时保留原值。以前这里默认 anthropic，改个备注/倍率就把 openai 槽打回
        // anthropic，接着每次请求都撞 8083 的 404（2026-11-23 实测把 7 个槽连续打崩两次）。
        protocol: incoming.protocol === 'openai' || incoming.protocol === 'anthropic'
          ? incoming.protocol
          : (prev.protocol === 'openai' ? 'openai' : 'anthropic'),
        base: String(incoming.base ?? prev.base ?? 'https://portdan.com').trim(),
        key: nextKey,
        model: String(incoming.model ?? prev.model ?? '').trim(),
        note: String(incoming.note ?? prev.note ?? '').trim().slice(0, 140),
        别名: String(incoming.别名 ?? prev.别名 ?? incoming.model ?? prev.model ?? '').trim().slice(0, 48),
        停用: incoming.停用 === undefined ? (prev.停用 === true) : incoming.停用 === true,
        倍率: incoming.倍率 == null || incoming.倍率 === '' ? (prev.倍率 == null ? 1 : Number(prev.倍率)) : Number(incoming.倍率),
        峰谷: incoming.峰谷 === undefined ? (prev.峰谷 === true) : incoming.峰谷 === true,
        峰倍率: incoming.峰倍率 == null || incoming.峰倍率 === '' ? (prev.峰倍率 ?? null) : Number(incoming.峰倍率),
        谷倍率: incoming.谷倍率 == null || incoming.谷倍率 === '' ? (prev.谷倍率 ?? null) : Number(incoming.谷倍率),
        stats: prev.stats || { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' },
      }
      if (!merged.model) return 发JSON(res, 400, { ok: false, msg: '模型 ID 不能为空' })
      if (idx >= 0) d.slots[idx] = merged
      else d.slots.push(merged)
      if (body.activateNow) d.activeSlot = id
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: `接口「${merged.model}」已保存${body.activateNow ? '并设为首选' : ''}`, state: 舰队脱敏快照(d) })
    }

    if (act === 'deleteSlot') {
      const id = String(body.id || '')
      if ((d.slots || []).length <= 1) return 发JSON(res, 400, { ok: false, msg: '至少留一个接口' })
      d.slots = (d.slots || []).filter((s) => s.id !== id)
      if (d.activeSlot === id) d.activeSlot = d.slots[0].id
      if (d.fallbackSlot === id) d.fallbackSlot = d.slots[0].id
      写舰队(d)
      return 发JSON(res, 200, { ok: true, msg: '接口已移除', state: 舰队脱敏快照(d) })
    }

    if (act === 'probe') {
      const target = (d.slots || []).find((s) => s.id === body.id)
      if (!target) return 发JSON(res, 404, { ok: false, msg: '找不到这个接口' })
      const pr = await 探针测槽位(target)
      target.stats = target.stats || { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' }
      target.stats.latencyMs = pr.ms
      target.stats.lastAt = 京分()
      target.stats.lastErr = pr.ok ? '' : pr.msg
      写舰队(d)
      return 发JSON(res, 200, { ok: pr.ok, msg: pr.msg, state: 舰队脱敏快照(d) })
    }

    return 发JSON(res, 400, { ok: false, msg: '未知操作：' + act })
  }

  // ── 模型推理主入口 (/v1/messages) ──────────────────────────────────────
  if (req.method === 'POST' && url.includes('/messages')) {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const rawBody = Buffer.concat(chunks).toString('utf8')
    let parsed = {}
    try { parsed = JSON.parse(rawBody) } catch { return 发JSON(res, 400, { error: { message: 'invalid json' } }) }

    // CONTEXT_GUARD 2026-11-24：正常超长交给 收口请求 砍历史；这里只挡那种一眼就不该发的怪兽包。
    if (rawBody.length > 输入上限 * 20) {
      记日志({ 事: '上下文过大', 字: rawBody.length, 上限: 输入上限 })
      return 发JSON(res, 400, { error: {
        type: 'context_overflow',
        message: `上下文约 ${rawBody.length} 字（≈${Math.round(rawBody.length * 0.75)} tokens），离谱到没法整形；先压缩或开新会话再试` } })
    }

    const d = 读舰队()
    const candidates = 路由候选(d).map((x) => x.s)

    let chosen = null
    let attempt = null
    const errs = []

    // 整轮预算：单槽超时只管一次尝试，7 个槽轮流超时能拖成 10 分钟。
    // 聊天给 150 秒总预算、带 tools 给 240 秒；过了就认输，让宿主那边按 502 处理。
    const 总预算 = Number(process.env.DSH_TOTAL_BUDGET_MS || (Array.isArray(parsed.tools) && parsed.tools.length ? 240000 : 150000))
    const 起跑 = Date.now()
    for (const sl of candidates) {
      if (Date.now() - 起跑 > 总预算) { errs.push('总预算用完'); break }
      sl.stats = sl.stats || { calls: 0, ok: 0, latencyMs: 0, lastAt: '', lastErr: '' }
      sl.stats.calls = (Number(sl.stats.calls) || 0) + 1
      const r = await 请求槽位(sl, rawBody, parsed)
      if (r.ok) {
        sl.stats.ok = (Number(sl.stats.ok) || 0) + 1
        sl.stats.latencyMs = r.ms
        sl.stats.lastAt = 京分()
        sl.stats.lastErr = ''
        sl.coolUntil = 0
        chosen = sl
        attempt = r
        break
      } else {
        sl.stats.lastAt = 京分()
        sl.stats.lastErr = r.err
        sl.coolUntil = Date.now() + 冷却时长(r.err)
        errs.push(`${sl.codename}(${r.err})`)
      }
    }
    try { 写舰队(d) } catch (e) { console.error('[接口网关]', e && e.message) }

    if (!chosen || !attempt) {
      记日志({ 事: '全挂', 错: errs })
      return 发JSON(res, 502, { type: 'error', error: { type: 'api_error', message: '所有接口都失败了：' + errs.join('；') } })
    }

    const tStart = Date.now()
    if (attempt.proto === 'openai') {
      await 桥接OpenAI响应(attempt.res, res, Boolean(parsed.stream), chosen.model, ({ inTok, outTok, cacheRead, 估算 }) => {
        记用量({
          ...请求体量(parsed),
          上游: chosen.codename,
          模型: chosen.model,
          用途: '{{BOT_DISPLAY}}对话',
          入: inTok,
          出: outTok,
          出估算: Boolean(估算),
          缓读: cacheRead,
          缓读已知: true,
          缓写: 0,
          思考: 0,
          用时毫秒: Date.now() - tStart + (attempt.ms || 0),
        })
      })
      return
    }

    // Anthropic native response passthrough + usage sniffing
    const headers = {}
    for (const [k, v] of attempt.res.headers.entries()) {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection'].includes(k.toLowerCase())) {
        headers[k] = v
      }
    }
    res.writeHead(attempt.res.status, headers)
    let tailBuf = ''
    let inTok = 0, outTok = 0, cacheRead = 0, cacheCreate = 0
    const dec = new TextDecoder()
    try {
      for await (const chunk of attempt.res.body) {
        res.write(chunk)
        tailBuf = (tailBuf + dec.decode(chunk, { stream: true })).slice(-8192)
      }
      res.end()
    } catch (e) {
      // 同上：透传流被超时打断时只收尾，不能让进程崩。
      try { res.end() } catch (e) { console.error('[接口网关]', e && e.message) }
      return
    }
    try {
      for (const line of tailBuf.split(/\r?\n/)) {
        const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim()
        if (!s.startsWith('{')) continue
        const j = JSON.parse(s)
        const u = j.usage || j.message?.usage
        if (u) {
          if (u.input_tokens != null) inTok = Number(u.input_tokens)
          if (u.output_tokens != null) outTok = Number(u.output_tokens)
          if (u.cache_read_input_tokens != null) cacheRead = Number(u.cache_read_input_tokens)
          if (u.cache_creation_input_tokens != null) cacheCreate = Number(u.cache_creation_input_tokens)
        }
      }
      记用量({
        ...请求体量(parsed),
        上游: chosen.codename,
        模型: chosen.model,
        用途: '{{BOT_DISPLAY}}对话',
        入: inTok + cacheRead + cacheCreate,
        出: outTok,
        缓读: cacheRead,
        缓读已知: true,
        缓写: cacheCreate,
        思考: 0,
        用时毫秒: Date.now() - tStart + (attempt.ms || 0),
      })
    } catch (e) { console.error('[接口网关]', e && e.message) }
    return
  }

  发JSON(res, 404, { ok: false, msg: 'not found' })
})

server.listen(PORT, HOST, () => {
  console.log(`[fish-upstream] API gateway listening on http://${HOST}:${PORT}`)
})
