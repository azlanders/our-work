// 睡眠段.mjs —— 「一次睡觉只能有一条段」的唯一判据（2026-11-06 批次121）
//
// 病根：`自动作息.mjs` 强制她睡时连着做两件事 —— 先 `startSleep()`（睡眠阶段.mjs 推一条
// `{start:'HH:MM:SS', phases:[]}`），紧接着 `作息.mjs --想睡`（又推一条 `{start:'HH:MM', end:null}`）。
// 一次觉两条段，于是三个读者各打一块补丁：
//   · 面板.mjs 写了 SLEEP_DEDUP，按 `start[:16]|end[:16]` 合并，取 phases 多的那条；
//   · 自动作息.mjs 结算时不敢相加，注释写着「同一觉可能留了两条残段，相加会翻倍」，改取 max；
//   · 早间简报.mjs 从后往前挑第一条带 end 的 —— 挑到哪条看运气。
// 三个补丁指着同一个错：写的那一头错了。这个文件给出判据，两个写者都过它。
// 读者那边**不动**：脏数据已经躺在 睡眠.json 里了，补丁留着当安全网。

// 一条段的 start 是北京时间裸字符串（有的带秒，有的不带）。解析口径全项目就这一个。
export function 段开始(start) {
  const t = Date.parse(String(start || '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? t : NaN
}

export function 段多长了(start, now = Date.now()) {
  const t = 段开始(start)
  return Number.isFinite(t) ? (now - t) / 3600e3 : NaN
}

/**
 * 找到「还开着的段」（没有 end 的那条）。
 *
 * 顺手处理尸体：开着的段超过 `最多小时` 还没关，说明那次睡觉没走完结算（崩了 / 被强杀），
 * 它不是这一次的觉 —— 就地封成一条零长度残段留档，别拿它去记今晚的睡眠，
 * 否则今晚的时长会从三天前算起。
 *
 * 返回 `{ 段, 收掉的 }`：段为 null 表示现在没有开着的段，调用方该自己推一条。
 */
export function 找开着的段(segs, now = Date.now(), 最多小时 = 12) {
  const 全部 = Array.isArray(segs) ? segs : []
  // SEG_TYPE 2026-11-13（批次385）：数组里混进字符串段时，'abc' 也算「没有 end」，
  // 后面收尸体会执行 `s.end = ...`，而 ESM 严格模式下给原始值赋属性直接抛 TypeError。
  // 睡眠.json 里只要混进一个字符串，整个睡眠判定就崩（睡态、醒来结算、补课全走这条）。
  const 开 = 全部.filter((s) => s && typeof s === 'object' && !s.end)
  const 收掉的 = []
  while (开.length) {
    const s = 开[开.length - 1]
    const h = 段多长了(s.start, now)
    if (Number.isFinite(h) && h >= 0 && h <= 最多小时) return { 段: s, 收掉的 }
    开.pop()
    s.end = s.end || s.start
    s.hours = 0
    s.残缺 = '开着的段超过' + 最多小时 + '小时没关，收掉了'
    收掉的.push(s)
  }
  return { 段: null, 收掉的 }
}
