// t571 —— 四层说真话 + cognitive 只留「此刻清醒度」（批次571）
//
// 主人的三条决定（2026-11-16）：
//   ① existential 单独出门：做「心气」，**不进精力**
//   ② cognitive 只留「此刻清醒度」，「学到多少」搬走
//   ③ 这一批先修「说真话」+ 拆 cognitive；existential 的独立出口另开一批
//
// 为什么必须修（都是实测出来的）：
//   · 面板写着「精力是木桶：四层里最低的那层卡住它」「当前瓶颈＝四层最低」，
//     而 `恢复目标.精力()` 只取 p^0.6 × c^0.4 × 情绪乘子 —— **existential 根本不参与**。
//     面板在说谎，看板的人会误判她的状态。
//   · `cognitive 86.6` 超过了设计目标 82 —— 因为 `学完涨认知` 往同一个字段里加 1.5（封 95）。
//     于是「此刻脑子清不清醒」和「学到多少」挤在一个数里：
//     她读完一篇 B 站，outbound 的 `cog<35` 判据会以为她更清醒，睡一觉又「学的东西被睡没了」。
//
// 这一批不动的东西（刻意的）：
//   · `精力()` 公式一个字不改（三层木桶是现状，改它要把 30/35/62/65 全部重标定）
//   · `learn` 不再涨 cognitive，但**不新造 knowledge 字段** —— 没有出口的字段就是第二个 existential
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))
const bj16 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

// t453：文件里出现插件路径就要闭嘴（也免得测试往真档灌日志）
process.env.QUIET_NOTE = '1'

const 总 = await import(工具 + '/_总线.mjs')
const 恢复 = await import(工具 + '/恢复目标.mjs')

