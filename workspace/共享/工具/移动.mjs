// 移动.mjs —— 她换地方这件事，只有这一个实现
//
// 批次166（2026-11-07）：原来「搬人 + 同步自主.json」有四份各写一遍，规则三种：
//
//   走路.mjs --去          写在途，但完全不碰 自主.json
//   缺口.mjs 同步搬动()     出发后补一次：place 写【目的地】
//   qq_go 走一趟()          出发后补一次：place 写【出发地】，无条件 state=走动
//   资产.mjs --去           瞬移，一样都不同步
//
// 缺口那份先写「到了」，qq_go 那份先写「还在出发地」—— 同一时刻两套说法。
// 加第五个入口（她学会骑车、坐公交）时必然再漏一次，所以收到这里。
//
// 两条硬规矩：
//
// 1) place 写【出发地】。人还在路上，先说到了就是撒谎 —— 面板信 资产.位置，
//    但对话侧和 醒来.mjs 会读 自主.place，两边一句话对不上就是「她不知道自己在哪」。
//
// 2) 读-改-写在【同一把锁】里。原来四个入口都是「锁外读 → 锁内写」，
//    两个 cron 撞同一秒就丢更新 —— 走路.mjs 自己的注释写着「最坏是丢一次更新」。
//    _底层.写档 只保证不出现半截 JSON，它明说了「读-改-写丢更新是调用方的事」。
import fs from 'node:fs'
import path from 'node:path'
import { 改档, 北京 } from './_底层.mjs'
import { execFileSync } from 'node:child_process'

/** 出发：写下 在途，并把「她在哪 / 在做什么」按事实对齐。位置不变，要等到了才变。 */
export function 出发(目录, { 从, 到, 分钟, 现在 = Date.now() }) {
  const 分 = Math.max(1, Math.round(Number(分钟) || 1))
  const arriveAt = 现在 + 分 * 60e3
  改档(path.join(目录, '资产.json'), (a) => {
    a.在途 = { from: String(从 || a.位置 || '家'), to: String(到), startAt: 现在, arriveAt, minutes: 分 }
  }, { 钱: 0, 位置: String(从 || '家') })
  // 出发时 place 仍是「从」：她人还在那儿，只是要走了。
  // nextAt 必须推到到达之后 —— 不然下一分钟的 自主行动 立刻重挑，她刚出门就被按回原地。
  改档(path.join(目录, '自主.json'), (aut) => {
    // 睡着的人不会自己迈腿。真被谁搬了（守卫有漏、面板点了按钮），也只补地点，
    // 别把 state 从「睡觉」改成「走动」—— 那是替她宣布醒着，
    // 同步QQ状态 会说她醒着，主人那边看到的就是「叫不醒」。
    // PLACE_FALLBACK 2026-11-13（批次385）：资产那边是 `从 || a.位置 || '家'`，
    // 这边只写 `从 || ''` —— 不传 从 时资产记当前位置、自主变空串，
    // 而 移动.mjs 自己的注释写着「两边一句话对不上就是『她不知道自己在哪』」。
    // 线上唯一调用方 走路.mjs:76 总是传 从，所以走不到；补上让两处口径一致。
    if (/睡/.test(String(aut.state || ''))) { aut.place = String(从 || aut.place || '家'); return }
    aut.state = '走动'
    aut.since = 现在
    aut.form = '线下'
    aut.place = String(从 || aut.place || '家')   // 同 PLACE_FALLBACK：与 资产.位置 的口径对齐
    aut.doneAt = arriveAt
    aut.nextAt = arriveAt + 30e3
  }, {})
  // UMBRELLA_AUTO 2026-11-07（批次194）：出门前看天气。判据全在 物品.mjs 的 --带伞，
  // 这里只无脑调一次（注意 物品.mjs 的目录跟它的 QQ_AUTONOMY_MEM 走，跟本函数的
  // 「目录」参数无关——线上两者同为 记忆/）。失败不拦走路。
  try {
    execFileSync('/usr/local/bin/node', ['{{BOT_ROOT}}/共享/工具/物品.mjs', '--带伞', '--去', String(到)], {
      encoding: 'utf8', timeout: 10000,
      env: process.env,
    })
  } catch { /* 带不上伞不影响出门 */ }
  return { 从: String(从 || ''), 到: String(到), 分钟: 分, arriveAt }
}

/**
 * 结算：到点了才真的到。没到 / 不在路上都返回 ok:false，调用方照它说的话去讲。
 * 幂等：重复调只会第一次动账（在途 已删）。
 */
export function 到了(目录, 现在 = Date.now()) {
  let 途 = null
  const 结果 = 改档(path.join(目录, '资产.json'), (a) => {
    途 = a.在途 || null
    if (!途) return false
    if (Number(途.arriveAt) > 现在) return false
    a.位置 = String(途.to || a.位置 || '家')
    // ARRIVE_AT：到这个地点的时刻。面板「发呆 · 街市（已经 59 分钟）」靠它，
    // 自主.json 的 since 在换地方时不会变，只有这里知道她什么时候到的。
    a.到此At = 现在
    const 记录 = Array.isArray(a.记录) ? a.记录 : []
    记录.push({ at: 北京(现在), what: `从${途.from}走到${途.to}` })
    a.记录 = 记录.slice(-200)
    delete a.在途
    return { ok: true, 到: a.位置, 从: String(途.from || ''), 分钟: Number(途.minutes) || 0 }
  }, { 钱: 0, 位置: '家' })

  if (结果) {
    同步到达(目录, 结果.到, 现在)
    return 结果
  }
  if (!途) return { ok: false, why: '没在路上' }
  return { ok: false, why: '还差', 到: String(途.to || ''), 剩: Math.max(0, Math.ceil((Number(途.arriveAt) - 现在) / 60e3)) }
}

/**
 * 瞬移：不花时间直接到（面板按钮、调试）。
 * 语义等于「出发 + 立刻到达」，所以照样清 在途、写 到此At、记一笔、同步自主。
 */
export function 瞬移(目录, 到, 现在 = Date.now()) {
  const 结果 = 改档(path.join(目录, '资产.json'), (a) => {
    const 从 = String(a.位置 || '家')
    // 本来就在这儿：不动账，也不记「从家到了家」那种假账。调用方拿 null 去说「本来就在」。
    if (从 === String(到)) return false
    a.位置 = String(到)
    a.到此At = 现在
    delete a.在途
    const 记录 = Array.isArray(a.记录) ? a.记录 : []
    记录.push({ at: 北京(现在), what: `从${从}到了${到}` })
    a.记录 = 记录.slice(-200)
    return { 从, 到: String(到) }
  }, { 钱: 0, 位置: '家' })
  if (结果) 同步到达(目录, 结果.到, 现在)
  return 结果
}

/**
 * 到达只对齐事实：地点是这儿。只有还挂着「走动」时才把计时归零 ——
 * 她已经坐下开始吃饭了（state=吃饭、nextAt 是吃完的时刻）就别覆盖。
 */
function 同步到达(目录, 到, 现在) {
  const p = path.join(目录, '自主.json')
  if (!fs.existsSync(p)) return
  改档(p, (aut) => {
    aut.place = String(到 || '')
    if (String(aut.state || '') === '走动') {
      aut.since = 现在
      aut.doneAt = 现在
      aut.nextAt = 现在
    }
  }, {})
}
