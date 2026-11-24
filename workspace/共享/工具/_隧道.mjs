// _隧道.mjs —— 两条出口：VPS 本机 mihomo(:7890) 与 旧手机家宽(:1080)
//
// 批次217（2026-11-07）曾把「本机 Windows 贤者云」经 ssh -R 借给 VPS（17891）；
// 批次218 主人拍板「直接让 VPS 用隧道，别接我本机」——VPS 自己跑 mihomo 订阅（systemd:
// mihomo.service，/opt/mihomo，mixed-port 127.0.0.1:7890，watchdog 每 5 分钟探活），
// 不再依赖任何人的电脑。17891 那条已撤（run.cmd / 启动项都删了）。
//
// 为什么还是要两条：
//   - **bilibili 只能用家宽**：机房 IP 抓 view-api 一律 412（本机 HK 出口实测也是 412）。
//     旧手机 Termux `autossh -R 1080` 把家宽借给 VPS，B 站走它（view-api 200 / 视频页 301）。
//   - **墙外站走 VPS 本机 mihomo**：pixiv / YouTube / Google / t.me / github.com 主站在 VPS 上
//     直连全 000，走 7890 全 200；它是常驻服务，开机自启，跟电脑开不开机无关。
//
// 用法：
//   import { 取JSON } from './_隧道.mjs'
//   const j = await 取JSON(url, { 'User-Agent': UA })            // 按域名自动选出口
//   const j = await 取JSON(url, {}, { 出口: '家宽' })              // 强制走某条
//
// 规则：**默认直连**；只有直连抛错/非 2xx（含 412/403）才走出口。墙外那一路直连只等 6 秒。
// 出口没开（端口不通）就原样抛直连的错，行为与没有隧道时一致。
import { execFileSync } from 'node:child_process'
import { connect } from 'node:net'
import { readFileSync as __读文件 } from 'node:fs'

// PORT_ENV 2026-11-24：出口端口不再写死 —— 两台机器的出口根本不是一回事：
//   · {{ALT_BOT_DISPLAY}} VPS：7890=mihomo（机场订阅）、1080=旧手机 autossh 借的家宽
//   · {{BOT_DISPLAY}}（西安机房）：7890=mihomo（同款订阅）、**没有 1080**（旧手机只连 VPS）
// 写死的结果是「一台能用、另一台每次都要白等一次注定失败的探活」。
// 现在每台机器在环境里声明自己有什么出口；没声明的端口 = 该出口不存在。
// 显式设 0 = 本机确认没有这条出口（不是「没配」）。
const __envPort = (名, 默认) => {
  const raw = process.env[名]
  if (raw === undefined || raw === '') return 默认
  const v = Number(raw)
  if (!Number.isFinite(v) || v < 0) return 默认
  return v
}
export const 墙外端口 = __envPort('QQ_TUNNEL_WALL_PORT', 7890)  // 机场订阅（mihomo）
export const 家宽端口 = __envPort('QQ_TUNNEL_HOME_PORT', 1080)

/**
 * 本机这个端口到底有没有人在听（同步、零开销）。
 *
 * HOME_AUTODETECT 2026-11-24：家宽（旧手机 autossh -R）**只连一台主机**，
 * 另一台机器上根本没有 1080 —— 原来写死 1080 当默认值，那台机器上
 * B 站系域名会被判给家宽 → 探活必然失败 → 直连明明能用却被拖成报错。
 *
 * 靠环境变量声明太脆（要改 systemd、要重启、cron 还不读 /etc/environment），
 * 所以直接读 /proc/net/tcp + /proc/net/tcp6 找 LISTEN —— 纯同步、微秒级，
 * 哪台机器有就自动有，没有就自动没有，不需要任何配置。
 */
function 端口在听(port) {
  if (!port || port <= 0) return false
  const hex = port.toString(16).toUpperCase().padStart(4, '0')
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let txt
    try { txt = String(__读文件(f, 'utf8')) } catch { continue }
    for (const line of txt.split('\n').slice(1)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 4) continue
      const local = cols[1] || ''
      const st = cols[3]
      if (!local.endsWith(':' + hex)) continue
      if (st === '0A') return true   // 0A = LISTEN
    }
  }
  return false
}

