import test from 'node:test'
import assert from 'node:assert/strict'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次450：把今天三批（447 qq_wait 的 seconds、448 qq_sleep 的 mode/熬、449 qq_audio_understand
// 的「他发来语音」）逐个修完之后，发现它们全是同一个病 —— **工具的声明和实现对不上**。
// 一条一条修是追不完的，所以把这类判据做成通用闸：32 个工具全注册一遍，逐个对。
//
// 五条：
//   A 32 个都得注册上（注册函数里每个都有 try/catch + note，静默失败是常态）
//   B 每个都要有 output.schema 和 render，且 render 对「形状合法的返回值」不能给空串
//     （给空串 = 她那边一片空白，日志里什么也看不出来）
//   C required 里的名字必须真声明；每个参数必须有说明
//   D 描述里写成 `xxx=` / `xxx:` 的名字必须是真参数 —— qq_sleep 的 `mode='睡'` 就是这条
//   E execute 里读的 args.X 必须已声明 —— qq_collect_face 的 limit 就是这条
//     （additionalProperties:false，没声明她就永远填不进去，那一支等于死代码）

const L = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/'

const 模块 = {
  'tool.js': ['registerSendTool', 'registerEmojiSearchTool', 'registerHistoryTool', 'registerQzoneTool', 'registerCollectTool', 'registerFacePreviewTool', 'registerWaitTool', 'registerListenTool', 'registerPassTool', 'registerCloseTool', 'registerRememberTool', 'registerFeelTool', 'registerReactTool', 'registerStatusTool', 'registerBoardTool', 'registerLaterTool', 'registerShareCardTool', 'registerAudioUnderstandTool', 'registerWatchVideoTool', 'registerUnsendTool', 'registerSelfTool', 'registerLieTool'],
  'voice.js': ['registerVoiceSendTool'],
  'sayVoice.js': ['registerSayVoiceTool'],
  'screen.js': ['registerScreenTool'],
  'go.js': ['registerGoTool'],
  'recall.js': ['registerRecallTool'],
  'photo.js': ['registerPhotoTool'],
  'items.js': ['registerItemTool'],
  'sleep.js': ['registerSleepTool'],
  'money.js': ['registerMoneyTool'],
  'work.js': ['registerWorkTool'],
}

let 缓存 = null
async function 全部() {
  if (缓存) return 缓存
  const defs = []
  const seen = new Set()
  const tools = {
    register(d) {
      if (d && d.name && !seen.has(d.name)) { seen.add(d.name); defs.push(d) }
      return () => {}
    },
  }
  const ctx = { tools, get: (k) => (k === 'tools' ? tools : undefined), effect() {}, log() {}, getConfig: () => ({}) }
  const 缺 = []
  for (const [f, fns] of Object.entries(模块)) {
    const m = await import(L + f)
    for (const fn of fns) {
      if (typeof m[fn] !== 'function') { 缺.push(f + ' 没有 ' + fn); continue }
      try { await m[fn](ctx) } catch (e) { 缺.push(f + ' ' + fn + ' 抛错：' + e.message) }
    }
  }
  await new Promise((r) => setTimeout(r, 200))
  缓存 = { defs, 缺 }
  return 缓存
}

/** 按 schema 造一个「形状合法」的返回值 */
const 造值 = (p) => {
  const o = {}
  for (const [k, v] of Object.entries(p || {})) {
    if (!v || typeof v !== 'object') { o[k] = ''; continue }
    if (Array.isArray(v.enum) && v.enum.length) o[k] = v.enum[0]
    else if (v.type === 'number' || v.type === 'integer') o[k] = 1
    else if (v.type === 'boolean') o[k] = true
    else if (v.type === 'array') o[k] = []
    else if (v.type === 'object') o[k] = {}
    else o[k] = '示例'
  }
  return o
}

/** render 可能返回字符串 / 数组 of {type:'text',text} / 单个块 */
const 取文 = (r) => {
  if (typeof r === 'string') return r
  if (Array.isArray(r)) return r.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('')
  if (r && typeof r.text === 'string') return r.text
  return ''
}

