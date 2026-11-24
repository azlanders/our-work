// 自主状态.mjs —— 「她现在在做什么」，只有这一个写入口
//
// 批次169（2026-11-07）审计：自主.json 有九个写入点，各写各的字段组合，
// 其中三处还是裸 writeFileSync（洗澡.mjs / 资产.mjs / 状态推进.mjs）：
//
//   · 裸写没有原子性 —— 进程正好在那一刻被 kill 或 OOM，落到盘上就是半截 JSON。
//     读档() 兜底成 {}，state/since/log 一起没：面板显示「发呆」，对话侧说她「待命」，
//     而人其实在上班。半截 JSON 是「她不知道自己刚才在干什么」最脏的一种来源。
//   · 九处都是「锁外读 → 改 → 写」。两个 cron 撞同一秒就丢更新，洗澡.mjs 那份
//     甚至连 save() 都没用，直接 fs.writeFileSync 整份覆盖。
//   · 字段组合三家不同：只有 打盹/自主行动 写 nextAt；只有 吃饭/洗澡 写 last；
//     只有 打盹/自主行动 写 log。资产.mjs 的 记活动 连 log 都不写 ——
//     面板点了「打工」，自主行动 的 recent/countToday 完全不知道，下一分钟就重挑。
//
// 这里只做三件事：锁内的 改()、写一件事的 起()、读真实位置的 真位()。
// 字段一个都不替调用方猜 —— 传了什么写什么，没传的一律不动。
import path from 'node:path'
import { 改档, 读档, 北京 } from './_底层.mjs'

export const 文件名 = '自主.json'
const 路径 = (目录) => path.join(String(目录), 文件名)

/** 锁内读-改-写。改() 拿到的是锁内重读的那份；返回 false 表示这一轮不用写。 */
export function 改(目录, 改法, 兜底 = {}) {
  return 改档(路径(目录), 改法, 兜底)
}

/**
 * 真实位置：place 的默认值。
 *
 * 在途时 资产.位置 是【出发地】—— 人还在路上，place 就不该先说到目的地。
 * 这条规矩原来写在 移动.mjs 的注释里，现在 起() 也按它补默认值，两处一致。
 */
export function 真位(目录) {
  const a = 读档(path.join(String(目录), '资产.json'), { 位置: '家' })
  return String(a.位置 || '家')
}

/**
 * 起一件事 / 改一件事。只写传进来的字段。
 *
 * 事 = { state, place, since, doneAt, nextAt, form, note, last, 记, nextMinutes }
 *
 * 记: true —— 额外往 log 追加一条。默认 false：
 *   log 是「她做过什么」的账，自主行动 拿它算 countToday / recent（最近 4 件用来降权）。
 *   家区域 每 20 分钟一条「在家·床」，混进去会把 recent 全占满，降权直接失效 ——
 *   所以它的历史单独叫 区域历史（见 家区域.mjs），不叫 log。
 *
 * 几个坑（都踩过，别再改回去）：
 *   · place 不传 —— 用 真位() 补。老代码里 打盹/自主行动 都这么补。
 *   · nextAt 不传 —— 一律不动。吃饭.mjs 本来就不写 nextAt（它靠 吃饭.json 的「到」
 *     拦人），替它写 0 会让 自主行动 下一分钟就把她正吃着的事重挑掉。
 *   · since 传 falsy —— 按现在算。状态推进.mjs 的「睡着」分支要传睡眠开始时刻，别丢。
 */
export function 起(目录, 事 = {}) {
  const { 记 = false, nextMinutes, logNote, ...字段 } = 事
  const 现在 = Number(字段.since) || Date.now()
  return 改(目录, (aut) => {
    if (字段.state !== undefined) aut.state = String(字段.state)
    aut.since = 现在
    if (字段.place !== undefined) aut.place = String(字段.place)
    else if (!aut.place) aut.place = 真位(目录)
    if (字段.form !== undefined) aut.form = String(字段.form)
    if (字段.doneAt !== undefined) aut.doneAt = Number(字段.doneAt) || 0
    if (字段.nextAt !== undefined) aut.nextAt = Number(字段.nextAt) || 0
    if (字段.note !== undefined) aut.note = String(字段.note)
    if (字段.last !== undefined) aut.last = 字段.last
    if (记) {
      const 条 = { at: 北京(现在), state: String(aut.state || ''), note: String(logNote !== undefined ? logNote : (字段.note || '')) }
      if (Number.isFinite(Number(nextMinutes))) 条.nextMinutes = Number(nextMinutes)
      aut.log = [...(Array.isArray(aut.log) ? aut.log : []), 条].slice(-30) // SLIM 2026-11-07（批次210）：200→30，她只需要最近几次，整份反序列化太贵
    }
    return true
  })
}
