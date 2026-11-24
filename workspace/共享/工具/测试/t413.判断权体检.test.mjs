// t413 —— 判断权体检：从「写了没人跑」变成每周真的跑（批次408）
//
// 病根：
//   1) 体检-判断权.mjs 221 行，2026-11-10 写的，注释里明写「加新功能前后各跑一次」，
//      可全仓 0 引用、心跳表没有、crontab 没有 —— 靠人记得，就等于不会跑。
//      它防的是「系统替她下判断」这一类错，而这批（406 别扭、407 撤回）恰好都在动
//      「谁来判断」这条线，越是这样越该有个哨兵。
//   2) 就算手动跑，它每次都报同样 6 处「中文正则带情绪词」+ 1 条「好感度入口不止一个」——
//      报三次以上人就不看了。哨兵一旦变成背景噪音，比没有更糟（会让你以为查过了）。
//
// 这个文件锁：
//   C1 干净仓库上：硬性违规 0、要人看的 0（有噪音就说明白名单又漏了）
//   C2 三处已知的「系统代判」还在被查（不是空跑）
//   C3 行内块注释 `/* ... */` 不再被当成正则字面量（好感度-日结 那处误报）
//   C4 好感度入口：登记过的标出来，只报没登记的
//   C5 --strict 的退出码约定还在（硬性违规才 1）
//   C6 心跳表里有它，且调度只落在周一 05:40（相邻时刻不命中）
//   C7 跑得够快（心跳是每分钟串行跑几十条，单个任务不能占太久）
//
// 跑法：node --test t413.判断权体检.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const CLI = join(TOOLS, '体检-判断权.mjs')
const 读 = (p) => readFileSync(p, 'utf8')

function 体检() {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CLI, '--strict'], { encoding: 'utf8', timeout: 30000, cwd: TOOLS }) }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}

test('C1 干净仓库上：硬性违规 0、要人看的 0', () => {
  const r = 体检()
  assert.equal(r.code, 0, '--strict 退出码非 0，说明有硬性违规：\n' + r.out.slice(-800))
  assert.ok(/硬性违规 0 条/.test(r.out), '硬性违规不是 0：\n' + r.out.slice(-800))
  assert.ok(/没有需要人看的新地方/.test(r.out), '又冒出新噪音了（白名单漏了）——哨兵会因此失效：\n' + r.out.slice(-1200))
  assert.ok(/\d+ 处已逐条看过/.test(r.out), '「已认」那行不见了，白名单可能被清空')
})

test('C2 三处已知的「系统代判」还在被查', () => {
  const 源 = 读(CLI)
  assert.ok(/poll\.js 又在 spawn 认事\.mjs/.test(源), '第一条检查被删了')
  assert.ok(/贴表情\.mjs 又出现 feedHormone/.test(源), '第二条检查被删了')
  assert.ok(/还在调 奖惩\.mjs --识别/.test(源), '第三条检查被删了')
  // 光有文案不够 —— 跑出来的输出里也得有这三条的结论
  const r = 体检()
  assert.ok(/poll\.js 不再 spawn 认事\.mjs/.test(r.out), '第一条没真的跑')
  assert.ok(/贴表情\.mjs 不再自动喂激素/.test(r.out), '第二条没真的跑')
  assert.ok(/没有任何文件再调 奖惩\.mjs --识别/.test(r.out), '第三条没真的跑')
})

