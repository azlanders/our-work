#!/usr/bin/env node
// 体检-闭环.mjs —— 查「接口做了、接入点没有」（2026-11-09 批次309）
//
// 为什么要有：批次307 发现 关系.json 从 11-04 起再没更新 —— 关系.mjs 唯一的调用方
// 是批次63 就停用的 认事.mjs，而 voiceSlots 三个槽和 激素.mjs 一直在读它。
// 同类问题在好感度（批次298「一直是 60」）、回头说（有存储有消费、没写入端）都出现过。
//
// 判据只取「结构明确」的三类，宁可漏报不要噪音（weather-watch 那条教训：
// 每天报的噪音会训练人忽略它）。「数据只读不写」这类靠变量拼接就能骗过静态分析，
// 不在这里自动判定，只在末尾列新鲜度供人看。
//
// 用法：node 体检-闭环.mjs [--静]
// 退出码：心跳表脚本缺失 → 1；其余只报告不失败。
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
// 批次351：读 crontab 用。CRONTAB_CMD 可覆盖，单测要注入假的。
import { execSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as 待办 from './待办.mjs'   // TODO_SYNC 2026-11-14（批次409）：见文件末尾

const 这 = dirname(fileURLToPath(import.meta.url))
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const MEM = '{{BOT_ROOT}}/记忆'
const 账本 = join(MEM, '工具调用.jsonl')
const 心跳表 = join(这, '心跳表.json')
const 静 = process.argv.includes('--静')

const 读 = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

// 白名单：已经核实「故意不用」的导出，别再每周报一遍。
// 噪音会训练人忽略它（weather-watch 的教训）—— 但**加之前必须读代码注释**，
// 别把真断点加进来。加错的代价是以后再也不会报警。
let 白名单 = new Set()
try {
  const j = JSON.parse(读(join(这, '闭环白名单.json')))
  for (const x of j['允许死导出'] || []) 白名单.add(String(x))
} catch { /* 没有白名单就全报 */ }
const 有 = (p) => { try { statSync(p); return true } catch { return false } }

// ── 1. plugin/lib 的导出符号：全库 0 引用就是死代码 ────────────
const libFiles = readdirSync(LIB).filter((f) => /\.(js|mjs)$/.test(f))
const 全库 = new Map()
for (const f of libFiles) 全库.set('lib/' + f, 读(join(LIB, f)))
for (const f of readdirSync(这)) if (/\.(mjs|js)$/.test(f) && f !== '体检-闭环.mjs') 全库.set('tool/' + f, 读(join(这, f)))

const 死导出 = []
let 跳过 = 0
for (const f of libFiles) {
  if (f === 'index.js') continue // 入口的 name/inject/apply 由宿主按约定取，不是 import
  const s = 全库.get('lib/' + f) || ''
  for (const m of s.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$\u4e00-\u9fa5][\w$\u4e00-\u9fa5]*)/gm)) {
    const 名 = m[1]
    const 词 = 名.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp('(?<![\\w$\u4e00-\u9fa5])' + 词 + '(?![\\w$\u4e00-\u9fa5])', 'g')
    // 本文件内除了定义行还有引用（VOICE_SLOTS 数组、内部互调）→ 只是多余 export，不是死代码
    if ((s.match(re) || []).length > 1) continue
    re.lastIndex = 0
    let 外部 = 0
    for (const [p, src] of 全库) {
      if (p === 'lib/' + f) continue
      if (re.test(src)) { 外部 += 1; break }
    }
    if (外部 === 0) {
      const 键 = f + ' → ' + 名
      if (白名单.has(键)) 跳过 += 1
      else 死导出.push(键)
    }
  }
}

// ── 2. 心跳表里的脚本是否都存在 ────────────────────────────────
const 缺脚本 = []
try {
  const 表 = JSON.parse(读(心跳表))
  for (const t of 表['任务'] || []) {
    if (!t || !t['脚本']) continue
    if (!有(join(这, t['脚本']))) 缺脚本.push(t['名'] + ' → ' + t['脚本'])
  }
} catch (e) { 缺脚本.push('心跳表读不了：' + e.message) }

