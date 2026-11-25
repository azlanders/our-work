#!/usr/bin/env node
/**
 * 一起听歌.mjs —— 网易云同号实时伴听（不顶号 · 同步歌名/歌词/热评 + Omni 真耳听旋律）
 *
 * 用法：
 *   node 一起听歌.mjs --tick          # 心跳每分钟跑：检测主人手机是否在放歌，自动同步歌词与听感
 *   node 一起听歌.mjs --看            # 查看当前同步状态
 *   node 一起听歌.mjs --听 <songId>   # 指定单曲 ID 立即精听并缓存
 *   node 一起听歌.mjs --扫码          # 若日后 Cookie 过期，生成二维码供扫码续期
 */
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { 写档, 改档 } from './_底层.mjs'
import { analyzeAudio, omniAudioConfigured } from './视频音频.mjs'

const MEM = process.env.QQ_MUSIC_MEM || '{{BOT_ROOT}}/记忆'
const STATE_FILE = path.join(MEM, '一起听.json')
const CACHE_DIR = path.join(MEM, '听过的歌')
// MUSIC_DL 2026-11-14（批次454）：下载目录原来是写死的，测试把脚本当 CLI 跑一遍，
// 4MB 音频就落进真档下载目录、还送去云端分析。给它一个能被指走的出口。
const DL_DIR = process.env.QQ_MUSIC_DL || '{{BOT_ROOT}}/下载'
const COOKIE_FILE = '{{DSH_ROOT}}/netease-cookie'
// ACCOUNTS 2026-11-12：支持多个网易云号，随时切「跟谁一起听」。
// 唯一真源是这个文件；老的 netease-cookie 只作为「还没建过账号档」时的兜底，
// 建过之后就不再看它，免得到时候两个地方各说各的。
const ACCOUNTS_FILE = process.env.QQ_MUSIC_ACCOUNTS || '{{DSH_ROOT}}/netease-accounts.json'
const API_BASE = 'http://127.0.0.1:3999'
const ACTIVE_WINDOW_MS = 10 * 60 * 1000 // playTime 在 10 分钟内视为「正在一起听」

fs.mkdirSync(CACHE_DIR, { recursive: true })
fs.mkdirSync(DL_DIR, { recursive: true })

const 缺档 = (e) => Boolean(e && e.code === 'ENOENT')

function loadEnvFile() {
  const env = { ...process.env }
  try {
    const raw = fs.readFileSync('/etc/dshbot.env', 'utf8')
    for (const line of raw.split(/\r?\n/)) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
      if (m && !env[m[1]]) env[m[1]] = m[2].trim()
    }
  } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
  return env
}

const OMNI_CONF_FILE = process.env.FISH_OMNI_CONFIG || '{{DSH_ROOT}}/fish-omni.json'

export function isMusicSyncEnabled() {
  try {
    const j = JSON.parse(fs.readFileSync(OMNI_CONF_FILE, 'utf8')) || {}
    if (j?.一起听?.开启 === false || j?.musicSync === false) return false
  } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
  return true
}

function 读账号档() {
  try {
    const j = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
    if (j && Array.isArray(j.账号) && j.账号.length) return j
  } catch { /* 还没建过 */ }
  // 迁移：老的单文件 cookie 当成第一个号，名字就叫「默认」
  let 旧 = ''
  try { 旧 = fs.readFileSync(COOKIE_FILE, 'utf8').trim() } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
  if (旧) return { 当前: '默认', 账号: [{ id: '默认', 名: '主人（同号）', cookie: 旧, 更新于: '' }] }
  return { 当前: '', 账号: [] }
}

function 写账号档(d) {
  写档(ACCOUNTS_FILE, d)
  // cookie 就是账号本体的凭据，别让别人读得到
  try { fs.chmodSync(ACCOUNTS_FILE, 0o600) } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
  return d
}

