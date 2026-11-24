import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
const root = process.env.METRICS_ROOT || '{{BOT_ROOT}}/共享/工具'
const { 请求观测 } = await import(new URL('file://' + root + '/usage-解析.mjs'))
const request = {model:'alias',system:[{type:'text',text:'系统秘密'}],tools:[{name:'sample',description:'工具说明',input_schema:{type:'object'}}],messages:[{role:'user',content:[{type:'text',text:'正文秘密'},{type:'image',source:{type:'base64',data:'secret-image'}}]},{role:'user',content:[{type:'tool_result',tool_use_id:'id',content:[{type:'text',text:'结果'},{type:'image',source:{data:'nested'}}]}]}]}
const copy=JSON.stringify(request)
const stats=请求观测(request)
assert.equal(stats.工具数,1)
assert.equal(stats.系统字符,4)
assert.equal(stats.工具描述字符,4)
assert.equal(stats.图片数,2)
assert.equal(stats.工具结果字符,2)
assert.equal(stats.消息数,2)
assert.equal(JSON.stringify(request),copy)
assert.equal(JSON.stringify(stats).includes('秘密'),false)
assert.equal(请求观测({...request,messages:[]}).系统哈希,stats.系统哈希)
assert.notEqual(请求观测({...request,system:'changed'}).系统哈希,stats.系统哈希)
assert.notEqual(请求观测({...request,tools:[]}).工具哈希,stats.工具哈希)
assert.equal(请求观测(null).工具数,0)
assert.equal(请求观测({tools:[{function:{description:'abc'}}]}).工具描述字符,3)
console.log('13 request metric assertions passed')
// 真网关进程+本地假上游，不访问线上钥匙、余额、路由或日志。
const dir=mkdtempSync(join(tmpdir(),'token-metrics-'))
let child,upstream
try {
 let forwarded
 upstream=createServer(async(req,res)=>{
  let raw='';for await(const b of req)raw+=b
  forwarded=JSON.parse(raw)
  res.setHeader('content-type','application/json')
  res.end(JSON.stringify({usage:{input_tokens:10,output_tokens:2,cache_read_input_tokens:90}}))
 })
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve))
 const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port
 await new Promise(resolve=>reservation.close(resolve))
 const fleet=join(dir,'fleet.json'),keys=join(dir,'keys.json'),log=join(dir,'usage.jsonl'),relayLog=join(dir,'relay.log')
 writeFileSync(fleet,JSON.stringify({
  modelOrder:['actual'],slotOrder:['slot-1'],
  slots:[{id:'slot-1',codename:'fake',enabled:true,protocol:'anthropic',base:'http://127.0.0.1:'+upstream.address().port,key:'fake-test-only',model:'actual',rate:1}]
 }))
 writeFileSync(keys,'[]')
 child=spawn(process.execPath,[join(root,'接口网关.mjs')],{
  env:{...process.env,HAJIMI_UPSTREAM_PORT:String(port),FISH_FLEET_CONFIG:fleet,HAJIMI_KEYS_FILE:keys,HAJIMI_USAGE_LOG:log,HAJIMI_RELAY_LOG:relayLog,FLEET_TOKEN:'test-token'},
  stdio:['ignore','pipe','pipe']
 })
 let stderr='';child.stderr.on('data',b=>stderr+=b)
 await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('gateway start timeout '+stderr)),5000)
  child.once('error',e=>{clearTimeout(timer);reject(e)})
  child.once('exit',code=>{clearTimeout(timer);reject(new Error('gateway exited '+code+' '+stderr))})
  child.stdout.once('data',()=>{clearTimeout(timer);resolve()})
 })
 for(let n=0;n<2;n++){
  const response=await fetch('http://127.0.0.1:'+port+'/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:copy})
  assert.equal(response.status,200);const body=await response.json();assert.equal(body.usage.cache_read_input_tokens,90)
 }
 // CACHE_ANCHOR：接口网关在 Anthropic 协议直通时自动注入最多 4 个 cache_control 断点。
 const 剥断点=(o)=>{
  const c=JSON.parse(JSON.stringify(o))
  const 剥=(arr)=>{if(Array.isArray(arr))for(const it of arr)if(it&&typeof it==='object')delete it.cache_control}
  剥(c.tools);剥(c.system)
  if(Array.isArray(c.messages))for(const m of c.messages)if(m&&Array.isArray(m.content))剥(m.content)
  return c
 }
 assert.deepEqual(剥断点(forwarded),{...JSON.parse(JSON.stringify(request)),model:'actual'})
 const 点数=[...(forwarded.tools||[]),...(forwarded.system||[]),
   ...((forwarded.messages||[]).flatMap((m)=>Array.isArray(m&&m.content)?m.content:[]))]
   .filter((x)=>x&&typeof x==='object'&&x.cache_control).length
 assert.ok(点数>=1,'一个断点都没挂 —— 前缀缓存那 9 折就没了')
 assert.ok(点数<=4,'挂了 '+点数+' 个断点，超过上游 4 个的上限')
 let records=[]
 const deadline=Date.now()+3000
 while(Date.now()<deadline){
  try { records=readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(x=>JSON.parse(x)).filter(x=>x.模型==='actual') } catch {}
  if(records.length===2)break
  await new Promise(resolve=>setImmediate(resolve))
 }
 assert.equal(records.length,2)
 assert.equal(records[0].模型,'actual')
 assert.equal(records[0].工具数,1)
 assert.equal(records[0].缓读已知,true)
 assert.equal(records[0].入,100)
 assert.equal(records[0].缓读,90)
 assert.equal(JSON.stringify(records).includes('系统秘密'),false)
 assert.match(records[0].at,/^\d{4}-\d{2}-\d{2} /)
 console.log('gateway integration passed: body preserved, mapped model, metrics and usage persisted')
} finally {
 if(child && child.exitCode===null){const exited=once(child,'exit');child.kill('SIGTERM');await exited}
 if(upstream)await new Promise(resolve=>upstream.close(resolve))
 rmSync(dir,{recursive:true,force:true})
}
