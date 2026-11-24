// t555 —— 「食物保留在库存」原来只是话术，东西根本没留下（批次554）
//
// 实测 2026-11-15 23:55 她买泡面（5 块）：
//   资产.记录：「买了泡面（5 块）」            ← 钱扣了
//   物品.json  ：从头到尾只有一只水杯          ← 东西没了
//   自主.log   ：「买到了泡面，但没有开始有效进食；食物保留在库存」  ← 假话
//
// 根因：花钱.mjs 把泡面走了「堂食」分支（直接调 吃饭.mjs，不写物品），
// 吃饭没起来 → 钱花了、东西没了。而 `自主行动` 这句 note 是写死的，从来没真入库。
//
// 后果不只是丢一份泡面：她家里的吃喝永远是 0 样，「吃存货」这个动作永远走不到，
// 只能一直点外卖（带配送费）。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'

test('F1 吃不成时必须真补一次入库，不是只写一句话', () => {
  const s = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.match(s, /FOOD_KEEP/, '注释头没了')
  // 必须真的调 物品.mjs --入
  assert.match(s, /'物品\.mjs'\), '--入', String\(want\)/, '没真入库')
  // 两句话术要分开：存住了 / 丢了
  assert.match(s, /先塞进包里存着/, '存住时的说法没了')
  assert.match(s, /也没能存进包（这份算丢了）/, '丢了的说法没了')
  // 老那句假话不许**当话术**用。
  // 注意不能直接 `/食物保留在库存/.test(s)` —— FOOD_KEEP 的注释里就引用了那句话（说明它原来是什么），
  // 那样断言永远红。这个坑跟「断言注释存在不能先 strip 注释」是同一枚硬币的两面：
  //   查「有」要连注释一起看；查「不许有」要把注释排除掉。
  assert.equal(/note = `[^`]*食物保留在库存/.test(s), false, '「食物保留在库存」还在当话术用')
})

test('F2 幂等：已经有同名的就不补（防止花钱那边已经入过）', () => {
  const s = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.match(s, /const __包里 = \(\(\) => \{/, '没查包里有没有')
  assert.match(s, /some\(\(x\) => x && String\(x\.n\) === String\(want\)\)/, '幂等判据不对')
  assert.match(s, /let 留住了 = __包里/, '没把「已有」当成已留住')
})

test('F3 真跑：物品.mjs --入 能把东西放进包，而且同名会累加', () => {
  const b = mkdtempSync(join(tmpdir(), 't555-'))
  writeFileSync(join(b, '物品.json'), JSON.stringify({
    items: [{ n: '水杯', 在: '包', 来: '买', 容器: { 容量: 1000, 成分: [{ 物: '水', 量: 400 }] } }],
  }))
  writeFileSync(join(b, '资产.json'), JSON.stringify({ 钱: 589, 位置: '便利店', 记录: [] }))
  const 入 = (名) => execFileSync(process.execPath, [join(工具, '物品.mjs'), '--入', 名, '--在', '包', '--价', '0'], {
    encoding: 'utf8', timeout: 20000, env: { ...process.env, QQ_AUTONOMY_MEM: b },
  })
  assert.match(入('泡面'), /收进包/)
  const 一 = JSON.parse(readFileSync(join(b, '物品.json'), 'utf8')).items
  assert.equal(一.length, 2, '泡面没进包')
  assert.ok(一.some((x) => x.n === '泡面' && x.在 === '包'), '泡面不在包里：' + JSON.stringify(一))
  // 再来一次同名 → 数 +1，不新增条目
  入('泡面')
  const 二 = JSON.parse(readFileSync(join(b, '物品.json'), 'utf8')).items
  assert.equal(二.length, 2, '同名又新增了一条')
  assert.equal(二.find((x) => x.n === '泡面').数, 2, '同名没有累加')
  rmSync(b, { recursive: true, force: true })
})

test('F4 入库失败要如实说「丢了」，不能再说留下了', () => {
  const s = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  const i = s.indexOf('FOOD_KEEP')
  const 段 = s.slice(i, i + 2600)
  assert.match(段, /catch \{ \/\* 见下面的话术 \*\/ \}/, '没有失败分支')
  assert.match(段, /留住了\s*\n?\s*\?/, '话术没有按成败分流')
})
