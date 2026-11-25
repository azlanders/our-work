/**
 * custom-faces.js —— QQ 收藏表情（商城大表情 / 收藏表情包）的列举、查找与发送。
 */
import { callOneBot, deliverOneBot, DELIVERY_REJECTED } from './onebot.js'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { getConfig } from './config.js'
import { note } from './env.js'
import { resolveSendTarget } from './target.js'
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const IMG_DIRS = [
  `${QQ_WS}/收到的图片`,
  `${QQ_WS}/记忆/归档/收到的图片-重复`,
]

function namesFile() {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'qq-bridge-emoji-names.json')
}

export function readFaceNames() {
  try {
    const file = namesFile()
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function saveFaceName(emojiId, name, filePath = '') {
  const id = String(emojiId ?? '').trim()
  const label = String(name ?? '').trim()
  if (id === '' || label === '') return false
  try {
    const all = readFaceNames()
    const prev = all[id] && typeof all[id] === 'object' ? all[id] : {}
    const resolvedPath = String(filePath || prev.path || '').trim()
    all[id] = { name: label, at: Date.now(), ...(resolvedPath ? { path: resolvedPath } : {}) }
    writeFileSync(namesFile(), JSON.stringify(all, null, 1), 'utf8')
    return true
  } catch {
    return false
  }
}

/** 记忆目录：和 poll.js 一个口径，测试/二号机都能指走。 */
function 记忆目录() {
  return process.env.QQ_MEM || `${QQ_WS}/记忆`
}

export function 读表情用过() {
  try {
    const parsed = JSON.parse(readFileSync(join(记忆目录(), '表情用过.json'), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 记一次「这张表情真的发出去了」。
 *
 * 2026-11-14：主人连着说了三次「怎么老是用这个表情包」「不是给你挺多的表情包了吗」。
 * 原来系统里**没有任何地方记她用过哪张**，她只能凭印象挑，结果一张用到腻。
 * 现在按「名字 → 时间」记，voiceSlots 靠它把两小时内用过的名字从候选里剔掉。
 * 存名字不存 emoji_id：她看到的、说出口的都是名字。
 */
export function recordFaceUse(emojiId) {
  const id = String(emojiId ?? '').trim()
  if (id === '') return false
  try {
    const 名 = String(readFaceNames()[id]?.name ?? '').trim()
    if (名 === '') return false
    const all = 读表情用过()
    all[名] = Date.now()
    // 只留最近 40 个名字 —— 这不是账本，是「最近用过谁」
    const 键 = Object.keys(all).sort((a, b) => Number(all[b]) - Number(all[a]))
    for (const k of 键.slice(40)) delete all[k]
    writeFileSync(join(记忆目录(), '表情用过.json'), JSON.stringify(all, null, 1), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 把本地命名表的名字补进 NapCat 返回的收藏列表。
 *
 * 2026-11-14 的根因就在这一条：`fetch_custom_face_detail` 返回的 22 条里
 * **没有 summary / desc 字段**（协议端不支持给收藏表情改名），而原来写的是
 * `remote.length > 0 ? remote : localNamedList(limit)` —— 远端只要有数据就不看本地表，
 * 于是她起的 17 个名字全被丢掉，`收藏表情候选` 永远是空的。
 * 表现就是她说的「大半连名字都没有，我认不出来，能叫上名的就那两三张」。
 */
export function mergeFaceNames(remote, names) {
  const 表 = names !== null && typeof names === 'object' ? names : {}
  return (Array.isArray(remote) ? remote : []).map((row) => {
    const id = String(row?.emojiId ?? '').trim()
    const 本地名 = String((id !== '' ? 表[id]?.name : '') ?? '').trim()
    const 名 = String(row?.summary ?? '').trim() || String(row?.desc ?? '').trim() || 本地名
    // 场合标签（委屈/被气到/没话接/好吃）也只存在本地表里 —— 协议端连名字都不给，更别说这个。
    // 她 2026-11-14 11:39 自己说的「我按脸上的样子认，不按场合挑」，缺的就是这一层。
    const 标签 = String((id !== '' ? 表[id]?.tag : '') ?? '').trim()
    return { ...row, summary: 名, desc: 名, ...(标签 !== '' ? { tag: 标签 } : {}) }
  })
}

export function resolveLocalFacePath(emojiId) {
  const id = String(emojiId ?? '').trim()
  if (id === '') return ''
  if (id.startsWith('/') && existsSync(id)) return id
  const all = readFaceNames()
  const entry = all[id]
  if (entry?.path && existsSync(entry.path)) return String(entry.path)
  // 从 emojiId 提取哈希段去 收到的图片/ 目录匹配
  const parts = id.split('_').filter((p) => p.length >= 8 && p !== '3556352474')
  const hash = (parts.length > 0 ? parts[parts.length - 1] : id).toLowerCase()
  if (hash.length >= 6) {
    for (const dir of IMG_DIRS) {
      if (!existsSync(dir)) continue
      try {
        const files = readdirSync(dir)
        for (let i = files.length - 1; i >= 0; i--) {
          if (files[i].toLowerCase().includes(hash)) {
            return join(dir, files[i])
          }
        }
      } catch (_err) { console.error('[onebot:custom-faces]', _err?.message || _err) }
    }
  }
  return ''
}

function localNamedList(limit = 50) {
  const names = readFaceNames()
  return Object.entries(names)
    .sort((a, b) => Number(b[1]?.at || 0) - Number(a[1]?.at || 0))
    .map(([emojiId, val]) => {
      const label = String(val?.name ?? '').trim()
      const emoPath = resolveLocalFacePath(emojiId)
      const 标签 = String(val?.tag ?? '').trim()
      return {
        emojiId,
        url: '',
        emoPath,
        summary: label,
        desc: label,
        // 场合标签也只在本地表里 —— 远端那条路没有，兜底这条路不能一起丢
        ...(标签 !== '' ? { tag: 标签 } : {}),
      }
    })
    .filter((x) => x.emojiId !== '' && x.summary !== '')
    .slice(0, Number(limit) || 50)
}

export async function listCustomFaces(limit = 50) {
  try {
    const result = await callOneBot({ action: 'fetch_custom_face_detail', params: { count: Number(limit) || 50 } })
    if (result?.retcode !== 0) {
      return localNamedList(limit)
    }
    const list = Array.isArray(result?.data) ? result.data : []
    const remote = list
      .map((item) => ({
        emojiId: String(item?.emoji_id ?? item?.resId ?? '').trim(),
        url: String(item?.url ?? '').trim(),
        // PATH_FIRST 2026-11-14（批次446）：NapCat 的 emoPath 指向它自己的
        // .../personal_emoji/Ori/<md5>.jpg，而实测**这些文件并不存在**（返回里 isExist:false）。
        // 原来它排在前面，于是「本地明明有原图」的条目也被判成没图 ——
        // 列表给不出可看的路径，她也永远认不出那几张没名字的。
        // 改成先找本地（命名表里的 path / 收到的图片里按 hash 匹配），找不到才退回 NapCat 的。
        emoPath: resolveLocalFacePath(String(item?.emoji_id ?? item?.resId ?? '')) || String(item?.emoPath ?? '').trim(),
        summary: String(item?.summary ?? item?.desc ?? '').trim(),
        desc: String(item?.desc ?? '').trim()
      }))
      .filter((item) => item.emojiId !== '')
    // 远端有数据也要补名字（远端不带 summary/desc，见 mergeFaceNames 的注释）
    const 合并 = mergeFaceNames(remote, readFaceNames())
    if (合并.length === 0) return localNamedList(limit)
    // ROSTER_UNION 2026-11-14：名册 = 远端 ∪ 本地命名表。
    // 只在远端取会漏掉「QQ 收藏夹里已经没有、但本地还留着原图」的那几张
    // （顶盆委屈、就是啊）—— 它们照样能发（sendCustomFace 走本地原图那条路），
    // 而顶盆委屈正是她最常甩的那张。按 emojiId 和名字各去一次重。
    const 有号 = new Set(合并.map((r) => String(r.emojiId)))
    const 有名 = new Set(合并.map((r) => String(r.summary || "").trim()).filter(Boolean))
    const 补 = localNamedList(limit).filter((r) => !有号.has(String(r.emojiId)) && !有名.has(String(r.summary || "").trim()))
    return 合并.concat(补)
  } catch (error) {
    const fallback = localNamedList(limit)
    if (fallback.length > 0) return fallback
    note('emoji', `拉收藏表情失败：${error instanceof Error ? error.message : error}`)
    return []
  }
}

export async function sendCustomFace(requestedTarget, emojiId) {
  const id = String(emojiId ?? '').trim()
  if (id === '') throw new Error('收藏表情的 emoji_id 是空的')
  const target = resolveSendTarget(requestedTarget, getConfig().peerUin)
  const isGroup = target.kind === 'group'
  const recipient = isGroup ? { group_id: Number(target.id) } : { user_id: Number(target.id) }

  // 优先直接用本机收藏表情原图以 sub_type=1（动画表情包）发送，兼容 NapCat 且保留 GIF 动画
  const localPath = resolveLocalFacePath(id)
  if (localPath && existsSync(localPath)) {
    const fileUrl = localPath.startsWith('file://') ? localPath : 'file://' + localPath
    const seg = { type: 'image', data: { file: fileUrl, sub_type: 1 } }
    const action = isGroup ? 'send_group_msg' : 'send_private_msg'
    const params = { ...recipient, message: [seg] }
    try {
      const receipt = await deliverOneBot({ action, params })
      const mid = receipt.data.message_id
      note('emoji', `已发送收藏表情包 ${id} (${localPath.split('/').pop()}) -> message_id=${mid}`)
      recordFaceUse(id)
      return { ...receipt, message_id: mid }
    } catch (error) {
      if (error?.code !== DELIVERY_REJECTED) throw error
    }
  }

  const params = { ...recipient, emoji_id: id }
  const receipt = await deliverOneBot({ action: 'send_custom_face', params })
  recordFaceUse(id)
  return { ...receipt, message_id: receipt.data.message_id }
}

export async function findCustomFace(keyword, limit = 50) {
  const key = String(keyword ?? '').trim()
  if (key === '') return null
  const names = readFaceNames()
  const lowerKey = key.toLowerCase()
  // 1) 精确匹配或包含匹配本地命名表
  const entries = Object.entries(names)
  const exactNamed = entries.find(([eid, value]) => {
    const label = String(value?.name ?? '').toLowerCase()
    return label === lowerKey || eid.toLowerCase() === lowerKey
  })
  const partialNamed = exactNamed ?? entries.find(([eid, value]) => {
    const label = String(value?.name ?? '').toLowerCase()
    return label !== '' && (label.includes(lowerKey) || lowerKey.includes(label) || eid.toLowerCase().includes(lowerKey))
  })
  if (partialNamed !== undefined) {
    const [eid, val] = partialNamed
    return {
      emojiId: eid,
      url: '',
      emoPath: resolveLocalFacePath(eid),
      summary: String(val?.name ?? ''),
      desc: String(val?.name ?? '')
    }
  }
  const list = await listCustomFaces(limit)
  if (list.length === 0) return null
  const exact = list.find((item) => item.summary.toLowerCase() === lowerKey || item.desc.toLowerCase() === lowerKey)
  if (exact !== undefined) return exact
  const partial = list.find(
    (item) =>
      item.summary.toLowerCase().includes(lowerKey) ||
      item.desc.toLowerCase().includes(lowerKey) ||
      item.emojiId.toLowerCase() === lowerKey ||
      item.emojiId.toLowerCase().includes(lowerKey)
  )
  return partial ?? null
}
