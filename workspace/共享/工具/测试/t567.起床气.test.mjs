// t567 —— 起床气：深睡里被人硬拽起来，得有脾气（批次567）
//
// 交接文档 4.1 的落点清单：判「这次是被强制叫醒」的线索已有 ——
// `QQ_WAKE_BY`（谁叫的）、`live.phase`（叫醒时是不是 N3）、`reason`（woken / natural / long）。
//
// 三条硬约束，各有出处：
//   1. **不碰 layers.emotional**。批次245：醒来那一刻再融合一次情绪 = 睡一觉治好抑郁。
//      这里只动 `mood.intensity`（±2 的「当下心情」），它由 状态推进 每 15 分钟往激素底子收敛。
//   2. **不硬拦消息**。批次537：把主人的话吞掉比不回话坏得多。起床气只压「回话意愿」
//      （poll.js 的 intensity <= -1 → 有点烦 / 门槛高），开不开口仍然归她。
//   3. **注入里不许出现裸号**。t421 I5：`QQ_WAKE_BY` 是「主人私聊 {{OWNER_UIN}}」这种形状，
//      只白名单成「主人 / 人」，绝不原样拼进句子。
//
// 判据（写死在这条测试里，改判据先改这里）：
//   起床气 = reason === 'woken' && 叫醒时 phase === 'N3' && 这一觉 >= 60 分钟
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const 沙 = '/tmp/sb567'
const 真 = '{{BOT_ROOT}}/记忆'
const 工具 = '{{BOT_ROOT}}/共享/工具'
const 读 = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

fs.rmSync(沙, { recursive: true, force: true })
fs.mkdirSync(沙 + '/日志', { recursive: true })
// 沙盒变量必须在 import 之前设 —— 睡眠阶段.mjs 的 __base 是顶层求值的（批次536 的教训）
process.env.ST_BASE = 沙
process.env.QQ_CATCHUP_MEM = 沙
process.env.QQ_LOCK_DIR = 沙 + '/.locks'
process.env.ST_NO_DREAM = '1'
process.env.ST_NO_HORMONE = '1'
// QUIET_NOTE（t453）：这条测试只 **读** poll.js、并不 import 插件，但 t453 的判据认的是
// 文件里有没有那串路径 —— 按它的规矩闭嘴就是了（note() 不写生产日志，本来也该这样）。
process.env.QUIET_NOTE = '1'

// T5：真档防线不能用 mtime（线上有每分钟写 状态.json 的心跳），这里只做「size+内容特征」比对
const 真档 = ['状态.json', '睡眠.json', '睡醒.json'].map((f) => 真 + '/' + f)
// T5：状态.json 每分钟被心跳写、睡眠.json 每分钟被 tickSleep 写 —— 拿 size/mtime 当指纹必然假红
// （批次570 就红给我看了）。真档防线改成**特征值**：沙盒每一份都带 `测试标记`，真档不可能有。
const 脏真档 = () => 真档.filter((p) => { try { return fs.readFileSync(p, 'utf8').includes('测试标记') } catch { return false } })

const { endSleep } = await import(工具 + '/睡眠阶段.mjs')
const { 起床气话 } = await import(工具 + '/睡态.mjs')

function 造({ phase = 'N3', 分钟 = 90, reason = 'woken', 谁 = '', intensity = 0, 旧气 = null } = {}) {
  const now = Date.now()
  const startMs = now - 分钟 * 60e3
  const 起 = 北京(startMs)
  const st = {
    energy: 50, 困意: 60, mood: { intensity, label: '睡着' },
    layers: { physical: 50, emotional: 50, cognitive: 80, existential: 50 },
    更新时间: 北京(now - 15 * 60e3),
  }
  if (旧气) st['起床气'] = 旧气
  st['测试标记'] = 't567'   // 真档永远不会有这串字（T5 的特征值防线）
  fs.writeFileSync(沙 + '/状态.json', JSON.stringify(st))
  fs.writeFileSync(沙 + '/睡眠.json', JSON.stringify({
    sleeping: true, 测试标记: 't567',
    live: { phase, cycle: 2, deep_min: Math.round(分钟 * 0.4), light_min: Math.round(分钟 * 0.4), rem_min: 5, start: 起, startMs, lastTick: now },
    segments: [{ start: 起, phases: [] }],
    records: [], 欠: 0,
  }))
  fs.writeFileSync(沙 + '/睡醒.json', JSON.stringify({ sleeping: true, since: 起.slice(0, 16) }))
  process.env.QQ_WAKE_BY = 谁
  return endSleep(reason)
}

