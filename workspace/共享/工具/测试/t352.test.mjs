import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 /data/hajimi-dsh/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// SELF_NAMES_ENV 2026-11-24：calledByMyname() 读 process.env.QQ_SELF_NAMES，
// 读不到会回落成**别家 bot 的名字**。本文件多处断言「点名要接」，
// 却从没设置这个 env → 判据拿别人的名字去匹配，必然 false。
// 红的不是代码，是测试漏了一行 env。
process.env.QQ_SELF_NAMES = process.env.QQ_SELF_NAMES || '哈基米'

// 批次352：筛批判据跟投递侧对齐（静音期 + 外群没点名）。
// POLL_FILE 可指向改前备份，用来证明「改前是红的」。
const 临时 = '/tmp/t352'
rmSync(临时, { recursive: true, force: true })
mkdirSync(临时, { recursive: true })
process.env.GROUP_TIER_LOG = 临时 + '/强度.jsonl'
process.env.QQ_AUTONOMY_MEM = 临时
process.env.QQ_PHONE_FILE = 临时 + '/手机.json'
process.env.FEEL_FILE = 临时 + '/感受.jsonl'
writeFileSync(临时 + '/自主.json', JSON.stringify({ state: '发呆' }))

const LIB = '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const 被测 = process.env.POLL_FILE || (LIB + '/poll.js')
const __poll = await import(被测)
const { feelHint } = await import(process.env.FEEL_MODULE || (LIB + '/感受.mjs'))
const { groupNeedsReply, 群聊显式叫起, 限群聊上下文, 记一次开口, 群冷却剩余, 关系提示目标 } = __poll
const { stateHintRecipient } = __poll
const { markVoiceTarget, buildVoiceText } = await import(LIB + '/stateVoice.js')
const { muteFor, clearMute } = await import(LIB + '/mute.js')
const { targetKeyOf } = await import(LIB + '/outbound.js')

// OWN_GROUPS_CFG 2026-11-24：这里原来写死 `主群 = '2000000001'` —— 一个不存在的假群号。
// poll.js 的 OWN_GROUPS 是「主群名单」，假群号永远不在里面，于是
// 「普通群聊消息：放行」这类断言全部变成 false，红的不是代码，是测试在测一个假群。
// 现在从 qq-bridge.config.json 的 groupUins 取真主群；取不到再回落一个显式假号，
// 并且把「是不是主群」作为前置条件断言出来 —— 配错时一眼能看出是哪一层的问题。
function 取主群() {
  try {
    const p = (process.env.DSH_HOME || '/data/hajimi-dsh') + '/qq-bridge.config.json'
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const g = Array.isArray(j.groupUins) ? j.groupUins : []
    if (g.length) return String(g[0])
  } catch { /* 读不到就回落 */ }
  return '2000000001'
}
const ME = '3556352474'
const 主群 = 取主群()
const 外群 = '1051483012'
const 配置 = (extra = {}) => ({ selfUin: ME, groupOnlyWhenAt: false, groupStrengthObserve: false, ...extra })
const 文本 = (s) => ({ message_id: String(Math.random()).slice(2), sender: { user_id: '123456' }, message: [{ type: 'text', data: { text: s } }] })
const 艾特 = (qq) => ({ type: 'at', data: { qq } })

