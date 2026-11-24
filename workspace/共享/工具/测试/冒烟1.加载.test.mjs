// 全模块冒烟 · 第一层：能不能 import。
//
// 覆盖 共享/工具/*.mjs（122 个）+ 插件 lib/*.js（61 个）。
// 只 import 不调函数 —— 模块顶层的副作用（读档、建目录）照样会跑，所以先把 env 全指到沙箱。
//
// 输出：加载成功 / 失败（含错误）/ 跳过（依赖别的插件）。
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// SB_UNIQUE 2026-11-14（批次437）：原来和另一个冒烟测试共用 /tmp/smoke-mem，
// 全套里两个文件是并行进程，各自开头的 rmSync 会删掉对方正在用的沙盒。
const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke1-'))
const 真 = '{{BOT_ROOT}}/记忆'
const 工具 = '{{BOT_ROOT}}/共享/工具'
const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

// ── 沙箱：复制记忆目录里的小文件，跳过归档/视频/歌单 ──
const 跳过 = new Set(['归档', '视频画面', '听过的歌', '日志'])
fs.rmSync(沙, { recursive: true, force: true })
fs.mkdirSync(沙 + '/日志', { recursive: true })
let 拷了 = 0
for (const f of fs.readdirSync(真)) {
  if (跳过.has(f)) continue
  const a = path.join(真, f), b = path.join(沙, f)
  const s = fs.statSync(a)
  if (s.isDirectory()) { fs.mkdirSync(b, { recursive: true }); continue }
  if (s.size > 2 * 1024 * 1024) continue      // 单文件超过 2M 的不拷
  fs.copyFileSync(a, b)
  拷了++
}

// ── 把所有已知的 env 指到沙箱 ──
for (const k of ['QQ_AUTONOMY_MEM', 'GAP_MEM', 'QQ_ACT_MEM', 'HUNGER_MEM', 'BAOKE_MEM',
  'QQ_MEM', 'ITEM_MEM', 'SHOT_MEM', 'QQ_PANEL_MEM', 'QQ_AUTONOMY_TOOLS', 'QQ_WORK_TOOLS']) {
  process.env[k] = 沙
}
// SMOKE_AWAKE 2026-11-16（批次540）：上面把真档整个复制过来了，**包括 睡醒.json** ——
// 她真睡着的时候那份是 `{sleeping: true}`，于是 `资产.mjs`（第 61 行：睡着就 process.exit(0)）
// 这类模块在 import 阶段直接退出，冒烟被判成「中途被结束 / 最后在处理 [共享] 资产.mjs」。
// 实测：07:12 她真的去睡了，07:13 那次全套就从 141/141 变成 141/142。
//
// 冒烟只验「模块能不能加载」；「她睡着时这些地方怎么走」不归它管（那是 睡态 的 t4xx 在测）。
// 所以把沙盒里的睡觉标记强制改成醒着 —— 只改沙盒副本，真档一个字不动（真档指纹在后面单独比）。
fs.writeFileSync(沙 + '/睡醒.json', JSON.stringify({ sleeping: false, since: '2026-01-01 00:00' }))

process.env.FISH_USAGE_LOG = 沙 + '/fish-usage-log.jsonl'
process.env.FISH_OMNI_CONFIG = 沙 + '/fish-omni.json'
// OMNI_SANDBOX 2026-11-14（批次454）：这两个冒烟会把每个 .mjs 当 CLI 真跑一遍，
// 一起听歌.mjs 的顶层就是 `await 同步一次()`。原来 FISH_OMNI_CONFIG 指到一个**不存在**
// 的沙盒文件，而 isMusicSyncEnabled() 读不到时会 fail-open（当成开着）—— 于是每跑一次全套
// 就真的去网易云同步、下载 4MB、送去云端分析，还写真档 记忆/一起听.json。
// 现在把沙盒配置写出来，明确关掉。
fs.writeFileSync(沙 + '/fish-omni.json', JSON.stringify({ 一起听: { 开启: false } }))
process.env.UPSTREAM_LOG = 沙 + '/upstream.log'
process.env.QQ_PLUGIN_LIB = 插件
process.env.ST_BASE = 沙
// SMOKE_NO_MODEL 2026-11-14（批次455）：写日记 / 自主学习 / 拍照想法 一跑就调一次真模型。
// 冒烟只是验「能不能加载」，不该花钱，也不该在共享/工具 工作区留会话目录（已 143 条）。
process.env.SMOKE_NO_MODEL = '1'
// GUARD 2026-11-14（批次456）：env 名单补不全（漏一个模块，它就把线上真档写脏）。
// 本进程在 import 那些模块**之前**先装沙盒守卫，把 fs 写入口改道到沙盒。
// 注意顺序：守卫必须读得到下面这几个 env，所以放在 env 之后、逐个 import 之前。
process.env.SMOKE_GUARD_ROOT = '{{BOT_ROOT}}'
process.env.SMOKE_GUARD_SANDBOX = 沙
process.env.SMOKE_GUARD_LOG = 沙 + '/.改道.log'
await import(pathToFileURL(path.join(工具, '测试', '沙盒守卫.mjs')).href)

