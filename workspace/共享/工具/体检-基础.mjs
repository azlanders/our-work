#!/usr/bin/env node
// 体检-基础.mjs —— 她还能不能正常运转的三块地基（批次411，2026-11-14）
//
// 为什么要有这个：
//   2026-11-14 那次手工查了一遍 —— 记忆下 436 个 .json 全可解析、11 个 .jsonl 全可解析、
//   4 个 systemd 单元全 active、近 3 天没有 OOM。**查完就没了**。下一个人（或者三个月后的我）
//   还得再手工来一遍，而且不一定想得起查哪几项。
//
//   这跟已有的三个体检不是一回事：
//     · 生活体检   她此刻的生活数据合不合理（穿了不合季的衣服、饿了多久）
//     · 闭环体检   写了的东西有没有人用（死导出、零调用工具）
//     · 契约检查   代码结构对不对（628 项）
//     · **这个**   「她还能不能说话」的前提：档没坏、服务在、没被系统杀掉
//
// 三块：
//   一、数据   记忆/ 下所有 .json / .jsonl 能不能解析。坏一个档就可能让整轮报错
//   二、服务   四个 systemd 单元 active+enabled，关键端口在听
//   三、健壮   近 24 小时有没有 OOM / segfault / core dump
//
// 用法：
//   node 体检-基础.mjs            # 打印 + 写面板待办
//   node 体检-基础.mjs --静        # 只打一行摘要（心跳里用）
//   node 体检-基础.mjs --json     # 机器可读（面板/脚本用）
//
// 沙盒（测试用）：BASE_MEM 换记忆目录、SERVICES 换服务名（逗号分隔）、SKIP_SYSTEMD=1 跳过第二三块。

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as 待办 from './待办.mjs'
import { 一笔 } from './账本.mjs'

const args = process.argv.slice(2)
const 静 = args.includes('--静')
const 要JSON = args.includes('--json')

const MEM = process.env.BASE_MEM || '{{BOT_ROOT}}/记忆'
const 服务们 = (process.env.SERVICES || 'dsh-bot,fish-panel,fish-upstream,fish-gptsovits')
  .split(',').map((x) => x.trim()).filter(Boolean)
const 端口们 = [
  { 名: '面板', 口: 8788 },
  { 名: '接口中转', 口: 39401 },
  { 名: '语音合成', 口: 9880 },
  { 名: 'OneBot WS', 口: 8090 },
  { 名: 'OneBot HTTP', 口: 3011 },
]
const 跳过系统 = process.env.SKIP_SYSTEMD === '1'

/**
 * ROLE_AWARE 2026-11-24：这份体检原来把「服务没跑」和「端口连不上」一律记成问题。
 *
 * 但两台机器的**角色不同**：
 *   · {{BOT_DISPLAY}}（西安）—— 完整栈：napcat / 一次代理 / 面板 / 网关 / dsh-bot 全跑
 *   · {{ALT_BOT_DISPLAY}} VPS     —— 只跑业务脚本 + GSV + mihomo；QQ 协议端、dsh-bot、面板、
 *                       接口中转全部刻意停用（inactive），因为她的对话链路走网关那台
 *
 * 于是 VPS 每天都会报 7 条「问题」，心跳把体检判红，真正的故障反而看不见。
 * 修法：服务/端口分「必须」与「可选」两类，用环境变量声明本机角色；
 * 可选组件没起来就记 ok（未启用），不参与 bad 计数。
 *
 * 声明方式（二选一，不改也不影响旧行为）：
 *   BOT_ROLE=full        本机跑完整栈（默认，全部当必须）
 *   BOT_ROLE=scripts     本机只跑业务脚本（可选组件全跳过）
 *   BASE_OPTIONAL_SERVICES=fish-panel,fish-upstream  只额外放宽这几个服务
 *   BASE_OPTIONAL_PORTS=8788,39401                   只额外放宽这几个端口
 */
