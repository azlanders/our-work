import { atomicWriteFileSync } from './atomic-fs.js'
/**
 * closure.js —— 这段对话是不是可以收了。
 *
 * 思路移植自 github.com/Mieksido/surfcore 的 src/conversation-closure.js（MIT），
 * 但按其公开思路**重写**，没有复制代码 —— 数据结构和阈值都按这边的需求重排过。
 *
 * 为什么要这个东西：
 *   原插件是「消息进来 → 回答 → 转发」，模型永远只能接话，
 *   没有「这段聊完了」这个出口，于是每次都要硬凑一句 —— 这就是所谓的 AI 味。
 *   把「该不该结束」变成一个**可计算、可解释**的判断，模型才知道什么时候该闭嘴。
 *
 * 设计红线（跟它一致的三条）：
 *   1. 纯函数零 I/O：不做网络、不读盘，方便单测，也方便在别处复用。
 *   2. 对方还在提问时**硬判继续** —— 不许用收尾来逃避回答。
 *   3. 判断可解释：每次都给 reasons[]，出了岔子能一眼看出是哪个信号在拉分。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, note } from './env.js'

/** 收尾记录文件。故意不跟游标 state 同一个文件：loadState() 会重建整个对象，塞进去会被丢掉。 */
export const CLOSURE_FILE = join(DATA_DIR, 'qq-bridge-closures.json')

/** 六路信号合并时的权重（同原版：话题闭环最重，己方意图次之，疲劳只是佐证）。 */
export const CLOSURE_WEIGHTS = {
  topicClosure: 0.32,
  ownIntent: 0.24,
  theirIntent: 0.22,
  fatigue: 0.12,
}

/** 落到哪一档的阈值。 */
export const CLOSURE_THRESHOLDS = { close: 0.62, linger: 0.45 }

/** 自己的末句是收尾式 / 附和式时的加分。 */
const OWN_CLOSING_BONUS = 0.18
/** 对方明确道别时的加分。 */
const THEIR_GOODBYE_BONUS = 0.15
/** 有还没回答的问题时的重罚（负值）。 */
const OPEN_QUESTION_PENALTY = -0.35

/**
 * 静默时长（分钟）怎么参与收口判定。2026-11-04 加。
 *
 * 为什么加：只用文本分时，真正的对话结尾和对话中间几乎分不开——
 * 实测正样本（段尾）均分 0.306、负样本（段中）均分 0.263，只差 0.043。
 * 人判断「这段过去了没有」靠的其实是「没人接话了」，不是「最后一句像不像道别」。
 *
 * 阈值依据（/root/qq-audit/tests/silence-curve.mjs，6096 个段内间隔 + 三个群的日志）：
 *   对话还在进行时，相邻两条的间隔 p50=0.1 分、p90=1.0 分、p99=6.2 分、最长 28.4 分；
 *   散场那一侧的间隔 p01=34 分、p10=95 分。
 * 所以：超过 10 分钟已经越过 99% 的正常停顿，半小时以上基本就是散了。
 *
 * 注意「段间」那组是按 30 分钟切段切出来的，拿它证明 30 分钟对是循环论证；
 * 真正站得住的是「段内 p99 = 6.2 分」这个非循环的数。
 */
export const SILENCE = {
  freshMin: 2,      // ≤2 分钟：对方刚说完，这时候收摊太急
  freshBias: -0.10,
  calmMin: 10,      // 10 分钟：正常停顿的上限
  calmBias: 0.05,
  lapsedMin: 30,    // 30 分钟：这段已经散了
  lapsedBias: 0.24,
  goneMin: 60,      // 60 分钟：肯定散了
  goneBias: 0.36,
}

/**
 * 静默时长 → 分数偏置。传入非法值（没传/NaN/负数）时返回 0，保持旧行为。
 * 分段线性，不搞指数衰减：这几段都有实测含义，写成分段更好解释也更好验。
 */
