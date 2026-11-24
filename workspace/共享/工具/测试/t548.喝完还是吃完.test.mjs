// t548 —— 喝咖啡被说成「咖啡这份吃完了」（批次548）
//
// 主人 08:15 问的：「喝咖啡怎么变成吃咖啡了」。
//
// 根因：`物品.mjs` 吃完那一行的 `吃` 是**物品名**（`--吃 咖啡` 的参数），不是动作，
// 而动词写死成「吃」—— 于是对什么都写「<名字>这份吃完了」。
// 咖啡在物品总表里 `类别: "喝"`，物品对象也带 `类`（`--入` 会写）。
// 现在按类别选：喝 → 喝完，其余 → 吃完。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'

function 造盒(物品) {
  const b = mkdtempSync(join(tmpdir(), 't548-'))
  writeFileSync(join(b, '物品.json'), JSON.stringify({ items: 物品 }))
  writeFileSync(join(b, '资产.json'), JSON.stringify({ 钱: 621, 位置: '咖啡店', 记录: [] }))
  writeFileSync(join(b, '饱渴.json'), JSON.stringify({ 饱腹: 40, 卡: 500, 胃: 30, 水: 500, 账: [] }))
  return b
}
const 跑 = (b, ...args) => {
  try {
    return execFileSync(process.execPath, [join(工具, '物品.mjs'), ...args], {
      encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_AUTONOMY_MEM: b },
    })
  } catch (e) { return String(e.stdout || '') + String(e.stderr || '') }
}

test('V1 咖啡（类=喝）→ 说「喝完了」，不说「吃完了」', () => {
  const b = 造盒([{ n: '咖啡', 在: '包', 来: '买', 数: 1, 类: '喝', 价: 22 }])
  const out = 跑(b, '--吃', '咖啡')
  assert.match(out, /咖啡这份喝完了/, '还是说成吃完了：' + out.slice(0, 120))
  assert.equal(/咖啡这份吃完了/.test(out), false, '「吃完了」还在')
  rmSync(b, { recursive: true, force: true })
})

test('V2 糖（类=零食）→ 仍然是「吃完了」', () => {
  const b = 造盒([{ n: '糖', 在: '包', 来: '买', 数: 1, 类: '零食', 价: 2 }])
  const out = 跑(b, '--吃', '糖')
  assert.match(out, /糖这份吃完了/, '零食被说成喝完了：' + out.slice(0, 120))
  rmSync(b, { recursive: true, force: true })
})

test('V3 没有「类」的老物品 → 回落「吃完了」（不许因为缺字段就乱说喝）', () => {
  const b = 造盒([{ n: '台灯', 在: '包', 来: '买', 数: 1, 价: 40 }])
  const out = 跑(b, '--吃', '台灯')
  assert.equal(/喝完了/.test(out), false, '没有类却说了喝完了：' + out.slice(0, 120))
  rmSync(b, { recursive: true, force: true })
})

test('V4 源码：动词是按类别算的，不是写死', () => {
  const src = readFileSync(join(工具, '物品.mjs'), 'utf8')
  assert.ok(src.includes("const 动词 = String((条 && 条.类) || '') === '喝' ? '喝' : '吃'"), '动词判据被删了')
  assert.ok(src.includes('${吃}这份${动词}完了'), '输出还在用写死的「吃完了」')
})
