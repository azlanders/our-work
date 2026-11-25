import { 原子写 } from './_底层.mjs'
// 读取 Gemini Web 账号的 5 小时 / 7 天额度窗口，给 WebUI 用量页用。
// 思路和 Magpie 的 usage.mjs 一致：从 gemini-web2api 的 SQLite 里拿活 cookie，
// 走后端同一个代理出口，请求 gemini.google.com 的 UsagePageQuery。
//
// 必须走同一个出口：Google 会按 IP 记账，换个 IP 读会让会话看起来在两地。
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const DB = process.env.GEMINI_WEB2API_DB || '/opt/gemini-web2api/data/gemini.db'
// PROXY_AUTODETECT 2026-11-24：默认值原来写死 7891，而那个端口只在装有 gemini-web2api
// 的主机上存在；只有 mihomo（7890）的主机跑这个脚本会静默失败。
// 现在按顺序探：显式 env > 7891（web2api 专用出口）> 7890（mihomo 通用出口）。
// 探活看 /proc/net/tcp 的 LISTEN，零开销、同步。
function 端口在听(p) {
  const hex = p.toString(16).toUpperCase().padStart(4, '0')
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
const PROXY = (() => {
  if (process.env.GEMINI_WEB2API_PROXY) return process.env.GEMINI_WEB2API_PROXY
  if (端口在听(7891)) return 'http://127.0.0.1:7891'
  if (端口在听(7890)) return 'http://127.0.0.1:7890'
  return 'http://127.0.0.1:7891'   // 都没有就保持旧默认，让报错指向原处
})()
const OUT_DIR = process.env.QUOTA_OUT_DIR || process.env.DSH_HOME || '{{DSH_ROOT}}'
const CACHE = join(OUT_DIR, 'quota-cache.json')
const HISTORY = join(OUT_DIR, 'quota-history.json')
const FRESH_MS = 30 * 1000
const RETRY_MS = 10 * 60 * 1000

const USAGE_QUERY = '2/dWbCvkVB0X16r9NPnxifeOAAqdCqMf0xeWvau9yPy7g='
const USAGE_VARIABLES = {
  g1Request: {
    entrypoints: [
      'GEMINI_USAGE_SETTINGS_UPGRADE_BANNER',
      'GEMINI_USAGE_SETTINGS_AI_CREDITS_UPSELL_CARD',
      'GEMINI_USAGE_SETTINGS_UPGRADE_AND_CREDITS_BANNER',
    ],
  },
  workspaceRequest: {
    recommendationsForSurfaceRequests: [{
      recommendationSurface: { rpOnramp: 'GEMINI_CHAT_USAGE_LIMITS_UPSELL', version: '1' },
      maxRecommendationCount: 1,
    }],
  },
}
const POOLS = [
  { type: 'GXU_FIVE_HOURLY', name: '5 小时', span: 5 * 3600 },
  { type: 'GXU_WEEKLY', name: '7 天', span: 7 * 24 * 3600 },
]

function readCache() {
  try { return JSON.parse(readFileSync(CACHE, 'utf8')) } catch { return null }
}

function writeCache(v) {
  try {
    mkdirSync(dirname(CACHE), { recursive: true })
    原子写(CACHE, JSON.stringify(v))
  } catch { /* 写不进去就不缓存，下次重新读 */ }
}

function pickAccount() {
  const db = new DatabaseSync(DB, { readOnly: true })
  try {
    const rows = db.prepare(
      "SELECT id, label, cookie, authuser, proxy_id FROM accounts WHERE status = 'enabled' ORDER BY id"
    ).all()
    if (!rows.length) throw new Error('gemini-web2api 里没有可用账号')
    const row = rows[0]
    let proxy = PROXY
    try {
      if (row.proxy_id != null) {
        const p = db.prepare('SELECT url, enabled FROM proxies WHERE id = ?').get(row.proxy_id)
        if (p && p.enabled === 1 && p.url) proxy = p.url
      }
    } catch { /* 没有代理表就用默认出口 */ }
    return { id: row.id, cookie: String(row.cookie || ''), authuser: Number(row.authuser || 0), proxy }
  } finally {
    db.close()
  }
}

function fetchUsage(account) {
  if (!account.cookie) throw new Error('账号没有 cookie')
  const base = account.authuser > 0 ? `https://gemini.google.com/u/${account.authuser}` : 'https://gemini.google.com'
  const vars = encodeURIComponent(JSON.stringify(USAGE_VARIABLES))
  const url = `${base}/_/BardChatUi/graphql/schemas/GEMINI_WEB_GRAPHQL/executeQuery`
    + `?query_signature=${encodeURIComponent(USAGE_QUERY)}&variables=${vars}`
  let out
  try {
    out = execFileSync('curl', [
      '-s', '--max-time', '25',
      '-x', account.proxy,
      url,
      '-H', 'Content-Type: application/x-www-form-urlencoded;charset=UTF-8',
      '-H', 'Accept: application/json',
      '-H', 'Origin: https://gemini.google.com',
      '-H', `Referer: ${base}/usage`,
      '-H', 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      '-H', 'Sec-Fetch-Dest: empty',
      '-H', 'Sec-Fetch-Mode: cors',
      '-H', 'Sec-Fetch-Site: same-origin',
      '-H', `Cookie: ${account.cookie}`,
    ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    throw new Error(`读额度失败：${error?.message || error}`)
  }
  const start = out.indexOf('[')
  if (start < 0) throw new Error('Gemini 返回了无法识别的额度数据')
  const payloads = JSON.parse(out.slice(start))
  for (const p of Array.isArray(payloads) ? payloads : []) {
    const info = p?.data?.viewer?.rpcs?.getUsageInfo
    if (info) return { tier: info.subscriptionTier || '', pools: Array.isArray(info.pools) ? info.pools : [] }
    if (p?.errors?.length) throw new Error(`Gemini 拒绝查询：${p.errors[0]?.message || 'unknown'}`)
  }
  throw new Error('Gemini 的回复里没有额度数据')
}

function windowsOf(pools, now) {
  const out = []
  for (const { type, name, span } of POOLS) {
    const p = pools.find((x) => x?.poolType === type)
    if (typeof p?.percentageUsed !== 'number' || p.percentageUsed < 0) continue
    const used = Math.min(100, Math.round(p.percentageUsed * 100))
    const resetsAt = Date.parse(p.gxu?.windowRefreshesAt ?? '')
    const w = { name, span, used, left: 100 - used, resetsAt: Number.isFinite(resetsAt) ? new Date(resetsAt).toISOString() : null }
    if (w.resetsAt) {
      // 配速：已用比例减去时间进度，正数表示烧得比线性快
      const start = resetsAt - span * 1000
      const progress = Math.min(1, Math.max(0, (now - start) / (span * 1000)))
      w.pace = Math.round(used - progress * 100)
    }
    out.push(w)
  }
  return out
}

function appendHistory(windows, now) {
  try {
    let hist = []
    try { hist = JSON.parse(readFileSync(HISTORY, 'utf8')) } catch { hist = [] }
    const last = hist[hist.length - 1]
    if (!last || now - last.at >= 10 * 60 * 1000) {
      hist.push({ at: now, windows: windows.map((w) => ({ name: w.name, used: w.used })) })
      hist = hist.filter((h) => now - h.at < 7 * 24 * 3600 * 1000)
      mkdirSync(dirname(HISTORY), { recursive: true })
      原子写(HISTORY, JSON.stringify(hist))
    }
  } catch { /* 历史只是画图，写不了不影响主结果 */ }
}

export function readQuota({ force = false } = {}) {
  const now = Date.now()
  const cached = readCache()
  if (!force && cached && now - Number(cached.at || 0) < FRESH_MS) return cached
  if (!force && cached && cached.ok === false && now - Number(cached.at || 0) < RETRY_MS) return cached
  try {
    const windows = windowsOf(fetchUsage(pickAccount()).pools, now)
    const result = { ok: true, at: now, windows }
    writeCache(result)
    appendHistory(windows, now)
    return result
  } catch (error) {
    const result = { ok: false, at: now, error: error?.message || String(error), windows: [] }
    writeCache(result)
    return result
  }
}

export function readHistory() {
  try { return JSON.parse(readFileSync(HISTORY, 'utf8')) } catch { return [] }
}

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const r = readQuota({ force: process.argv.includes('--force') })
  console.log(JSON.stringify({ ...r, history: process.argv.includes('--history') ? readHistory() : undefined }, null, 2))
}