export function silenceBias(minutes) {
  // 坑：Number(null) === 0、Number('') === 0，会被当成「刚静默 0 分钟」去扣分。
  // 「没传」必须显式挡掉，不能只看 Number() 的转换结果。实测这一条让 null 白白多扣 0.10。
  if (minutes === null || minutes === undefined || minutes === '') return 0
  const m = Number(minutes)
  if (!Number.isFinite(m) || m < 0) return 0
  const S = SILENCE
  if (m <= S.freshMin) return S.freshBias
  const lerp = (a, b, va, vb) => va + (vb - va) * ((m - a) / (b - a))
  if (m <= S.calmMin) return lerp(S.freshMin, S.calmMin, S.freshBias, S.calmBias)
  if (m <= S.lapsedMin) return lerp(S.calmMin, S.lapsedMin, S.calmBias, S.lapsedBias)
  if (m <= S.goneMin) return lerp(S.lapsedMin, S.goneMin, S.lapsedBias, S.goneBias)
  return S.goneBias
}

/** 空泛附和：不提供新信息，通常是「嗯 / 哈哈 / 确实」这种。 */
const ACK_WORDS = [
  '嗯', '嗯嗯', '哦', '噢', '好吧', '好', '行', '行吧', '可以', '知道了', '了解', '收到',
  '没问题', '也对', '确实', '好像是', '这样啊', '原来如此', '哈哈', '哈哈哈', '233', '666',
  'ok', 'OK', 'okay', 'soga', '草', '啊这', '好家伙',
]

/** 明确道别 / 收摊词。 */
const ENDING_WORDS = [
  '晚安', '拜拜', 'bye', '再见', '回见', '先撤', '先下了', '下线了', '去忙了', '忙去了',
  '先这样', '改天聊', '回头聊', '有空聊', '睡了', '下次聊', '886', '先睡觉', '告辞',
]

/** 问句：结尾标点、结尾语气词，或含疑问开头。容忍中文里高频的「吗/呢」，只在**结尾**才认，避免中间出现就误判。 */
const QUESTION_RE = /[?？]$|(?:吗|呢|吧)$|怎么|怎么办|怎么样|是什么|为什么|是不是|能不能|有没有|要不要|可不可以|几点|多少|多久|还得|是谁|哪|谁/

/**
 * 商定 / 收工的口语句。2026-11-04 加。
 *
 * 起因：「明天再说吧」「那就按这个来吧」被 QUESTION_RE 的 (?:吗|呢|吧)$ 判成 question，
 * 于是 openQuestion 为真 → 分数 -0.35、level 硬判 continue、qq_close 直接回
 * 「对方还在问/还在求，这会儿不能收摊」。对方明明在收工，系统却在催她继续说。
 *
 * 但**不能**反过来把所有「吧」都当收工：查了 10 个日志共 6249 条真实消息，
 * 52 条以「吧」结尾，其中「记忆还在吧」「没有清掉重要的吧」「换好了吧」
 * 都是真的要一个确认答复，放掉就违反本文件开头那条红线。
 *
 * 所以只认这些明确的「把话题放下」的说法——它们本身就是结论，不需要她再答什么。
 */
const DECISION_PHRASES = [
  '明天再说', '改天再说', '回头再说', '以后再说', '下次再说', '再说吧', '晚点再说',
  '就这样吧', '先这样吧', '先这么着', '先这么定', '说定了', '先不聊', '不聊了',
  '明天聊', '改天聊', '回头聊', '下次聊', '先去忙', '先忙了',
]

/**
 * 「吧」结尾的让步句（上游 0.16.15，2026-11-24 移植）。
 * DECISION_PHRASES 只认整句短语，盖不住「随你吧」「你看这办吧」「也行吧」这类短附和；
 * 它们在 QUESTION_RE 里命中 `吧$` 会被判成提问 → 收尾被锁死。
 * 只认「短句 + 整句匹配」，长句里的「吧」不动。
 */
const YIELD_PATTERNS = [
  /^好吧$/, /^行吧$/, /^好嘛$/, /^得吧$/,
  /^(就|那|那就|要不|算了吧?)?这?样吧$/, /^(就|那|那就)?算了吧$/,
  /^(随|听|依)你(吧|的)?$/, /^(都|全)行吧?$/, /^你(说|定)了算$/, /^你看(着办|着来)吧$/,
  /^(先)?(这样|这么)(吧|着)$/, /^可以吧$/, /^也行吧?$/,
]
const YIELD_MAX_LEN = 8
const isYieldPhrase = (plain) => plain.length <= YIELD_MAX_LEN && YIELD_PATTERNS.some((re) => re.test(plain))

/** 求助 / 指令：这类不算提问，但同样**不能**因为收尾而丢下不理。 */
const REQUEST_RE = /帮我|给我|替我|麻烦你|请你|看一下|查一下|发一下|弄一下|搞一下|整一下|拉我|带上我|记得催|提醒我/