// ── 3. 注册了但从没调用过的工具 ────────────────────────────────
// USAGE396 2026-11-14（批次396）：原来只认 工具调用.jsonl。
// 那个账本靠劫持 tools.register 记账，只覆盖「插件自己注册之后、走同一个 tools 服务」的工具 ——
// 实测漏掉 30 种（memory_update 533 次 / memory_remember 449 / memory_judge 435 /
// web_search 20 / read_animation 7 / search_meme_wiki 18 全都没记）。
// 拿它判「零调用」会把正常在用的工具报成死的 —— 批次395 就这么误判了一整批。
// 现在优先用 工具用量.json（宿主 stream.jsonl 派生，一行不落），账本只当兜底。
const 已用 = new Set()
let 账本起点 = ''
let 用量源 = '工具调用.jsonl（兜底：只覆盖插件工具，宿主工具会漏）'
const 用量 = (() => { try { return JSON.parse(读(join(MEM, '工具用量.json'))) } catch { return null } })()
if (用量 && 用量['按工具'] && Object.keys(用量['按工具']).length) {
  for (const k of Object.keys(用量['按工具'])) 已用.add(String(k))
  账本起点 = String(用量['窗口起'] || 用量['生成于'] || '')
  用量源 = '工具用量.json（窗口 ' + String(用量['窗口天'] || '?') + ' 天，生成于 ' + String(用量['生成于'] || '') + '）'
} else {
  for (const line of 读(账本).split('\n')) {
    if (!line.trim()) continue
    try {
      const d = JSON.parse(line)
      const n = d.tool || d.name
      if (n) 已用.add(String(n))
      const t = String(d.at || '')
      if (t && (账本起点 === '' || t < 账本起点)) 账本起点 = t
    } catch { /* 坏行跳过 */ }
  }
}
// REG_SCOPE 2026-11-14（批次396c）：原来只扫 tool.js，于是 recall.js / work.js / go.js /
// photo.js / items.js / sleep.js / money.js / screen.js / voice.js / sayVoice.js 里注册的工具
// **从来没被体检看见过** —— qq_recall、qq_work 连续 7 天零调用，C 节一次都没报过。
// 「注册了没调用」这个判据，注册那一侧先漏了 9 个文件，等于判据本身不成立。
const 注册 = new Set()
for (const [f, src] of 全库) {
  if (!f.startsWith('lib/')) continue
  for (const m of src.matchAll(/name:\s*['"](qq_[a-z_]+)['"]/g)) 注册.add(m[1])
}
const 未调用全 = [...注册].filter((n) => !已用.has(n)).sort()
// NOT_GIVEN 2026-11-14（批次396b）：注册了但**没进白名单**的工具，她根本看不到、不可能调。
// 把它们混进「零调用」里，等于每周报三个永远不可能发生的警报 —— 噪音会训练人忽略体检
// （这条教训写在闭环白名单那段注释里，这次又踩了一遍）。
const 下发 = new Set(Array.isArray(用量?.['白名单工具']) ? 用量['白名单工具'].map(String) : [])
const 未调用 = 下发.size ? 未调用全.filter((n) => 下发.has(n)) : 未调用全
const 未下发 = 下发.size ? 未调用全.filter((n) => !下发.has(n)) : []

// ── 4. 数据新鲜度（只列，不判定）──────────────────────────────
const 数据名 = new Set()
for (const [f, s] of 全库) {
  if (!f.startsWith('lib/')) continue
  for (const m of s.matchAll(/['"`]([\u4e00-\u9fa5\w-]+\.(?:json|jsonl))['"`]/g)) 数据名.add(m[1])
}
const 被读 = []
for (const name of 数据名) {
  const p = join(MEM, name)
  if (!有(p)) continue
  let 谁读 = []
  for (const [f, s] of 全库) if (f.startsWith('lib/') && s.includes(name)) { 谁读.push(f.slice(4)); break }
  if (!谁读.length) continue
  const 天 = (Date.now() - statSync(p).mtimeMs) / 86400e3
  被读.push({ name, 天, 谁读: 谁读[0] })
}
被读.sort((a, b) => b.天 - a.天)

// ── 输出 ─────────────────────────────────────────────────────
const 北京 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 行 = []
行.push('闭环体检 ' + 北京)
行.push('')
行.push('A. plugin/lib 导出但全库零引用（' + 死导出.length + (跳过 ? '，白名单跳过 ' + 跳过 : '') + '；提示，不计问题）')
for (const x of 死导出.slice(0, 20)) 行.push('  · ' + x)
if (死导出.length > 20) 行.push('  … 另有 ' + (死导出.length - 20) + ' 条')
if (!死导出.length) 行.push('  （无）')
行.push('')
行.push('B. 心跳表脚本缺失（' + 缺脚本.length + '）')
for (const x of 缺脚本) 行.push('  ⚠ ' + x)
if (!缺脚本.length) 行.push('  （无）')
行.push('')
行.push('C. 下发了但零调用（' + 未调用.length + '，数据源 ' + 用量源 + '，起点 ' + (账本起点 || '未知') + '）')
行.push('  ' + (未调用.join(' ') || '（无）'))
if (未下发.length) 行.push('  注册了但没下发（不可能被调用，不算问题）：' + 未下发.join(' '))
行.push('')
行.push('D. 被 lib 读、最久没更新（只列，不判定；前 8）')
for (const x of 被读.slice(0, 8)) 行.push('  ' + x.name.padEnd(16) + x.天.toFixed(1) + ' 天   ← ' + x.谁读)

// ── 5. crontab 与心跳表双轨 ──────────────────────────────────
// 2026-11-09 批次344 踩过：日级任务迁进心跳表、crontab 没删 → 两边都跑（连跑三轮）。
// 反过来也危险：crontab 删了、心跳表没加 → 任务彻底停，而且没人知道。
const 双轨 = []
const 未收编 = []
try {
  const 任务表 = JSON.parse(读(心跳表))['任务'] || []
  const 表脚本 = new Set(任务表.map((t) => String(t['脚本'] || '')))
  const cron = execSync(process.env.CRONTAB_CMD || 'crontab -l 2>/dev/null || true',
    { encoding: 'utf8', timeout: 5000 })
  const 见过 = new Set()
  for (const 行c of cron.split('\n')) {
    if (行c.trim().startsWith('#')) continue
    const m = 行c.match(/([^\s/'"]+\.mjs)/)
    if (!m) continue
    const 脚本 = m[1]
    if (脚本 === '心跳.mjs') continue   // 调度器本身，不在表里是正常的
    if (见过.has(脚本)) continue
    见过.add(脚本)
    if (表脚本.has(脚本)) 双轨.push(脚本)
    else 未收编.push(脚本)
  }
} catch { /* 读不到 crontab 就跳过 */ }
行.push('')
行.push('E. crontab 与心跳表（两边都有 = 会跑两次）')
if (双轨.length) {
  行.push('  ⚠ 两边都有（' + 双轨.length + '）：' + 双轨.slice(0, 6).join(' ')
    + (双轨.length > 6 ? ' … 另有 ' + (双轨.length - 6) + ' 个' : ''))
} else {
  行.push('  两边都有：0')
}
行.push('  只在 crontab、没进心跳表（' + 未收编.length + '）：' + (未收编.slice(0, 8).join(' ') || '（无）')
  + (未收编.length > 8 ? ' … 另有 ' + (未收编.length - 8) + ' 个' : ''))

const 文本 = 行.join('\n')
if (!静) console.log(文本)
else console.log('闭环体检：死导出 ' + 死导出.length + (跳过 ? '（白名单 ' + 跳过 + '）' : '') + '，缺脚本 ' + 缺脚本.length + '，未调用工具 ' + 未调用.length + '，双轨 ' + 双轨.length + '，最旧数据 ' + (被读[0] ? 被读[0].name + ' ' + 被读[0].天.toFixed(1) + ' 天' : '—'))
// TODO_SYNC 2026-11-14（批次409）：结果要有人看得见。
// 原来它只写一行摘要进 闭环体检.log —— 而那个文件停在 11-09 05:10（上一次周一），
// 也就是说「跑了、但没人翻」。三个每周体检都是这个毛病：日志是给已经会去看的人写的。
// 现在改成：有问题就在面板「需要你处理」里挂一条，条件消失自动挪进 done（同 会话体检）。
// 不算问题的两项（下面这两条一直是这个数，报上去就是噪音）：
//   · 未调用工具 8 —— 都是场景没发生（qq_card / qq_watch_video / qq_qzone_post …）
//   · 被 lib 读、最久没更新 —— D 节本来就写着「只列，不判定」
const 该管的 = []
if (缺脚本.length > 0) 该管的.push('心跳表里的脚本缺了 ' + 缺脚本.length + ' 个：' + 缺脚本.slice(0, 4).join('、'))
if (双轨.length > 0) 该管的.push('crontab 与心跳表两边都有 ' + 双轨.length + ' 个：' + 双轨.slice(0, 4).join('、'))
const 闭环 = 该管的.length ? {
  证据: 该管的.join('；'),
  根因: '待负责人核实；本次体检只确认结构命中，不把现象当成已证实根因',
  负责人: '维护者',
  授权: '待主人决定是否修复、归档或接受现状',
  下一步: '查看闭环体检输出与对应脚本，补充根因和处理方案后再改动',
  复验: '处理后重跑体检-闭环，确认同一稳定 id 不再命中',
  回滚点: '本次体检未改代码或数据；若后续修改，使用该次修改的发布前快照回退',
  回执: '待负责人记录实际处理结果；体检不代替人工确认',
} : undefined
try {
  待办.同步({
    id: '体检-闭环',
    事项: '闭环体检发现问题：' + 该管的.join('；'),
    来源: '闭环体检',
    该在: 该管的.length > 0,
    闭环,
  })
} catch (e) {
  // TODO_FAIL 2026-11-14（批次409）：原来这里是空 catch —— 而「待办.同步 is not a function」
  // 就是这么被吞掉的（二号机的 待办.mjs 还是批次385 之前的版本，没有 同步）。
  // 体检照跑、待办静默不写、谁都不知道。写一行 stderr：不影响体检本身，但心跳日志里看得见。
  process.stderr.write('[待办未写入] ' + String(e && e.message || e).slice(0, 100) + '\n')
}

// EXIT_ALIGN 2026-11-14（批次429）：退出码原来只看「缺脚本」，而上面 `该管的` 认三件事
// （死导出 / 缺脚本 / 双轨）。语义上不一致：面板挂待办说「体检发现问题」，
// 退出码却回 0，任何人拿 `$?` 判都不会知道。
// 现在跟 `该管的` 对齐；死导出只是提示，不计问题（见 A 段标题）。
process.exit(该管的.length > 0 ? 1 : 0)
