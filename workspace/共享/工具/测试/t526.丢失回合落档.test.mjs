// 批次526：卸载前「还没等到回复的回合」必须能取出来落档
//
// 由来：05:04 我给 dsh-bot 重启，掐断了第 1086 回合（主人 05:01 说的「你不用搞了」她连「好」都没回）。
// 日志里只留一句「卸载：出站队列还有 1 个会话没转发完，已丢弃」——
// 既不知道丢的是谁、也不知道是哪一刻，只能回头解 200MB 会话才还原。
// 现在卸载前落一份 `qq-lost-turns.jsonl`。
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { enqueueOutbound, 取待发快照, clearOutbound } = await import(LIB + '/outbound.js')

test('L1 投一个回合进去，快照必须能看到它（会话、目标、投递时刻）', () => {
  clearOutbound()
  enqueueOutbound('session-A', {}, 100, { kind: 'private', id: '{{OWNER_UIN}}' }, {})
  const 快照 = 取待发快照()
  assert.equal(快照.length, 1, '快照条数不对')
  const e = 快照[0]
  assert.equal(e.sessionId, 'session-A')
  assert.equal(e.kind, 'private')
  assert.equal(e.id, '{{OWNER_UIN}}')
  assert.ok(e.投递于 > 0, '没有投递时刻')
  assert.equal(e.主动, false)
})

test('L2 主动搭话投进去的回合要标出来（这类回合丢了她不会怪没人说话）', () => {
  clearOutbound()
  enqueueOutbound('session-B', {}, 200, { kind: 'group', id: '1051483012' }, { proactive: true })
  const 快照 = 取待发快照()
  assert.equal(快照.length, 1)
  assert.equal(快照[0].主动, true)
  assert.equal(快照[0].kind, 'group')
})

test('L3 多个会话都要出现（不能只报第一个）', () => {
  clearOutbound()
  enqueueOutbound('session-A', {}, 1, { kind: 'private', id: '1' }, {})
  enqueueOutbound('session-B', {}, 2, { kind: 'group', id: '2' }, {})
  enqueueOutbound('session-B', {}, 3, { kind: 'group', id: '2' }, {})
  const 快照 = 取待发快照()
  assert.equal(快照.length, 3, '同一会话两条队列也要各算一条：' + JSON.stringify(快照))
  assert.deepEqual([...new Set(快照.map((x) => x.sessionId))].sort(), ['session-A', 'session-B'])
})

test('L4 清空之后快照必须是空的（否则重启会误报丢失）', () => {
  clearOutbound()
  enqueueOutbound('session-A', {}, 1, { kind: 'private', id: '1' }, {})
  assert.equal(取待发快照().length, 1)
  clearOutbound()
  assert.deepEqual(取待发快照(), [])
})

test('L5 队列里是脏数据也不许抛（卸载路径不能因为落档失败卡住）', () => {
  clearOutbound()
  // 造一条没有 target 的
  enqueueOutbound('session-C', {}, 9, undefined, {})
  const 快照 = 取待发快照()
  assert.equal(快照.length, 1)
  assert.equal(快照[0].kind, '')
  assert.equal(快照[0].id, '')
})

test('L6 index.js 必须真的在卸载里调它（不然导出也没用）', async () => {
  const { readFileSync } = await import('node:fs')
  const 源 = readFileSync(LIB + '/index.js', 'utf8')
  const i = 源.indexOf('const 快照 = 取待发快照()')
  assert.ok(i > 0, '卸载分支没调 取待发快照')
  assert.ok(源.slice(i, i + 500).includes('qq-lost-turns.jsonl'), '没落档到 qq-lost-turns.jsonl')
  // 顺序：落档必须在 clearOutbound 之前（清完就取不到东西了）
  const 清 = 源.indexOf('const dropped = clearOutbound()')
  assert.ok(清 > i, '落档跑到清空后面去了')
})