// 家宽是「有没有」而不是「默认走哪」：本机没这条出口，选出口时直接跳过。
export const 有家宽 = 家宽端口 > 0 && 端口在听(家宽端口)

// 直连不通、必须走墙外出口的域名（2026-11-07 逐站实测，见 变更.md 批次217/218）
const 墙外域名 = /(^|\.)(pixiv\.net|pximg\.net|fanbox\.cc|youtube\.com|youtu\.be|ytimg\.com|googlevideo\.com|google\.com|gstatic\.com|googleapis\.com|t\.me|telegram\.org|x\.com|twitter\.com|twimg\.com|github\.com|githubusercontent\.com|gh-proxy\.com)$/i
// BILI_ONLY 2026-11-24：家宽（旧手机 autossh 借的家宽）抖一下就断、而且随时可能不下线。
// 原来 选出口() 把所有非墙外域名都判给家宽 —— 天气/网盘/贴吧这些纯国内站也跟着走，
// 家宽一掉，它们每次都要先等直连失败、再等 300ms 探活、再抛错。
// 现在家宽只服务确实需要它的 B 站系域名，其余一律「直连优先」。
const 家宽域名 = /(^|\.)(bilibili\.com|b23\.tv|hdslb\.com|bilivideo\.com|bilivideo\.cn)$/i

export function 域名(url) {
  try { return new URL(String(url)).hostname.toLowerCase() } catch { return '' }
}

/**
 * 按域名挑出口：墙外站走 7890，B 站系走家宽（本机有的话），其余直连优先。
 *
 * HOME_ABSENT 2026-11-24：本机没有家宽出口时，B 站系也退回直连 ——
 * {{BOT_DISPLAY}}那台直连 B 站是 200，比「拿一个不存在的 1080 去探活再失败」好。
 */
export function 选出口(url) {
  const d = 域名(url)
  if (墙外域名.test(d)) return '墙外'
  if (家宽域名.test(d)) return 有家宽 ? '家宽' : '直连'
  return '直连'
}

/** 出口对应的端口。家宽不存在时返回 0（调用方应先查 有家宽）。 */
export function 端口(出口) {
  return 出口 === '墙外' ? 墙外端口 : 家宽端口
}

/** 出口对应的 curl 代理参数。 */
export function 代理参数(出口, 端口号) {
  const p = 端口号 || 端口(出口)
  return 出口 === '墙外'
    ? ['--proxy', 'http://127.0.0.1:' + p]
    : ['--socks5-hostname', '127.0.0.1:' + p]
}

/**
 * 出口是否**真能出网**（不只是端口在听）。
 *
 * ALIVE_PROBE 2026-11-24：原来只做 TCP connect —— 2026-11-24 实测 7890
 * 「端口在听、控制面 alive:true、节点也选中了」，但数据面 100% SSL EOF。
 * TCP 探活一路通过，进去 curl 才失败：比端口不通更难查，而且每个墙外请求
 * 都要白等 15~25 秒。改成探一次真实的 generate_204，探活结果缓存 60 秒。
 */
const __探活缓存 = new Map()
export function 出口通(出口, 端口号) {
  const p = 端口号 || 端口(出口)
  if (!p || p <= 0) return false   // 这条出口本机不存在
  const key = 出口 + ':' + p
  const hit = __探活缓存.get(key)
  if (hit && Date.now() - hit.at < 60e3) return hit.ok
  let ok = false
  try {
    const args = ['-sS', '-m', '6', '-o', '/dev/null', '-w', '%{http_code}', ...代理参数(出口, p),
      'http://www.gstatic.com/generate_204']
    const code = String(execFileSync('curl', args, { encoding: 'utf8', timeout: 8000 })).trim()
    ok = code === '204' || code === '200'
  } catch { ok = false }
  __探活缓存.set(key, { at: Date.now(), ok })
  return ok
}

