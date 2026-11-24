#!/usr/bin/env node
// 心跳.mjs —— 批次208（2026-11-07）：统一心跳调度，收编 21 条高频 cron。
//
// 为什么：crontab 里 21 条每 1/2/5/10/15/20/30/40 分钟的任务在整点会同时拉起
// 十几个 Node 进程抢锁读写同一批 JSON（既耗内存，先后顺序也不确定）。
// 现在由一张声明式表（心跳表.json）统一管理，按表顺序串行跑。
//
// 用法：
//   node 心跳.mjs --tick                    # cron 每分钟一次，跑本分钟命中的任务
//   node 心跳.mjs --dry [--at "2026-11-07 18:20"]   # 只打印命中集与顺序，不跑
//   node 心跳.mjs --tick --表 /tmp/x.json    # 指定表（单测用）
//
// 设计：
//   · 串行执行，顺序 = 表顺序；单任务超时（默认 25s）或失败只记 心跳.log，绝不阻塞后续。
//   · 睡着(记忆) && 任务.睡着跑 === false → 调度层直接跳（省子进程冷启动）。
//   · 跨分钟重入：50 秒内已经跑过一轮就跳过（慢任务不会叠罗汉）。
//   · 日志：每个任务的 stdout/stderr 照旧追加到 记忆/<日志>（复刻原 cron 的 >> 行为）。
//   · 沙盒：FISH_SANDBOX_DIR 改记忆目录、心跳_超时毫秒/心跳_重入毫秒 改阈值（单测用）。
import { readFileSync, existsSync, appendFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { 加锁 } from './_锁.mjs'
import { 睡着 } from './睡态.mjs'
// FAIL_VISIBLE 2026-11-14（批次419）：失败要能看见。原来它只写 心跳.log，
// 而 目录卫生.mjs 把日志裁到 2500 行 —— 心跳一分钟一行，1.7 天就滚没了。
// 「某个任务连着失败」这件事，过了两天就完全没有痕迹。
import * as 待办 from './待办.mjs'
import { 写档 } from './_底层.mjs'

const 目录 = dirname(fileURLToPath(import.meta.url))
// 环境值一律函数内读取：模块顶层捕获会让「import 后再设 env」的沙盒测试失效
const 记忆 = () => process.env.FISH_SANDBOX_DIR || '{{BOT_ROOT}}/记忆'
const 日志目录 = () => { const d = join(记忆(), '日志'); try { mkdirSync(d, { recursive: true }) } catch {} return d }
const 日志路径 = () => join(日志目录(), '心跳.log')
const 状态路径 = () => join(记忆(), '.心跳上次.json')
// TASK_LEDGER 2026-11-12：每个任务上次「真跑」的时刻（毫秒）。
// 原来只有 lastStart（整轮），面板想看「哪个任务停摆了」只能猜各自日志的 mtime ——
// 而 --quiet 的任务根本不写日志（工作/同步QQ状态/自主行动 全被误判成超时）。
// 这里在调度层记：跑了才写、睡跳过和没命中的不写，比日志 mtime 可信。
const 任务账路径 = () => join(记忆(), '.心跳任务.json')
// 连败账：每个任务连着失败了几次。成功一次就归零。
const 连败路径 = () => join(记忆(), '.心跳连败.json')
function 读连败() { try { return JSON.parse(readFileSync(连败路径(), 'utf8')) || {} } catch { return {} } }
/**
 * 失败几次才值得挂待办：
 *   · 高频任务（间隔分）容忍偶发 —— 同步QQ状态 5 分钟一跑，4.5% 的失败率，
 *     连败 3 次已经是 0.009%，那时候确实出问题了。
 *   · 每天/每周/每月一次的任务，**失败一次就是真停了**（下次机会在一天后），
 *     还要等三次才报，等于三天后才知道。
 */
function 连败阈值(t) {
  if (t.每天 === true || t.每周 !== undefined || t.每月 !== undefined) return 1
  return 3
}

function 记任务(账) {
  const 键 = Object.keys(账 || {})
  if (!键.length) return
  const 放 = 加锁('heartbeat-tasks', { strict: true })
  try {
    let 旧 = {}
    try { 旧 = JSON.parse(readFileSync(任务账路径(), 'utf8')) || {} } catch { 旧 = {} }
    const 新 = Object.assign({}, 旧, 账)
    // 任务表就 44 条，留 300 个名字足够；防止哪天脚本名带上时间戳把文件撑大
    const 名 = Object.keys(新)
    if (名.length > 300) for (const k of 名.slice(0, 名.length - 300)) delete 新[k]
    writeFileSync(任务账路径(), JSON.stringify(新, null, 1))
  } finally { try { 放() } catch { /* 放锁失败不影响本轮 */ } }
}
const 超时毫秒 = () => Math.max(500, Number(process.env.心跳_超时毫秒) || 25000)
// 0 是合法值（想连着补跑两轮时用），不能用 `|| 50000` —— 那会把 0 当成「没设」回落 50 秒。
// 批次209 在 睡眠阶段 踩过同一个坑（`Number(0) || 45` 把地板值当成没有）。这次是沙盒测出来的。
const 重入毫秒 = () => {
  const v = process.env.心跳_重入毫秒
  if (v === undefined || v === '') return 50000
  return Math.max(0, Number(v) || 0)
}

const 北京 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 记(行) {
  try { appendFileSync(日志路径(), 北京() + ' ' + 行 + '\n') } catch { /* 日志失败不影响调度 */ }
}

/** 读表：数组即任务列表；坏行跳过。 */
export function 读表(p) {
  const d = JSON.parse(readFileSync(p, 'utf8'))
  const arr = Array.isArray(d) ? d : (Array.isArray(d?.任务) ? d.任务 : [])
  return arr.filter((t) => t && typeof t.脚本 === 'string' && t.脚本 !== '')
}

/** 该分钟是否命中：分针 % 间隔 === 偏移 % 间隔。 */
export function 命中(任务, 分, 时刻) {
  // SCHED213 2026-11-07（批次213）：支持「每周几 + 时:分」和「每月几号 + 时:分」。
  // 原判据只有「分针 % 间隔」，跨天的任务（每周/每月）根本表达不了——间隔 10080 会
  // 退化成「每小时那一分钟都跑」。跨天任务必须有日期，--at 只给 HH:MM 时不命中。
  const h = Number(任务.时 ?? 0)
  const m = Number(任务.分 ?? 0)
  if (任务.每周 !== undefined && 任务.每周 !== null) {
    if (!时刻 || 时刻.周 === null) return false
    return 时刻.周 === Number(任务.每周) && 时刻.时 === h && 时刻.分 === m
  }
  if (任务.每月 !== undefined && 任务.每月 !== null) {
    if (!时刻 || 时刻.日 === null) return false
    return 时刻.日 === Number(任务.每月) && 时刻.时 === h && 时刻.分 === m
  }
  // DAILY 2026-11-09（批次345）：每天 HH:MM。
  // 不加这个分支，「每天 11:30」在表里没有写法 —— `分` 是当前分钟(0~59)，
  // `间隔分: 1440` 永不命中，写 `时/分` 会被忽略而退化成「每分钟都跑」。
  // 日级任务因此一直留在 crontab，两套调度并存、时区还要心里换算。
  if (任务.每天 === true) {
    if (!时刻) return false
    return 时刻.时 === h && 时刻.分 === m
  }
  const 间 = Math.max(1, Math.round(Number(任务.间隔分) || 1))
  const 偏 = Math.round(Number(任务.偏移分) || 0)
  return ((分 % 间) + 间) % 间 === ((偏 % 间) + 间) % 间
}

/** 北京时刻（系统是 UTC）：{ 分, 时, 日, 周 }，周 0=周日。 */
export function 北京时刻(ms = Date.now()) {
  const d = new Date(ms + 8 * 3600e3)
  return { 分: d.getUTCMinutes(), 时: d.getUTCHours(), 日: d.getUTCDate(), 周: d.getUTCDay() }
}

/** "YYYY-MM-DD HH:MM" / "HH:MM" → 时刻；只给 HH:MM 时日/周为 null（跨天任务不命中）。 */
export function 解析时刻(s) {
  const str = String(s || '')
  const m = /(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})\s*$/.exec(str)
  if (!m) return null
  const 时 = Number(m[4])
  const 分 = Number(m[5])
  if (!(分 >= 0 && 分 <= 59 && 时 >= 0 && 时 <= 23)) return null
  if (m[1]) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 时, 分))
    return { 分, 时, 日: d.getUTCDate(), 周: d.getUTCDay() }
  }
  return { 分, 时, 日: null, 周: null }
}

