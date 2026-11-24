/**
 * files.js —— QQ 文件 -> 落盘 + 文本注入（2026-11-05 批次90）
 *
 * 主人发了一个 x.txt（推特 cookie），她只收到一个「[文件]」的壳：
 * 段类型翻译成 [文件] 是对的，但谁也没去把内容取下来。
 * 她要「把那串 cookie 贴出来用」，手里却没有那个文件 —— 只能让人重发。
 *
 * 这里做三件事：
 *   1. 找到文件：段里带 url 就直接下；只带 file_id 就问 NapCat（get_file / get_group_file_url）。
 *   2. 落一份副本到 <工作区>/收到的文件/，人翻得到，她也拿得到路径。
 *   3. 是文本（txt/md/json/csv…）且不超过 64KB，就把内容作为一段文字投进会话，
 *      标明「这是他发来的文件内容，不是他说的话」——她才能真读到那段 cookie。
 *
 * 取不到就如实说取不到，不假装收到过。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { getConfig } from './config.js'
import { note, bjDate, DATA_DIR } from './env.js'
import { callOneBot } from './onebot.js'

// 只认这些后缀当文本；其余一律按二进制处理（给路径，不乱读）。
const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'jsonl', 'csv', 'tsv', 'log', 'ini', 'conf', 'cfg',
  'yml', 'yaml', 'toml', 'env', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'py', 'sh', 'bat', 'ps1',
  'html', 'htm', 'css', 'xml', 'sql', 'srt', 'ass', 'vtt', 'properties', 'gitignore',
])
const MAX_TEXT_BYTES = 64 * 1024
// 单个文件最多下 10MB。NapCat 的 get_file 实测**不认 file_id**：
// 拿一个不存在的 id 去问，它照样回上一个文件的本地路径（实测回来一个 95MB 的 rar）。
// 不设上限的话，一次错 id 就能把 95MB 读进内存、还往她的收件目录里塞一份。
const MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024
const MAX_VIDEO_DOWNLOAD_BYTES = 80 * 1024 * 1024

/** 段的 data 可能有两种形状：扁平（{file,file_id,url}）或嵌套（{file:{name,size,url},file_id}）。 */
export function metaOf(segment) {
  const d = segment?.data ?? {}
  const inner = d.file && typeof d.file === 'object' ? d.file : {}
  const name = String(
    d.file_name ?? inner.name ?? (typeof d.file === 'string' ? d.file : '') ?? d.name ?? ''
  ).trim()
  const size = Number(d.file_size ?? inner.size ?? 0) || 0
  const url = String(d.url ?? inner.url ?? '').trim()
  const fileId = String(d.file_id ?? inner.file_id ?? inner.uuid ?? inner.id ?? '').trim()
  const busid = Number(d.busid ?? inner.busid ?? 0) || 0
  return { name, size, url, fileId, busid }
}

/** 这条消息里的文件段。 */
export function fileSegmentsOf(message) {
  if (!Array.isArray(message)) return []
  return message
    .filter((s) => s?.type === 'file')
    .map((s) => ({ ...metaOf(s), isVideo: false }))
    .filter((m) => m.name !== '' || m.fileId !== '' || m.url !== '')
}

/** QQ 视频段（type === 'video'）：单独落盘到 下载/ 供 qq_watch_video 调阅。 */
export function videoSegmentsOf(message) {
  if (!Array.isArray(message)) return []
  return message
    .filter((s) => s?.type === 'video')
    .map((s) => {
      const m = metaOf(s)
      let name = m.name
      if (!name) name = '视频.mp4'
      else if (!/\.(mp4|mov|mkv|webm|avi|flv)$/i.test(name)) name += '.mp4'
      return { ...m, name, isVideo: true }
    })
    .filter((m) => m.fileId !== '' || m.url !== '')
}

