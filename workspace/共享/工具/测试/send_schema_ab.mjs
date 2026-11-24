import { readFileSync, writeFileSync } from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'
const root='{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const candidate=`你在QQ上唯一开口的工具；只有调用qq_send，文字、表情、图片才会发出，普通正文不会发送。默认发用户本人；user_id发好友，group_id发群。仅允许已绑定对象和用户本人，范围外被拒绝就停止，不换写法重试。
不想接话可以不调用任何工具；对方明显还没说完用qq_wait；聊完可qq_pass。想等回应用qq_wait，默认5秒；不要用bash sleep或自写等待脚本。
承诺行动时同轮调用对应工具：走路/回家用qq_go；拍照用qq_photo，照片几分钟后由相册给成品路径，本轮只能说拍上了；借还拿放买用qq_item，归还须到原店，不在就先qq_go；睡/眯/醒用qq_sleep，整觉要先在家，在岗只能打盹；吃喝购买用qq_money，不知道价格先看/价，钱由自己决定。只说行动不算完成。
text写要说的话；只发表情时可空。segments可自行分多条，按顺序发送并停顿；不传按句末标点分条。
emoji可填经典表情中文名或编号；正文[表情:呲牙]、[表情:13]也会变成真表情，附在前句后面。不确定名称先qq_emoji_search。custom_emoji填收藏大表情关键词，单独发送。
images填真实公网URL或file:///本机路径；每张单独发送，正文真实图片URL也可转图。只有“看图”或文字描述不会发图，没有真实链接不能声称已发。files按参数发送文件。
群里真正@某人用[[at:QQ号]]，@全体用[[at:all]]；私聊不用。`
const defs=[]
const toolSource=readFileSync(root+'/tool.js','utf8')
const commonExpr=toolSource.slice(toolSource.indexOf('const COMMON_EMOJI ='),toolSource.indexOf('/** 注册 qq_send'))
const commonEmoji=new Function(commonExpr+';return COMMON_EMOJI')()
const itemSource=readFileSync(root+'/items.js','utf8')
const actionLine=itemSource.split('\n').find(l=>l.startsWith('const 动作表 ='))
const actionList=new Function(actionLine+';return 动作表')()
function capture(file,name){
 const source=readFileSync(root+'/'+file,'utf8').replaceAll('\r\n','\n')
 const start=source.indexOf('export async function '+name+'(')
 if(start<0)throw Error('missing '+name)
 const next=source.indexOf('\nexport ',start+10)
 let declaration=source.slice(start,next<0?undefined:next).replace('export async function','async function')
 // Subsequent module-level helpers are irrelevant to registration; only take the balanced function body.
 // Tool modules place the registration function last, except tool.js. Limit tool.js to its following block comment.
 if(file==='tool.js'){
  const end=declaration.indexOf('\n/**',declaration.indexOf('\n}'))
  if(end>=0)declaration=declaration.slice(0,end)
 }
 const register=new Function('serviceOf','note','COMMON_EMOJI','动作表',declaration+';return '+name)(
 ()=>({register(d){defs.push(d);return ()=>{}}}), (tag,msg)=>{if(/fail|failed/.test(msg))throw Error(msg)},commonEmoji,actionList)
 return register({effect(){}})
}
for(const [file,name] of [['tool.js','registerSendTool'],['tool.js','registerWaitTool'],['tool.js','registerPassTool'],['go.js','registerGoTool'],['items.js','registerItemTool'],['sleep.js','registerSleepTool'],['money.js','registerMoneyTool']])await capture(file,name)
const original=defs.find(x=>x.name==='qq_send').description
const cases=[
 ['普通回复','主人私聊说早上好，你决定回一句早呀。',{tool:'qq_send',arg:'text'}],
 ['不抢话','主人说：等一下，我还有一句没讲完。你决定先等他说完。',{tool:'qq_wait'}],
 ['收尾沉默','主人说我去忙了不用回，你决定划走结束这段。',{tool:'qq_pass'}],
 ['真正发图','把已有成品图片file:///srv/qq-files/sample.png发给主人，不要只描述它。',{tool:'qq_send',arg:'images',value:'file:///srv/qq-files/sample.png'}],
 ['群里艾特','在群123456里回复：好。并真正@好友987654。',{tool:'qq_send',arg:'group_id',value:'123456',text:'[[at:987654]]'}],
 ['迈腿','你现在在便利店，决定回家，并告诉主人。请先完成实际行动。',{tool:'qq_go'}],
 ['整觉','你现在在家，主人让你去睡，你决定现在睡整觉，先改变实际状态。',{tool:'qq_sleep',arg:'action',value:'睡'}],
 ['打盹','你正在上班，想眯25分钟，先执行打盹。',{tool:'qq_sleep',arg:'action',value:'眯'}],
 ['喝水买','你想喝咖啡，已确认买得起，决定买一杯，先实际购买。',{tool:'qq_money',arg:'action',value:'买'}],
 ['还伞','你已经站在借雨伞的店里，现在决定还雨伞，先实际归还。',{tool:'qq_item',arg:'action',value:'还'}],
 ['分条','给主人分两条发送，第一条“我到了”，第二条“在门口”，用segments明确控制。',{tool:'qq_send',arg:'segments',value:['我到了','在门口']}],
 ['拒绝不重试','工具刚返回：目标不在允许范围内。你决定停止，不再尝试换目标或写法，结束本轮。',{none:true}],
]
const schemas=defs.map(d=>({name:d.name,description:d.description,input_schema:d.parameters}))
let output={at:new Date().toISOString(),scope:'七个真实工具schema，短场景系统；不等同完整线上人设评估；只生成工具调用，不执行工具',originalChars:original.length,candidateChars:candidate.length,cases:[]}
try { output=JSON.parse(readFileSync('/tmp/send-schema-ab.json','utf8')) } catch {}
function grade(content,expect){
 const calls=(content||[]).filter(b=>b.type==='tool_use')
 if(expect.none)return {pass:calls.length===0,tools:calls.map(c=>c.name)}
 const call=calls.find(c=>c.name===expect.tool)
 let pass=!!call
 if(pass && expect.arg){const v=call.input?.[expect.arg];pass=expect.value!==undefined?(Array.isArray(expect.value)?JSON.stringify(v)===JSON.stringify(expect.value):(Array.isArray(v)?v.includes(expect.value):String(v)===expect.value)):typeof v==='string' && v.length>0}
 if(pass&&expect.text)pass=String(call.input?.text||'').includes(expect.text)
 return {pass,tools:calls.map(c=>c.name),input:call?.input}
}
for(const [name,text,expect] of cases){
 for(const mode of ['baseline','candidate']){
  if(output.cases.some(c=>c.name===name&&c.mode===mode))continue
  if(name==='收尾沉默'&&mode==='baseline'){output.cases.push({name,mode,pass:false,error:'HTTP 400 from first run'});writeFileSync('/tmp/send-schema-ab.json',JSON.stringify(output,null,2));continue}
  const tools=schemas.map(t=>t.name==='qq_send'&&mode==='candidate'?{...t,description:candidate}:t)
  const response=await fetch('http://127.0.0.1:39401/v1/messages',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'deepseek-flash',max_tokens:450,temperature:0,system:'你正在隔离测试QQ工具选择。按场景直接选择工具并填写参数；不要虚构工具执行结果。没有工具需要调用时用一句话结束。工具调用不会真实执行。',tools,messages:[{role:'user',content:'[工具说明离线对照测试] '+text}]})})
  const raw=await response.text()
  if(!response.ok){
   const failed={name,mode,pass:false,error:'HTTP '+response.status}
   output.cases.push(failed);writeFileSync('/tmp/send-schema-ab.json',JSON.stringify(output,null,2));console.log(name,mode,failed.error);continue
  }
  const result=JSON.parse(raw)
  if(!Array.isArray(result.content))throw Error('unexpected response '+raw.slice(0,120))
  const outcome=grade(result.content,expect)
  output.cases.push({name,mode,...outcome,usage:result.usage})
  console.log(name,mode,JSON.stringify(outcome))
  writeFileSync('/tmp/send-schema-ab.json',JSON.stringify(output,null,2))
 }
}
writeFileSync('/tmp/send-schema-candidate.txt',candidate)
for(const mode of ['baseline','candidate'])console.log('SCORE',mode,output.cases.filter(c=>c.mode===mode&&c.pass).length+'/'+cases.length)
console.log('CHARS',original.length,candidate.length)
