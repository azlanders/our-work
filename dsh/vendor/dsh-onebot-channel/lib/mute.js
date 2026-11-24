// mute.js —— 被叫停后的会话静默（只放内存，重启即清）
// 2026-11-03：WorkBuddy kimi 写，肥鱼接入
const muted = new Map() // key -> 到期时间戳

export function muteFor(key, ms = 90000) {
  muted.set(String(key), Date.now() + ms)
}

export function isMuted(key) {
  const k = String(key)
  const until = muted.get(k)
  if (until === undefined) return false
  if (Date.now() >= until) { muted.delete(k); return false }
  return true
}

export function clearMute(key) { muted.delete(String(key)) }

export function muteRemainMs(key) {
  if (!isMuted(key)) return 0
  return Math.max(0, muted.get(String(key)) - Date.now())
}
