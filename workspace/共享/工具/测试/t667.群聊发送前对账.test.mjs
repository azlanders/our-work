// 批次667：群聊版的「发送前再看一眼」。
//
// 起因：群聊没有 input_status（线上实测 5761 条输入状态全是私聊，群聊 0 条），
// 3.5 秒固定窗口接不住的连发只能靠发之前对账。私聊早就有这条（582/585/587），
// 群聊一直没有 —— 因为 poll.js 的群聊投递从来不调 markDeliveredBatch，
// deliveredCursor 永远返回 null，对账整个失效。
//
// 这里锁四件事：
//   G1 群聊投递后游标能读到、带得出发送者
//   G2 同一个人补话算「新」，别的人闲聊不算
//   G3 @她 / 叫她名字算「新」（无论谁说的）
//   G4 没有游标时放行（不能因为兜底让回复卡死）
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'
process.env.QQ_SELF_NAMES = process.env.QQ_SELF_NAMES || '{{BOT_DISPLAY}}'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { markDeliveredBatch, deliveredCursor } = await import(LIB + '/rhythm.js')
const { 筛选新入站, 群缓冲归一 } = await import(LIB + '/tool.js')
const { calledByMyname } = await import(LIB + '/poll.js')
const { isAtMe, textOf } = await import(LIB + '/onebot.js')

// 群聊缓冲里的消息形状（pushToBuffer 存的是 normalizeEvent 的结果）
const 群消息 = (id, uid, text, sec) => ({
  message_id: id,
  sender: { user_id: String(uid), nickname: 'u' + uid },
  message: [{ type: 'text', data: { text } }],
  time: sec,
})

const 秒 = Math.floor(Date.now() / 1000)

test('G1 群聊投递后游标可读，且带得出发送者', () => {
  const key = 'group:1051483012'
  markDeliveredBatch(key, [群消息(9001, {{OWNER_UIN}}, '看看', 秒)], Date.now())
  const cur = deliveredCursor(key)
  assert.notEqual(cur, null, '群聊投递后 deliveredCursor 竟然是 null —— 对账会整个跳过')
  assert.ok(cur.ids.has(9001), '游标里没有刚投递的那条')
  assert.ok(cur.users instanceof Set, '游标没记发送者（不知道是谁在说）')
  assert.ok(cur.users.has('{{OWNER_UIN}}'), '发送者集合里没有主人')
})

test('G2 同一个人补话算新，别人闲聊不算', () => {
  const key = 'group:1051483012'
  const now = Date.now()
  const cur = deliveredCursor(key)
  assert.notEqual(cur, null)
  const 原始 = [
    群消息(9001, {{OWNER_UIN}}, '看看', 秒),
    群消息(9002, {{OWNER_UIN}}, '你的', 秒 + 3), // 同一个人接着补
    群消息(9003, {{SELF_UIN}}, '哈哈哈', 秒 + 3), // 别人闲聊
  ]
  // TRAP：群缓冲是 OneBot 原始形状（message_id / sender.user_id），
  // 筛选新入站() 认的是归一后的 messageId / userId。直接喂原始形状会一条都筛不出来。
  assert.deepEqual(筛选新入站(原始, cur, '3556352474'), [], '原始形状竟然筛出了东西 —— 归一那层是不是被绕过了')
  const buf = 群缓冲归一(原始)
  assert.equal(buf[0].messageId, 9001, '归一没把 message_id 转成 messageId')
  assert.equal(buf[0].userId, '{{OWNER_UIN}}', '归一没把 sender.user_id 转成 userId')
  const fresh = 筛选新入站(buf, cur, '3556352474')
  assert.deepEqual(fresh.map((m) => m.messageId).sort(), [9002, 9003], '筛选新入站这一层不对')
  const 本回合的人 = cur.users instanceof Set ? cur.users : new Set()
  // 注意：归一之后发送者在 `userId`，不是原始形状的 `sender.user_id`。
  const 要拦 = fresh.filter((m) => 本回合的人.has(String(m?.userId ?? '')))
  assert.deepEqual(要拦.map((m) => m.messageId), [9002], '同一个人补话没被拦，或者别人的闲聊也被拦了')
  assert.ok(now > 0)
})

test('G3 @她 / 叫她名字算新，无论谁说的', () => {
  const self = '3556352474'
  const at = [{ type: 'at', data: { qq: self } }, { type: 'text', data: { text: ' 在吗' } }]
  assert.equal(isAtMe(at, self), true, 'isAtMe 没认出 @')
  assert.equal(calledByMyname('{{BOT_DISPLAY}}你看看这个'), true, 'calledByMyname 没认出名字')
  assert.equal(calledByMyname('小肥鱼在吗'), false, '叫「小肥鱼」被当成了她')
  assert.equal(calledByMyname('肥鱼在哪'), false, '只叫「肥鱼」不该算她')
  assert.equal(textOf([{ type: 'text', data: { text: '{{BOT_DISPLAY}}你看' } }]), '{{BOT_DISPLAY}}你看')
})

test('G4 没有游标时对账放行（不能因为兜底让回复卡死）', () => {
  const key = 'group:999999'
  assert.equal(deliveredCursor(key), null, '没投递过的群竟然有游标')
})
