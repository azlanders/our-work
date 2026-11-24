/**
 * 自动回忆.mjs —— 只给事实，不替她成句。
 *
 * 触发条件很窄：当前私聊消息里有“记得/想起/上次/手账/日记/梦”这类
 * 回看线索，或者明确提到某一天。平时不扫全库，避免每轮都吃磁盘和上下文。
 *
 * 返回格式固定为：
 *   [旧事素材] 这些是记录里的事实……
 *   - 手账 · 2026-11-16：……
 *
 * 这里不写“我想起来了”，也不判断她该不该提；提不提由回合里的她自己决定。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { 读QQ原话批次 } from './onebot.js'

const 默认记忆 = process.env.QQ_MEM || `${QQ_WS}/记忆`
const 默认日记 = process.env.QQ_DIARY || `${QQ_WS}/日记`
const 线索 = /记得|想起|想起来|忘了|忘记|上次|上回|之前|以前|那天|那次|当时|后来|说过|答应|约好|手账|日记|梦|哪天|哪一天|什么时候|昨天|前天|大前天|20\d{2}-\d{2}-\d{2}|\d+\s*天前|今天.*(干|做|发生|过|忙)/
// WINTER 2026-11-17（批次649）：`记忆/冬冰/看完记.md` 是她自己写的 13KB 看片笔记，
// 雷霆体检报「写了没人读」—— 全库只有读档脚本会扫到它，没有任何召回入口。
// 只在主人明确提到这个合集时才翻，避免平时把一大段剧情塞进上下文。
//
// BATCH662 2026-11-17（审计 P1-7）：触发词收窄。原来带了泛词「合集」，
// 主人随口说「这个合集不错」就会翻 13KB 笔记；而且冬冰来源自带 `源分 = 4`，
// 又用 `源中 > 0 ? 1 : 0` 记成 `命中`，导致一条词面完全无关的笔记也能通过
// 「有命中」筛选、按分数挤进前两条。现在：
//   1) 触发只认「冬冰 / 看完记 / 中转站」；「合集」必须同时带看片语境才放开；
//   2) 源分只参与排序，不再冒充命中；
//   3) 靠「合集 + 看片语境」触发时，冬冰条目必须自己有实际词块命中才允许入选；
//   4) 明确点名「冬冰/看完记/中转站」时算一次话题命中 —— 笔记正文里并没有
//      「冬冰」二字（标题才有），硬要求词面会把 t649 的整条入口废掉。
const 冬冰线 = /冬冰|看完记|中转站/
const 合集线 = /合集/
const 看片语境 = /看|剧情|讲到|看到|进度|到哪|第几条|第几集|结局/

function 有回看线索(text) {
  return text.length >= 3 && (线索.test(text) || 冬冰线.test(text) || (合集线.test(text) && 看片语境.test(text)))
}

export function 自动回忆批次(messages, opts = {}) {
  return 自动回忆素材(读QQ原话批次(messages), opts)
}

export function 自动回忆素材(rows, opts = {}) {
  const index = rows.findLastIndex(({ text }) => 有回看线索(text))
  if (index < 0) return ''
  const anchor = rows[index]
  const query = rows.slice(index).map(({ text }) => text.slice(0, 200)).filter(Boolean).join('\n').slice(0, 400)
  const now = opts.now ?? Date.now()
  return 自动回忆段(query, { ...opts, now: anchor.at && anchor.at <= now ? anchor.at : now })
}

const 缓存 = new Map()
function 读文本(p) {
  try {
    const st = statSync(p)
    const hit = 缓存.get(p)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
    const text = readFileSync(p, 'utf8')
    缓存.set(p, { mtimeMs: st.mtimeMs, size: st.size, text })
    return text
  } catch { return '' }
}

const 北京日 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)
const 减日 = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') - n * 86400e3).toISOString().slice(0, 10)

function 取日(text, now = Date.now()) {
  const t = String(text || '')
  const 日 = t.match(/20\d{2}-\d{2}-\d{2}/)
  if (日) return { days: [日[0]], explicit: true }
  const 今 = 北京日(now)
  if (/昨天/.test(t)) return { days: [减日(今, 1)], explicit: true }
  if (/大前天/.test(t)) return { days: [减日(今, 3)], explicit: true }
  if (/前天/.test(t)) return { days: [减日(今, 2)], explicit: true }
  if (/今天/.test(t)) return { days: [今], explicit: true }
  const n = t.match(/(\d+)\s*天前/)
  if (n) return { days: [减日(今, Number(n[1]))], explicit: true }
  return { days: Array.from({ length: 7 }, (_, i) => 减日(今, i)), explicit: false }
}

const 停词 = new Set([
  '记得', '想起', '想起来', '忘了', '忘记', '上次', '上回', '之前', '以前',
  '那天', '那次', '当时', '后来', '说过', '答应', '约好', '手账', '日记', '梦',
  '今天', '昨天', '前天', '大前天', '哪天', '哪一天', '什么', '是什', '么事', '时候',
  '怎么', '怎么样', '为什么', '干什么', '干嘛', '这个', '那个',
  '说的', '吃的', '看的', '我的', '你的', '他的', '她的', '我们', '你们', '他们',
])

function 词块(text) {
  const clean = String(text || '')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/@\S+/g, ' ')
    .replace(/是什么|什么时候|怎么样|为什么|干什么|干嘛/g, ' ')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9_-]+/g, ' ')
    .trim()
  const raw = clean.split(/\s+/).filter((x) => x.length >= 2)
  const out = new Set()
  for (const seg of raw) {
    for (let n = 2; n <= Math.min(4, seg.length); n++) {
      for (let i = 0; i + n <= seg.length; i++) {
        const g = seg.slice(i, i + n)
        if (!停词.has(g)) out.add(g)
      }
    }
  }
  return [...out].slice(0, 80)
}

function 记分(文, blocks) {
  let s = 0
  for (const b of blocks) if (文.includes(b)) s += Math.min(4, b.length)
  return s
}

function 手账条(day, mem, 读 = 读文本) {
  const p1 = join(mem, `手账-${day}.md`)
  const p2 = join(mem, '归档', '历史按月', day.slice(0, 7), `手账-${day}.md`)
  const p = existsSync(p1) ? p1 : existsSync(p2) ? p2 : ''
  if (!p) return []
  const seen = new Set()
  const out = []
  for (const l of 读(p).split('\n')) {
    const m = l.match(/^- (\d{2}:\d{2}) · (.+)$/)
    if (!m) continue
    const 文 = String(m[2]).replace(/\s+/g, ' ').trim()
    if (!文 || seen.has(文)) continue
    seen.add(文)
    out.push({ 来源: '手账', 日: day, 文: m[1] + ' ' + 文 })
  }
  return out
}

function 来源指纹({ 来源, 日, 文, 时点 }) {
  const 原笔 = 时点 ? [来源, 日, 文, 时点] : [来源, 日, 文]
  return createHash('sha256').update(JSON.stringify(原笔)).digest('hex')
}

function 现读来源(path, 缺失值 = '') {
  try { return readFileSync(path, 'utf8') } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return 缺失值
  }
}

function 日记条(day, diary, 读 = 读文本) {
  const p = join(diary, `${day}.md`)
  if (!existsSync(p)) return []
  return 读(p).split(/\n{2,}/)
    .map((x) => x.replace(/^#.*$/gm, '').replace(/~~/g, '').replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 10)
    .slice(0, 6)
    .map((文) => ({ 来源: '日记', 日: day, 文 }))
}

function 梦条(day, mem, 读 = 读文本) {
  const p1 = join(mem, `梦-${day}.md`)
  const p2 = join(mem, '归档', '历史按月', day.slice(0, 7), `梦-${day}.md`)
  const p = existsSync(p1) ? p1 : existsSync(p2) ? p2 : ''
  if (!p) return []
  const lines = []
  for (const l of 读(p).split('\n')) {
    const m = l.match(/^(余味|场景|地点|细节|转折|身体感|结尾)[:：]\s*(.+)$/)
    if (m && m[2].trim()) lines.push(m[1] + '：' + m[2].trim())
  }
  if (!lines.length) return []
  return [{ 来源: '梦', 日: day, 文: lines.slice(0, 2).join('；') }]
}

function 链条(mem, allowedDays, 读 = 读文本) {
  const p = join(mem, '链.md')
  if (!existsSync(p)) return []
  let 作废
  try {
    作废 = JSON.parse(现读来源(join(mem, '链-作废.json'), '{"条目":[]}'))
  } catch (error) {
    if (error instanceof SyntaxError) return []
    throw error
  }
  if (!Array.isArray(作废?.条目) || !作废.条目.every(条 => typeof 条?.at === 'string')) return []
  const 死链 = new Set(作废.条目.map(条 => 条.at))
  const out = []
  const seen = new Set()
  for (const block of 读(p).split(/^## /m).filter(Boolean)) {
    const lines = block.trim().split('\n')
    const at = (lines[0] || '').trim()
    const day = at.slice(0, 10)
    if (!allowedDays.has(day)) continue
    // 自动回忆只递“事实”：判断是她的主观话，未决是待办，都不该被当成发生过的事。
    if (死链.has(at.slice(0, 16))) continue
    const hit = lines.find((l) => /^-\s*事实[：:]/.test(l))
    if (!hit) continue
    const 文 = hit.replace(/^-\s*事实[：:]\s*/, '').trim()
    // 不把群号、QQ 号、服务器路径、链接带进主人私聊的回忆素材。
    if (!文 || /\d{6,}|\/data\/|https?:\/\//.test(文)) continue
    const key = 文.replace(/[，。！？、…；：\s,.!?]/g, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ 来源: '链', 日: day, 文, 时点: at.slice(0, 16) })
  }
  return out
}

