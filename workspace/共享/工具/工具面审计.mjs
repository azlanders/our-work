#!/usr/bin/env node
// 工具面审计.mjs —— 批次463（2026-11-14）
//
// 起因：主人发的视频警告「插件提醒你调 compress 工具，而白名单没有它 → 反复提醒 → 烧 token」。
// 那不是 compress 一个工具的事，是**三个面**对不上：
//   ① 注册面：插件/宿主真正注册了哪些工具；
//   ② 白名单：她实际能看到哪些（qq-bridge.config.json 的 工具白名单）；
//   ③ 提示面：有哪些文字在**让她去调**某个工具（SOUL/门牌/注入槽/插件提示词）。
// 只要「③ 提到」「② 没有」，她就会去调一个看不见的工具 —— 轻则报错，重则死循环。
//
// 这个脚本把三面都扫出来对账。只读，不改任何东西。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const DIR = '{{BOT_ROOT}}'
const TOOLS = path.join(DIR, '共享/工具')
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const NM = '{{DSH_ROOT}}/profiles/web/node_modules'
const CFG = '{{DSH_ROOT}}/qq-bridge.config.json'

const 白名单 = (() => {
  try { return (JSON.parse(fs.readFileSync(CFG, 'utf8')).工具白名单) || [] } catch { return [] }
})()

// ── ① 注册面：假 tools 服务，只 register 不 execute ──
const 注册 = []
{
  const 假 = { register(d) { 注册.push(d && d.name); return () => {} }, get() {} }
  const ctx = { tools: 假, get: (k) => (k === 'tools' ? 假 : undefined), effect() {}, log() {}, getConfig: () => ({}) }
  const 文件 = fs.readdirSync(LIB).filter((f) => f.endsWith('.js')).sort()
  for (const f of 文件) {
    try {
      const m = await import(pathToFileURL(path.join(LIB, f)).href)
      for (const [k, v] of Object.entries(m)) {
        if (typeof v !== 'function') continue
        if (!/^register/.test(k)) continue
        try { await v(ctx) } catch {
          // 单个注册函数失败不影响整体；下面用数量对账
        }
      }
    } catch {}
  }
}

// ── ③ 提示面：扫「让她去调某个工具」的句子 ──
const 提示源 = []
const 收文本 = (p, 标签) => {
  try {
    const t = fs.readFileSync(p, 'utf8')
    if (t.length < 4 || t.length > 2 * 1024 * 1024) return
    提示源.push({ 标签, 文本: t })
  } catch {}
}
// 她自己读的文件
for (const f of ['SOUL.md', '门牌.md', '梗知识.md', '热记忆.md']) 收文本(path.join(DIR, f), f)
// 注入槽
// tool.js 里的 description 就是她挑工具时读的字，必须算进提示面
收文本(path.join(LIB, 'tool.js'), '插件/tool.js')
for (const f of ['voiceSlots.js', 'poll.js', '感受.mjs', 'stateVoice.js']) {
  收文本(path.join(LIB, f), '插件/' + f)
  if (f.endsWith('.mjs')) 收文本(path.join(TOOLS, f), '工具/' + f)
}
// 插件里的提示词（含 memewiki / rofm / live-compact 等）
for (const d of fs.readdirSync(NM)) {
  if (d.startsWith('.')) continue
  const 目录 = path.join(NM, d)
  let st
  try { st = fs.lstatSync(目录) } catch { continue }
  if (!st.isDirectory()) continue
  let 名们 = []
  try { 名们 = fs.readdirSync(目录) } catch { continue }
  for (const f of 名们) {
    if (!/\.(js|mjs)$/.test(f)) continue
    收文本(path.join(目录, f), d + '/' + f)
  }
}