function 当前账号() {
  const d = 读账号档()
  const 列 = d.账号 || []
  return 列.find((x) => String(x.id) === String(d.当前)) || 列[0] || null
}

function readCookie() {
  const a = 当前账号()
  return a ? String(a.cookie || '').trim() : ''
}

// NC_GET 2026-11-12（切歌不同步的真根因）：
// 本地 3999 这个网易云服务对 **POST** 做了缓存 —— 同一个 body 连打两次，返回的是几分钟前那份；
// 换成 GET 同样的参数就是新的。实测：POST 两次（间隔 3 秒）都还是 4 分钟前的列表，
// GET 立刻拿到新歌。轮询再快也没用，因为拿的是缓存。
// 所以「最近播放」这种要新鲜度的接口一律走 GET，并带一个 _t 防它按 URL 再缓存。
async function ncmGet(ep, params = {}) {
  const ck = readCookie()
  const q = new URLSearchParams({
    ...params,
    ...(ck ? { cookie: ck } : {}),
    _t: String(Date.now()),
  })
  const r = await fetch(API_BASE + ep + '?' + q.toString(), {
    headers: ck ? { Cookie: ck } : {},
    signal: AbortSignal.timeout(12000),
  })
  if (!r.ok) throw new Error(`${ep} HTTP ${r.status}`)
  return r.json()
}

async function ncmPost(ep, params = {}) {
  const ck = readCookie()
  const body = JSON.stringify({ ...params, ...(ck ? { cookie: ck } : {}) })
  const r = await fetch(API_BASE + ep, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) },
    body,
    signal: AbortSignal.timeout(12000),
  })
  if (!r.ok) throw new Error(`${ep} HTTP ${r.status}`)
  return r.json()
}

function cleanLyrics(lrcText, tlyricText = '') {
  const strip = (s) => String(s || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\[[^\]]+\]/g, '').trim())
    .filter((l) => l && !/^(作词|作曲|编曲|制作人|混音|母带|录音|吉他|贝斯|鼓|弦乐|和声|出品|发行|OP|SP)\s*[:：]/i.test(l))
  const main = strip(lrcText)
  if (!main.length) return ''
  if (main.length === 1 && /纯音乐/.test(main[0])) return '（纯音乐 / 器乐曲，无人声歌词）'
  const trans = strip(tlyricText)
  const picked = main.slice(0, 14).join(' / ')
  const transPicked = trans.length ? '（译：' + trans.slice(0, 8).join(' / ') + '）' : ''
  return (picked + transPicked).slice(0, 260)
}

