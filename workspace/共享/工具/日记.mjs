// 日记.mjs —— 她的日记。同一份稿子，两种读法。
//
// 为什么单独拆一个文件：
//   面板.mjs 已经六千多行了，把解析和渲染搅在一起最容易出事。
//   更要紧的是「给客人看 / 给主人看」这条边界只能有一处实现 ——
//   散在渲染里写两遍，迟早有一遍漏。所以裁剪只在这里做，面板只管调。
//
// 她写字时用的两条私有记号（解析器只认这两条，多一条都不认）：
//   1. 整节只给主人：节标题里写「只给你」「心里话」「不给人看」之类；
//      或者那一节第一句是引用块，写着「这页只在本机，不外发」
//      —— 2026-11-05 那篇她自己就是这么写的，规矩照着她的习惯来，别新造一套。
//   2. 一段只给主人：用删除线包住 ~~这一句~~。删除线本身就是「划掉了」，
//      她在 markdown 里划掉一句，比让她记住一个自定义标记自然得多。
//
// 默认值是「公开」：日记本来就是要给人看的，只有她明确划掉的才藏。
// 反过来默认藏，主人会以为她那天什么都没写。
//
// 一条纪律：客人版不返回任何「这里原本有字」的线索（不返回数量、不返回占位）。
// 划掉也要让人看得出来，那是**主人**的特权；客人拿到的就是一篇完整的日记。

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'

// 目录可用环境变量顶掉，单测/沙盒不必动真实日记（和 地点.mjs 的 读档 一个路数）
const 目录 = process.env.DIARY_DIR || '{{BOT_ROOT}}/日记'
const 天气本 = process.env.DIARY_WEATHER || '{{BOT_ROOT}}/记忆/天气本.jsonl'
const 星期 = ['日', '一', '二', '三', '四', '五', '六']

// 节标题里的私有词。别往里加「梦」——她写梦是给人看的（11-05 那节就是）。
const 私节词 = /(只给你|只给主人|不给人看|不给外人|不给别人|私房|心里话|别看这页)/
// 引用块做前言时，认这几句。她原话是「这页只在本机，不外发、不进流水」。
const 私引词 = /(只在本机|不外发|不进流水|不给人看|只给你|不给别人)/

export function 有哪些() {
  let files = []
  try { files = readdirSync(目录).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)) } catch { return [] }
  // 新的在前。同一天的多个文件（比如 .bak）不认 —— 正则已经卡死了。
  files.sort().reverse()
  return files.map((f) => {
    const date = f.slice(0, 10)
    let size = 0
    try { size = statSync(目录 + '/' + f).size } catch { /* 读不到就当空 */ }
    return { date, size }
  })
}

