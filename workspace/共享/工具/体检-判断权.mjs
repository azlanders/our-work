#!/usr/bin/env node
// 体检-判断权.mjs —— 「这是好事/坏事/我被注意到了」该由她自己判，系统只递事实。
//
// 为什么需要这个脚本：
//   同一个错已经犯过三次 ——
//     ① 正则判「滚=骂人」：6624 条真实语料里 47 条「被骂」几乎全是「回滚/滚动」误报
//     ② 收到贴表情就自动加催产素：系统替她判「我被注意到了」
//     ③ 认事.mjs → 奖惩.mjs --识别：每条群消息用正则判夸/骂，直接改好感度和状态
//        （它自己的账本 6 条里 5 条是误判，含「别是又变成滚木了」判成「坏话」扣 1.2）
//
//   每次都是「加功能时顺手让系统替她下判断」，当时都觉得没问题，事后才发现错得离谱。
//   所以把这条检查变成能跑的，加新功能前后各跑一次。
//
// 用法：
//   node 体检-判断权.mjs          # 检查 + 列清单
//   node 体检-判断权.mjs --strict # 有硬性违规就退出码 1（给 CI / 定时任务用）
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import * as 待办 from './待办.mjs'   // TODO_SYNC 2026-11-14（批次409）

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const SELF = '体检-判断权.mjs'
// 认事.mjs 和 奖惩.mjs 已经停用，里面的 --识别 / 正则都还在（留着查历史）。
// 检测时排除它们自己 —— 否则每次跑都报「有文件在调 --识别」，报的是尸体。
const 已停用 = new Set(['认事.mjs', '奖惩.mjs'])

const args = process.argv.slice(2)
const strict = args.includes('--strict')

let bad = 0
const 硬性 = []
const 提醒 = []

function read(p) {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return ''
  }
}

function filesIn(dir, exts) {
  try {
    return readdirSync(dir)
      .filter((f) => exts.some((e) => f.endsWith(e)))
      .map((f) => join(dir, f))
  } catch {
    return []
  }
}

// ── 一、三条已知的「代判」不许复活 ────────────────────────────
console.log('── 一、已经改掉的三处，别偷偷加回来 ──')

const poll = read(join(LIB, 'poll.js'))
if (/spawn\([^)]*认事\.mjs/.test(poll)) {
  硬性.push('poll.js 又在 spawn 认事.mjs —— 那是「正则判夸/骂 → 直接改好感度和状态」，2026-11-05 拆掉的')
} else {
  console.log('  ✓ poll.js 不再 spawn 认事.mjs')
}