/** "--at 2026-11-07 18:20" 或 "18:20" → 分针；坏格式回 null。 */
export function 解析分钟(s) {
  const m = /(\d{1,2}):(\d{2})\s*$/.exec(String(s || ''))
  if (!m) return null
  const 分 = Number(m[2])
  if (!Number.isFinite(分) || 分 < 0 || 分 > 59) return null
  return 分
}

function 参数表(argv) {
  const 取 = (名) => {
    const i = argv.indexOf(名)
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : ''
  }
  return { 表: 取('--表') || join(目录, '心跳表.json'), at: 取('--at') }
}

function 表与分钟(opt) {
  const 表 = 读表(opt.表)
  const 时刻 = opt.at !== '' ? 解析时刻(opt.at) : 北京时刻(Date.now())
  if (!时刻) throw new Error('--at 格式不对，示例：--at "2026-11-07 18:20"')
  return { 表, 分: 时刻.分, 时刻 }
}

function 睡着了() {
  try { return 睡着(记忆()) === true } catch { return false }
}

/** --dry：打印本分钟命中集与顺序。 */
export function 干跑(argv = process.argv.slice(2), 输出 = console.log) {
  const { 表, 分, 时刻 } = 表与分钟(参数表(argv))
  const 睡 = 睡着了()
  let 命中数 = 0, 跳过数 = 0
  for (const t of 表) {
    if (!命中(t, 分, 时刻)) continue
    命中数++
    if (t.睡着跑 === false && 睡) {
      跳过数++
      输出(`[睡跳过] ${t.名 || t.脚本}`)
      continue
    }
    输出(`[命中] ${String(t.名 || t.脚本).padEnd(8, '　')} ${t.脚本} ${(t.参数 || []).join(' ')} → ${t.日志 || '(无日志)'}`)
  }
  输出(`— 分针 :${String(分).padStart(2, '0')} 命中 ${命中数} 条（睡跳过 ${跳过数}，${睡 ? '她睡着' : '她醒着'}，表内共 ${表.length} 条）`)
  return { 分, 命中数, 跳过数, 睡 }
}

