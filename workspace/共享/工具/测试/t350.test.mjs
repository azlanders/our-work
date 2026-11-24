import test from 'node:test'
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync } from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// SELF_NAMES_ENV 2026-11-24：calledByMyname() 读 process.env.QQ_SELF_NAMES，
// 读不到回落「{{ALT_BOT_DISPLAY}}」（别家 bot 的名字）。这个测试断言「{{BOT_DISPLAY}}你在吗」算点名，
// 却从没设置这个环境变量 → 判据用的是别人的名字，必然 false。
// 红的不是代码，是测试漏了一行 env。这里显式设定，并在断言前说明它来自哪。
process.env.QQ_SELF_NAMES = process.env.QQ_SELF_NAMES || '{{BOT_DISPLAY}}'

// GROUP_TIER_LOG 在函数内读，运行时设就生效
const 临时 = '/tmp/t350'
rmSync(临时, { recursive: true, force: true })
mkdirSync(临时, { recursive: true })
process.env.GROUP_TIER_LOG = 临时 + '/强度.jsonl'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { groupNeedsReply, 记一次开口, 群冷却剩余 } = await import(LIB + '/poll.js')

// OWN_GROUPS_CFG 2026-11-24：这里原来写死 `主群 = '2000000001'` —— 一个不存在的假群号。
// poll.js 的 OWN_GROUPS 是「主群名单」，假群号永远不在里面，于是
// 「普通群聊消息：放行」这类断言全部变成 false，红的不是代码，是测试在测一个假群。
// 现在从 qq-bridge.config.json 的 groupUins 取真主群；取不到再回落一个显式假号，
// 并且把「是不是主群」作为前置条件断言出来 —— 配错时一眼能看出是哪一层的问题。
function 取主群() {
  try {
    const p = (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/qq-bridge.config.json'
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const g = Array.isArray(j.groupUins) ? j.groupUins : []
    if (g.length) return String(g[0])
  } catch { /* 读不到就回落 */ }
  return '2000000001'
}
const ME = '3556352474'
// 批次352：假群号 'g1' 现在算「外群」—— 没点名本来就不回。
// 要测冷却/纯图/紧急词，必须用主群号，否则测的是外群判据。
const 主群 = 取主群()
const 配置 = (extra = {}) => ({ selfUin: ME, groupOnlyWhenAt: false, groupStrengthObserve: false, ...extra })
const 文本 = (s) => ({ message_id: String(Math.random()).slice(2), sender: { user_id: '123456' }, message: [{ type: 'text', data: { text: s } }] })
const 图片 = () => ({ message_id: String(Math.random()).slice(2), sender: { user_id: '123456' }, message: [{ type: 'image', data: { file: 'a.jpg' } }] })
const 艾特 = (qq) => ({ type: 'at', data: { qq } })

test('普通群聊消息：放行', () => {
  assert.equal(groupNeedsReply(文本('今天天气不错'), 配置(), 主群), true)
})

test('推回（「没跟你说话」）：不接', () => {
  assert.equal(groupNeedsReply(文本('没跟你说话'), 配置(), 主群), false)
})

test('@别人、没点她名：让位', () => {
  const m = 文本('你看这个')
  m.message.unshift(艾特('999888'))
  assert.equal(groupNeedsReply(m, 配置(), 主群), false)
})

test('@她：放行（哪怕 groupOnlyWhenAt）', () => {
  const m = 文本('你看这个')
  m.message.unshift(艾特(ME))
  assert.equal(groupNeedsReply(m, 配置({ groupOnlyWhenAt: true }), 主群), true)
})

test('点她名字：放行（哪怕 groupOnlyWhenAt）', () => {
  assert.equal(groupNeedsReply(文本('{{BOT_DISPLAY}}你在吗'), 配置({ groupOnlyWhenAt: true }), 主群), true)
})

test('groupOnlyWhenAt 且没点她：不接', () => {
  assert.equal(groupNeedsReply(文本('今天天气不错'), 配置({ groupOnlyWhenAt: true }), 主群), false)
})

test('纯图没文字、没 @：放行 —— mediaOnly 其实是个死判据', () => {
  // 写测试时才发现：`textOf()` 会给图片段生成占位文字 "[图片]"，
  // 所以 `text === ''` 永远不成立 → `mediaOnly` 恒为 false →
  // `if (mediaOnly && !atMe && !calledByName) return false` 从来没生效过。
  // 实际行为是「照投，由她判断」（跟 SEE_ALL 那条注释的意图一致）。
  // 这条断言钉住的是**当前真实行为**，不是我以为的行为。
  assert.equal(groupNeedsReply(图片(), 配置(), 主群), true)
})

test('纯图但 @ 了她：接（当他想让她看）', () => {
  const m = 图片()
  m.message.push(艾特(ME))
  assert.equal(groupNeedsReply(m, 配置(), 主群), true)
})

test('空文本没 @：不接', () => {
  const m = { message_id: 'x1', sender: { user_id: '1' }, message: [] }
  assert.equal(groupNeedsReply(m, 配置(), 主群), false)
})

test('小肥鱼不算叫她（只认「{{BOT_DISPLAY}}」）', () => {
  assert.equal(groupNeedsReply(文本('小肥鱼呢'), 配置({ groupOnlyWhenAt: true }), 主群), false)
})
test('20 秒冷却：刚开过口就不接', () => {
  const gid = 主群
  记一次开口(gid)
  assert.ok(群冷却剩余(gid) > 0, '冷却应该生效')
  assert.equal(groupNeedsReply(文本('随便说点'), 配置(), gid), false)
})

test('紧急词穿透冷却', () => {
  const gid = 主群
  记一次开口(gid)
  assert.equal(groupNeedsReply(文本('紧急，停一下'), 配置(), gid), true)
})

test('@ 她穿透冷却', () => {
  const gid = 主群
  记一次开口(gid)
  const m = 文本('在吗')
  m.message.unshift(艾特(ME))
  assert.equal(groupNeedsReply(m, 配置(), gid), true)
})