/** 端口是否在监听（300ms 超时，连不上就当没有）。 */
export function 隧道可用(端口号 = 家宽端口) {
  return new Promise((resolve) => {
    let done = false
    const sock = connect({ host: '127.0.0.1', port: 端口号 })
    const end = (v) => { if (!done) { done = true; try { sock.destroy() } catch { /* ignore */ } resolve(v) } }
    sock.setTimeout(300, () => end(false))
    sock.once('connect', () => end(true))
    sock.once('error', () => end(false))
  })
}

/** 同步睡一会儿（不依赖平台命令）。 */
function 睡(毫秒) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 毫秒)
}

/**
 * 用 curl 走指定出口取 JSON（Node 的 fetch 不认 SOCKS，借 curl）。
 * 带 HTTP 状态：4xx 直接抛「HTTP 412」这类错（B 站风控就是 412 带一页 HTML，
 * 以前只报 JSON 解析错，排查时看不出是风控），5xx / 网络错才重试一次。
 */
export function curlJSON(url, headers = {}, opts = {}) {
  const 出口 = opts.出口 || 选出口(url)
  const 超时 = opts.超时 || 25
  const 次数 = Math.max(1, opts.重试 ?? 3)
  const args = ['-sS', '-m', String(超时), ...代理参数(出口, opts.端口)]
  for (const [k, v] of Object.entries(headers)) args.push('-H', k + ': ' + v)
  args.push('-w', '\n__HTTP__%{http_code}', String(url))
  let 最后错 = null
  for (let i = 0; i < 次数; i++) {
    try {
      const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      const 切点 = out.lastIndexOf('__HTTP__')
      const 状态 = Number(out.slice(切点 + 8).trim())
      const 正文 = 切点 >= 0 ? out.slice(0, 切点) : out
      if (状态 >= 400) {
        const e = new Error('HTTP ' + 状态)
        e.status = 状态
        e.body = 正文.slice(0, 300)
        throw e
      }
      if (!正文.trim()) throw new Error('空响应')
      return JSON.parse(正文)
    } catch (e) {
      最后错 = e
      if (e instanceof SyntaxError) throw e        // JSON 解析错重试也没用
      if (e.status && e.status < 500) throw e      // 4xx（含 412 风控）重试也一样
      if (i + 1 < 次数) 睡(400 * (i + 1))
    }
  }
  throw 最后错
}

/**
 * 取 JSON：先直连，失败（网络错 / 非 2xx）再走出口重试。
 * 返回解析后的对象；两条路都失败时抛最后一次的错（附 directError 便于排查）。
 */
export async function 取JSON(url, headers = {}, opts = {}) {
  const 出口 = opts.出口 || 选出口(url)
  let 直连错 = null
  try {
    const init = { headers }
    if (出口 === '墙外') init.signal = AbortSignal.timeout(6000)
    const r = await fetch(url, init)
    const text = await r.text()
    if (!r.ok) {
      const e = new Error('HTTP ' + r.status)
      e.status = r.status
      e.body = text.slice(0, 300)
      throw e
    }
    return JSON.parse(text)
  } catch (e) {
    直连错 = e
  }
  // 直连也失败了：如果是「直连优先」的域名，先试家宽（国内站点家宽通常更快）；
  // 墙外站就直接走它那条。两条都要先通过「真能出网」的探活。
  if (出口 === '直连') {
    if (有家宽 && await 隧道可用(家宽端口) && 出口通('家宽', 家宽端口)) {
      try { return curlJSON(url, headers, { 出口: '家宽', 端口: 家宽端口, 超时: opts.超时 }) } catch { /* 家宽也不行就抛直连错 */ }
    }
    throw 直连错
  }
  const p = opts.端口 || 端口(出口)
  if (!(await 隧道可用(p)) || !出口通(出口, p)) throw 直连错
  try {
    return curlJSON(url, headers, { 出口, 端口: p, 超时: opts.超时 })
  } catch (e) {
    e.directError = 直连错?.message || String(直连错)
    throw e
  }
}
