#!/usr/bin/env node
// 房间服务 v4 —— 加了「放置/收回」接口，家当位置存进资产（2026-11-02）
//
// 为什么改：
//   · 主人要「放置模式：能转向、能放、能取消、能收回，没放下时半透明跟着走」。
//     位置数据就得真存起来，不能只存在浏览器里——所以 资产.json 的「家」从
//     ["台灯","书架"] 升级成 [{n:"台灯", x:2.0, z:-3.2, rot:0}]，同时兼容老格式。
//   · 接口只给主人（面板那张 cookie 的 role），访客只能看。
import { 写档 } from './_底层.mjs'
import { 睡着 } from './睡态.mjs'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHmac, timingSafeEqual } from 'node:crypto'

const PORT = Number(process.env.ROOM_PORT || 8790)
const base = '{{BOT_ROOT}}/记忆'
const tools = '{{BOT_ROOT}}/共享/工具'
const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)
// FURNITURE_MERGE 2026-11-03：与面板共用一张家具表
const 家具表 = (() => { try { return JSON.parse(readFileSync(tools + '/家具表.json', 'utf8')) } catch { return {} } })()
const COMFORT = Object.fromEntries(Object.entries(家具表).map(([k, v]) => [k, Number(v.舒适 || 0)]))

const KEY = load(tools + '/面板密钥.json', null)
const verify = (token) => {
  if (!KEY || !token || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const want = createHmac('sha256', KEY.secret).update(body).digest('base64url')
  try {
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    return p.exp > Date.now() ? p : null
  } catch { return null }
}
const cookieOf = (req) => {
  const m = String(req.headers.cookie || '').match(/fish_session=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

// 默认摆位（老数据没有坐标时用）
const DEFAULT_POS = {
  台灯: [2.0, -3.2], 水杯: [1.5, -3.15], 鱼缸: [-2.9, -3.2], 书架: [3.1, 1.2],
  软垫: [-1.4, 2.4], 小地毯: [0.4, 1.0], 窗帘: [0, 3.9], 音箱: [1.9, -3.35],
}
const normalize = (home) => (home || []).map((it) => {
  if (typeof it === 'string') { const d = DEFAULT_POS[it] || [0, 0]; return { n: it, x: d[0], z: d[1], rot: 0 } }
  return { n: it.n, x: Number(it.x || 0), y: Number(it.y || 0), z: Number(it.z || 0), rot: Number(it.rot || 0) }
})

// BUILTIN_SEED：房间自带家具也进家具栏，位置可挪（挪了存 资产.自带）
const BUILTIN_DEFAULT = [
  { n: '床', x: -2.7, y: 0, z: 1.2, rot: 0 },
  { n: '书桌', x: 2.1, y: 0, z: -3.15, rot: 0 },
  { n: '书桌', x: -2.7, y: 0, z: -3.15, rot: 0 },
]
function ensureBuiltin(a) {
  if (!Array.isArray(a['自带']) || a['自带'].length === 0) {
    a['自带'] = BUILTIN_DEFAULT.map((x) => ({ ...x }))
    save(base + '/资产.json', a)
  }
  return a['自带']
}

const readBody = (req, cb) => { let b = ''; req.on('data', (c) => { b += c }); req.on('end', () => { try { cb(JSON.parse(b || '{}')) } catch { cb({}) } }) }

const server = createServer((req, res) => {
  const url = req.url.split('?')[0]
  const sendJson = (o, code) => { res.writeHead(code || 200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)) }

  // STATIC_THREE 2026-11-02：three 模块版 + GLTFLoader + 模型，都给静态吐出去
  if (url.startsWith('/three/') || url.startsWith('/models/')) {
    const rel = url.startsWith('/three/') ? tools + '/three/' + url.slice(7) : tools + '/models/' + url.slice(8)
    if (!existsSync(rel)) { res.writeHead(404); return res.end('没有这个文件') }
    const type = rel.endsWith('.js') ? 'application/javascript; charset=utf-8'
      : rel.endsWith('.glb') ? 'model/gltf-binary'
      : 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'max-age=3600' })
    return res.end(readFileSync(rel))
  }

  if (url === '/three.min.js') {
    const p = tools + '/three/three.min.js'
    if (!existsSync(p)) { res.writeHead(404); return res.end('three.min.js 不在') }
    res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'max-age=86400' })
    return res.end(readFileSync(p))
  }

  const sess = verify(cookieOf(req))
  if (!sess) {
    const host = String(req.headers.host || '').replace(/:\d+$/, '')
    res.writeHead(302, { location: 'http://' + host + ':8787/' })
    return res.end()
  }

  if (url === '/room-state') {
    const a = load(base + '/资产.json', { 家: [], 包: [] })
    const home = normalize(a.家)
    const builtin = ensureBuiltin(a)
    const comfort = home.reduce((s, it) => s + Number(COMFORT[it.n] || 0), 0)
    const st = load(base + '/状态.json', {})
    const aut = load(base + '/自主.json', {})
    // 批次164：原来只看 睡眠.json.sleeping —— endSleep 写完睡眠档但 writeFlag 挂了时，
    // 它和 缺口/自主行动 会给出相反的答案（一个说在睡、一个说醒着）。判据收在 睡态.mjs。
    const __睡 = 睡着(base)
    return sendJson({
      role: sess.role,
      home,
      builtin,
      bag: a.包 || [],
      comfort,
      // ROOM_SLEEP_SYNC 2026-11-03：睡着时别让人在 3D 房间里看到她「在打工点摸鱼」
      place: __睡 ? '床上' : (a.位置 || '家'),
      activity: __睡 ? '睡着' : (aut.state || '待命'),
      energy: st.energy ?? null,
      strain: st['熬夜'] || null,
      patience: st['耐心'] || null,
      mood: st?.mood?.label || '',
    })
  }

  // 放下 / 移动一件家具
  if (url === '/room-place' && req.method === 'POST') {
    if (sess.role !== 'owner') return sendJson({ ok: false, msg: '只有主人能摆' })
    return readBody(req, (j) => {
      const a = load(base + '/资产.json', { 家: [], 包: [] })
      const name = String(j.item || '')
      // 自带家具：只更新位置，不进包也不进家
      if (j.builtin) {
        const b = ensureBuiltin(a)
        const bi = b.findIndex((x) => x.n === name)
        if (bi >= 0) b[bi] = { n: name, x: Number(j.x || 0), y: Number(j.y || 0), z: Number(j.z || 0), rot: Number(j.rot || 0) }
        save(base + '/资产.json', a)
        return sendJson({ ok: true, builtin: b })
      }
      const home = normalize(a.家)
      const item = { n: name, x: Number(j.x || 0), y: Number(j.y || 0), z: Number(j.z || 0), rot: Number(j.rot || 0) }
      const i = home.findIndex((it) => it.n === name)
      if (i >= 0) home[i] = item
      else {
        const bi = (a.包 || []).indexOf(name)
        if (bi < 0) return sendJson({ ok: false, msg: '包里没有这件' })
        a.包.splice(bi, 1)
        home.push(item)
      }
      a.家 = home
      save(base + '/资产.json', a)
      return sendJson({ ok: true, home })
    })
  }

  // 收回：从家里拿回包里
  if (url === '/room-remove' && req.method === 'POST') {
    if (sess.role !== 'owner') return sendJson({ ok: false, msg: '只有主人能收' })
    return readBody(req, (j) => {
      const a = load(base + '/资产.json', { 家: [], 包: [] })
      const home = normalize(a.家)
      const name = String(j.item || '')
      // 2026-11-02 自带家具也能收回：从 自带 挪进包，之后可以再摆出来
      const bi = (a['自带'] || []).findIndex((x) => x.n === name)
      if (bi >= 0) {
        a['自带'].splice(bi, 1)
        a.包 = [...(a.包 || []), name]
        save(base + '/资产.json', a)
        return sendJson({ ok: true, builtin: a['自带'] })
      }
      const i = home.findIndex((it) => it.n === name)
      if (i < 0) return sendJson({ ok: false, msg: '家里没这件' })
      home.splice(i, 1)
      a.家 = home
      a.包 = [...(a.包 || []), name]
      save(base + '/资产.json', a)
      return sendJson({ ok: true, home })
    })
  }

  if (url === '/room-say' && req.method === 'POST') {
    if (sess.role !== 'owner') return sendJson({ ok: false, msg: '只有主人能跟她说话' })
    return readBody(req, (j) => {
      const text = String(j.text || '').slice(0, 80).trim()
      if (text === '') return sendJson({ ok: false, msg: '没说话啊' })
      const f = base + '/房间对话.json'
      const d = load(f, { items: [] })
      d.items = [...(d.items || []), { at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), text, from: 'me', read: false }].slice(-50)
      save(f, d)
      return sendJson({ ok: true })
    })
  }

  // ROOM_CHAT_API 2026-11-02：把「我发的」和「她在群里说的」合成一条时间线给房间页
  if (url === '/room-chat') {
    const mine = (load(base + '/房间对话.json', { items: [] }).items || []).map((x) => ({
      at: x.at, text: x.text, from: x.from || 'me',
    }))
    const hers = []
    try {
      const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
      const log = base + '/../群聊日志/' + '2000000001-' + day + '.jsonl'
      if (existsSync(log)) {
        const lines = readFileSync(log, 'utf8').trim().split('\n').slice(-200)
        for (const line of lines) {
          try {
            // ROOM_CHAT_FIX 2026-11-03：群聊日志是扁平结构 {time, user_id, nickname, text}，
            // 不是 OneBot 的 message 段数组。原来的写法永远取不到她的话。
            const m = JSON.parse(line)
            if (String(m.user_id) !== '3556352474') continue
            const text = String(m.text || '').replace(/\s+/g, ' ').trim()
            // PLACEHOLDER_FILTER 2026-11-03：附件消息在日志里只剩「[file]」这种占位，别当一句话显示
            if (/^\[(file|image|face|record|video|json|xml|reply|at)[^\]]*\]$/i.test(text)) continue
            if (text === '') continue
            const at = String(m.time || '').slice(0, 16)
            if (at === '') continue
            hers.push({ at, text: text.slice(0, 120), from: 'her' })
          } catch (_err) { console.error('[房间]', _err?.message || _err) }
        }
      }
    } catch (_err) { console.error('[房间]', _err?.message || _err) }
    const all = [...mine, ...hers].sort((a, b) => String(a.at).localeCompare(String(b.at))).slice(-40)
    return sendJson({ ok: true, items: all })
  }

  const page = tools + '/房间页.html'
  if (!existsSync(page)) { res.writeHead(500); return res.end('房间页.html 不在') }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(readFileSync(page))
})
// 2026-11-04 修：端口被占时原来抛未捕获 error，打一屏堆栈，上层会以为服务挂了。
// 语义上这就是「已经在跑」，说明一句正常退出即可；其它错误才报失败。
server.on('error', (e) => {
  if (e && e.code === 'EADDRINUSE') { console.log('房间服务已在跑（' + PORT + ' 被占用），这次不重复起'); process.exit(0) }
  console.error('房间服务起不来：' + (e && e.message)); process.exit(1)
})
server.listen(PORT, '0.0.0.0', () => console.log('房间服务 v4 起来了：' + PORT))
