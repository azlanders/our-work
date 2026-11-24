// AUDIT_V3 2026-11-03：收紧假警报（同名只看同块顶层、被调用的脚本不算漏排期）
// 冲突体检 v2：把插件目录也算进"参数是否被读"，兜底值只查真参数名（v1 里 score/energy 这种是同名巧合）
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const T = '{{BOT_ROOT}}/共享/工具'
const M = '{{BOT_ROOT}}/记忆'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

const read = (p) => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const collect = (dir) => {
  const skip = new Set(['node_modules', '.git', 'img', 'models', 'wb', 'three', '__pycache__', '.cache'])
  // 最多进入 3 层子目录，f 始终使用相对根目录的 / 分隔路径。
  const walk = (current, rel = '', depth = 0) => {
    try {
      return fs.readdirSync(current, { withFileTypes: true }).flatMap((e) => {
        const full = path.join(current, e.name)
        const relative = rel ? `${rel}/${e.name}` : e.name
        if (e.isDirectory()) {
          if (depth >= 3 || skip.has(e.name) || e.name.startsWith('归档')) return []
          return walk(full, relative, depth + 1)
        }
        if (!e.isFile() || (!e.name.endsWith('.mjs') && !e.name.endsWith('.js'))) return []
        try {
          if (fs.statSync(full).size > 2 * 1024 * 1024) return []
          return [{ dir, f: relative, text: read(full) }]
        } catch { return [] }
      })
    } catch { return [] }
  }
  return walk(dir)
}

const sources = [...collect(T), ...collect(LIB)]
// LIST_EXCLUDE 2026-11-04：清单类脚本（如 清死参数.mjs）会把参数名当字符串写着，
// 体检若把它算进「源码里有人读」，就会得出「没有孤儿」的假绿。这里按文件名排除。
const __isListFile = (f) => /清单|清死参数/.test(f)
const __allSources = sources.filter((x) => !__isListFile(x.f))
const all = __allSources.map((s) => s.text).join('\n')

const out = []
const line = (tag, msg) => out.push(`${tag} ${msg}`)

// ---------- 1) 参数孤儿（含插件目录）
let params = {}
try { params = JSON.parse(read(path.join(T, '参数.json'))) } catch { /* 无 */ }
const leaves = new Set()
const walk = (o) => { for (const [k, v] of Object.entries(o || {})) { if (k.startsWith('_')) continue; if (v && typeof v === 'object' && !Array.isArray(v)) walk(v); else leaves.add(k) } }
walk(params)
const orphans = [...leaves].filter((k) => !all.includes(k) && k !== '_说明')
if (orphans.length) line('🟡', `参数写了但两处代码都不读（${orphans.length} 个）：${orphans.slice(0, 20).join('、')}${orphans.length > 20 ? ' …' : ''}`)
else line('🟢', '参数没有孤儿（工具 + 插件都算上）')

// ---------- 2) 兜底值分裂：只查真参数名（出现在参数表里的键，或 T./参数. 前缀取值）
const paramKeys = new Set([...leaves])
const fallbacks = {}
const re = /(?:T\.|参数\.)?([\w\u4e00-\u9fa5]+)\s*(?:\?\?|\|\|)\s*(-?\d+(?:\.\d+)?)/g
for (const s of sources) {
  let m
  while ((m = re.exec(s.text))) {
    const key = m[1]
    // 2026-11-07（批次175）：两个假警报的来源，全在这里。
    // ① 「别扭档位」在参数表里是数字键 1/2/3，于是 `Number(x) * 2 || 60` 里的 `2`
    //    被当成「参数 2」，报出一条 🔴「兜底值分裂 60 / 16000」——
    //    16000 是插件里 config.requestTimeoutMs 的兜底，跟「2」八竿子打不着。
    //    **红色的假警报比没有警报更糟**：看两次就不再看红色了。
    if (!/[^\d]/.test(key)) continue                 // 纯数字的键（1/2/3）不参与
    const 前 = s.text.slice(Math.max(0, m.index - 2), m.index).trim().slice(-1)
    if ('*/+-'.includes(前)) continue                // `x * 2 || 60` 是算术，不是参数兜底
    if (!paramKeys.has(key)) continue
    fallbacks[key] = fallbacks[key] || new Set()
    fallbacks[key].add(m[2])
  }
}
const split = Object.entries(fallbacks).filter(([, v]) => v.size > 1)
if (split.length) split.forEach(([k, v]) => line('🔴', `兜底值分裂「${k}」：${[...v].join(' / ')}`))
else line('🟢', '参数兜底值一致')

