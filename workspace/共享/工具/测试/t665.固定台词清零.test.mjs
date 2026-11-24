// 批次665（拟人化红线）：把审计列出的固定台词逐条清掉
//
// 红线：非必要不用代码强制她做/说某事，不写死台词、不固定选择；
// 代码只递事实、只影响权重，出口永远 qq_send / qq_pass / 沉默。
//
// 这里不验「文案好不好」，只验「那些替她说话的句子还在不在」。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const lib = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 工具 = process.env.QQ_TOOLS || '{{BOT_ROOT}}/共享/工具'
const 有 = existsSync(path.join(lib, 'poll.js')) && existsSync(path.join(工具, '心气.mjs'))
const 跳过 = '找不到线上 lib/工具 目录'
const 读 = (p) => readFileSync(p, 'utf8')
// 只看代码：注释里会写「这里原来是什么」，那是记录，不是还在跑的台词。
const 去注释 = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((l) => l.replace(/(^|[^:\\])\/\/.*$/, '$1'))
  .join('\n')
const poll = 有 ? 去注释(读(path.join(lib, 'poll.js'))) : ''
const voice = 有 ? 去注释(读(path.join(lib, 'voiceSlots.js'))) : ''

test('F1 poll.js：不再给可照念的答句', { skip: 有 ? false : 跳过 }, () => {
  for (const 句 of [
    '别人问你在忙什么，说「刚做完，现在闲着」就行',
    '别人问你在便利店做什么，说「找个角落坐着看手机」就行',
    '别人问起就照这个说',
    '问忙不忙照实说',
    '别编成在翻货架',
    '别瞎编',
  ]) {
    assert.ok(!poll.includes(句), '还留着可照念的答句：' + 句)
  }
})

test('F2 poll.js：不再替她规定表达方式', { skip: 有 ? false : 跳过 }, () => {
  for (const 句 of [
    '话说短、别解释、别铺排',
    '句子短一点',
    '话可以短、可以没条理',
    '别装精神',
    '别他一说话就顺杆爬',
    '嘴上别太急',
  ]) {
    assert.ok(!poll.includes(句), '还留着表达命令：' + 句)
  }
})

test('F3 poll.js：stateHintOf 不再拼第一人称状态句', { skip: 有 ? false : 跳过 }, () => {
  for (const 句 of [
    '心里有怨（',
    '有点想他（',
    '他欠你一句道歉',
    '这会儿不太想开口，不是生气',
    '想起来一件事：',
  ]) {
    assert.ok(!poll.includes(句), '还留着第一人称成句：' + 句)
  }
})

test('F4 voiceSlots：余温只报事件名，不翻译成感受', { skip: 有 ? false : 跳过 }, () => {
  for (const 句 of ['刚被夸过一句，心里还热着', '刚被凶过，眼睛还酸着', '刚搞砸了一下，心里发沉', '说话会带着这层']) {
    assert.ok(!voice.includes(句), '还留着第一人称余温句：' + 句)
  }
  assert.match(voice, /return '\[刚才\] ' \+ 得\.join\('、'\) \+ '（2 小时内）'/)
})

test('F5 voiceSlots：两处打架只报数值差异', { skip: 有 ? false : 跳过 }, () => {
  for (const 句 of ['身上还有劲，心已经不想动了', '困得眼睛发涩，心气倒还没塌', '脑子清楚，身体跟不上', '身体没事，脑子转不动', '熟了，可还留着一手']) {
    assert.ok(!voice.includes(句), '还留着第一人称体感判断：' + 句)
  }
  assert.match(voice, /说\.push\('精力 ' \+ Math\.round\(精\) \+ ' \/ 情绪 ' \+ Math\.round\(情\)\)/)
})

test('F6 voiceSlots：语气与关系倾向不再写死', { skip: 有 ? false : 跳过 }, () => {
  for (const 句 of ['说话懒懒的', '说话会带点俏皮', '档位倾向']) {
    assert.ok(!voice.includes(句), '还留着写死的语气/倾向：' + 句)
  }
})

test('F7 voiceSlots：梦余味直接递标签，不再翻译成暖/沉', { skip: 有 ? false : 跳过 }, () => {
  assert.ok(!voice.includes('还有点暖'))
  assert.ok(!voice.includes('心里有点沉'))
  assert.match(voice, /return '\[梦\] 今早的梦，余味：' \+ String\(余\.余味\)\.trim\(\)/)
})

test('F8 关系档：档位倾向表已删', { skip: 有 ? false : 跳过 }, () => {
  const 源 = 去注释(读(path.join(工具, '关系档.mjs')))
  assert.ok(!/export const 档位倾向/.test(源))
  for (const 句 of ['可以撒娇', '别自来熟', '不用特意拉近']) {
    assert.ok(!源.includes(句), '档位倾向里还留着行为规定：' + 句)
  }
})

test('F9 心气：今日锚不再替当天定性', { skip: 有 ? false : 跳过 }, () => {
  const 源 = 去注释(读(path.join(工具, '心气.mjs')))
  assert.ok(!源.includes('今天零碎着过了'), '还留着「今天零碎着过了」')
  assert.match(源, /return '今日记录：' \+ 有\.join\('；后来 '\) \+ '。'/)
})

test('F10 惦记 / 独处 / 谎言 / 夜里 四处也只报事实', { skip: 有 ? false : 跳过 }, () => {
  for (const 句 of ['你心里还记着：', '合适的时候顺嘴问一句', '别硬追']) {
    assert.ok(!poll.includes(句), 'poll.js 还留着惦记句：' + 句)
  }
  for (const 句 of [
    '脑子里会转这些',
    '安静下来就会想起来',
    '你没打算主动说破',
    '这是你的老毛病',
    '今天跟他聊了不少',
    '更近了、有点累、被晾着',
  ]) {
    assert.ok(!voice.includes(句), 'voiceSlots.js 还留着成句：' + 句)
  }
})
