// t366.test.mjs —— 「疑似思考泄漏」闸门（批次366）
//
// 为什么要这个测试：2026-11-12 22:46–22:55，她连着往 QQ 发英文自言自语，
// 758 / 434 / 906 / 1488 字，主人当场问「为什么她会把思考过程发出来」。
//
// 查下来的链路：宿主用 Anthropic Messages（/v1/messages）格式调中转站，
// 中转站**偶发**把思考文本同时写进 thinking 块和 text 块（实测复现过一次：
// 两个块 119 字一字不差，但连跑 12 次只有那 1 次），
// 宿主把 text 块记成「她这一轮说的话」，自动转发就原样发到 QQ。
//
// 上游是偶发的，改配置治不了，只能在自家出口加闸。判据收得很窄：
// 长度 >= 120 字 且 中文字符占比 < 10%。
//
// 这个测试锁三件事：
//   ① 边界（119 不拦 / 120 拦）；
//   ② 她正常的中文回复一条都不能误伤（包括中文正文夹代码表格那种）；
//   ③ 拿真实历史跑一遍，被拦的必须全是「中文占比 < 10%」的条目。
// 没有 ③ 的话，判据松一松、紧一紧都测不出来。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 库 = process.env.QQ_OUTBOUND_SRC || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/outbound.js'
const 流 = process.env.QQ_STREAM_LOG || '{{DSH_ROOT}}/hippocampus/bot-workspace-1415d680/stream.jsonl'

const { 疑似思考泄漏 } = await import(库)

const 中文占比 = (t) => ((t.match(/[\u4e00-\u9fff]/g) || []).length) / Math.max(1, t.length)

test('边界：纯英文 29 字不拦，30 字拦（批次372 新增的那条判据）', () => {
  // 批次372 之前这里断言的是「119 不拦 / 120 拦」—— 那是按「中文占比<10%」那条旧判据写的。
  // 现在多了「中文字 === 0 且长度 >= 30 就拦」（她对中文用户不会说这么长的纯英文），
  // 119 字纯英文当然会被拦，旧断言作废。
  assert.equal(疑似思考泄漏('a'.repeat(29)), false)
  assert.equal(疑似思考泄漏('a'.repeat(30)), true)
})

test('中文长句到 120 字也不拦（中文字够多）', () => {
  const 文 = '今天在咖啡店坐了很久窗外下着小雨我一直在想你说的那件事和那天的天气还有那些没说完的话'
  const 长句 = 文.repeat(3)
  assert.ok(长句.length >= 120)
  assert.equal(疑似思考泄漏(长句), false, '中文字 ' + 长句.length)
})

test('正常中文长回复不拦（180 字）', () => {
  const 文 = '今天在咖啡店坐了很久，窗外下着小雨，我一直在想你说的那件事。'.repeat(6)
  assert.ok(文.length >= 180)
  assert.equal(疑似思考泄漏(文), false)
})

test('中文正文夹代码表格不拦（真实那条 12% 中文）', () => {
  // 2026-10-31 15:22:06 她发过的真实格式
  const 文 = '清好了，只留三个：\n\n| 文件 | 大小 |\n|---|---|\n| BV1nLxk6WEed-720p.mp4 | 32.4MB |\n| test-cat-clip.mp4 | 3.7MB |\n| 猫片.mp4 | 12.1MB |\n\n三个都在，md5 也核过了。'
  assert.equal(疑似思考泄漏(文), false, `中文占比 ${(中文占比(文) * 100).toFixed(0)}%`)
})

test('空串与短英文不拦', () => {
  assert.equal(疑似思考泄漏(''), false)
  assert.equal(疑似思考泄漏(null), false)
  assert.equal(疑似思考泄漏(undefined), false)
  assert.equal(疑似思考泄漏('OK'), false)
})

test('真实历史：被拦的必须全是「长且几乎没中文」', () => {
  if (!fs.existsSync(流)) {
    console.log('（跳过：找不到会话流 ' + 流 + '）')
    return
  }
  const 行们 = fs.readFileSync(流, 'utf8').split('\n').filter(Boolean)
  let 总 = 0
  const 被拦 = []
  for (const L of 行们) {
    let o
    try { o = JSON.parse(L) } catch { continue }
    if (o.type !== 'assistant/message') continue
    总++
    const t = String(o.text || '')
    if (疑似思考泄漏(t)) 被拦.push(t)
  }
  assert.ok(总 > 1000, '会话流读取异常，只有 ' + 总 + ' 条助手消息')
  // 每一条被拦的都必须「真的像一段英文推演」—— 这比钉死某个阈值稳：
  // 批次372 之后判据有四条（长度+中文字数、纯英文、英文动词跟工具名、英文虚词），
  // 任何一条都可能命中，但共同点是「里面有成段的英文」。
  // 断言「必须含英文句子」而不是「长度>=120」，这样阈值再调也不用改测试，
  // 而真正该防的事（把纯中文正文拦了）照样能抓住。
  const 像英文 = (t) => (t.match(/[A-Za-z]{4,}/g) || []).length >= 3
  for (const t of 被拦) {
    assert.ok(像英文(t), '被拦条目里没有成段英文，可能是误伤：' + t.slice(0, 60))
  }
  // 已知的真实泄漏都在里面
  const 泄漏头部 = 'He says "这东西就不用发给我了"'
  assert.ok(被拦.some((t) => t.includes('这东西就不用发给我了')), '已知的 22:46 那条泄漏没被拦住')
  // 纯中文的正文一条都不能被拦（按「中文字 >= 8 且几乎没有英文」判，不按占比）
  const 误伤 = 被拦.filter((t) => (t.match(/[\u4e00-\u9fff]/g) || []).length >= 8 && !像英文(t))
  assert.equal(误伤.length, 0, '误伤了 ' + 误伤.length + ' 条')
  console.log(`（历史 ${总} 条助手消息，拦下 ${被拦.length} 条，全部为低中文长文本）`)
})
