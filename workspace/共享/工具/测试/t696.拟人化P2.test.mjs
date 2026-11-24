// t696 —— 拟人化红线 P2 十条（审计三次报告第四节）
//
// 判据只用主人那一条：删掉这段代码，她只是「少知道一件事」 → 合规；
// 删掉后她就说不出这句话 / 不会做这个动作 → 违规。
//
// P2 全是「轻量但仍是指令」：事实留下，话术规定和替她定的情绪/动作删掉。
// 这一条按源码字符串锁「旧句不出现 + 事实仍在」，剥掉注释再匹配，
// 免得把「这里原来是什么」的历史说明当成还在跑的台词。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync  } from 'node:fs'

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

process.env.QUIET_NOTE = '1'

const 测试目录 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(测试目录, '..')
const 线上lib = (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/profiles/web/node_modules/dsh-onebot-channel/lib'
const LIB = process.env.QQ_LIB_DIR || (existsSync(join(工具, '..', 'plugin-lib')) ? join(工具, '..', 'plugin-lib') : 线上lib)

function 读源码(名) {
  const 路径 = 名.startsWith('tools/') ? join(工具, 名.slice('tools/'.length)) : join(LIB, 名)
  const s = readFileSync(路径, 'utf8')
  // 去掉行注释与块注释，只留真正会跑到的字符串
  return s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

const poll = 读源码('poll.js')
const voice = 读源码('voiceSlots.js')
const 行动 = 读源码('tools/自主行动.mjs')

test('P2-1 作息事实不再命令「照这个说」', () => {
  assert.doesNotMatch(poll, /照这个事实说/)
  assert.doesNotMatch(poll, /别自己编/)
  assert.match(poll, /以上是记录/)
  assert.match(poll, /真实作息/)
})

test('P2-2 回话时差只报事实，不给对话策略', () => {
  assert.doesNotMatch(poll, /别把已经翻篇的话题当成现在/)
  assert.match(poll, /这条是 \$\{说\}前发的/)
})

test('P2-3 未回话事实不再替她「惦记着」也不「别催」', () => {
  assert.doesNotMatch(poll, /惦记着但别催/)
  assert.match(poll, /还没得到回话/)
})

test('P2-4 同批消息不再指定「挑一句答完」', () => {
  assert.doesNotMatch(poll, /同一批消息挑一句答完/)
  assert.match(poll, /同一批消息可以合并处理/)
})

test('P2-5 天气提示去掉「问起照说」', () => {
  assert.doesNotMatch(poll, /问起照说/)
  assert.match(poll, /\[窗外\]/)
})

test('P2-6 关门的店只报营业状态，不加行为禁令', () => {
  assert.doesNotMatch(poll, /别当自己还在里头/)
  assert.doesNotMatch(poll, /别顺口答应等会儿去这儿/)
  assert.match(poll, /这个点已经关了/)
})

test('P2-7 她自己的「怕」原样递，不加第一人称话头', () => {
  assert.doesNotMatch(poll, /心里有点怕/)
  assert.match(poll, /怕的：/)
})

test('P2-8 幽默偏好不再变成「说话可以带点 X」', () => {
  assert.doesNotMatch(poll, /这会儿说话可以带点/)
  assert.match(poll, /幽默偏好：/)
})

test('P2-9 口癖清单只递她写的原文，不下执行指令', () => {
  assert.doesNotMatch(voice, /说话时自然照着来/)
  assert.match(voice, /\[你给自己记的说话习惯\]/)
  assert.match(voice, /别念出这条提示本身/)
})

test('P2-10 自动洗澡不再替她编理由', () => {
  assert.doesNotMatch(行动, /身上都黏了/)
  assert.doesNotMatch(行动, /'该洗了'/)
  assert.match(行动, /洗澡\.mjs'\), '--开始'/)
})
