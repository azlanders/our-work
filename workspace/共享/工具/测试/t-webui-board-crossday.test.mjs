// 2026-11-20：她可以跨天回以前的便签，也可以补贴以前的板子；只有未来不行。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 盒 = mkdtempSync(join(tmpdir(), 'fish-board-crossday-'))
process.env.BOARD_DIR = 盒
process.env.BOARD_READ = join(盒, 'read.json')
process.env.QQ_LOCK_DIR = join(盒, 'locks')
const 板 = await import('../留言板.mjs')

const 今 = 板.今天()
const 今t = Date.parse(今 + 'T00:00:00+08:00')
const 北京日 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 10)
const 昨 = 北京日(今t - 24 * 3600e3)
const 明 = 北京日(今t + 24 * 3600e3)

test('过去的板子可以补贴，未来不行', () => {
  const r = 板.贴({ date: 昨, by: '主人', color: 'pink', text: '昨天忘了说' })
  assert.equal(r.ok, true, r.msg)
  assert.equal(r.note.text, '昨天忘了说')
  assert.equal(existsSync(join(盒, 昨 + '.json')), true, '应该写到昨天那块板')
  assert.equal(板.读(昨).notes.length, 1)

  const 未 = 板.贴({ date: 明, text: '明天的话' })
  assert.equal(未.ok, false)
  assert.match(未.msg, /未来|还没到/)
  assert.equal(existsSync(join(盒, 明 + '.json')), false, '未来的板子一张都不许建')
})

test('只给 note_id 也能回前几天的便签，且写回那一天', () => {
  const n = 板.读(昨).notes[0]
  const r = 板.评论({ date: 今, id: n.id, by: '{{BOT_DISPLAY}}', text: '补一句' })
  assert.equal(r.ok, true, r.msg)
  assert.equal(r.date, 昨, '应该落在便签原来那天')
  assert.equal(r.comment.text, '补一句')
  const 签 = 板.读(昨).notes[0]
  assert.equal(签.comments.length, 1)
  assert.equal(板.读(今).notes.length, 0, '不能把评论写到今天的板上')
})

test('撕旧便签同样跨天定位，仍然只许撕自己的', () => {
  const 她 = 板.贴({ date: 昨, by: '{{BOT_DISPLAY}}', color: 'blue', text: '她自己的', x: 40, y: 40 })
  assert.equal(她.ok, true, 她.msg)
  assert.equal(板.撕({ date: 今, id: 她.note.id, 只限: '{{BOT_DISPLAY}}' }).ok, true)
  assert.equal(板.读(昨).notes.some((z) => z.id === 她.note.id), false)

  const 他的 = 板.贴({ date: 昨, by: '主人', color: 'yellow', text: '主人的', x: 60, y: 60 })
  const 拒 = 板.撕({ date: 今, id: 他的.note.id, 只限: '{{BOT_DISPLAY}}' })
  assert.equal(拒.ok, false)
  assert.match(拒.msg, /不是你贴的/)
})

test('找不到的便签仍然要拒，不能顺手新建一张空板', () => {
  const r = 板.评论({ date: 今, id: 'n-不存在', text: '喂' })
  assert.equal(r.ok, false)
  assert.match(r.msg, /不在了/)
  assert.equal(existsSync(join(盒, 今 + '.json')), false)
})

test('未读带 id 和日期，才知道该回哪张旧便签', () => {
  writeFileSync(join(盒, 'read.json'), JSON.stringify({ at: '2020-01-01 00:00' }))
  const 新 = 板.未读(20)
  assert.ok(新.length > 0)
  assert.ok(新.every((x) => x.id && x.date), '每条都要带 id 和日期')
  assert.ok(新.some((x) => x.type === 'note' && x.date === 昨))
})
