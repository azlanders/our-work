// 黑话槽的三种分支：有释义 / 无释义 / 没命中。批次388。
// 关键：旧话术「别当生词解释」必须彻底消失 —— 那句是教她装懂。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
// SB_UNIQUE 2026-11-14（批次437）：和 t388.锁 共用 /tmp/sb388，并行时互相删沙盒。
const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'sb399-'))

const { slotMemeCue } = await import(LIB + '/voiceSlots.js')

const 跑 = (词表, 文本) => {
  if (词表 === null) { try { fs.unlinkSync(沙 + '/圈子黑话.json') } catch {} }
  else fs.writeFileSync(沙 + '/圈子黑话.json', typeof 词表 === 'string' ? 词表 : JSON.stringify(词表), 'utf8')
  try { return slotMemeCue({ lastText: 文本, memDir: 沙 }) } catch (e) { return '抛错:' + e.message.slice(0, 40) }
}

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])

const 有义 = [{ 词: 'inm', 义: '一个亚文化梗，主要用来斗图', 例: 'inm牌摩托车', 问了: true }]
const 无义 = [{ 词: '老鼠', 例: '老鼠牌摩托车', 问了: false }]

// ── 有释义 ──
const a = 跑(有义, '这inm牌摩托车笑死')
加('A1 有释义：返回里带「是：」', a.includes('是：'), true)
加('A2 有释义：带上了释义原文', a.includes('一个亚文化梗'), true)
加('A3 有释义：还带例子', a.includes('inm牌摩托车'), true)
加('A4 有释义时不能再说「别当生词解释」', a.includes('别当生词解释'), false)
加('A5 有释义时不能说「不知道」', a.includes('不知道'), false)

// ── 无释义 ──
const b = 跑(无义, '老鼠牌摩托车')
加('B1 无释义：明说不知道', b.includes('不知道它什么意思'), true)
加('B2 无释义：给「可以问一句」', b.includes('问一句'), true)
加('B3 无释义：★ 旧话术「别当生词解释」必须消失', b.includes('别当生词解释'), false)
加('B4 无释义：不能说「是：」', b.includes('是：'), false)

// ── 边界 ──
加('C1 没命中 → 空串', 跑(有义, '今天天气不错'), '')
加('C2 词库不存在 → 空串', 跑(null, 'inm'), '')
加('C3 词库是坏 JSON → 空串', 跑('{坏', 'inm'), '')
加('C4 空文本 → 空串', 跑(有义, ''), '')
加('C5 词库是对象不是数组 → 空串', 跑({ 词: 'inm' }, 'inm'), '')
加('C6 单字词不触发（length>=2）', 跑([{ 词: '啊', 义: 'x' }], '啊啊啊'), '')
加('C7 释义超 60 字被截断', 跑([{ 词: 'inm', 义: '很'.repeat(80) }], 'inm').length < 200, true)
加('C8 释义为空串 → 走「不知道」分支', 跑([{ 词: 'inm', 义: '  ' }], 'inm').includes('不知道'), true)
加('C9 释义字段不存在 → 走「不知道」分支', 跑([{ 词: 'inm' }], 'inm').includes('不知道'), true)

let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (实 === 期) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实).slice(0, 90)}`)
}
fs.rmSync(沙, { recursive: true, force: true })
console.log(`通过 ${过}/${场景.length}`)
for (const x of 败) console.log('  ★ ' + x)
console.log('\n两种实际注入：')
console.log('  有释义 → ' + a)
console.log('  无释义 → ' + b)
