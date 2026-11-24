// t568 —— 连续熬夜的永久惩罚（批次568）
//
// 主人在 4.2 拍的三条（都取推荐项）：
//   ① 熬夜判据：**入睡晚于 00:30** 或 **这一觉睡不到 6.5 小时**（任一命中算一晚）
//   ② 惩罚落在**认知上限 + 情绪回落目标**，不碰体力（体力已经有 虚弱/饱腹/病 三条上限）
//   ③ 恢复：**连着 3 晚达标才清零**，清零之后每晚 +2 认知养回来
//
// 交接文档 4.2 的坑：`layers.cognitive` 已有软顶（`恢复目标.mjs` 的 `收敛`），**别造第二套上限**。
// 所以这里不加新封顶，只把「睡着后收敛的目标」往下挪 —— 睡也睡不回 82，这才是「永久」的意思。
//
// 边界（判据写死在这条测试里，改先改这里）：
//   · 只有**夜觉**入账：入睡 20:00~06:00 之外（白天补觉）不动账
//   · 只有 >= 120 分钟的觉入账：打盹、被叫醒的短觉不动账
//   · 同一晚只记一次（`最近` 去重）：endSleep 被多调一次不许翻倍
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const 沙 = '/tmp/sb568'
const 真 = '{{BOT_ROOT}}/记忆'
const 工具 = '{{BOT_ROOT}}/共享/工具'
const 读 = (p) => JSON.parse(fs.readFileSync(p, 'utf8'))
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

fs.rmSync(沙, { recursive: true, force: true })
fs.mkdirSync(沙 + '/日志', { recursive: true })
process.env.ST_BASE = 沙
process.env.QQ_CATCHUP_MEM = 沙
process.env.QQ_LOCK_DIR = 沙 + '/.locks'
process.env.ST_NO_DREAM = '1'
process.env.ST_NO_HORMONE = '1'
process.env.QUIET_NOTE = '1'

const 真档 = ['状态.json', '睡眠.json', '睡醒.json'].map((f) => 真 + '/' + f)
// T5：比 size 会假红（她每分钟都在被心跳写）。真档防线用特征值：沙盒带 `测试标记`。
const 脏真档 = () => 真档.filter((p) => { try { return fs.readFileSync(p, 'utf8').includes('测试标记') } catch { return false } })

const { endSleep } = await import(工具 + '/睡眠阶段.mjs')
const { 结算熬夜, 睡着后, 认知目标, 情绪目标 } = await import(工具 + '/恢复目标.mjs')
const { 熬夜话 } = await import(工具 + '/睡态.mjs')

const 完 = (o = {}) => ({ 连续天数: 0, 达标晚数: 0, 认知扣: 0, 情绪扣: 0, 最近: '', ...o })

