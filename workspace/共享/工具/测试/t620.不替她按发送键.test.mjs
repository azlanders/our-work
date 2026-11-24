// 批次620：拟人化红线 P0 —— 没调 qq_send / 回合超时，都不再由代码自动发正文。
// 只读 outbound.js 源码，不起服务、不写任何档。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// QUIET_NOTE：本文件只读源码，不 import 插件 lib；但静态检查按路径字符串认人，照规矩关日志。
process.env.QUIET_NOTE = '1'

const 源 = readFileSync(
  process.env.QQ_OUTBOUND_SRC || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/outbound.js',
  'utf8'
)

test('A1 没调 qq_send 的回合只进死信，不自动转发', () => {
  assert.ok(源.includes('本回合没有调用 qq_send，按拟人化红线不自动转发'),
    '缺少「无 qq_send」守卫标记')
  const 守 = 源.indexOf('本回合没有调用 qq_send，按拟人化红线不自动转发')
  const 发 = 源.indexOf('await sendToQQ(entry.target, text)')
  assert.ok(守 >= 0 && 发 > 守, '守卫必须在正常发送之前')
})

test('A2 回合超时不再自动补发，正文进死信', () => {
  assert.ok(源.includes('回合超时，未自动补发'),
    '缺少超时转死信标记')
  assert.ok(!源.includes('await sendToQQ(entry.target, salvaged)'),
    '仍在自动补发超时正文')
})

test('A3 正常回复的发送路径还在（没有把出口整个删掉）', () => {
  assert.ok(源.includes('await sendToQQ(entry.target, text)'),
    '正常发送路径不见了')
  assert.ok(源.includes('已转发回复'), '发送成功日志不见了')
})

// SEND_FAIL 2026-11-17（批次649）：qq_send 调用失败原来会掉进「自动转发」分支，
// 把这一轮 assistant 的**完整正文**发出去 —— 不是她 qq_send 里挑的那段。
// 这条锁死：失败也只进死信，不再有「改自动转发」这条路径。
test('A4 qq_send 失败不再自动转发正文，只进死信', () => {
  assert.ok(!源.includes('改自动转发'), '还在走「qq_send 失败 → 自动转发」')
  assert.ok(源.includes('qq_send 调用失败，按拟人化红线不自动转发'), '缺少失败转死信的标记')
  const 失败守 = 源.indexOf('qq_send 调用失败，按拟人化红线不自动转发')
  const 发 = 源.indexOf('await sendToQQ(entry.target, text)')
  assert.ok(失败守 >= 0 && 发 > 失败守, '失败守卫必须在正常发送之前')
})

test('A5 失败分支和「没调用 qq_send」分支走同一套死信出口', () => {
  const 段 = 源.slice(源.indexOf('const sendCalls = events.filter('), 源.indexOf('if (text === \'\')'))
  assert.match(段, /outboundDeadLetters\.push/, '失败分支没进内存死信')
  assert.match(段, /记录死信\(/, '失败分支没写死信文件')
  assert.match(段, /continue/, '失败分支没有跳过自动转发')
})
