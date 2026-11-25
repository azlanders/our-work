// 批次676（拟人化红线）：审计 P1-1..P1-24 逐条清掉的条件成句 / 行为规定。
//
// 红线：代码只递事实、数值、权重；不写死台词、不命令她怎么做，
// 不替她决定说不说 / 接不接 / 插不插 / 解释不解释。
//
// 这里不验文案好坏，只锁两件事：
//   ① 被点名的那句（剥掉注释后的源码里）不再出现；
//   ② 同一处保留的事实 / 数值句仍然在。
// 测试只读本地镜像（默认按本文件位置推到 ../../plugin-lib），
// 也可用 QQ_LIB_DIR 指向别的镜像；不跑服务、不读生产文件。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 线上lib = '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const lib = process.env.QQ_LIB_DIR || (existsSync(path.join(线上lib, 'poll.js')) ? 线上lib : path.resolve(本目录, '..', '..', 'plugin-lib'))
const 齐 = ['poll.js', 'photo.js', 'voiceSlots.js'].every((f) => existsSync(path.join(lib, f)))
const 跳过 = '找不到 QQ_LIB_DIR 下的 poll.js / photo.js / voiceSlots.js'
const 读 = (f) => readFileSync(path.join(lib, f), 'utf8')
// 注释里会记录「原来是什么」，那是历史，不是还在跑的提示。
const 去注释 = (s) => String(s)
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n')
  .map((l) => l.replace(/(^|[^:\\])\/\/.*$/, '$1'))
  .join('\n')

const poll = 齐 ? 去注释(读('poll.js')) : ''
const photo = 齐 ? 去注释(读('photo.js')) : ''
const voice = 齐 ? 去注释(读('voiceSlots.js')) : ''
const 入口 = 齐 ? 去注释(读('记忆入口.mjs')) : ''

const 不见 = (源, 句, 文件) => assert.ok(!源.includes(句), 文件 + ' 仍出现旧句：' + 句)
const 仍在 = (源, 句, 文件) => assert.ok(源.includes(句), 文件 + ' 丢了事实句：' + 句)

test('P1-1/2/3/4 性格·低谷·精力·激素只递数值', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of [
    '你说话直，不爱绕弯子',
    '你说话会留三分余地',
    '话可以少、可以敷衍',
    '别等对方嗯',
    '身体有点绷着',
    '身体挺松弛、有劲',
    '这会儿不太想黏人',
    '最近你有点提不起劲',
  ]) 不见(poll, 句, 'poll.js')
  for (const 句 of [
    "bits.push('E 恃强性 ' + 一位(E) + ' / N 世故性 ' + 一位(N))",
    "'低谷：active'",
    "'精力 ' + Math.round(energy) + '/100'",
    "'多巴胺 ' + Math.round(d) + ' / 皮质醇 ' + Math.round(c) + ' / 催产素 ' + Math.round(o)",
  ]) 仍在(poll, 句, 'poll.js')
})

test('P1-5 耐心只报短/长，waitHint 与参数引用清零', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of [
    '等得住，他话没说完可以先别接',
    '耐心一般，等他停了你再接',
    '这会儿没什么耐心，别硬等',
    '底子上还愿意等',
    '底子上有点磨了',
    '底子上不太想等了',
  ]) 不见(poll, 句, 'poll.js')
  仍在(poll, "parts.push('耐心 短' + sp + '/长' + lp)", 'poll.js')
  不见(poll, "T('耐心_高'", 'poll.js')
})

test('P1-6 关系浓度·思念只报数，不替她定亲近或想躲', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of [
    '别忽然变热也别忽然变冷',
    '今天格外亲近',
    '自己人，但今天想躲一下',
    '有点想他',
  ]) 不见(poll, 句, 'poll.js')
  仍在(poll, "notes.push('关系浓度 ' + Math.round(heat * 100) + '%')", 'poll.js')
  仍在(poll, "notes.push('思念 ' +", 'poll.js')
})