// ══════════ 沙盒 ══════════
function 造盒() {
  const d = mkdtempSync(join(tmpdir(), 't571-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  const now = Date.now()
  const 层 = { physical: 55, emotional: 52, cognitive: 80, existential: 50 }
  // A3 的比较对象是「学习前后 energy 一样」。如果这里手写一个跟 layers 对不上的数，
  // `后.energy = 精力(layers)` 一重算就会「变」—— 红的是我的假数据，不是功能（第一版就是这么假红的）。
  writeFileSync(join(d, '状态.json'), JSON.stringify({
    energy: 恢复.精力(层), 困意: 20, hoursAwake: 0, 测试标记: 't571',
    layers: 层,
    mood: { intensity: 0, label: '还行' },
    更新时间: bj16(now - 15 * 60e3),
  }, null, 2))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({ sleeping: false, records: [], 欠: 0 }))
  return d
}

// ══════════ A 学完不再涨 cognitive ══════════
test('A1 读进去一篇 → cognitive 一点不动（它现在只表示「此刻脑子清不清」）', () => {
  const d = 造盒()
  try {
    const 前 = 读(join(d, '状态.json')).layers.cognitive
    const 收 = 总.学完记一笔(d)
    assert.equal(读(join(d, '状态.json')).layers.cognitive, 前, 'cognitive 被学习推高了：' + 前 + ' → ' + 收.cognitive)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A2 但「心气」涨 0.4 —— 学到东西确实让人踏实一点', () => {
  const d = 造盒()
  try {
    const 前 = 读(join(d, '状态.json')).layers.existential
    const 收 = 总.学完记一笔(d)
    assert.ok(Math.abs(收.existential - (前 + 0.4)) < 0.011, 'existential ' + 前 + ' → ' + 收.existential)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A3 精力不变 —— 读一篇文章不改变「此刻能不能动」', () => {
  const d = 造盒()
  try {
    const 前 = 读(join(d, '状态.json')).energy
    const 收 = 总.学完记一笔(d)
    assert.equal(收.energy, 前, '学习把精力改了：' + 前 + ' → ' + 收.energy)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('A4 心气有痕迹（日志里能找到这一笔，不是黑箱）', () => {
  const d = 造盒()
  try {
    总.学完记一笔(d)
    const p = join(d, '日志', '存在层.log')
    assert.ok(existsSync(p), '没写 存在层.log —— 改了什么完全查不到')
    assert.match(readFileSync(p, 'utf8'), /\+0\.4/)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════ B cognitive 的上限就是 82 ══════════
test('B1 认知 90（历史遗留的高值）睡一觉明显回落，睡满一天落到 82', () => {
  // 实测：0.26/h 走 8 小时只补掉 91% 的差距 —— 90 → 82.72。
  // **82 是「收敛目标」不是硬顶**，别把「接近」写成「到了」（t568 栽过一次）。
  const 八 = 恢复.睡着后({ physical: 55, cognitive: 90, emotional: 52 }, 8)
  assert.ok(八.cognitive < 84, '睡 8 小时几乎没降：' + 八.cognitive)
  const 一天 = 恢复.睡着后({ physical: 55, cognitive: 90, emotional: 52 }, 24)
  assert.ok(一天.cognitive <= 恢复.认知目标 + 0.01, '睡满一天还在 ' + 一天.cognitive)
})

test('B2 没有任何「涨 cognitive」的写点（静态扫，只认会加号的那种）', () => {
  const 源 = readFileSync(join(工具, '_总线.mjs'), 'utf8')
  // 只盯 `layers.cognitive =` 这一种写法；`-` 和 收敛 都是对的
  const 行 = 源.split('\n').filter((l) => /layers\.cognitive\s*=/.test(l))
  const 加 = 行.filter((l) => /\+\s*(Number|增|加|1\.5)/.test(l))
  assert.equal(加.length, 0, '还有地方在涨 cognitive：\n' + 加.join('\n'))
})

// ══════════ C 面板说真话 ══════════
test('C1 面板的「当前瓶颈」只算三层（existential 不进精力，不许算进去）', () => {
  const 源 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  // T5 2026-11-16（批次571，我自己栽的）：原来写 `/Math\.min\(([^)]*)\)/`，
  // `层值('physical')` 里的 `)` 就让捕获组提前收尾 —— 于是「漏了 emotional」这种假红。
  // 只取那一整行，再看里面有没有那四个词。
  const 行 = 源.split('\n').find((l) => /const 最薄\s*=\s*Math\.min/.test(l))
  assert.ok(行, '找不到 最薄 那行 —— 面板改了写法，这条断言要跟着改')
  assert.ok(!/existential/.test(行), '「最薄」把 existential 算进去了，而 精力() 根本不读它：' + 行)
  for (const k of ['physical', 'emotional', 'cognitive']) {
    assert.ok(行.includes(k), '「最薄」漏了 ' + k + '：' + 行)
  }
})

test('C2 面板不再声称「四层木桶」', () => {
  const 源 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  // T5 2026-11-16（批次571，我自己栽的第二次）：先写 `/四层里最低/` 禁止它出现，
  // 结果那段**注释**里为了解释「原来写着什么」把它写回去了 —— 断言红在自己身上。
  // 现在只取 `g('core'` 那一行的文案，注释怎么写都不影响。
  const 行 = 源.split('\n').find((l) => l.includes("g('core', '核心状态'"))
  assert.ok(行, '找不到核心状态那一段')
  assert.ok(!/四层/.test(行), '面板还在说四层：' + 行)
  assert.match(行, /三层/, '面板没有一句说清精力是三层算的：' + 行)
})

test('C3 面板的「循环」死行删掉（st.loop 全仓没有写方，永远显示 —）', () => {
  const 源 = readFileSync(join(工具, '面板.mjs'), 'utf8')
  assert.ok(!/it\('循环'/.test(源), '面板还在显示 st.loop —— 这个字段从来没被写过')
})

// ══════════ D 注入说真话 ══════════
test('D1 poll.js 不再把「存在」裸数字塞进她的上下文', () => {
  const p = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
  const 源 = readFileSync(p, 'utf8')
  const 行 = 源.split('\n').find((l) => l.includes('分层 生理'))
  assert.ok(行, '找不到那行注入 —— 写法变了，断言要跟着改')
  assert.ok(!/存在/.test(行), '注入里还有「存在」裸数字：' + 行)
})

test('D2 三层数字还在（她需要知道自己体力/情绪/认知）', () => {
  const p = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
  const 源 = readFileSync(p, 'utf8')
  const 行 = 源.split('\n').find((l) => l.includes('分层 生理')) || ''
  for (const k of ['生理', '情绪', '认知']) assert.ok(行.includes(k), '注入里丢了 ' + k + '：' + 行)
})

test('D3 poll.js 也删掉 `if (j?.loop)`（同一个死字段）', () => {
  const p = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
  const 源 = readFileSync(p, 'utf8')
  // 同一条坑：注释里会提到这个名字，所以只认「行首的 if」
  assert.ok(!/^\s*if \(j\?\.loop\)/m.test(源), 'poll.js 还在读 j.loop —— 全仓没有写方')
})

// ══════════ E 真档防线 + 反向自检 ══════════
test('E1 跑了四轮沙盒，真档 状态.json 里没有 测试标记（沙盒变量没漏）', () => {
  const p = join(真档, '状态.json')
  const 前 = readFileSync(p, 'utf8')
  assert.ok(!前.includes('测试标记'), '真档本来就有测试标记 —— 之前漏过')
  const d = 造盒()
  try {
    总.学完记一笔(d)
    总.学完记一笔(d)
  } finally { rmSync(d, { recursive: true, force: true }) }
  assert.equal(readFileSync(p, 'utf8'), 前, '真档被写了')
})

test('E2 反向自检：沙盒里确实有那一笔（找不到 = 我测的是空气）', () => {
  const d = 造盒()
  try {
    const 前 = 读(join(d, '状态.json')).layers.existential
    总.学完记一笔(d)
    const 后 = 读(join(d, '状态.json')).layers.existential
    assert.ok(后 > 前, '沙盒里的 existential 没涨：' + 前 + ' → ' + 后)
  } finally { rmSync(d, { recursive: true, force: true }) }
})
