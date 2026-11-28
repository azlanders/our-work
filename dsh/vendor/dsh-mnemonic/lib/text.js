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

/**
 * 取记录里「用户说的那半段」：正文格式是「用户：…\n我：…」，助手的话不能当用户事实。
 * 没有「用户：」前缀的旧记录按整段算，但整条以「我：」开头的说明只有助手独白，返回空。
 * 这个判据原来在 tone/facts/profile/openloops 各写一份且行为不一致，统一到这里。
 */
export function userPartOf(text) {
  const s = String(text ?? '')
  const mark = s.indexOf('用户：')
  if (mark >= 0) {
    const from = mark + 3
    const end = s.indexOf('\n我：', from)
    return (end >= 0 ? s.slice(from, end) : s.slice(from)).trim()
  }
  if (/^\s*我[：:]/.test(s)) return ''
  const end = s.indexOf('\n我：')
  return (end >= 0 ? s.slice(0, end) : s).trim()
}

const INJECTION_RE = /(?:忽略(?:以上|上面|之前|所有|全部|先前)+(?:的)?(?:指令|规则|提示|设定)|ignore\s+(?:all\s+)?(?:previous|above)\s+instructions|system\s+prompt\s*:|<\|im_start\|>)/i
// 纯道歉和纯应声一样没有可记的内容；整句匹配才挡，带正文的「抱歉我今天……」不受影响。
const NOISE_ONLY_RE = /^(?:[\s\p{P}\p{S}]+|https?:\/\/\S+|(?:哈哈|呵呵|嗯+|哦+|好[的呀啦]?|行|ok|好的|收到|谢谢|晚安|早安|在吗|对不起|抱歉|不好意思|\?+|？+))$/iu

/** 识别明显提示词注入或无信息量水话，避免自动归档污染长期记忆库。 */
export function isLowValueOrInjection(text, { minLen = 6 } = {}) {
  const s = String(text || '').trim()
  // 「我换工作了」这种 5 个字的转折比一段闲聊重要得多；短不等于没价值。
  if (s.length < minLen) {
    if (s.length >= 3 && SELF_EVENT_RE.test(s)) return false
    return true
  }
  if (INJECTION_RE.test(s)) return true
  if (NOISE_ONLY_RE.test(s)) return true
  return false
}

// 自述的状态变化：换工作、搬家、分手、住院……短句也要入库，否则画像永远停在旧版本。
const SELF_EVENT_RE = /^(?:我|俺)(?:换|辞|离职|入职|调岗|调去|搬|分手|结婚|订婚|怀孕|生(?:病|了)|住院|确诊|考上|考完|退学|毕业|离婚|改名|改叫|不干|走了|退休)/

// 上游报错/降级文案（余额不足、网关 5xx、连接被重置）不是「我说过的话」，
// 归档进记忆库后会被下轮当事实召回，必须挡在写入口。
const DEGRADED_PREFIX_RE = /^(?:error\b|错误[:：]|报错|出错了?|请求失败|调用失败|\[?(?:api|gateway)\]?\s*error)/i
const DEGRADED_MARK_RE = /(?:ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|connection (?:was forcibly closed|reset)|credits balance is too low|insufficient_user_quota|余额不足|Arrearage|HTTP\s*[45]\d\d)/i
const DEGRADED_MARK_MAX_LEN = 300

/** 判断助手回复是否只是报错/降级占位，而不是真正说过的话。 */
export function isDegradedAssistantText(text) {
  const s = String(text || '').trim()
  if (!s) return true
  if (DEGRADED_PREFIX_RE.test(s)) return true
  return s.length <= DEGRADED_MARK_MAX_LEN && DEGRADED_MARK_RE.test(s)
}

// 一个问题要多个点（「哪些」「分别」「要注意什么」）时，4 条预算往往只够一半。
// 判据必须先是问句：「我今天买了几件衣服」不是多要点提问，别给它放大预算。
// 「要带什么」曾经因为写成「需要?带」漏掉了「要带」；「还欠几件」也没有任何一条命中。
// 不能单放一个「带」字：「皮带多少钱」是单要点，也会被放大成 8 条。
const MULTI_NEED_RE = /哪些|分别|各自|注意什么|(?:需要|要)带|带(?:什么|哪些)|列一下|列出|几件|几个|还有(?:什么|哪些|几)/

export function isMultiNeedQuery(text) {
  const t = String(text || '')
  if (!/(?:[?？]|吗|呢|什么|哪|多少|怎么)/.test(t)) return false
  return MULTI_NEED_RE.test(t)
}

