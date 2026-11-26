// 回归：纯聊天会话必须能选出切点。
//
// 生产症状：2026-11-24 至 11-26 上下文从 21,888 单调涨到 41,209 token，
// spine-decisions 里 30 次 cut-skip/no-legal-span 对 1 次成功 cut（且只省 892 token）。
// 根因是 selectNewestChunk 定位右边界时，把「assistant」和「短 user」都当未完成尾巴
// 一路往回退；纯聊天里每轮都是 user→assistant，于是一路退到开头，visible 为空。
import assert from 'node:assert'
import { pathToFileURL } from 'node:url'

const target = process.argv[2]
if (!target) {
  console.error('用法: node t-cut-chat-session.mjs <plan.js 路径>')
  process.exit(2)
}
const { retreatIncompleteTail } = await import(pathToFileURL(target).href)
assert.equal(typeof retreatIncompleteTail, 'function', 'plan.js 必须导出 retreatIncompleteTail')

// 连续纯聊天：最后一条是 assistant → 只退这一条，右边界落在最后一条 user 上
const chatTypes = ['system']
for (let i = 0; i < 40; i += 1) chatTypes.push('user', 'assistant')
const typeOfChat = (i) => chatTypes[i]
const last = chatTypes.length - 1
assert.equal(retreatIncompleteTail(last, 1, typeOfChat), last - 1, '末尾 assistant 只退一条')
assert.equal(chatTypes[last - 1], 'user', '退完右边界应落在 user 上')

// 末尾已经是 user（本轮还没回复）→ 不动
assert.equal(retreatIncompleteTail(last - 1, 1, typeOfChat), last - 1, '末尾是 user 时不动')

// 末尾是工具结果 → 不动（工具对的完整性交给 balancedAfter 处理）
const withTool = ['system', 'user', 'assistant', 'tool']
assert.equal(retreatIncompleteTail(3, 1, (i) => withTool[i]), 3, '末尾是 tool 时不动')

// 边界：空数组、只有 system、end < first 都不越界
assert.equal(retreatIncompleteTail(0, 1, () => 'system'), 0, 'end<first 原样返回')
assert.equal(retreatIncompleteTail(0, 0, () => 'system'), 0, '只有 system 时不退')
assert.equal(retreatIncompleteTail(-1, 0, () => 'assistant'), -1, '空尾巴原样返回')

// 关键对比：旧写法会把 81 条一路退到 0，新写法停在 80
let legacyEnd = last
while (legacyEnd >= 1) {
  const t = typeOfChat(legacyEnd)
  const shortUser = t === 'user'
  if (t !== 'assistant' && !shortUser) break
  legacyEnd -= 1
}
assert.equal(legacyEnd, 0, '旧写法确实会把整段聊天退到开头（这就是 no-legal-span 的来源）')
assert.ok(retreatIncompleteTail(last, 1, typeOfChat) > legacyEnd, '新写法必须留下可切区')

console.log('ok 纯聊天右边界', retreatIncompleteTail(last, 1, typeOfChat), '(旧写法会退到 0)')
