/** QQ 记忆入口。关联当前收件人，再把回合交给各自的记忆提供方。 */
import { randomUUID } from 'node:crypto'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { 自动回忆素材 } from './自动回忆.mjs'
import { note } from './env.js'
import { describeMemory } from './memory.js'
import { 主人专属会话, QQ聊天键, QQ记忆来源 } from './记忆核心.mjs'
import { 读QQ原话批次 } from './onebot.js'

export function QQ记忆批次(target, messages, senderId) {
  const rows = 读QQ原话批次(messages)
  const source = QQ记忆来源(target, senderId, rows.map(({ text }) => text).filter(Boolean).join('\n'))
  return { source, rows }
}

export function 生活记忆条(batch, config, sessionId, options) {
  const 来源 = batch?.source
  const ownerSessionId = 主人专属会话({ kind: 来源?.chatKind, id: 来源?.chatId }, config)
  return ownerSessionId && ownerSessionId === sessionId ? 自动回忆素材(batch.rows, options) : ''
}

export function 关系记忆条(targetKey, config) {
  if (config.memoryEnabled === false) return ''
  // 2026-11-19：旧卡的关键词不能证明分享授权，群里只读本群的卡。
  return describeMemory(targetKey)
}

const 记忆目录 = process.env.QQ_MEM || `${QQ_WS}/记忆`

function 词库路径(target, mem) {
  const key = QQ聊天键(target?.kind, target?.id)
  return key ? join(mem, '聊天黑话-v1', `${key}.json`) : ''
}

function 读词表(file) {
  try {
    const rows = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(rows)) throw new Error('词库格式无效')
    return rows
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return []
  }
}

/** 2026-11-19：只读当前聊天的词库，不从无归属旧总表回退。 */
export function 读取聊天黑话(target, mem = 记忆目录) {
  const file = 词库路径(target, mem)
  try { return file ? 读词表(file) : [] }
  catch { note('memory', '当前聊天词库读取失败'); return [] }
}

export function 记聊天黑话(target, word, meaning, mem = 记忆目录) {
  const file = 词库路径(target, mem)
  if (!file || word.length < 2 || word.length > 50 || /^\d+$|[\r\n]/.test(word) || !meaning) {
    throw new Error('请给出 2–50 个字的黑话和对应的释义。')
  }
  const rows = 读词表(file).filter((row) => row?.词 !== word)
  const entry = { 词: word, 义: meaning.replace(/\s+/g, ' ').slice(0, 120).toWellFormed(), at: new Date().toISOString() }
  mkdirSync(join(mem, '聊天黑话-v1'), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify([...rows, entry].slice(-50), null, 1) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(tmp, file)
  } finally {
    rmSync(tmp, { force: true })
  }
}

function 读纪念日档(路径) {
  try { return JSON.parse(readFileSync(路径, 'utf8')) }
  catch (error) {
    if (error?.code !== 'ENOENT') note('memory', `纪念日档读取失败：${error?.code ?? 'JSON 无效'}`)
    return null
  }
}

// 2026-11-19：纪念日是独立的日期事实，不依赖旧人味、状态文件或状态进入正文的开关。
export function 纪念日条(target, config, sessionId, now = Date.now(), mem = 记忆目录) {
  if (!sessionId || 主人专属会话(target, config) !== sessionId || !Number.isFinite(now)) return null
  const 条目 = 读纪念日档(join(mem, '想要.json'))?.纪念日
  if (!Array.isArray(条目) || !条目.length) return null
  const 北京 = new Date(now + 8 * 3600e3).toISOString()
  const 今天 = 北京.slice(0, 10)
  const 月日 = 今天.slice(5)
  const 事实 = 条目.find((条) => typeof 条?.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(条.day)
    && 条.day <= 今天 && 条.day.slice(5) === 月日 && typeof 条.什么 === 'string' && 条.什么.trim())
  if (!事实) return null
  const 回执文件 = join(mem, '纪念日提过.json')
  if (读纪念日档(回执文件)?.上次 === 今天) return null
  const 年数 = Number(今天.slice(0, 4)) - Number(事实.day.slice(0, 4))
  const text = `[纪念日] ${月日}：${事实.什么.trim().slice(0, 24)}${年数 > 0 ? `（第 ${年数} 年）` : ''}`
  return { text, 回执文件, 回执: { 上次: 今天, at: 北京.slice(0, 16).replace('T', ' ') } }
}

export function 记纪念日已提示(条) {
  if (!条) return
  const 临时文件 = `${条.回执文件}.${process.pid}.tmp`
  try {
    writeFileSync(临时文件, JSON.stringify(条.回执) + '\n', { mode: 0o600 })
    renameSync(临时文件, 条.回执文件)
  } catch (error) {
    note('memory', `纪念日回执写入失败：${error?.code ?? '未知错误'}`)
    try { rmSync(临时文件, { force: true }) } catch { /* 保留原回执 */ }
  }
}