/** --tick：按表顺序串行执行本分钟任务。 */
export function 跑一轮(argv = process.argv.slice(2), 输出 = console.log) {
  const opt = 参数表(argv)
  const { 表, 分, 时刻 } = 表与分钟(opt)
  // 先取调度锁再读写重入标记：锁冲突时不得留下标记或派发子任务。
  let 放
  try {
    放 = 加锁('heartbeat', { strict: true })
  } catch (e) {
    输出(`心跳锁不可用，跳过本轮：${e?.message || e}`)
    return { skipped: 'lock' }
  }
  let 跑 = 0, 失败 = 0, 跳过 = 0
  const 跑过 = {}
  const 连败账 = 读连败()
  let 连败脏 = false
  try {
    // 跨分钟重入：上一轮还没结束就不再叠
    try {
      if (existsSync(状态路径())) {
        const st = JSON.parse(readFileSync(状态路径(), 'utf8'))
        const 上次 = Number(st?.lastStart) || 0
        if (Date.now() - 上次 < 重入毫秒()) {
          输出('上一轮还在窗口内，跳过')
          return { skipped: 'reentry' }
        }
      }
    } catch { /* 状态坏了就当没跑过 */ }
    try { writeFileSync(状态路径(), JSON.stringify({ lastStart: Date.now() })) } catch { /* 写不进也不拦 */ }

    const 睡 = 睡着了()
    const 基底 = dirname(opt.表) // 任务脚本/相对路径都相对「表所在目录」（生产表就在 共享/工具）
    for (const t of 表) {
      if (!命中(t, 分, 时刻)) continue
      if (t.睡着跑 === false && 睡) { 跳过++; continue }
      跑++
      const 脚本路径 = isAbsolute(t.脚本) ? t.脚本 : join(基底, t.脚本)
      // BUDGET 2026-11-14（批次465）：预算单独取一次。
      // 原来报错里写「超时(>25000ms)」，而某条任务设了 t.超时毫秒 时实际给的是别的数 —— 排查时会被带偏。
      const 预算 = Math.max(500, Number(t.超时毫秒) || 超时毫秒())
      const r = spawnSync(process.execPath, [脚本路径, ...(Array.isArray(t.参数) ? t.参数 : [])], {
        cwd: 基底,
        timeout: 预算,
        encoding: 'utf8',
        maxBuffer: 4 * 1024 * 1024,
      })
      // 跑了就记 —— 成功失败都算「调度层确实派发过」，停摆要抓的是「没派发」
      跑过[String(t.名 || t.脚本)] = Date.now()
      const 超时 = r.error && r.error.code === 'ETIMEDOUT'
      // SIGNAL_FAIL 2026-11-14（批次465）：原来只认「status 是数字且非 0」。
      // 而子进程**被信号杀死**（OOM / 外部 kill / 收摊）时 status 是 null、signal 有值，
      // spawn 直接失败时 status 也是 null、error 有值 —— 这两种都被判成「成功」，
      // 更糟的是会走 else 分支把连败账归零，于是「一直被杀」的任务在台账上永远健康。
      // 实测：node -e 'process.kill(process.pid,"SIGKILL")' → status=null signal=SIGKILL。
      const 被信号 = !超时 && r.status === null && !!r.signal
      const 起不来 = !超时 && !!r.error
      const 坏 = 超时 || 被信号 || 起不来 || (typeof r.status === 'number' && r.status !== 0)
      // 复刻原 cron 的 >> 重定向：stdout/stderr 追加到该任务自己的日志
      if (t.日志) {
        const 段 = String(r.stdout || '') + String(r.stderr || '')
        if (段.trim() !== '') { try { appendFileSync(join(日志目录(), t.日志), 段) } catch { /* 日志目录不在就算了 */ } }
      }
      const 名 = String(t.名 || t.脚本)
      if (坏) {
        失败++
        const 原因 = 超时
          ? `超时(>${预算}ms)`
          : 被信号
            ? `被信号 ${r.signal} 杀掉`
            : 起不来
              ? `起不来(${(r.error && (r.error.code || r.error.message)) || 'spawn'})`
              : `退出码 ${r.status}`
        const 尾 = String(r.stderr || '').trim().split('\n').slice(-2).join(' | ').slice(0, 300)
        const 前 = Number(连败账[名]?.连败) || 0
        const 后 = 前 + 1
        连败账[名] = { 连败: 后, 最后失败: 北京(), 错误: (原因 + (尾 ? ' ' + 尾 : '')).slice(0, 200) }
        连败脏 = true
        // 只在「刚好到阈值」那一次挂，之后继续失败也不再重复写盘
        if (后 === 连败阈值(t)) {
          try {
            待办.同步({
              id: '心跳-失败-' + 名,
              事项: `心跳任务「${名}」连着失败 ${后} 次：${原因}${尾 ? '（' + 尾.replace(/\s+/g, ' ').slice(0, 100) + '）' : ''}`,
              来源: '心跳',
              该在: true,
            })
          } catch (e) {
            // 空 catch 会把这个错彻底埋掉 —— 批次409 在二号机踩过一模一样的一次
            try { process.stderr.write('[待办未写入] ' + (e?.message || e) + '\n') } catch { /* 连 stderr 都写不进就算了 */ }
          }
        }
        记(`[失败] ${名} ${原因}${尾 ? ' ｜ ' + 尾 : ''}`)
      } else {
        // 好了一次就算恢复正常：待办自动挪进 done（谁=自动）
        if (连败账[名] && Number(连败账[名].连败) > 0) {
          连败账[名] = { 连败: 0, 最后成功: 北京() }
          连败脏 = true
        }
        // 连败账丢了（换机/换目录/被清）时上一次的失败待办还挂在面板上 ——
        // 成功就是成功，不管账本里有没有这一笔，都去销一次（没有这条不会写盘）。
        try { 待办.同步({ id: '心跳-失败-' + 名, 该在: false }) } catch { /* 销不掉下次接着销 */ }
      }
    }
  } finally {
    // 记账放在放锁之前：这一轮的派发已经发生，锁还没放的时候写最不容易跟下一轮打架
    try { 记任务(跑过) } catch { /* 记不上不影响调度 */ }
    if (连败脏) { try { 写档(连败路径(), 连败账) } catch { /* 连败账写不进不影响调度 */ } }
    try { 放() } catch { /* 忽略 */ }
  }
  if (跑 > 0 || 失败 > 0) 记(`心跳 ${String(分).padStart(2, '0')} 分：跑 ${跑} 条，失败 ${失败}，睡跳过 ${跳过}`)
  return { 分, 跑, 失败, 跳过 }
}

// ---- CLI（只在直接运行时执行；被 import 时绝不跑主流程）----
const 是主 = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] } catch { return false }
})()
const argv = process.argv.slice(2)
if (是主) {
  if (argv.includes('--dry')) {
    干跑(argv)
  } else if (argv.includes('--tick')) {
    const r = 跑一轮(argv)
    if (r && r.skipped) process.exit(0)
    process.exit(0)
  } else {
    console.log('用法：node 心跳.mjs --tick ｜ --dry [--at "YYYY-MM-DD HH:MM"] [--表 路径]')
  }
}