// 真文件指纹，跑完比对
// CONTENT_HASH 2026-11-16（批次527）：原来比的是 size+mtimeMs —— 她自己的心跳（状态推进、
// 好感度-日结…每分钟都在写）会把这几个文件的 mtime 刷掉，于是冒烟动不动喊
// 「★★★ 真实文件被动了，本轮作废」。改成比**内容**：内容没变就是没人写脏。
const 真指纹 = (p) => {
  try {
    const b = fs.readFileSync(p)
    // RACY_FIX 2026-11-16（批次573）：`睡眠.json` 在**她睡着时每分钟**被 睡眠心跳 改
    // （live.lastTick、阶段累计），而冒烟要跑 7~30 秒 —— 撞上就红。
    // 下面「硬判」那三行写着「只在她真睡/真听歌时才变」，可它每分钟变正是因为**她真的在睡**，
    // 一次长觉四五个小时。这就是 T5：拿真档当指纹，而真档有每分钟的写者。
    // 睡眠只比骨架：睡没睡 / 这一段起点 / records 与 segments 条数 —— 只有真结算才会变。
    if (p.endsWith('/睡眠.json')) {
      const j = JSON.parse(b.toString('utf8'))
      return ['睡', j.sleeping, j.live && j.live.start, (j.records || []).length, (j.segments || []).length].join('|')
    }
    return b.length + ':' + crypto.createHash('md5').update(b).digest('hex')
  } catch { return '无' }
}
const 真档 = ['饱渴.json', '饥饿.json', '资产.json', '自主.json', '状态.json', '关系.json', '睡醒.json', '睡眠.json', '工作.json', '一起听.json']
  .map((f) => path.join(真, f))
const 前 = 真档.map(真指纹).join('|')

// SYNTAX_ONLY 2026-11-16（批次527）：这个文件原来**只加载到第 10 个工具就死了**。
// `体检-判断权.mjs` 顶层跑到最后有 `process.exit(0)` —— import 它等于当场结束进程，
// 而 `node --test` 看见进程正常退出就当「通过」。于是 137 个工具只验了前 10 个，
// 61 个插件模块**一个都没加载**，全套照绿。
//
// 名单里这些「顶层有真动作」的模块只做 `node --check`（查语法、不执行）：
//   · 会发消息/删消息/改签名：发表情 发卡片 撤回 抓消息文件 同步QQ状态
//   · 会 process.exit 把测试进程杀掉：体检-判断权 体检-基础 回归-激素 回归用例 静态检查
//   · 顶层 await main() 会真干活：做梦 刷一刷 自主学习
// 不名单里的照旧 import —— 它们要么没有顶层动作，要么写盘已被沙盒守卫改道。
// 这 39 个是子进程逐个跑出来的（每个单独 import，看有没有走到最后一行），不是猜的。
// 插件 lib 里混着浏览器端文件（用 window/document），Node 里 import 必然失败，不算问题。
const 浏览器模块 = new Set(['client.js'])

