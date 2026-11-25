#!/usr/bin/env node
/**
 * 回忆.mjs —— 让她能自己翻旧账（2026-11-07 批次189）。
 *
 * 以前只有「系统塞给她」：链尾 3 条、印象一句话。她想不起某件事时没有任何办法。
 * 隔壁 qq_msg_history 能翻 QQ 聊天记录，但翻不了她自己的手账、梦、链 —— 这就是缺口。
 *
 * 用法：
 *   node 回忆.mjs --日 2026-11-05      # 那天的手账 + 日记 + 那晚的梦
 *   node 回忆.mjs --日 昨天
 *   node 回忆.mjs --词 图书馆          # 手账/日记/梦/链里提到过的
 *   node 回忆.mjs --最近 3             # 最近三天
 *   node 回忆.mjs --json               # 给插件用
 *
 * 只读，不写任何文件。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// DIARY_ROLE 2026-11-17（批次654）：私有段（`## 只给你` / `~~划掉~~`）的裁剪
// 只认 日记.mjs 一处实现，回忆侧不再自己剥。
import { 读一篇, 给角色 } from './日记.mjs'
import { 是旧黑话链 } from './黑话.mjs'

const base = process.env.QQ_RECALL_MEM || '{{BOT_ROOT}}/记忆'
const 日记目录 = process.env.QQ_RECALL_DIARY || '{{BOT_ROOT}}/日记'
const args = process.argv.slice(2)
const val = (n, d) => {
  const i = args.indexOf(n)
  return i >= 0 && args[i + 1] ? args[i + 1] : d
}
const JSON_OUT = args.includes('--json')

const 条目上限 = 12
const 每条上限 = 100

const 偏移日 = (n) => new Date(Date.now() + 8 * 3600e3 - n * 86400e3).toISOString().slice(0, 10)

/** 只认 2026-11-05 / 今天 / 昨天 / 前天 / N天前，别的一律空。 */
export function 解析日(s) {
  const t = String(s ?? '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t
  if (t === '今天') return 偏移日(0)
  if (t === '昨天') return 偏移日(1)
  if (t === '前天') return 偏移日(2)
  const m = t.match(/^(\d+)\s*天前$/)
  if (m) return 偏移日(Number(m[1]))
  return ''
}

const 截 = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > 每条上限 ? t.slice(0, 每条上限) + '…' : t
}

/** 围绕命中词居中截取，防止长段落在第 100 字截断时把命中词本身切掉。 */
export function 截围绕(s, q) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (t.length <= 每条上限) return t
  const needle = String(q ?? '').trim().toLowerCase()
  if (!needle) return t.slice(0, 每条上限) + '…'
  const idx = t.toLowerCase().indexOf(needle)
  if (idx < 0 || idx + needle.length <= 每条上限 - 4) return t.slice(0, 每条上限) + '…'
  const start = Math.max(0, idx - Math.floor((每条上限 - needle.length) / 2))
  const end = Math.min(t.length, start + 每条上限)
  return (start > 0 ? '…' : '') + t.slice(start, end) + (end < t.length ? '…' : '')
}

function 找归档(prefix, day) {
  const p1 = join(base, `${prefix}-${day}.md`)
  if (existsSync(p1)) return p1
  const pSub = join(base, prefix, `${prefix}-${day}.md`)
  if (existsSync(pSub)) return pSub
  const p2 = join(base, '归档', '历史按月', day.slice(0, 7), `${prefix}-${day}.md`)
  return existsSync(p2) ? p2 : ''
}

function 读手账(day) {
  const p = 找归档('手账', day)
  if (!p) return []
  const 全 = readFileSync(p, 'utf8').split('\n')
  const seen = new Set()
  const rows = []
  for (const l of 全) {
    if (!/^- \d{2}:\d{2} · /.test(l)) continue
    const line = l.replace(/^- /, '').trim()
    const body = line.replace(/^\d{2}:\d{2} · /, '')
    // 同一句一天里出现几次只留第一条：生成端会重复（11-06 两条一模一样的夜班）
    if (seen.has(body)) continue
    seen.add(body)
    rows.push(line)
  }
  // DAY_QUIET 2026-11-08（批次250）：今天什么都没做时，事件行是 0 条 —— 但手账里还有
  // 「今天没什么可记的」和「那天的心气：…」。原来直接返回空，于是她说「回忆今天」
  // 拿到的是「最近 1 天没有记录」，等于把有内容的一天说成空白。
  // 兜底只捞心气这一行，不硬凑事件。
  if (rows.length === 0) {
    for (const l of 全) {
      const m = l.match(/^那天的心气[：:](.+)$/)
      if (m && m[1].trim()) { rows.push('心气 · ' + m[1].trim()); break }
    }
  }
  return rows
}

