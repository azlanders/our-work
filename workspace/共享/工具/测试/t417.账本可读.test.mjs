// t417 —— 账本可读性：她的钱账能不能被算出来（批次413）
//
// 为什么要有：`账本.mjs` 是纯正则解析器，她记的账是一句句中文话。
// 谁哪天改了写记录的措辞（工资从「打工赚了 20」→「上班：…（475 分钟，130 块）」），
// 账本没跟上，那笔钱就在日报/快照/面板里**静默变成 0**，而没有任何东西会报警。
// 11-03 那天她挣了 1137，快照记 0、日报写「赚了 0 块」—— 就是这么来的。
//
// 这个文件锁两件事：
//   ① 体检-基础 的第五块能看见「钱写进记录了、账本算不出来」
//   ② 账本认「元」（钱是中文写的，元/块是同一个意思，只认一种就是丢账）
//
// 跑法：node --test t417.账本可读.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const CLI = join(TOOLS, '体检-基础.mjs')
const 沙 = mkdtempSync(join(tmpdir(), 'ledger417-'))
const 档 = join(沙, '待办.json')
const MEM = join(沙, '记忆')

function 准备(记录) {
  rmSync(沙, { recursive: true, force: true })
  mkdirSync(MEM, { recursive: true })
  writeFileSync(join(MEM, '状态.json'), JSON.stringify({ energy: 50 }))
  writeFileSync(join(MEM, 'a.jsonl'), '{"x":1}\n')
  if (记录 !== undefined) {
    writeFileSync(join(MEM, '资产.json'), JSON.stringify({ 钱: 100, 位置: '家', 记录 }))
  }
}
function 跑(extra = {}, args = []) {
  try {
    const out = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', timeout: 30000, cwd: TOOLS,
      env: { ...process.env, BASE_MEM: MEM, TODO_FILE: 档, SKIP_SYSTEMD: '1', ...extra },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}
function 待办() {
  try { return JSON.parse(readFileSync(档, 'utf8')) } catch { return { items: [], done: [] } }
}

test('L1 没有资产.json 也不崩（一、那节按坏档报，这里不重复吵）', () => {
  准备(undefined)
  const r = 跑()
  assert.ok(/五、账本/.test(r.out), '第五块没打印：\n' + r.out.slice(-700))
  assert.ok(/0 条记录/.test(r.out), '没资产时应说 0 条：\n' + r.out.slice(-700))
})

test('L2 非钱记录（走路/换衣服）不算问题', () => {
  准备([
    { at: '2026-11-13 11:50', what: '从家走到咖啡店' },
    { at: '2026-11-13 12:00', what: '换上 水手服' },
    { at: '2026-11-13 12:30', what: '逛街：看见猫在晒太阳，站了一会儿' },
  ])
  const r = 跑()
  assert.ok(/每一笔的钱都算得出来/.test(r.out), '走路被当成丢账了：\n' + r.out.slice(-700))
  assert.equal(待办().items.length, 0, '干净数据却写了待办：' + JSON.stringify(待办().items.map((x) => x.id)))
})

test('L3 账本认得出的写法（块 / 元 / 括号 / 工资 / 退回）一个都不报', () => {
  准备([
    { at: '2026-11-13 09:21', what: '外卖：早饭（10 块，含配送费 2）' },
    { at: '2026-11-13 10:00', what: '花了 12 元' },
    { at: '2026-11-13 11:00', what: '买了 台灯（-40）' },
    { at: '2026-11-12 06:00', what: '上班：便利店夜班（475 分钟，130 块，扣了 20）' },
    { at: '2026-11-12 08:00', what: '打工赚了 20' },
    { at: '2026-11-09 01:22', what: '补：连点 3 单烧烤没吃到，退回 141 块' },
  ])
  const r = 跑()
  assert.ok(/每一笔的钱都算得出来/.test(r.out), '有写法没认出来：\n' + r.out.slice(-800))
})

test('L4 繁体「塊」在括号里账本也能算（不因为见到繁体就报警）', () => {
  // 这条锁的是判据的「准」：不是「含繁体就报」，而是「真的算不出钱才报」。
  // 买了西瓜（15 塊）走的是 ⑥ 的括号分支，跟「块」字无关，能算出 15。
  准备([{ at: '2026-11-13 12:00', what: '买了西瓜（15 塊）' }])
  const r = 跑()
  assert.ok(/每一笔的钱都算得出来/.test(r.out), '括号写法被误报了：\n' + r.out.slice(-700))
})

test('L5 记录里出现 undefined 要报（写记录时变量没取到，这条账是废的）', () => {
  准备([
    { at: '2026-11-13 12:00', what: '买了自热饭（15 块）' },
    { at: '2026-11-13 13:00', what: '在家吃了undefined' },
  ])
  const r = 跑()
  assert.ok(/脏数据/.test(r.out), 'undefined 没被点名：\n' + r.out.slice(-800))
  assert.ok(/在家吃了undefined/.test(r.out), '没说清是哪一条：\n' + r.out.slice(-800))
  const 条 = 待办().items.find((x) => x.id === '体检-基础')
  assert.ok(条, '没写待办')
  assert.ok(/算不出钱|undefined/.test(条.事项), '待办没说清：' + 条.事项)
})

test('L6 有「塊」没被账本认出来 → 报「算不出钱」（不是脏数据那类）', () => {
  // 账本现在只认简体「块|元」。「花了 12 塊」算 0 —— 钱是真花了，
  // 账本一个字看不出来。体检要能看见它，并且说清是「算不出钱」不是「脏数据」。
  准备([{ at: '2026-11-13 12:00', what: '花了 12 塊' }])
  const r = 跑()
  assert.ok(/算不出钱/.test(r.out), '这种写法没被看见：\n' + r.out.slice(-800))
  assert.ok(/花了 12 塊/.test(r.out), '没把原文打出来：\n' + r.out.slice(-800))
})

test('L7 账本有问题也不改退出码（钱算不出来不让她停摆）', () => {
  准备([{ at: '2026-11-13 12:00', what: '在家吃了undefined' }])
  const r = 跑()
  assert.equal(r.code, 0, '账本问题把退出码改成非 0 了 —— 那心跳会天天显示失败，是另一种噪音：\n' + r.out.slice(-500))
  assert.ok(/问题 0 条/.test(r.out), '账本问题被算进「问题数」了：\n' + r.out.slice(-500))
})

test('L8 账本单元：一笔() 认「元」，也仍然认「块」', async () => {
  const { 一笔 } = await import(join(TOOLS, '账本.mjs'))
  assert.deepEqual(一笔('花了 12 元'), { 花: 12, 赚: 0, 被拿: 0 }, '「元」没认出来')
  assert.deepEqual(一笔('买了自热饭（15 块）'), { 花: 15, 赚: 0, 被拿: 0 }, '「块」被改坏了')
  assert.deepEqual(一笔('给了 50 元'), { 花: 0, 赚: 50, 被拿: 0 }, '「给了 N 元」方向错了')
  assert.deepEqual(一笔('退回押金 10 元'), { 花: 0, 赚: 10, 被拿: 0 }, '「退回 N 元」方向错了')
  assert.deepEqual(一笔('走到街市'), { 花: 0, 赚: 0, 被拿: 0 }, '走路被算成花钱了')
})

test('L9 --json 里带账本两个字段（面板/脚本要用）', () => {
  准备([{ at: '2026-11-13 12:00', what: '买了自热饭（15 块）' }])
  const r = 跑({}, ['--json'])
  const j = JSON.parse(r.out)
  assert.equal(j.账本条数, 1, 'json 里没有账本条数：' + r.out.slice(0, 300))
  assert.deepEqual(j.账本问题, [], 'json 里账本问题不是空数组：' + JSON.stringify(j.账本问题))
})
