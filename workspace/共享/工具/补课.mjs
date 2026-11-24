#!/usr/bin/env node
// 补课.mjs —— 她睡着的几个小时里群里聊了什么，醒来收一份事实账（2026-11-07 批次190）。
//
// 纪律：只递事实（谁说了几条、聊到「什么」），一个字的反应都不替她生成。
// 写 记忆/醒来看到.json（已用:false），注入端（poll.js）在她醒后第一轮递进上下文、
// 递完置已用。她自己说不说、怎么说，全是她的事。
//
// 触发：醒来.mjs 结算完一觉后在 finally 里调；只对 >=1 小时的觉做（打盹没错过什么）。
// 沙盒：QQ_CATCHUP_MEM 指记忆目录、QQ_CATCHUP_LOG 指群聊日志目录。
import { readFileSync, readdirSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { 写档 } from './_底层.mjs'

const MEM = process.env.QQ_CATCHUP_MEM || '{{BOT_ROOT}}/记忆'
const LOG_DIR = process.env.QQ_CATCHUP_LOG || '{{BOT_ROOT}}/群聊日志'
const SELF = '3556352474'   // 她自己睡着的，日志里按说没有；保险起见排掉

/** 时间归一：'T' → 空格；缺秒补 ':00'。返回可整串比较的 'YYYY-MM-DD HH:MM:SS'。 */
function 规(t) {
  t = String(t || '').replace('T', ' ').trim()
  return t.length === 16 ? t + ':00' : t
}

/** 取睡眠区间内的消息（含起止）。导出来给单测。 */
export function 取段内(起, 止, msgs) {
  const a = 规(起), b = 规(止)
  return (Array.isArray(msgs) ? msgs : []).filter((m) => {
    const t = 规(m && m.time)
    return t && t >= a && t <= b
  })
}

/** 汇总：按群聚合 → 谁在聊（前3）、聊到什么（非占位里最长的两条各截 24 字）。 */
export function 汇总(msgs) {
  const by = new Map()
  for (const m of (Array.isArray(msgs) ? msgs : [])) {
    const uid = String(m && m.user_id || '')
    if (!uid || uid === SELF) continue
    const text = String(m && m.text || '').trim()
    if (!text) continue
    const g = String(m && m.group_id || '?')
    if (!by.has(g)) by.set(g, [])
    by.get(g).push({ 名: String(m.nickname || '').trim() || ('…' + uid.slice(-4)), text })
  }
  const out = []
  for (const [群, arr] of by) {
    const cnt = new Map()
    for (const x of arr) cnt.set(x.名, (cnt.get(x.名) || 0) + 1)
    const 谁 = [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([名, 条]) => ({ 名, 条 }))
    // 摘录跳过占位（[图片][表情]…），按长度取最像「聊话题」的两条
    const 聊了 = arr.map((x) => ({ ...x, text: x.text.replace(/\[[^\]]*\]|@\S+/g, '').trim() })).filter((x) => x.text.length >= 2)
      .sort((a, b) => b.text.length - a.text.length).slice(0, 2)
      .map((x) => x.text.replace(/\s+/g, ' ').slice(0, 24))
    out.push({ 群, 条数: arr.length, 谁, 聊了 })
  }
  return out.sort((a, b) => b.条数 - a.条数).slice(0, 3)
}

// 是主守卫：import 时不跑主流程（测别的模块用得着 汇总/取段内）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const sj = JSON.parse(readFileSync(MEM + '/睡眠.json', 'utf8'))
    const last = (sj.segments || []).filter((s) => s && s.start && s.end).at(-1)
    if (!last) { console.log('没有完整的一觉，不补课'); process.exit(0) }
    const 起 = 规(last.start), 止 = 规(last.end)
    const 小时 = (Date.parse(止.replace(' ', 'T') + '+08:00') - Date.parse(起.replace(' ', 'T') + '+08:00')) / 3600e3
    if (!(小时 >= 1)) { console.log('只睡了 ' + 小时.toFixed(2) + ' 小时，没错过什么，不补课'); process.exit(0) }
    let files = []
    try { files = readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')) } catch { files = [] }
    const msgs = []
    for (const f of files) {
      for (const line of readFileSync(LOG_DIR + '/' + f, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { msgs.push(JSON.parse(line)) } catch { continue }
      }
    }
    const 群 = 汇总(取段内(起, 止, msgs))
    if (!群.length) { console.log('睡着时群里没动静'); process.exit(0) }
    写档(MEM + '/醒来看到.json', {
      at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
      起, 止, 群, 已用: false,
    })
    console.log('补课记好了：' + 群.map((g) => g.群 + ' ' + g.条数 + ' 条').join('、'))
  } catch (e) { console.error('补课失败：' + (e && e.message || e)); process.exit(0) }
}
