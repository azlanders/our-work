#!/usr/bin/env node
import { 原子写 } from './_底层.mjs'
/**
 * 余额预警.mjs —— 上游余额低了就往面板待办里提一条。
 *
 * 为什么要有（批次489）：2026-11-14 首次去查上游真实账单，才发现
 * **中转只剩 9.20 元、按当天的花法只够 3 天**，而这件事没有任何人/任何代码盯着 ——
 * 只有面板「用量」页上能翻到，但没人会主动去翻。真断粮那天她会直接哑掉。
 *
 * 做法：读 {{DSH_ROOT}}/fish-api-keys.json，只在接口允许时段查余额：
 *   · portdan 这类中转 → `GET <base>/v1/usage` 的 `balance`
 *   · deepseek 官方 → `GET https://api.deepseek.com/user/balance` 的 `total_balance`
 * 低于阈值就往 `待办.json`（工作区顶层）写一条（同一条 12 小时内只写一次，别刷屏）。
 *
 * 阈值（元）：默认 中转 5 / 官方 1。可用环境变量覆盖：
 *   QQ_BALANCE_WARN=5  QQ_BALANCE_WARN_OFFICIAL=1
 *
 * 不改任何配置、不切换路由 —— 只提醒。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { 凭证可用 } from './接口时段.mjs'

const 候选档 = process.env.QQ_API_KEYS || '{{DSH_ROOT}}/fish-api-keys.json'
const 待办 = process.env.QQ_TODO || '{{BOT_ROOT}}/待办.json'
const 提醒档 = process.env.QQ_BALANCE_STATE || '{{BOT_ROOT}}/记忆/余额提醒.json'

const 阈值中转 = Number(process.env.QQ_BALANCE_WARN || 5)
const 阈值官方 = Number(process.env.QQ_BALANCE_WARN_OFFICIAL || 1)
const 最小间隔 = 12 * 3600e3 // 同一把钥匙 12 小时只提醒一次

function 读JSON(p, 兜底) {
  try {
    if (!existsSync(p)) return 兜底
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch { return 兜底 }
}

function 是官方(base) {
  return String(base || '') === '' || /api\.deepseek\.com/.test(String(base || ''))
}

async function 查余额(base, key) {
  const b = String(base || '').replace(/\/+$/, '')
  try {
    if (是官方(b)) {
      const r = await fetch('https://api.deepseek.com/user/balance', {
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(12000)
      })
      if (!r.ok) return { ok: false, 因: 'HTTP ' + r.status }
      const j = await r.json()
      const b0 = (j.balance_infos || [])[0] || {}
      const n = Number(b0.total_balance)
      return Number.isFinite(n) ? { ok: true, 余额: n, 币: b0.currency || 'CNY' } : { ok: false, 因: '没余额字段' }
    }
    const r = await fetch(b + '/v1/usage', {
      headers: { authorization: 'Bearer ' + key },
      signal: AbortSignal.timeout(12000)
    })
    if (!r.ok) return { ok: false, 因: 'HTTP ' + r.status }
    const j = await r.json()
    const n = typeof j.balance === 'number' ? j.balance : Number(j.remaining)
    return Number.isFinite(n) ? { ok: true, 余额: n, 币: 'CNY' } : { ok: false, 因: '没余额字段' }
  } catch (e) {
    return { ok: false, 因: String((e && e.message) || e).slice(0, 60) }
  }
}

const 列表 = 读JSON(候选档, [])
if (!Array.isArray(列表) || 列表.length === 0) {
  console.log('[余额] 候选档里没有钥匙，跳过')
  process.exit(0)
}

const 提醒 = 读JSON(提醒档, {}) || {}
const 现在 = Date.now()
const 要提 = []

for (const k of 列表) {
  const 名 = String(k.名 || k.name || '')
  const key = String(k.key || '')
  if (!key) continue
  if (!凭证可用(列表, key)) {
    console.log(`[余额] ${名}：不在允许时段，跳过`)
    continue
  }
  const 阈 = 是官方(k.base) ? 阈值官方 : 阈值中转
  const r = await 查余额(k.base, key)
  if (!r.ok) {
    console.log(`[余额] ${名}：查不到（${r.因}）`)
    continue
  }
  const 余额 = r.余额
  const 标记 = `${名}`
  console.log(`[余额] ${名}：${余额.toFixed(2)} ${r.币}（阈值 ${阈}）`)
  if (余额 > 阈) continue
  const 上次 = Number(提醒[标记] || 0)
  if (现在 - 上次 < 最小间隔) {
    console.log(`[余额] ${名} 低于阈值，但 ${Math.round((最小间隔 - (现在 - 上次)) / 3600e3)} 小时内已提醒过`)
    continue
  }
  提醒[标记] = 现在
  要提.push({ 名, 余额, 币: r.币, 阈 })
}

if (要提.length === 0) {
  console.log('[余额] 无新增余额提醒')
  process.exit(0)
}

// 写面板待办
const 档 = 读JSON(待办, { items: [] })
if (!Array.isArray(档.items)) 档.items = []
const ID = 'balance-warn'
档.items = 档.items.filter((x) => x && x.id !== ID)
const 明细 = 要提.map((x) => `${x.名} 只剩 ${x.余额.toFixed(2)} ${x.币}`).join('；')
档.items.push({
  id: ID,
  事项:
    `上游余额不足：${明细}。` +
    `充值入口在对应上游后台；中转（portdan 0.2 倍率）最便宜，优先充它。` +
    `**充完记得把这个待办标掉** —— 不标的话下次低于阈值时会重新提一条（12 小时一次）。` +
    `注意：0.2 和 0.4 两把中转是同一个账户的两条通道，余额共享，不是两笔钱。`,
  加于: new Date(现在 + 8 * 3600e3).toISOString().slice(0, 10),
  来源: '余额预警',
  更新于: new Date(现在 + 8 * 3600e3).toISOString().slice(0, 10)
})
try {
  原子写(待办, JSON.stringify(档, null, 1), 'utf8')
} catch (e) {
  console.error('[余额] 写待办失败：' + (e instanceof Error ? e.message : e))
  process.exit(1)
}
try {
  原子写(提醒档, JSON.stringify(提醒, null, 1), 'utf8')
} catch { /* 提醒档写不进去最多多提一次，不影响主流程 */ }

console.log('[余额] 已写面板待办：' + 明细)