// ROLE_SOURCE 2026-11-24：优先读 参数.json 的 开关.机器人角色（跟 全套验收 同一处配置），
// 其次环境变量 BOT_ROLE，最后默认 full。
const 角色 = (() => {
  try {
    const p = JSON.parse(readFileSync('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))
    const v = String((p['开关'] || {})['机器人角色'] || '')
    if (v) return v
  } catch { /* 读不到就退回环境变量 */ }
  return String(process.env.BOT_ROLE || 'full')
})()
const 可选服务 = new Set(
  String(process.env.BASE_OPTIONAL_SERVICES || (角色 === 'scripts' ? 'dsh-bot,fish-panel,fish-upstream' : ''))
    .split(',').map((x) => x.trim()).filter(Boolean)
)
const 可选端口 = new Set(
  String(process.env.BASE_OPTIONAL_PORTS || (角色 === 'scripts' ? '8788,39401,8090,3011' : ''))
    .split(',').map((x) => x.trim()).filter(Boolean)
)

/** 端口有没有在听（同步、零开销）。可选端口据此判「未启用」而不是「连不上」。 */
function 端口在听(port) {
  const hex = Number(port).toString(16).toUpperCase().padStart(4, '0')
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      const txt = String(readFileSync(f, 'utf8'))
      for (const line of txt.split('\n').slice(1)) {
        const c = line.trim().split(/\s+/)
        if (c.length < 4) continue
        if ((c[1] || '').endsWith(':' + hex) && c[3] === '0A') return true
      }
    } catch { /* 读不到就跳过 */ }
  }
  return false
}

// ── 一、数据 ────────────────────────────────────────────────
function 走目录(d, out) {
  let ents = []
  try { ents = readdirSync(d, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.isDirectory()) {
      // 归档不查：那是历史快照，坏了也不影响她今天
      if (e.name === '归档' || e.name === '_归档') continue
      走目录(join(d, e.name), out)
    } else out.push(join(d, e.name))
  }
  return out
}

const 坏档 = []
const 坏行 = []
let 档数 = 0, 行数档 = 0
if (existsSync(MEM)) {
  for (const p of 走目录(MEM, [])) {
    if (p.endsWith('.json')) {
      档数++
      let t = ''
      try { t = readFileSync(p, 'utf8') } catch (e) { 坏档.push({ 档: relative(MEM, p), 因: '读不了：' + e.message.slice(0, 40) }); continue }
      if (t.trim() === '') { 坏档.push({ 档: relative(MEM, p), 因: '空文件' }); continue }
      try { JSON.parse(t) } catch (e) { 坏档.push({ 档: relative(MEM, p), 因: e.message.slice(0, 60) }) }
    } else if (p.endsWith('.jsonl')) {
      行数档++
      let t = ''
      try { t = readFileSync(p, 'utf8') } catch { continue }
      let n = 0
      let 首 = ''
      t.split('\n').forEach((l, i) => {
        if (l.trim() === '') return
        try { JSON.parse(l) } catch { n++; if (!首) 首 = 'L' + (i + 1) + ': ' + l.slice(0, 50) }
      })
      if (n > 0) 坏行.push({ 档: relative(MEM, p), 行: n, 首 })
    }
  }
}

