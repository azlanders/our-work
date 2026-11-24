// t542 —— 困意过线必须能顶掉 nextAt（批次540）
//
// 事故：2026-11-16 06:27 她「喝完水」，自己安排了 132 分钟（要站到 08:39）。
// 07:08 时 physical 已经掉到 12.6、清醒 24 小时。可 `自主行动` 第 284 行是：
//
//   if (waitMin > 0 && !__急渴 && !__急饿 && !__班次强制动作) process.exit(0)
//
// **只有口渴 / 饿 / 班次能顶掉 nextAt，困意不行** —— 于是她明明困得撑不住，
// 还得站在原地等 89 分钟。加 `__急困` 之后：07:12 那一轮真的去睡了
// （日志：现在去「打瞌睡」：困得撑不住了，去睡（不是眯一会儿））。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'

function 造盒(困意) {
  const b = mkdtempSync(join(tmpdir(), 't542-'))
  const now = Date.now()
  const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  writeFileSync(join(b, '状态.json'), JSON.stringify({
    energy: 26, 困意, hoursAwake: 24, 更新时间: bj(now - 15 * 60e3),
    layers: { physical: 12.6, cognitive: 75, emotional: 51, existential: 52 },
    mood: { intensity: 0.26 }, body: { 困: 33 },
  }))
  writeFileSync(join(b, '自主.json'), JSON.stringify({
    state: '喝点水', since: now - 3600e3, doneAt: now - 3600e3,
    nextAt: now + 89 * 60e3, log: [], place: '便利店', form: '线下',
  }))
  writeFileSync(join(b, '资产.json'), JSON.stringify({ 钱: 621, 位置: '便利店', 记录: [] }))
  writeFileSync(join(b, '活动台账.json'), JSON.stringify({ today: [], log: [] }))
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj(now - 24 * 3600e3) }))
  return b
}
const 跑 = (b) => {
  try {
    return execFileSync(process.execPath, [join(工具, '自主行动.mjs'), '--tick'], {
      encoding: 'utf8', timeout: 90000, // NAP_MEM 也要指过去：自主行动 spawn 的 打盹.mjs 读 NAP_MEM（默认真档）
  env: { ...process.env, QQ_AUTONOMY_MEM: b, NAP_MEM: b, QUIET_NOTE: '' , QQ_NO_MICROSLEEP: '1' },
    })
  } catch (e) { return String(e.stdout || '') + String(e.stderr || '') }
}
// T5 2026-11-16（批次569 修）：**别拿全文当指纹。**
// 她白天也在睡，而 睡眠.json 每分钟被 睡眠心跳 改一次（live.lastTick）——
// 这条防线于是「她睡着时 10 次红 3 次」，报的还是「沙盒写脏了真档」这种假警报。
// 只比这一觉的**骨架**：睡没睡 / 段起点 / records 与 segments 条数 / 睡醒 since。
// 这些只有真的结算（醒来 / 开睡）才会变，正是这条用例想守的东西。
const 指纹 = (f) => {
  try {
    const j = JSON.parse(readFileSync(join(真档, f), 'utf8'))
    return [j.sleeping, j.live && j.live.start, (j.records || []).length, (j.segments || []).length, j.since || ''].join('|')
  } catch { return 'NONE' }
}

test('N1 困意 114 + nextAt 还有 89 分钟 → 必须去睡，不许干等', () => {
  const b = 造盒(114)
  // NAP_SLIDE 2026-11-16（批次569 修）：先记下原来那个 nextAt —— 「被打断」= 它被改写。
  const 原nextAt = Number(JSON.parse(readFileSync(join(b, '自主.json'), 'utf8')).nextAt)
  const out = 跑(b)
  // QUADRANT（批次563）之后不再清池 —— 困意过线只是「票多」，抽中什么随机。
  // 这个用例的真实意图是「__急困 让她不再干等 89 分钟」，不是「必定抽中打瞌睡」。
  // 原来断言 `state === '打瞌睡'`，实测抽到「发呆」就红 —— 红的是随机，不是功能。
  assert.match(out, /打瞌睡票|现在去「/, '困意 114 却还在干等（没进入抽签）：' + out.slice(0, 200))
  const a = JSON.parse(readFileSync(join(b, '自主.json'), 'utf8'))
  assert.ok(Number(a.nextAt) > Date.now(), 'nextAt 没被重新安排')
  // 批次569：**别钉「新安排一定短于 89 分钟」**。`ranges` 表里发呆是 35~120 分钟，
  // 抽中 120 就红 —— 红的是随机，不是功能（8 次里红过 2 次，t542 自己第 39 行也记过同类翻车）。
  // 这条用例真正要的是「原来那 89 分钟被顶掉」，所以钉「nextAt 被改写」。
  assert.ok(Math.abs(Number(a.nextAt) - 原nextAt) > 1000, 'nextAt 还是原来那一个（' + 原nextAt + '）—— 等于没打断，state=' + a.state)
  rmSync(b, { recursive: true, force: true })
})

test('N2 困意只有 40（没过 78 门槛）→ 照样干等，不许乱动', () => {
  const b = 造盒(40)
  const out = 跑(b)
  assert.equal(/打瞌睡/.test(out), false, '困意 40 也去睡了 —— 门槛被拿掉了')
  const a = JSON.parse(readFileSync(join(b, '自主.json'), 'utf8'))
  // 断言「没去打瞌睡」，不是「抽到了喝点水」—— 批次563 之后抽签是随机的，
  // 喝点水只有 4 票，原来那条在全套里稳定红（单跑碰巧抽中就绿）。红的也是随机，不是功能。
  assert.notEqual(a.state, '打瞌睡', '困意 40 却去睡了：' + a.state)
  rmSync(b, { recursive: true, force: true })
})

test('N3 源码：急困必须出现在 exit 条件里，门槛跟选动作那条是同一个数', () => {
  const src = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.match(src, /const __急困 = !!\(sleepy && sleepy >= H\('自主_打瞌睡困意门槛', 78\)\)/)
  assert.match(src, /!__班次强制动作 && !__急困\) process\.exit\(0\)/, 'exit 条件里没有 __急困')
})

test('N4 跑了两轮沙盒，真档的 睡醒/睡眠 一个字不许动', () => {
  const 前 = ['睡醒.json', '睡眠.json'].map(指纹)
  const b = 造盒(114)
  跑(b)
  rmSync(b, { recursive: true, force: true })
  const 后 = ['睡醒.json', '睡眠.json'].map(指纹)
  assert.deepEqual(后, 前, '沙盒跑 自主行动 写脏了真档的睡眠数据')
})
