// _底层.mjs —— 共享/工具 里所有脚本的底层：读档 / 写档 / 北京时间。
//
// 为什么收成一处（批次164 审计量出来的）：
//   · 39 份 load/save 各写一份，其中只有 5 份是原子写；
//   · 20 多处各自解析北京时间，三种写法不等价 —— `.replace(' ','T') + ':00+08:00'`
//     遇到已经带秒的字符串会拼成 `06:02:23:00+08:00`，Date.parse 直接 NaN；
//   · 最要命的是 睡眠阶段.mjs 那份「原子写」的临时名是固定的 `file + '.tmp'`：
//     两个进程同时写会往同一个 .tmp 里灌，rename 出去的就是对方的半截。
//     ——它会写 状态.json / 睡眠.json / 睡醒.json，而她睡着时这条路每 20 分钟就跑一次。
//
// 这里不猜路径、不读环境变量：路径一律由调用方传。每个脚本的沙盒变量名都不一样
// （ST_BASE / QQ_AUTONOMY_MEM / WORK_MEM / GAP_MEM / HUNGER_MEM …），
// 在这一层统一猜，必然在某个沙盒里串味 —— 沙盒测试测到真数据上，比没测更糟。

import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { dirname, basename } from 'node:path'
import { 加锁 } from './_锁.mjs'

const 时区 = 8 * 3600e3

/**
 * 读一个 JSON 档。
 *
 * 文件不在 / 坏 / 内容是 null 或标量 —— 一律回落默认值。
 * 判 typeof 那一下是 2026-11-04 加的：文件被写成 `null` 后，后面直接读字段 TypeError。
 */
export function 读档(p, 默认 = {}) {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8'))
    return v === null || typeof v !== 'object' ? 默认 : v
  } catch { return 默认 }
}

/**
 * 写一个 JSON 档。恒原子、临时名恒唯一。
 *
 * 临时名带 pid + 随机：两个进程同时写，各自的 rename 都是完整的，
 * 最后落地的那个赢 —— 不会出现「A 的 rename 把 B 的半截文件搬成正式档」。
 * （锁解决的是读-改-写丢更新，那是调用方的事，这里不做。）
 *
 * 选.不写  —— 干跑（原来的 DRY）
 * 选.容错  —— 写不进去只吼一声，不抛（原来的 try/catch + console.log）
 */
export function 写档(p, 值, 选 = {}) {
  if (选.不写) return false
  const 临时 = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(临时, JSON.stringify(值, null, 2))
    renameSync(临时, p)
    return true
  } catch (e) {
    try { unlinkSync(临时) } catch { /* 没造出来，或已经 rename 走了 */ }
    if (选.容错) { console.log('写不进去：' + e.message); return false }
    throw e
  }
}

/**
 * 锁内读-改-写。改() 拿到的是【锁内重读】的那份，返回 false 表示这一轮不用写。
 *
 * 为什么不直接 读档() → 改 → 写档()：读和写之间隔着几十毫秒到几秒（中间可能要跑
 * 子进程），这段时间别人写的字段会被旧副本整份抹掉。锁内重读把这个窗口压到微秒级。
 *
 * 锁是按文件名抢的（_锁.mjs），所以不同脚本改同一个档会互斥 —— 前提是都走这里。
 * 批次169 从 移动.mjs 提上来：写 自主.json 的九个入口全要它，不该只有搬人那一处有。
 */
export function 改档(p, 改, 兜底 = {}) {
  const waitMs = Number.isFinite(Number(process.env.QQ_LEDGER_LOCK_WAIT_MS)) ? Math.max(0, Number(process.env.QQ_LEDGER_LOCK_WAIT_MS)) : 5000
  // LOCKNAME_REVERT 2026-11-24：曾改成「父目录名 + basename」以避免子目录同名互斥，
  // 但 t353 有一整套「预建 计划.json.lock 期望 fail-closed」的契约测试，
  // 改名后它们全部失效（9 项红）。权衡后回滚：记忆目录是扁平的，
  // 同名不同文件的场景只有「软链接指向子目录实体」，而软链接与实体本就该互斥（同一个文件）。
  const 放 = 加锁(basename(String(p)), { strict: true, waitMs })
  try {
    const 原 = 读档(p, 兜底)
    const 值 = 原 && typeof 原 === 'object' ? 原 : 兜底
    const r = 改(值)
    if (r === false) return null
    写档(p, 值, { 容错: true })
    return r === undefined ? 值 : r
  } finally { 放() }
}

/** 北京「年-月-日 时:分」。服务器是 UTC，项目内一律北京时间。 */
export const 北京 = (ms = Date.now()) => new Date(ms + 时区).toISOString().slice(0, 16).replace('T', ' ')

/** 北京「年-月-日 时:分:秒」。睡眠段的 start/end 用这个精度。 */
export const 北京秒 = (ms = Date.now()) => new Date(ms + 时区).toISOString().slice(0, 19).replace('T', ' ')

/** 北京「年-月-日」。 */
export const 北京日期 = (ms = Date.now()) => new Date(ms + 时区).toISOString().slice(0, 10)

/**
 * 把北京时间的字符串解析成毫秒。认这几种写法（项目里全都出现过）：
 *   「2026-11-07」「2026-11-07 06:02」「2026-11-07 06:02:23」
 *   「2026-11-07T06:02」「2026-11-07 06:02:23.123」
 *   「2026-11-07T06:02:23+08:00」（已经带时区就不再加）
 *
 * 解析不出来返回兜底值 —— 不返回 NaN，因为 NaN 会像病毒一样传到每个比较里，
 * 而 `if (h > 0)` 对 NaN 恒假，看起来就像「没睡过」。
 */
export function 解析北京(s, 兜底 = 0) {
  if (typeof s !== 'string') return 兜底
  let t = s.trim().replace(' ', 'T')
  if (!t) return 兜底
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00:00'
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t)) t += ':00'
  if (!/(?:[+-]\d{2}:\d{2}|Z)$/.test(t)) t += '+08:00'
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : 兜底
}


/**
 * 原子写任意文本或二进制内容（drop-in 替代裸 writeFileSync）。
 * 临时名带 pid + 随机，失败自动清理临时文件并向上抛错。
 */
export function 原子写(p, 内容, 编码 = 'utf8') {
  const 临时 = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    mkdirSync(dirname(p), { recursive: true })
    if (typeof 内容 === 'string') writeFileSync(临时, 内容, 编码)
    else writeFileSync(临时, 内容)
    renameSync(临时, p)
  } catch (e) {
    try { unlinkSync(临时) } catch (_err) { console.error('[_底层:原子写清理]', _err?.message || _err) }
    throw e
  }
}
