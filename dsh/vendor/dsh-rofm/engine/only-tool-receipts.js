/**
 * BATCH647 2026-11-17：召回装填时跳过「只有工具回执、没有一句对话」的 folder。
 *
 * 线上只读统计（`memory/sessions` 全库，2026-11-17 12:00）：
 *   5542 个 folder 里 **1433 个**只有 tool 消息、user/assistant 一句都没有，
 *   共 169.6 万字（占全部归档字符 31%）。它们是 638 之前归档工具原文留下的，
 *   被召回时整段是命令输出/报错栈/网页正文 —— 既不是她经历过的事，
 *   也会挤掉真正有对话的 folder 的预算。
 *
 * 638 之后新归档的 tool 已经只留 40 字预览，但**旧 folder 不会自己变**。
 * 这里做的是纯读过滤：不动数据、不删文件、不改索引，只是不把这种 folder
 * 装进召回块。想看/想删仍然可以用 memory_audit / 手工清理。
 *
 * 判据刻意写得窄：**一条 user/assistant 都没有**才算空壳。
 * 只要有一句人话，哪怕其余全是工具回执，也照常召回。
 */

/** 有对话的 role；`system`/`developer`/`tool` 都不算「说过话」。 */
const 对话角色 = new Set(['user', 'assistant'])

/**
 * 这个 folder 是不是「只有工具回执」。
 * @param {Array<{role?:string}>} messages
 * @returns {boolean} true = 没有一句人话，可以不召回
 */
export function 只有工具回执(messages) {
  const 列 = Array.isArray(messages) ? messages : []
  if (列.length === 0) return false // 空 folder 交给原来的缺档处理，不在这里判
  return !列.some((m) => m && 对话角色.has(String(m.role || '')))
}