test('C3 行内块注释不再被当成正则（好感度-日结 L169 那处误报）', () => {
  const 源 = 读(CLI)
  // 剥注释再判，而不是靠白名单盖 —— 白名单盖住就再也看不见同类新问题
  assert.ok(/const 去注释 = line\.replace\(/.test(源), '没剥行内块注释')
  assert.ok(/正则行\.test\(去注释\)/.test(源), '剥了注释却还在用原行判正则')
  const r = 体检()
  assert.ok(!/好感度-日结\.mjs（\d+ 处）/.test(r.out),
    '好感度-日结 又被报了 —— 那行只是在读 感受.jsonl，`/* 坏行跳过 */` 被当成了正则')
})

test('C4 好感度入口：登记过的标出来，只报没登记的', () => {
  const r = 体检()
  assert.ok(/感受\.mjs（她自己 qq_feel 记下的感受，判断权在她）/.test(r.out), '感受.mjs 没登记')
  assert.ok(/好感度-日结\.mjs（按群日志/.test(r.out), '好感度-日结.mjs 没登记')
  // 结构：必须有「未知入口」这一层。只靠文案断言的话，文案没跟着退回就抓不到（反测时中过一次）。
  const 源 = 读(CLI)
  assert.ok(/const 未知好感入口 = favWriters\.filter/.test(源),
    '「未知入口」这层没了 —— 又退回「入口 > 1 就报」')
  // 行为：不管文案怎么写，只要它进了「要人看的」列表就是退化了。
  // 注意别用 split('要人看的') —— `需要人看的新地方` 里就含这四个字，会切到第四段去。
  const m = r.out.match(/要人看的\s+\d+\s+条：([\s\S]*)$/)
  const 提醒块 = m ? m[1] : ''
  assert.ok(!/好感度/.test(提醒块), '好感度入口又进了「要人看的」列表：' + 提醒块.slice(0, 200))
  assert.ok(!/改好感度的入口不止一个/.test(r.out), '还在用「>1 就报」的老逻辑 —— 这条每次都报，等于没有')
  // 只看第四段：第一段里那句「没有任何文件再调 奖惩.mjs --识别」是应该出现的
  const 第四段 = r.out.split('── 四、')[1] || ''
  assert.ok(第四段.length > 0, '没有第四段')
  assert.ok(!/奖惩\.mjs/.test(第四段), '已停用的 奖惩.mjs 又被算成入口了')
})

test('C5 --strict 的退出码约定还在', () => {
  const 源 = 读(CLI)
  assert.ok(/process\.exit\(strict && 硬性\.length > 0 \? 1 : 0\)/.test(源),
    '--strict 的退出码丢了 —— 心跳里就看不到「失败」这两个字了')
})

test('C6 心跳表里有它，且只落在周一 05:40', () => {
  const 表 = JSON.parse(读(join(TOOLS, '心跳表.json')))
  const arr = 表.任务
  const 它 = arr.find((j) => j.名 === '判断权体检')
  assert.ok(它, '心跳表里没有 判断权体检')
  assert.equal(它.脚本, '体检-判断权.mjs')
  assert.deepEqual(它.参数, ['--strict'])
  assert.equal(它.每周, 1)
  assert.equal(它.时, 5)
  assert.equal(它.分, 40)
  assert.equal(它.睡着跑, true)
  // 跟闭环体检（05:10）错开，别同一分钟两个体检抢 IO
  const 闭环 = arr.find((j) => j.名 === '闭环体检')
  assert.ok(闭环, '闭环体检不见了')
  assert.notEqual(它.时 * 60 + 它.分, 闭环.时 * 60 + 闭环.分, '跟闭环体检撞在同一分钟')

  // 真的问一次调度：命中那分钟、不命中相邻分钟、不命中别的日子。
  // 按「[命中] 判断权体检」这一整行数 —— 单纯 match 名字会把同一行里的 `→ 判断权体检.log` 也算进去。
  const dry = (t) => execFileSync(process.execPath, [join(TOOLS, '心跳.mjs'), '--dry', '--at', t], { encoding: 'utf8', cwd: TOOLS, timeout: 30000 })
  const 数 = (t) => dry(t).split('\n').filter((l) => /\[命中\]\s*判断权体检/.test(l)).length
  assert.equal(数('2026-11-16 05:40'), 1, '周一 05:40 没命中')
  assert.equal(数('2026-11-16 05:41'), 0, '05:41 也命中了 —— 退化成每分钟一跑')
  assert.equal(数('2026-11-17 05:40'), 0, '周二也命中了 —— 每周: 1 没生效')
  assert.equal(数('2026-11-16 05:10'), 0, '跟闭环体检那分钟撞了')
})

test('C7 跑得够快', () => {
  const t0 = Date.now()
  体检()
  const ms = Date.now() - t0
  assert.ok(ms < 5000, '跑一次要 ' + ms + 'ms —— 心跳是每分钟串行跑几十条的，不能占这么久')
})