// ══════════ A 纯函数：结算熬夜 ══════════
test('A1 一晚 05:00 睡 5 小时（晚 + 短）→ 连熬 1 晚，认知 -1.5、情绪 -2', () => {
  const a = 结算熬夜(完(), { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-16' })
  assert.equal(a.连续天数, 1)
  assert.equal(a.认知扣, 1.5)
  assert.equal(a.情绪扣, 2)
  assert.equal(a.最近, '2026-11-16')
})

test('A2 第 2、3 晚继续熬 → 认知 3 / 4.5，情绪跟着涨', () => {
  let a = 结算熬夜(完(), { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-16' })
  a = 结算熬夜(a, { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-17' })
  assert.equal(a.连续天数, 2)
  assert.equal(a.认知扣, 3)
  assert.equal(a.情绪扣, 4)
  a = 结算熬夜(a, { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-18' })
  assert.equal(a.认知扣, 4.5)
  assert.equal(a.情绪扣, 6)
})

test('A3 一直熬：认知封顶 -12、情绪封顶 -8（不许无限叠）', () => {
  let a = 完()
  for (let i = 0; i < 20; i += 1) a = 结算熬夜(a, { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-12-' + String(i + 1).padStart(2, '0') })
  assert.equal(a.认知扣, 12, '认知扣没封顶：' + a.认知扣)
  assert.equal(a.情绪扣, 8, '情绪扣没封顶：' + a.情绪扣)
})

test('A4 一晚达标（23:00 睡 8 小时）→ 达标晚数 +1，连熬天数先不动', () => {
  const 糟 = 完({ 连续天数: 2, 达标晚数: 0, 认知扣: 3, 情绪扣: 4 })
  const a = 结算熬夜(糟, { 入睡时: 23, 入睡分: 1380, 分钟: 480, 日期: '2026-11-17' })
  assert.equal(a.达标晚数, 1)
  assert.equal(a.连续天数, 2, '才一晚达标就把连熬清零了')
  assert.equal(a.认知扣, 3, '没清零就开始回认知了')
})

test('A5 连 3 晚达标 → 清零；清零那一晚不回认知，下一晚才 -2', () => {
  let a = 完({ 连续天数: 2, 达标晚数: 2, 认知扣: 6, 情绪扣: 4 })
  a = 结算熬夜(a, { 入睡时: 23, 入睡分: 1380, 分钟: 480, 日期: '2026-11-18' })
  assert.equal(a.连续天数, 0, '三晚达标没清零')
  assert.equal(a.情绪扣, 0, '清零了情绪锁还挂着')
  assert.equal(a.认知扣, 6, '清零那一晚就把认知还了（该从下一晚开始）')
  a = 结算熬夜(a, { 入睡时: 23, 入睡分: 1380, 分钟: 480, 日期: '2026-11-19' })
  assert.equal(a.认知扣, 4, '清零后没按每晚 +2 养回来')
})

test('A6 白天补觉（14:00 睡 5 小时）不算熬夜 —— 账一个字节都不动', () => {
  const 糟 = 完({ 连续天数: 1, 认知扣: 1.5, 情绪扣: 2, 最近: '2026-11-15' })
  const a = 结算熬夜(糟, { 入睡时: 14, 入睡分: 840, 分钟: 300, 日期: '2026-11-16' })
  assert.deepEqual(a, 糟)
})

test('A7 短觉（90 分钟）不动账 —— 打盹和「被叫醒的短觉」都不该记熬夜', () => {
  const 糟 = 完({ 连续天数: 1, 认知扣: 1.5, 情绪扣: 2, 最近: '2026-11-15' })
  assert.deepEqual(结算熬夜(糟, { 入睡时: 3, 入睡分: 180, 分钟: 90, 日期: '2026-11-16' }), 糟)
})

test('A8 同一晚重复结算 → 幂等（endSleep 多跑一次不许翻倍）', () => {
  const 一 = 结算熬夜(完(), { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-16' })
  const 二 = 结算熬夜(一, { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-16' })
  assert.deepEqual(二, 一)
})

test('A9 坏账/空值都当 0 处理，不抛错', () => {
  const a = 结算熬夜(null, { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-16' })
  assert.equal(a.连续天数, 1)
  assert.equal(结算熬夜(完({ 认知扣: 'xx', 连续天数: -3 }), { 入睡时: 5, 入睡分: 300, 分钟: 300, 日期: '2026-11-17' }).连续天数, 1)
})

// ══════════ B 睡着后：目标被挪下来（不造第二套上限）══════════
test('B1 没账：睡 10 小时，认知收敛到 82 附近、情绪到 55 附近', () => {
  const r = 睡着后({ physical: 40, cognitive: 40, emotional: 60 }, 10, undefined, null)
  // 0.26/h 走 10 小时还原不了 100%（还剩 4.9%），82 的差距 42 → 79.9。别把「接近」写成「到了」。
  assert.ok(r.cognitive > 79, '认知没朝 82 收敛：' + r.cognitive)
  assert.ok(r.emotional > 54, '情绪没回到 55：' + r.emotional)
  assert.ok(r.cognitive <= 认知目标 + 0.01, '冲过了认知目标')
})

test('B2 认知扣满 12：睡 10 小时也只到 70 —— 睡不回来，这才叫永久', () => {
  const r = 睡着后({ physical: 40, cognitive: 40, emotional: 60 }, 10, undefined, 完({ 连续天数: 8, 认知扣: 12 }))
  assert.ok(r.cognitive < 72, '认知扣 12 还睡到 ' + r.cognitive + '（目标没被挪下去）')
  assert.ok(r.cognitive > 68, '压过头了：' + r.cognitive)
})

test('B3 情绪扣 8：同一觉（10 小时）情绪只到 47 附近，不是 55', () => {
  const 平 = 睡着后({ physical: 40, cognitive: 40, emotional: 60 }, 10, undefined, null)
  const 熬 = 睡着后({ physical: 40, cognitive: 40, emotional: 60 }, 10, undefined, 完({ 连续天数: 4, 认知扣: 6, 情绪扣: 8 }))
  // 0.06/h 很慢：10 小时只吃掉 54% 的差距，8 的挪动只剩 3.7 —— 但只要方向对，落点一定低于中性 55
  assert.ok(熬.emotional < 平.emotional - 3, '情绪目标没被挪下来：平 ' + 平.emotional + ' vs 熬 ' + 熬.emotional)
  assert.ok(熬.emotional < 情绪目标, '熬夜后的情绪目标不该还高于中性')
})

// ══════════ C endSleep：真的入账 ══════════
function 造觉({ 起 = 5, 存量 = null, nowMs = null } = {}) {
  const 原DateNow = Date.now
  const now = Number(nowMs) || 原DateNow()
  const 今 = new Date(now + 8 * 3600e3)   // 北京「今天」
  // 入睡时刻是北京时间 `起` 点；这一觉一直睡到**现在**（endSleep 用 Date.now() 收尾）
  let 起Ms = Date.UTC(今.getUTCFullYear(), 今.getUTCMonth(), 今.getUTCDate(), 起, 0, 0) - 8 * 3600e3
  if (起Ms > now - 120 * 60e3) 起Ms -= 86400e3   // 起点不能落在未来 / 太近
  const 真分 = Math.round((now - 起Ms) / 60e3)
  const 睡 = {
    sleeping: true,
    live: { phase: 'N2', cycle: 2, deep_min: Math.round(真分 * 0.4), light_min: Math.round(真分 * 0.4), rem_min: 5, start: 北京(起Ms), startMs: 起Ms, lastTick: now },
    segments: [{ start: 北京(起Ms), phases: [] }],
    records: [], 欠: 0,
  }
  if (存量) 睡['熬夜账'] = 存量
  睡['测试标记'] = 't568'   // T5 特征值：真档不会有
  fs.writeFileSync(沙 + '/睡眠.json', JSON.stringify(睡))
  fs.writeFileSync(沙 + '/状态.json', JSON.stringify({
    energy: 50, 困意: 60, 测试标记: 't568', mood: { intensity: 0, label: '睡着' },
    layers: { physical: 50, emotional: 50, cognitive: 60, existential: 50 },
    更新时间: 北京(now - 15 * 60e3).slice(0, 16),
  }))
  fs.writeFileSync(沙 + '/睡醒.json', JSON.stringify({ sleeping: true, since: 北京(起Ms).slice(0, 16) }))
  // 这条测试原先用真实时钟，凌晨 05:00 跑时“23:00 睡到现在”只有 6 小时，
  // 被误判成没睡够。固定时钟只用于测试，不改生产 endSleep 的默认行为。
  try {
    if (nowMs !== null) Date.now = () => now
    return endSleep('natural')
  } finally {
    Date.now = 原DateNow
  }
}

test('C1 05:00 才睡（睡到中午）真走一遍 endSleep → 记下连熬 1 晚', () => {
  const r = 造觉({ 起: 5 })
  assert.equal(r.ok, true, 'endSleep 没成功')
  const 账 = 读(沙 + '/睡眠.json')['熬夜账']
  assert.ok(账, '睡眠.json 没有 熬夜账')
  assert.equal(账.连续天数, 1, '连熬天数 ' + 账.连续天数)
  assert.equal(账.认知扣, 1.5)
})

test('C2 昨晚 23:00 睡到现在（睡够）→ 达标晚数 +1，不记熬夜', () => {
  const 早上七点 = Date.UTC(2026, 10, 17, 7, 0, 0) - 8 * 3600e3
  const r = 造觉({ 起: 23, 存量: 完({ 连续天数: 2, 达标晚数: 0, 认知扣: 3, 情绪扣: 4 }), nowMs: 早上七点 })
  assert.equal(r.ok, true)
  const 账 = 读(沙 + '/睡眠.json')['熬夜账']
  assert.equal(账.达标晚数, 1)
  assert.equal(账.连续天数, 2)
})

// ══════════ D 状态推进：睡着分支真的用了这个账 ══════════
function 跑推进() {
  const r = spawnSync(process.execPath, [工具 + '/状态推进.mjs'], {
    encoding: 'utf8', timeout: 60000, cwd: 工具,
    env: { ...process.env, ST_BASE: 沙, QQ_CATCHUP_MEM: 沙, QQ_LOCK_DIR: 沙 + '/.locks' },
  })
  return String((r.stdout || '') + (r.stderr || ''))
}
function 造在睡({ 认知扣 = 0, 认知 = 40 } = {}) {
  const now = Date.now()
  const 起 = now - 8 * 3600e3
  fs.writeFileSync(沙 + '/睡眠.json', JSON.stringify({
    sleeping: true, 欠: 0, 测试标记: 't568', 熬夜账: 完({ 连续天数: 认知扣 ? 8 : 0, 认知扣 }),
    live: { phase: 'N3', cycle: 3, deep_min: 100, light_min: 100, rem_min: 60, start: 北京(起), startMs: 起, lastTick: now },
    segments: [{ start: 北京(起), phases: [] }], records: [],
  }))
  fs.writeFileSync(沙 + '/状态.json', JSON.stringify({
    energy: 45, 困意: 30, 测试标记: 't568', mood: { intensity: 0, label: '睡着' },
    layers: { physical: 45, emotional: 50, cognitive: 认知, existential: 50 },
    更新时间: 北京(now - 8 * 3600e3).slice(0, 16),
  }))
  fs.writeFileSync(沙 + '/睡醒.json', JSON.stringify({ sleeping: true, since: 北京(起).slice(0, 16) }))
}

test('D1 睡 8 小时：没熬夜账 → 认知回到 77 以上', () => {
  造在睡({ 认知扣: 0 })
  跑推进()
  const c = Number(读(沙 + '/状态.json').layers.cognitive)
  assert.ok(c > 75, '没熬夜账却只回到 ' + c)
})

test('D2 认知扣满 12 → 同样睡 8 小时，认知卡在 70 以下（状态推进真的传了账）', () => {
  造在睡({ 认知扣: 12 })
  跑推进()
  const c = Number(读(沙 + '/状态.json').layers.cognitive)
  assert.ok(c < 71, '认知扣 12 还睡到 ' + c + ' —— 状态推进没把账传进 睡着后')
})

// ══════════ E 注入那一句 + 真档防线 ══════════
test('E1 熬夜话：没账不说；连熬 3 晚要说清「几晚」和「怎么养回来」', () => {
  assert.equal(熬夜话(null), '')
  assert.equal(熬夜话(完()), '')
  const 话 = 熬夜话(完({ 连续天数: 3, 认知扣: 4.5, 情绪扣: 6 }))
  assert.match(话, /3 晚/, '没说熬了几晚：' + 话)
  assert.match(话, /养得回来|养回来|缓回来/, '没说怎么养回来：' + 话)
  assert.ok(!/\d{8}/.test(话), '注入里出现 8 位裸号')
})

test('E2 真档里没有一条「测试标记」', () => {
  const 脏 = 脏真档()
  assert.deepEqual(脏, [], '真档被写了：' + 脏.join('、'))
})

test('E3 反向自检：沙盒里是**另一份**文件（同 inode 就说明 env 没生效，上面全写进真档了）', () => {
  const a = fs.statSync(沙 + '/睡眠.json')
  const b = fs.statSync(真 + '/睡眠.json')
  assert.notEqual(a.ino, b.ino, '沙盒和真档是同一个 inode —— 沙盒变量没生效')
  assert.ok(读(沙 + '/睡眠.json')['熬夜账'], '沙盒 睡眠.json 里没有 熬夜账')
})
