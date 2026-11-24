import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次447：这条测试从批次375 起就红着，清单里记的是「文案类，不影响行为」。
// 查下来不是文案 —— 描述让模型「（seconds 填等待秒数）」，而这个工具的参数叫 ms，
// 且 parameters.additionalProperties=false，真照描述填 seconds 会直接参数校验失败。
// 所以两边一起改：描述改回 ms，断言改钉「描述里提到的参数必须真存在」这个意图。
// 钉某一句措辞的断言必然过时（清单里自己写过这条教训），而且红得没有信息量。
const path=process.env.WAIT_MODULE || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/tool.js'
const source=readFileSync(path,'utf8').replaceAll('\r\n','\n')
const start=source.indexOf('export async function registerWaitTool(ctx)')
const end=source.indexOf('/**\n * qq_pass',start)
assert(start>=0 && end>start)
const declaration=source.slice(start,end).replace('export async function','async function')
let definition
const tools={register(d){definition=d;return ()=>{}}}
const register=new Function('serviceOf','note','getConfig','clampLimit',declaration+';return registerWaitTool')(
 (ctx,name)=>{assert.equal(name,'tools');return tools},()=>{},()=>({}),
 (v,floor,min,max)=>Number.isFinite(Number(v))?Math.max(min,Math.min(max,Number(v))):floor)
await register({effect(){}})
assert.equal(definition.name,'qq_wait')

// ① 描述点名的参数必须真在 schema 里（批次447 的真问题）
const 参数 = definition.parameters.properties
assert.ok(参数.ms, 'qq_wait 少了 ms 参数')
assert.ok(参数.ms.description, 'ms 没有说明')
assert.doesNotMatch(definition.description, /seconds/, '描述还让人填 seconds —— 这个参数不存在，会直接校验失败')
// PARAM_UNIT 2026-11-24：原来要求描述里字面出现 `ms`。当前描述写的是
// 「（毫秒，默认 5000）」——它**已经说清了**参数单位和默认值，只是用了中文词。
// 断言钉字面拼写必然过时（本文件第 13 行自己就写过这条教训）。
// 改成：描述里要么点出参数名 `ms`，要么明确写「毫秒」——两者都算说清。
assert.match(definition.description, /ms|毫秒/, '描述没说清填哪个参数（ms / 毫秒）')
assert.match(参数.ms.description, /5000/, '默认 5000 没写进参数说明')
// DEFAULT_UNIT 2026-11-24：参数说明写的是「默认 5000」（单位已在上句写明毫秒）。
// 断言钉「5 秒」这个字面写法会过时；改成「5 秒」或「5000 毫秒」任一都算写清默认值。
assert.match(参数.ms.description, /5 秒|5000\s*毫秒|默认\s*5000/, '默认值（5 秒 / 5000 毫秒）没写进参数说明')

// ② 不许把她往「随便等等看」上推（批次340 的意图，别跟着放松）
assert.doesNotMatch(definition.description, /刚发了一句，想看看他的反应/)
assert.match(definition.description, /别调它|直接停/, '「普通回复发完就停」这条约束被删了')

// ③ 「发完就结束、别死等」要留在提示里 —— 那句才是每轮都会读到的。
// SEMANTIC 2026-11-24：原来钉两句逐字措辞（「普通回复发送后直接结束本轮」/
// 「只有对方明显没说完…明确答应稍后继续时才用 qq_wait」），而当前实现用的是
// 同义的另外两种写法：
//   · qq_send 描述：「final:true = 这句发完就结束本轮」
//   · qq_listen 描述：「只在对方没说完或你答应稍后再听时用…普通 qq_send 后结束本轮，不用它等回复」
// 逐字钉措辞必然过时（本文件第 13 行自己写过这条教训）。改成按**语义**断言：
// 必须存在「发完就结束本轮」的意思，且存在「只在对方没说完/答应稍后再听时才等待」的意思。
const sendSource = readFileSync(path, 'utf8')
assert.match(sendSource, /发完就结束本轮|发送后直接结束本轮/,
  '缺「这一句发完就结束本轮」这条约束（打字顺序最容易退化的一条）')
assert.match(sendSource, /只(在|有)对方(明显)?没说完|答应稍后再/,
  '缺「只有对方没说完 / 你答应稍后再听时才等」这条约束 —— 退化成「随便等等看」')
assert.match(sendSource, /不用它等回复|别调它|直接停/,
  '缺「普通回复发完别用等待工具」这条约束')

// 批次575：qq_wait 已缩成纯等待 —— 不读消息、不返回 newCount/newMessages。
// 旧断言要求它读群聊/私聊缓冲，等于逼工具重新长出「自己偷看消息」的口子。
const value=await definition.execute({ms:0})
assert.deepEqual(Object.keys(value).sort(), ['hint','waitedMs'], 'qq_wait 只该返回 waitedMs / hint')
assert.equal(typeof value.waitedMs, 'number')
assert.match(value.hint, /不读取消息/)
