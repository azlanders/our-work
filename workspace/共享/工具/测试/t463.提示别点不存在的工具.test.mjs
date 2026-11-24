// t463.提示别点不存在的工具.test.mjs —— 批次463（2026-11-14）
//
// 主人发的视频讲的坑：插件提醒她调 compress，白名单没有 compress → 调不到 → 反复提醒 → 烧 token。
// 形状是「**有人叫她调一个她看不见的工具**」。她这儿没有这个坑，但没有任何东西挡着它以后出现。
//
// 契约新增第 85 项钉这个：每轮注入的文本里出现的 qq_* 名字，必须都在 工具白名单 里。
// 这里再独立复算一遍 + 验它真的会红。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const DIR = '{{BOT_ROOT}}'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 契约 = fs.readFileSync(path.join(DIR, '共享/工具/契约检查.mjs'), 'utf8')

const 剥注释 = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('A1 契约里有这一项，而且剥了注释再扫', () => {
  assert.ok(契约.includes('提示里提到的 qq_* 工具都在白名单'), '契约里没有这一项')
  assert.ok(/剥注释再扫/.test(契约) || /replace\(\/\\\/\\\*/.test(契约), '没有剥注释的步骤')
})

test('A2 独立复算：注入面提到的 qq_* 全在白名单', () => {
  const 白 = new Set((JSON.parse(fs.readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8')).工具白名单) || [])
  const 缺 = new Set()
  for (const f of ['SOUL.md', '门牌.md', '梗知识.md', '热记忆.md']) {
    let t = ''
    try { t = fs.readFileSync(path.join(DIR, f), 'utf8') } catch { continue }
    for (const m of t.matchAll(/\bqq_[a-z][a-z0-9_]{2,24}\b/g)) if (!白.has(m[0])) 缺.add(m[0] + '(' + f + ')')
  }
  for (const f of ['voiceSlots.js', 'poll.js', 'stateVoice.js']) {
    let t = ''
    try { t = 剥注释(fs.readFileSync(path.join(LIB, f), 'utf8')) } catch { continue }
    for (const m of t.matchAll(/\bqq_[a-z][a-z0-9_]{2,24}\b/g)) if (!白.has(m[0])) 缺.add(m[0] + '(' + f + ')')
  }
  assert.deepEqual([...缺], [], '这些工具被注入文本提到、却不在白名单：' + [...缺].join('、'))
})

test('A3 白名单里的 qq_* 都真的注册得上（别反着漏）', () => {
  const 白 = (JSON.parse(fs.readFileSync('{{DSH_ROOT}}/qq-bridge.config.json', 'utf8')).工具白名单) || []
  // 不能只看 tool.js —— qq_go / qq_photo / qq_screen 这些注册在 go.js / photo.js / screen.js 里
  let 源码 = ''
  for (const f of fs.readdirSync(LIB)) if (f.endsWith('.js')) 源码 += fs.readFileSync(path.join(LIB, f), 'utf8')
  const 缺 = 白.filter((x) => x.startsWith('qq_') && !源码.includes("'" + x + "'") && !源码.includes('"' + x + '"'))
  assert.deepEqual(缺, [], '白名单里有、但 lib 里找不到注册：' + 缺.join('、'))
})
