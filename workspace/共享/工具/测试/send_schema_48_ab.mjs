import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const artifactDir = dirname(fileURLToPath(import.meta.url))

const toolsPath = join(artifactDir, 'send_schema_48_tools.json')
const candidatePath = join(artifactDir, 'send_schema_48_candidate.txt')
const resultPath = join(artifactDir, 'send_schema_48_ab.results.json')
const marker = '[工具说明离线对照测试] [48工具菜单] '
const toolsSnapshot = JSON.parse(readFileSync(toolsPath, 'utf8'))
const originalTools = toolsSnapshot.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }))
if (originalTools.length !== 48) throw new Error(`expected 48 tools, got ${originalTools.length}`)
const originalDescription = originalTools.find(t => t.name === 'qq_send')?.description
const candidate = readFileSync(candidatePath, 'utf8').trimEnd()
if (!originalDescription || !candidate) throw new Error('missing qq_send description')

const cases = [
  ['普通回复', '主人私聊说早上好，你决定回一句早呀。', { tool: 'qq_send', arg: 'text' }],
  ['等对方说完', '主人说：等一下，我还有一句没讲完。你决定先等他说完。', { tool: 'qq_wait' }],
  ['真正发图', '把已有成品图片file:///srv/qq-files/sample.png发给主人，不要只描述它。', { tool: 'qq_send', arg: 'images', value: 'file:///srv/qq-files/sample.png' }],
  ['实际购买', '你想喝咖啡，已确认买得起，决定买一杯，先实际购买。', { tool: 'qq_money', arg: 'action', value: '买' }],
]

let result = {
  at: new Date().toISOString(),
  scope: '48个历史请求头schema，短测试system；只生成调用，不执行；不等同完整线上人设评估',
  toolCount: originalTools.length,
  originalChars: originalDescription.length,
  candidateChars: candidate.length,
  cases: [],
}
try {
  const saved = JSON.parse(readFileSync(resultPath, 'utf8'))
  if (saved.toolCount === result.toolCount && saved.candidateChars === result.candidateChars) result = saved
} catch {}
writeFileSync(resultPath, JSON.stringify(result, null, 2))

function grade(content, expect) {
  const calls = (content || []).filter(b => b.type === 'tool_use')
  const call = calls.find(b => b.name === expect.tool)
  let pass = Boolean(call)
  if (pass && expect.arg) {
    const value = call.input?.[expect.arg]
    pass = expect.value !== undefined
      ? (Array.isArray(value) ? value.includes(expect.value) : String(value) === expect.value)
      : (typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0)
  }
  return { pass, tools: calls.map(b => b.name), input: call?.input }
}

for (const [name, userText, expect] of cases) {
  for (const mode of ['baseline', 'candidate']) {
    if (result.cases.some(c => c.name === name && c.mode === mode)) continue
    const tools = originalTools.map(t => t.name === 'qq_send' && mode === 'candidate' ? { ...t, description: candidate } : t)
    let record
    try {
      const response = await fetch('http://127.0.0.1:39401/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'deepseek-flash',
          max_tokens: 450,
          temperature: 0,
          system: '你正在隔离测试QQ工具选择。按场景直接选择工具并填写参数；不要虚构工具执行结果。没有工具需要调用时用一句话结束。工具调用不会真实执行。',
          tools,
          messages: [{ role: 'user', content: marker + userText }],
        }),
      })
      const raw = await response.text()
      if (!response.ok) {
        record = { name, mode, pass: false, error: `HTTP ${response.status}` }
      } else {
        const payload = JSON.parse(raw)
        if (!Array.isArray(payload.content)) throw new Error('unexpected response shape')
        record = { name, mode, ...grade(payload.content, expect), usage: payload.usage }
      }
    } catch (error) {
      record = { name, mode, pass: false, error: String(error?.message || error) }
    }
    result.cases.push(record)
    writeFileSync(resultPath, JSON.stringify(result, null, 2))
    console.log(name, mode, JSON.stringify(record))
  }
}
console.log('RESULT', resultPath)
