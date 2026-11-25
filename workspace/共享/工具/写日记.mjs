// 写日记.mjs —— 夜里让她自己写一页日记。
//
// 为什么要有这个：
//   日记页做出来了，可 11-03、11-04 那两页只有「（待补）」——
//   她只在逛贴吧那一轮里「遇到有感触的才写」，于是十天才写三篇。
//   这本子得每天有人翻，才叫日记。
//
// 怎么做的：
//   不替她写。把当天**真发生的事**捞成几条（去了哪、买了什么、拍了什么、天气），
//   丢给 headless 那一轮让她自己叙述，输出用 ===日记开始=== 包着，脚本只负责落盘。
//   素材给得少而具体 —— 给一屏流水，她会写成报表。
//
// 用法：
//   node 写日记.mjs --dry              # 只看看今天有哪些素材、prompt 长什么样，不调模型
//   node 写日记.mjs                    # 写今天的（已经有像样的日记就不动）
//   node 写日记.mjs --day 2026-11-06   # 补写某天
//   node 写日记.mjs --force            # 覆盖（她那天写得太短、想重来时才用）
import { readFileSync, writeFileSync, existsSync, appendFileSync, statSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
// SEASON_MAT 2026-11-05（批次82）：日记要有季节。
// 天气本是逐日的「晴/雨」，季节是「这阵子一直这样」—— 两个都得给。
import { 季节在 } from './季节.mjs'
// PHOTO_ID 2026-11-07（批次161）：只认真的照片，截图不是「今天拍了什么」。
import { 是成品图 } from './成品图.mjs'
import * as 账本 from './账本.mjs'
// EXI_DIARY 2026-11-14（批次386）：记下今天这件事，本身就该给「长期意义感」加一点。
// 它原来只有 奖惩.mjs 一个写入源，那个脚本批次63 就停用了 —— existential 冻了 10 天。
import { 涨存在 } from './_总线.mjs'

// ENTRY_GUARD 2026-11-14（批次459）：被 import 时不要跑主流程。
// 冒烟测试「逐个 import」会把每个 .mjs 当 CLI 真跑一遍（457 实测一次写 16 个真档），
// 而这些脚本顶层就是整条流程。只有 `node <本文件>` 才执行下面的主流程；被 import 时是空模块。
// 用 __path/__fileURLToPath 这两个别名，避免和各文件已有的 path/join 撞名。
import __path from 'node:path'
import { fileURLToPath as __fileURLToPath } from 'node:url'
const 是入口 = (() => {
  try { return !!process.argv[1] && __path.resolve(process.argv[1]) === __fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {

// CLI_GUARD 2026-11-17（批次616B）：审计 P0-5。
// 帮助必须在取锁、调模型、写日志之前退出；拼错和 --day 缺值也一样。
const args = process.argv.slice(2)
const 用法 = [
  '用法：',
  '  node 写日记.mjs                    # 写今天的（已有正文就不动）',
  '  node 写日记.mjs --dry              # 只看素材和 prompt，不调模型、不写盘',
  '  node 写日记.mjs --day 2026-11-06   # 补写某天',
  '  node 写日记.mjs --force            # 覆盖已有正文',
  '  node 写日记.mjs --help             # 只打印用法',
].join('\n')
const 带值参数 = new Set(['--day'])
const 开关参数 = new Set(['--dry', '--force', '--help', '-h'])
const 未知参数 = []
const 缺值参数 = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (带值参数.has(a)) {
    const v = args[i + 1]
    if (!v || v.startsWith('--')) 缺值参数.push(a)
    else i++
  } else if (!开关参数.has(a)) {
    未知参数.push(a)
  }
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(用法)
  process.exit(0)
}
if (未知参数.length > 0 || 缺值参数.length > 0) {
  if (未知参数.length > 0) console.error('未知参数：' + 未知参数.join('、'))
  if (缺值参数.length > 0) console.error('参数缺少值：' + 缺值参数.join('、'))
  console.error(用法)
  process.exit(2)
}

const TOOLS = process.env.QQ_TOOLS || '{{BOT_ROOT}}/共享/工具'
const MEM = process.env.QQ_MEM || '{{BOT_ROOT}}/记忆'
const DIR = process.env.QQ_DIARY || '{{BOT_ROOT}}/日记'
const LOG = join(MEM, '日志', '写日记.log')
const LOCK = join(MEM, '.写日记.lock')

const 取值 = (名) => { const i = args.indexOf(名); return i >= 0 ? args[i + 1] : undefined }
const DRY = args.includes('--dry')
const FORCE = args.includes('--force')

// 一律按北京时间算「今天」。服务器是 UTC，这里错一天，整本日记就全串位。
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3)
const 今天 = bj().toISOString().slice(0, 10)
const day = 取值('--day') || 今天
if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { console.error('--day 要写成 YYYY-MM-DD'); process.exit(2) }

const 读 = (p, fb) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb } }
const 有 = (p) => { try { return readFileSync(p, 'utf8') } catch { return '' } }

const 目标 = join(DIR, day + '.md')
const 已有 = 有(目标).trim()
const 已有字数 = 已有.replace(/\s/g, '').length
// 那个文件里有没有「（待补）」—— 有就说明是占位稿，不是她写的
const 是占位稿 = /[（(]\s*待补\s*[)）]/.test(已有)

// 判「要不要覆盖」不能看字数。她自己写的一篇可能只有四十字（那天就没什么可说），
// 而「（待补）+ 记得的部分」那种机器占位稿反而有九十多字 —— 用字数挡，正好挡反。
// 判据只看一件事：**里面有没有她写的字**。有就不动，只有占位就补上。
if (!FORCE && 已有 && !是占位稿) {
  console.log(`${day} 已经有她自己写的 ${已有字数} 字，不动它（要覆盖加 --force）`)
  process.exit(0)
}

// —— 素材：只挑当天真的发生过的
const 资产 = 读(join(MEM, '资产.json'), {})
const 活动 = 读(join(MEM, '活动台账.json'), { log: [] })
const 记录 = (资产.记录 || []).filter((r) => String(r.at || '').startsWith(day))

const 线 = (活动.log || [])
  .filter((x) => String(x.at || '').startsWith(day) && x.生效)
  .sort((a, b) => String(a.at).localeCompare(String(b.at)))

// 手账是已经写过一遍的人话流水（「07:30 · 从家走到电影院」），
// 比台账的 kind 字段好读 —— 台账里只写「买」，模型看不出买了什么。
//
// 但它不能原样给她：2026-11-03 那天「打工赚了 XX」在 00:35~01:13 之间刷了五十几条
// （一次动作在同一分钟里反复结算），原样传过去等于让她看五十行几乎相同的字，
// 真正有画面的「在台阶上坐了半小时」「捡到一个水杯」全被淹了。
// 所以先压：同一类重复的合并成一句，相邻完全一样的去掉。
const 手账 = (() => {
  const t = 有(join(MEM, '手账-' + day + '.md')) || 有(join(MEM, '手账', '手账-' + day + '.md')) || 有(join(MEM, '归档', '历史按月', day.slice(0, 7), '手账-' + day + '.md'))
  const 原 = t.split('\n')
    .filter((l) => /^-\s*\d{2}:\d{2}\s*·/.test(l.trim()))
    .map((l) => l.trim().replace(/^-\s*/, ''))

  let 打工 = 0, 打工起 = ''
  const 中间 = []
  for (const l of 原) {
    const 时 = (l.match(/^(\d{2}:\d{2})/) || [])[1] || ''
    const 文 = l.replace(/^\d{2}:\d{2}\s*·\s*/, '')
    const m = 文.match(/^打工赚了\s*(\d+)/)
    if (m) {
      打工 += Number(m[1] || 0)
      if (!打工起) 打工起 = 时
      continue
    }
    中间.push(时 + ' ' + 文)
  }
  const 去重 = 中间.filter((x, i) => x !== 中间[i - 1])
  if (打工) {
    // 只写「打了会儿工」，不带金额。
    // 那个数字是刷出来的（一次打工在同一分钟里反复结算，11-03 一天算到 1198 块），
    // 给她这个数，日记里就会出现「今天赚了一千二」这种一眼假的话。
    return (打工起 ? [打工起 + ' 打了会儿工'] : ['打了会儿工']).concat(去重)
  }
  return 去重
})()

// 那一觉睡了多久，也是那天的一部分
const 觉 = (() => {
  const t = 有(join(MEM, '手账-' + day + '.md')) || 有(join(MEM, '手账', '手账-' + day + '.md')) || 有(join(MEM, '归档', '历史按月', day.slice(0, 7), '手账-' + day + '.md'))
  const m = t.match(/这一觉：\s*([^→]+)→\s*([^，]+)，深睡\s*(\d+)\s*分/)
  if (!m) return ''
  const 起 = String(m[1]).slice(11, 16), 止 = String(m[2]).slice(11, 16)
  return `${起} 睡到 ${止}，深睡 ${m[3]} 分`
})()

// 批次174：口径在 账本.mjs。这里原来是项目里最宽的一份（认括号负数、认不带「块」的
// 「打工赚了 20」），但 快照.mjs 和 日报.mjs 各有自己一份，同一天能算出三个数。
const __账 = 账本.汇总(记录)
let 花 = __账.花, 赚 = __账.赚

// 那天拍的照片（连她当时写的那句话一起给 —— 那句话往往就是日记的开头）
const 照片 = (() => {
  const dir = '{{BOT_ROOT}}/共享/自拍/成品'
  let list = []
  try { list = readdirSync(dir).filter(是成品图) } catch { return [] }
  const out = []
  for (const f of list) {
    let mt = 0
    try { mt = statSync(join(dir, f)).mtimeMs } catch { continue }
    if (bj(mt).toISOString().slice(0, 10) !== day) continue
    const id = f.replace(/\.png$/, '')
    const meta = (() => { try { return JSON.parse(readFileSync(join(dir, id + '.json'), 'utf8')) } catch { return {} } })()
    out.push({ 时: bj(mt).toISOString().slice(11, 16), 场景: meta.场景 || '', 主体: meta.主体 || '', 话: String(meta.话 || '').trim() })
  }
  return out.sort((a, b) => a.时.localeCompare(b.时)).slice(0, 4)
})()

// 天气：从天气本里查那一天。查不到就不写 —— 不拿今天的天气去冒充那天的。
const 天 = (() => {
  const t = 有(join(MEM, '天气本.jsonl'))
  for (const l of t.split('\n').filter(Boolean).reverse()) {
    try {
      const o = JSON.parse(l)
      if (o.date === day) return o
    } catch { /* 坏行跳过 */ }
  }
  return null
})()

// 梦只取「余味」那一行：梦文件本身是记忆抽取的产物，整篇塞进去会带出群号和人设条目
const 梦 = (() => {
  const t = 有(join(MEM, '梦-' + day + '.md')) || 有(join(MEM, '梦', '梦-' + day + '.md')) || 有(join(MEM, '归档', '历史按月', day.slice(0, 7), '梦-' + day + '.md'))
  const m = t.match(/余味[:：]\s*(.+)/)
  return m && m[1].trim() ? m[1].trim().slice(0, 80) : ''
})()

const 素材行 = []
if (觉) 素材行.push('睡得怎么样：' + 觉, '')
if (手账.length) {
  素材行.push('今天的足迹：')
  for (const l of 手账.slice(0, 12)) 素材行.push('- ' + l.replace(/\s*·\s*/, ' ').slice(0, 46))
} else if (线.length) {
  素材行.push('今天的足迹：')
  // 走到这一步说明手账没读到（正常情况下它每 30 分钟刷新，轮不到这里）。
  // 台账只有「在哪、哪一类」，没有买了什么 —— 所以措辞不能让它冒充一件具体的事。
  // 「一直在」是实话：它是半小时一条的在场记录，不是一次动作。
  for (const x of 线.slice(0, 12)) {
    const 名 = String(x.名 || '')
    素材行.push(`- ${String(x.at).slice(11, 16)} 一直在${x.地点 || '?'}${名 ? '（' + 名 + '）' : ''}`)
  }
} else {
  素材行.push('今天的足迹：没怎么出门。')
}
// 正常一天：打工二十上下、买东西几十。单日进出过 500 只可能是结算重复刷出来的
// （11-03 那天算到赚 1137）。这种数不是「她今天真的赚了这么多」，是账错了 ——
// 给出去日记就会写成「今天赚了一千二」，所以这行干脆不写。
// 批次174：这个 500 的闸是两边共用的 —— 赚 780（主人给了 550+200+30）会把整行吞掉，
// 连花的那半也不写。提到 1000：11-03 那份 1137 是结算重复刷出来的，仍然挡得住。
if (记录.length && (花 || 赚) && 花 <= 1000 && 赚 <= 1000) {
  素材行.push('', '钱：' + [
    花 ? '花了 ' + 花 + ' 块' : '', 赚 ? '赚了 ' + 赚 + ' 块' : '',
  ].filter(Boolean).join('，') + `（现在剩 ${资产.钱 ?? '?'}）`)
}
if (天) 素材行.push('', `天气：${天.天气 || '?'}，${天.最低 ?? '?'}~${天.最高 ?? '?'}℃，${天.降水 ? '下过雨' : '没下雨'}`)
// 只给物候，不给「深秋」这个词 —— 「深秋」是概括，「梧桐叶黄了大半」才是她看见的。
// 按 day 算而不是按今天，补写某天的时候不会串季。
if (天) {
  const 季 = 季节在(day)
  if (季 && 季.树) 素材行.push(`季节：${季.树}；${季.花}`)
}

if (照片.length) {
  素材行.push('', '今天拍下的：')
  for (const p of 照片) 素材行.push(`- ${p.时} 在${p.场景 || '某处'}拍了张${p.主体 || '照'}${p.话 ? '，当时心里想的是「' + p.话 + '」' : ''}`)
}
if (梦) 素材行.push('', '昨晚的梦，醒来还剩一点：' + 梦)
try {
  const 歌m = (有(join(MEM, '手账-' + day + '.md')) || '').match(/^一起听过的歌：(.+)$/m)
  if (歌m && 歌m[1].trim()) 素材行.push('', '今天戴着云耳机跟他一起听过的歌：' + 歌m[1].trim())
} catch (_err) { console.error('[写日记]', _err?.message || _err) }

const 素材 = 素材行.join('\n')

if (!线.length && !记录.length && !照片.length) {
  console.log(`${day} 什么都没发生（没走动、没花钱、没拍照），不硬写`)
  process.exit(0)
}

const 模板 = 有(join(TOOLS, '自主-写日记.md'))
if (!模板) { console.error('模板 自主-写日记.md 不在'); process.exit(1) }
const prompt = 模板.replaceAll('{{DATE}}', day).replaceAll('{{MATERIAL}}', 素材)

if (DRY) {
  console.log('=== 素材 ===\n' + 素材)
  console.log('\n=== prompt 长度 ' + prompt.length + ' 字 ===')
  process.exit(0)
}

// —— 一轮只跑一个，别和自主学习抢
const 活着 = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
if (existsSync(LOCK)) {
  const old = Number(有(LOCK).trim())
  if (活着(old)) { console.log(`另一轮写日记还在跑（pid ${old}），这轮不挤`); process.exit(3) }
}
mkdirSync(dirname(LOCK), { recursive: true })
// SMOKE_NO_MODEL 2026-11-14（批次455）：冒烟测试（冒烟1 / 冒烟1b）会把每个 .mjs 当 CLI 真跑一遍，
// 而这个脚本一跑就调一次真模型 —— 花钱，还在 `--data-bot-workspace-共享-工具--` 工作区留一条会话目录
// （实测已经 143 条）。冒烟里设 SMOKE_NO_MODEL=1，这里立刻退出，一个字节都不碰。
if (process.env.SMOKE_NO_MODEL === '1') {
  console.log('[冒烟] 不调模型，直接退出')
  process.exit(0)
}
writeFileSync(LOCK, String(process.pid))

try {
  // 凭据只从 systemd 的环境文件继承，不写进脚本、日志或命令行
  const r = spawnSync('/bin/bash', [
    '-c',
    'set -a; . /etc/dshbot.env; set +a; exec dsh --profile headless "$1"',
    '写日记',
    prompt,
  ], {
    encoding: 'utf8',
    timeout: 9 * 60e3,
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, DSH_HOME: '{{DSH_ROOT}}', NO_COLOR: '1' },
  })
  const text = [r.stdout, r.stderr].filter(Boolean).join('\n')
  appendFileSync(LOG, `\n===== ${new Date().toISOString()} ${day} exit=${r.status ?? 'timeout'} =====\n${text}\n`)
  // 日志别长成几个 G：留最近 40 万字符
  try {
    if (statSync(LOG).size > 640 * 1024) writeFileSync(LOG, readFileSync(LOG, 'utf8').slice(-400_000))
  } catch { /* 截不了就算了，不能因为日志把正事弄挂 */ }

  const m = text.match(/===日记开始===([\s\S]*?)===日记结束===/)
  if (!m) {
    if (/===跳过===/.test(text)) { console.log(day + ' 她觉得今天没什么可写，跳过'); process.exitCode = 0 }
    else { console.error('没找到日记正文（模型没按格式输出，或这一轮失败了）'); process.exitCode = 1 }
  } else {
    let 正文 = m[1].trim()
    // 头一行必须是日期。她偶尔会自己加个标题，那就补一行日期上去，别硬把标题删了。
    if (!new RegExp('^#\\s*' + day).test(正文)) 正文 = '# ' + day + '\n\n' + 正文
    if (正文.replace(/\s/g, '').length < 60) {
      console.error('写出来只有 ' + 正文.length + ' 字，太短，不落盘')
      process.exitCode = 1
    } else {
      writeFileSync(目标, 正文 + '\n')
      const 私 = (正文.match(/~~[\s\S]+?~~/g) || []).length
      console.log(`${day} 写好了，${正文.replace(/\s/g, '').length} 字${私 ? '，划掉 ' + 私 + ' 处' : ''}`)
      process.exitCode = 0
      // 只在真写下来时加：她觉得没可写的（===跳过===）、太短没落盘、--dry，都不加。
      try {
        const r = 涨存在(MEM, 0.8)
        console.log('  存在层 → ' + r.existential)
      } catch (e) { /* 加不上不影响日记 */ }
    }
  }
} catch (e) {
  appendFileSync(LOG, `\n===== ${new Date().toISOString()} ${day} ERROR =====\n${e.stack || e.message}\n`)
  console.error(e.message)
  process.exitCode = 1
} finally {
  try { unlinkSync(LOCK) } catch { /* 已经没了 */ }
}
}