const 白名单 = new Set(['at', 'true', 'false', 'null', 'http', 'https'])

test('A 全部工具都注册得上（注册失败是静默的，只看 note）', async () => {
  const { defs, 缺 } = await 全部()
  assert.deepEqual(缺, [], '有工具的注册函数没跑通：' + 缺.join('；'))
  assert.ok(defs.length >= 32, '注册到的工具只有 ' + defs.length + ' 个，少了说明某个注册被别的东西挡了')
})

test('B 每个工具都有 output.schema + render，且 render 对合法返回值不吐空串', async () => {
  const { defs } = await 全部()
  const 坏 = []
  for (const d of defs) {
    if (!d.output || !d.output.schema) { 坏.push(d.name + '：没有 output.schema'); continue }
    if (typeof d.output.render !== 'function') { 坏.push(d.name + '：没有 output.render'); continue }
    try {
      const t = 取文(d.output.render({}, 造值(d.output.schema.properties)))
      if (t.trim() === '') 坏.push(d.name + '：render 给了空串（她那边一片空白）')
    } catch (e) { 坏.push(d.name + '：render 抛错 ' + e.message) }
  }
  assert.deepEqual(坏, [])
})

test('C required 里的名字必须真声明；每个参数都要有说明', async () => {
  const { defs } = await 全部()
  const 坏 = []
  for (const d of defs) {
    const props = Object.keys((d.parameters && d.parameters.properties) || {})
    const req = (d.parameters && d.parameters.required) || []
    for (const k of req) if (!props.includes(k)) 坏.push(d.name + '：required 里的 ' + k + ' 没声明')
    for (const k of props) {
      const 说 = String(d.parameters.properties[k] && d.parameters.properties[k].description || '').trim()
      if (说 === '') 坏.push(d.name + '：参数 ' + k + ' 没有说明')
    }
  }
  assert.deepEqual(坏, [])
})

test('D 描述里写成 xxx= / xxx: 的名字必须是真参数（qq_sleep 的 mode 就是这条）', async () => {
  const { defs } = await 全部()
  const 坏 = []
  for (const d of defs) {
    const props = Object.keys((d.parameters && d.parameters.properties) || {})
    const 文 = String(d.description || '')
    // 前面不能是字母数字或 [（挡掉 [[at:QQ号]] 这种），白名单挡掉 true/false/url 之类
    for (const m of 文.matchAll(/(^|[^A-Za-z0-9_[])([a-z][a-z0-9_]{1,20})\s*[=:]/g)) {
      const t = m[2]
      if (props.includes(t) || 白名单.has(t)) continue
      坏.push(d.name + '：描述里的「' + t + '=」不对应任何参数（真参数：' + props.join(',') + '）')
    }
  }
  assert.deepEqual(坏, [])
})

test('E execute 里读的 args.X 必须已声明（否则那一支永远走不到）', async () => {
  const { defs } = await 全部()
  const 坏 = []
  for (const d of defs) {
    if (typeof d.execute !== 'function') continue
    const props = Object.keys((d.parameters && d.parameters.properties) || {})
    const src = d.execute.toString()
    const 读 = new Set()
    for (const m of src.matchAll(/args\s*(?:\?\.|\.)\s*([A-Za-z_][A-Za-z0-9_]*)/g)) 读.add(m[1])
    for (const m of src.matchAll(/args\s*\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g)) 读.add(m[1])
    for (const m of src.matchAll(/\{\s*([^{}]+?)\s*\}\s*=\s*args/g)) {
      for (const seg of m[1].split(',')) {
        const nm = seg.split(':')[0].split('=')[0].trim()
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(nm)) 读.add(nm)
      }
    }
    for (const k of 读) if (!props.includes(k)) 坏.push(d.name + '：读了没声明的 ' + k)
  }
  assert.deepEqual(坏, [])
})
