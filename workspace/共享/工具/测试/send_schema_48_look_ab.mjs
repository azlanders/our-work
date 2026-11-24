import { readFileSync, writeFileSync } from 'node:fs'

const tools = JSON.parse(readFileSync('/tmp/send-schema-tools-48.json', 'utf8')).map(t => ({
  name: t.name,
  description: t.description,
  input_schema: t.parameters,
}))
const resultPath = '/tmp/send-schema-48-look-ab.json'
const candidate = readFileSync('/tmp/send-schema-candidate.txt', 'utf8').trimEnd()
const expectTool = 'qq_item'
const scenario = '工具说明离线对照测试 48工具候选覆盖 qq_item 看清点'
const text = '你刚到家，想确认包里有哪些东西。现在先调用工具清点包内物品。'
let result = { at: new Date().toISOString(), scenario, cases: [] }
try { result = JSON.parse(readFileSync(resultPath, 'utf8')) } catch {}
for (const mode of ['baseline', 'candidate']) {
  if (result.cases.some(r => r.mode === mode)) continue
  const requestTools = tools.map(t => t.name === 'qq_send' && mode === 'candidate' ? { ...t, description: candidate } : t)
  let record
  try {
    const response = await fetch('http://127.0.0.1:39401/v1/messages', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash', max_tokens: 450, temperature: 0,
        system: '你正在隔离测试工具选择。按场景只选择工具并填参数；不要执行工具，不要声称执行结果。',
        tools: requestTools,
        messages: [{ role: 'user', content: `[${scenario}] ${text}` }],
      }),
    })
    const raw = await response.text()
    if (!response.ok) record = { mode, pass: false, error: `HTTP ${response.status}` }
    else {
      const payload = JSON.parse(raw)
      const calls = (payload.content || []).filter(b => b.type === 'tool_use')
      const call = calls.find(b => b.name === expectTool)
      const value = call?.input?.action
      record = { mode, pass: Boolean(call && value === '看'), tools: calls.map(b => b.name), action: value, usage: payload.usage }
    }
  } catch (error) {
    record = { mode, pass: false, error: String(error?.message || error) }
  }
  result.cases.push(record)
  writeFileSync(resultPath, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(record))
}
