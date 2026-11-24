import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const PLUGIN = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-rofm/lib/plugin.js'
const HOST = '/usr/local/lib/nodejs/node-v22.23.4-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js'
const source = readFileSync(PLUGIN, 'utf8')

test('C1 回忆块注册到 runtime-context，不再占 system 头段', () => {
  assert.match(source, /systemPrompt\.context\(\{/)
  assert.match(source, /this\.recallInContext = true/)
  assert.match(source, /recall block -> runtime-context/)
})

test('C2 四处回忆变化不再强制开新请求序列', () => {
  const hits = source.match(/if \(this\.recallInContext !== true\) state\.forceNewSeries = true/g) ?? []
  assert.equal(hits.length, 4)
})

test('C3 评分任务块仍在 system section，仍用 forceNewSeries 重写头节点', () => {
  assert.match(source, /name: TASKS_SECTION_NAME/)
  assert.match(source, /onMemoryTasksChanged\(session\)[\s\S]{0,300}forceNewSeries = true/)
})

test('C4 没有 context 的旧宿主回退到 section', () => {
  assert.match(source, /typeof systemPrompt\.context === 'function'/)
  assert.match(source, /this\.recallInContext = false/)
})

test('C5 宿主拼接 runtime-context 时声明旧快照失效', () => {
  const host = readFileSync(HOST, 'utf8')
  assert.match(host, /This snapshot supersedes earlier runtime-context snapshots/)
})