// ── 二、服务 ────────────────────────────────────────────────
const 服务差 = []
const 端口差 = []
const 端口未启用 = []
const 服务未启用 = []
if (!跳过系统) {
  for (const u of 服务们) {
    const 活 = 读命令(`systemctl is-active ${u} 2>&1`).trim()
    const 开 = 读命令(`systemctl is-enabled ${u} 2>&1`).trim()
    // ROLE_AWARE：可选服务在这台机器上本就不该跑 → 记为「未启用」，不进问题数
    if (活 !== 'active') {
      if (可选服务.has(u)) { 服务未启用.push(u); continue }
      服务差.push({ 单元: u, 活, 开 })
      continue
    }
    // 只认「开机会起不来」的那两种。static / indirect / generated 是正常的单元类型，
    // 拿 enabled 的完整枚举去卡会天天误报（比如 generated 是 systemd 自己生成的）。
    else if (开 === 'disabled' || 开 === 'masked') 服务差.push({ 单元: u, 活, 开 })
  }
  let 听 = ''
  try { 听 = execSync('ss -tln 2>/dev/null', { encoding: 'utf8', timeout: 5000 }) } catch { 听 = '' }
  for (const { 名, 口 } of 端口们) {
    if (端口在听(口)) continue
    // ROLE_AWARE：可选端口没在听 = 本机不跑这个组件，不是「连不上」
    if (可选端口.has(String(口))) { 端口未启用.push({ 名, 口 }); continue }
    端口差.push({ 名, 口 })
  }
}

// ── 三、健壮 ────────────────────────────────────────────────
const 非自愿 = []
if (!跳过系统) {
  try {
    const out = execSync('journalctl -u dsh-bot --since "24 hours ago" --no-pager 2>/dev/null', { encoding: 'utf8', timeout: 15000 })
    for (const l of out.split('\n')) {
      // 只认真正的非自愿终止。`Killed process` 是 OOM killer 的原话，`segfault` 是段错误。
      // 不要用 "fatal" 这种宽词 —— 上游 SDK 正常也会打 FATAL 级别的日志，那是噪音。
      if (/Out of memory|oom-kill|Killed process \d+|segfault at|core dumped/i.test(l)) 非自愿.push(l.replace(/^.{0,32}/, '').slice(0, 140))
    }
  } catch { /* journalctl 读不到就算了，不因为查不到就说她有事 */ }
}

function 读命令(c) {
  try { return execSync(c, { encoding: 'utf8', timeout: 8000 }) } catch (e) { return String((e.stdout || '') + (e.stderr || '')) }
}

// ── 四、插件快照 ────────────────────────────────────────────
// PATCH_SNAPSHOT 2026-11-14（批次412）：`reapply-patches.sh` 不带参数就是「覆盖恢复 + 重启」，
// 快照过期 = 一次误操作把最近所有改动冲回旧版，而且不报错。
// 实测 11-14 05:54 那次：快照停在 11-05，9 个文件处于风险区（含这十来批改的
// tool.js / index.js / voiceSlots.js / photoWatch.js / 话题.mjs）—— 跑了一次 --save 才对上。
// 这里只做「发现」：不一致的文件列出来，快照太旧才催。
const 快照清单 = process.env.PATCH_SNAPSHOT || '/root/onebot-patches/lib.md5'
const 插件根 = process.env.PLUGIN_ROOT || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel'
const 快照差 = []
let 快照小时 = 0
if (existsSync(快照清单) && existsSync(插件根)) {
  try {
    快照小时 = Math.round((Date.now() - statSync(快照清单).mtimeMs) / 36e5)
    for (const line of readFileSync(快照清单, 'utf8').split('\n')) {
      if (!line.trim()) continue
      const [期望, 相对] = line.trim().split(/\s+/)
      if (!期望 || !相对) continue
      const p = join(插件根, 相对)
      if (!existsSync(p)) { 快照差.push(相对 + '（快照里有、磁盘上没有）'); continue }
      const 实 = createHash('md5').update(readFileSync(p)).digest('hex')
      if (实 !== 期望) 快照差.push(相对)
    }
  } catch { /* 快照读不到就跳过，不因为这个说她有事 */ }
}

