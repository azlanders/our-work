#!/usr/bin/env node
/**
 * 看视频.mjs —— B站/本地视频统一下载 + 「Omni 优先 / Storyboard 分镜插件自动兜底」看视频核心。
 *
 * 模式由 {{DSH_ROOT}}/fish-omni.json 的「看视频.模式」控制（WebUI 用量页可实时切换，无需重启）：
 *   · omni（默认）：优先调 qwen3.8-omni-flash 音画联合理解；若 Omni 未配置/失败/超长/无声，自动切到 dsh-video-storyboard 插件！
 *   · storyboard：直接走 dsh-video-storyboard 插件（按镜头切点密度 1/1…1/8 动态排布宫格分镜图 + faster-whisper 带时间码台词清单 + 响度包络）。
 *
 * 用法：
 *   node 看视频.mjs BV1Vzxc6dEwp [--json] [--omni] [--图]
 *   node 看视频.mjs --reading <账本id> [--json] [--omni] [--图]
 *   默认跟随面板「看视频方式」：omni → 音画理解；storyboard → 分镜+台词。
 *   --图 是「只下载 + 拼 16 格图」的快路径（不调 omni）。**面板为 Omni 优先时会被拒绝**，
 *   只有面板改成 Storyboard 才允许 —— 面板是唯一开关，命令行不许绕过它。
 *   node 看视频.mjs --self-test
 */
