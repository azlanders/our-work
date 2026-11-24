// 情绪事件.mjs —— 聊天里发生的事，喂给激素系统的唯一出口。
//
// 为什么要单独一个文件：poll.js（聊天）和 proactive.js（主动搭话）都要喂激素，
// 但 proactive 不能反过来 import poll（会成环）。所以把「怎么识别」和「怎么落盘」抽出来，
// 两边共用一套口径，避免以后又在某个文件里内联一份正则、跟另一份不同步。
//
// 纪律（跟激素.mjs 的设计一致）：
//   · 只认明确信号，模糊的不猜 —— 宁可少喂，也别把群友之间的客套算成她的事。
//   · 每个事件类型 30 秒节流；事件 id 由调用方给，激素.mjs 自己还会按 id 去重。
//   · 子进程 fire-and-forget，激素那边挂了也不影响收发消息。
import { execFile } from 'node:child_process'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'

const TOOL = `${QQ_WS}/共享/工具/激素.mjs`
const 节流 = new Map() // 事件名 -> 上次记的时间
const THROTTLE_MS = 30000

// FEELING_LEDGER 2026-11-05：classifyEmotion() 已删除。
// 它替她判定「这句是夸我还是骂我」，真实语料误报太多（「回滚」被当成「滚」）。
// 判断权归她的 qq_feel；这个文件现在只剩 recordEmotion()，只给「客观发生过、
// 不需要判断」的事用（比如主动搭话没人应）。

/** 记一次情绪事件。kind 必须是 激素.mjs 的 EVENTS_TABLE 里有的。 */
export function recordEmotion(kind, id) {
  if (typeof kind !== 'string' || kind === '') return false
  const now = Date.now()
  if (now - (节流.get(kind) || 0) < THROTTLE_MS) return false
  节流.set(kind, now)
  // DRY 开关：只在真跑测试/观测时用，只打一行、不落盘，避免把测试事件写进真实激素记录。
  if (process.env.DSH_EMOTION_DRY === "1") {
    try { process.stderr.write("[emotion-dry] " + kind + " " + String(id || "") + "\n") } catch { /* 忽略 */ }
    return true
  }
  try {
    execFile(
      '/usr/local/bin/node',
      [TOOL, '--event', kind, '--id', String(id || kind + '-' + now)],
      { timeout: 8000 },
      () => { /* 结果无所谓，失败不重试 */ }
    )
    return true
  } catch {
    return false
  }
}
