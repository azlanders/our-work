// t678 —— 批次678：打盹和吃饭不能同时成立，未做完的不能写成「已做完」
//
// 线上案例 2026-11-17 19:47：
//   19:47 打盹（state=打瞌睡、doneAt=20:32、note=眯 45 分钟，20:32 醒）
//   同一分钟外卖到了走 物品.mjs → 吃饭.mjs --开始，把 state 改成「吃饭」、doneAt 改成 20:12，
//   note 还挂着打盹那句 —— 三条互相矛盾。她跟主人讲「睡了一下，八点半才迷迷糊糊醒，
//   醒来肚子空得能听见响，点了顿饱饭」，可当时才 19:50，那顿 25 分钟的饭刚坐下。
//
// 这一批把两件事分开：
//   · 数据层：人在打盹（doneAt 还没到）就不许 --开始，食物留在库存里，醒了再吃；
//   · 注入层：doneAt 还在未来时只写「正在做，预计 HH:MM 结束（还没做完）」，
//     不许写「刚做完 / 已做完」。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 工具 = join(dirname(fileURLToPath(import.meta.url)), '..')
// QQ_LIB_DIR：线上 plugin-lib 不在工具目录旁边（{{DSH_ROOT}}/profiles/web/.../lib），
// 沿用 t676 的写法，线上跑测试时显式指过去。
const 线上lib = (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/profiles/web/node_modules/dsh-onebot-channel/lib'
const 插件 = process.env.QQ_LIB_DIR || (existsSync(join(工具, '..', 'plugin-lib')) ? join(工具, '..', 'plugin-lib') : 线上lib)

function 造(自主) {
  const 根 = mkdtempSync(join(tmpdir(), 't678-'))
  const mem = join(根, '记忆')
  mkdirSync(mem, { recursive: true })
  writeFileSync(join(mem, '资产.json'), JSON.stringify({ 钱: 500, 位置: '家', 记录: [] }), 'utf8')
  writeFileSync(join(mem, '自主.json'), JSON.stringify(自主), 'utf8')
  return { 根, mem }
}

function 环境(mem) {
  const e = {
    ...process.env,
    QQ_WORKSPACE: join(mem, '..'),
    HUNGER_MEM: mem, QQ_ACT_MEM: mem, QQ_AUTONOMY_MEM: mem,
    QQ_LOCK_DIR: join(mem, '.locks'),
  }
  delete e.NODE_OPTIONS
  return e
}

const 跑开始 = (mem) => execFileSync(process.execPath, [
  join(工具, '吃饭.mjs'), '--开始', '--吃', '一顿正经饭', '--在哪', '家',
  '--分钟', '25', '--加', '40', '--类别', '吃',
], { encoding: 'utf8', timeout: 20000, env: 环境(mem) })

test('D1 正在打盹时开饭被拒，吃饭档不落盘，状态不变', () => {
  const now = Date.now()
  const 沙 = 造({
    state: '打瞌睡', since: now, doneAt: now + 45 * 60e3, nextAt: now + 45 * 60e3,
    note: '眯 45 分钟，20:32 醒', last: { at: '2026-11-17 19:47', what: '打瞌睡', note: '眯 45 分钟' },
  })
  try {
    const out = 跑开始(沙.mem)
    assert.match(out, /还在打盹/)
    assert.equal(existsSync(join(沙.mem, '吃饭.json')), false, '被拒时不该写 吃饭.json')
    const 自 = JSON.parse(readFileSync(join(沙.mem, '自主.json'), 'utf8'))
    assert.equal(自.state, '打瞌睡', 'state 不能被改写成吃饭')
    assert.ok(Number(自.doneAt) > Date.now(), 'doneAt 仍是打盹的到点')
    assert.match(String(自.note), /眯 45 分钟/)
  } finally { rmSync(沙.根, { recursive: true, force: true }) }
})

test('D2 打盹已到点（doneAt 过去）就允许开饭', () => {
  const now = Date.now()
  const 沙 = 造({
    state: '打瞌睡', since: now - 50 * 60e3, doneAt: now - 5 * 60e3, nextAt: now - 5 * 60e3,
    note: '眯 45 分钟', last: { at: '2026-11-17 19:02', what: '打瞌睡', note: '眯 45 分钟' },
  })
  try {
    const out = 跑开始(沙.mem)
    assert.doesNotMatch(out, /还在打盹/)
    assert.equal(existsSync(join(沙.mem, '吃饭.json')), true, '到点后应该能坐下吃')
    const 自 = JSON.parse(readFileSync(join(沙.mem, '自主.json'), 'utf8'))
    assert.equal(自.state, '吃饭')
  } finally { rmSync(沙.根, { recursive: true, force: true }) }
})

test('D3 醒着时正常开饭，doneAt 写在未来', () => {
  const now = Date.now()
  const 沙 = 造({
    state: '待命', since: now - 10 * 60e3, doneAt: 0, nextAt: now,
    note: '', last: { at: '2026-11-17 19:40', what: '发呆', note: '' },
  })
  try {
    跑开始(沙.mem)
    const 饭 = JSON.parse(readFileSync(join(沙.mem, '吃饭.json'), 'utf8'))
    assert.equal(饭.吃啥, '一顿正经饭')
    const 自 = JSON.parse(readFileSync(join(沙.mem, '自主.json'), 'utf8'))
    assert.equal(自.state, '吃饭')
    assert.ok(Number(自.doneAt) > Date.now() + 20 * 60e3, 'doneAt 是这顿吃完的时刻')
  } finally { rmSync(沙.根, { recursive: true, force: true }) }
})

test('D4 poll.js 注入层：未来的 doneAt 不许写成「已做完」', () => {
  const 源 = readFileSync(join(插件, 'poll.js'), 'utf8')
  assert.match(源, /FUTURE_NOT_DONE/, '缺少批次678 的注入守卫')
  assert.match(源, /const __doing = __doneAt > Date\.now\(\) \+ 60e3/)
  assert.match(源, /__lastFresh && !一次性\.has\(aut\.state\) && !__doing/, '「刚做完」必须排除正在做的')
  assert.match(源, /还没做完/, '正在做时要明确说还没做完')
})
