// t565 —— 硬扛行为的代价：压制有账、结束带利息（批次565）
//
// 主人给的设计（原话摘要）：
//   「玩手机/打游戏/赶工这类高刺激分心行为，本质是用精神资源换清醒时间。
//     被压住的那部分困意不会消失，而是存进一个待结算池。一旦行为结束，
//     这些欠下的困意一次性爆发，还带利息 —— 刷到凌晨三点手机锁屏，困意瞬间从 70 飙到 120。」
//
// 我们不新造字段：`困意账` 本来就是带半衰期的损益账（咖啡 -22 / 半衰 240 分）。
// 但那张账在 `状态.json` 里，而 状态推进 / 困意 / 睡眠心跳 三个写者已经在抢它 ——
// 再加一个写者就多一次并发。所以压制单独落在 `压制.json`：
//   只有 自主行动 写（它唯一知道「这一轮换了什么动作」），只有 困意.mjs 读。
//
// 判据抽成 在干嘛.压制账推进（纯函数）—— 这个文件是「她在干什么」的唯一来源，
// 而且纯函数能直接测，不用 spawn。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 读 = (p) => readFileSync(p, 'utf8')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

test('A1 压制判据只有一份，且在 在干嘛.mjs（「她在干什么」的唯一来源）', () => {
  const s = 读(工具 + '/在干嘛.mjs')
  assert.ok(s.includes('export const 压制类'), '没有 压制类')
  assert.ok(s.includes('export function 压制账推进'), '没有 压制账推进')
  for (const x of ['看B站', '逛贴吧', '学点东西', '琢磨黑话', '打零工']) {
    assert.ok(s.includes("'" + x + "'"), '压制类漏了 ' + x)
  }
  // 不许在别的文件里再定义一份
  const 自主 = 读(工具 + '/自主行动.mjs')
  assert.ok(!/const 压制类 = new Set/.test(自主), '自主行动 自己又写了一份 压制类')
})

test('A2 自主行动 每轮把当前动作报给纯函数，变了才落盘（DRY 不写）', () => {
  const s = 读(工具 + '/自主行动.mjs')
  assert.ok(s.includes('压制账推进'), '没调 压制账推进')
  const i = s.indexOf('压制账推进(load(')
  assert.ok(i > 0, '调用写法变了')
  const 附近 = s.slice(i - 400, i + 900)
  assert.match(附近, /压制\.json/, '没落到 压制.json')
  assert.match(附近, /if \(__新压\.变了\)/, '变了才该写盘，否则每分钟都在写')
  assert.match(附近, /if \(!DRY\)/, '--dry 不该记账')
})

test('A3 困意.mjs 只读压制.json，不许自己写（写者只能有一个）', () => {
  const s = 读(工具 + '/困意.mjs')
  assert.match(s, /readJson\(join\(base, '压制\.json'\)/, '没读 压制.json')
  assert.ok(!/写档\([^)]*压制\.json/.test(s), '困意.mjs 竟然在写 压制.json')
  assert.match(s, /__账增 -= Number\(H\('自主_压制值', 14\)\)/, '压制期间没扣')
  assert.match(s, /__账增 \+= Number\(__e\['值'\] \|\| 0\)/, '待结算没加回')
})

// ---- 纯函数：四条状态机边 ----
test('B1 进出压制类的四条边（纯函数，不用 spawn）', async () => {
  const { 压制账推进 } = await import(工具 + '/在干嘛.mjs')
  const t0 = 1_700_000_000_000

  // 边 1：普通动作 → 压制动作：开一条
  const a = 压制账推进({}, '看B站', t0)
  assert.equal(a.变了, true)
  assert.equal(a.当前.动作, '看B站')
  assert.equal(a.当前.开始, t0)

  // 边 2：还在压制、动作没变：不变
  const b = 压制账推进(a, '看B站', t0 + 60e3)
  assert.equal(b.变了, false, '每分钟都在写盘就是这条没做对')

  // 边 3：压制 → 压制（换一个动作）：还在压，不结算，开始时间保留
  const c = 压制账推进(a, '逛贴吧', t0 + 120e3)
  assert.equal(c.变了, true)
  assert.equal(c.当前.动作, '逛贴吧')
  assert.equal(c.当前.开始, t0, '换动作不该重置开始时间（那会让她一直不被结算）')
  assert.equal(c.待结算.length, 0, '换成另一个压制动作不该结算')

  // 边 4：压制 → 普通动作：结算，带回一笔
  const d = 压制账推进(a, '发呆', t0 + 120e3)
  assert.equal(d.变了, true)
  assert.equal(d.当前, null)
  assert.equal(d.待结算.length, 1)
  assert.equal(d.待结算[0].啥, '看B站')
})

test('B2 利息随压制时长增长，但封顶 2 倍（借得越多利息越狠，不是无限）', async () => {
  const { 压制账推进 } = await import(工具 + '/在干嘛.mjs')
  const t0 = 1_700_000_000_000
  const 压值 = 14
  const 利 = (分钟) => {
    const 档 = 压制账推进({ 当前: { 动作: '看B站', 开始: t0 }, 待结算: [] }, '发呆', t0 + 分钟 * 60e3, { 压制值: 压值, 利息: 0.8 })
    return 档.待结算[0].值 / 压值
  }
  const a = 利(0)      // 1.0
  const b = 利(60)     // 1 + min(2, 0.5)*0.8 = 1.4
  const c = 利(600)    // 1 + min(2, 5)*0.8 = 2.6（封顶）
  assert.ok(a < b && b < c, '利息没随压制时长涨：' + [a, b, c].join(' / '))
  assert.ok(Math.abs(c - 2.6) < 0.01, '封顶算错：' + c)
  assert.ok(Math.abs(a - 1) < 0.01, '刚压就结束不该有额外利息：' + a)
})

// ---- 端到端：困意.mjs 真读出这个文件 ----
function 沙盒(压制档) {
  const d = mkdtempSync(join(tmpdir(), 't565-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  writeFileSync(join(d, '状态.json'), JSON.stringify({
    困意: 40, energy: 50, hoursAwake: 6,
    layers: { physical: 60, emotional: 50, cognitive: 60, existential: 50 },
    mood: { intensity: 0 },
  }))
  // BASELINE 2026-11-16：**基准困意要够高，否则压 14 点会被 Math.max(0,…) 夹住。**
  // 第一版写 6 小时清醒，实测 sleepy 只有 7 —— 压制后变 0，差值是 7 不是 14，
  // 看起来像「压制只生效一半」，其实是撞到了下限。18 小时清醒 → adenosine 45，够看。
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj(Date.now() - 18 * 3600e3).slice(0, 16) }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({ sleeping: false, live: null, segments: [], records: [], 欠: 0, awakeSince: Date.now() - 18 * 3600e3 }))
  writeFileSync(join(d, '自主.json'), JSON.stringify({ state: '待命', since: Date.now(), nextAt: 0 }))
  if (压制档) writeFileSync(join(d, '压制.json'), JSON.stringify(压制档))
  return d
}

