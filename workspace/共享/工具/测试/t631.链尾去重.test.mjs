// t631 —— 链尾先去重再切 3 条：连续重复不能把更早的不同事实挤出窗口。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const LIB = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const POLL = join(LIB, 'poll.js')
const { 链尾去重, 链尾摘要 } = await import(pathToFileURL(POLL).href + '?t631=1')

const 块 = (t, body) => `${t}\n- 判断：${body}\n- 未决：（没有）`
const 鼠 = 块('2026-11-16 11:29', '群里老说「老鼠」，我没看懂那是什么意思')
const 鼠2 = 块('2026-11-16 11:36', '群里老说「老鼠」，我没看懂那是什么意思')
const 鼠3 = 块('2026-11-16 13:20', '群里老说「老鼠」，我没看懂那是什么意思')
const 梦 = 块('2026-11-15 15:28', '想起 2026-11-11 那晚的梦，想在那束光里多坐一会儿。')

test('C1 最近三条连续重复时，更早的不同事实仍能进链尾', () => {
  const out = 链尾摘要(链尾去重([梦, 鼠, 鼠2, 鼠3]).slice(-3))
  assert.match(out, /光里多坐/, '更早的梦被重复条目挤掉了')
  assert.equal((out.match(/老鼠/g) || []).length, 1, '重复的老鼠应只出现一次')
})

test('C2 旧写法（先切 3 条再合并）确实会丢掉更早的梦', () => {
  const out = 链尾摘要([鼠, 鼠2, 鼠3])
  assert.doesNotMatch(out, /光里多坐/, '旧写法本来就不该有梦；这条锁住对照')
  assert.equal((out.match(/老鼠/g) || []).length, 1)
})

test('C3 重复组保留最新时间戳，不保留最老', () => {
  const kept = 链尾去重([梦, 鼠, 鼠2, 鼠3])
  assert.equal(kept.length, 2)
  assert.match(kept[1], /2026-11-16 13:20/)
})

test('C4 没有判断正文的块不被吞掉', () => {
  const 空 = '2026-11-16 14:00\n- 未决：（没有）'
  const kept = 链尾去重([空, 梦])
  assert.equal(kept.length, 2)
  assert.match(kept[0], /14:00/)
})

test('C5 读取路径先取最近 12 条去重，再切 3 条', () => {
  const s = readFileSync(POLL, 'utf8')
  assert.match(s, /链尾去重\(raw\.split\(\/\^## \/m\)[\s\S]{0,260}?slice\(-12\)\)\.slice\(-3\)/)
})