function 拆段(正文) {
  // 按空行切段；段内多余换行并成一行（手写体排版靠 CSS 行高，不靠硬换行）
  return String(正文 || '')
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function 段信息(原文) {
  let 文 = 原文
  let 私 = false
  // ~~...~~：只要出现一处删除线，整段算私有。
  // 不按「删掉那半句、留下前半句」处理 —— 半句话读起来是残的，而且容易把上下文漏出去。
  if (/~~[\s\S]+?~~/.test(文)) {
    私 = true
    文 = 文.replace(/~~([\s\S]+?)~~/g, '$1')
  }
  // 段首引用块：`> 这页只在本机…` 是她的旁注，不是正文，不进日记
  let 旁注 = ''
  const m = 文.match(/^>\s*([\s\S]+)$/)
  if (m) {
    旁注 = m[1].replace(/\n>\s?/g, ' ').trim()
    return { 旁注, 私: 私引词.test(旁注) ? true : 私 }
  }
  // 列表项原样留符号，她写「- 感受：…」是想列出来，不是想要段落
  return { 文, 私 }
}

// 把不属于日记的东西挡在门外。
//
// 2026-11-02 那篇是事故：记忆抽取的条目被写进了日记目录，正文里直接带着群号和人设行。
// 那是机器写的账，不是她的话 —— 出现在日记里既出戏又漏东西。
// 这里按**格式**剔（`- [fact] …` 这种带英文标签的列表项），不猜内容：
// 判「这句是不是她真心话」是替她做主，判「这行有没有 [fact] 标记」只是认格式。
// 「（待补）」同理：那是占位符，不是她写的字。
const 是元数据行 = (t) => (
  /^[-*]\s*\[(fact|rules|pref|user|hot|cold|soul|全局|热|冷)(\/[a-z]+)?\]/i.test(t) ||
  /^[-*]\s*共\s*\d+\s*条/.test(t)
)
const 是占位行 = (t) => /^[（(]\s*待补\s*[)）]$/.test(t)
// 她自己在小标题里写了「不写进档案」「不落盘」—— 那就别当日记
const 丢节词 = /(不写进档案|不落盘|散掉的)/

function 滤掉非日记(文) {
  const 留 = String(文).split('\n').filter((l) => {
    const t = l.trim()
    if (!t) return false
    if (是元数据行(t) || 是占位行(t)) return false
    return true
  })
  return 留.join('\n').trim()
}

// DIR_ARG 2026-11-17（批次654）：多一个可选的目录参数。
// 回忆.mjs 有自己的目录变量（QQ_RECALL_DIARY），而 日记.mjs 的默认目录在
// 模块加载时就定死了 —— 传参比改 env 更干净，也让沙盒测试能指到临时目录。
export function 读一篇(date, dir) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null
  const p = String(dir || 目录) + '/' + date + '.md'
  if (!existsSync(p)) return null
  let 原文 = ''
  try { 原文 = readFileSync(p, 'utf8') } catch { return null }

  // 首行 `# 2026-11-05` 是标题，去掉；有副标题就留着当她的题
  let 行 = 原文.replace(/\r/g, '').split('\n')
  let 题 = ''
  if (行.length && /^#\s+/.test(行[0])) {
    const 头 = 行.shift().replace(/^#\s+/, '').trim()
    // 头里光有日期就不当题
    if (!/^\d{4}-\d{2}-\d{2}$/.test(头)) 题 = 头
  }

  const 节们 = []
  let 当前 = { 题: '', 行: [] }
  for (const l of 行) {
    const m = l.match(/^##\s+(.+?)\s*$/)
    if (m) {
      节们.push(当前)
      当前 = { 题: m[1], 行: [] }
    } else if (/^###\s+/.test(l)) {
      // 三级标题当小标题用，不另起一节
      当前.行.push('###' + l.replace(/^###\s*/, ' '))
    } else {
      当前.行.push(l)
    }
  }
  节们.push(当前)

  const sections = []
  for (const 节 of 节们) {
    if (丢节词.test(节.题)) continue
    const 整节私 = 私节词.test(节.题)
    const paras = []
    for (const 段 of 拆段(节.行.join('\n'))) {
      const r = 段信息(段)
      if (r.旁注) {
        // 旁注只用来判私有，本身不进正文
        if (r.私) { /* 该节已据此标私，见下 */ }
        paras.push({ 旁注: r.旁注 })
        continue
      }
      paras.push({ 文: r.文, 私: 整节私 || r.私 })
    }
    // 旁注判定：节里有含私有词的引用块 → 整节私有
    const 引判私 = paras.some((x) => x.旁注 && 私引词.test(x.旁注))
    const 正文段 = paras
      .filter((x) => !x.旁注)
      .map((x) => ({ 文: 滤掉非日记(x.文), 私: 引判私 ? true : x.私 }))
      .filter((x) => x.文)   // 滤完变空的段不要（整段都是账本条目 / 占位符）
    if (!正文段.length) continue
    sections.push({ 题: 节.题, 段: 正文段 })
  }

  const 全段 = sections.flatMap((s) => s.段)
  const 字 = 全段.reduce((n, x) => n + x.文.replace(/\s/g, '').length, 0)
  const d = new Date(date + 'T12:00:00+08:00')
  // 落款：她哪天几点写完的。取文件写入时刻 —— 比「今天」诚实，
  // 也是日记本上唯一该有的时间戳（页码之外）。
  let 写于 = ''
  try {
    const mt = statSync(p).mtimeMs
    写于 = new Date(mt + 8 * 3600e3).toISOString().slice(11, 16)
  } catch { /* 读不到时间就不写 */ }

  return {
    date,
    题,
    星期: 星期[d.getUTCDay()] || '',
    字,
    写于,
    sections,
    私段: 全段.filter((x) => x.私).length,
    // 列表页要的一句摘：取第一段公开文字
    摘: (全段.find((x) => !x.私) || 全段[0] || { 文: '' }).文.replace(/^[-*]\s*/, '').slice(0, 68),
  }
}

// 裁剪：这是全站唯一决定「客人能看到多少」的地方。
// role 只有 owner 能拿到私有段；其余（guest / 没登录）一律剥干净。
export function 给角色(篇, role) {
  if (!篇) return null
  const 主人 = role === 'owner'
  // 客人版每个段落只留 `文` 一个字段 —— 连 `私:false` 都不下发。
  // 留着的话，前端源码里会看到「是私有段但值为假」，等于把裁剪这件事本身露出来。
  const sections = 篇.sections
    .map((s) => ({
      题: s.题,
      段: s.段.filter((x) => 主人 || !x.私).map((x) => (主人 ? { 文: x.文, 私: x.私 } : { 文: x.文 })),
    }))
    .filter((s) => s.段.length)
  const 全段 = sections.flatMap((s) => s.段)
  const out = {
    date: 篇.date,
    题: 篇.题,
    星期: 篇.星期,
    写于: 篇.写于 || '',
    字: 全段.reduce((n, x) => n + x.文.replace(/\s/g, '').length, 0),
    sections,
    摘: (全段.find((x) => !x.私) || 全段[0] || { 文: '' }).文.replace(/^[-*]\s*/, '').slice(0, 68),
  }
  // 这两项只给主人。客人版连字段都不出现 —— 前端就算想显示也没得显示。
  if (主人) {
    out.私段 = 篇.私段
    out.有划掉 = 篇.私段 > 0
  }
  return out
}

export function 当天天气(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null
  let 行 = []
  try { 行 = readFileSync(天气本, 'utf8').split('\n').filter(Boolean) } catch { return null }
  for (let i = 行.length - 1; i >= 0; i--) {
    let o = null
    try { o = JSON.parse(行[i]) } catch { continue }
    if (o && o.date === date) {
      return { 天气: o.天气 || '', 最高: o.最高 ?? null, 最低: o.最低 ?? null, 降水: o.降水 === true }
    }
  }
  // 查不到就返回 null。不拿今天的天气去冒充那天的 —— 这一条在照片墙上已经踩过一次。
  return null
}