test('追问兜底：缺少会话上下文时不发送忙去了类固定句', () => {
  const followup = readFileSync(process.env.FOLLOWUP_FILE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/followup.js', 'utf8')
  assert.doesNotMatch(followup, /await sendToQQ\(entry\.target, pickLine\(\), \{ followup: true \}\)/)
})

test('余额刷新联动：强刷同步 key 卡、节流并尊重只读', async () => {
  const { readFileSync } = await import('node:fs')
  const vm = await import('node:vm')
  const html = readFileSync(process.env.BALANCE_HTML_FILE || '/data/hajimi-workspace/共享/工具/简洁页.html', 'utf8')
  const get = (start, end) => {
    const a = html.indexOf(start)
    const b = html.indexOf(end, a)
    assert.ok(a >= 0 && b > a, `missing UI function ${start}`)
    return html.slice(a, b)
  }
  const top = get('function __initBalance(){', 'tickClock();')
  const api = get('function __initApi(){', 'async function loadDebug(){')
  const document = {
    nodes: new Map(),
    getElementById(id) { if (!this.nodes.has(id)) this.nodes.set(id, { id, className: '', classList: { add() {}, remove() {} }, style: {}, dataset: {}, innerHTML: '', textContent: '', title: '', querySelectorAll() { return [] } }); return this.nodes.get(id) },
    querySelectorAll() { return [] },
  }
  const listeners = new Map()
  const window = { __balanceRefreshAt: 0, addEventListener(name, fn) { listeners.set(name, fn) }, dispatchEvent(ev) { const fn = listeners.get(ev.type); if (fn) fn(ev); return true } }
  const calls = []
  let now = 50000
  let readOnly = false
  const context = {
    window, document, $: (id) => document.getElementById(id), console, Promise, Set, Map, Date: class extends Date { static now() { return now } },
    CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail } },
    setInterval() { return 1 }, clearInterval() {},
    __ask回: true, 预览客人: false, ROLE: 'owner',
    dbgEsc: (x) => String(x ?? ''), uFmt: (x) => String(x ?? 0),
    loadUsage() {}, windowHeight: 0,
    Math, JSON, Number, String, Array, Object, RegExp, Boolean, Error,
  }
  context.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body })
    if (url.startsWith('/api/balance')) return { json: async () => ({ ok: true, 类型: 'balance', 余额: 12, 供应商: 'mock', 今日: {} }) }
    if (url.startsWith('/api/apikey')) {
      if (options.method === 'POST') return { json: async () => ({ ok: true, 候选: [{ id: 'k1', 名: 'mock', 查: { ok: true, 余额: 12, 币: 'USD' }, 模型: { 列表: [{ id: 'deepseek-flash' }] } }], 中转: {} }) }
      return { json: async () => ({ ok: true, 只读: readOnly, 候选: [], 中转: {} }) }
    }
    throw new Error('unexpected URL')
  }
  vm.runInNewContext(top + '\n__initBalance()', context)
  await new Promise((resolve) => setImmediate(resolve))
  vm.runInNewContext(api + '\n__initApi()', context)
  const balanceNode = document.getElementById('balChip')
  balanceNode.onclick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((x) => x.url === '/api/apikey' && x.method === 'POST' && JSON.parse(x.body || '{}').action === 'balance').length, 1, JSON.stringify(calls.map(({url, method, body}) => ({url, method, body}))))
  assert.equal(calls.filter((x) => x.url === '/api/balance?force=1').length, 1)
  assert.match(document.getElementById('apiCands').innerHTML, /¥12\.00/, 'key 卡片应显示刷新后的余额')

  now += 1000
  window.dispatchEvent(new context.CustomEvent('balance:refresh', { detail: { at: now } }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((x) => x.url === '/api/apikey' && x.method === 'POST' && JSON.parse(x.body || '{}').action === 'balance').length, 1, '15秒内重复事件应节流')

  now += 16000
  readOnly = true
  balanceNode.onclick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.filter((x) => x.url === '/api/apikey' && x.method === 'POST' && JSON.parse(x.body || '{}').action === 'balance').length, 1, JSON.stringify(calls.map(({url, method, body}) => ({url, method, body}))))
})

test('感受提示：私聊只回放当前对象记录，缺对象和群聊不注入个人记录', () => {
  const now = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  writeFileSync(临时 + '/感受.jsonl', [
    JSON.stringify({ at: now, who: 'peer-b', kind: '被骂', why: '另一对象的合成测试记录' }),
    JSON.stringify({ at: now, who: 'peer-b', kind: '被骂', why: '另一对象重复记录二' }),
    JSON.stringify({ at: now, who: 'peer-b', kind: '被骂', why: '另一对象重复记录三' }),
    JSON.stringify({ at: now, who: 'peer-b', kind: '被骂', why: '另一对象重复记录四' }),
    JSON.stringify({ at: now, who: 'peer-a', kind: '陪伴', why: '当前对象的合成测试记录' }),
  ].join('\n') + '\n')
  const nameOf = (who) => who === 'peer-a' ? '测试对象A' : who === 'peer-b' ? '测试对象B' : ''
  const own = feelHint(nameOf, 'peer-a')
  assert.match(own, /测试对象A/)
  assert.doesNotMatch(own, /peer-b|测试对象B|另一对象的合成测试记录/)
  assert.doesNotMatch(own, /七天你自己记的|这个月：/, 'foreign repeated records must not enter aggregates')
  assert.equal(feelHint(nameOf, ''), '')
})