// 纯寒暄/情绪的一句半句，没有要找的信息。这时候翻旧账只会显得「又在提以前的事」。
const CHITCHAT_RE = /^(?:在吗|在不在|早(?:安|呀|啊)?|晚安|哈喽|哈啰|你好|hi|hello|嗨|嗯+|哦+|噢+|好[的呀吧]?|行吧|睡了|困了|累了|无聊|想你|抱抱|摸摸|亲亲|吃(?:饭)?了(?:吗|嘛|没)?|哈哈+)[\s!！。.~～?？]*$/iu

/**
 * 「打算/准备/下周…」这类未来表述不是既成事实：拿它去覆盖现在的住址/称呼，
 * 会让「下个月搬到徐汇」提前变成「已经搬了」。Graphiti 对计划类记录用的是说话时刻
 * 而不是计划发生日，这里做同样的区分。
 */
export function isPlanStatement(text) {
  const s = String(text || '')
  const completed = /已经|搬到了|搬到.{0,6}了|换成.{0,6}了|改成.{0,6}了|现在是|不再是/.test(s)
  return !completed && /打算|准备|计划|以后|过几天|下周|下个月|明年|明天|想要|要搬/.test(s)
}

export function isChitChat(text) {
  const t = String(text || '').trim()
  if (t.length <= 10 && CHITCHAT_RE.test(t)) return true
  // 兜底：去掉标点和语气词后只剩一两个字，基本就是「嗯」「好」「哦」这类应声。
  const core = t.replace(/[\s\p{P}\p{S}]/gu, '').replace(/[呀啊哦呗啦嘛呢哈嗯]+$/u, '')
  if (/[几哪谁多少什么吗]/.test(core)) return false
  return core.length > 0 && core.length <= 2
}

// 「你还记得我上次说的那个事吗」——没点名是什么事，检索词全是虚词，BM25 一条都召不回。
// 这种时候该按「最近聊过什么」倒着数，而不是硬找关键词。
const META_RECALL_RE = /(?:还?记得|记不记得|上次|上回|之前(?:说|讲|聊)|那个事|那件事|我说过|我跟你说)/u
// 「那个电影」「上次那家店」是点名了东西的，正常检索能召回；只有没点名的「那个事」才走最近记录。
const NAMED_THING_RE = /(?:那个|这个|上次(?:说)?的?那个|上次那个|上回那个)(?!事|事情|东西|话)[\u4e00-\u9fff]{1,6}/

export function isMetaRecall(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 40) return false
  if (NAMED_THING_RE.test(t)) return false
  return META_RECALL_RE.test(t)
}

// 原话和问法常常没有一个共同词：「我叫沈知夏，24」与「全名咋写」「多大来着」。
// 写入时按句型补属性词，只进检索权重（keywords），不改变注入给模型的原文。
const ATTRIBUTE_RULES = [
  [/我叫|我的名字|我名字|叫我/, ['名字', '姓名', '全名', '称呼', '自称']],
  [/\d+\s*岁|我今年|周岁/, ['年龄', '多大', '几岁']],
  [/生日|出生|农历|公历/, ['生日', '出生', '日期']],
  [/过敏|忌口|一口不沾/, ['过敏', '忌口', '忌讳']],
  [/上班|工作|职业|入职|客服/, ['工作', '职业', '单位']],
  [/搬到|住在|住址|哪个城市/, ['住址', '城市', '家']],
  [/手机号|电话|联系方式/, ['电话', '号码', '联系']],
]
const ATTRIBUTE_MAX = 12

