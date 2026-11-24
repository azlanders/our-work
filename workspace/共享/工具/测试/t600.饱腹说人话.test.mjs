// t600 —— 给她的状态提示必须说「当下饿不饿」，不能把千卡百分比叫「饱」
//
// 现场：饱渴.json 里卡 1468（73%）、胃 0、血糖 4.2，
// 饱腹感 = 胃60% + 血糖40% ≈ 10（很饿）；而旧提示写「肚子 73/100（有点空）」。
// 她照着提示说「不饿」，同一轮心情却在按饿扣 —— 自己跟自己打架。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const 沙 = mkdtempSync(join(tmpdir(), 't600-'))
const 记忆 = join(沙, '记忆')
mkdirSync(记忆, { recursive: true })
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const now = Date.now()
const 写 = (n, o) => writeFileSync(join(记忆, n), JSON.stringify(o), 'utf8')

写('饱渴.json', {
  水: 1239, 水At: bj(now), 卡: 1468, 卡At: bj(now),
  胃: 0, 胃At: bj(now), 血糖: 4.2, 血At: bj(now),
  欠: 13, 欠At: bj(now), 账: [],
})
写('饥饿.json', { 今天: { 日期: bj(now).slice(0, 10), 顿: 1, 钱: 0, 零食: 0 }, 饱腹: 73 })
写('状态.json', { energy: 67, layers: { physical: 61, emotional: 51, cognitive: 75, existential: 57 } })
写('资产.json', { 位置: '家' })
写('自主.json', { state: '看B站', since: now - 30 * 60e3 })

process.env.QUIET_NOTE = '1'
process.env.QQ_MEM = 记忆
process.env.HUNGER_MEM = 记忆
process.env.BAOKE_MEM = 记忆
process.env.GAP_MEM = 记忆
process.env.QQ_ACT_MEM = 记忆
process.env.QQ_AUTONOMY_MEM = 记忆
process.env.ITEM_MEM = 记忆

const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { stateFastHintOf, stateHintOf } = await import(插件 + '/poll.js')

test('F1 快速提示里的「饱」是饱腹感（约10），不是千卡73', () => {
  const 出 = String(stateFastHintOf() || '')
  assert.match(出, /饱(9|10|11)\b/, `实际：${出}`)
  assert.doesNotMatch(出, /饱73\b/, `实际：${出}`)
})

test('F2 完整提示把「肚子」「胃里」「热量」分开说', () => {
  const 出 = String(stateHintOf({}) || '')
  assert.match(出, /肚子 (9|10|11)\/100/, `实际：${出.slice(0, 400)}`)
  assert.match(出, /热量 73%/, `实际：${出.slice(0, 400)}`)
  assert.doesNotMatch(出, /肚子 73\/100/, `实际：${出.slice(0, 400)}`)
})

test.after(() => {
  try { rmSync(沙, { recursive: true, force: true }) } catch {}
})
