// t569 —— 打盹滑入整觉：困意还在涨，就别让她「眯 40 分钟再眯 40 分钟」（批次569）
//
// 交接文档 4.3：`自主行动.mjs` 第 191 行
//     if (在打盹(base)) { console.log('她在打盹，这一轮不换动作'); process.exit(0) }
// **无条件早退** —— 于是「困到该睡整觉」那条判据（批次500 加的，在 `pick === '打瞌睡'` 里）
// 对**正在打盹的人**永远走不到。批次500 的实测：00:35 / 03:19 / 03:43 / 04:39 连着四次打盹，
// 每次起来困意还在 96+（打盹本来就不清困意账）。
//
// 这一批不新开第三条睡觉路：过线时**不退出**，强制这一轮走「打瞌睡」那一支 ——
// 收打盹、判家、startSleep、作息 --想睡 全复用批次500/542 那一套。
//
// 判据抽成 自主判据.该滑入整觉() 一份，两处共问（抽中打瞌睡时 / 打盹途中）。
// 判家的坑是批次542 的：**第二个入口没判家，她睡在便利店**。这里必须一样问 读资产再判。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, existsSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))
const bj16 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

const { 该滑入整觉 } = await import(工具 + '/自主判据.mjs')

// ══════════ A 纯函数：该不该滑进去 ══════════
test('A1 困意 120 体力 60 → 该睡整觉（困到 95 以上了）', () => {
  assert.equal(该滑入整觉(120, 60), true)
})

test('A2 困意 80 体力 60 → 不滑（过打盹门槛 78，但没到整觉线）', () => {
  assert.equal(该滑入整觉(80, 60), false)
})

test('A3 困意 60 体力 30 → 该整觉（困低体力低，四象限那条）', () => {
  assert.equal(该滑入整觉(60, 30), true)
})

test('A4 困意 60 体力 45 → 不滑（体力还够，眯一会儿就够）', () => {
  assert.equal(该滑入整觉(60, 45), false)
})

test('A5 边界：95/94、55/54、38/39 各卡一次', () => {
  assert.equal(该滑入整觉(95, 90), true, '正好 95 不算过线')
  assert.equal(该滑入整觉(94.9, 90), false, '94.9 就滑了 —— 线拉低了')
  assert.equal(该滑入整觉(55, 38), true, '困 55 + 体力 38 该整觉')
  assert.equal(该滑入整觉(54.9, 38), false, '困 54.9 不该整觉')
  assert.equal(该滑入整觉(55, 39), false, '体力 39 还不该整觉')
})

test('A6 坏值不当真：null / NaN / 空串一律 false，不抛错', () => {
  assert.equal(该滑入整觉(null, 60), false)
  assert.equal(该滑入整觉(undefined, 60), false)
  assert.equal(该滑入整觉('', 60), false)
  assert.equal(该滑入整觉('xx', 60), false)
  assert.equal(该滑入整觉(120, null), true, '困到 95 以上时体力读不出来也该睡')
})

test('A7 线可被参数覆盖（参数.json 里那几个数）', () => {
  assert.equal(该滑入整觉(70, 60, { 困到该睡整觉: 70 }), true)
  assert.equal(该滑入整觉(70, 60, { 困到该睡整觉: 71 }), false)
})

test('A8 判据只有一份：自主行动 里不再内联那条公式，两处都问 该滑入整觉', () => {
  const s = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.ok(!/sleepy >= H\('自主_困到该睡整觉', 95\)/.test(s), '自主行动 里还内联着整觉公式（该收进 自主判据）')
  const 次 = (s.match(/该滑入整觉\(/g) || []).length
  assert.ok(次 >= 2, '只找到 ' + 次 + ' 处调用 —— 打盹途中那处没接上')
})

// ══════════ B 行为（沙盒真跑 自主行动 --tick）══════════
function 造盒({ 困意 = 120, 体力 = 60, 位置 = '家', 打盹到 = 15 } = {}) {
  const d = mkdtempSync(join(tmpdir(), 't569-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  for (const f of ['资产.json', '饱渴.json', '饥饿.json', '卫生.json', '工作.json', '天气.json', '疾病.json', '物资.json', '物品.json']) {
    try { writeFileSync(join(d, f), readFileSync(join(真档, f))) } catch { writeFileSync(join(d, f), '{}') }
  }
  // 卫生.json 是「在洗澡」的唯一判据；真档此刻正在洗澡，搬进来会让整轮早退。
  writeFileSync(join(d, '卫生.json'), '{}')
  const now = Date.now()
  writeFileSync(join(d, '状态.json'), JSON.stringify({
    energy: 40, 困意, hoursAwake: 20, 测试标记: 't569', 更新时间: bj16(now - 15 * 60e3),
    layers: { physical: 体力, cognitive: 70, emotional: 50, existential: 50 },
    mood: { intensity: 0 }, body: { 困: Math.min(100, Math.round(困意)) },
  }))
  writeFileSync(join(d, '自主.json'), JSON.stringify({ state: '待命', since: now, doneAt: now, nextAt: 0, log: [], place: 位置, form: '线下' }))
  const 产 = 读(join(d, '资产.json'))
  产.位置 = 位置
  delete 产.在途
  writeFileSync(join(d, '资产.json'), JSON.stringify(产))
  writeFileSync(join(d, '活动台账.json'), JSON.stringify({ today: [], log: [] }))
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj16(now - 20 * 3600e3) }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({ sleeping: false, live: null, segments: [], records: [], 欠: 0, 测试标记: 't569' }))
  writeFileSync(join(d, '打盹.json'), JSON.stringify({
    开始: bj16(now - 20 * 60e3), 到毫秒: now + 打盹到 * 60e3, 到: bj16(now + 打盹到 * 60e3),
    分钟: 35, 为什么: '困得撑不住',
  }))
  for (const f of ['吃饭.json', '压制.json', '链.md']) { try { unlinkSync(join(d, f)) } catch { /* 本来就没有 */ } }
  return d
}