const hasAny = (text, list) => list.some((word) => text.includes(word))
const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0))

/**
 * 一句话属于哪一类。分类只用于后面打分，不需要 100% 准 ——
 * 判错一档只是让分数偏一点，不至于崩。
 *
 * @returns {'empty'|'ending'|'ack'|'question'|'request'|'substantive'}
 */
export function classifyUtterance(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return 'empty'
  const plain = trimmed.replace(/[\s,.!！~～。…、，]+$/g, '')
  if (plain === '') return 'empty'
  const lower = plain.toLowerCase()

  // 2026-11-04 修：求助要排在道别前面。原来「先下了，帮我看看这个报错」先命中道别词，
  // 这句就被归成 ending、openQuestion=false，收口分直接 1.00 → 她收摊走人，把人家求助丢下，
  // 正好违反本文件开头那条红线「对方还在提问时硬判继续」。求助是事情没闭环，必须压过道别。
  if (REQUEST_RE.test(plain)) return 'request'
  // 商定/收工的说法：本身就是结论，不是提问，也不该让她继续追话题
  if (hasAny(plain, DECISION_PHRASES)) return 'ending'
  if (isYieldPhrase(plain)) return 'ack'
  // 道别优先于疑问：「晚安？」「走啦？」仍然是道别
  if (hasAny(lower, ENDING_WORDS)) return 'ending'
  if (QUESTION_RE.test(plain) || QUESTION_RE.test(lower)) return 'question'
  // 短且在附和词表里 → ack（长度 gate：长句里带个「嗯」不算附和）
  if (plain.length <= 8 && hasAny(lower, ACK_WORDS)) return 'ack'
  return 'substantive'
}

/**
 * 疲劳度：最近几轮是不是「越回越短」。
 * 只看我方的发言长度趋势 —— 双方都在缩水是典型的自然收尾信号。
 *
 * @param {Array<{mine?: string, theirs?: string}>} recent 由旧到新
 */
function fatigueScore(recent) {
  const list = (Array.isArray(recent) ? recent : []).slice(-3)
  if (list.length < 2) return 0
  const lens = list.map((pair) => String(pair?.mine ?? '').length)
  if (lens.every((n) => n === 0)) return 0
  let shrinking = 0
  for (let i = 1; i < lens.length; i += 1) {
    if (lens[i] <= lens[i - 1]) shrinking += 1
  }
  const trend = shrinking / (lens.length - 1)
  const shortness = clamp01(1 - Math.max(...lens) / 40)
  return clamp01(trend * 0.6 + shortness * 0.4)
}

/**
 * 这次是不是该结束了。
 *
 * @param {object} input
 * @param {string} input.mine        我最后一句（她这回合最后说的话）
 * @param {string} input.theirs      对方最后一句
 * @param {Array}  [input.recent]    最近几轮 [{mine, theirs}]，用于疲劳判断
 * @param {string} [input.pendingThought] 她还有没有想说没说的（有则不想收）
 * @returns {{score:number, level:'continue'|'linger'|'close', reasons:string[], openQuestion:boolean, myKind:string, theirKind:string}}
 */