function 读梦(day) {
  const p = 找归档('梦', day)
  if (!p) return ''
  const txt = readFileSync(p, 'utf8')
  // DREAM_FACTS 2026-11-17（批次649）：`余味:` 现在是底色标签（暖/不安/烧热），
  // 单独一个「暖」字当回忆素材毫无信息量。改成把梦文件里的**事实行**拼回去：
  // 情绪 + 睡眠 + 场景/细节/地点/转折/身体感/结尾。
  // 她读到的是「那天梦见了什么」，不是别人替她写好的一句感受。
  const 行 = txt.split('\n').map((l) => l.trim()).filter(Boolean)
  const 取 = (k) => (行.find((l) => l.startsWith(k + '：') || l.startsWith(k + ':')) || '').replace(/^[^：:]+[：:]\s*/, '').trim()
  const 段 = []
  const 情绪 = 取('情绪')
  if (情绪) 段.push('情绪 ' + 情绪)
  const 睡眠 = 取('睡眠')
  if (睡眠) 段.push(睡眠)
  for (const k of ['场景', '地点', '转折', '身体感', '结尾']) {
    const v = 取(k)
    if (v) 段.push(v)
  }
  const 细节 = 行.filter((l) => l.startsWith('细节：') || l.startsWith('细节:')).map((l) => l.replace(/^细节[：:]\s*/, '').trim())
  段.push(...细节)
  if (段.length) return 段.join('；')
  const m = txt.match(/^余味[:：]\s*(.+)$/m)
  if (m && m[1].trim()) return m[1].trim()
  const first = txt.split('\n').find((l) => l.trim() && !l.startsWith('#'))
  return first ? first.trim() : ''
}

// DIARY_RECALL 2026-11-17（批次621）：日记原来只写、只给面板看，聊天侧翻不到。
// 这里按天读成段落，交给 qq_recall 的「日 / 词 / 最近」三条路；只读，不写。
//
// DIARY_ROLE 2026-11-17（批次654）：**私有段的裁剪只有 日记.mjs 一处实现。**
// 这里原来自己 readFileSync + replace(/~~/g,'')，等于把「划掉的句子」和
// 「## 只给你」整节都当成公开内容交出去 —— 群聊里 qq_recall 一翻就能看到。
// 现在改走 日记.mjs 的 读一篇() + 给角色(篇, role)：owner 拿全部，
// 其他角色拿到的就是全站统一裁剪后的公开段。
// 角色由环境变量 QQ_RECALL_ROLE 传入（recall.js 判私聊主人后设 owner），
// 缺省是 guest —— 忘了传只会少给，不会多给。
function 读日记段(day) {
  try {
    // DIARY_ROLE 2026-11-17（批次654）：私有段裁剪只认 日记.mjs 一处实现。
    // 目录由这里显式传进去（QQ_RECALL_DIARY），不靠改 process.env ——
    // 日记.mjs 的默认目录在模块加载时就定了，改 env 已经来不及。
    const 篇 = 读一篇(day, 日记目录)
    if (!篇) return []
    const 角色 = process.env.QQ_RECALL_ROLE === 'owner' ? 'owner' : 'guest'
    const 视 = 给角色(篇, 角色)
    if (!视) return []
    return (视.sections || [])
      .flatMap((s) => s.段 || [])
      .map((x) => String(x?.文 ?? '').replace(/~~/g, '').replace(/\s+/g, ' ').trim())
      .filter((s) => s.length > 10)
  } catch { return [] }
}

function 读链() {
  const p = join(base, '链.md')
  if (!existsSync(p)) return []
  let 死链 = new Set()
  try {
    const v = JSON.parse(readFileSync(join(base, '链-作废.json'), 'utf8'))
    死链 = new Set((v['条目'] || []).map((x) => String(x['at'] || '')))
  } catch (_err) { console.error('[回忆]', _err?.message || _err) }
  return readFileSync(p, 'utf8')
    .split(/^## /m)
    .filter((x) => x.trim() !== '' && !是旧黑话链(x))
    .map((b) => {
      const lines = b.trim().split('\n')
      const at = (lines[0] || '').trim()
      if (死链.has(at.slice(0, 16))) return null
      const judge = (lines.find((l) => l.startsWith('- 判断：')) || '').replace('- 判断：', '').trim()
      return { at, text: judge }
    })
    .filter((x) => x && x.at && x.text)
}

function 所有天() {
  const set = new Set()
  const scan = (dir) => {
    try {
      for (const f of readdirSync(dir)) {
        const m = f.match(/^(?:手账|梦)-(\d{4}-\d{2}-\d{2})\.md$/)
        if (m) set.add(m[1])
      }
    } catch (_err) { if (_err?.code !== 'ENOENT') console.error('[回忆]', _err?.message || _err) }
  }
  scan(base)
  scan(join(base, '手账'))
  scan(join(base, '梦'))
  try {
    const archRoot = join(base, '归档', '历史按月')
    if (existsSync(archRoot)) {
      for (const ym of readdirSync(archRoot)) scan(join(archRoot, ym))
    }
  } catch (_err) { console.error('[回忆]', _err?.message || _err) }
  try {
    for (const f of readdirSync(日记目录)) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/)
      if (m) set.add(m[1])
    }
  } catch (_err) { console.error('[回忆]', _err?.message || _err) }
  return [...set].sort().reverse()
}

/** 流水账：走路、买东西、吃喝。不是不重要，是太碎 —— 给「事件」让位，只补几条。 */
const 流水账 = /买了|走到|吃了|喝了|接了|放了/