test('P1-7/10 口渴与洗澡只报身体事实', { skip: 齐 ? false : 跳过 }, () => {
  不见(poll, '该找水喝', 'poll.js')
  不见(poll, '毛巾还搭在肩上', 'poll.js')
  仍在(poll, "parts.push('渴 ' + 水百 + '%（' + 渴话 + '）')", 'poll.js')
  仍在(poll, '你刚洗完澡，头发还湿着（大概 ', 'poll.js')
})

test('P1-8 睡眠只报小时数与质量百分比', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of ['睡得很沉', '睡得还行', '睡得浅', '睡得很碎']) 不见(poll, 句, 'poll.js')
  仍在(poll, "'（睡眠质量 ' + __睡分(__q) + '%'", 'poll.js')
})

test('P1-9 待命不再解释成闲着等你说话', { skip: 齐 ? false : 跳过 }, () => {
  不见(poll, '闲着等你说话', 'poll.js')
  不见(poll, "待命: '闲着等你说话'", 'poll.js')
})

test('P1-11/12/13 谎言·睡意·纪念日只递事实条目', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of ['说的时候会露出', '你就已经该睡了', '别硬撑到难受', '对了，今天是']) {
    不见(poll, 句, 'poll.js')
  }
  仍在(poll, '瞒着：对外「', 'poll.js')
  仍在(poll, '破绽记录：', 'poll.js')
  仍在(poll, "'睡意记录：'", 'poll.js')
  仍在(入口, '`[纪念日] ${月日}', '记忆入口.mjs')
})

test('P1-14 问句不再命令「别只陈述」', { skip: 齐 ? false : 跳过 }, () => {
  不见(poll, '别只陈述', 'poll.js')
  // INTENT_OFF：intentHint 已整体撤掉，只锁「别只陈述」不再出现
})

test('P1-15/16 纯图与积压只报客观信息', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of ['看一眼就够了', '不用把画面描述出来', '想接就接一句像人的反应', '挑最要紧的一两句', '挨个补会像刷屏']) {
    不见(poll, 句, 'poll.js')
  }
  仍在(poll, '这张图没配文字、也没点你名。', 'poll.js')
  仍在(poll, '最早一条在 ', 'poll.js')
})

test('P1-17/18 外群与连发只报场合和条数', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of ['可以短接一两句', '不必等点名', '就别插', '觉得没说完就先别说', '等他补完再答', '想插一句也可以']) {
    不见(poll, 句, 'poll.js')
  }
  仍在(poll, '（这是外群，人多。）', 'poll.js')
  仍在(poll, '刚才连着发了 ', 'poll.js')
})

test('P1-19 相册不再要求照这个说', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of ['照这个说', '没拍过的别编', '别当刚拍的发给他', '要发就说清楚是旧的那张']) {
    不见(photo, 句, 'photo.js')
  }
  仍在(photo, '[相册] 你最近拍过：', 'photo.js')
  仍在(photo, '出的旧图', 'photo.js')
})

test('P1-20 眯醒只报时长与醒来时刻', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of ['脑子还沉', '慢半拍', '还没全回神', '醒了大半']) 不见(voice, 句, 'voiceSlots.js')
  仍在(voice, "'[你眯过一会儿] ' + 分 + ' 分钟，' + 时分 + ' 醒的。'", 'voiceSlots.js')
})

test('P1-21/22/23/24 表情·穿衣·一起听·接梗不再附行为规定', { skip: 齐 ? false : 跳过 }, () => {
  for (const 句 of ['正经讲事时别甩图', '换着甩', '想添就去买一件', '冷了没得换', '自然顺着旋律', '别当百科解释', '别毒舌呛人']) {
    不见(voice, 句, 'voiceSlots.js')
  }
  仍在(voice, '；是否发送由你决定）', 'voiceSlots.js')
  仍在(voice, '衣柜里能凑的只有 ', 'voiceSlots.js')
  仍在(voice, "return line + '。'", 'voiceSlots.js')
  仍在(voice, '——接不接、怎么接由你定。', 'voiceSlots.js')
})
