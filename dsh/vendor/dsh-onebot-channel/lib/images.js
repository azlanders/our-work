import { atomicWriteFileSync } from './atomic-fs.js'
/**
 * images.js —— QQ 图片 -> DSH 附件库 -> image 块。
 *
 * 会话格式是 { type:'image', attachment: ImageAttachmentRef }（dsh 的 wire schema 里 image 是一等块类型），
 * 图片本体走 attachments.saveImages() 存内容寻址附件库，块里只放引用。
 * 模型侧 supportsImages: true，这样投进去 AI 是真能看见图的，不是只看到 [图片] 四个字。
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { getConfig } from './config.js'
import { note, serviceOf, bjDate } from './env.js'
import { DATA_DIR } from './env.js'

/** 按内容嗅探媒体类型 —— 别信 URL 后缀，QQ 的下载链接不带扩展名。 */
export function sniffImageMediaType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return 'image/gif'
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp'
  return null
}

/** 媒体类型 → 文件扩展名。 */
export function extOfMediaType(mediaType) {
  return { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp' }[mediaType] ?? 'jpg'
}

/**
 * 改写文件名里的扩展名。
 * QQ 给的文件名永远是 <MD5>.jpg，但内容可能是 GIF / PNG —— 以真实格式为准。
 */
export function withExt(name, ext) {
  const s = String(name ?? '').trim()
  if (s === '') return `image.${ext}`
  // 2026-11-04 修：点开头的名字（'.jpg'）没有真正的扩展名。
  // 原来的正则会把整个名字当成后缀吃掉，结果只剩 '.png' —— 名字整个没了。
  const dot = s.lastIndexOf('.')
  if (dot <= 0) return `${s}.${ext}`
  return `${s.slice(0, dot)}.${ext}`
}

/** 这条消息里能下载的图片段。 */
export function imageSegmentsOf(message) {
  if (!Array.isArray(message)) return []
  const list = []
  for (const segment of message) {
    if (segment?.type !== 'image') continue
    const url = String(segment?.data?.url ?? '')
    if (url === '') continue
    list.push({ url, file: String(segment?.data?.file ?? '') })
  }
  return list
}

/**
 * 图片图鉴（IMG_MEMORY 批次519）—— 同一张图她到底见过没有。
 *
 * 为什么要有：主人 2026-11-16 说「发过的表情包她每次都像第一次看见」。
 * 实测「收到的图片」41 个文件里只有 27 张不同的图，13 组重复，最多的一张（顶盆那只）
 * 被存了 3 次（11-15 18:52 / 11-16 01:11 / 11-16 04:01）—— 她三次都当新图看，
 * 而那张图她在 01:21 还亲自起过名字叫「紫鸟翘脚站桩」。
 *
 * 键用 QQ 文件名里的 MD5（`<MD5>.jpg`），没有就退回内容的 md5。稳定、跨会话可用。
 * 沙盒变量 QQ_IMG_MEM：测试时不碰她真实的 看图记录.json。
 */
function 图鉴目录() {
  return process.env.QQ_IMG_MEM
    || join(String(getConfig()?.workspaceCwd ?? '') || DATA_DIR, '记忆')
}

export function 读图鉴() {
  try {
    const p = join(图鉴目录(), '看图记录.json')
    if (!existsSync(p)) return {}
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return j !== null && typeof j === 'object' ? j : {}
  } catch { return {} }
}

function 存图鉴(o) {
  try {
    const p = join(图鉴目录(), '看图记录.json')
    mkdirSync(dirname(p), { recursive: true })
    atomicWriteFileSync(p, JSON.stringify(o, null, 1))
    return true
  } catch { return false }
}

/** 这张图的指纹：优先 QQ 给的文件名（它本身就是 MD5），退回内容哈希。 */
export function 图的指纹(seg, data) {
  const m = String(seg?.file ?? '').trim().match(/^([0-9A-Fa-f]{16,})\./)
  if (m) return m[1].toUpperCase()
  try { return createHash('md5').update(data).digest('hex').toUpperCase() } catch { return '' }
}

/** 查这张图见过没有；没见过返回 null。 */
export function 见过这张图(指纹) {
  if (String(指纹 ?? '') === '') return null
  const v = 读图鉴()[指纹]
  if (v === null || typeof v !== 'object') return null
  return { ...v, 次数: Number(v.次数) || 1 }
}

/** 记一次「看见」。返回更新后的记录。 */
export function 记看图(指纹, opt = {}) {
  if (String(指纹 ?? '') === '') return null
  const j = 读图鉴()
  const 旧 = j[指纹] !== null && typeof j[指纹] === 'object' ? j[指纹] : null
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  const 新 = 旧
    ? { ...旧, 次数: (Number(旧.次数) || 1) + 1, 最近: now }
    : { 首次: now, 最近: now, 次数: 1 }
  if (旧 === null && String(opt.uin ?? '') !== '') 新.uin = String(opt.uin)
  if (String(opt.名字 ?? '') !== '') 新.名字 = String(opt.名字)
  if (String(opt.路径 ?? '') !== '') 新.路径 = String(opt.路径)
  j[指纹] = 新
  存图鉴(j)
  return 新
}

/**
 * 从落盘路径里取指纹。文件名形如 `<stamp>_<uin>_<MD5>.<ext>`。
 *
 * 为什么要从路径取而不是从 seg 取：`listRecentImages()` 里存的是 path，
 * 她调 qq_image_note 不传 md5 时，只能靠这个把「最近那张」对回图鉴。
 */
export function 路径的指纹(p) {
  const m = String(p ?? '').split('/').pop().match(/_([0-9A-Fa-f]{16,})\.[a-z0-9]+$/i)
  return m ? m[1].toUpperCase() : ''
}

/**
 * 给一张图记「它里面是什么」（IMAGE_NOTE 批次520）。
 *
 * 为什么需要：图鉴原来只存 md5 + 名字，没有内容。同一张顶盆图她起过两个名字
 * （「顶盆站桩不吭声」→「紫鸟翘脚站桩」），因为每次都重新识别、没有上次的结论可对。
 * 主人 04:32 选的方案 B：给她一个工具直接写，不用记命令。
 *
 * 不传指纹时用「最近收到的那张」；允许只给前 6 位以上前缀（唯一才认）。
 */
export function 记图片描述(指纹, 描述) {
  const 描 = String(描述 ?? '').trim()
  if (描 === '') return { ok: false, why: '描述是空的，没记' }
  if (描.length > 300) return { ok: false, why: '描述太长了（>300 字），挑重点' }
  const j = 读图鉴()
  let 键 = String(指纹 ?? '').trim().toUpperCase()
  if (键 === '') {
    const 最 = listRecentImages(1)[0]
    键 = 路径的指纹(最?.path)
    if (键 === '') return { ok: false, why: '手上没有刚收到的图，得给 md5（文件名里那串）' }
  }
  if (j[键] === undefined && 键.length >= 6) {
    const 命中 = Object.keys(j).filter((k) => k.startsWith(键))
    if (命中.length === 1) 键 = 命中[0]
    else if (命中.length > 1) return { ok: false, why: '这个前缀对上多张，给长一点：' + 命中.slice(0, 3).join('、') }
  }
  const 旧 = j[键] !== null && typeof j[键] === 'object' ? j[键] : { 首次: '', 最近: '', 次数: 1 }
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  j[键] = { ...旧, 描述: 描, 描述于: now }
  存图鉴(j)
  return { ok: true, md5: 键, desc: 描, 是新的: 旧.首次 === '' }
}

/** 图片副本目录：默认 <workspaceCwd>\收到的图片；配置 imageCopyDir 可改，设 "off" 关掉。 */
function imageCopyDirOf() {
  const config = getConfig()
  const configured = String(config.imageCopyDir ?? '').trim()
  if (configured.toLowerCase() === 'off') return ''
  if (configured !== '') return configured
  return join(String(config.workspaceCwd ?? '') || DATA_DIR, '收到的图片')
}

/**
 * 落一份人能看的副本（带时间戳命名），返回保存路径。
 * 跟附件库互不影响：哪边失败都不耽误另一边，更不耽误主链路。
 */
/**
 * 这张图是不是她自己发的（SELF_IMAGE 批次515）。
 *
 * 抽成纯函数是因为边界全在字符串上：selfUin 配成 0 / 空 / 数字 / 字符串，
 * uin 可能是 undefined。判错一次就变成「所有图都不存」或「照存不误」，
 * 这两种都不报错，只会让「收到的图片」慢慢失真 —— 所以边界必须被单测钉住。
 */
export function 是自己发的图片(uin, selfUin) {
  const self = String(selfUin ?? '').trim()
  if (self === '' || self === '0') return false
  return String(uin ?? '').trim() === self
}

function saveImageCopy(data, mediaType, seg, uin) {
  const dir = imageCopyDirOf()
  if (dir === '') return ''
  // SELF_IMAGE 2026-11-16（批次515）：主人引用回复她自己发的图时，那张图也会走这条链路。
  // 结果「收到的图片」里混进 4 张她自己发的（同 md5 的还存了两份，占 1.3MB），
  // 而且会进 recentImages 索引 —— 她「最近收到的第 N 张」于是拿到自己的图，
  // 01:12 她照着这个索引整理收藏夹，删掉的正是一张自己刚发过的。
  // 只跳过「落副本 + 进索引」；附件库那边照旧，AI 该看到还是看得到。
  if (是自己发的图片(uin, getConfig()?.selfUin)) return ''
  // DEDUP 2026-11-16（批次519）：同一张图别再存第二份 —— 41 个文件里 14 份是重复的。
  // 命中时记得把「最近收到的图片」索引也刷一下（她刚收到，索引该变新）。
  const 指纹 = 图的指纹(seg, data)
  const 旧 = 见过这张图(指纹)
  if (旧 !== null && String(旧.路径 ?? '') !== '' && existsSync(String(旧.路径))) {
    try {
      rememberImage({
        path: String(旧.路径),
        url: String(seg?.url ?? ''),
        uin,
        name: String(旧.路径).split('/').pop() ?? '',
        at: Date.now(),
      })
    } catch { /* 索引失败不影响主链路 */ }
    记看图(指纹, { uin, 名字: String(旧.名字 ?? ''), 路径: String(旧.路径) })
    note('image', `同一张图（第 ${(Number(旧.次数) || 1) + 1} 次），不重复存：${String(旧.路径)}`)
    return String(旧.路径)
  }
  try {
    mkdirSync(dir, { recursive: true })
    const ext = extOfMediaType(mediaType)
    // 2026-11-04 修：这里原来用 new Date() 取本地时间，而机器跑在 UTC ——
    // 落盘的文件名比北京时间早 8 小时，人翻「收到的图片」目录时对不上自己发图的时间。
    // 项目里其它地方一律按 +8 处理，这里跟上。
    const now = bjDate() // 2026-11-04：原来这里自己加八小时，收拢到 env.js
    const pad = (n) => String(n).padStart(2, '0')
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
    // 原名是 QQ 的哈希名，前面加时间戳和来源 QQ 号，既不重名也能一眼看出是谁发的
    const original = String(seg?.file ?? '').replace(/[\\/:*?"<>|]/g, '_').trim()
    const base = original !== ''
      ? original
      : `${createHash('sha256').update(data).digest('hex').slice(0, 8)}.${ext}`
    // ⚠️ 扩展名**按真实格式**改写，不沿用 QQ 给的那个。
    //   QQ 发来的表情包文件名一律是 <MD5>.jpg，但内容经常是 GIF（QQ 商城表情基本都是 GIF）。
    //   之前原样保留 .jpg，导致「看到的格式」和「实际格式」对不上 ——
    //   收藏夹里存进去的 GIF 顶着 .jpg 的名字，AI 看图时也认不出是动图。
    const path = join(dir, `${stamp}_${uin}_${withExt(base, ext)}`)
    atomicWriteFileSync(path, data)
    note('image', `副本已存 ${path}`)
    // 记进「最近收到的图片」索引 —— 收藏表情包时要用它拿本地路径。
    // name 用**落盘后的真实文件名**（扩展名已按真实格式修正），别用 QQ 原始的 .jpg 名。
    rememberImage({ path, url: String(seg?.url ?? ''), uin, name: withExt(base, ext), at: Date.now() })
    记看图(指纹, { uin, 路径: path })
    return path
  } catch (error) {
    note('image', `副本保存失败 ${error instanceof Error ? error.message : error}`)
    return ''
  }
}

/**
 * 最近收到的图片索引（内存环形缓冲，最多 60 张）。
 *
 * 干什么用：树树在教 DSH 认表情包 —— 她收到图片后要能把它**存进 QQ 收藏夹**。
 * 协议端的 add_custom_face 要的是一个「它能读到的图片源」：
 *   - http(s):// —— QQ 的图片直链，**带 rkey 有时效**，过一会儿就失效
 *   - file://    —— 本地文件（协议端跟插件同机，能直接读）
 *   - base64://  —— 内联字节
 * 所以最稳的是用本地副本路径。这个索引就是给「引用最近第 N 张图」用的。
 */
const RECENT_LIMIT = 60
const recentImages = []

/** 记一张收到的图片。 */
function rememberImage(item) {
  recentImages.push(item)
  while (recentImages.length > RECENT_LIMIT) recentImages.shift()
}

/**
 * 取最近收到的图片。
 *
 * @param {number} [index=1] 1 = 最近一张，2 = 倒数第二张，以此类推
 * @returns {object|null} { path, url, uin, name, at }
 */
export function recentImage(index = 1) {
  const n = Math.max(1, Number(index) || 1)
  const item = recentImages[recentImages.length - n]
  return item ?? null
}

/** 最近收到的图片列表（新的在前）。 */
export function listRecentImages(limit = 10) {
  const n = Math.max(1, Math.min(RECENT_LIMIT, Number(limit) || 10))
  return recentImages.slice(-n).reverse()
}

/**
 * 把消息里的图片下载下来：存进 DSH 附件库（AI 能看）+ 落一份副本（人能翻）。
 * 传进来的是一条条消息对象（{ message: [段] }），真正要扫的是里面的段数组。
 * 任何一步失败都只记日志、返回空 —— 文本里已有 [图片] 占位，主链路不受影响。
 */
/** QQ 图片动辄 1MB+，原样进上下文一次就能烧掉上百万 token。
 *  人翻的副本留原图；进 AI 侧的缩成长边 ≤1024 的 JPEG，缩不动才回退原图。 */
export function 压上下文图(data, mediaType) {
  const 原字节 = data.length
  if (原字节 <= 150_000) return { data, mediaType, 原字节, 缩字节: 原字节 }
  let 最后一档 = null
  for (const 宽 of [1024, 768, 560]) {
    try {
      const out = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0',
        '-vf', `scale=min(${宽}\\,iw):-2`, '-q:v', '5', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { input: Buffer.from(data), timeout: 15000, maxBuffer: 16 * 1024 * 1024 })
      if (out.length === 0) continue
      最后一档 = { data: new Uint8Array(out), mediaType: 'image/jpeg', 原字节, 缩字节: out.length }
      if (out.length <= 200_000) return 最后一档
    } catch { /* 这一档缩不动就试更小的一档 */ }
  }
  return 最后一档 ?? { data, mediaType, 原字节, 缩字节: 原字节 }
}

export async function buildImageBlocks(ctx, messages) {
  const blocks = []
  const config = getConfig()
  let attachments = null
  try {
    attachments = serviceOf(ctx, 'attachments')
  } catch {
    attachments = null
  }
  const canAttach = attachments !== undefined && attachments !== null && typeof attachments.saveImages === 'function'
  const segmentsOf = (item) => imageSegmentsOf(Array.isArray(item) ? item : item?.message)
  if (!canAttach && messages.some((item) => segmentsOf(item).length > 0)) {
    note('image', 'attachments 服务不可用，图片只存副本，AI 侧退化成 [图片] 占位')
  }
  for (const item of messages) {
    const uin = String(item?.sender?.user_id ?? '')
    for (const seg of segmentsOf(item)) {
      try {
        // QQ 图片链接带 rkey 有时效，拿到就得立刻下载。
        // 必须带超时：这里卡住会连坐整个私聊轮询链（自调度循环等它跑完），
        // 图床挂死时表现就是「这个号从此再不收消息」。跟 callOneBot 一个口径。
        const response = await fetch(seg.url, {
          headers: { 'User-Agent': 'Mozilla/5.0' },
          signal: AbortSignal.timeout(Math.max(5000, Number(config.requestTimeoutMs) * 2 || 16000))
        })
        if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
        const data = new Uint8Array(await response.arrayBuffer())
        const mediaType = sniffImageMediaType(data)
        if (mediaType === null) throw new Error(`认不出的图片格式（${data.length} 字节）`)
        // ALLOW 批次519：先查图鉴，再落盘（saveImageCopy 里去重）。
        // 认识的图要**在图片前面插一句身份** —— 她认不出「顶盆那只」正是因为她只收到一张裸图。
        const 指纹 = 图的指纹(seg, data)
        const 旧 = 见过这张图(指纹)
        if (旧 !== null) {
          const 名字 = String(旧.名字 ?? '').trim()
          const 描述 = String(旧.描述 ?? '').trim()
          const 次 = (Number(旧.次数) || 1) + 1
          const 末 = String(旧.最近 ?? '').trim()
          blocks.push({
            type: 'text',
            text: '（你见过这张图' + (名字 !== '' ? `，你自己给它起过名字「${名字}」` : '')
              + `：这是第 ${次} 次看到，最早一次是 ${String(旧.首次 ?? '?')}`
              + (末 !== '' ? `，上次是 ${末}` : '')
              + '。'
              + (描述 !== '' ? `你当时看出的内容：「${描述}」。` : '（你还没记过它里面是什么。）')
              + '别当成新图。）',
          })
        } else if (指纹 !== '') {
          // 新图：提醒她看完记一句，下次就认得
          blocks.push({
            type: 'text',
            text: '（这张是第一次见。看出它里面是什么之后，用 qq_image_note 记一句，'
              + '下次同一张再来你就认得了 —— 不记的话每次都当新图。）',
          })
        }
        saveImageCopy(data, mediaType, seg, uin)
        if (!canAttach) continue
        const 上下文 = 压上下文图(data, mediaType)
        const refs = await attachments.saveImages([{ data: 上下文.data, mediaType: 上下文.mediaType, name: seg.file !== '' ? seg.file : undefined }])
        if (上下文.缩字节 < 上下文.原字节) {
          note('image', `进上下文压缩 ${Math.round(上下文.原字节 / 1024)}KB → ${Math.round(上下文.缩字节 / 1024)}KB`)
        }
        for (const ref of refs) blocks.push({ type: 'image', attachment: ref })
      } catch (error) {
        note('image', `图片入库失败（${seg.file || seg.url.slice(0, 60)}）：${error instanceof Error ? error.message : error}`)
      }
    }
  }
  return blocks
}
