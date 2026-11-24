#!/usr/bin/env node
// 待办.mjs —— 「需要主人处理」的事，读写只有这一处（2026-11-08 批次229）。
//
// 为什么单独成文件：
//   · 面板原来直接 readFileSync + JSON.parse，只能看不能改，主人在 UI 上点进去也没处下手。
//   · 以后「SESSDATA 快到期」「隧道断了」这类事要由脚本自动加，也得有统一写口，别各写各的字段。
//
// 结构：{ 说明, items:[{id,事项,加于,来源}], done:[{...同 items, 完成于, 谁}] }
// 路径可用 TODO_FILE 覆盖（测试用）；在函数里读 env，不在模块顶层求值 ——
// 否则测试进程先 import 再设 env 就失效（批次223 踩过）。

import { readFileSync } from 'node:fs'
import { 写档 } from './_底层.mjs'

export const 默认档 = '{{BOT_ROOT}}/待办.json'
const 档 = () => process.env.TODO_FILE || 默认档

const 上限 = { items: 40, done: 200 }

/** 只到日期，跟现有「加于」字段一致（面板里本来就这么写） */
function 今天(ts = Date.now()) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 10)
}

function 干净(s, n) {
  return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n)
}

function 清理闭环(闭环) {
  if (!闭环 || typeof 闭环 !== 'object') return undefined
  const 字段 = ['证据', '根因', '负责人', '授权', '下一步', '复验', '回滚点', '回执']
  const 值 = {}
  for (const 键 of 字段) {
    const 文本 = 干净(闭环[键], 240)
    if (文本) 值[键] = 文本
  }
  return Object.keys(值).length ? 值 : undefined
}

/** 读；文件不在/坏了都当空表 —— 待办读不出来不该把面板带崩 */
export function 读() {
  let d
  try {
    d = JSON.parse(readFileSync(档(), 'utf8'))
  } catch {
    d = {}
  }
  const items = Array.isArray(d.items) ? d.items.filter((x) => x && x.事项) : []
  const done = Array.isArray(d.done) ? d.done.filter((x) => x && x.事项) : []
  return {
    说明: String(d.说明 || '需要主人处理的事。面板只列这里，健康状态不占地方。'),
    items,
    done,
  }
}

export function 列() {
  return 读().items
}

/** 加一条。同一条事项已经在列表里就不重复加（返回 existing:true）。 */
export function 加({ 事项, 来源 = '主人', id = '', 闭环 } = {}) {
  const t = 干净(事项, 160)
  if (!t) return { ok: false, msg: '写点内容再贴' }
  const d = 读()
  const 已有 = d.items.find((x) => 干净(x.事项, 160) === t)
  if (已有) return { ok: true, existing: true, item: 已有, items: d.items }
  if (d.items.length >= 上限.items) return { ok: false, msg: '待办太多了（' + 上限.items + ' 条），先处理掉几条' }
  const item = {
    id: 干净(id, 40) || 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    事项: t,
    加于: 今天(),
    来源: 干净(来源, 40) || '主人',
  }
  const 维护 = 清理闭环(闭环)
  if (维护) item.闭环 = 维护
  d.items.push(item)
  写档(档(), d)
  return { ok: true, item, items: d.items }
}

/**
 * 机器自动维护的一条（2026-11-14 批次385）：
 *   会话体检 这类定时检查，同一个 id 只该有一条 —— 体积天天变，按文字去重会攒成一排。
 *   该在：没有就加，已有就原地更新「事项」（加于 保留第一次的时间，另记 更新于）
 *   不该在：条件不再成立（比如换完会话、降到门槛以下），自动挪进 done，谁=自动
 */