function safeName(name) {
  const b = basename(String(name || '').replace(/\\/g, '/'))
  const cleaned = b.replace(/[<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim()
  return cleaned === '' ? '文件' : cleaned.slice(0, 80)
}

function copyDirOf() {
  const config = getConfig() || {}
  const configured = String(config.fileCopyDir ?? '').trim()
  if (configured.toLowerCase() === 'off') return ''
  if (configured !== '') return configured
  return join(String(config.workspaceCwd ?? '') || DATA_DIR, '收到的文件')
}

function stamp() {
  const d = bjDate()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`
}

function isHttp(url) {
  return /^https?:\/\//i.test(String(url || ''))
}

/**
 * 把「从哪儿取」收敛成一个能读的来源。
 * NapCat4 的 get_file 有时把 url 直接给成本机路径（协议端和插件同机），这也算拿得到。
 */
async function resolveSource(meta, kind, id) {
  if (isHttp(meta.url)) return { url: meta.url }
  if (meta.url !== '') {
    const p = meta.url.replace(/^file:\/\//i, '')
    if (existsSync(p)) return { path: p }
  }
  if (meta.fileId !== '') {
    const tries = []
    if (kind === 'group') {
      tries.push({ action: 'get_group_file_url', params: { group_id: Number(id), file_id: meta.fileId, busid: meta.busid || 0 } })
    } else if (Number(id) > 0) {
      tries.push({ action: 'get_private_file_url', params: { user_id: Number(id), file_id: meta.fileId } })
    }
    tries.push({ action: 'get_file', params: { file_id: meta.fileId, file_name: meta.name || undefined } })
    for (const t of tries) {
      try {
        const r = await callOneBot(t)
        const d = r?.data ?? {}
        const 回来的名 = String(d.file_name ?? '').trim()
        if (回来的名 !== '' && meta.name !== '' && 回来的名 !== meta.name) {
          note('file', `${t.action} 回来的不是这个文件（要 ${meta.name}，给 ${回来的名}），丢掉`)
          continue
        }
        if (typeof d.base64 === 'string' && d.base64.length > 0) {
          return { bytes: new Uint8Array(Buffer.from(d.base64, 'base64')) }
        }
        const u = String(d.url ?? d.file ?? '').trim()
        if (u === '') continue
        if (isHttp(u)) return { url: u }
        const p = u.replace(/^file:\/\//i, '')
        if (existsSync(p)) return { path: p }
        return { url: u }
      } catch (error) {
        note('file', `${t.action} 失败（${meta.name || meta.fileId}）：${error instanceof Error ? error.message : error}`)
      }
    }
  }
  return null
}

async function readSource(src, timeoutMs, maxBytes = MAX_DOWNLOAD_BYTES) {
  if (src.bytes) {
    if (src.bytes.length > maxBytes) throw new Error(`文件太大（${sizeWords(src.bytes.length)}），没下`)
    return src.bytes
  }
  if (src.path) {
    const sz = statSync(src.path).size
    if (sz > maxBytes) throw new Error(`文件太大（${sizeWords(sz)}），没下`)
    return new Uint8Array(readFileSync(src.path))
  }
  const response = await fetch(src.url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) throw new Error(`下载失败 HTTP ${response.status}`)
  const len = Number(response.headers.get('content-length') ?? 0)
  if (len > maxBytes) throw new Error(`文件太大（${sizeWords(len)}），没下`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length > maxBytes) throw new Error(`文件太大（${sizeWords(bytes.length)}），没下`)
  return bytes
}

/** 像不像文本：先看后缀，后缀不认识再看内容有没有 NUL / 大量替换符。 */
export function looksText(name, bytes) {
  const ext = String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? ''
  if (TEXT_EXT.has(ext)) return true
  if (bytes.length === 0) return false
  const head = bytes.subarray(0, Math.min(4096, bytes.length))
  for (const b of head) if (b === 0) return false
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head)
  const bad = (text.match(/\uFFFD/g) || []).length
  return text.length > 0 && bad / text.length < 0.02
}

function sizeWords(n) {
  if (!n) return ''
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/**
 * 把消息里的文件取下来。
 * 返回可以直接塞进 content 的 text 块 —— 跟图片块一样，都是「补在正文后面的东西」。
 * 任何一步失败都只记日志、返回一句人话，不影响主链路。
 */
export async function buildFileBlocks(ctx, messages) {
  const config = getConfig() || {}
  const timeoutMs = Math.max(5000, Number(config.requestTimeoutMs) * 2 || 16000)
  const blocks = []
  for (const item of messages) {
    const rawSegs = Array.isArray(item) ? item : item?.message
    const segs = [...fileSegmentsOf(rawSegs), ...videoSegmentsOf(rawSegs)]
    if (segs.length === 0) continue
    const kind = item?.message_type === 'group' || item?.group_id ? 'group' : 'private'
    const id = kind === 'group' ? String(item?.group_id ?? '') : String(item?.sender?.user_id ?? item?.user_id ?? '')
    for (const meta of segs) {
      const isVid = Boolean(meta.isVideo) || /\.(mp4|mov|mkv|webm)$/i.test(String(meta.name || ''))
      const limitBytes = isVid ? MAX_VIDEO_DOWNLOAD_BYTES : MAX_DOWNLOAD_BYTES
      const name = safeName(meta.name || (isVid ? '视频.mp4' : '文件'))
      const 尺寸 = sizeWords(meta.size)
      try {
        if (meta.size > limitBytes) throw new Error(`文件太大（${sizeWords(meta.size)}），没下`)
        const src = await resolveSource(meta, kind, id)
        if (src === null) throw new Error('协议端没给下载地址（可能过期了）')
        const bytes = await readSource(src, isVid ? Math.max(timeoutMs, 60000) : timeoutMs, limitBytes)
        let saved = ''
        const dir = isVid ? join(String(config.workspaceCwd ?? '') || DATA_DIR, '下载') : copyDirOf()
        if (dir !== '') {
          try {
            mkdirSync(dir, { recursive: true })
            saved = join(dir, `${stamp()}_${name}`)
            writeFileSync(saved, bytes)
          } catch (error) {
            saved = ''
            note('file', `副本没落下来（${name}）：${error instanceof Error ? error.message : error}`)
          }
        }
        const realBytes = bytes.length
        // 显示用 QQ 报的大小（那是人看到的），实际读进来多少只管「要不要塞进上下文」。
        const 显示 = meta.size || realBytes
        const where = saved !== '' ? `，已存到 ${saved}` : ''
        if (looksText(name, bytes) && realBytes <= MAX_TEXT_BYTES) {
          let text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
          text = text.replace(/^\uFEFF/, '')
          blocks.push({
            type: 'text',
            text: `[他发来一个文件：${name}（${sizeWords(显示)}）${where}]\n`
              + `—— 下面是文件内容，不是他说的话 ——\n`
              + text
              + `\n—— 文件内容到此为止（${name}）——`,
          })
        } else if (isVid) {
          blocks.push({ type: 'text', text: `[他发来一段视频：${name}（${sizeWords(显示)}）${where}；要用眼睛看画面和听声音，请调 qq_watch_video 工具传 video="${saved}"]` })
        } else {
          const why = looksText(name, bytes)
            ? `太大（${sizeWords(显示)}，超过 64KB），没往会话里塞`
            : '不是能直接读的文本'
          blocks.push({ type: 'text', text: `[他发来一个文件：${name}（${sizeWords(显示)}）${where}；${why}]` })
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        note('file', `文件没取下来（${name}）：${msg}`)
        blocks.push({ type: 'text', text: `[他发来一个文件：${name}${尺寸 ? `（${尺寸}）` : ''}，但这边没取下来（${msg}）]` })
      }
    }
  }
  return blocks
}