/** 从一段原话里抽出属性检索词（名字/年龄/生日/忌口/职业/住址/联系方式）。 */
export function attributeKeywords(text, { max = ATTRIBUTE_MAX } = {}) {
  const s = String(text || '')
  if (!s) return []
  const out = []
  for (const [re, words] of ATTRIBUTE_RULES) {
    if (!re.test(s)) continue
    for (const w of words) if (!out.includes(w)) out.push(w)
  }
  return out.slice(0, max)
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
  // 「欠了几件/讲过哪件」问的是还账进度，原话写的是「先还一件，还剩两件」，
  // 两边只有「件」一个共词；补上还账用语才命得中（P01-CASE-001 三档全错在这）。
  [/欠|还欠|讲过|讲到哪|说到哪|兑现|还了没/, ['还', '先还', '还剩', '剩下', '讲', '说']],
  [/喜欢|讨厌|爱吃|爱喝|偏好|口味|忌口/, ['喜欢', '讨厌', '偏好', '爱', '忌口']],
  [/多少钱|价格|花了|买了|钱/, ['钱', '价格', '元', '买']],
  [/工作|上班|职业|干啥|干什么|哪一行|什么行业|做什么的|干哪行/, ['工作', '上班', '职业', '行业', '岗位']],
  [/身体|病|疼|不舒服|医院|吃药/, ['身体', '病', '疼', '医院', '药']],
  [/猫|狗|宠物|毛孩子/, ['猫', '狗', '宠物']],
  [/旅游|旅行|出差|机票|酒店|去玩/, ['旅游', '旅行', '出差', '酒店', '机票']],
  [/电影|番剧|动漫|游戏|歌|音乐/, ['电影', '番剧', '游戏', '歌', '音乐']],
  [/服务器|端口|配置|密码|脚本|部署|代码/, ['服务器', '端口', '配置', '密码', '脚本', '部署']],
]

// 属性类目归一：问法常用上位词（口味/哪台/什么歌），原话用具体实例（美式/电磨/粤语歌）。
// 只补检索词、权重低于原词；触发词必须是明确的类目名词，避免「吃」这种动词过扩。
const CATEGORY_RULES = [
  [/喝的|饮品|饮料|喝啥|喝什么/, ['咖啡', '美式', '拿铁', '茶', '奶茶', '奶', '果汁']],
  [/口味|吃的|吃啥|吃什么|早饭|午饭|晚饭|宵夜|辣不辣/, ['口味', '辣', '甜', '咸', '奶', '咖啡', '美式', '拿铁', '茶', '奶茶', '早饭', '午饭', '晚饭', '宵夜']],
  [/歌单|听啥|听什么|什么歌|流派|曲子|音乐/, ['歌', '歌单', '流派', '曲子', '音乐', '爵士', '粤语']],
  [/哪台|器具|电器|磨豆|咖啡机|手冲|机器/, ['磨豆机', '咖啡机', '电磨', '手摇', '器具', '机器']],
]

export function expandLocal(query) {
  const s = String(query || '')
  const extra = []
  for (const [re, words] of LOCAL_EXPAND_RULES) {
    if (re.test(s)) extra.push(...words)
  }
  // 类目词只做增量：旧规则已给出的词保持原有重复权重，不在这里改变既有排序。
  const seen = new Set(extra)
  for (const [re, words] of CATEGORY_RULES) {
    if (!re.test(s)) continue
    for (const w of words) {
      if (seen.has(w)) continue
      seen.add(w)
      extra.push(w)
    }
  }
  return extra.length ? extra.join(' ') : ''
}

// 存档侧属性归一：口语原话（「我叫沈知夏」「今年36岁」）与问法（「全名咋写」「多大」）
// 没有一个共同词，查询侧扩词救不了。索引时把属性词补进文档，只在检索里用，注入仍是原文。
const DOC_RULES = [
  [/我叫|我的名字|名字是|叫我/, ['名字', '姓名', '全名', '称呼']],
  [/\d+\s*岁|今年\s*\d+|周岁|年龄/, ['年龄', '多大', '几岁']],
  [/生日|出生|农历|公历/, ['生日', '出生']],
  [/过敏|忌口|一口不沾|不吃|不能吃/, ['过敏', '忌口', '忌讳']],
  [/上班|工作|职业|入职|做了?\s*结构|结构设计|学徒|调酒/, ['工作', '职业', '上班']],
  // 职业类的原话很少直接写「工作」：靠岗位词、退下来、兼职/全职这些线索补，
  // 否则「爸妈退休前干什么工作」「阿梅做哪一行」永远命不中。
  [/退休|退下来|当.{1,4}(?:员|工|师|长)|做.{1,6}设计|管图书室|开店|兼职|全职|文案|写作|撰稿/, ['工作', '职业', '岗位', '行业']],
  [/大学读|毕业于|大学学|专业/, ['专业', '学历', '大学']],
  [/搬到|住在|我家|住址|城市|从.+搬/, ['住址', '城市', '家', '搬家']],
  [/手机号|电话|联系方式/, ['电话', '号码', '联系']],
]

export function docExpand(text) {
  const s = String(text || '')
  const extra = []
  for (const [re, words] of DOC_RULES) if (re.test(s)) extra.push(...words)
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