test('主人关系提示受众：只给主人私聊注入主人档案，通用状态仍保留', () => {
  assert.equal(typeof stateHintRecipient, 'function')
  const owner = 'owner-test'
  assert.deepEqual(stateHintRecipient({ peerUin: owner, isPrivate: true }, owner), { ownerPrivate: true })
  assert.deepEqual(stateHintRecipient({ peerUin: 'peer-test', isPrivate: true }, owner), { ownerPrivate: false })
  assert.deepEqual(stateHintRecipient({ peerUin: 'peer-test', isPrivate: false }, owner), { ownerPrivate: false })
  assert.deepEqual(stateHintRecipient({ peerUin: owner, isPrivate: false }, owner), { ownerPrivate: false })
  assert.deepEqual(stateHintRecipient({ peerUin: owner, isPrivate: true }, ''), { ownerPrivate: false })

  const source = readFileSync(process.env.POLL_FILE || (LIB + '/poll.js'), 'utf8')
  const start = source.indexOf('export function stateHintOf')
  // 批次427：poll.js 里的记忆路径收敛成了 `${MEM}/好感度.json`，字面量锚点跟着改。
  // 钉字面量的断言必然在这种收敛里失效 —— 失效时 indexOf 返回 -1，后面的 slice 会静默变空。
  const aff = source.indexOf('const aff = `${MEM}/好感度.json`', start)
  const relationship = source.indexOf('// 2026-11-01：关系档 = 好感 × 熟悉度', aff)
  const ownerOpen = source.lastIndexOf('if (__audience.ownerPrivate) {', relationship)
  const ownerClose = source.indexOf('// PERSONA_FIRST_HOOK', relationship)
  assert.ok(start >= 0 && aff > start && relationship > aff && ownerOpen > aff && ownerOpen < relationship && ownerClose > relationship)
  const common = source.slice(start, relationship)
  const personal = source.slice(ownerOpen, ownerClose)
  assert.match(common, /parts\.push\(`精力 /, '通用身体状态应保留')
  assert.match(common, /parts\.push\('你自己这会儿在|parts\.push\('你正在/, '通用活动状态应保留')
  assert.match(common, /if \(__audience\.ownerPrivate\) parts\.push\('对主人 /, '主人好感分单独受众隔离')
  assert.match(personal, /parts\.push\('关系：/)
  assert.match(personal, /parts\.push\('说话的样：/)
  assert.match(personal, /parts\.push\('此刻的感受：/)
  // 批次197：调用点搬进 stateVoice.js 的 systemPrompt.context()，且刻意把 text/history 置空
  //（那段要进缓存，不能带逐条消息的内容）。所以这里改查真正的那一处。
  const 声 = readFileSync(process.env.STATEVOICE_FILE || (LIB + '/stateVoice.js'), 'utf8')
  assert.match(声, /stateHintOf\(\{ text: '', history: \[\], peerUin: t\.peer, isPrivate: t\.isPrivate \}\)/,
    '状态注入必须把收件人和私聊/群聊一起传下去')
})

test('system context：stateHintOf receives the actual recipient and privacy mode', () => {
  const owner = 'owner-test'
  const seen = []
  const agent = {}
  const context = buildVoiceText(agent, {
    stateHintOf: (opts) => { seen.push(opts); return '' },
    voiceHintOf: () => '',
    ownerUin: owner,
    状态进正文: false,
  })
  markVoiceTarget(agent, { peer: owner, isPrivate: true, lastText: 'owner text', at: Date.now() })
  context()
  markVoiceTarget(agent, { peer: 'peer-test', isPrivate: false, lastText: 'group text', at: Date.now() + 1 })
  context()
  assert.deepEqual(seen.map(({ peerUin, isPrivate }) => ({ peerUin, isPrivate })), [
    { peerUin: owner, isPrivate: true },
    { peerUin: 'peer-test', isPrivate: false },
  ])
})

test('外群没点名：不接（would=false）', () => {
  assert.equal(groupNeedsReply(文本('今天天气不错'), 配置(), 外群), false)
})

test('外群 @ 她：接', () => {
  const m = 文本('你看这个'); m.message.unshift(艾特(ME))
  assert.equal(groupNeedsReply(m, 配置(), 外群), true)
})

test('外群点她名字：接', () => {
  assert.equal(groupNeedsReply(文本('哈基米在吗'), 配置(), 外群), true)
})

test('外群引用她或紧急消息：进入候选；不引用她的回复不升级', () => {
  const quote = { ...文本('接着说'), message: [{ type: 'reply', data: { id: '902' } }, { type: 'text', data: { text: '接着说' } }] }
  const history = [{ message_id: 902, sender: { user_id: ME } }]
  assert.equal(groupNeedsReply(quote, 配置(), 外群, history), true)
  assert.equal(groupNeedsReply(文本('紧急，先处理'), 配置(), 外群), true)
  assert.equal(groupNeedsReply(quote, 配置(), 外群, [{ message_id: 902, sender: { user_id: '999' } }]), false)
})


test('主群普通消息仅成为看手机候选；只在@配置下不启动候选', () => {
  resetPhone()
  clearMute(targetKeyOf({ kind: 'group', id: 主群 }))
  assert.equal(groupNeedsReply(文本('今天天气不错'), 配置(), 主群), true)
  const own = 文本('机器人自己发的内容'); own.sender.user_id = ME
  assert.equal(groupNeedsReply(own, 配置(), 主群), false)
  assert.equal(groupNeedsReply(文本('今天天气不错'), 配置({ groupOnlyWhenAt: true }), 主群), false)
  assert.equal(groupNeedsReply(文本('今天天气不错'), 配置({ phoneGate: false }), 主群), false)
})

test('群聊持续窗口：同一发送者在@模式下可续接，旁人不能接入，续接绕过刚开口冷却', () => {
  resetPhone()
  const t0 = Date.now()
  记回话(主群, t0, '123456', { explicit: true })
  记一次开口(主群)
  assert.ok(群冷却剩余(主群) > 0)
  const same = 文本('继续刚才的话')
  same.sender.user_id = '123456'
  const other = 文本('插入无关话题')
  other.sender.user_id = '777777'
  const gate = 配置({ groupOnlyWhenAt: true, phoneGate: true })
  assert.equal(groupNeedsReply(same, gate, 主群), true)
  assert.equal(groupNeedsReply(other, gate, 主群), false)
})

test('群聊显式启动：点名、正确引用她、紧急内容可启动；引用他人不算', () => {
  const named = 文本('哈基米你在吗')
  assert.equal(群聊显式叫起(named, 配置(), []), true)
  const quoted = { ...文本('接着问'), message: [{ type: 'reply', data: { id: '901' } }, { type: 'text', data: { text: '接着问' } }] }
  assert.equal(群聊显式叫起(quoted, 配置(), [{ message_id: 901, sender: { user_id: ME } }]), true)
  assert.equal(群聊显式叫起(quoted, 配置(), [{ message_id: 901, sender: { user_id: '999' } }]), false)
  assert.equal(群聊显式叫起(文本('先处理'), 配置({ groupOnlyWhenAt: true }), []), true)
})

test('群聊上下文始终最多3条且每条最多240字', () => {
  const out = 限群聊上下文(['a'.repeat(500), 'b'.repeat(500), 'c'.repeat(500), 'd'.repeat(500)], 99, 999)
  assert.equal(out.length, 3)
  assert.deepEqual(out.map((line) => line.length), [240, 240, 240])
  assert.deepEqual(限群聊上下文(['never include'], 0, 240), [])
})

test('静音期：@ 她也不接（被拒绝后 3 分钟）', () => {
  const k = targetKeyOf({ kind: 'group', id: 主群 })
  const m = 文本('在吗'); m.message.unshift(艾特(ME))
  muteFor(k, 60000)
  try { assert.equal(groupNeedsReply(m, 配置(), 主群), false) }
  finally { clearMute(k) }
})

test('静音只作用那个群：主群不受外群静音影响', () => {
  const k = targetKeyOf({ kind: 'group', id: 外群 })
  muteFor(k, 60000)
  try { assert.equal(groupNeedsReply(文本('今天天气不错'), 配置(), 主群), true) }
  finally { clearMute(k) }
})

test('静音过期自动恢复', async () => {
  const k = targetKeyOf({ kind: 'group', id: 主群 })
  muteFor(k, 30)
  await new Promise((r) => setTimeout(r, 80))
  try { assert.equal(groupNeedsReply(文本('今天天气不错'), 配置(), 主群), true) }
  finally { clearMute(k) }
})

test('私聊媒体块按原消息顺序交错，普通消息也保留', async () => {
  const module = await import(process.env.DELIVER_MODULE || (LIB + '/deliver.js'))
  const out = module.组装私聊内容块([
    { text: '第一条', images: [], files: [] },
    { text: '[图片]', images: [{ type: 'image', attachment: 'image-1' }], files: [] },
    { text: '接着解释', images: [], files: [] },
    { text: '附带文件', images: [], files: [{ type: 'text', text: 'file-1' }] },
    { text: '下载失败的图', images: [], files: [] },
    { text: '下一张图片', images: [{ type: 'image', attachment: 'image-2' }], files: [] },
  ])
  assert.deepEqual(out, [
    { type: 'text', text: '第一条' },
    { type: 'text', text: '[图片]' },
    { type: 'image', attachment: 'image-1' },
    { type: 'text', text: '接着解释' },
    { type: 'text', text: '附带文件' },
    { type: 'text', text: 'file-1' },
    { type: 'text', text: '下载失败的图' },
    { type: 'text', text: '下一张图片' },
    { type: 'image', attachment: 'image-2' },
  ])
})

test('私聊媒体模式保留状态前缀且消息正文只出现一次', async () => {
  const module = await import(process.env.DELIVER_MODULE || (LIB + '/deliver.js'))
  const body = '状态提示\n还有更早的消息\n第一条正文\n图片后短句'
  const ordered = module.组装私聊内容块([
    { text: '第一条正文', images: [], files: [] },
    { text: '图片后短句', images: [{ type: 'image', attachment: 'image-1' }], files: [] },
  ], '状态提示\n还有更早的消息\n')
  const out = module.组装有序投递块(`记忆卡\n${body}`, body, ordered)
  assert.deepEqual(out, [
    { type: 'text', text: '记忆卡\n' },
    { type: 'text', text: '状态提示\n还有更早的消息\n第一条正文' },
    { type: 'text', text: '图片后短句' },
    { type: 'image', attachment: 'image-1' },
  ])
  const emittedText = out.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
  assert.equal((emittedText.match(/第一条正文/g) ?? []).length, 1)
  assert.equal((emittedText.match(/图片后短句/g) ?? []).length, 1)
})

test('无媒体私聊保持单块旧序列化文本', async () => {
  const module = await import(process.env.DELIVER_MODULE || (LIB + '/deliver.js'))
  const out = module.组装私聊内容块([
    { text: 'A', images: [], files: [] },
    { text: 'B', images: [], files: [] },
  ])
  assert.deepEqual(out, [{ type: 'text', text: 'A\nB' }])
})


const __phone = await import(LIB + '/phone.mjs')
const { 看手机, 记回话, 是持续对话 } = __phone
function resetPhone() { writeFileSync(临时 + '/手机.json', JSON.stringify({ groups: {}, lookTimes: [] })) }

test('看手机：明确叫起可过闸，普通消息按单群间隔节流', () => {
  resetPhone()
  const config = { phoneGate: true, groupOnlyWhenAt: false, phoneLookMin: 5, phoneLookMax: 5, phoneThreadMin: 3, phoneThreadMax: 4, phoneGroupMaxPerHour: 6 }
  const first = 看手机(config, { groupId: 'phone-a', senderUin: 'u1', text: '闲聊' }, 1000000)
  assert.equal(first.ok, true)
  assert.match(first.why, /看了一眼手机/)
  const second = 看手机(config, { groupId: 'phone-a', senderUin: 'u2', text: '又一句' }, 1001000)
  assert.equal(second.ok, false)
  assert.match(second.why, /还差/)
  const called = 看手机(config, { groupId: 'phone-a', senderUin: 'u2', text: '哈基米在吗', named: true }, 1002000)
  assert.equal(called.ok, true)
  assert.match(called.why, /被喊名字/)
})

test('看手机：整群每小时看手机次数有全局上限', () => {
  resetPhone()
  const config = { phoneGate: true, groupOnlyWhenAt: false, phoneLookMin: 1, phoneLookMax: 1, phoneGroupMaxPerHour: 600 }
  for (let i = 0; i < 6; i++) {
    const r = 看手机(config, { groupId: 'cap-' + i, senderUin: 'u' + i, text: '话题' }, 2000000 + i)
    assert.equal(r.ok, true)
  }
  const seventh = 看手机(config, { groupId: 'cap-7', senderUin: 'u7', text: '继续' }, 2000010)
  assert.equal(seventh.ok, false)
  assert.match(seventh.why, /本小时看手机次数已到上限/)
})

test('看手机：持续对话限同一发送者、三分钟、最多四次，收尾立即关窗', () => {
  resetPhone()
  const config = { phoneGate: true, groupOnlyWhenAt: true, phoneThreadMin: 300, phoneThreadMax: 400, phoneThreadMaxDurationMin: 999 }
  const t0 = 3000000
  记回话('thread-g', t0, 'owner', { explicit: true })
  assert.equal(是持续对话('thread-g', 'owner', t0 + 1000, config), true)
  assert.equal(是持续对话('thread-g', 'other', t0 + 1000, config), false)
  assert.equal(看手机(config, { groupId: 'thread-g', senderUin: 'owner', text: '接着说' }, t0 + 1000).ok, true)
  assert.equal(看手机(config, { groupId: 'thread-g', senderUin: 'other', text: '插入闲聊' }, t0 + 1000).ok, false)

  for (let i = 1; i <= 4; i++) 记回话('thread-g', t0 + i * 1000, 'owner', { continuation: true, threadMin: 3 })
  assert.equal(看手机(config, { groupId: 'thread-g', senderUin: 'owner', text: '第五句' }, t0 + 5000).ok, false)
  assert.equal(是持续对话('thread-g', 'owner', t0 + 181000, config), false)
  记回话('thread-duration', t0, 'owner', { explicit: true })
  assert.equal(是持续对话('thread-duration', 'owner', t0 + 10 * 60000 + 1, config), false)

  记回话('thread-end', t0, 'owner', { explicit: true })
  const close = 看手机(config, { groupId: 'thread-end', senderUin: 'owner', text: '好，先这样。' }, t0 + 1000)
  assert.equal(close.ok, false)
  assert.match(close.why, /收尾/)
  assert.equal(是持续对话('thread-end', 'owner', t0 + 2000, config), false)
  记回话('thread-ack', t0, 'owner', { explicit: true })
  assert.equal(看手机(config, { groupId: 'thread-ack', senderUin: 'owner', text: '好' }, t0 + 1000).closed, true)
  记回话('thread-explicit-end', t0, 'owner', { explicit: true })
  const explicitAgain = 看手机(config, { groupId: 'thread-explicit-end', senderUin: 'owner', text: '好，先这样。', named: true }, t0 + 1000)
  assert.equal(explicitAgain.ok, true)
})

test('看手机：睡着不续聊，缺省配置安全拒绝非显式消息', () => {
  resetPhone()
  writeFileSync(临时 + '/自主.json', JSON.stringify({ state: '睡觉' }))
  记回话('sleep-g', 4000000, 'u1', { explicit: true })
  const asleep = 看手机({ phoneGate: true, groupOnlyWhenAt: true, phoneThreadMin: 3, phoneThreadMax: 4 }, { groupId: 'sleep-g', senderUin: 'u1', text: '我再补一句' }, 4001000)
  assert.equal(asleep.ok, false)
  writeFileSync(临时 + '/自主.json', JSON.stringify({ state: '发呆' }))
  const missingConfig = 看手机({ groupOnlyWhenAt: true }, { groupId: 'missing', senderUin: 'u2', text: '普通消息' }, 5000000)
  assert.equal(missingConfig.ok, false)
})

test('同批筛选快照：保留未紧急的候选，紧急消息例外', () => {
  const { 应合并群消息 } = __poll
  assert.equal(typeof 应合并群消息, 'function')
  const urgent = { message_id: 1001, message: [{ type: 'text', data: { text: '紧急马上处理' } }] }
  const early = { message_id: 1002, message: [{ type: 'text', data: { text: '先前普通消息' } }] }
  const latest = { message_id: 1003, message: [{ type: 'text', data: { text: '后续普通消息' } }] }
  const outsider = { message_id: 1004, message: [{ type: 'text', data: { text: '当时不该回复' } }] }
  const lastReplyable = latest
  const replyable = new Set([early])
  assert.equal(应合并群消息(urgent, lastReplyable, replyable), false)
  assert.equal(应合并群消息(early, lastReplyable, replyable), true)
  assert.equal(应合并群消息(latest, lastReplyable, replyable), false)
  assert.equal(应合并群消息(outsider, lastReplyable, replyable), false)
  assert.equal(应合并群消息(early, latest, new Set()), false)
})