function 冬冰条(mem, 读 = 读文本) {
  const p = join(mem, '冬冰', '看完记.md')
  if (!existsSync(p)) return []
  let 日 = ''
  try {
    const st = statSync(p)
    日 = new Date(st.mtimeMs + 8 * 3600e3).toISOString().slice(0, 10)
  } catch { 日 = 北京日() }
  const out = []
  for (const l of 读(p).split('\n')) {
    // 这份笔记的正文是「1. 墨提斯三国杀…」这种编号条目（54 条），
    // 末尾「这系列值得学的」才是 `- ` 短句。两种都要认 —— 只认 `- ` 会漏掉 78% 的内容。
    const m = l.match(/^(?:(-\s+)|\d+\.\s+)(.+)$/)
    if (!m) continue
    const 编号 = !m[1]
    const 文 = String(m[2]).replace(/\s+/g, ' ').trim()
    // 太长的是世界观综述，召回时只会挤占预算；保留能单独站住的短条目。
    if (文.length < 8 || 文.length > 220) continue
    out.push({ 来源: '冬冰', 日, 文, 编号 })
  }
  return out
}

// 问「讲到哪了 / 看到第几条了」时，真正该给的是 `冬冰/进度.md` 的末两条进度，
// 不是剧情笔记里的任意一条。这两行是整份文件里唯一带「当前进度」语义的内容。
function 冬冰进度条(mem, 读 = 读文本) {
  const p = join(mem, '冬冰', '进度.md')
  if (!existsSync(p)) return []
  let 日 = ''
  try { 日 = new Date(statSync(p).mtimeMs + 8 * 3600e3).toISOString().slice(0, 10) } catch { 日 = 北京日() }
  const 行 = 读(p).split('\n').filter((l) => /^-\s*(已看清|待看)/.test(l.trim()))
  if (!行.length) return []
  return 行.slice(-2).map((l) => ({ 来源: '冬冰进度', 日, 文: l.replace(/^-\s*/, '').trim() }))
}