const 只查语法 = new Set([
  '体检-判断权.mjs', '体检-基础.mjs', '体检-闭环.mjs', '余额预警.mjs', '印象更新.mjs',
  '发卡片.mjs', '房间.mjs', '自我巡检.mjs', '本子同步.mjs', '发表情.mjs', '吃饭.mjs', '同步QQ状态.mjs', '回归-激素.mjs',
  '回归用例.mjs', '奖惩.mjs', '好感度.mjs', '封面.mjs', '怨.mjs',
  '打盹.mjs', '抓消息文件.mjs', '投递留言.mjs', '拍照想法.mjs', '撤回.mjs',
  '日报.mjs', '早间简报.mjs', '活动.mjs', '物品.mjs', '状态推进.mjs',
  '生长.mjs', '缺口.mjs', '自主学习.mjs', '自主行动.mjs', '自动作息.mjs',
  '花钱.mjs', '计划.mjs', '认事.mjs', '记忆消退.mjs', '走路.mjs',
  '认事.mjs', '记忆消退.mjs', '走路.mjs', '醒来.mjs', '链.mjs', '露馅.mjs', '静态检查.mjs',
  // 这两个 import 就 listen：接口中转抢 39301（第二次跑直接 EADDRINUSE 崩掉整个冒烟），
  // 面板会真把 8788 起起来。都只能查语法。
  '接口中转.mjs', '接口网关.mjs', '面板.mjs',
  // 这两个 import 就真发请求：探测上游每次打一次假工具（max_tokens 200，真花钱），
  // 还会写 {{DSH_ROOT}}/upstream-probe.json；连两次拿不到 tool_use 就自动把她切到官方 API。
  // 网盘顶层会真去拉列表。
  '探测上游.mjs', '网盘.mjs',
  // 这几个是「报告生成器」：import 就把整套检查跑一遍并写一份 md（写入画像 5.6KB、雷霆体检 2.7KB），
  // 全套测试因此慢 20 多秒；它们本来也不需要「被 import 时执行」。只查语法。
  '写入画像.mjs', '工具面审计.mjs', '回忆.mjs',
])

const 结果 = { ok: [], 只查了语法: [], 失败: [], 有输出: [] }
// 逐个 import 时把 stdout 抢过来 —— 有的模块在顶层就跑了 CLI 主流程（这本身是隐患，
// 后面单独统计）。不抢的话它们会把冒烟结果冲掉。
const 原写 = process.stdout.write.bind(process.stdout)

// 守卫：如果某个模块顶层 still 调了 process.exit，进程会在循环中途结束。
// 那种情况下 `node --test` 会把「提前退出」当成功 —— 这个 handler 把它变成真红。
let 当前 = ''
let 走完 = false
process.on('exit', () => {
  if (走完) return
  原写('\n★★★ 冒烟中途被结束，最后在处理：' + 当前 + '\n'
    + '  它的顶层大概率有 process.exit —— 加进上面的 只查语法 名单。\n')
  process.exitCode = 1
})
const 逐个 = async (目录, 文件们, 标签) => {
  for (const f of 文件们) {
    当前 = '[' + 标签 + '] ' + f
    const p = path.join(目录, f)
    const t0 = Date.now()
    // 插件 lib 只查语法：它们会被本进程 import 时起服务/拿端口（面板 8788、接口中转 39301），
    // 全套里多个测试文件并行，会互相抢端口把别的测试搞红。插件本身有 50+ 个测试直接 import，
    // 冒烟1b 也用子进程全覆盖了，这里不重复。
    // 只查语法：不执行，防「import 就发消息 / 就 exit」
    if (只查语法.has(f) || 标签 === '插件') {
      const { execFileSync } = await import('node:child_process')
      try {
        execFileSync(process.execPath, ['--check', p], { stdio: 'pipe', timeout: 8000 })
        结果.只查了语法.push({ 标签, f, ms: Date.now() - t0 })
      } catch (e) {
        const msg = String((e && (e.stderr || e.message)) || e).split('\n')[0].slice(0, 150)
        结果.失败.push({ 标签, f, msg, 缺依赖: false })
      }
      continue
    }
    if (浏览器模块.has(f)) {
      结果.浏览器模块 = 结果.浏览器模块 ?? []
      结果.浏览器模块.push(f)
      continue
    }
    let 捕获 = ''
    process.stdout.write = (s) => { 捕获 += String(s); return true }
    try {
      await import(pathToFileURL(p).href)
      结果.ok.push({ 标签, f, ms: Date.now() - t0 })
    } catch (e) {
      const msg = String((e && e.message) || e).split('\n')[0].slice(0, 150)
      const 缺依赖 = /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg)
      结果.失败.push({ 标签, f, msg, 缺依赖 })
    } finally {
      process.stdout.write = 原写
    }
    if (捕获.trim()) {
      结果.有输出.push({ 标签, f, 字: 捕获.trim().length, 头: 捕获.trim().split('\n')[0].slice(0, 70) })
    }
  }
}