async function fetchSongMeta(songId) {
  // TRACE 2026-11-14（批次452 临时）：开关关着还在下载，先查是谁在调。
  try { fs.appendFileSync('/tmp/{{BOT_NAME}}-ncm-who.log', new Date().toISOString() + ' pid=' + process.pid + ' ppid=' + process.ppid + ' argv=' + JSON.stringify(process.argv.slice(2)) + ' sid=' + songId + '\n') } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
  const metaCache = path.join(CACHE_DIR, `${songId}.json`)
  let cached = {}
  try { cached = JSON.parse(fs.readFileSync(metaCache, 'utf8')) } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }

  if (!cached.lyrics) {
    try {
      const lyr = await ncmPost('/lyric', { id: songId })
      cached.lyrics = cleanLyrics(lyr?.lrc?.lyric, lyr?.tlyric?.lyric) || '（暂无歌词）'
    } catch { cached.lyrics = '' }
  }
  if (!cached.hotComment) {
    try {
      const hot = await ncmPost('/comment/hot', { id: songId, type: 0, limit: 2 })
      const list = Array.isArray(hot?.hotComments) ? hot.hotComments : []
      if (list[0]?.content) cached.hotComment = String(list[0].content).replace(/\s+/g, ' ').trim().slice(0, 70)
    } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
  }

  // 如果还没用耳朵听过这首歌，拉取副歌 40 秒片段喂给 Omni 模型听旋律/乐器/氛围！
  const env = loadEnvFile()
  if (!cached.omniFeel && omniAudioConfigured(env) && !cached.omniTried) {
    cached.omniTried = true
    const clipFile = path.join(DL_DIR, `ncm-clip-${songId}.mp3`)
    const rawFile = path.join(DL_DIR, `ncm-raw-${songId}.audio`)
    try {
      const ures = await ncmPost('/song/url', { id: songId, br: 128000 })
      const audioUrl = ures?.data?.[0]?.url
      if (audioUrl) {
        execFileSync('curl', ['-s', '-L', '-m', '25', '-A', 'Mozilla/5.0', '-o', rawFile, audioUrl], { timeout: 28000 })
        // 从第 35 秒（通常进入主歌/副歌）截取 40 秒转成 64kbps mp3（仅 ~320KB，极省流量又快）
        execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', '35', '-t', '40', '-i', rawFile, '-ac', '1', '-ar', '24000', '-b:a', '64k', clipFile], { timeout: 20000 })
        if (!fs.existsSync(clipFile) || fs.statSync(clipFile).size < 4096) {
          execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-t', '40', '-i', rawFile, '-ac', '1', '-ar', '24000', '-b:a', '64k', clipFile], { timeout: 20000 })
        }
        if (fs.existsSync(clipFile) && fs.statSync(clipFile).size >= 4096) {
          const res = await analyzeAudio(clipFile, {
            env,
            inputDir: DL_DIR,
            cachePath: path.join(CACHE_DIR, `${songId}.omni.json`),
            prompt: '请用简短自然的中文（80字以内）描述这段音乐听到的真实乐器、节奏快慢、曲风氛围以及人声（或纯音乐）的情绪质感。不要编造歌名。'
          })
          if (res?.ok && res.text) {
            cached.omniFeel = String(res.text).replace(/\s+/g, ' ').trim().slice(0, 110)
          }
        }
      }
    } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) } finally {
      try { if (fs.existsSync(rawFile)) fs.unlinkSync(rawFile) } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
      try { if (fs.existsSync(clipFile)) fs.unlinkSync(clipFile) } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
    }
  }

  cached.updatedAt = Date.now()
  写档(metaCache, cached)
  return cached
}

const args = process.argv.slice(2)

if (args.includes('--号')) {
  const d = 读账号档()
  const i = args.indexOf('--号')
  const 目标 = String(args[i + 1] || '').trim()
  if (!目标) {
    console.log(JSON.stringify({ 当前: d.当前, 账号: (d.账号 || []).map((x) => ({ id: x.id, 名: x.名, 更新于: x.更新于 || '' })) }, null, 2))
    process.exit(0)
  }
  const 有 = (d.账号 || []).find((x) => String(x.id) === 目标 || String(x.名) === 目标)
  if (!有) { console.error('没有这个号：' + 目标); process.exit(1) }
  d.当前 = 有.id
  写账号档(d)
  console.log('已切到 ' + (有.名 || 有.id))
  process.exit(0)
}

