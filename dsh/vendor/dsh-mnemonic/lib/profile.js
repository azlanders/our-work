// 长期印象：从记录里抽「对方是谁」这类稳定信息，同一槽位只留最新一条。
//
// 为什么单独做一层：情景记忆（这轮聊了什么）回答不了「她怎么称呼自己」，而画像槽位能。
// 学术侧证据（EMem 2026）：纯事件记忆在偏好类问题上只有 32% 正确率；社区侧证据：
// 陪伴场景里用户最先在意的是「它记得我是谁」。两边都指向「画像要和流水账分开」。
//
// 不做的事：不调模型、不猜、不合并语义。只是关键词归类 + 取最新 + 截断。

import { clip, userPartOf } from './text.js'
import { toneOf } from './tone.js'

const SLOT_RULES = [
  // 亲友必须排在最前：一句「我妈睡觉了」同时命中关系和作息，关系才是主语。
  ['亲友', /我妈|我爸|我哥|我姐|我弟|我妹|对象|老公|老婆|男朋友|女朋友|孩子|闺女|儿子/],
  // 「我叫啥来着」「我叫了个外卖」都不是在报名字：疑问词和「了」必须排除，否则画像会被写成「称呼：啥来着」。
  ['称呼', /叫我(?!一声)|称呼我|我叫(?![你他她它这那啥谁哪什么怎几了的])|名字叫|可以叫我/],
  ['住处', /我住在|我家在|搬到|住在.{0,6}(市|区|县|镇)/],
  ['生日', /生日|出生/],
  ['作息', /睡觉|起床|作息|熬夜|睡得|失眠/],
  ['忌口', /不吃|忌口|过敏|不能吃|吃不了/],
  ['工作', /上班|上(?:夜|白|早|晚|中)班|打工|工作|公司|开店|退休|上学|读研|职业/],
]

// 会被「今天上班好累」这种临时情绪污染的词。作废旧记录时必须排除它们，
// 否则一句抱怨就能把「我在便利店上班」从检索里永久抹掉。
const FLEETING_RE = /今天|明天|昨天|刚才|最近|现在|这会儿|一会儿|有点|好累|好烦|累死|烦死|不爽|开心|难过|加班|出差|请假|临时|这周|下周|刚(?:才|从)/

// 覆盖判据按槽位分开写：一句「我在公司加班」也以「我在」开头，用统配正则会把真实职业作废。
// 每个槽位只认定义式说法，宁可不覆盖，也不要把「临时状态」当成「我改主意了」。
const HARD_RULES = [
  // 「我叫你一声」「我的生日礼物」「我不吃这套」都会被宽松正则当成身份陈述，
  // 这三个槽又是一覆盖就作废旧值，认错一次就把真名字/真生日顶掉，所以卡在定义式说法上。
  ['称呼', /^(?:我|俺)(?:叫|就叫)(?![你他她它这那啥谁哪什么怎几了的])|^(?:我|俺)(?:的)?名字(?:是|叫)/],
  ['住处', /^(?:我|俺)(?:住在|家住在|家在|搬到了?|已经搬到)(?![你他她它])/],
  ['生日', /^(?:我|俺)(?:的)?生日(?:是|在|\d|每?年|过)/],
  ['忌口', /^(?:我|俺)(?:不吃|忌口|不能吃|吃不了)(?![这那套])|^(?:我|俺)对.{1,8}过敏/],
  // 「我换工作了，现在在便利店上夜班」是明确的职业变更，必须能覆盖旧值，不能因为带「现在」被当成临时状态。
  // 「上夜班 / 上白班 / 打工」也是职业陈述：只认「上班」会把「我在便利店上夜班」漏掉。
  ['工作', /^(?:我|俺)(?:在|于).{1,14}(?:上班|工作|读书|上学|读研|上(?:夜|白|早|晚|中)班|打工)|^(?:我|俺)(?:是|做).{0,4}(?:老师|医生|护士|程序员|设计师|会计|销售|司机|店主|老板|工人|服务员|学生|研究生|律师|警察)|^(?:我|俺)(?:换(?:了|个)?工作|转行|改行|换到|调到)/],
  // 「每天/一般/通常」不能省：「我今天10点睡的」是当天状态，省了就把「我每天十一点睡」作废掉。
  ['作息', /^(?:我|俺)(?:每天|一般|通常|平时).{0,6}(?:\d{1,2}点(?:半)?|\d{1,2}:\d{2})(?:睡|起)|^(?:我|俺)(?:每天|一般|通常|平时).{0,6}(?:睡|起)/],
]