import { execFileSync } from 'node:child_process'
import { 取JSON, 隧道可用 } from './_隧道.mjs'
import { mkdirSync, existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { analyzeVideo, omniConfigured, getVideoMode, MAX_VIDEO_BYTES, MAX_VIDEO_SECONDS } from './视频音频.mjs'

// OUT_DIR_ENV 2026-11-14（批次467）：能指到别处，测试才不会把她的 记忆/视频画面 当草稿纸
// （批次453~457 那一串事故全是「测试写进真目录」）。生产不设这个变量，行为不变。
export const OUT_DIR = process.env.FISH_VIDEO_OUT || '{{BOT_ROOT}}/记忆/视频画面'
const CRED = '{{DSH_ROOT}}/bili-humanism/credential.json'
const STORYBOARD_PKG = '{{DSH_ROOT}}/profiles/web/vendor/dsh-video-storyboard'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
const COLS = 4
const ROWS = 4
const CELL_W = 400

function sessdata() {
  try { return String(JSON.parse(readFileSync(CRED, 'utf8')).sessdata || '') } catch { return '' }
}

async function 领buvid() {
  const j = await 取JSON('https://api.bilibili.com/x/frontend/finger/spi', {
    'User-Agent': UA, Referer: 'https://www.bilibili.com/',
  })
  return String(j?.data?.b_3 || '')
}

async function 调(url, b3, ck) {
  return 取JSON(url, {
    'User-Agent': UA,
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
    Accept: 'application/json, text/plain, */*',
    Cookie: `SESSDATA=${ck}; buvid3=${b3}`,
  })
}

/** 从 BV号 / bilibili URL / b23.tv 短链里解析出标准 BV 号（或 aid）。 */
function biliPage(input) {
  const raw = input.match(/[?&]p=([^&#]*)/)?.[1]
  if (raw === undefined) return undefined
  const page = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(page) || page < 1) throw new Error('分P必须是正整数')
  return page
}

export async function resolveBiliId(raw) {
  let s = String(raw || '').trim()
  if (!s) return null
  if (/^https?:\/\/b23\.tv\//i.test(s)) {
    try {
      const loc = execFileSync('curl', ['-sS', '-I', '-L', '--max-redirs', '3', '-o', '/dev/null', '-w', '%{url_effective}',
        '-H', `User-Agent: ${UA}`, s], { encoding: 'utf8', timeout: 15000 }).trim()
      if (loc) s = loc
    } catch {}
  }
  const bvMatch = s.match(/^(BV[0-9A-Za-z]{10})$|^https?:\/\/(?:[a-z0-9-]+\.)?bilibili\.com\/video\/(BV[0-9A-Za-z]{10})(?:[/?#]|$)/i)
  if (bvMatch) return { bvid: bvMatch[1] || bvMatch[2], page: biliPage(s) }
  const avMatch = s.match(/(?:^|\/|av)(\d{5,16})(?:\b|\/|\?|$)/i)
  if (avMatch && /bilibili\.com|^av\d+/i.test(s)) return { aid: avMatch[1], page: biliPage(s) }
  return null
}

/** 下载 B 站视频到 {{BOT_ROOT}}/记忆/视频画面/<bvid>.mp4（带 buvid3 + 隧道抗 412），同时抓取 B 站自带字幕（若有）。 */
export async function downloadBiliVideo(idOrObj, { outDir = OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true })
  const ck = sessdata()
  const b3 = await 领buvid()
  if (!b3) throw new Error('领不到 buvid3')
  const query = typeof idOrObj === 'string'
    ? `bvid=${idOrObj}`
    : (idOrObj.bvid ? `bvid=${idOrObj.bvid}` : `aid=${idOrObj.aid}`)
  const v = await 调(`https://api.bilibili.com/x/web-interface/view?${query}`, b3, ck)
  if (v.code !== 0) throw new Error(`view ${v.code} ${v.message}`)
  const bvid = String(v.data.bvid || idOrObj.bvid || idOrObj)
  const pages = Array.isArray(v.data.pages) ? v.data.pages : []
  const page = typeof idOrObj === 'object' ? idOrObj.page || 1 : 1
  const part = pages.find(item => item.page === page)
  const cid = part?.cid || (page === 1 && pages.length === 0 ? v.data.cid : 0)
  if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error(`B站没有可确认的第 ${page} P`)
  const 时长 = Number(part?.duration || v.data.duration) || 0
  const 标题 = String(v.data.title || '')
  const 作者 = String(v.data.owner?.name || '')
  const 简介 = String(v.data.desc || '').slice(0, 300)
  const partKey = `${bvid}.p${page}.${cid}`
  const legacyMp4 = join(outDir, `${bvid}.mp4`)
  const partMp4 = join(outDir, `${partKey}.mp4`)
  const explicitPage = typeof idOrObj === 'object' && idOrObj.page !== undefined
  const mp4 = !explicitPage && pages.length === 1 && !existsSync(partMp4) && existsSync(legacyMp4) &&
    Math.abs(videoDuration(legacyMp4) - 时长) <= 2 ? legacyMp4 : partMp4

  if (!existsSync(mp4) || statSync(mp4).size < 1024) {
    const pu = await 调(
      `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&fnval=1&fnver=0&fourk=0`,
      b3, ck,
    )
    if (pu.code !== 0) throw new Error(`playurl ${pu.code} ${pu.message}`)
    const 段 = (pu.data?.durl || [])[0]
    if (!段?.url) throw new Error('没有直链')
    const urls = [段.url, ...((段.backup_url || []).filter((u) => typeof u === 'string'))]

    let last = -1
    let 隧道开 = null
    for (let i = 0; i < 6; i++) {
      const cur = existsSync(mp4) ? statSync(mp4).size : 0
      if (cur === last) break
      last = cur
      if (i >= 2 && 隧道开 === null) 隧道开 = await 隧道可用()
      const 代理 = (i >= 2 && 隧道开 === true) ? ['--socks5-hostname', '127.0.0.1:1080'] : []
      try {
        execFileSync('curl', ['-sS', '-L', '-C', '-', ...代理, '-o', mp4,
          '-H', `User-Agent: ${UA}`, '-H', 'Referer: https://www.bilibili.com/',
          urls[i % urls.length]], { timeout: 240e3, stdio: 'ignore' })
      } catch { /* 断流续传 */ }
    }
  }
  if (!existsSync(mp4) || statSync(mp4).size < 1024) throw new Error('视频流没拉下来')

  // 顺手尝试拿 B 站原生 CC/AI 字幕写进 .srt（如果拿得到，storyboard 就不用跑 CPU Whisper 了，1秒出稿！）
  const srtPath = join(outDir, `${basename(mp4, '.mp4')}.srt`)
  if (!existsSync(srtPath) && ck) {
    try {
      const pj = await 调(`https://api.bilibili.com/x/player/wbi/v2?bvid=${bvid}&cid=${cid}`, b3, ck)
      const sub = (pj?.data?.subtitle?.subtitles || [])[0]
      let surl = String(sub?.subtitle_url || '')
      if (surl.startsWith('//')) surl = 'https:' + surl
      if (surl.startsWith('https://')) {
        const sj = await 取JSON(surl, { 'User-Agent': UA })
        const body = Array.isArray(sj?.body) ? sj.body : []
        if (body.length > 0) {
          const fmtT = (sec) => {
            const ms = Math.max(0, Math.round(Number(sec || 0) * 1000))
            const h = String(Math.floor(ms / 3600000)).padStart(2, '0')
            const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0')
            const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')
            const f = String(ms % 1000).padStart(3, '0')
            return `${h}:${m}:${s},${f}`
          }
          const srt = body.map((it, idx) => `${idx + 1}\n${fmtT(it.from)} --> ${fmtT(it.to)}\n${String(it.content || '').trim()}\n`).join('\n')
          writeFileSync(srtPath, srt, 'utf8')
        }
      }
    } catch { /* 没字幕算正常，落回 faster-whisper */ }
  }

  return { bvid, aid: Number(v.data?.aid) || 0, cid: mp4 === partMp4 ? cid : null, page: mp4 === partMp4 ? page : null, mp4, srtPath: existsSync(srtPath) ? srtPath : '', 标题, 作者, 简介, 时长 }
}

/**
 * 抓 B 站评论区（顶层，按热度）。她看完视频会顺带看评论区 —— 观众反应常常比视频本身更有信息量。
 * 失败一律返回 []，不让评论抓取拖垮看视频主路径。
 */
export async function fetchBiliComments(id, { limit = 15 } = {}) {
  try {
    const ck = sessdata()
    const b3 = await 领buvid()
    if (!b3) return []
    let aid = Number(typeof id === 'object' ? id?.aid : 0) || 0
    if (!aid) {
      const bvid = typeof id === 'object' ? id?.bvid : String(id || '')
      if (!bvid) return []
      const v = await 调(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, b3, ck)
      if (v.code !== 0) return []
      aid = Number(v.data?.aid) || 0
    }
    if (!aid) return []
    const r = await 调(`https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&sort=2&ps=${limit}&pn=1`, b3, ck)
    if (r.code !== 0) return []
    return (r.data?.replies || []).map((c) => ({
      用户: String(c.member?.uname || '匿名'),
      赞: Number(c.like) || 0,
      回复: Number(c.rcount) || 0,
      内容: String(c.content?.message || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    })).filter((c) => c.内容)
  } catch { return [] }
}

/** 生成 4x4 均匀 16 格拼图（用于 Omni 模式的轻量辅助图，或极简兜底）。 */
export function buildGrid16(mp4, png, 时长 = 0) {
  const fps = 时长 > 0 ? 16 / 时长 : 1 / 15
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', '-i', mp4,
    '-vf', `fps=${fps.toFixed(4)},scale=${CELL_W}:-2,tile=${COLS}x${ROWS}:padding=4:margin=4:color=black`,
    '-frames:v', '1', png], { timeout: 180e3, stdio: 'ignore' })
  return existsSync(png) ? png : ''
}

/** 调 dsh-video-storyboard 核心管线：按镜头切点密度（1/1..1/8）排布宫格分镜图 + 带时间码台词清单 + 响度包络。 */
export async function runStoryboardOnFile(mp4, { srtPath = '', outPrefix = '', maxSheets = 3, detail = 'med', from = 0, to = 0 } = {}) {
  const pipeUrl = pathToFileURL(join(STORYBOARD_PKG, 'src/storyboard/pipeline.js')).href
  const fmtUrl = pathToFileURL(join(STORYBOARD_PKG, 'src/storyboard/format.js')).href
  const boardUrl = pathToFileURL(join(STORYBOARD_PKG, 'src/storyboard/board.js')).href
  const { runStoryboard } = await import(pipeUrl)
  const { formatForDetail } = await import(fmtUrl)
  const { boardOptions } = await import(boardUrl)

  const rawArgs = {
    input: mp4,
    maxSheets,
    detail,
    ...(from > 0 ? { from } : {}),
    ...(to > 0 ? { to } : {}),
    ...(srtPath && existsSync(srtPath) ? { transcriptFile: srtPath } : {}),
  }
  const opts = boardOptions(rawArgs, { kind: 'board' })
  const result = await runStoryboard(opts)
  const text = formatForDetail(result, { detail })
  const savedPaths = []
  const sheets = []
  for (const s of (result.sheets || [])) {
    let p = ''
    if (outPrefix) {
      p = `${outPrefix}.sb-${s.sheet}.png`
      try { writeFileSync(p, s.png); savedPaths.push(p) } catch { p = '' }
    }
    sheets.push({ sheet: s.sheet, png: s.png, path: p })
  }
  return { ok: sheets.length > 0, sheets, savedPaths, text, duration: result.duration || 0 }
}

function videoDuration(mp4) {
  try {
    return Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', mp4], { encoding: 'utf8', timeout: 15000 }).trim()) || 0
  } catch { return 0 }
}

async function cachedBiliVideo(input, outDir) {
  if (!/^(?:BV[0-9A-Za-z]{10}$|https?:\/\/(?:[a-z0-9-]+\.)?bilibili\.com\/video\/BV)/i.test(String(input).trim())) {
    throw new Error('离线回查请用 BV 号或完整 B 站地址')
  }
  const source = await resolveBiliId(input)
  if (!source?.bvid || !existsSync(outDir)) throw new Error('未找到本地视频缓存')
  const { bvid, page } = source
  const partPattern = new RegExp(`^${bvid}\\.p([1-9]\\d*)\\.([1-9]\\d*)\\.mp4$`)
  const parts = readdirSync(outDir).map(name => name.match(partPattern)).filter(match => match && (!page || Number(match[1]) === page))
  const legacy = existsSync(join(outDir, `${bvid}.mp4`))
  if (parts.length > 1 || (!page && legacy && parts.length)) throw new Error('命中多份缓存，请指定分P。同一分P有多个版本时需重新核对来源。')
  const part = parts[0]
  if (!part && (page || !legacy)) throw new Error('本地缓存无法确认请求的分P，请先按分P看一次原片')
  const mp4 = join(outDir, part?.[0] || `${bvid}.mp4`)
  return {
    mp4,
    srtPath: join(outDir, `${basename(mp4, '.mp4')}.srt`),
    meta: { bvid, page: part ? Number(part[1]) : null, cid: part ? Number(part[2]) : null },
  }
}

async function readVideoEvidence({ mp4, srtPath, meta }, options, requestedMode) {
  const duration = videoDuration(mp4)
  const from = options.from ?? 0
  const to = options.to ?? Math.min(from + 15, duration)
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || from >= duration || to <= from || to > duration + 0.05 || to - from > 120) {
    throw new Error(`片长 ${duration.toFixed(2)} 秒。请选择片内不超过 120 秒的区间。`)
  }
  const end = Math.min(to, duration)
  const { parseSrt } = await import(pathToFileURL(join(STORYBOARD_PKG, 'src/storyboard/transcript-file.js')).href)
  const hasSrt = Boolean(srtPath && existsSync(srtPath))
  const lines = hasSrt ? parseSrt(readFileSync(srtPath, 'utf8')) : []
  const matches = lines.filter(line => line.to > from && line.from < end)
  const excerpts = matches.slice(0, 40).map(line => `[${line.from.toFixed(3)}–${line.to.toFixed(3)} 秒] ${line.text.slice(0, 320)}`)
  const at = (from + end) / 2
  let png
  try {
    png = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(at), '-i', mp4, '-map', '0:v:0', '-frames:v', '1', '-vf', 'scale=min(960\\,iw):-2', '-threads', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { timeout: 12000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch { png = null }
  const sourceUrl = meta.bvid ? `https://www.bilibili.com/video/${meta.bvid}?${meta.page ? `p=${meta.page}&` : ''}t=${Math.floor(from)}` : ''
  const source = meta.bvid ? `${meta.bvid}${meta.cid ? ` · P${meta.page} · CID ${meta.cid}` : ' · 旧缓存，分P/CID未核实'}\n原片入口：${sourceUrl}` : `视频：${meta.标题}`
  const coverage = [
    `回查范围：${from.toFixed(3)}–${end.toFixed(3)} 秒。只取本地证据，未做音画模型分析。`,
    png?.length ? `附图：约 ${at.toFixed(3)} 秒的单帧，画面仅覆盖这一刻。` : '此区间未拿到画面。',
    lines.length ? `缓存字幕轨来源未核。区间有 ${matches.length} 段字幕${matches.length > excerpts.length ? `，返回前 ${excerpts.length} 段` : ''}。字幕可能有误或遗漏。` : (hasSrt ? '无法从缓存字幕读取台词。' : '本地没有字幕缓存。'),
  ]
  return { ok: true, requestedMode, engine: 'evidence', mp4, meta, sheets: png?.length ? [{ png }] : [], text: [source, ...coverage, ...excerpts].join('\n') }
}

/**
 * 统一看视频入口（聊天侧 qq_watch_video 与 B站自主学习共用）：
 *   1. 读取模式（options.mode 显式指定 > {{DSH_ROOT}}/fish-omni.json 看视频.模式 > 默认 'omni'）
 *   2. 若 mode === 'omni'：先走 qwen3.8-omni-flash（analyzeVideo）；
 *      一旦 Omni 失败 / 未配置 / 超时 / 超长(>30min) / 无音轨，自动无缝切换到 Storyboard 插件！
 *   3. 若 mode === 'storyboard'：直接跑 Storyboard 分镜插件！
 */
export async function watchVideoUnified(input, options = {}) {
  const env = options.env || process.env
  const outDir = options.outDir || OUT_DIR
  if (options.evidenceOnly) return readVideoEvidence(await cachedBiliVideo(input, outDir), options, 'evidence')
  const requestedMode = String(options.mode || getVideoMode(env)).toLowerCase() === 'storyboard' ? 'storyboard' : 'omni'
  mkdirSync(outDir, { recursive: true })

  let mp4 = ''
  let srtPath = ''
  let meta = { bvid: '', 标题: '', 作者: '', 简介: '', 时长: 0 }
  const bili = await resolveBiliId(input)
  if (bili) {
    const dl = await downloadBiliVideo(bili, { outDir })
    mp4 = dl.mp4
    srtPath = dl.srtPath
    meta = { bvid: dl.bvid, aid: dl.aid, cid: dl.cid, page: dl.page, 标题: dl.标题, 作者: dl.作者, 简介: dl.简介, 时长: dl.时长 }
  } else {
    const local = resolve(String(input || ''))
    if (!existsSync(local) || !statSync(local).isFile()) {
      throw new Error('找不到视频文件或无法识别的链接：' + String(input || '').slice(0, 80))
    }
    mp4 = local
    meta.时长 = Math.round(videoDuration(mp4))
    meta.标题 = basename(mp4)
  }

  if (options.from !== undefined || options.to !== undefined) return readVideoEvidence({ mp4, srtPath, meta }, options, requestedMode)

  // COMMENT_SIDE 2026-11-24：看视频顺带看评论区（默认开，options.comments === false 可关）。
  const 评论 = bili && options.comments !== false
    ? await fetchBiliComments({ bvid: meta.bvid, aid: meta.aid }, { limit: Number(options.commentLimit) || 15 })
    : []
  const 评论段 = () => 评论.length
    ? `【评论区（按热度，${评论.length} 条）】\n` + 评论.map((c, i) =>
      `${i + 1}. ${c.用户}（赞${c.赞}${c.回复 ? ` · ${c.回复} 回复` : ''}）：${c.内容}`).join('\n')
    : ''

  const baseKey = basename(mp4, extname(mp4)).replace(/[^A-Za-z0-9._-一-龥]/g, '_').slice(0, 80)
  const prefix = join(outDir, baseKey)

  let usedEngine = requestedMode
  let fallbackReason = ''

  if (requestedMode === 'omni') {
    let omniRes
    if (!omniConfigured(env)) {
      omniRes = { ok: false, reason: 'not-configured' }
    } else if (meta.时长 > MAX_VIDEO_SECONDS) {
      omniRes = { ok: false, reason: 'video-duration-limit' }
    } else {
      // RETRY 2026-11-14（批次479）：omni 原来**一次失败就降级**，而失败原因里有一半是瞬时的。
      // 19:46 那次现场：B 站下载断流留下 10.2M 的半截 mp4（正常 20.1M）→ omni 失败 → 降级拼图；
      // 19:57 重下 20.1M 之后一次就成。这类值得重试。
      // 但配置类/超限类（not-configured / video-size-limit / duration-limit / media-probe-failed /
      // audio-track-missing …）重试 100 次也一样，必须直接降级，不然白等 3 秒还多传两遍 20M。
      const 可重试 = (r) => {
        const x = String(r?.reason || '')
        if (/^upload-http-(0|408|429|5\d\d)$/.test(x)) return true  // 网络断 / 限流 / 服务端
        if (x === 'model-output-empty') return true                 // 模型偶发返空
        return false
      }
      for (let 次 = 1; 次 <= 3; 次++) {
        omniRes = await analyzeVideo(mp4, {
          env,
          cachePath: `${prefix}.omni.json`,
          ...(options.prompt ? { prompt: options.prompt } : {}),
        })
        if (omniRes?.ok && omniRes.text) break
        if (次 === 3 || !可重试(omniRes)) break
        // 退避 1.5s / 3s —— 429 和 5xx 大多几十毫秒就恢复，等太久她那边就是干等
        await new Promise((r) => setTimeout(r, 1500 * 次))
      }
      if (!omniRes?.ok) {
        // 重试过还是不行就记一笔，`fallbackReason` 会带出来，面板和日志能看出是重试耗尽
        const 末次原因 = String(omniRes?.reason || 'omni-failed')
        if (末次原因 !== 'not-configured') console.error(`[omni] 重试耗尽：${末次原因}`)
      }
    }
    if (omniRes?.ok && omniRes.text) {
      const gridPng = `${prefix}.png`
      if (!existsSync(gridPng)) {
        try { buildGrid16(mp4, gridPng, meta.时长) } catch {}
      }
      const sheets = []
      if (existsSync(gridPng)) {
        sheets.push({ sheet: 1, path: gridPng, png: readFileSync(gridPng) })
      }
      const headLines = []
      if (meta.标题) headLines.push(`视频：《${meta.标题}》${meta.作者 ? `（UP主：${meta.作者}）` : ''}${meta.时长 ? ` · ${meta.时长}s` : ''}`)
      if (meta.简介) headLines.push(`简介：${meta.简介}`)
      const 评1 = 评论段()
      if (评1) headLines.push(评1)
      headLines.push(`【音画理解（Omni）】\n${omniRes.text}`)
      return {
        ok: true,
        requestedMode,
        engine: 'omni',
        fallbackReason: '',
        mp4,
        meta,
        评论,
        path: existsSync(gridPng) ? gridPng : '',
        sheets,
        omniText: omniRes.text,
        text: headLines.join('\n'),
      }
    }
    // Omni 挂了 / 未配 / 超长 / 无声 → 自动切 Storyboard 插件！
    usedEngine = 'storyboard'
    fallbackReason = String(omniRes?.reason || 'omni-failed')
  }

  // 走 Storyboard 插件（直接选了插件，或者 Omni 自动降级过来）
  const sb = await runStoryboardOnFile(mp4, {
    srtPath,
    outPrefix: prefix,
    maxSheets: Number(options.maxSheets) || 3,
    detail: options.detail || 'med',
  })
  // 顺手把第一张分镜图也落一份到 <prefix>.png，保证自主学习等只读单图的旧入口直接拿到高信息量分镜图！
  const mainPng = `${prefix}.png`
  if (sb.sheets[0]?.png) {
    try { writeFileSync(mainPng, sb.sheets[0].png) } catch {}
  }
  const headLines = []
  if (meta.标题) headLines.push(`视频：《${meta.标题}》${meta.作者 ? `（UP主：${meta.作者}）` : ''}${meta.时长 ? ` · ${meta.时长}s` : ''}`)
  if (meta.简介) headLines.push(`简介：${meta.简介}`)
  const 评2 = 评论段()
  if (评2) headLines.push(评2)
  if (fallbackReason) headLines.push(`（注：Omni 暂不可用 [${fallbackReason}]，已自动切换至 Storyboard 分镜插件解析）`)
  headLines.push(`【分镜与时间轴台词（Storyboard）】\n${sb.text}`)

  return {
    ok: true,
    requestedMode,
    engine: usedEngine,
    fallbackReason,
    mp4,
    meta,
    评论,
    path: existsSync(mainPng) ? mainPng : (sb.savedPaths[0] || ''),
    sheets: sb.sheets,
    omniText: '',
    storyboardText: sb.text,
    text: headLines.join('\n'),
  }
}

// ── CLI 入口（保持与 自主学习.mjs / t353.test.mjs 契约完全兼容） ──────────────
const 是主 = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (是主) {
  const args = process.argv.slice(2)
  const asJson = args.includes('--json')
  let bvid = args.find((a) => /^BV[0-9A-Za-z]{8,}$/.test(a)) || ''
  const readingId = (() => {
    const i = args.indexOf('--reading')
    return i >= 0 ? String(args[i + 1] || '') : ''
  })()
  if (!bvid && readingId) {
    try {
      bvid = execFileSync('python3', ['-c', `
import sqlite3,sys
c=sqlite3.connect("file:{{DSH_ROOT}}/bili-humanism/ledger.sqlite?mode=ro",uri=True)
r=c.execute("select bvid from readings where id=?",(sys.argv[1],)).fetchone()
print(r[0] if r else "")
`, readingId], { encoding: 'utf8', timeout: 15e3 }).trim()
    } catch { bvid = '' }
  }

  const 说 = (o) => {
    if (asJson) console.log(JSON.stringify(o, null, 2))
    else console.log(o.path ? o.path : o.说 || '')
  }

  if (args.includes('--self-test')) {
    const has = (bin) => { try { execFileSync(bin, ['-version'], { stdio: 'ignore' }); return true } catch { return false } }
    const r = {
      ffmpeg: has('ffmpeg'),
      ffprobe: has('ffprobe'),
      看视频模式: getVideoMode(),
      Omni配置: omniConfigured(),
      Storyboard插件: existsSync(join(STORYBOARD_PKG, 'package.json')),
      Omni最大视频MB: Math.round(MAX_VIDEO_BYTES / 1024 / 1024),
      凭据: sessdata() ? '有' : '没有',
      目录: existsSync(OUT_DIR) ? '有' : '待建',
    }
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ffmpeg ? 0 : 1)
  }

  if (!bvid) {
    console.error('用法：node 看视频.mjs BV1xxxxxxxxx [--json] [--omni] [--图] | node 看视频.mjs --reading <账本id> [--json] [--omni] [--图]')
    process.exit(1)
  }

  try {
    // ENGINE_DEFAULT 2026-11-14（批次467）：判据原来是
    //   wantRich = args.includes('--omni') || getVideoMode() === 'storyboard'
    // —— **写反了**。面板选「Omni 优先」（默认）时它判 false，直接掉到下面那个
    // 「只下载 + 拼 16 格图」的轻分支，**一次 omni 都不调**；面板选 storyboard 时它反而判 true。
    // 后果：她批量看视频（`node 看视频.mjs BVxxx`）全走轻分支，手上只有 mp4 + srt + 拼图，
    // 只能读台词、画面几乎没看；而轻分支的输出里连「引擎」这一栏都没有 —— 她根本不知道没调 omni。
    // 现在：默认跟随面板；要省钱走快路径显式加 --图（输出会写明没调 omni）。
    // 兼容 t353 静态扫描断言：args.includes('--omni') 与 analyzeVideo(mp4, ...) 都还在。
    const 要快 = args.includes('--图') || args.includes('--fast')
    // PANEL_RULES 2026-11-14（批次468）：主人定死「面板选 omni，就全用 omni」——
    // 快路径不许绕过面板。面板是 Omni 优先时，--图 直接拒，并告诉她去找主人改设置。
    // （面板是 Storyboard 时 --图 仍然可用：那种模式本来就只跑 CPU，快路径只是跳过分镜。）
    if (要快 && getVideoMode() === 'omni') {
      说({ ok: false, 说: '面板的「看视频方式」是 Omni 优先，不能只用拼图绕过它。真要只出拼图，得先请主人把面板改成 Storyboard。' })
      process.exit(1)
    }
    const wantRich = !要快
    if (wantRich) {
      const res = await watchVideoUnified(bvid)
      const kb = res.path && existsSync(res.path) ? Math.round(statSync(res.path).size / 1024) : 0
      const avText = res.engine === 'omni' ? res.omniText : res.storyboardText
      const 音视频 = avText
        ? { ok: true, engine: res.engine, fallbackReason: res.fallbackReason || undefined, text: avText }
        : { ok: false, reason: res.fallbackReason || 'empty' }
      说({
        ok: Boolean(res.path),
        path: res.path,
        标题: res.meta.标题,
        时长: res.meta.时长,
        格数: COLS * ROWS,
        设备: `${kb}KB`,
        引擎: res.engine,
        音视频,
        评论: res.评论 || [],
      })
      process.exit(res.path ? 0 : 1)
    } else {
      const dl = await downloadBiliVideo(bvid)
      const mp4 = dl.mp4
    const png = join(OUT_DIR, `${basename(mp4, '.mp4')}.png`)
      buildGrid16(mp4, png, dl.时长)
      if (!existsSync(png)) throw new Error('没生成拼图')
      const kb = Math.round(statSync(png).size / 1024)
      let 音视频 = null
      if (args.includes('--omni')) {
        音视频 = await analyzeVideo(mp4, { cachePath: join(OUT_DIR, `${basename(mp4, '.mp4')}.omni.json`) })
      }
      const 评论 = await fetchBiliComments({ bvid: dl.bvid, aid: dl.aid }, { limit: 15 })
      // 轻分支原来只回 path/标题/时长 —— 少了「这次用的什么引擎」，于是她读着台词
      // 以为自己在"看视频"，其实画面只过了一张 16 格拼图。这一栏必须自报。
      说({
        ok: true, path: png, 标题: dl.标题, 时长: dl.时长, 格数: COLS * ROWS, 设备: `${kb}KB`,
        引擎: 音视频 ? '拼图 + omni（--图 同时带了 --omni）' : '拼图（没调 omni：只下载+拼图，画面只是一张 16 格缩略图）',
        ...(音视频 ? { 音视频 } : {}),
        ...(评论.length ? { 评论 } : {}),
      })
      process.exit(0)
    }
  } catch (e) {
    说({ ok: false, 说: `没出画面：${String(e.message || e).slice(0, 80)}` })
    process.exit(1)
  }
}
