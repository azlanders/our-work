// 批次601：数值审计 P0 三条
//   1) 激素 → 情绪偏置读当前值 v，不再读设定点 B（B 永远到不了 65）
//   2) 空胃不再被「胃<=10」和「饱腹感<25」双扣
//   3) 整份吃() 与分口吃部分() 还的欠账总量一致（都是 -2）
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 工具 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const 装入 = (p) => import(pathToFileURL(p).href)
const 临时 = () => fs.mkdtempSync(path.join(os.tmpdir(), 't601-'))
// 模块在第一次 import 时就把 env 固化，所以整个文件共用一个沙盒目录
const 测试MEM = 临时()
process.env.BAOKE_MEM = 测试MEM
process.env.ITEM_MEM = 测试MEM
const 写json = (p, o) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(o, null, 2))
}

test('激素偏置：v 高时生效，B 高时不再误触发', async () => {
  const { 算激素心情偏置 } = await 装入(path.join(工具, '_总线.mjs'))
  assert.equal(算激素心情偏置({ v: { dopamine: 70, cortisol: 25 }, B: { dopamine: 45, cortisol: 25 } }).情绪基线, 2)
  assert.equal(算激素心情偏置({ v: { dopamine: 45, cortisol: 70 }, B: { dopamine: 45, cortisol: 25 } }).情绪基线, -3)
  // 回归：设定点被写到 65 以上也不该生效——那不是当前值
  assert.equal(算激素心情偏置({ v: { dopamine: 45, cortisol: 25 }, B: { dopamine: 75, cortisol: 70 } }).情绪基线, 0)
})

test('激素偏置：平铺结构与缺失 v 的兜底', async () => {
  const { 算激素心情偏置 } = await 装入(path.join(工具, '_总线.mjs'))
  assert.equal(算激素心情偏置({ dopamine: 70, cortisol: 25 }).情绪基线, 2)
  assert.equal(算激素心情偏置({ B: { dopamine: 45, cortisol: 70 } }).情绪基线, -3)
  assert.equal(算激素心情偏置({}).情绪基线, 0)
})

test('心情修正：空胃只扣一次，不再叠加胃<=10', async () => {
  const mem = 测试MEM
  const now = Date.now()
  const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  写json(path.join(mem, '饱渴.json'), {
    水: 2000, 水At: 北京(now), 卡: 2000, 卡At: 北京(now),
    胃: 0, 胃At: 北京(now), 血糖: 5.5, 血At: 北京(now), 欠: 0, 欠At: 北京(now),
  })
  const { 心情修正 } = await 装入(path.join(工具, '饱渴.mjs'))
  const r = 心情修正(now)
  // 空腹 + 血糖 5.5：饱腹感=20 → 只扣 -1.0；卡满 → 长期 +0.3
  assert.equal(r.即时, -1.0)
  assert.equal(r.长期, 0.3)
  assert.equal(r.合计, -0.7)
})

test('欠账：400 kcal 整份 -2 与四口各 -0.5 总量一致', async () => {
  const mem = 测试MEM
  // 饱渴的写档时间只到分钟；用整分钟避免把不足一分钟的退账算进断言。
  const now = Math.floor(Date.now() / 60000) * 60000
  const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  写json(path.join(mem, '物品总表.json'), {
    分组: { 测试: { 测试饭: { 类别: '吃', 价: 10, 吃: { kcal: 400, 顶胃: 500, 补水: 100 } } } },
  })
  写json(path.join(mem, '饱渴.json'), {
    水: 2000, 水At: 北京(now), 卡: 2000, 卡At: 北京(now),
    胃: 0, 胃At: 北京(now), 血糖: 5.5, 血At: 北京(now), 欠: 100, 欠At: 北京(now),
  })
  const { 吃, 吃部分, 读 } = await 装入(path.join(工具, '饱渴.mjs'))
  assert.ok(吃('测试饭', now))
  assert.ok(Math.abs(读(now).欠 - 98) <= 0.01)

  写json(path.join(mem, '饱渴.json'), {
    水: 2000, 水At: 北京(now), 卡: 2000, 卡At: 北京(now),
    胃: 0, 胃At: 北京(now), 血糖: 5.5, 血At: 北京(now), 欠: 100, 欠At: 北京(now),
  })
  for (let i = 0; i < 4; i++) assert.ok(吃部分('测试饭', 0.25, now))
  assert.ok(Math.abs(读(now).欠 - 98) <= 0.01)
})