function 算(d) {
  const r = spawnSync(process.execPath, [join(工具, '困意.mjs'), '--json'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, QQ_SLEEPY_MEM: d, ST_BASE: d, QQ_SLEEP_MEM: d, QQ_AUTONOMY_MEM: d, NAP_MEM: d, LOG_PREFIX_OFF: '1' },
  })
  const out = String(r.stdout || '')
  const m = out.match(/"sleepy":\s*(-?\d+)/)
  assert.ok(m, '没拿到 sleepy：' + out.slice(0, 300))
  return Number(m[1])
}

test('B3 端到端：压制中 → 困意被压下去（真读 压制.json）', () => {
  const 基 = 沙盒(null)
  const 压 = 沙盒({ 当前: { 动作: '看B站', 开始: Date.now() }, 待结算: [] })
  try {
    const a = 算(基)
    const b = 算(压)
    // 基准必须先够高 —— 不然压 14 点撞下限，差值会变成「离 0 还有多远」，量的是错的东西
    assert.ok(a >= 30, '沙盒基准只有 ' + a + '，太低，压制会撞 Math.max(0,…) 下限')
    assert.ok(a - b >= 12 && a - b <= 16, '压制只压了 ' + (a - b) + ' 点（期望 ~14）')
  } finally {
    rmSync(基, { recursive: true, force: true })
    rmSync(压, { recursive: true, force: true })
  }
})

test('B4 端到端：行为结束的「待结算」会把她打回来（带利息）', () => {
  const 基 = 沙盒(null)
  const 结 = 沙盒({ 当前: null, 待结算: [{ at: Date.now(), 值: 20, 半衰: 40, 啥: '看B站' }] })
  try {
    const a = 算(基)
    const b = 算(结)
    assert.ok(a >= 30, '沙盒基准只有 ' + a + '，太低')
    assert.ok(b - a >= 18 && b - a <= 22, '结算只加了 ' + (b - a) + ' 点（期望 ~20）')
  } finally {
    rmSync(基, { recursive: true, force: true })
    rmSync(结, { recursive: true, force: true })
  }
})

test('B5 端到端：结算的半衰会衰减 —— 40 分钟前的那笔只剩一半', () => {
  const 新 = 沙盒({ 当前: null, 待结算: [{ at: Date.now(), 值: 20, 半衰: 40 }] })
  const 旧 = 沙盒({ 当前: null, 待结算: [{ at: Date.now() - 40 * 60e3, 值: 20, 半衰: 40 }] })
  try {
    const a = 算(新)
    const b = 算(旧)
    assert.ok(a - b >= 9 && a - b <= 11, '半衰 40 分钟后应该只剩一半，实测差 ' + (a - b))
  } finally {
    rmSync(新, { recursive: true, force: true })
    rmSync(旧, { recursive: true, force: true })
  }
})