// ══════════ A 接线（poll.js 没有沙盒变量，只能认死这一处）══════════
// poll.js 一个字都不读 env（几十处硬编码），造不了场景 —— 所以这条只能静态认：
// 它必须 import 这个纯函数，并且真的推进 parts 里，否则「她自己知道」这半条就是空的。
test('A1 poll.js 真的把起床气话 塞进注入了（不是只 import 不调用）', () => {
  const p = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
  const s = fs.readFileSync(p, 'utf8')
  // 批次568 起同一条 import 还带 熬夜话，所以只认「里面有起床气话、来自睡态.mjs」
  assert.match(s, /(?:import|const)\s*\{[^}]*起床气话[^}]*\}\s*(?:from\s*|await import\(|=\s*await import\()\s*['\"`][^'\"`]*睡态\.mjs['\"`]\)?/, 'poll.js 没 import 起床气话')
  assert.match(s, /const 气话 = 起床气话\(j && j\['起床气'\]\)/, '没把 状态.json 的 起床气 喂进去')
  assert.ok(/if \(气话\) parts\.push\(气话\)/.test(s), '算了但没塞进 parts —— 等于没注入')
})

// ══════════ B 纯函数：起床气话 ══════════
const T = Date.parse('2026-11-16T11:00:00+08:00')

test('B1 起床气还没过期 → 说出「硬拽」和剩余分钟', () => {
  const 话 = 起床气话({ untilMs: T + 12 * 60e3, 谁: '主人' }, T)
  assert.match(话, /硬拽/, '没说是被硬拽起来的：' + 话)
  assert.match(话, /12 分钟/, '没说还剩几分钟：' + 话)
  assert.match(话, /主人/, '没说是谁叫的')
})

test('B2 过期了 → 一个字都不说（起床气不是永久标签）', () => {
  assert.equal(起床气话({ untilMs: T - 1, 谁: '主人' }, T), '')
})

test('B3 没这个字段 / 坏值 → 空串，不抛错', () => {
  assert.equal(起床气话(null, T), '')
  assert.equal(起床气话(undefined, T), '')
  assert.equal(起床气话({}, T), '')
  assert.equal(起床气话({ untilMs: 'xx' }, T), '')
})

test('B4 谁 只可能是「主人」或「人」—— 喂个 QQ 号也绝不原样吐进注入（t421 I5）', () => {
  const 话 = 起床气话({ untilMs: T + 60e3, 谁: '{{OWNER_UIN}}' }, T)
  assert.ok(!/\d{8}/.test(话), '注入里出现了 8 位裸号：' + 话)
  assert.match(话, /人/, '连「人」都没说')
})

// ══════════ C endSleep：什么时候算起床气 ══════════
test('C1 深睡被叫醒（woken + N3 + 90 分钟）→ 记下起床气，心情跌到「有点烦」以下', () => {
  const r = 造({ phase: 'N3', 分钟: 90, reason: 'woken', 谁: '主人私聊 {{OWNER_UIN}}' })
  assert.equal(r.ok, true, 'endSleep 没成功')
  const st = 读(沙 + '/状态.json')
  assert.ok(st['起床气'] && typeof st['起床气'] === 'object', '状态.json 里没有 起床气')
  assert.ok(Number(st['起床气'].untilMs) > Date.now(), '起床气的到期时间不在将来')
  assert.equal(st['起床气'].谁, '主人', '叫醒人没收敛成「主人」')
  // poll.js 的判据：intensity <= -1 → 有点烦 + 门槛抬高
  assert.ok(Number(st.mood.intensity) <= -1, '心情只跌到 ' + st.mood.intensity + '，没跨过 -1（她不会有一点烦）')
  // 记在 睡眠.json 里也要有（面板/复盘看得见这次是什么醒的）
  const 睡 = 读(沙 + '/睡眠.json')
  assert.ok(睡.last_sleep && 睡.last_sleep['起床气'], '睡眠.json 的 last_sleep 没记这次起床气')
})

test('C2 自然醒（natural + N3）→ 没有起床气（那不是脾气，是惯性）', () => {
  造({ phase: 'N3', 分钟: 90, reason: 'natural' })
  const st = 读(沙 + '/状态.json')
  assert.ok(!st['起床气'], '自然醒也记了起床气')
  // N3 的 inertia 仍然要扣那 0.3（原来就有的行为，不许被这一批改掉）
  assert.ok(Number(st.mood.intensity) < -0.2, 'N3 的 inertia 丢了')
})

test('C3 浅睡被叫醒（woken + N2）→ 没有起床气', () => {
  造({ phase: 'N2', 分钟: 90, reason: 'woken', 谁: '主人私聊 1' })
  assert.ok(!读(沙 + '/状态.json')['起床气'], 'N2 也叫起床气 —— 判据松了')
})

test('C4 深睡但只睡了 30 分钟（打盹）→ 没有起床气', () => {
  造({ phase: 'N3', 分钟: 30, reason: 'woken', 谁: '主人私聊 1' })
  assert.ok(!读(沙 + '/状态.json')['起床气'], '30 分钟的觉也叫起床气 —— 门槛没了')
})

test('C5 没传叫醒人 → 说「人」，不许空着也不许编一个名字', () => {
  造({ phase: 'N3', 分钟: 90, reason: 'woken', 谁: '' })
  const 气 = 读(沙 + '/状态.json')['起床气']
  assert.equal(气.谁, '人', '没传 QQ_WAKE_BY 时 谁 是 ' + 气.谁)
})

test('C6 上一觉的起床气没还完又睡了 → 标成「睡过去了」，不许下次醒来再还一遍', () => {
  const 旧 = { since: '2026-11-16 10:00:00', untilMs: Date.now() - 3600e3, 谁: '主人', 还: 1.1, 已还: false }
  造({ phase: 'N2', 分钟: 90, reason: 'natural', 旧气: 旧 })
  const 气 = 读(沙 + '/状态.json')['起床气']
  assert.ok(气, '旧记录被整条删了 —— 复盘时会查不到')
  assert.notEqual(气.已还, false, '旧的起床气还挂着「没还」，下次醒来会二次补回')
})

// ══════════ D 状态推进：到期还回去，且只还一次 ══════════
function 跑推进() {
  const r = spawnSync(process.execPath, [工具 + '/状态推进.mjs'], {
    encoding: 'utf8', timeout: 60000, cwd: 工具,
    env: { ...process.env, ST_BASE: 沙, QQ_CATCHUP_MEM: 沙, QQ_LOCK_DIR: 沙 + '/.locks' },
  })
  return String((r.stdout || '') + (r.stderr || ''))
}
function 造到期({ 到期 = -60e3, 已还 = false, intensity = -1.3 } = {}) {
  const now = Date.now()
  fs.writeFileSync(沙 + '/状态.json', JSON.stringify({
    energy: 50, 困意: 20, mood: { intensity, label: '有点烦' },
    layers: { physical: 50, emotional: 50, cognitive: 80, existential: 50 },
    // 状态推进 的 parseBJ 只认 16 字符（YYYY-MM-DD HH:MM）；带秒会被判「无法解析」并按现在重置，
    // 于是 mins=0 直接 early-exit —— 第一版就是这样假红的（不是代码没生效）
    更新时间: 北京(now - 15 * 60e3).slice(0, 16),
    起床气: { since: 北京(now - 20 * 60e3), untilMs: now + 到期, 谁: '主人', 还: 1.1, 已还 },
  }))
  fs.writeFileSync(沙 + '/睡醒.json', JSON.stringify({ sleeping: false, since: 北京(now - 25 * 60e3).slice(0, 16) }))
}

test('D1 到期后把扣掉的那 1.1 还回来（起床气是短跌，不是一整天）', () => {
  造到期({ 到期: -60e3 })
  跑推进()
  const st = 读(沙 + '/状态.json')
  assert.ok(Number(st.mood.intensity) > -0.5, '到期了心情还卡在 ' + st.mood.intensity)
  assert.equal(st['起床气'].已还, true, '没标已还 —— 下一次推进会再加一遍')
})

test('D2 已经还过 → 再推进十次也不许再涨（只还一次）', () => {
  造到期({ 到期: -60e3 })
  跑推进()
  const 一 = Number(读(沙 + '/状态.json').mood.intensity)
  for (let i = 0; i < 3; i += 1) 跑推进()
  const 二 = Number(读(沙 + '/状态.json').mood.intensity)
  assert.ok(Math.abs(二 - 一) < 0.2, '重复推进把心情一直往上加：' + 一 + ' → ' + 二)
})

test('D3 还没到期 → 一分都不还（不然起床气等于没发生）', () => {
  造到期({ 到期: 5 * 60e3, intensity: -1.3 })
  跑推进()
  const st = 读(沙 + '/状态.json')
  assert.equal(st['起床气'].已还, false, '还没到期就还了')
  assert.ok(Number(st.mood.intensity) <= -1.2, '没到期心情就被抬到 ' + st.mood.intensity)
})

// ══════════ E 真档防线 ══════════
test('E1 上面跑了这么多次，她真档里没有一条「测试标记」', () => {
  const 脏 = 脏真档()
  assert.deepEqual(脏, [], '真档被写了：' + 脏.join('、'))
})

test('E2 反向自检：沙盒里确实落下了文件（找不到 = env 没生效，上面全写进真档了）', () => {
  assert.ok(fs.existsSync(沙 + '/睡眠.json'), '沙盒里没有 睡眠.json')
  const 睡 = 读(沙 + '/睡眠.json')
  assert.ok(Array.isArray(睡.records) && 睡.records.length > 0, '沙盒的 records 是空的 —— endSleep 根本没写沙盒')
})
