import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'
const { filterQQDevContext, registerQQPromptFilter, markVoiceTarget } = await import(process.env.STATE_MODULE || new URL("file://{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/stateVoice.js").href)
const indexSource = readFileSync(process.env.INDEX_SOURCE || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/index.js', 'utf8')
const STATE_CONTEXT_ORDER = Number(/systemPrompt\.context\(\{ name: 'qq-state', order: ([^,]+), text \}/.exec(indexSource)?.[1])
let cases = 0
const assembly = {
 sections: [{name:'persona',text:'人设'}, {name:'harness:source',text:'source'}, {name:'app:web-surface',text:'web'}, {name:'dsh-rofm:recall',text:'回忆'}],
 contexts: [{name:'working-directory:current',text:'目录'}, {name:'harness:source',text:'路径'}, {name:'app:web-surface',text:'网址'}, {name:'qq-state',text:'状态'}],
 tools: [{name:'bash'}], variables:{x:1},
}
const original = JSON.stringify(assembly)
const filtered = filterQQDevContext(assembly,{mute:false})
assert.deepEqual(filtered.sections.map(x=>x.name),['persona','dsh-rofm:recall']);cases++
assert.deepEqual(filtered.contexts.map(x=>x.name),['working-directory:current','qq-state']);cases++
assert.equal(JSON.stringify(assembly),original);assert.equal(filtered.tools,assembly.tools);assert.equal(filtered.variables,assembly.variables);cases++
assert.equal(filterQQDevContext(assembly,{mute:true}),assembly);cases++
assert.equal(filterQQDevContext(assembly,null),assembly);cases++
const required = {sections:[],contexts:[{name:'harness:source',required:true}]}
assert.equal(filterQQDevContext(required,{}).contexts.length,1);cases++
let callback
const ctx = {on(name,fn){assert.equal(name,'system-prompt/assemble');callback=fn;return ()=>{}}}
const agent={}
registerQQPromptFilter(ctx,{})
markVoiceTarget(agent,{peer:'test',isPrivate:true})
assert.deepEqual((await callback({}, {agent},async()=>assembly)).sections.map(x=>x.name),['persona','dsh-rofm:recall']);cases++
assert.equal(await callback({}, {agent:{}},async()=>assembly),assembly);cases++
markVoiceTarget(agent,{peer:'test',mute:true})
assert.equal(await callback({}, {agent},async()=>assembly),assembly);cases++
markVoiceTarget(agent,{peer:'test',at:Date.now()-11*60e3})
assert.equal(await callback({}, {agent},async()=>assembly),assembly);cases++
registerQQPromptFilter(ctx,{精简QQ开发提示:false})
markVoiceTarget(agent,{peer:'test'})
assert.equal(await callback({}, {agent},async()=>assembly),assembly);cases++
// 宿主真实refreshContext实现：省略的可选上下文不会在入场时恢复；必需事实保持。
const {SystemPrompt}=await import(process.env.PROMPT_MODULE || new URL("file:///usr/local/lib/nodejs/node-v22.23.4-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js").href)
assert.ok(Number.isFinite(STATE_CONTEXT_ORDER), 'qq-state order must be statically verifiable')
const orderedProviders = new Map([
 ['persona', { name:'persona', order:10200 }],
 ['harness:source', { name:'harness:source', order:12000 }],
 ['dsh-rofm:recall', { name:'dsh-rofm:recall', order:10300 }],
 ['dsh-rofm:memory-tasks', { name:'dsh-rofm:memory-tasks', order:10301 }],
 ['qq-state', { name:'qq-state', order:STATE_CONTEXT_ORDER }],
])
const orderedNames = [...orderedProviders.values()].sort((a,b)=>a.order-b.order).map(x=>x.name)
assert.deepEqual(orderedNames,['persona','dsh-rofm:recall','dsh-rofm:memory-tasks','harness:source','qq-state']);cases++
const providers=new Map(assembly.contexts.map(x=>[x.name,{...x,order:1}]))
const fake={layers:{merge:()=>providers,global:{runtimeContextSuppressors:{isEmpty:()=>true}},chainLayers:()=>[]}}
const refreshed=SystemPrompt.prototype.refreshContext.call(fake,filtered,{})
assert.deepEqual(refreshed.contexts.map(x=>x.name),['working-directory:current','qq-state']);cases++
console.log(cases+' QQ prompt cases passed')