function 查日(day) {
  const all = 读手账(day)
  const 事件 = all.filter((l) => !流水账.test(l)).slice(0, 7)
  const 流水 = all.filter((l) => 流水账.test(l)).slice(0, 3)
  // 事件先选、再按时间排回去 —— 不然「15:40 洗澡」后面接「01:18 走回家」，读着像时间倒流
  const 时刻 = (l) => (l.match(/^(\d{2}:\d{2})/) || [, '99:99'])[1]
  const 手账 = 事件.concat(流水).sort((a, b) => 时刻(a).localeCompare(时刻(b)))
  const out = 手账.map((line) => ({ 来源: '手账', 日: day, 文: 截(line) }))
  for (const seg of 读日记段(day).slice(0, 2)) out.push({ 来源: '日记', 日: day, 文: 截(seg) })
  const dream = 读梦(day)
  if (dream) out.push({ 来源: '梦', 日: day, 文: 截(dream) })
  return out
}

function 查词(词, 限定日 = '') {
  const q = String(词 ?? '').trim()
  if (!q) return []
  const qLow = q.toLowerCase()
  const match = (text) => String(text ?? '').toLowerCase().includes(qLow)
  const out = []
  const days = 限定日 ? [限定日] : 所有天()
  for (const day of days) {
    for (const line of 读手账(day)) {
      if (match(line)) out.push({ 来源: '手账', 日: day, 文: 截围绕(line, q) })
      if (out.length >= 60) break
    }
    const dream = 读梦(day)
    if (dream && match(dream)) out.push({ 来源: '梦', 日: day, 文: 截围绕(dream, q) })
    for (const seg of 读日记段(day)) {
      if (match(seg)) out.push({ 来源: '日记', 日: day, 文: 截围绕(seg, q) })
    }
    if (out.length >= 60) break
  }
  for (const it of 读链()) {
    if (限定日 && it.at.slice(0, 10) !== 限定日) continue
    if (match(it.text)) out.push({ 来源: '链', 日: it.at.slice(0, 10), 文: 截围绕(it.text, q) })
  }
  return out
}

const 是入口 = (() => {
  try { return !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) }
  catch { return false }
})()

if (是入口) {
  const 日参 = val('--日', '')
  const 词参 = val('--词', '')
  const 最近 = Number(val('--最近', '')) || 0

  let 结果 = []
  let 说明 = ''

  if (日参) {
    const day = 解析日(日参)
    if (!day) { 说明 = '日期看不懂：' + 日参 + '（要 2026-11-05 / 今天 / 昨天 / 前天 / N天前）' }
    else if (词参) {
      结果 = 查词(词参, day)
      if (!结果.length) 说明 = day + ' 没找到提到「' + 词参 + '」的记录'
    } else {
      结果 = 查日(day)
      if (!结果.length) 说明 = day + ' 没有手账也没有梦'
    }
  } else if (词参) {
    结果 = 查词(词参)
    if (!结果.length) 说明 = '没找到提到「' + 词参 + '」的记录'
  } else {
    const n = Math.max(1, Math.min(7, 最近 || 3))
    for (const day of 所有天().slice(0, n)) 结果 = 结果.concat(查日(day))
    if (!结果.length) 说明 = '最近 ' + n + ' 天没有记录'
  }

  // TRUNC 2026-11-17（批次639）：原来超过 12 条直接切掉，说明一个字不提。
  // 她翻到 12 条就会当成「只有 12 条」照实说出去 —— 2026-11-16 那次「就这几条」
  // 就是这么来的。现在把总数记下来，说明里写清楚只列了前 12 条。
  const 总数 = 结果.length
  结果 = 结果.slice(0, 条目上限)
  if (总数 > 结果.length) {
    const 截断 = '匹配 ' + 总数 + ' 条，这里只列前 ' + 条目上限 + ' 条（换个更窄的词或指定某一天能看别的）'
    说明 = 说明 ? 说明 + '；' + 截断 : 截断
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ ok: 结果.length > 0, 条数: 结果.length, 总数, 说明, 条目: 结果 }, null, 2))
    process.exit(0)
  }

  if (!结果.length) {
    console.log(说明 || '没找到。')
    process.exit(0)
  }

  // 按「来源 · 日」分组打印。同一天的手账可能被拆成「事件」和「流水」两段，
  // 这里合并回一个标题下，不然会出现两个「手账 · 2026-11-06」。
  const 组 = []
  const 位置 = new Map()
  for (const it of 结果) {
    const tag = it.来源 + ' · ' + it.日
    if (!位置.has(tag)) { 位置.set(tag, 组.length); 组.push({ tag, 条: [] }) }
    组[位置.get(tag)].条.push(it)
  }
  for (const g of 组) {
    console.log('\n' + g.tag)
    for (const it of g.条) console.log('  ' + it.文)
  }
  console.log('\n共 ' + 结果.length + ' 条' + (总数 > 结果.length ? '（匹配 ' + 总数 + ' 条，只列了前 ' + 条目上限 + ' 条）' : ''))
}