function 跑(d, extra = []) {
  const r = spawnSync(process.execPath, [join(工具, '自主行动.mjs'), '--tick', ...extra], {
    encoding: 'utf8', timeout: 90000,
    env: {
      ...process.env, QQ_AUTONOMY_MEM: d, ST_BASE: d, QQ_SLEEP_MEM: d, NAP_MEM: d,
      QQ_SLEEPY_MEM: d, QQ_ACT_MEM: d, QUIET_NOTE: '', QQ_NO_MICROSLEEP: '1', LOG_PREFIX_OFF: '1',
    },
  })
  return String((r.stdout || '') + (r.stderr || ''))
}

test('B1 打盹中 + 困意 120 + 在家 → 收掉打盹、开整觉', () => {
  const d = 造盒({ 困意: 120, 体力: 60, 位置: '家' })
  try {
    const out = 跑(d)
    const 睡 = 读(join(d, '睡眠.json'))
    const 醒 = 读(join(d, '睡醒.json'))
    assert.equal(睡.sleeping, true, '没开整觉。输出：' + out.slice(-300))
    assert.equal(醒.sleeping, true, '睡醒镜没同步')
    assert.ok(!existsSync(join(d, '打盹.json')), '打盹没收掉（还挂着打盹，外面看起来像在眯着）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B2 打盹中 + 困意 80（没过整觉线）→ 继续打盹，不许开整觉', () => {
  const d = 造盒({ 困意: 80, 体力: 60 })
  try {
    const out = 跑(d)
    assert.ok(!读(join(d, '睡眠.json')).sleeping, '困意 80 也睡了 —— 线被拉掉了。输出：' + out.slice(-300))
    assert.ok(existsSync(join(d, '打盹.json')), '困意 80 就把打盹收了')
    assert.match(out, /在打盹/, '没有走「打盹中」那条')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B3 打盹中 + 困意 120 + 人在便利店 → 先走回家，不许就地睡（批次542 的坑）', () => {
  const d = 造盒({ 困意: 120, 体力: 60, 位置: '便利店' })
  try {
    const out = 跑(d)
    assert.ok(!读(join(d, '睡眠.json')).sleeping, '在便利店就睡了 —— 判家没接上。输出：' + out.slice(-400))
    const 产 = 读(join(d, '资产.json'))
    assert.equal(String(产.在途 && 产.在途.to || ''), '家', '既没睡也没往家走（在途=' + JSON.stringify(产.在途 || null) + '）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════ C 真档防线 ══════════
test('C1 跑了两轮沙盒，她真档里没有「测试标记」', () => {
  // T5：她每分钟都在被 tickSleep 写 睡眠.json —— 比 size 会假红，比特征值不会。
  const d = 造盒({ 困意: 120 })
  跑(d)
  rmSync(d, { recursive: true, force: true })
  const 脏 = ['睡眠.json', '睡醒.json'].filter((f) => { try { return readFileSync(join(真档, f), 'utf8').includes('测试标记') } catch { return false } })
  assert.deepEqual(脏, [], '真档被写了：' + 脏.join('、'))
})

test('C2 反向自检：沙盒里真的写出了整觉记录', () => {
  const d = 造盒({ 困意: 120 })
  try {
    跑(d)
    assert.ok(读(join(d, '睡眠.json')).sleeping === true, '沙盒里没有整觉记录 —— env 没生效')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