// 从提示文本里抽工具名：只在「工具/tool」这个词附近取英文标识符
const 提到 = new Map()   // 工具名 → 出处集合
const 句式 = [
  /(?:调用|使用|用|调用一下|调)\s*[`'"]?([a-z][a-z0-9_]{2,29})[`'"]?\s*工具/g,
  /([a-z][a-z0-9_]{2,29})\s*(?:工具|tool)\b/g,
  /\b(?:call|use|invoke)\s+(?:the\s+)?[`'"]?([a-z][a-z0-9_]{2,29})[`'"]?\s*(?:tool)?/gi,
]
for (const { 标签, 文本 } of 提示源) {
  for (const re of 句式) {
    for (const m of 文本.matchAll(re)) {
      const 名 = m[1]
      if (!名 || 名.length < 3) continue
      if (['the', 'and', 'for', 'with', 'tool', 'tools', 'this', 'that', 'your'].includes(名.toLowerCase())) continue
      if (!提到.has(名)) 提到.set(名, new Set())
      提到.get(名).add(标签)
    }
  }
}

// 宿主自带、无需插件注册的工具（她白名单里这些是宿主提供的）
const 宿主工具 = new Set(['bash', 'web_search', 'web_fetch', 'read_image', 'memory_judge',
  'memory_recall', 'memory_image', 'search_meme_wiki', 'read_animation', 'video_zoom'])

const 注册集 = new Set(注册.filter(Boolean))
const 白集 = new Set(白名单)
const 现 = Date.now()
const 时 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')

const 出 = []
出.push('# 工具面审计 · ' + 时(现))
出.push('')
出.push(`注册到 ${注册集.size} 个工具 · 白名单 ${白集.size} 个 · 提示面 ${提示源.length} 份文本里提到 ${提到.size} 个疑似工具名`)
出.push('')

// 差集 A：注册了、白名单没有
const 没进白 = [...注册集].filter((x) => !白集.has(x)).sort()
出.push('## A. 注册了但不在白名单（她看不见）：' + 没进白.length + ' 个')
出.push('')
if (没进白.length) for (const x of 没进白) 出.push('- ' + x)
else 出.push('（无）')
出.push('')

// 差集 B：白名单有、注册面没有（可能是宿主提供，也可能幽灵）
const 幽灵 = 白名单.filter((x) => !注册集.has(x) && !宿主工具.has(x)).sort()
出.push('## B. 白名单里有、但没人注册（幽灵？）：' + 幽灵.length + ' 个')
出.push('')
if (幽灵.length) for (const x of 幽灵) 出.push('- ' + x)
else 出.push('（无 —— 白名单里除了宿主工具，其余都能在插件注册面找到）')
出.push('')

// 差集 C：提示面提到、但白名单没有 —— 这就是视频里那个坑的形状
const 坑 = []
for (const [名, 源] of 提到) {
  if (白集.has(名)) continue
  // tool.js 里的 description 会提到自己的名字（"用 qq_xxx 干嘛"），这是自指，不算「让她调一个看不见的工具」
  if ([...源].every((x) => x === '插件/tool.js')) continue
  if (注册集.has(名)) { 坑.push({ 名, 源, 类型: '注册了但白名单没有' }); continue }
  if (宿主工具.has(名)) continue
  // 只保留看起来真的像工具名的（snake_case 或 qq_ 前缀 或 在注册面里出现过）
  // 只留看起来真的是工具名的：必须有下划线（compact/model/only 这类英文词全部排除）
  if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(名)) continue
  坑.push({ 名, 源, 类型: '不在白名单、也不在注册面' })
}
坑.sort((a, b) => a.类型.localeCompare(b.类型))
出.push('## C. 提示面让她调、白名单里没有：' + 坑.length + ' 个（视频里那个坑的形状）')
出.push('')
for (const x of 坑.slice(0, 30)) 出.push(`- **${x.名}**（${x.类型}）出现在：${[...x.源].slice(0, 3).join('、')}`)
if (!坑.length) 出.push('（无）')
出.push('')

// 差集 D：白名单里每个工具，提示面覆盖了多少（反过来看哪些工具从没被教过怎么用）
const 全文 = 提示源.map((x) => x.文本).join('\n')
const 没教 = 白名单.filter((x) => !全文.includes(x))
出.push('## D. 白名单里有、但提示面从没提过（她不知道什么时候用）：' + 没教.length + ' 个')
出.push('')
for (const x of 没教) 出.push('- ' + x)

const 文本 = 出.join('\n')
const 目录 = path.join(DIR, '共享/工作日志')
const 名 = '工具面审计-' + new Date(现 + 8 * 3600e3).toISOString().slice(0, 16).replace(/[-:T]/g, '').slice(0, 12) + '.md'
try { fs.writeFileSync(path.join(目录, 名), 文本) } catch (e) { console.log('写报告失败：' + e.message) }
console.log(文本)
console.log('\n---- 报告：共享/工作日志/' + 名)
