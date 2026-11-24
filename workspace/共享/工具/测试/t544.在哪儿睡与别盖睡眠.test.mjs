// t544 —— 她在便利店睡 + 睡眠记录被反复重置（批次542/543）
//
// 主人 07:51 问：「为什么他没在家里睡觉」。查下去是两件事：
//
// ① **睡觉有两条入口，只有一条判了家。**
//    `自动作息.mjs` 有（批次107 修的：「一个人不会在便利店床上睡」），
//    但 `自主行动.mjs` 里「困意 >= 95 困到该睡整觉」那条是批次500 后来加的，直接 startSleep()。
//    她 07:12 困意 128，于是就在便利店睡着了。
//
// ② **`作息.mjs --想睡` 会把 sleeping/live 盖回旧值。**
//    它结尾是 `save(sleepP, sleep)` —— 写的是**本进程启动时**读到的整个对象。
//    而 自主行动 的顺序是「先 startSleep() 再喊 --想睡」，这几十毫秒里只要有人动过，
//    那一写就盖回去。实测 live.start 被重置三次（07:12 → 07:15 → 07:43），
//    每段只有 3 分钟 / 27 分钟就重开，睡够 6 小时永远攒不够。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'

test('A1 自主行动 的整觉分支必须判家 —— 跟 自动作息 同源', () => {
  const src = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  // 整觉分支里要有「读资产再判」，而且判到要走就调 走路 --去 家
  assert.ok(src.includes("import { 读资产再判 } from './睡在哪.mjs'"), '没 import 睡在哪')
  assert.ok(src.includes('const __哪2 = __班2'), '整觉分支没有判家')
  assert.ok(src.includes('const __哪2 = __班2'), '判家的变量没了')
  assert.ok(src.includes("join(tools, '走路.mjs'), '--去', '家'"), '判到要走却没走')
  // 走不成也有兜底（不能让她永远不睡）
  assert.ok(src.includes('走不成，先在'), '走不成的兜底被删了')
})

test('A2 自动作息 那条判据不许被删（它是批次107 修的，别回头改坏）', () => {
  const src = readFileSync(join(工具, '自动作息.mjs'), 'utf8')
  assert.ok(src.includes('const __哪 = __班'), '自动作息 的判家没了')
  assert.ok(src.includes('读资产再判(base)'), '自动作息 没问 睡在哪')
})

test('A3 自主行动 要看 startSleep 的返回值 —— 开不成别喊「去睡了」', () => {
  const src = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.ok(src.includes('const __r = __m.startSleep()'), '没接返回值')
  assert.ok(src.includes('__r.ok === false'), '没判 ok')
})

// ── 静态：--想睡 只覆盖 segments（防御，不是根因修复）──
//
// 诚实说明：这一条**反向验证不了**。原来写的是沙盒真跑 作息 --想睡，看 sleeping/live 会不会被盖回；
// 但把代码改回 `save(sleepP, sleep)` 之后测试照样过 —— 因为同步顺序下它读到的本来就是最新值。
// 所以那两条沙盒断言没有区分力，删了。这里只钉「代码形态」，不声称它是根因修复。
test('A4 --想睡 只覆盖 segments，sleeping / live 以文件里为准', () => {
  const src = readFileSync(join(工具, '作息.mjs'), 'utf8')
  assert.ok(src.includes('盘.segments = sleep.segments'), '只覆盖 segments 的写法没了')
  assert.ok(src.includes('const 盘 = load(sleepP, null)'), '没重读一遍')
})

// ── 根因没坐实，留一条可观测的判据 ──
test('A5 startSleep 开不成时要能看出来（A3 是它的门）', () => {
  const src = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.ok(src.includes('想睡没开成（睡眠记录说已经在睡 / live 还在）'), '日志文本没了')
})
