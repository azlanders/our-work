/**
 * 黑话.mjs —— 圈子黑话候选的机械召回（2026-11-07 批次193）。
 *
 * 判据是「她的库里没有」，不是「这词很新」（学 MaiBot 的那条：必须是需要当前
 * 圈子语境才能理解的词）。机械端只做召回：最近消息里频次够、多人用、库里查不到。
 * 挑出来的候选只是一个「去琢磨」的入口 —— 是不是黑话、要不要问群友、问完记不记，
 * 全归她自己。库里查不到 ≠ 黑话，误报（普通搭配）由她的脑子滤，最多给 3 个名额。
 *
 * 切分（第一版整段切分抓不到「这也太绝绝子了」——8 个字的汉字段整段超长被跳过，
 * 嵌在句中的黑话一个都抓不到；字母梗 yyds 也被非汉字边界直接切掉）：
 *   · 先提取汉字段（任意长）/字母段（2-8）/数字段（2-4）
 *   · 汉字段 2-6 字 → 整段计；>6 字 → 滑窗 2-4 字（同一条消息内去重）
 *   · 字母段整体小写化计（yyds/xswl 这类）
 *   · 频次 = 提到这个词的**消息数**（同一条消息里说三遍不算三回）
 *
 * 纯函数：IO（读群聊日志/库文本/黑话账本）在调用方（自主行动.mjs）。
 */

// 2026-11-20：兼容旧自主行动链，避免历史记录再次进入候选。
export const 是旧黑话链 = (block) => /^- 判断：群里老说「[^\r\n]+」，我没看懂那是什么意思\r?$/m.test(block)
export const 是旧黑话惦记 = (row) => row?.from === '链' && !row.who && /^「[^\r\n]+」到底是什么意思$/.test(row.what)

export function 挑候选(msgs, opts = {}) {
  const 库文本 = String((opts && opts.库文本) || '')
  const 昵称们 = new Set(((opts && opts.昵称们) || []).map((x) => String(x || '').trim()).filter(Boolean))
  const 已收 = new Set(((opts && opts.已收) || []).map((x) => String(x || '').trim()).filter(Boolean))
  const 频次门槛 = Number((opts && opts.频次门槛) ?? 3)
  const 最多 = Number((opts && opts.最多) ?? 3)
  // 粗停用表：只挡最高频的虚词/代词/时间词/语气词。挡不全没关系 —— 候选只递给她的脑子。
  const 停用 = new Set([
    '他们', '我们', '你们', '什么', '怎么', '这样', '那样', '然后', '其实', '应该',
    '可能', '真的', '时候', '知道', '觉得', '可以', '没有', '不是', '还是', '但是',
    '因为', '所以', '如果', '已经', '一下', '一个', '这个', '那个', '这么', '那么',
    '现在', '出来', '上去', '过来', '自己', '大家', '直接', '感觉', '问题', '东西',
    '还有', '就是', '看看', '想说', '哈哈', '啊啊', '嘻嘻', '今天', '昨天', '明天',
    '时候', '一点', '的话', '人在', '在说', '在哪', '干啥', '怎么', '多少', '回事',
  ])
  const 计 = new Map()
  const 记 = (w, uid, 名, text) => {
    if (停用.has(w)) return
    if (昵称们.has(w)) return
    if (库文本.includes(w)) return
    if (已收.has(w)) return
    if (!计.has(w)) 计.set(w, { 词: w, 几回: 0, 谁: new Map(), 例: '' })
    const e = 计.get(w)
    e.几回 += 1
    e.谁.set(名 || ('…' + uid.slice(-4)), 1)
    if (!e.例) e.例 = text.replace(/\s+/g, ' ').slice(0, 30)
  }
  for (const m of (Array.isArray(msgs) ? msgs : [])) {
    const uid = String((m && m.user_id) || '')
    if (!uid) continue
    const text = String((m && m.text) || '')
    if (!text) continue
    if (昵称们.has(text.trim())) continue   // 整条就是在喊人
    const 名 = String((m && m.nickname) || '').trim()
    // 占位符不是群友打的字：[图片] [表情] [CQ:...] 剥掉再统计，
    // 不然「图片」以 416 回拿候选第一名（实测 11-07 的真实日志）。
    const 正文 = text.replace(/\[[^\]]*\]/g, ' ').replace(/@\S+/g, ' ')
    // 消息内去重：同一条消息里同一个词只计一回
    const 见过 = new Set()
    const 段s = 正文.match(/[\u4e00-\u9fa5]{2,12}|[a-zA-Z]{2,8}|\d{2,4}/g) || []
    for (const 段 of 段s) {
      if (/^[a-zA-Z]+$/.test(段)) {
        const w = 段.toLowerCase()
        if (!见过.has(w)) { 见过.add(w); 记(w, uid, 名, text) }
        continue
      }
      if (/^\d+$/.test(段)) continue
      // 汉字段一律滑窗 2-4（段长 2-4 时滑窗=段本身）。
      // 不记 >4 的整段：'今天绝绝子' 是 5 个字的段，整段不是词，里面的 '绝绝子' 才是。
      for (let n = 2; n <= 4; n++) {
        for (let i = 0; i + n <= 段.length; i++) {
          const w = 段.slice(i, i + n)
          if (!见过.has(w)) { 见过.add(w); 记(w, uid, 名, text) }
        }
      }
    }
  }
  return [...计.values()]
    .filter((e) => e.几回 >= 频次门槛 && e.谁.size >= 2)
    .sort((a, b) => b.几回 - a.几回)
    .slice(0, 最多)
    .map((e) => ({ 词: e.词, 几回: e.几回, 谁: [...e.谁.keys()], 例: e.例 }))
}