const like = read(join(LIB, '贴表情.mjs'))
// 只看代码行：注释里专门写了「别再把 feedHormone 加回来」，会被误判
const likeCode = like.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
if (/feedHormone\s*\(/.test(likeCode)) {
  硬性.push('贴表情.mjs 又出现 feedHormone( —— 那是「系统替她判我被注意到了」，改成让她自己记「被注意到」')
} else {
  console.log('  ✓ 贴表情.mjs 不再自动喂激素')
}

// 认事.mjs 停用后，任何文件再调 奖惩.mjs --识别 都算复活
let 识别调用 = 0
for (const f of [...filesIn(LIB, ['.js', '.mjs']), ...filesIn(TOOLS, ['.mjs'])]) {
  if (f.endsWith(SELF) || 已停用.has(f.split('/').pop())) continue
  const s = read(f)
  // 注释里提到 --识别 不算（那是说明，不是调用）
  const code = s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  const hit = code.match(/'--识别'|"--识别"/)
  if (hit !== null) 识别调用 += 1
}
if (识别调用 > 0) {
  硬性.push(`有 ${识别调用} 个文件还在调 奖惩.mjs --识别（那套正则的误报率是 5/6）`)
} else {
  console.log('  ✓ 没有任何文件再调 奖惩.mjs --识别')
}

// ── 二、激素事件必须都在表里 ──────────────────────────────────
console.log('\n── 二、喂给激素的事件，必须在事件表里 ──')

const hj = read(join(TOOLS, '激素.mjs'))
const tableKinds = new Set()
for (const m of hj.matchAll(/^\s{2}([\u4e00-\u9fa5A-Za-z_]+):\s*\{/gm)) {
  tableKinds.add(m[1])
}
// 事件表以外还有 DEFAULTS 之类的同名键，靠下面的实际比对兜底

let 未知事件 = []
for (const f of [...filesIn(LIB, ['.js', '.mjs']), ...filesIn(TOOLS, ['.mjs'])]) {
  if (f.endsWith(SELF) || f.endsWith('激素.mjs')) continue
  const s = read(f)
  const code = s.split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  const 好感度目标 = new Set([...code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[^;\n]*好感度\.mjs/g)].map((m) => m[1]))
  for (const m of code.matchAll(/--event['",\s]+['"]([\u4e00-\u9fa5]+)['"]/g)) {
    const at = m.index
    const begin = code.lastIndexOf('[', at)
    const comma = code.indexOf(',', begin)
    if (begin < 0 || comma < 0) continue
    const target = code.slice(begin + 1, comma).trim().replace(/^['"]|['"]$/g, '')
    if (好感度目标.has(target) || target.includes('好感度.mjs')) continue
    const 是激素 = target.includes('激素.mjs') || [...code.matchAll(/(?:const|let)\s+(\w+)\s*=\s*[^;\n]*激素\.mjs/g)].some((x) => x[1] === target)
    if (!是激素) continue
    if (!tableKinds.has(m[1])) 未知事件.push(`${f.split('/').pop()} → ${m[1]}`)
  }
}
if (未知事件.length > 0) {
  硬性.push('这些事件名在 激素.mjs 的事件表里找不到：' + [...new Set(未知事件)].join('、'))
} else {
  console.log('  ✓ 所有 --event 的名字都能在事件表里找到')
}

// ── 三、用正则判态度的地方（人工审查清单）────────────────────
console.log('\n── 三、用中文正则判「态度/情绪」的地方（要人看，不是自动判错）──')

const 情绪词 = /(骂|夸|烦|滚|蠢|笨|废物|垃圾|讨厌|喜欢|可爱|谢谢|对不起|抱歉|越界|催|凶|生气|难过|开心|委屈|敷衍)/

// 已经逐条看过、确认可以留的（用「文件名|片段」匹配，不用行号 —— 行号会漂）。
// 判据只有一条：**它判的是「这句话要干什么」，还是「他心里什么感觉」？**
// 前者留（有标点和固定说法撑着），后者删。
const 白名单 = new Map([
  ['closure.js|REQUEST_RE', '判「他是不是在让我做事」，用来决定要不要等他讲完 —— 意图，不是态度'],
  ['poll.js|帮我|麻烦|能不能', '意图提示「对方在请你帮忙」—— 判请求格式，不判情绪'],
  ['poll.js|多巴胺 ', '激素数值展示：斜杠只是字符串分隔符，不是正则，也没有判断任何人的态度'],
  ['碎片.mjs|难受|开心|害怕', '记忆权重：带情绪的事更容易被想起。这是记忆规律，不是在替她解读谁'],
  ['好感度|分享|道歉|和好', '统计历史事件的 kind，不是判断某句话'],
  ['面板.mjs|不错|开心', '只是选一个表情图标，不写任何账'],
  ['主动戳.mjs|喜欢', '命令行提示语，告诉人能传什么参数'],
  ['poll.js|qq_feel', '提示文案里列举了 qq_feel 的档位，不是判断'],
  // ── 2026-11-14（批次408）：第 3 段每次跑都报同样这 6 处，人看三次就不看了 ──
  // 逐条看过，判的都是「这句话要干什么」或「选哪个参数」，没有一处替她判态度：
  ['poll.js|别提端口、日志、脚本', '主人全权段的授权口径说明 —— 是给她的话术约束，不是判谁的态度'],
  ['tool.js|kind 可选：被骂', 'qq_feel 的档位枚举 —— 给她的选项清单，不是系统在判某句话'],
  ['voiceSlots.js|可以 qq_feel 记一笔', '体感槽里的提示文案：告诉她能记什么，判断还是她做'],
  ['voiceSlots.js|空间斩|世界斩', '梗词表（咒术回战等）—— 命中就递台词，不写任何账'],
  ['语音合成|太棒|好耶', '选语音场景参数（exclaim），只影响用哪段参考音，不写账'],
  // ── 2026-11-14（批次414）：qq_self 的 path 枚举 ──
  ['tool.js|偏好.喜欢 / 偏好.讨厌', 'qq_self 的 path 写法清单 —— 「喜欢/讨厌」是 偏好.json 的真实字段名，是给人看的填参示例，不是系统在判谁的态度'],
  // ── 2026-11-14（批次446）：qq_collect_face 的 list 描述 ──
  ['tool.js|有名字的带场合', '收藏表情的场合标签（委屈/被气到/没话接/好吃）是她自己在 表情备注.md 里定的分类，描述里只是告诉她有这一层 —— 不是系统在判谁的态度'],
])

function 在白名单里(file, text) {
  for (const [key, why] of 白名单) {
    const [name, ...rest] = key.split('|')
    const frag = rest.join('|')
    if (!file.includes(name)) continue
    // 片段里的 | 是「或」的意思：任一段出现就算命中
    if (frag.split('|').some((piece) => piece !== '' && text.includes(piece))) return why
  }
  return null
}
const 正则行 = /\/[^/\n]*[\u4e00-\u9fa5][^/\n]*\/[gimsuy]*/

const 命中 = []
const 已认 = []
for (const f of [...filesIn(LIB, ['.js', '.mjs']), ...filesIn(TOOLS, ['.mjs'])]) {
  if (f.endsWith(SELF) || 已停用.has(f.split('/').pop())) continue
  const lines = read(f).split('\n')
  lines.forEach((line, i) => {
    const t = line.trim()
    // /* 开头的块注释行也要跳过 —— 原来只排除了 // 和 *，
    // 「/** 认不出就跳过这张，不把垃圾塞给模型」这种注释行会被当成代码报出来。
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('<!--')) return
    // INLINE_COMMENT 2026-11-14（批次408）：行内块注释 `catch { /* 坏行跳过 */ }` 里的两个斜杠
    // 会被当成一个正则字面量，把整行误报成「用中文正则判情绪」—— 好感度-日结 就是这么被报的，
    // 而它那行其实只是在读 感受.jsonl。先把行内的 /* ... */ 剥掉再看，别拿白名单盖。
    const 去注释 = line.replace(/\/\*[\s\S]*?\*\//g, '')
    if (!正则行.test(去注释) || !情绪词.test(去注释)) return
    const name = f.split('/').pop()
    const known = 在白名单里(name, t)
    if (known !== null) {
      已认.push(`${name} L${i + 1} —— ${known}`)
      return
    }
    命中.push({
      file: name,
      line: i + 1,
      text: t.slice(0, 90)
    })
  })
}

if (已认.length > 0) {
  console.log(`  （${已认.length} 处已逐条看过、确认可留）`)
}
if (命中.length === 0) {
  console.log('  ✓ 没有需要人看的新地方')
} else {
  const byFile = new Map()
  for (const h of 命中) {
    if (!byFile.has(h.file)) byFile.set(h.file, [])
    byFile.get(h.file).push(h)
  }
  for (const [file, list] of byFile) {
    console.log(`  · ${file}（${list.length} 处）`)
    for (const h of list.slice(0, 3)) console.log(`      L${h.line}: ${h.text}`)
    if (list.length > 3) console.log(`      …还有 ${list.length - 3} 处`)
  }
  提醒.push(`有 ${命中.length} 处中文正则带情绪词，分布在 ${byFile.size} 个文件 —— 逐个确认它们是在「判客观事实」还是在「替她判态度」`)
}

// ── 四、情绪出口是不是只有她自己的 qq_feel ────────────────────
console.log('\n── 四、能改「好感度」的入口 ──')
const favWriters = []
for (const f of [...filesIn(LIB, ['.js', '.mjs']), ...filesIn(TOOLS, ['.mjs'])]) {
  // 已停用的（奖惩.mjs）不算入口 —— 它里面那套正则早就不跑了，算进来只会让清单永远是「3 个」。
  if (f.endsWith(SELF) || 已停用.has(f.split('/').pop())) continue
  const code = read(f).split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n')
  if (/好感度\.mjs|FAV\b/.test(code) && /execFile|spawn/.test(code)) favWriters.push(f.split('/').pop())
}
// FAV_KNOWN 2026-11-14（批次408）：原来是「入口 > 1 就提醒」，可这两个入口一直都是对的，
// 于是每周报同一条 —— 报三次以上就没人看了。改成登记过的标出来，只报没登记的。
const 已知好感入口 = {
  '感受.mjs': '她自己 qq_feel 记下的感受，判断权在她',
  '好感度-日结.mjs': '按群日志 / 互动.json 的客观互动量日结',
}
const 未知好感入口 = favWriters.filter((x) => 已知好感入口[x] === undefined)
if (favWriters.length === 0) console.log('  （没有）')
else console.log('  ' + favWriters.map((x) => x + (已知好感入口[x] ? '（' + 已知好感入口[x] + '）' : '（**没登记**）')).join('\n  '))
if (未知好感入口.length > 0) {
  提醒.push('改好感度的新入口：' + 未知好感入口.join('、') + ' —— 确认它是「她自己的判断」还是「客观互动量」')
}

// ── 汇总 ──────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(50))
if (硬性.length > 0) {
  console.log('硬性违规 ' + 硬性.length + ' 条：')
  for (const x of 硬性) console.log('  ✗ ' + x)
} else {
  console.log('硬性违规 0 条 —— 没有「系统替她下判断」的已知模式')
}
if (提醒.length > 0) {
  console.log('要人看的 ' + 提醒.length + ' 条：')
  for (const x of 提醒) console.log('  ? ' + x)
}
// TODO_SYNC 2026-11-14（批次409）：硬性违规要上面板，不能只活在心跳日志里。
// 只有「没登记的中文情绪正则」不算问题（那是提醒，白名单机制本来就靠人隔一阵看一眼）。
try {
  待办.同步({
    id: '判断权体检',
    事项: '判断权体检硬性违规 ' + 硬性.length + ' 条：' + 硬性.slice(0, 2).join('；'),
    来源: '判断权体检',
    该在: 硬性.length > 0
  })
} catch (e) {
  // TODO_FAIL 2026-11-14（批次409）：原来这里是空 catch —— 而「待办.同步 is not a function」
  // 就是这么被吞掉的（二号机的 待办.mjs 还是批次385 之前的版本，没有 同步）。
  // 体检照跑、待办静默不写、谁都不知道。写一行 stderr：不影响体检本身，但心跳日志里看得见。
  process.stderr.write('[待办未写入] ' + String(e && e.message || e).slice(0, 100) + '\n')
}

process.exit(strict && 硬性.length > 0 ? 1 : 0)