// ---------- 3) 名字冲突（AUDIT_V3：只看同一 <script> 块、且顶格的 function/window 赋值）
// 为什么收紧：上一版把登录页模板字符串里的定义、以及嵌套作用域里的同名都算成冲突，
// 全是假警报。真正的覆盖只发生在「同一个脚本块、同一层作用域」。
const panel = sources.find((s) => s.f === '面板.mjs')
if (panel) {
  const blocks = []
  const reBlock = /<script[^>]*>([\s\S]*?)<\/script>/g
  let mb
  while ((mb = reBlock.exec(panel.text))) blocks.push(mb[1])
  if (blocks.length === 0) blocks.push(panel.text)
  const problems = []
  blocks.forEach((code, bi) => {
    const fns = []
    const wins = []
    code.split('\n').forEach((line) => {
      if (/^function\s+[A-Za-z_$][\w$]*\s*\(/.test(line)) fns.push(line.match(/^function\s+([A-Za-z_$][\w$]*)/)[1])
      const mw = line.match(/^(?:window\.)([A-Za-z_$][\w$]*)\s*=/)
      if (mw) wins.push(mw[1])
    })
    const dup = fns.filter((n, i) => fns.indexOf(n) !== i)
    if (dup.length) problems.push('块' + (bi + 1) + ' 顶层重复函数：' + [...new Set(dup)].join('、'))
    const over = wins.filter((n) => fns.includes(n))
    if (over.length) problems.push('块' + (bi + 1) + ' window 覆盖同名函数：' + over.join('、'))
  })
  if (problems.length) problems.forEach((p) => line('🔴', '面板.mjs ' + p))
  else line('🟢', '面板.mjs 同一脚本块内没有同名覆盖')
}

// ---------- 4) 时区混用
const tzBad = sources.filter((s) => /toISOString\(\)/.test(s.text) && /getHours\(\)|getDate\(\)/.test(s.text) && !/8 \* 3600|288e5/.test(s.text)).map((s) => s.f)
line(tzBad.length ? '🟡' : '🟢', tzBad.length ? `可能时区混用：${tzBad.join('、')}` : '时区用法未见明显混用')

// ---------- 5) cron 覆盖（AUDIT_V3：被别的脚本 execFileSync/spawn 调用的，不算漏排期）
let cron = ''
try { cron = execFileSync('crontab', ['-l'], { encoding: 'utf8' }) + '\n' + read(path.join(T, '心跳表.json')) } catch { /* 无 */ }
const CANDIDATES = ['状态推进.mjs', '困意.mjs', '自动作息.mjs', '耐心.mjs', '自主行动.mjs', '内心.mjs',
  '印象更新.mjs', '记忆消退.mjs', '生长复盘.mjs', '做梦.mjs', '做梦整合.mjs', '手账.mjs', '自我巡检.mjs',
  '碎片.mjs', '好感度-日结.mjs', '自动学习.mjs']
const calledBy = (name) => sources.some((s) => s.f !== name && s.text.includes("'" + name + "'"))
const missing = CANDIDATES.filter((f) => {
  if (!fs.existsSync(path.join(T, f))) return false
  if (cron.includes(f)) return false
  if (calledBy(f)) return false // 被别的脚本调用 = 已接线
  return true
})
line(missing.length ? '🔴' : '🟢', missing.length ? '脚本存在但既没排期也没人调用：' + missing.join('、') : '定时脚本要么在 crontab、要么被别的脚本调用')

// ---------- 6) 字段新鲜度（含 body 这类常年不动的）
let st = {}
try { const v = JSON.parse(read(path.join(M, '状态.json'))); st = v && typeof v === 'object' ? v : {} } catch { /* 无 */ } // 2026-11-04 修：文件里是 null 时也要回落成对象
const stale = []
const now = Date.now()
const chk = (label, v) => {
  const t = Date.parse(String(v || '').replace(' ', 'T') + (String(v || '').includes('T') ? '' : '+08:00'))
  if (Number.isFinite(t)) { const h = (now - t) / 3600e3; if (h > 48) stale.push(`${label} 停在 ${v}（${Math.round(h)} 小时前）`) }
}
if (st['耐心']) { chk('耐心.短期更新于', st['耐心']['短期更新于']); chk('耐心.长期更新于', st['耐心']['长期更新于']) }
if (st['更新时间']) chk('状态.更新时间', st['更新时间'])
line(stale.length ? '🟡' : '🟢', stale.length ? `字段过期：${stale.join('；')}` : '状态时间戳都新鲜')

console.log(out.join('\n'))
