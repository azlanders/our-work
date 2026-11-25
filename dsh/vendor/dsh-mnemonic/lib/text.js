// 文本提取、切词、时间窗解析与防注入清洗：全部本地、确定性，不联网。
import { createHash } from 'node:crypto'

const TEXT_PARTS = new Set(['text', 'input_text', 'output_text'])
const DAY = 86400000
const DEFAULT_TZ_OFFSET_MS = 8 * 3600000

/** 从一条消息里取出纯文本；兼容 content 为字符串 / 数组两种形态。 */
export function messageText(message) {
  const content = message?.content ?? message?.message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const out = []
  for (const part of content) {
    if (!part) continue
    if (typeof part === 'string') { out.push(part); continue }
    if (!TEXT_PARTS.has(part.type)) continue
    const text = part.text ?? part.value ?? ''
    if (text) out.push(String(text))
  }
  return out.join('\n').trim()
}

export function roleOf(message) {
  return message?.role ?? message?.message?.role ?? ''
}

/**
 * 清洗记忆正文：去掉控制字符，并中和伪造系统/回忆块头部的提示词注入文本。
 */
export function sanitizeMemoryText(text) {
  return String(text ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/【\s*(记忆[·•]|现在|系统指令|SYSTEM)/gi, '[$1')
    .replace(/Current runtime context\./gi, '[runtime-ctx]')
    .trim()
}

const INJECTION_RE = /(?:忽略(?:以上|上面|之前|所有|全部|先前)+(?:的)?(?:指令|规则|提示|设定)|ignore\s+(?:all\s+)?(?:previous|above)\s+instructions|system\s+prompt\s*:|<\|im_start\|>)/i
const NOISE_ONLY_RE = /^(?:[\s\p{P}\p{S}]+|https?:\/\/\S+|(?:哈哈|呵呵|嗯+|哦+|好[的呀啦]?|行|ok|好的|收到|谢谢|晚安|早安|在吗|\?+|？+))$/iu

/** 识别明显提示词注入或无信息量水话，避免自动归档污染长期记忆库。 */
export function isLowValueOrInjection(text) {
  const s = String(text || '').trim()
  if (s.length < 6) return true
  if (INJECTION_RE.test(s)) return true
  if (NOISE_ONLY_RE.test(s)) return true
  return false
}

/**
 * 切词：中文走二元组（bigram）+ 单字兜底，英文/数字走整词。
 * 不引入任何分词依赖——记忆检索要的是召回，不是语言学。
 */
export function tokens(text) {
  const s = String(text || '').toLowerCase()
  const out = []
  const runs = s.match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) || []
  for (const run of runs) {
    if (/^[a-z0-9_]/.test(run)) {
      if (run.length >= 2) out.push(run)
      continue
    }
    if (run.length === 1) { out.push(run); continue }
    for (let i = 0; i + 1 < run.length; i += 1) out.push(run.slice(i, i + 2))
  }
  return out
}

export function tokenSet(text) {
  return new Set(tokens(text))
}

/** 关键词兜底：统计查询里各二元组/词的出现次数。 */
export function queryGrams(text) {
  const map = new Map()
  for (const t of tokens(text)) map.set(t, (map.get(t) || 0) + 1)
  return map
}

// 零延迟本地方言/同义词补充，作为 LLM 查询改写的保底与增强（权重低于原词）。
const LOCAL_EXPAND_RULES = [
  [/全名|叫什么|咋写|怎么称呼|叫啥|名字/, ['名字', '姓名', '称呼', '自称']],
  [/多大|几岁|年龄|年纪|生日/, ['年龄', '岁', '生日']],
  [/住哪|住的|住址|家在哪|哪个城市|什么地方|地址|搬家/, ['住址', '搬家', '搬到', '家']],
  [/欠|答应|约定|说好|承诺|保证/, ['约定', '答应', '欠', '承诺']],
  [/喜欢|讨厌|爱吃|爱喝|偏好|口味|忌口/, ['喜欢', '讨厌', '偏好', '爱', '忌口']],
  [/多少钱|价格|花了|买了|钱/, ['钱', '价格', '元', '买']],
  [/工作|上班|职业|干啥|干什么/, ['工作', '上班', '职业']],
  [/身体|病|疼|不舒服|医院|吃药/, ['身体', '病', '疼', '医院', '药']],
  [/猫|狗|宠物|毛孩子/, ['猫', '狗', '宠物']],
  [/旅游|旅行|出差|机票|酒店|去玩/, ['旅游', '旅行', '出差', '酒店', '机票']],
  [/电影|番剧|动漫|游戏|歌|音乐/, ['电影', '番剧', '游戏', '歌', '音乐']],
  [/服务器|端口|配置|密码|脚本|部署|代码/, ['服务器', '端口', '配置', '密码', '脚本', '部署']],
]