if (args.includes('--看')) {
  try {
    console.log(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch { console.log('还没有一起听记录') }
  process.exit(0)
}

if (args.includes('--听')) {
  const idx = args.indexOf('--听')
  const sid = String(args[idx + 1] || '').replace(/\D/g, '')
  if (!sid) { console.error('请给歌曲 ID'); process.exit(1) }
  const detail = await ncmPost('/song/detail', { ids: sid }).catch(() => ({}))
  const song = detail?.songs?.[0] || { id: Number(sid), name: '未知曲目', ar: [] }
  const meta = await fetchSongMeta(sid)
  const artist = (song.ar || []).map((a) => a.name).filter(Boolean).join('/')
  console.log(JSON.stringify({ id: Number(sid), name: song.name, artist, ...meta }, null, 2))
  process.exit(0)
}

// REALTIME 2026-11-12：正在分析的歌。同一个 songId 不重复开分析（20 秒一轮会撞车）。
const 分析中 = new Set()

// 歌名已经写出去了，歌词/热评/听感随后补进同一个状态。
// 按 songId 校验：这中间切歌了就把结果丢掉，别把上一首的听感贴到新歌上。
function 补元信息(songId, m) {
  try {
    改档(STATE_FILE, (d) => {
      if (String(d.songId) !== String(songId)) return false
      if (m.lyrics) d.lyrics = m.lyrics
      if (m.hotComment) d.hotComment = m.hotComment
      if (m.omniFeel) d.omniFeel = m.omniFeel
    }, {})
  } catch { /* 补不上不影响歌名 */ }
}

// 默认 / --tick：查最近播放第 1 首
async function 同步一次() {
try {
  if (!isMusicSyncEnabled()) {
    try {
      const old = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      if (old && old.active) 写档(STATE_FILE, { ...old, active: false, disabled: true, checkedAt: Date.now() })
    } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
    if (!args.includes('--quiet')) console.log('[一起听已关闭]')
    return
  }
  const ck = readCookie()
  if (!ck) return
  const rec = await ncmGet('/record/recent/song', { limit: 3 })
  if (Number(rec?.code) !== 200) {
    写档(STATE_FILE, { ok: false, active: false, 账号: (当前账号() || {}).名 || '', reason: 'cookie-expired-or-error', checkedAt: Date.now() })
    return
  }
  const list = rec?.data?.list || []
  if (!list.length) return

  const top = list[0]
  const playTime = Number(top?.playTime || 0)
  const d = top?.data || {}
  const songId = Number(d.id || 0)
  const name = String(d.name || '').trim()
  const artist = (Array.isArray(d.ar) ? d.ar : []).map((a) => a?.name).filter(Boolean).join('/')
  const album = String(d.al?.name || '').trim()
  const durationMs = Number(d.dt || 240000)
  const now = Date.now()
  const ageMs = now - playTime
  // 按真实曲长 + 75 秒缓冲判定是否在放：如果手机已暂停且超过一首歌时长没新上报，自动退为「刚才听过」不再假装还在放
  const windowMs = Math.min(12 * 60 * 1000, Math.max(180000, durationMs + 75000))
  // LOOPFIX 2026-11-12（批次363）：云端 playTime 在「单曲循环」时压根不刷新，按它往后推会一路涨过曲长 ——
  // 线上实测 174 秒的曲推成了 854 秒（面板写着「播到 14:14 / 2:54」）。两处补：
  //   ① 超曲长按循环取模，至少落在曲长范围内；
  //   ② 窗口放宽到 6 倍曲长，但只在 PC 上报器活着（25 秒内有推送）时放宽 ——
  //      否则「昨天晚上听过的歌」会一直挂在「正在播」。
  const 曲长 = Math.round(durationMs / 1000)
  const 已播 = Math.max(0, Math.round((now - playTime) / 1000))
  const 循环中 = 曲长 > 0 && 已播 > 曲长 + 5
  let 上报活 = false
  try {
    const 实档 = JSON.parse(fs.readFileSync(path.join(MEM, '一起听实时.json'), 'utf8'))
    // 只认「推的正是云端这一首」—— 否则 PC 上报的歌名和云端不同名时，
    // 会把上一首的窗口撑开，让她以为还在听上一首。
    if (实档 && Number(实档.at) && now - Number(实档.at) < 25000 && String(实档.歌名 || '') === name) 上报活 = true
  } catch { /* 没装上报器就按老窗口走 */ }
  const 窗口上限 = 上报活 ? Math.max(windowMs, 曲长 * 1000 * 6) : windowMs
  const active = songId > 0 && playTime > 0 && ageMs >= -60000 && ageMs <= 窗口上限

  let prev = {}
  try { prev = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch (e) { if (!缺档(e)) console.error('[一起听歌]', e && e.message) }
  const replayed = prev.songId === songId && prev.playTime && playTime > Number(prev.playTime) + 15000
  const replayCount = prev.songId === songId ? (Number(prev.replayCount || 1) + (replayed ? 1 : 0)) : 1

  // 省 token 优化：只有「正在听（active）」时才拉 Omni 听感；如果是几小时前早已停播的旧歌，不烧 Omni！
  // 先用已知的把状态写出去 —— 歌名、歌手、进度立刻就新，面板 20 秒内就能对上。
  // 歌词/热评/听感丢到后台补（听感要下片段 + ffmpeg + Omni，十几秒，绝不能挡在这条路上）。
  let meta = {
    lyrics: prev.songId === songId ? (prev.lyrics || '') : '',
    hotComment: prev.songId === songId ? (prev.hotComment || '') : '',
    omniFeel: prev.songId === songId ? (prev.omniFeel || '') : '',
  }
  if (songId > 0 && active && !分析中.has(songId)) {
    分析中.add(songId)
    ;(async () => {
      try {
        const m = await fetchSongMeta(songId)
        if (m) 补元信息(songId, m)
      } catch { /* 补不上就等下一轮 */ } finally { 分析中.delete(songId) }
    })()
  }

  const recent3 = list.slice(0, 3).map((it) => {
    const s = it?.data || {}
    const ar = (s.ar || []).map((a) => a?.name).filter(Boolean).join('/')
    return `${s.name}${ar ? ' - ' + ar : ''}`
  })

  const 号 = 当前账号() || {}
  const state = {
    ok: true,
    active,
    账号: String(号.名 || ''),
    号id: String(号.id || ''),
    // 进度：最近播放只给了「开始播的时刻」，按它往后推算现在是第几秒，封顶到曲长。
    // 有了它，面板和她说话都能说「播到 1:23」，而不是只说歌名。
    progressSec: active ? Math.min(曲长, 循环中 ? (已播 % Math.max(1, 曲长)) : 已播) : 0,
    循环中,
    checkedAt: now,
    playTime,
    ageMin: Math.max(0, Math.round(ageMs / 60000)),
    songId,
    name,
    artist,
    album,
    durationSec: Math.round(durationMs / 1000),
    replayCount,
    replayedJustNow: Boolean(replayed),
    lyrics: meta.lyrics || '',
    omniFeel: meta.omniFeel || '',
    hotComment: meta.hotComment || '',
    recent3,
  }
  写档(STATE_FILE, state)
  if (!args.includes('--quiet')) {
    console.log(active ? `[一起听中] 《${name}》- ${artist} (${state.ageMin}分钟前切歌)` : `[最近听过] 《${name}》- ${artist} (${state.ageMin}分钟前)`)
  }
} catch (e) {
  if (!args.includes('--quiet')) console.error('一起听同步异常：' + (e?.message || e))
}
}

// LOOP 2026-11-12：心跳最快只能一分钟，而「切歌后她还在说上一首」就是那 60 秒的延迟。
// MUSIC_3S 2026-11-12：主人要求「起码压缩到 3 秒内」。默认 3 秒一轮 ——
// 打的是本机 3999 的「最近播放」，几百字节，比一次页面请求还轻。
// 但不能硬扛：接口连续报错（cookie 过期 / 被限流）时退到 15 秒，别把上游打崩、也别刷日志。
// 间隔可用 MUSIC_LOOP_MS 覆盖，排查时不用改代码。
if (args.includes('--loop')) {
  const 等 = (ms) => new Promise((r) => setTimeout(r, ms))
  const 快 = Math.max(1000, Number(process.env.MUSIC_LOOP_MS || 2000) || 2000)
  for (;;) {
    await 同步一次()
    let 慢 = false
    try {
      const 现状 = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
      慢 = Boolean(现状 && 现状.ok === false)
    } catch { /* 读不到就按快档走 */ }
    await 等(慢 ? 15000 : 快)
  }
} else {
  await 同步一次()
}
