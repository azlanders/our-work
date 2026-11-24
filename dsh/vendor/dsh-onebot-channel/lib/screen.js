/**
 * screen.js —— 让大肥鱼"看见"主人电脑的屏幕。
 *
 * 链路：主人电脑上跑 `screen-push.mjs`（ffmpeg gdigrab 抓屏 + 变化分筛帧）
 *      → ssh 推到 `${QQ_WS}/屏幕/latest.png` + `history/`
 *      → 这里读出来，`attachments.saveImages()` 存进附件库
 *      → 工具结果里带 image 块，模型就能真看见。
 *
 * 为什么不做成"实时视频"：这块是**单向、低频、有损**的推送，因为
 *  1) VPS 是无头 Linux，see-now 那种桌面插件在这上面根本跑不起来（源码里直接 reject）；
 *  2) 每帧几 MB 走一路实时流，对这台 2 核机器不划算；
 *  3) 她需要的不是"盯着看"，而是"问一句时能看见刚才发生了什么"。
 *
 * 因此这里最重要的一件事是**如实报告画面有多旧** —— 让她别把 8 分钟前的画面
 * 当成"现在"，那是比看不见更糟的错。
 */
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join, basename } from 'node:path'
import { note, serviceOf } from './env.js'
import { sniffImageMediaType } from './images.js'

const SCREEN_ROOT = process.env.QQ_SCREEN_DIR || `${QQ_WS}/屏幕`
const 来源表 = { 电脑: '', 手机: '手机' }
/** 来源名 → 目录。不认识的名字按「电脑」处理，别因为拼错就看不到。 */
function 源目录(source) {
  const 名 = String(source ?? '').trim() || '电脑'
  const 子 = Object.prototype.hasOwnProperty.call(来源表, 名) ? 来源表[名] : 来源表.电脑
  return 子 === '' ? SCREEN_ROOT : join(SCREEN_ROOT, 子)
}
/** 一次算出这个来源的三个路径。 */
function 源路径(source) {
  const 目录 = 源目录(source)
  return { 目录, 最新: join(目录, 'latest.png'), 历史: join(目录, 'history') }
}

/** 一次最多看几张：图大，模型的单请求图片数也有上限。 */
const MAX_FRAMES = 3
/** 超过这么久没新帧，就提示"本机大概没在推"，而不是当成"屏幕没变"。 */
const STALE_MS = 10 * 60 * 1000

/** PNG 尺寸（IHDR 在固定偏移）。读不出来就返回 null，不猜。 */
function pngSize(buf) {
  if (buf.length < 24) return null
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/** 图片尺寸：只保证 PNG；别的格式返回 null，不硬编。 */
function imageSize(buf, mediaType) {
  if (mediaType === 'image/png') return pngSize(buf)
  return null
}

/** 人话描述"多久以前"，越近越精确。 */
export function ageText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '时间不明'
  const sec = Math.floor(ms / 1000)
  if (sec < 10) return '刚刚'
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  return `${Math.floor(hour / 24)} 天前`
}

/**
 * 镜头现在有什么。
 *
 * @returns {object} 永远返回对象、不抛 —— 工具里抛错会变成一条难看的失败，
 *   而"没有画面"是一个正常的、需要好好说清楚的状态。
 */
