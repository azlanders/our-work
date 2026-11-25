#!/usr/bin/env node
import { 原子写 } from './_底层.mjs'
/**
 * 探测上游.mjs —— 每 10 分钟摸一次中转：让她调一个假工具，看 tool_use 有没有回来。
 *
 * 为什么要这个：2026-11-13 20:14 / 20:33 她连着两轮只说英文不做事，
 * 根因是 portdan 把 tool_use 转成了 text。这种坏法不报错、HTTP 还是 200，
 * 只有真发一个带工具的请求、看响应里有没有 tool_use 块才看得见。
 *
 * 连续两次没有 tool_use 就自动切官方（只在第一次切，不来回跳）。
 */
import fs from 'node:fs'
import os from 'node:os'
// ROUTE_KEEP 2026-11-17（批次668）：置顶逻辑抽在 路由.mjs（纯函数、可单测），
// 别在探测脚本里再写一份「怎么找官方那条」。
import { 置顶官方 } from './路由.mjs'

// PROBE_GENERIC 2026-11-24：原来写死某个实例的网关和 DSH 目录，换实例就探错地方。
// 现在按实例变量走；没有 fish-upstream.json 的实例跳过「自动切官方」。
const DSH = process.env.DSH_ROOT || os.homedir() + '/.dsh'
const 转 = String(process.env.GATEWAY_URL || 'http://127.0.0.1:39301').replace(/\/+$/, '') + '/v1/messages'
const 状态档 = DSH + '/upstream-probe.json'
const 上游档 = DSH + '/fish-upstream.json'
const 候选档 = DSH + '/fish-api-keys.json'
const 阈值 = 2

const 读 = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const 写 = (p, o) => 原子写(p, JSON.stringify(o, null, 2) + '\n', 'utf8')
const 京 = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

const 体 = {
  model: 'deepseek-flash',
  // PROBE_BUDGET 2026-11-24：200 太小 —— Gemini 4 是 thinking 模型，200 预算被思考吃光，
  // 返回 content=[]、没有 tool_use，于是探测连报 72 次假失败（面板一直红着）。
  // 实测同样请求 2000 预算能稳定拿到 tool_use。
  max_tokens: 2000,
  tools: [{ name: 'probe', description: '连通性探测，没有副作用', input_schema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } }],
  messages: [{ role: 'user', content: '调用 probe 工具，x 填 ok。不要用文字回答。' }],
}

const 旧 = 读(状态档, { 连续失败: 0, 已切官方: false })
const 新 = { at: 京(), ok: false, 块: [], 连续失败: Number(旧.连续失败) || 0, 已切官方: !!旧.已切官方 }

// 连打 3 次：portdan 可能挂在多个后端上，有的正常有的吞 tool_use，
// 只打一次会碰上哪台算哪台 —— 2026-11-13 就出现过 21:05 假、21:12 真。
let 过 = 0
const 明细 = []
// PROBE_PARALLEL 2026-11-24：串行 3 次 × 15 秒会超过心跳 25 秒预算，被调度器砍掉时
// 状态档一个字都写不进去（上一次就是 7 秒 × 3 串行，全超时）。并行发，总耗时≈单次。
// PROBE_ONCE 2026-11-24：带 tools 的 Gemini 请求实测 30 秒上下，3 次串/并行都吃满心跳预算。
// 这把上游只有一个后端，采 1 次就够；连续失败阈值本来按「每次探测 +1」算，不受影响。
const 次数 = 1
const 各次 = await Promise.all(Array.from({ length: 次数 }, () => (async () => {
  try {
    const r = await fetch(转, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' },
      body: JSON.stringify(体),
      // PROBE_BUDGET 2026-11-24：这里原来 45000ms，而心跳单任务预算只有 25000ms
      // （心跳.mjs 的 `超时毫秒() || 25000`）。45 秒的单次探测一定会被调度器砍在半路
      // → 状态档一个字都写不进去 → 「连续失败 +1 / 切官方」的兜底永远不触发。
      // 实测单次成功 0.6~1.0 秒，30 秒以上基本就是上游真坏了，没必要等。
      // 取 8000：留足正常抖动，又保证整个探针能在 25 秒预算内写完状态档。
      signal: AbortSignal.timeout(8000),
    })
    const t = await r.text()
    let d = null
    try { d = JSON.parse(t) } catch { return { 块: null, 说明: 'HTTP' + r.status + '非JSON' } }
    if (d.error) return { 块: null, 说明: 'HTTP' + r.status }
    const 块 = (d.content || []).map((c) => c && c.type)
    return { 块, 停因: d.stop_reason }
  } catch (e) {
    return { 块: null, 说明: '连不上' }
  }
})()))
for (const x of 各次) {
  if (x.块) {
    新.块 = x.块
    新.停因 = x.停因
    if (x.块.includes('tool_use')) 过 += 1
    else 明细.push(JSON.stringify(x.块))
  } else {
    明细.push(x.说明 || '连不上')
  }
}
新.ok = 过 === 次数
新.通过 = 过 + '/' + 次数
if (!新.ok) 新.说明 = 次数 + ' 次里只有 ' + 过 + ' 次拿到 tool_use：' + 明细.slice(0, 次数).join(' / ')