function 截(s, n = 100) {
  const x = String(s || '').replace(/\s+/g, ' ').trim()
  return x.length > n ? x.slice(0, n) + '…' : x
}

/**
 * @param {string} text 当前消息
 * @param {{mem?: string, diary?: string, now?: number, maxItems?: number, maxChars?: number}} opts
 * @returns {string} 没有命中就返回空串
 */
export function 自动回忆段(text, opts = {}) {
  const q = String(text || '').trim()
  if (!有回看线索(q)) return ''
  // BATCH662：入口判据要和下面「要不要读冬冰笔记」用同一套，否则
  // 「合集看到第几条了」会在门口就被挡掉。
  const 谈冬冰 = 冬冰线.test(q) || (合集线.test(q) && 看片语境.test(q))
  // 明确点名合集 = 话题命中；只靠泛词「合集」进来的，不算。
  const 点名冬冰 = 冬冰线.test(q)
  const mem = String(opts.mem || 默认记忆)
  // 生产上日记是记忆的同级目录；沙盒里给了别的 mem，就跟着沙盒走，别漏读真档。
  const diary = String(opts.diary || (opts.mem ? join(dirname(mem), '日记') : 默认日记))
  const now = Number(opts.now) || Date.now()
  const { days, explicit } = 取日(q, now)
  const blocks = 词块(q)
  const allowed = new Set(days)
  const 按来源现读 = {
    手账: day => 手账条(day, mem, 现读来源),
    日记: day => 日记条(day, diary, 现读来源),
    梦: day => 梦条(day, mem, 现读来源),
    链: day => 链条(mem, new Set([day]), 现读来源),
    冬冰: () => 冬冰条(mem, 现读来源),
    冬冰进度: () => 冬冰进度条(mem, 现读来源),
  }
  const rows = []

  for (const day of days) {
    rows.push(...手账条(day, mem), ...日记条(day, diary), ...梦条(day, mem))
  }
  rows.push(...链条(mem, allowed))
  if (谈冬冰) {
    rows.push(...冬冰条(mem))
    if (/讲到|看到|进度|到哪|第几条/.test(q)) rows.push(...冬冰进度条(mem))
  }

  const 源分 = (来源) => {
    if (/梦/.test(q) && 来源 === '梦') return 6
    if (/日记/.test(q) && 来源 === '日记') return 6
    if (/手账/.test(q) && 来源 === '手账') return 6
    if (/链/.test(q) && 来源 === '链') return 4
    if (谈冬冰 && 来源 === '冬冰') return 4
    if (/讲到|看到|进度|到哪|第几条/.test(q) && 来源 === '冬冰进度') return 8
    return 0
  }
  const seen = new Set()
  const uniq = rows.filter((x) => {
    const k = String(x.文 || '').replace(/[，。！？、…；：\s,.!?]/g, '')
    if (!k || seen.has(k)) return false
    seen.add(k)
    return true
  })
  const scored = uniq.map((x) => {
    const age = Math.max(0, (Date.parse(北京日(now) + 'T00:00:00Z') - Date.parse(x.日 + 'T00:00:00Z')) / 86400e3)
    const 词中 = 记分(x.文, blocks)
    const 源中 = 源分(x.来源)
    // 问“梦/日记/手账”时，对应来源至少算一条命中，别被同日别的流水挤掉。
    // 冬冰笔记里「1. 第几条讲了什么」才是她要的东西；世界观综述/系列总结只是背景，
    // 同样命中时让编号条目先上，否则问「讲到哪了」只会拿到两段泛泛的世界观。
    const 条分 = x.来源 === '冬冰' ? (x.编号 ? 2 : 0) : (x.来源 === '冬冰进度' ? 4 : 0)
    // BATCH662：来源分只负责排序，不能当命中。
    // 明确点名「冬冰/看完记/中转站」时，笔记标题就是话题本身，算一次命中；
    // 只靠泛词「合集」进来时，必须条目自己有词面命中，否则「这个合集不错」
    // 会把两条完全无关的看片笔记塞进来。
    // 例外：明确问「讲到哪了/第几条」时，「进度」条目本身就是答案，算命中。
    const 问进度 = /讲到|看到|进度|到哪|第几条/.test(q)
    const 是冬冰 = x.来源 === '冬冰'
    const 来源命中 = 源中 > 0 && x.来源 !== '冬冰' && x.来源 !== '冬冰进度' ? 1 : 0
    const 点名命中 = 是冬冰 && 点名冬冰 ? 1 : 0
    const 冬冰要词面 = 是冬冰 && !点名冬冰
    const 进度命中 = x.来源 === '冬冰进度' && 问进度 ? 1 : 0
    const 命中 = 词中 + 来源命中 + 点名命中 + 进度命中
    return { ...x, 命中, 冬冰要词面, 分: 词中 + 源中 + 条分 + Math.max(0, 7 - age) / 10 }
  })
  const 有命中 = scored.some((x) => x.命中 > 0)
  // 明确问了哪一天、但一个词都没命中时，才退回“那天的事实全给”；有命中就丢掉零命中项。
  const 候选 = scored.filter((x) => {
    if (x.冬冰要词面 && !(x.命中 > 0)) return false
    return 有命中 ? x.命中 > 0 : explicit
  })

  候选.sort((a, b) => b.分 - a.分 || String(b.日).localeCompare(String(a.日)))
  if (!候选.length) return ''

  const maxItems = Math.max(1, Math.min(3, Number(opts.maxItems) || 2))
  const maxChars = Math.max(160, Math.min(600, Number(opts.maxChars) || 360))
  const prefix = '[旧事素材] 下面只是过去记录的片段，不会自动改变你的状态。只据所记接话，没记的细节不要补写；梦不是现实。只有你此刻确实被触动，才自行判断是否调用 qq_feel；没感觉或不确定就不记。\n'
  const picked = []
  let used = 0
  for (const x of 候选) {
    const revision = opts.onPicked ? 来源指纹(x) : ''
    const label = `旧事-${revision.slice(0, 16)}`
    const line = `- ${x.来源} · ${x.日}：${截(x.文)}${opts.onPicked ? ` [${label}]` : ''}`
    if (picked.length >= maxItems) break
    const separator = picked.length ? 1 : 0
    if (prefix.length + used + separator + line.length > maxChars) continue
    picked.push(line)
    if (opts.onPicked) {
      const { 来源: source, 日: day } = x
      opts.onPicked({ label, source, day, revision, 仍有效: () => 按来源现读[source](day).some(row => 来源指纹(row) === revision) })
    }
    used += separator + line.length
  }
  if (!picked.length) return ''
  return prefix + picked.join('\n')
}