export function assessClosure(input) {
  const mine = String(input?.mine ?? '')
  const theirs = String(input?.theirs ?? '')
  const recent = input?.recent ?? []
  const pending = String(input?.pendingThought ?? '').trim()
  // 静默多久了（分钟）。不传就是 undefined → 偏置 0，行为与改前完全一致。
  const silenceMin = input?.silenceMin
  const silenceAdj = silenceBias(silenceMin)
  const hasSilence = silenceMin !== null && silenceMin !== undefined && silenceMin !== ''
    && Number.isFinite(Number(silenceMin)) && Number(silenceMin) >= 0

  const myKind = classifyUtterance(mine)
  const theirKind = classifyUtterance(theirs)
  const reasons = []

  // 对方还在问 / 还在求 → 有没闭环的事，必须继续
  const openQuestion = theirKind === 'question' || theirKind === 'request'

  // 话题是不是闭环：对方这句只是收尾式（道别/附和/没内容）→ 话题没在推进
  const topicClosure = theirKind === 'ending' ? 1
    : theirKind === 'ack' ? 0.8
      : theirKind === 'empty' ? 0.7
        : theirKind === 'question' || theirKind === 'request' ? 0.15
          : 0.4
  if (topicClosure >= 0.8) reasons.push(`对方最后一句是${theirKind === 'ending' ? '道别' : '附和'}，话题没推进`)


  // 我还想不想说：有没说出口的话就不想收
  const ownIntent = pending !== '' ? 0.9
    : (myKind === 'ending' || myKind === 'ack') ? 0.15
      : myKind === 'question' ? 0.8 // 我在等他回答
        : 0.45
  if (pending !== '') reasons.push('我还有想说没说的话')

  // 对方还想不想聊
  const theirIntent = openQuestion ? 1
    : theirKind === 'substantive' ? 0.8
      : theirKind === 'ack' ? 0.35
        : 0.1
  if (openQuestion) reasons.push('对方还在问/还在求，不能丢下')

  const fatigue = fatigueScore(recent)
  if (fatigue >= 0.6) reasons.push('两边都在越回越短')

  let score = topicClosure * CLOSURE_WEIGHTS.topicClosure
    + (1 - ownIntent) * CLOSURE_WEIGHTS.ownIntent
    + (1 - theirIntent) * CLOSURE_WEIGHTS.theirIntent
    + fatigue * CLOSURE_WEIGHTS.fatigue

  if (myKind === 'ending' || myKind === 'ack') {
    score += OWN_CLOSING_BONUS
    reasons.push('我这句本身就是收尾式')
  }
  if (theirKind === 'ending') {
    score += THEIR_GOODBYE_BONUS
    reasons.push('对方明确道别了')
  }
  if (openQuestion) {
    score += OPEN_QUESTION_PENALTY
    reasons.push('有还没回答的问题（重罚）')
  }

  // 2026-11-04：静默时长作为独立偏置计入。放最后、单独一段，
  // 是为了让「只靠文本」的那部分打分保持原样，方便对照和回滚。
  if (silenceAdj !== 0) {
    score += silenceAdj
    const mins = Math.round(Number(silenceMin))
    if (silenceAdj >= 0.2) reasons.push(`对方已经 ${mins} 分钟没动静了，这段散了`)
    else if (silenceAdj < 0) reasons.push('对方刚说完，这会儿收太急')
  }

  score = Math.min(1, Math.max(0, score))

  // 硬规矩：有没答的问题，再高的分也不能收
  // 2026-11-04 修：还有没说完的话时不该直接 close。原来 pendingThought 只抬高己方意图，
  // 实测「对方道别 + 我还有话说」仍算出 0.69 落到 close，那这句话就永远说不出口了。
  const wantMore = pending !== ''
  const level = openQuestion ? 'continue'
    : (wantMore && score >= CLOSURE_THRESHOLDS.close) ? 'linger'
      : (score >= CLOSURE_THRESHOLDS.close ? 'close' : (score >= CLOSURE_THRESHOLDS.linger ? 'linger' : 'continue'))

  const silenceOut = hasSilence
    ? { minutes: Math.round(Number(silenceMin)), bias: Number(silenceAdj.toFixed(3)) }
    : null
  return { score: Number(score.toFixed(3)), level, reasons, openQuestion, myKind, theirKind, silence: silenceOut }
}

/**
 * 「上次收尾距今多久」→ 给人看的说法 + 能不能直接接着聊。
 *
 * 为什么要分档：deliver 会把上一次 qq_close 记的「上次聊到…」带进提示里。
 * 只给内容不给时间，模型就会把 8 小时前的停顿当成刚聊完，一开口"接着上次"。
 * 分界按实测：同一轮对话内间隔 p99 = 6.2 分钟、最长 28.4 分钟；散场那侧 p01 = 34 分钟。
 *
 * @param {number} ageMs 距今毫秒
 * @returns {{minutes: number|null, label: string, resume: boolean}}
 */
