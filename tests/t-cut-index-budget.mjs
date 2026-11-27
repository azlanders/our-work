// 回归：走生产 index.js 的 selectNewestChunk，确认 keep 轮数受 keepRoundTokens 约束。
//
// 旧写法把 keepRounds 个工具轮整块保留。最新几轮都是大工具结果时，切点被顶到
// 第一个用户消息上，后面根本没有可切段，生产上表现为 cut-skip/no-legal-span。
// 本用例只替换宿主包（@deepseek-ai/*）；切点选择与卡片构造都跑真实实现。
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2]
  ? resolve(process.argv[2])
  : join(here, '..', 'dsh', 'vendor', 'dsh-live-compact', 'index.js')

const hostStubs = {
  '@deepseek-ai/dsh-compaction-basic': `
    export class BasicCompactionEngine {}
  `,
  '@deepseek-ai/dsh-compaction': `
    export const CompactionId = (value) => String(value)
    // 假 session 的每个工具调用/结果都成对；配对细节由 plan.js 自己的用例覆盖。
    export const toolPairingBalancedAfter = () => true
    export const toolPairingBalancedBefore = () => true
  `,
  '@deepseek-ai/dsh-llm': `
    export const createUserMessage = (message) => message
  `,
}

const stubURLs = new Map(Object.entries(hostStubs).map(([name, source]) => [
  name,
  `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`,
]))
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = stubURLs.get(specifier)
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context)
  },
})

const { selectNewestChunk } = await import(pathToFileURL(target).href)
assert.equal(typeof selectNewestChunk, 'function', 'index.js 必须导出 selectNewestChunk')

const TOOL_TOKENS = 5000
const KEEP_BUDGET = 9000
const events = []

function add(type, data) {
  events.push({ seq: events.length, type, data })
  return events.length - 1
}

const systemSeq = add('system/message', {
  content: [{ type: 'text', text: 'system prompt' }],
})
const userSeq = add('user/message', {
  role: 'user',
  content: [{ type: 'text', text: '请检查这三个大文件的输出' }],
})

const roundSeqs = []
for (let round = 1; round <= 3; round += 1) {
  const toolCallId = `call-${round}`
  const callSeq = add('assistant/message', {
    turn: round,
    message: {
      role: 'assistant',
      content: [{
        type: 'tool-call',
        id: toolCallId,
        name: 'bash',
        arguments: { command: `cat big-${round}.log` },
      }],
    },
  })
  const body = Array.from({ length: 80 }, (_, line) =>
    `普通输出数据 ${round} ${line} alpha beta gamma delta`).join('\n')
  const resultSeq = add('tool/result', {
    turn: round,
    message: {
      toolCallId,
      content: [{ type: 'text', text: body }],
    },
  })
  roundSeqs.push({ callSeq, resultSeq })
}

const nodes = events.map((event) => event.seq)
const tokensBySeq = new Map([
  [systemSeq, 10],
  [userSeq, 20],
])
for (const { callSeq, resultSeq } of roundSeqs) {
  tokensBySeq.set(callSeq, 40)
  tokensBySeq.set(resultSeq, TOOL_TOKENS)
}
const measured = {
  totalTokens: 45000,
  nodes: nodes.map((seq) => ({ tokens: tokensBySeq.get(seq) })),
}

const session = {
  surface: { nodes },
  eventAt(seq) {
    return events[seq]
  },
}

const chunk = selectNewestChunk(session, measured, 'test', {
  settings: {
    keepRounds: 3,
    keepRoundTokens: KEEP_BUDGET,
    chunkMin: 1000,
    chunkMax: 32000,
    pointerTokens: 32000,
  },
  engine: 'cloud',
  totalTokens: measured.totalTokens,
  drain: true,
})

assert.notEqual(chunk, null, '预算裁剪后必须还能选出合法切点')
const oldestRoundCall = roundSeqs[0].callSeq
const newestRoundCall = roundSeqs[2].callSeq
assert.equal(chunk.start, oldestRoundCall, '切点应从最旧一轮的工具调用开始')
assert.equal(chunk.end, roundSeqs[1].resultSeq, '切点应停在最新保留轮之前')
assert.equal(chunk.end + 1, newestRoundCall, 'keep 起点应是最新一轮的工具调用')
assert.equal(chunk.keptTokens, TOOL_TOKENS + 40, '预算只够保留最新一轮')
assert.ok(chunk.keptTokens <= KEEP_BUDGET, `keep 预算应不超过 ${KEEP_BUDGET}，实际 ${chunk.keptTokens}`)
assert.ok(chunk.tokens >= 1000, `可切 token 不得低于 chunkMin，实际 ${chunk.tokens}`)
assert.ok(chunk.start < chunk.end, '切点区间必须非空')

console.log(
  'ok index 预算裁剪',
  `keepStart=${chunk.end + 1}`,
  `keepRound=[${newestRoundCall},${roundSeqs[2].resultSeq}]`,
  `kept=${chunk.keptTokens}`,
  `cut=[${chunk.start},${chunk.end}]`,
  `tokens=${chunk.tokens}`,
)