export function screenStatus(now = Date.now(), source = '电脑') {
  const { 最新: LATEST, 历史: HISTORY } = 源路径(source)
  if (!existsSync(LATEST)) {
    return {
      ok: false,
      reason: 'empty',
      total: 0,
      message: `还没有任何${source === '手机' ? '手机' : '电脑'}屏幕画面。`
        + (source === '手机'
          ? `手机上那路还没推过 —— 需要先把它推到 屏幕/手机/。`
          : `主人电脑上的推送（screen-push）大概没在跑 —— 这不是"屏幕没变化"，而是"根本没在推"。要看得请他先启动那个进程。`),
    }
  }
  let st = null
  try { st = statSync(LATEST) } catch { /* 下面统一处理 */ }
  if (st === null) {
    return { ok: false, reason: 'unreadable', total: 0, message: '屏幕文件存在但读不到状态，可能正写到一半。稍等一下再试。' }
  }
  const ageMs = Math.max(0, now - st.mtimeMs)
  let total = 0
  try { total = readdirSync(HISTORY).filter((f) => f.endsWith('.png')).length } catch { /* 没有历史目录 */ }
  return {
    ok: true,
    reason: ageMs > STALE_MS ? 'stale' : 'fresh',
    ageMs,
    ageText: ageText(ageMs),
    bytes: st.size,
    total,
    stale: ageMs > STALE_MS,
    message: ageMs > STALE_MS
      ? `最近一张是 ${ageText(ageMs)} 的 —— 推送大概已经停了。别把它当成"现在"，可以照实说看不清现在的情况。`
      : `最近一张是 ${ageText(ageMs)} 的。`,
  }
}

/**
 * 取最近的几张帧（新的在前）。
 * @param {number} count 1..MAX_FRAMES
 */
export function pickFrames(count = 1, offset = 0, source = '电脑') {
  const { 最新: LATEST, 历史: HISTORY } = 源路径(source)
  const n = Math.max(1, Math.min(MAX_FRAMES, Number(count) || 1))
  // OFFSET 2026-11-14（批次480b）：主人 20:33「我滚动式翻书也没离谱到那么慢」。
  // 滚动看书的推送实测是 5.4 秒一帧，**连续帧**才看得出「滚到哪」；
  // 摊成均匀采样（3 张铺到 110 秒 = 每 54 秒一张）反而把中间 90% 漏掉，那个改动是错的。
  // 现在取连续的 n 张，要看更早的用 offset 往前翻 —— 她自己决定看多少段。
  const off = Math.max(0, Math.floor(Number(offset) || 0))
  const wanted = []
  if (existsSync(HISTORY)) {
    let files = []
    try { files = readdirSync(HISTORY).filter((f) => f.endsWith('.png')) } catch { files = [] }
    const withTime = files.map((f) => {
      const p = join(HISTORY, f)
      let mtimeMs = 0
      try { mtimeMs = statSync(p).mtimeMs } catch { /* 跳过坏的 */ }
      return { path: p, name: f, mtimeMs }
    }).filter((x) => x.mtimeMs > 0).sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const item of withTime.slice(off, off + n)) wanted.push(item)
  }
  // 历史为空（或不足）时退回 latest —— 只推过一张的情况下 history 可能还没建
  if (wanted.length === 0 && existsSync(LATEST)) {
    let mtimeMs = 0
    try { mtimeMs = statSync(LATEST).mtimeMs } catch { /* 忽略 */ }
    wanted.push({ path: LATEST, name: 'latest.png', mtimeMs })
  }
  return wanted
}

/** 读文件并认出媒体类型。认不出就跳过这张，不把垃圾塞给模型。 */
function readFrame(item) {
  let bytes = null
  try { bytes = readFileSync(item.path) } catch { return null }
  const mediaType = sniffImageMediaType(bytes)
  if (mediaType === null) return null
  const size = imageSize(bytes, mediaType)
  return {
    path: item.path,
    name: item.name,
    bytes,
    mediaType,
    width: size ? size.width : null,
    height: size ? size.height : null,
    ageMs: Math.max(0, Date.now() - item.mtimeMs),
  }
}

/** 把画面存进附件库，返回能放进 image 块的引用。 */
export async function attachFrames(ctx, frames) {
  const attachments = serviceOf(ctx, 'attachments')
  if (attachments === undefined || attachments === null || typeof attachments.saveImages !== 'function') {
    throw new Error('附件服务不可用，看不了屏幕画面')
  }
  const out = []
  for (const f of frames) {
    const refs = await attachments.saveImages([{
      data: f.bytes,
      mediaType: f.mediaType,
      name: `screen_${basename(f.name, '.png')}`,
    }])
    const ref = Array.isArray(refs) ? refs[0] : refs
    if (ref === undefined || ref === null) continue
    // width/height 可能读不出来（非 PNG）。schema 里声明的是 number，
    // 所以这里统一给 0 表示"不知道"，别塞 null 让宿主校验失败。
    out.push({
      ref,
      mediaType: f.mediaType,
      bytes: f.bytes.length,
      width: Number(f.width) || 0,
      height: Number(f.height) || 0,
      ageMs: f.ageMs,
    })
  }
  if (out.length === 0) throw new Error('画面存进附件库失败')
  return out
}

