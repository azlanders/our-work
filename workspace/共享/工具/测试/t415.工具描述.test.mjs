// t415 —— 两个零调用的工具，死在描述里（批次410）
//
// 病根：
//   29 个 qq_* 工具，7 天窗口里**只有两个是 0 调用**：qq_card、qq_audio_understand。
//   巧的是这两个的描述都写着「只在用户明确要求…时使用」——
//     qq_card           : 「仅在用户明确要分享音乐或哔哩哔哩链接时调用…不能用于自动分享、推测分享」
//     qq_audio_understand: 「只在用户明确要求分析本机下载目录内的一段音频时使用」
//   主人 2026-11-07 的原话是「你补一个发卡片消息」——他要的是**她能发卡片**，
//   不是一个只有他喊才动的按钮。语音同理：他会发语音，她听见「[语音]」想弄清口气就该能调。
//
//   这不是「安全」，是把她锁在门外。真正的闸在代码里：
//     · sendShareCard 里 `targets[kind].has(id)` —— 目标不在白名单直接 throw
//     · sendShareCard 里 `retcode === 0 && message_id > 0` —— 没回执不算发出去
//     · 两个工具都 required: ['confirm']
//
// 这个文件锁：
//   D1 那两个描述真的放开了（说清「什么时候用」，不再「只在用户明确要求」）
//   D2 安全阀一个都没少（白名单 / 回执 / confirm 必填）
//   D3 **该保留的硬约束一条都不许跟着放松** —— 否则下次有人「全部放开」就出事
//
// 跑法：node --test t415.工具描述.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? join(process.env.DSH_HOME, 'profiles/web/node_modules/dsh-onebot-channel/lib') : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const 读 = (p) => readFileSync(p, 'utf8')

/** 把某个工具的 description 抠出来（源码里可能是拼接的多段字符串） */
function 描述(name) {
  const src = 读(join(LIB, 'tool.js'))
  const i = src.indexOf("name: '" + name + "'")
  assert.ok(i > 0, '找不到工具 ' + name)
  const from = src.indexOf('description:', i)
  assert.ok(from > i, name + ' 没有 description')
  // 到 parameters: 之前都算描述（拼接的 + 也吃进来）
  const to = src.indexOf('parameters:', from)
  return src.slice(from, to > from ? to : from + 1200)
}

test('D1 两个零调用的工具，描述真的放开了', () => {
  const 卡 = 描述('qq_card')
  assert.ok(!/仅在用户明确要分享/.test(卡), 'qq_card 还是「仅在用户明确要分享」—— 她永远想不起来用')
  assert.ok(/什么时候用|时用|回一张|也可以分享/.test(卡), 'qq_card 没说什么时候用 —— 描述只说「不能做什么」等于没用')
  assert.ok(/你自己刷到|你自己/.test(卡), 'qq_card 没给她「自己也可以分享」的余地')

  const 音 = 描述('qq_audio_understand')
  assert.ok(!/只在用户明确要求分析本机下载目录/.test(音), 'qq_audio_understand 还是「只在用户明确要求」')
  assert.ok(/听不清|别猜/.test(音), 'qq_audio_understand 没告诉她「不确定就调它听一遍」')
  assert.ok(/confirm/.test(音), 'qq_audio_understand 没提 confirm')
})

test('D2 安全阀一个都没少', () => {
  const src = 读(join(LIB, 'tool.js'))
  // 白名单：目标不在服务目标里直接 throw
  assert.ok(/if \(!\(set instanceof Set\) \|\| !set\.has\(id\)\) throw new Error\('分享卡目标不在当前服务白名单内'\)/.test(src),
    'sendShareCard 的白名单校验不见了')
  // 回执：没有 message_id 不算发出去
  assert.ok(/retcode\) !== 0 \|\| !\(Number\(result\?\.data\?\.message_id\) > 0\)/.test(src),
    'sendShareCard 的 message_id 回执校验不见了')
  // confirm 必填
  for (const name of ['qq_card', 'qq_audio_understand']) {
    const i = src.indexOf("name: '" + name + "'")
    const seg = src.slice(i, i + 2600)
    assert.ok(/required: \[[^\]]*'confirm'/.test(seg), name + ' 的 confirm 不再是必填')
  }
})

test('D3 该保留的硬约束一条都不许跟着放松', () => {
  // 这些「只在/只能/不要」是流程或权限约束，不是把她锁在门外，别在下次「放松描述」时误伤：
  //   qq_qzone_post   发说说对外可见且不能删 → 必须他说了才发
  //   qq_pass         说完就结束本轮 → 不许再调别的工具
  //   qq_send         同理，别用 qq_wait 死等
  //   qq_board        只能撕自己贴的（权限）
  //   qq_listen       只在对方没说完时用（防死循环）
  const 该留 = [
    ['qq_qzone_post', /只在他明确说/, '发说说不能删，必须他说了才发'],
    ['qq_pass', /不要再调(用)?/, 'pass 之后本轮就结束了'],
    ['qq_send', /结束本轮|final.*收尾/, '发完就结束，收尾约束'],
    ['qq_board', /只能撕自己贴的/, '权限约束'],
    ['qq_listen', /只在对方(还)?没说完/, '防死循环'],
  ]
  for (const [name, re, why] of 该留) {
    assert.ok(re.test(描述(name)), name + ' 的硬约束被删了（' + why + '）—— 那条是必要的，不该跟着放松')
  }
})
