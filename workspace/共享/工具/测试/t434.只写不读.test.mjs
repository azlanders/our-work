import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// 批次434：三个「产出了但没人看」的地方。
//   ① 自我巡检 每周写一份 巡检-<日期>.md，而全仓没有一行读它（体检-闭环 早挂了待办，这个没有）
//   ② 喝水.json 是「渴」退休后留下的写入端 —— 状态推进 `delete b['渴']` 之后再没人读
//   ③ 早间简报-*.md 每天一份、没人读，而 目录卫生 的归档正则只认 手账/梦/巡检 → 永久堆积
const T = '{{BOT_ROOT}}/共享/工具'

test('Z1 自我巡检 把「告警+注意」挂进待办，通过的不挂', () => {
  const s = readFileSync(join(T, '自我巡检.mjs'), 'utf8')
  assert.match(s, /import \* as 待办 from '\.\/待办\.mjs'/, '没 import 待办')
  assert.match(s, /待办\.同步\(\{/, '没调 待办.同步')
  assert.match(s, /id: '自我巡检'/, 'id 不对 —— 面板上会跟别的条目混')
  assert.match(s, /该在: 该管\.length > 0/, '没按「有没有问题」决定挂/销')
  // 只挂两条，不能把「通过」也塞进去（每周一条「一切正常」就是噪音）
  assert.match(s, /const 该管 = \[\.\.\.result\.告警, \.\.\.result\.注意\]/, '把「通过」也挂上去了')
})

test('Z2 待办写不进去要留痕（空 catch 会让它静默三天）', () => {
  const s = readFileSync(join(T, '自我巡检.mjs'), 'utf8')
  assert.match(s, /\[待办未写入\]/, '没有留痕，写不进去就彻底没声了')
  assert.doesNotMatch(s, /catch\s*\{\s*\/\*\s*忽略\s*\*\/\s*\}/, '又出现空 catch')
})

test('Z3 物品.mjs 不再写 喝水.json（渴 2026-11-07 就退休了）', () => {
  const s = readFileSync(join(T, '物品.mjs'), 'utf8')
  // 注释里提到文件名是允许的，但不许再有写入那一行
  assert.doesNotMatch(s, /writeFileSync\([^)]*喝水\.json/, '又在写喝水.json 了')
  assert.match(s, /RETIRE_THIRST/, '没留下「为什么删」的注释，下次又会被人加回来')
  assert.equal(existsSync('{{BOT_ROOT}}/记忆/喝水.json'), false, '文件还在（应该已经删了）')
})

test('Z4 目录卫生 的归档正则认得 早间简报', () => {
  const s = readFileSync(join(T, '目录卫生.mjs'), 'utf8')
  // 解析 JS 正则字面量太脆（要穿好几层转义），钉候选词那一段更稳
  // 只钉候选词那一段。源码原文是 /^(手账|梦|巡检|早间简报)-(\d{4}-\d{2}-\d{2})\.md$/ ——
  // 前面把日期段也写进断言，结果被那个左括号挡住，连错两次。断言别猜整条字面量。
  assert.match(s, /\(手账\|梦\|巡检\|早间简报\)/, '归档正则没带 早间简报')
  // 再用一条等价正则跑真文件名，确认这串候选词真的好使（不只是写了个字面量）
  const 正则 = /^(手账|梦|巡检|早间简报)-\d{4}-\d{2}-\d{2}\.md$/
  for (const f of ['早间简报-2026-11-12.md', '手账-2026-11-12.md', '巡检-2026-11-12.md']) {
    assert.ok(正则.test(f), f + ' 反而认不出来')
  }
  for (const f of ['早间简报-坏名字.md', '早间简报-x-2026-11-12.md', '早间简报-2026-11-12.md.bak']) {
    assert.equal(正则.test(f), false, f + ' 不该匹配')
  }
})

test('Z5 自我巡检 --print 还能跑通（改完没把脚本改坏）', () => {
  const out = execFileSync(process.execPath, [join(T, '自我巡检.mjs'), '--print'], {
    encoding: 'utf8', timeout: 90000, cwd: T,
  })
  assert.match(out, /## 告警（\d+）/, '报告结构变了')
  assert.match(out, /## 注意（\d+）/, '报告结构变了')
  assert.match(out, /## 通过（\d+）/, '报告结构变了')
  // --print 是调试模式，不该写待办、也不该写报告文件
  assert.doesNotMatch(out, /\[待办未写入\]/, '--print 模式下不该碰待办')
})