新.连续失败 = 新.ok ? 0 : (新.连续失败 + 1)

// 人手动切回便宜的上游时，把这个标记放掉 —— 否则自动切一辈子只能用一次
try {
  const 当前 = 读(上游档, {}) || {}
  if (!/deepseek\.com/.test(String(当前.base || ''))) 新.已切官方 = false
} catch { /* 读不到就不动标记 */ }

if (!新.ok && 新.连续失败 >= 阈值 && !新.已切官方 && fs.existsSync(上游档)) {
  try {
    const j = 读(上游档, null)
    const f = (j && j.fallback) || {}
    if (j && !/portdan/.test(String(j.base))) {
      新.说明 = (新.说明 || '') + '（本来就是官方，不再切）'
    } else if (j && f.key) {
      j.名 = 'deepseek 官方（自动切的 ' + 新.at + '）'
      j.base = f.base
      j.key = f.key
      j.map = { 'deepseek-flash': 'deepseek-reasoner', 'deepseek-v4-pro': 'deepseek-reasoner' }
      // ROUTE_KEEP 2026-11-17（批次668）：**这里原来写的是 `j.路由 = []`，是这次事故的扳机。**
      // 清空路由在中转侧等于「退回老行为 = 只试当前这把 + fallback」；自动切官方之后
      // 当前和兜底是同一把官方 key，按 `base|key` 去重后整条链只剩 1 项 ——
      // 面板「换的顺序」显示 1 项、其余密钥看着像丢了，但候选档一直好好的。
      // 现在改成：找到官方那把候选，置顶，其余顺序原样保留。切上游只改「先试谁」，
      // 绝不删成员。
      const { 路由: 新路, 找到 } = 置顶官方(j.路由, 读(候选档, []), f.key)
      j.路由 = 新路
      if (!找到 && Array.isArray(新路) && 新路.length > 0) {
        // 有旧路由但候选档里找不到官方 id：保留旧链，只是顶层指到官方。
        // 宁可切换对链不生效，也不能把主人排好的顺序弄丢。
        新.说明 = (新.说明 || '') + '（候选档里没有官方 key，保留原路由顺序）'
      } else if (!找到) {
        新.说明 = (新.说明 || '') + '（候选档里没有官方 key，路由保持原样）'
      }
      写(上游档, j)
      新.已切官方 = true
      新.说明 = (新.说明 || '') + ' → 已自动切到官方'
    } else {
      新.说明 = (新.说明 || '') + '（兜底里没有官方 key，切不了）'
    }
  } catch (e) {
    新.说明 = (新.说明 || '') + '（切官方失败：' + String((e && e.message) || e).slice(0, 80) + '）'
  }
}

写(状态档, 新)
console.log(JSON.stringify(新))