export function 同步({ id = '', 事项, 来源 = '自动', 该在 = true, 闭环 } = {}) {
  const k = 干净(id, 40)
  if (!k) return { ok: false, msg: '同步的条目要给 id' }
  const d = 读()
  const i = d.items.findIndex((x) => x.id === k)
  if (!该在) {
    if (i < 0) return { ok: true, existing: false }
    const [item] = d.items.splice(i, 1)
    item.完成于 = 今天()
    item.谁 = '自动'
    d.done.push(item)
    if (d.done.length > 上限.done) d.done = d.done.slice(-上限.done)
    写档(档(), d)
    return { ok: true, removed: true, item, items: d.items }
  }
  const t = 干净(事项, 160)
  if (!t) return { ok: false, msg: '写点内容再贴' }
  if (i >= 0) {
    const 维护 = 清理闭环(闭环)
    let 变 = false
    if (d.items[i].事项 !== t) {
      d.items[i].事项 = t
      d.items[i].更新于 = 今天()
      变 = true
    }
    if (维护 && JSON.stringify(d.items[i].闭环 || {}) !== JSON.stringify(维护)) {
      d.items[i].闭环 = 维护
      变 = true
    }
    if (变) 写档(档(), d)
    return { ok: true, existing: true, item: d.items[i], items: d.items }
  }
  return 加({ 事项: t, 来源, id: k, 闭环 })
}

/** 标为已处理：从 items 挪进 done（不删，留着能回溯、能撤回） */
export function 完成(id, 谁 = '主人') {
  const k = 干净(id, 40)
  if (!k) return { ok: false, msg: '没说要处理哪一条' }
  const d = 读()
  const i = d.items.findIndex((x) => x.id === k)
  if (i < 0) return { ok: false, msg: '这条已经不在列表里了' }
  const [item] = d.items.splice(i, 1)
  item.完成于 = 今天()
  item.谁 = 干净(谁, 12) || '主人'
  d.done.push(item)
  if (d.done.length > 上限.done) d.done = d.done.slice(-上限.done)
  写档(档(), d)
  return { ok: true, item, items: d.items, done: d.done }
}

/** 点错了撤回：从 done 挪回 items */
export function 撤回(id) {
  const k = 干净(id, 40)
  if (!k) return { ok: false, msg: '没说要撤回哪一条' }
  const d = 读()
  const i = d.done.findIndex((x) => x.id === k)
  if (i < 0) return { ok: false, msg: '已处理里没有这条' }
  const [item] = d.done.splice(i, 1)
  delete item.完成于
  delete item.谁
  d.items.push(item)
  写档(档(), d)
  return { ok: true, item, items: d.items, done: d.done }
}

/** 命令行：node 待办.mjs            看列表
 *          node 待办.mjs --加 "文本"  加一条
 *          node 待办.mjs --好 <id>    标为已处理
 *          node 待办.mjs --撤 <id>    撤回 */
const 是主 = process.argv[1] && process.argv[1].endsWith('待办.mjs')
if (是主) {
  const a = process.argv.slice(2)
  const 值 = (k, d = '') => {
    const i = a.indexOf(k)
    return i >= 0 ? (a[i + 1] ?? d) : d
  }
  let r = null
  // FIXED_ID 2026-11-14（批次419）：`加()` 一直支持 id，但 CLI 没暴露 ——
  // 于是「补丁巡检」这类定时检查只能拿到随机 id，挂了之后谁也销不掉
  // （实测待办里躺着一条「快照对不上」，而快照早就一致了）。
  if (a.includes('--加')) r = 加({ 事项: 值('--加'), 来源: 值('--来源', '命令行'), id: 值('--id', '') })
  else if (a.includes('--好')) r = 完成(值('--好'))
  else if (a.includes('--撤')) r = 撤回(值('--撤'))
  const d = 读()
  if (r && !r.ok) console.log('没成：' + r.msg)
  if (!d.items.length) console.log('没有需要主人处理的事。')
  else {
    console.log('需要主人处理 ' + d.items.length + ' 条：')
    d.items.forEach((x) => console.log('  [' + x.id + '] ' + x.事项 + '（' + (x.加于 || '?') + ' · ' + (x.来源 || '?') + '）'))
  }
  if (d.done.length) console.log('已处理 ' + d.done.length + ' 条，最近：' + d.done.slice(-1)[0].事项)
}
