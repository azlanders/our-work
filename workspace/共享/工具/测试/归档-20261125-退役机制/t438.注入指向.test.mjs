import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 /data/hajimi-dsh/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次438：11-12 23:19 主人问「你最近看了什么贴吧和b站视频啊」，她编了个「刷小说」，
// 被当场抓住「我寻思我没给你这个功能」。之后加了个补丁 —— 但补丁指的是：
//   bili_humanism_memory（查的是「AI 自己的理解 / 用户明确说的偏好」）
//   tieba_diary_read（读日记，public 是给主人看的、private 是感受）
// 两个都跟「我最近看了什么」无关。结果是把「编造」换成了另一种错：
// 明明昨天看过 7 个视频，照它去查只会得到一堆偏好和日记，最后还是说「没看」。
//
// 真记录一直在：记忆/视频画面/<BV号>.omni.json（at + text）、记忆/刷到的.json。
// 这个文件钉三件事，都是「别再把提示指错地方」。
const LIB = '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const POLL = LIB + '/poll.js'
const VOICE = LIB + '/voiceSlots.js'
const 记忆 = '/data/hajimi-workspace/记忆'

function 跑注入() {
  const 代码 = `
    const m = await import(${JSON.stringify(POLL)})
    const v = await import(${JSON.stringify(VOICE)})
    const 私 = { peer: '3439411062', ownerUin: '3439411062', isPrivate: true, mute: false, lastText: '' }
    const 群 = { peer: '2000000001', ownerUin: '3439411062', isPrivate: false, mute: false, lastText: '' }
    const 拼 = (ctx) => String(m.stateHintOf(ctx.peer, ctx) || '') + '\\n' + String(m.voiceHintOf(ctx.peer, ctx) || '') + '\\n' + String(v.extraSlotsHint({ ...ctx, memDir: ${JSON.stringify(记忆)} }) || '')
    console.log(JSON.stringify({ 私: 拼(私), 群: 拼(群) }))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, QQ_MEM: 记忆 },
  })
  return JSON.parse(out.trim().split('\n').pop())
}

test('A1 [冲浪养分] 不许再把「最近看了什么」指到 bili_humanism_memory / tieba_diary_read', () => {
  const { 私 } = 跑注入()
  const 行 = (私.match(/\[冲浪养分\][^\n]*/) || [''])[0]
  assert.ok(行.length > 0, '[冲浪养分] 这一轮没出现 —— 这条断言失去前提，先查 human-world.md 还在不在')
  assert.doesNotMatch(行, /bili_humanism_memory/,
    '又指回 bili_humanism_memory 了 —— 它查的是「AI 的理解/用户偏好」，读不到观看记录')
  assert.doesNotMatch(行, /tieba_diary_read/,
    '又指回 tieba_diary_read 了 —— 它读的是日记，不是「看了什么」')
})

test('A2 [冲浪养分] 必须说清真正的记录在哪', () => {
  const { 私 } = 跑注入()
  const 行 = (私.match(/\[冲浪养分\][^\n]*/) || [''])[0]
  assert.ok(行.length > 0, '[冲浪养分] 没出现')
  assert.match(行, /视频画面/, '没告诉她看过的视频记在 记忆/视频画面/')
  assert.match(行, /omni\.json/, '没说是 .omni.json（只说目录她会去翻 png/mp4）')
  assert.match(行, /刷到的/, '没告诉她群里刷到的话在 记忆/刷到的.json')
  // at 是 UTC，不提醒她会把「昨晚 21:08」说成「今天 05:08」
  assert.match(行, /UTC|加 ?8 ?小时|北京时间/, '没提 at 是 UTC —— 她要自己换算才不会把日期说错')
  // 这两个文件的说明必须同时在场；只有一处等于另一半仍然查不到
  assert.match(行, /别凭印象编|别拿上面这条素材当答案/, '防编造的口径丢了')
})

test('A3 注入里提到的工具名必须真实存在（全 lib + 两个插件 + 用量账）', () => {
  const 存在 = new Set()

  // ① 插件 lib 下所有 .js 的 name: 'xxx'（不只 tool.js —— qq_go/qq_photo/qq_screen 分别在 go.js/photo.js/screen.js）
  for (const f of readdirSync(LIB).filter((x) => x.endsWith('.js'))) {
    const s = readFileSync(join(LIB, f), 'utf8')
    for (const m of s.matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)) 存在.add(m[1])
    for (const m of s.matchAll(/name:\s*"([a-z][a-z0-9_]*)"/g)) 存在.add(m[1])
  }

  // ② bili / tieba 两个插件（它们用 register("名字", ...) 的写法）
  for (const p of [
    '/data/hajimi-dsh/profiles/web/node_modules/dsh-bili-humanism/index.js',
    '/data/hajimi-dsh/profiles/web/node_modules/dsh-tieba-dive/index.js',
  ]) {
    if (!existsSync(p)) continue
    const s = readFileSync(p, 'utf8')
    for (const m of s.matchAll(/register\(\s*"([a-z][a-z0-9_]*)"/g)) 存在.add(m[1])
    for (const m of s.matchAll(/name:\s*'([a-z][a-z0-9_]*)'/g)) 存在.add(m[1])
  }

  // ③ 用量账里出现过的（宿主内置工具没有源码可查，但被真实调用过就说明存在）
  try {
    const u = JSON.parse(readFileSync(join(记忆, '工具用量.json'), 'utf8'))
    for (const k of Object.keys(u.按工具 || {})) 存在.add(k)
    for (const k of (u.名单外 || [])) 存在.add(k)
  } catch { /* 账读不到就不靠它 */ }

  // ④ **白名单** —— `restrict({allow})` 之后她实际能调到的就是这些，这是最权威的一份。
  // 为什么必须加：有些插件注册工具时名字**不是字面量**，静态 grep 永远抓不到。
  // 实测 dsh-rofm 的 `memory_image` 是 `tools.register(this.imageTool.definition())` ——
  // 名字在函数返回值里，整个 node_modules 搜 `name: 'memory_image'` 是 0 命中。
  // 第一版 A3 因此把 `memory_image` / `video_zoom` 判成「不存在」（差点去白名单里删掉真工具）。
  // 判断工具存不存在，静态扫 + 用量账 + 白名单三份合起来才算够。
  try {
    const cfg = JSON.parse(readFileSync('/data/hajimi-dsh/qq-bridge.config.json', 'utf8'))
    for (const k of (cfg.工具白名单 || [])) 存在.add(k)
  } catch { /* 配置读不到就不靠它 */ }

  assert.ok(存在.size > 30, '注册表只收到 ' + 存在.size + ' 个，八成是收集方式坏了')

  // 只认这四种前缀 —— custom_emoji 是 qq_send 的参数名，不是工具，别误伤
  const { 私, 群 } = 跑注入()
  const 全文 = 私 + '\n' + 群
  const 候选 = new Set()
  for (const m of 全文.matchAll(/\b(qq_[a-z0-9_]+|bili_humanism_[a-z]+|tieba_[a-z_]+|memory_[a-z_]+)\b/g)) {
    候选.add(m[1])
  }
  assert.ok(候选.size >= 3, '注入里一个工具名都没抽到，判据写坏了')

  const 缺 = [...候选].filter((x) => !存在.has(x)).sort()
  assert.deepEqual(缺, [], '注入里提到了不存在的工具：' + 缺.join(', ') +
    ' —— 她会去调一个没有的东西，而且失败后不知道该改用什么')
})