const PROFILE_MAX_LINE = 26
const PROFILE_MAX_SLOTS = 6

function trimmedUser(text) {
  return userPartOf(text).replace(/^(用户|你|我)：/, '').replace(/\s+/g, ' ').trim()
}

// 渲染用：去掉「我叫/我是/我住在」这类引导词，画像行里再重复一遍很啰嗦。
function slotValue(text) {
  return String(text || '')
    .replace(/^(?:我|俺)(?:叫|名字叫|是|住在|住|家住在|家在|现在住在)/, '')
    .replace(/^(?:我|俺)(?:在|于)/, '')
    .replace(/^叫我/, '')
    .trim()
}

// 提问、寒暄、系统话不是事实，不能进画像。
function declarative(text) {
  const t = String(text || '').trim()
  if (t.length < 3 || t.length > 80) return false
  if (/[?？]\s*$/.test(t) || /(吗|呢|对吧|是不是|好不好)\s*$/.test(t)) return false
  return true
}

export function slotOf(rec) {
  if (!rec?.text) return ''
  const t = trimmedUser(rec.text)
  if (!declarative(t)) return ''
  for (const [slot, re] of SLOT_RULES) if (re.test(t)) return slot
  return ''
}

/**
 * 作废判据（比 slotOf 严得多）：只有稳定的自我陈述才允许覆盖旧值。
 * slotOf 宽松到能认「今天上班好累」，那只能用来渲染画像；拿它当覆盖判据会把真信息抹掉。
 */
export function stableAttrOf(rec) {
  if (!rec?.text) return ''
  const t = trimmedUser(rec.text)
  if (!declarative(t) || t.length > 60) return ''
  // 定义式陈述优先于「临时词」判定：先认槽，再判断它是不是一句临时状态。
  // 否则「我换工作了，现在在便利店上夜班」会因为「现在」被 FLEETING 挡掉，画像永远停在旧职业。
  for (const [slot, re] of HARD_RULES) if (re.test(t)) return slot
  if (FLEETING_RE.test(t)) return ''
  return ''
}

/**
 * 按 scope 取每个槽位最新的一条，返回 [{ slot, rec, value }]。
 * `scopes` 只放当前会话的 scope：把全局记录并进来，等于一次拿不到 session 的写入会出现在所有人画像里。
 */
export function profileSlots(records, scopes) {
  const allow = new Set((scopes || []).map((s) => s || ''))
  // 稳定陈述优先：一句「今天上班好累」也算「工作」槽，但不能盖掉「我在便利店上班」。
  const stable = new Map()
  const loose = new Map()
  const put = (bag, slot, rec) => {
    const prev = bag.get(slot)
    if (!prev || (rec.eventAt || rec.createdAt || 0) >= (prev.eventAt || prev.createdAt || 0)) bag.set(slot, rec)
  }
  for (const rec of records) {
    if (!rec?.text) continue
    if (rec.supersededBy) continue
    if (rec.muted) continue
    // 伤口不进画像：「我妈住院了」该记，但不该在她每次自我介绍时被翻出来当标签。
    if (rec.tone === 'neg' || toneOf(rec.text) === 'neg') continue
    if (!allow.has(rec.scope || '')) continue
    const hard = stableAttrOf(rec)
    if (hard) put(stable, hard, rec)
    const soft = slotOf(rec)
    // 宽松槽只用来补空缺：「今天上班好累」这种临时情绪不该被当成长期印象展示。
    if (soft && soft !== hard && !FLEETING_RE.test(trimmedUser(rec.text))) put(loose, soft, rec)
  }
  const latest = new Map(stable)
  for (const [slot, rec] of loose) if (!latest.has(slot)) latest.set(slot, rec)
  return [...latest.entries()]
    .map(([slot, rec]) => {
      let value = slotValue(trimmedUser(rec.text))
      // 「我叫沈知夏，24」里的逗号后面是年龄，不是名字；称呼只在第一个停顿处截断。
      if (slot === '称呼') value = value.split(/[，,。；;、\s]/)[0]
      return { slot, rec, value }
    })
    .filter((s) => s.value)
    .sort((a, b) => (b.rec.importance || 0) - (a.rec.importance || 0))
    .slice(0, PROFILE_MAX_SLOTS)
}

export function renderProfile(slots, { maxChars = 180 } = {}) {
  if (!slots?.length) return ''
  const head = '【长期印象】'
  let out = head
  for (const s of slots) {
    const line = `\n· ${s.slot}：${clip(s.value, PROFILE_MAX_LINE)}`
    if (out.length + line.length > maxChars) break
    out += line
  }
  return out === head ? '' : out
}