export function expandLocal(query) {
  const s = String(query || '')
  const extra = []
  for (const [re, words] of LOCAL_EXPAND_RULES) {
    if (re.test(s)) extra.push(...words)
  }
  return extra.length ? extra.join(' ') : ''
}

/**
 * 解析中文相对时间表达（按北京时间 UTC+8 对齐），返回 { start, end, label } 或 null。
 * 用于对时间窗内的记忆加权，并在纯时间问句（如「昨天聊了什么」）时提供兜底候选。
 */
export function extractTimeWindow(query, now = Date.now(), tzOffsetMs = DEFAULT_TZ_OFFSET_MS) {
  const s = String(query || '')
  const shifted = new Date(now + tzOffsetMs)
  const y = shifted.getUTCFullYear()
  const m = shifted.getUTCMonth()
  const d = shifted.getUTCDate()
  const startOfToday = Date.UTC(y, m, d) - tzOffsetMs
  const endOfToday = startOfToday + DAY - 1

  if (/今天|今日|刚才|刚刚/.test(s)) {
    return { start: startOfToday, end: endOfToday, label: '今天' }
  }
  if (/昨天|昨日/.test(s)) {
    return { start: startOfToday - DAY, end: startOfToday - 1, label: '昨天' }
  }
  if (/前天|前日/.test(s)) {
    return { start: startOfToday - 2 * DAY, end: startOfToday - DAY - 1, label: '前天' }
  }
  if (/大前天/.test(s)) {
    return { start: startOfToday - 3 * DAY, end: startOfToday - 2 * DAY - 1, label: '大前天' }
  }
  if (/最近|这几天|前几天|近几天/.test(s)) {
    return { start: startOfToday - 7 * DAY, end: endOfToday, label: '最近7天' }
  }
  if (/上周|上星期|上礼拜/.test(s)) {
    const dow = (shifted.getUTCDay() + 6) % 7 // Monday = 0
    const thisMon = startOfToday - dow * DAY
    return { start: thisMon - 7 * DAY, end: thisMon - 1, label: '上周' }
  }
  if (/本周|这周|这星期|这礼拜/.test(s)) {
    const dow = (shifted.getUTCDay() + 6) % 7
    const thisMon = startOfToday - dow * DAY
    return { start: thisMon, end: endOfToday, label: '本周' }
  }
  if (/上个月|上月/.test(s)) {
    const prevStart = Date.UTC(m === 0 ? y - 1 : y, m === 0 ? 11 : m - 1, 1) - tzOffsetMs
    const thisStart = Date.UTC(y, m, 1) - tzOffsetMs
    return { start: prevStart, end: thisStart - 1, label: '上个月' }
  }
  if (/去年/.test(s)) {
    const lastYearStart = Date.UTC(y - 1, 0, 1) - tzOffsetMs
    const thisYearStart = Date.UTC(y, 0, 1) - tzOffsetMs
    return { start: lastYearStart, end: thisYearStart - 1, label: '去年' }
  }
  return null
}

/** 解析 YYYY-MM-DD / ISO 字符串或毫秒时间戳为毫秒数（默认按北京时间 +08:00 解释纯日期）。 */
export function parseEventTimestamp(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const s = String(value).trim()
  if (/^\d{10,13}$/.test(s)) return Number(s)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const t = Date.parse(`${s}T12:00:00+08:00`)
    return Number.isFinite(t) ? t : null
  }
  const t = Date.parse(s)
  return Number.isFinite(t) ? t : null
}

export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, Math.max(0, max - 1)) + '…'
}

export function hash32(text) {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16)
}

/** 48-bit SHA-256 截断哈希（12 位 hex），在百万级记录下几乎零碰撞。 */
export function hashId(text) {
  return 'm' + createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12)
}
