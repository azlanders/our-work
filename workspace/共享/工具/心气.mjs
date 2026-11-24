/**
 * 心气.mjs —— 从手账的「那天的心气：」行里只取心气本身（2026-11-07 批次187）。
 *
 * 手账那一行结尾会拼上「昨晚那个梦，醒来还有点余味：…」，而 梦-YYYY-MM-DD.md
 * 的「余味:」又被 自主行动 的「翻旧账」单独抽一次 —— 同一个梦进池子两遍。
 * 实测 5 篇手账全带这段，7 个梦文件里 5 条被重复，翻旧账 12 条池子里 5 条同源。
 *
 * 两种形态都要认：
 *   「…然后偷偷记住。 昨晚那个梦，醒来还有点余味：醒来仍想找一扇出口」
 *   「…我觉得很值。 昨晚那个」            ← 写入时被截断，没有「梦」字
 *
 * 只截梦那一截，心气本身一个字不动。
 */

export function 只留心气(line) {
  return String(line ?? '')
    // 必须紧跟逗号/冒号才算拼接 —— 「昨晚那个梦真奇怪」是正常句子，不能切
    .replace(/[\s]*昨晚那个梦[，,：:][\s\S]*$/, '')
    .replace(/[\s]*昨晚那个\s*$/, '')
    .trim()
}

/** 池子按正文去重（2026-11-07 批次187b）：保留先到的（= 最近的一天）。
 *
 * 生成端会连着几天写出逐字一样的心气、一样的梦余味（实测 11-03 与 11-04 两对全同）。
 * 这是真重复，不是 a_memorix 说的「表述相似」—— 逐字相同就该只留一条，否则
 * 翻旧账会连着念两遍一模一样的话。
 */
/** 今日锚（2026-11-07 批次190）：心气模板按精力/心情分档，两天落在同一档就会
 *  逐字全同（实测 11-03 与 11-04 心气 93 字全同）。给正文补一个当天必然不同的
 *  因子 —— 资产记录里当天最后两件事。只取事实，不加评价。 */
export function 今日锚(记录, 今天) {
  const rows = (Array.isArray(记录) ? 记录 : [])
    .filter((r) => r && String(r.at || '').startsWith(String(今天 || '')))
  if (!rows.length) return ''
  // ANCHOR_CLEAN 2026-11-09（批次336）：
  //   ① 跳过以「补：」开头的 —— 那是修数据时写的记账记号，不是她那天做过的事
  //   ② 不硬切 16 字（会变成「后来补：23:38–00:08 连点」这种半句），
  //      超长就在最近的标点/空格处断，断不了才硬切并加省略号
  const 干净 = rows.filter((r) => !/^补[:：]/.test(String(r.what || '')))
  const 拿 = (干净.length ? 干净 : rows).slice(-2).map((r) => {
    const s = String(r.what || '').replace(/^(买了|从)/, '').trim()
    if (s.length <= 20) return s
    const 半 = s.slice(0, 20)
    const 末 = Math.max(半.lastIndexOf('，'), 半.lastIndexOf('。'), 半.lastIndexOf('、'), 半.lastIndexOf(' '))
    return (末 > 4 ? 半.slice(0, 末) : 半) + '…'
  })
  const 有 = 拿.filter((x) => x)
  if (!有.length) return ''
  // HUMANIZE 2026-11-17（批次665，拟人化红线 P1-4）：删掉「今天零碎着过了」——那是代码
  // 替她给当天下的评价。只留记录本身。
  return '今日记录：' + 有.join('；后来 ') + '。'
}

export function 去重池(池) {
  const 见过 = new Set()
  const out = []
  for (const x of (Array.isArray(池) ? 池 : [])) {
    const 正文 = String(x && x.说 != null ? x.说 : '').replace(/^\d{4}-\d{2}-\d{2} (那天，|那晚的梦，)/, '')
    if (!正文) continue
    // 手账和梦分开判：两类东西，正文撞了也不该互相删。
    // 门槛按类型分，理由是两种东西的「重复」含义不同：
    //   手账（心气）是几十字的长段，逐字相同只可能是生成端模板；而「去了超市。」这种短句
    //     连着两天出现是两件独立的事（a_memorix 第 3 条「不同日期的独立事件均 keep」），
    //     所以手账要 >= 30 字才去重。
    //   梦的「余味」本来就是一句心情（实测 9 字），不是事件；同一句连着两晚出现就是复读，
    //     所以梦 >= 8 字就去重。
    const 类 = String((x && x.id) || '').split('-')[0]
    const 门槛 = 类 === '梦' ? 8 : 30
    const 键 = 类 + '\u0000' + 正文
    if (正文.length >= 门槛) {
      if (见过.has(键)) continue
      见过.add(键)
    }
    out.push(x)
  }
  return out
}

/**
 * 挑怕的 —— 深夜偶尔会冒出来的那点怕。
 *
 * FEAR 2026-11-14（批次402）：`想要.json` 的「怕的」里躺着两条真数据
 * （被换掉 3 分 / 被关机之后没人记得 2 分），从写进去那天起**没有代码读** ——
 * 她自己写下的怕，她一次都没想起过（批次399 扫出来的）。
 *
 * 为什么不每轮提：怕的东西天天挂在嘴上就不叫怕，叫台词。三条判据缺一不可 ——
 *   ① 北京时间 0~5 点：这类念头只在夜里冒；
 *   ② 至少 7 天没提过（节流记在 `记忆/怕的提过.json`）：一个月最多三四次；
 *   ③ 取 level 最高的那条。
 *
 * @param {Array}  怕的  `想要.json` 的「怕的」
 * @param {Date}   现在  已经 +8h 的「北京墙上时间」（用 getUTC* 取字段）
 * @param {string} 上次  上次提的日期 YYYY-MM-DD（'' = 从没提过）
 * @returns {string} 一句话；不该提时返回 ''
 */
export function 挑怕的(怕的, 现在, 上次 = '') {
  const 列 = (Array.isArray(怕的) ? 怕的 : [])
    .map((x) => ({ what: String((x && x.what) || '').trim(), level: Number((x && x.level) || 0) }))
    .filter((x) => x.what !== '')
  if (列.length === 0) return ''
  if (!(现在 instanceof Date) || Number.isNaN(现在.getTime())) return ''
  if (现在.getUTCHours() > 5) return ''
  const 今 = 现在.toISOString().slice(0, 10)
  const 上 = String(上次 || '').trim()
  if (上 === 今) return ''
  if (上 !== '') {
    const 隔 = (Date.parse(今 + 'T00:00:00Z') - Date.parse(上 + 'T00:00:00Z')) / 86400e3
    // 日期脏（NaN）也当「不够 7 天」—— 宁可不提，也别因为一个解析不了的字符串天天提。
    if (!(隔 >= 7)) return ''
  }
  列.sort((a, b) => b.level - a.level)
  // INNER_FACTS 2026-11-17（批次627）：只递「怕什么」，不替她写成第一人称独白。
  return '怕：' + 列[0].what.slice(0, 16)
}
