// t421 —— 注入给她的那段文字，不许泄漏 QQ 号、不许把昨天说成今天（批次417）
//
// 为什么要有：把 systemPrompt.context() 的三段（stateHintOf / voiceHintOf / extraSlotsHint）
// 拼出来逐字审了一遍，2643 字里有两处会让她说错话：
//
//   ① 「其中「被想起」有 4 次是343941」—— `nicknameOf` 查不到就 `slice(0,6)` 兜底，
//      于是主人的 QQ 号前六位被念给她听。她不知道这是谁（等于没信息），
//      在群里说出来还是泄漏。
//   ② 「最近一笔 13:59 买了小蛋糕」—— 那是**昨天**的 13:59，而 slice(11) 把日期切掉了。
//      这段的用意本来就是「钱是什么时候变的」（MONEY_WHEN），丢了日期她会说成刚刚。
//
// 跑法：node --test t421.注入干净.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 主人 = '{{OWNER_UIN}}'

const { feelHint } = await import(join(LIB, '感受.mjs'))
const { stateHintOf, voiceHintOf, 钱时刻 } = await import(join(LIB, 'poll.js'))
const { extraSlotsHint } = await import(join(LIB, 'voiceSlots.js'))

/** 8 位以上连续数字 —— QQ 号、群号都是这个形状。日期 2026-11-14 有短横，不会被误伤。 */
const 裸号 = /\d{8,}/

test('I1 查不到名字时，不许把 QQ 号片段念给她', () => {
  const s = feelHint(() => '', 主人)
  assert.ok(s.length > 0, '这段没输出，测不到东西')
  const m = s.match(裸号)
  assert.equal(m, null, '注入里出现了裸号：' + (m ? m[0] : ''))
  assert.ok(!s.includes(主人.slice(0, 6)), '出现了 QQ 号前六位 ' + 主人.slice(0, 6))
})

test('I2 查不到名字时，兜底要是人话（一个人 / 同一个人）', () => {
  const s = feelHint(() => '', 主人)
  assert.match(s, /一个人/, '兜底不是人话：' + s.slice(0, 200))
})

test('I3 查得到名字时用名字（兜底不能盖掉真名）', () => {
  const s = feelHint((u) => (String(u) === 主人 ? '主人' : ''), 主人)
  assert.match(s, /主人/, '有名字却没用：' + s.slice(0, 200))
  assert.equal(s.match(裸号), null, '有名字时还是泄漏了号')
})

test('I4 名字函数抛错也不许崩、不许漏号', () => {
  const s = feelHint(() => { throw new Error('模拟接口炸了') }, 主人)
  assert.equal(s.match(裸号), null, '名字函数抛错后漏出了号')
})

test('I5 私聊主人的完整注入里，一个 8 位数字都没有', () => {
  // 三段拼起来才是她真正看到的东西。单测某一小段会漏掉别的段落里的号。
  const t = { peer: 主人, isPrivate: true }
  const 段 = [
    stateHintOf({ text: '', history: [], peerUin: t.peer, isPrivate: true }),
    voiceHintOf(t.peer, { isPrivate: true }),
    extraSlotsHint({ peer: t.peer, ownerUin: 主人, isPrivate: true, mute: false, lastText: '', memDir: '{{BOT_ROOT}}/记忆' }),
  ].map((x) => String(x || ''))
  const 全 = 段.join('\n')
  assert.ok(全.length > 500, '注入太短，可能有一段落空了')
  const m = 全.match(裸号)
  assert.equal(m, null, '整段注入里有裸号：' + (m ? m[0] : '') + '（在哪一段：'
    + 段.map((s, i) => (裸号.test(s) ? ['状态', '说话', '体感'][i] : '')).filter(Boolean).join('、') + '）')
})