export function describeClosingAge(ageMs) {
  // 坑：Number(null)===0、Number('')===0，会被当成「刚才」→ 判成可以接着聊。
  // 「没传」必须显式挡掉，别只看 Number() 的结果。（silenceBias 那儿踩过同一个坑）
  if (ageMs === null || ageMs === undefined || ageMs === '') return { minutes: null, label: '', resume: false }
  const ms = Number(ageMs)
  if (!Number.isFinite(ms) || ms < 0) return { minutes: null, label: '', resume: false }
  const minutes = Math.round(ms / 60000)
  if (minutes <= 10) return { minutes, label: '刚才', resume: true }
  if (minutes <= 30) return { minutes, label: `${minutes} 分钟前`, resume: true }
  // 不用「昨天」：18 小时前可能是今天凌晨，「昨天」是日历概念，靠时长推会算错。
  // peekClosing 24 小时就过期，所以这里最大也就「23 小时前」，照实说就行。
  const hours = Math.max(1, Math.round(minutes / 60))
  return { minutes, label: `${hours} 小时前`, resume: false }
}

/** 给模型看的一行判断说明（放在工具返回值里，让它知道依据）。 */
export function describeClosure(result) {
  const label = result.level === 'close' ? '可以收了' : (result.level === 'linger' ? '再陪一句更好' : '还不该收')
  const why = result.reasons.length > 0 ? `（${result.reasons.join('；')}）` : ''
  return `${label} · ${result.score}${why}`
}

// ---------------------------------------------------------------------------
// 收尾记录：下次唤醒时告诉她「上次聊到哪儿停的」
// ---------------------------------------------------------------------------

let closings = null

function loadClosings() {
  if (closings !== null) return closings
  closings = {}
  try {
    if (existsSync(CLOSURE_FILE)) closings = JSON.parse(readFileSync(CLOSURE_FILE, 'utf8'))
  } catch (error) {
    // 读坏了不静默当空：保留原文件让她自己能捞回来（跟 state.js 的教训一致）
    note('closure', `收尾记录读坏了：${error instanceof Error ? error.message : error}`)
  }
  if (closings === null || typeof closings !== 'object') closings = {}
  return closings
}

/**
 * 记一次收尾。每个会话只留最近 N 条，别无限长。
 * @param {string} key `group:123` / `private:456`
 */
export function saveClosing(key, entry) {
  const table = loadClosings()
  const list = Array.isArray(table[key]) ? table[key] : []
  list.push({
    at: Date.now(),
    summary: String(entry?.summary ?? '').trim().slice(0, 200),
    next: String(entry?.next ?? '').trim().slice(0, 200),
  })
  table[key] = list.slice(-5)
  try {
    atomicWriteFileSync(CLOSURE_FILE, JSON.stringify(table, null, 2), 'utf8')
  } catch (error) {
    note('closure', `收尾记录写失败：${error instanceof Error ? error.message : error}`)
  }
  return true
}

/** 取最近一次收尾（没有就 null）。 */
export function lastClosing(key) {
  const list = loadClosings()[key]
  if (!Array.isArray(list) || list.length === 0) return null
  return list[list.length - 1]
}

/** 「已经带过给模型」的收尾（key:at），避免同一条收尾被反复拼进上下文。 */
const delivered = new Set()

/**
 * 取一条「还没告知过模型」的最新收尾。
 *
 * ⚠️ 为什么要去重：这个提示会拼进每回合的正文里。
 *   不做去重就等于把「表情标记怎么写」那件事重演一遍 ——
 *   同一句话在会话日志里重复上百遍，纯烧 token，还可能被她当成对方说的话复述回去。
 *   一条收尾只带一次，完了就到此为止。
 *
 * @param {string} key
 * @param {number} [maxAgeMs] 超过这个时间的收尾不再提起（默认 24 小时）
 */
export function peekClosing(key, maxAgeMs = 24 * 60 * 60 * 1000) {
  const item = lastClosing(key)
  if (item === null) return null
  const age = Date.now() - Number(item.at)
  if (!Number.isFinite(age) || age > maxAgeMs) return null
  const mark = `${key}:${Number(item.at)}`
  if (delivered.has(mark)) return null
  // 2026-11-04 修：这里原来直接 delivered.add(mark) —— 只要被 peek 过就算「已告知」。
  // 而 deliver.js 在 followup 之前 40 行就 peek 了：后面任何一步抛错、或者换下一个候选会话重试，
  // 这条收尾就被白消耗掉，表现是「qq_close 记了却永远不生效」。改为调用方在投递成功后再 consume。
  return item
}

/** 投递成功之后才把这条收尾标成「已告知」。 */
export function consumeClosing(key, item) {
  if (item === null || item === undefined) return
  const at = Number(item.at)
  if (!Number.isFinite(at)) return
  delivered.add(`${key}:${at}`)
}