// ── 五、账本（她记录里的钱，能不能被算出来）────────────────────
// LEDGER_READ 2026-11-14（批次413）：账本.mjs 是纯正则解析器 —— 她的账是一句句
// 中文话（「买了自热饭（15 块）」「打工赚了 20」）。谁哪天改了写记录的措辞
// （比如工资从「打工赚了 20」变成「上班：便利店夜班（475 分钟，130 块）」），
// 账本没跟上，那笔钱就在日报/快照/面板里**静默变成 0**，而没有任何东西会报警。
// 11-03 那天她挣了 1137，快照记 0、日报写「赚了 0 块」—— 就是这么来的。
//
// 两条判据（都不计入「问题数」：账算不出来不让她停摆，是「说出来不对」那一类）：
//   · 记录里出现 undefined / NaN / null —— 写记录时变量没取到，这条账是废的
//   · 「看着有钱」（有 N 块 / N 元 / 括号负数）但 一笔() 算 0 —— 账本漏了一种写法
const 账本问题 = []
let 账本条数 = 0
try {
  const 资档 = JSON.parse(readFileSync(join(MEM, '资产.json'), 'utf8'))
  const 记 = Array.isArray(资档.记录) ? 资档.记录 : []
  账本条数 = 记.length
  for (const r of 记) {
    const w = String((r && r.what) || '')
    if (/undefined|NaN|null/.test(w)) { 账本问题.push({ 类: '脏', at: (r && r.at) || '', what: w }); continue }
    const x = 一笔(w)
    if (!x.花 && !x.赚 && !x.被拿 && (/[0-9]\s*(块|元|塊|圓)/.test(w) || /[-（(]\s*[0-9]+/.test(w))) {
      账本问题.push({ 类: '没认', at: (r && r.at) || '', what: w })
    }
  }
} catch { /* 资产读不到：一、那节已经按坏档报过了，这里不重复吵 */ }

// ── 汇总 ────────────────────────────────────────────────────
const 问题数 = 坏档.length + 坏行.length + 服务差.length + 端口差.length + 非自愿.length

if (要JSON) {
  console.log(JSON.stringify({ 角色, 档数, 行数档, 坏档, 坏行, 服务差, 服务未启用, 端口差, 端口未启用, 非自愿, 快照差, 快照小时, 账本条数, 账本问题, 问题数 }, null, 2))
} else if (静) {
  console.log('基础体检：档 ' + 档数 + '（坏 ' + 坏档.length + '），行档 ' + 行数档 + '（坏 ' + 坏行.length + '），'
    + '服务 ' + (跳过系统 ? '跳过' : 服务们.length + '（差 ' + 服务差.length + '，未启用 ' + 服务未启用.length + '）') + '，'
    + '端口 ' + (跳过系统 ? '跳过' : 端口们.length + '（差 ' + 端口差.length + '，未启用 ' + 端口未启用.length + '）') + '，'
    + '非自愿终止 ' + (跳过系统 ? '跳过' : 非自愿.length)
    + '，快照差 ' + (跳过系统 ? '跳过' : 快照差.length) + (快照差.length ? '（快照 ' + 快照小时 + ' 小时前）' : '')
    + '，账本 ' + 账本条数 + '（疑 ' + 账本问题.length + '）')
} else {
  console.log('── 一、数据 ──')
  console.log('  .json ' + 档数 + ' 个，坏 ' + 坏档.length)
  for (const x of 坏档.slice(0, 6)) console.log('    ✗ ' + x.档 + ' —— ' + x.因)
  console.log('  .jsonl ' + 行数档 + ' 个，坏 ' + 坏行.length)
  for (const x of 坏行.slice(0, 6)) console.log('    ✗ ' + x.档 + ' 坏 ' + x.行 + ' 行（' + x.首 + '）')
  console.log('\n── 二、服务 ──')
  if (跳过系统) console.log('  （跳过了）')
  else {
    console.log('  单元 ' + 服务们.length + ' 个，有问题 ' + 服务差.length
      + (服务未启用.length ? '（未启用 ' + 服务未启用.length + '：' + 服务未启用.join('、') + '）' : ''))
    for (const x of 服务差) console.log('    ✗ ' + x.单元 + '  active=' + x.活 + ' enabled=' + x.开)
    console.log('  端口 ' + 端口们.length + ' 个，没在听 ' + 端口差.length)
    for (const x of 端口差) console.log('    ✗ ' + x.名 + ' :' + x.口)
  }
  console.log('\n── 三、健壮（近 24h）──')
  if (跳过系统) console.log('  （跳过了）')
  else if (非自愿.length === 0) console.log('  ✓ 没有 OOM / segfault / core dump')
  else for (const l of 非自愿.slice(0, 6)) console.log('    ✗ ' + l)
  console.log('\n── 四、插件快照（reapply-patches.sh 恢复后会不会丢掉改动）──')
  if (快照差.length === 0) console.log('  ✓ 与快照一致（快照 ' + 快照小时 + ' 小时前）')
  else {
    console.log('  ⚠ 有 ' + 快照差.length + ' 个文件跟快照不一样（快照 ' + 快照小时 + ' 小时前）')
    for (const x of 快照差.slice(0, 8)) console.log('    · ' + x)
    console.log('  改完代码要跑：/root/运维服务/reapply-patches.sh --save')
  }
  console.log('\n── 五、账本（记录里的钱能不能被算出来）──')
  if (账本问题.length === 0) console.log('  ✓ ' + 账本条数 + ' 条记录，每一笔的钱都算得出来')
  else {
    console.log('  ⚠ ' + 账本问题.length + ' 条对不上（账本没跟上记录写法？）')
    for (const x of 账本问题.slice(0, 6)) {
      console.log('    · [' + x.at + '] ' + (x.类 === '脏' ? '脏数据：' : '算不出钱：') + x.what)
    }
    console.log('  两种修法：改 账本.mjs 的 一笔() 认这种写法；或那种记录本来就不该带钱，改回去')
  }
  console.log('\n' + '─'.repeat(46))
  console.log(问题数 === 0 ? '问题 0 条 —— 数据可解析、服务都在、没被系统杀过' : '问题 ' + 问题数 + ' 条')
}

// 待办：只报「真会让她的基础停摆」的 —— 坏档 / 服务差 / 端口差 / 非自愿终止。
// 单条坏行不算（.jsonl 里一行脏数据各模块自己 catch，不会让她说不出话）。
const 该管 = []
if (坏档.length > 0) 该管.push('记忆里有 ' + 坏档.length + ' 个 json 解析不了：' + 坏档.slice(0, 3).map((x) => x.档).join('、'))
if (服务差.length > 0) 该管.push('服务单元不对：' + 服务差.map((x) => x.单元 + '(active=' + x.活 + ')').slice(0, 3).join('、'))
if (端口差.length > 0) 该管.push('端口没在听：' + 端口差.map((x) => x.名 + ':' + x.口).join('、'))
if (非自愿.length > 0) 该管.push('近 24h 有 ' + 非自愿.length + ' 次非自愿终止（OOM/段错误）')
// 快照不一致本身不是故障 —— 刚改完代码当然不一致。只有「改了超过一天还没 --save」才催：
// 那时候万一有人重装插件跑恢复，改动就真丢了。
if (快照差.length > 0 && 快照小时 >= 24) {
  该管.push('插件快照 ' + 快照小时 + ' 小时没更新，有 ' + 快照差.length + ' 个文件不一致（跑 reapply-patches.sh --save）')
}
// 账本算不出钱：她的钱是真的动了，只是事后说不清花在哪 —— 属「说出来不对」，
// 不进问题数（不停摆），但要有人知道。
if (账本问题.length > 0) {
  该管.push('账本有 ' + 账本问题.length + ' 条记录算不出钱（' + 账本问题.slice(0, 2).map((x) => String(x.what).slice(0, 16)).join('、') + '），可能新写法没进 账本.mjs')
}
try {
  待办.同步({
    id: '体检-基础',
    事项: '基础体检：' + 该管.join('；'),
    来源: '体检-基础',
    该在: 该管.length > 0,
  })
} catch (e) {
  process.stderr.write('[待办未写入] ' + String((e && e.message) || e).slice(0, 100) + '\n')
}

process.exit(问题数 > 0 ? 1 : 0)