test('I6 最近一笔：跨天必须带日期，当天只写时刻', () => {
  // 注意：`poll.js` 里全是硬编码 `{{BOT_ROOT}}/记忆/...`，**没有沙盒变量** ——
  // 所以 stateHintOf 只能读真实数据，第一版想用沙盒造两个场景是白费。
  // 改成「拿真实数据算出期望，再跟真实输出对账」：不管数据怎么变判据都成立。
  const 真 = JSON.parse(readFileSync('{{BOT_ROOT}}/记忆/资产.json', 'utf8'))
  const 记录 = Array.isArray(真.记录) ? 真.记录 : []
  // 跟实现同一个过滤口径（它改了这里就得跟着改 —— 这正是想被提醒的）
  const 候选 = 记录.filter((r) => /(给了|赚了|花了|买了|拿走|[0-9]\s*(块|元))/.test(String((r && r.what) || '')))
  if (候选.length === 0) return // 账上还没动过钱，这条测不到

  const 末 = 候选[候选.length - 1]
  const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  const 是今天 = String(末.at || '').slice(0, 10) === 今天

  const 输出 = String(stateHintOf({ text: '', history: [], peerUin: 主人, isPrivate: true }) || '')
  const 行 = (输出.match(/最近一笔 ([^，\n]+)/) || [])[1] || ''
  assert.ok(行.length > 0, '注入里没有「最近一笔」那段：' + 输出.slice(0, 300))

  const 带日期 = /\d{4}-\d{2}-\d{2}/.test(行)
  if (是今天) {
    assert.equal(带日期, false, '当天的记录不该带日期（太啰嗦）：「' + 行 + '」')
    assert.ok(行.includes(String(末.at).slice(11, 16)), '当天这条的时刻没出现（选错记录了？）：「' + 行 + '」')
  } else {
    assert.ok(带日期, '跨天的记录必须带日期，否则她会说成刚刚：「' + 行 + '」（记录是 ' + 末.at + '）')
  }
})

test('I7 最近一笔 认得出「外卖 / 跑腿 / 快递」这类记录（它们也是钱）', () => {
  // 原来动词表只有 给了/赚了/花了/买了/拿走 —— 而 花钱.mjs 写的是
  // 「外卖：早饭（10 块，含配送费 2）」，一个都不含。实测注入里「最近一笔」
  // 长期停在一条更老的记录上（当天 06:09 那笔外卖它看不见）。
  const 真 = JSON.parse(readFileSync('{{BOT_ROOT}}/记忆/资产.json', 'utf8'))
  const 记录 = Array.isArray(真.记录) ? 真.记录 : []
  const 有外卖 = 记录.filter((r) => /^(外卖|跑腿|快递)[:：]/.test(String((r && r.what) || '')))
  if (有外卖.length === 0) return // 她没有点过外卖，测不到
  const 输出 = String(stateHintOf({ text: '', history: [], peerUin: 主人, isPrivate: true }) || '')
  const 行 = (输出.match(/最近一笔 ([^，\n]+)/) || [])[1] || ''
  // 最后一条外卖比「最近一笔」还新 → 说明它没被认出来
  const 末外 = 有外卖[有外卖.length - 1]
  const 末候 = 记录.filter((r) => /(给了|赚了|花了|买了|拿走|[0-9]\s*(块|元))/.test(String((r && r.what) || ''))).pop()
  if (末候 && String(末外.at) > String(末候.at)) {
    assert.fail('最新的一笔外卖／跑腿（' + 末外.at + '）比「最近一笔」还新，说明它没被认出来：「' + 行 + '」')
  }
})

test('I8 钱时刻：当天只写时分，跨天必须带日期', () => {
  // 真实数据不一定两天都有，所以这条分支单独测函数 —— I6 那种「拿真实数据对账」
  // 在数据全在当天的时候会漏掉跨天那条（反测时就是这么漏的）。
  const now = Date.parse('2026-11-14T06:30:00+08:00')
  assert.equal(钱时刻('2026-11-14 05:12', now), '05:12', '当天该只写时分')
  assert.equal(钱时刻('2026-11-13 13:59', now), '2026-11-13 13:59', '跨天必须带日期')
  assert.equal(钱时刻('2026-10-30 23:00', now), '2026-10-30 23:00', '半个月前的也要带日期')
  assert.equal(钱时刻('', now), '', '空值不该崩')
  assert.equal(钱时刻(undefined, now), '', 'undefined 不该崩')
})