console.log('沙箱就绪：复制 ' + 拷了 + ' 个文件到 ' + 沙)
const 工具文件 = fs.readdirSync(工具).filter((f) => f.endsWith('.mjs')).sort()
const 插件文件 = fs.readdirSync(插件).filter((f) => f.endsWith('.js')).sort()
console.log('待加载：共享工具 ' + 工具文件.length + ' 个，插件 lib ' + 插件文件.length + ' 个\n')

await 逐个(工具, 工具文件, '共享')
await 逐个(插件, 插件文件, '插件')

const 分组 = (arr) => {
  const m = {}
  for (const x of arr) { const k = x.标签; m[k] = (m[k] || 0) + 1 }
  return m
}
console.log('=== 加载成功 ' + 结果.ok.length + ' 个 ' + JSON.stringify(分组(结果.ok)) + ' ===')
if (结果.浏览器模块 && 结果.浏览器模块.length) {
  console.log('=== 浏览器模块跳过 ' + 结果.浏览器模块.length + ' 个：' + 结果.浏览器模块.join('、') + ' ===')
}
if (结果.只查了语法.length) {
  console.log('=== 只查了语法 ' + 结果.只查了语法.length + ' 个（顶层有真动作，不执行）===')
  console.log('  ' + 结果.只查了语法.map((x) => x.f).join('、'))
}
if (结果.失败.length) {
  console.log('\n=== 失败 ' + 结果.失败.length + ' 个 ===')
  const 真错 = 结果.失败.filter((x) => !x.缺依赖)
  const 缺依赖 = 结果.失败.filter((x) => x.缺依赖)
  for (const x of 真错) console.log('  ★ [' + x.标签 + '] ' + x.f + '\n      ' + x.msg)
  if (缺依赖.length) {
    console.log('\n  （这些是「找不到别的包」，不是模块本身的问题，' + 缺依赖.length + ' 个）')
    for (const x of 缺依赖.slice(0, 8)) console.log('    [' + x.标签 + '] ' + x.f + ' → ' + x.msg.slice(0, 70))
  }
}

if (结果.有输出.length) {
  console.log('\n=== import 时就在跑东西的模块 ' + 结果.有输出.length + ' 个（隐患，见台账）===')
  for (const x of 结果.有输出) console.log('  [' + x.标签 + '] ' + x.f + '  ' + x.字 + ' 字  「' + x.头 + '」')
}

走完 = true
const 后 = 真档.map(真指纹).join('|')
if (前 === 后) {
  console.log('\n真实文件未被触碰（内容一致）')
} else {
  const 变 = 真档.filter((_p, i) => 前.split('|')[i] !== 后.split('|')[i]).map((p) => p.split('/').pop())
  // RACY 2026-11-16（批次529）：状态/激素/关系/自主/饱渴/饥饿/工作 这几个**她心跳每分钟都在写**，
  // 冒烟要跑 30 秒，撞上就必然「内容变了」。那不算测试写脏，只有下面这三个（只在她真睡/真听歌时才变）
  // 被改才说明守卫漏了。
  const 硬判 = ['一起听.json', '睡眠.json', '睡醒.json']
  const 真脏 = 变.filter((f) => 硬判.includes(f))
  if (真脏.length) {
    console.log('\n★★★ 真实文件被改了：' + 真脏.join('、') + ' —— 本轮作废')
    process.exitCode = 1
  } else {
    console.log('\n守卫正常（变了的是心跳文件：' + 变.join('、') + '，她自己的定时在写）')
  }
}
fs.rmSync(沙, { recursive: true, force: true })
