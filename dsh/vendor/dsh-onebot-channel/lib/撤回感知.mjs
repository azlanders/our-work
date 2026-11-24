/**
 * 撤回感知.mjs —— 有人撤回了一条消息，她该知道（2026-11-09 批次341）
 *
 * 为什么要有：
 *   OneBot 的 group_recall / friend_recall 只带 message_id，不带内容。
 *   poll.js 的 notice 分支原来把它**落盘就完了** —— 实测 qq-events.jsonl 里
 *   20 条 group_recall + 1 条 friend_recall，她一条都不知道。
 *
 * 内容从哪来：
 *   群聊日志（<群号>-<日期>.jsonl）每条都存了 message_id + text + nickname，
 *   撤回时拿 id 反查就行，不用额外缓存。
 *   私聊没有日志，只能记「谁撤回了一条」，说不出内容 —— 那也是事实，不要编。
 *
 * 为什么只认「撤回的人 = 当前正在跟她说话的人」：
 *   voiceSlots 的 ctx 里没有群号（peer 是发言者 uin）。不设这个限制，
 *   会把 A 群的撤回拿到 B 群的对话里去讲。
 *
 * 为什么窗口只有 20 分钟：
 *   「刚撤回」只在话题还热的时候有意义。两小时后提起来是翻旧账。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join, dirname } from 'node:path'

export const RECALL_FILE = process.env.DSH_RECALL_FILE || `${QQ_WS}/记忆/撤回的.json`
export const GROUP_LOG_DIR = process.env.DSH_GROUP_LOG || `${QQ_WS}/群聊日志`

/** 槽里提不提的窗口：20 分钟。 */
export const 说话窗口 = 20 * 60e3
/** 文件里留多久：24 小时（够她第二天翻，又不至于变日志）。 */
const 保留 = 24 * 3600e3
/** 最多留几条。 */
const 最多 = 20

const 日 = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 10)
export { 日 } // 测试要用同一个函数生成文件名，不能手抄日期（批次301 的教训）

/**
 * 去群聊日志里反查一条消息的原文。
 *
 * 跨零点会撤回前一天的消息，所以今天和昨天两个文件都看。
 * 找不到返回 null —— 可能是日志没落盘（她没在那个群）、或者那天被归档了。
 */
export function 反查群原文(groupId, messageId, now = Date.now(), dir = GROUP_LOG_DIR) {
  const 群 = String(groupId ?? '')
  const id = String(messageId ?? '')
  if (群 === '' || id === '') return null
  for (const 偏 of [0, -86_400e3]) {
    const p = join(String(dir || GROUP_LOG_DIR), 群 + '-' + 日(Number(now) + 偏) + '.jsonl')
    let 文 = ''
    try {
      if (!existsSync(p)) continue
      文 = readFileSync(p, 'utf8')
    } catch { continue }
    for (const 行 of 文.split('\n')) {
      const s = 行.trim()
      if (s === '' || !s.includes(id)) continue // 便宜的先筛，下面才是精确比对
      let d = null
      try { d = JSON.parse(s) } catch { continue }
      if (String(d?.message_id ?? '') !== id) continue
      return {
        text: String(d?.text ?? '').trim(),
        nickname: String(d?.nickname ?? '').trim(),
        userId: String(d?.user_id ?? ''),
      }
    }
  }
  return null
}

/** 读现有档。坏档当空，绝不因为一次坏读把历史全丢了。 */
export function 读档(p = RECALL_FILE) {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'))
    return Array.isArray(j?.items) ? j.items : []
  } catch { return [] }
}

function 写档(items, p = RECALL_FILE) {
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify({ items }, null, 1), 'utf8')
    renameSync(tmp, p)
  } catch { /* 写不进去就算了，不能让一条撤回把事件处理挂掉 */ }
}

/**
 * 记一条撤回。
 *
 * event 是 OneBot 的原始 notice；opts.selfUin 用来分辨「她自己撤的」。
 * 返回写进去的那条（调用方拿去打日志），跳过时返回 null。
 */
export function 记撤回(event, opts = {}) {
  const now = Number(opts.now) || Date.now()
  const kind = String(opts.kind ?? event?.notice_type ?? '')
  if (kind !== 'group_recall' && kind !== 'friend_recall') return null

  const 是群 = kind === 'group_recall'
  const 群 = String(event?.group_id ?? '')
  const 人 = String(event?.user_id ?? '')
  const 操作 = String(event?.operator_id ?? 人)
  const selfUin = String(opts.selfUin ?? '')
  // 她自己撤回的：那是她的动作，不是别人的社交信号。记下来，但槽里不出声。
  const 是我 = selfUin !== '' && 操作 === selfUin

  const 原文 = 是群 ? 反查群原文(群, event?.message_id, now, opts.dir) : null
  const 条 = {
    at: now,
    类: 是群 ? '群' : '私',
    群: 是群 ? 群 : '',
    谁: (原文 && 原文.nickname) || '',
    谁Id: 人,
    我: 是我,
    有: !!(原文 && 原文.text !== ''),
    文: (原文 && 原文.text) || '',
  }

  const 旧 = 读档(opts.file).filter((x) => Number(x?.at) > now - 保留)
  旧.push(条)
  写档(旧.slice(-最多), opts.file)
  return 条
}

/**
 * 给 voiceSlots 用：这个人最近 20 分钟内撤回的那一条。
 *
 * 只认「撤回的人就是这轮在跟她说话的人」—— ctx.peer 是发言者 uin，
 * 不做这个限制会串群。她自己的撤回不出声。
 */
export function 读最近撤回(ctx = {}) {
  const now = Number(ctx?.now) || Date.now()
  const peer = String(ctx?.peer ?? '')
  if (peer === '') return ''
  const items = 读档(ctx?.file)
  let 最新 = null
  for (const x of items) {
    if (!x || x.我 === true) continue
    if (String(x?.谁Id ?? '') !== peer) continue
    const t = Number(x?.at)
    if (!t || t > now + 60e3 || now - t > 说话窗口) continue
    if (!最新 || t > Number(最新.at)) 最新 = x
  }
  if (!最新) return ''
  const 话 = String(最新?.文 ?? '').trim()
  const 有 = 最新?.有 === true && 话 !== ''
  // 有原文就说原文（她能判断「他为什么撤」）；没有就只说「撤了一条」，不编
  return '[撤回] 他刚撤回了一条' + (有 ? '：「' + 话.slice(0, 40) + '」' : '，内容没留下')
    + '。可能不想让人看见，提不提你自己定。'
}