export async function registerScreenTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')

    const disposeTool = tools.register({
      name: 'qq_screen',
      description: "看主人屏幕的近期截图（source 区分电脑/手机），不是实时画面。问屏幕内容或报错时用；默认最新一张，count 连看，status 只查新旧。超过 10 分钟按旧画面处理。",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          count: { type: 'number', description: `可选；看几张，1~${MAX_FRAMES}，默认 1` },
          offset: { type: 'number', description: '可选；往前跳几张（0=最新）。' },
          source: { type: 'string', enum: ['电脑', '手机'], description: '可选；哪块屏，默认电脑。' },
          status: { type: 'boolean', description: '可选；只查多新，不送图。' },
        },
      },
      // 宿主的要求：render 必须在 output 里，且 output 要声明 schema。
      // schema 只描述**文字部分**；image 块不进 schema（跟 qq_face_preview 同一个做法）。
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            frames: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  // 附件引用字段随宿主版本变，不锁死
                  ref: { type: 'object', additionalProperties: true },
                  mediaType: { type: 'string' },
                  bytes: { type: 'number' },
                  width: { type: 'number' },
                  height: { type: 'number' },
                  ageMs: { type: 'number' },
                },
              },
            },
          },
        },
        render: (args, value) => {
        const frames = Array.isArray(value?.frames) ? value.frames : []
        if (frames.length === 0) {
          return [{ type: 'text', text: value?.message ?? '没有可看的画面' }]
        }
        const blocks = []
        for (const f of frames) blocks.push({ type: 'image', attachment: f.ref })
        const lines = frames.map((f, i) => {
          const size = f.width && f.height ? `${f.width}×${f.height}` : '尺寸未知'
          return `画面 ${i + 1}：${ageText(f.ageMs)}，${size}，${Math.round(f.bytes / 1024)}KB`
        })
        blocks.unshift({
          type: 'text',
          text: `${value?.message ?? ''}\n${lines.join('\n')}\n`
            + '（这是主人电脑屏幕的截图，不是实时流。按画面实际内容说话，看不清就说看不清。）',
        })
        return blocks
        },
      },
      execute: async (args) => {
        const 源 = String(args?.source ?? '').trim() || '电脑'
        const status = screenStatus(Date.now(), 源)
        if (!status.ok) {
          return { ok: false, frames: [], message: status.message }
        }
        if (args?.status === true) {
          return {
            ok: true,
            frames: [],
            message: `${status.message}（历史共 ${status.total} 张，可用 count 调更多）`,
          }
        }
        const picked = pickFrames(args?.count, args?.offset, 源)
        if (picked.length === 0) {
          return { ok: false, frames: [], message: '屏幕目录里没有能读的画面。' }
        }
        const read = picked.map(readFrame).filter((x) => x !== null)
        if (read.length === 0) {
          return { ok: false, frames: [], message: '画面文件读不出来（可能不是图片）。' }
        }
        const attached = await attachFrames(ctx, read)
        note('screen', `看了 ${attached.length} 张屏幕画面，最新 ${ageText(attached[0].ageMs)}`)
        return {
          ok: true,
          frames: attached,
          message: status.stale
            ? `注意：${status.message}`
            : `看了最近 ${attached.length} 张画面。`,
        }
      },
    })
    note('tool', 'qq_screen registered')
    return () => { try { disposeTool() } catch { /* 已经销毁 */ } }
  } catch (error) {
    note('tool', `qq_screen 注册失败：${error?.message ?? error}`)
  }
}
