// 批次603：血糖从饭后高点回落，落到 5.2 就该停住；不能再线性掉到 3.0 假装低血糖。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const mem = fs.mkdtempSync(path.join(os.tmpdir(), 't603-'))
process.env.BAOKE_MEM = mem
process.env.ITEM_MEM = mem
// ISOLATE 2026-11-17（批次649 顺带）：`倍率()` 读的是 `自主.json`，沙盒里没有这个文件时
// 会退回生产档 —— 线上她正在「走动」倍率 1.4，同一份 8.0 血糖 60 分钟就回落到 6.0 而不是 6.08。
// 这条用例本该只验血糖公式，不该被「她此刻在干嘛」左右。沙盒里补一份静止档。
fs.writeFileSync(path.join(mem, '自主.json'), JSON.stringify({ state: '刷手机', since: Date.now(), nextAt: 0, log: [] }))

const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 写档 = (o) => fs.writeFileSync(path.join(mem, '饱渴.json'), JSON.stringify(o))
const 底 = (血, 分钟前) => ({
  水: 2000, 水At: 北京(Date.now()), 卡: 2000, 卡At: 北京(Date.now()),
  胃: 500, 胃At: 北京(Date.now()), 血糖: 血, 血At: 北京(Date.now() - 分钟前 * 60e3),
  欠: 0, 欠At: 北京(Date.now()),
})

const { 读 } = await import(pathToFileURL(path.join(工具, '饱渴.mjs')).href)

test('饭后 3 小时：血糖停在 5.2，不再掉到 3.0', () => {
  写档(底(8.0, 180))
  assert.equal(读(Date.now()).血糖, 5.2)
})

test('饭后 1 小时：还在正常回落区间', () => {
  写档(底(8.0, 60))
  // 8.0 - 0.032*60 = 6.08
  assert.equal(读(Date.now()).血糖, 6.1)
})

test('低血糖从 3.0 缓慢回升，不跨过 5.2', () => {
  写档(底(3.0, 60))
  // 3.0 + 0.008*60 = 3.48
  assert.equal(读(Date.now()).血糖, 3.5)
  写档(底(3.0, 600))
  // 3.0 + 4.8 = 7.8，但上限是 5.2
  assert.equal(读(Date.now()).血糖, 5.2)
})
