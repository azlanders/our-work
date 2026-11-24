// t564 —— 睡觉时困意要实时显示、每分钟更新；床比别处恢复快但不能太快（批次564）
//
// 三件事叠在一起，以前每一件都缺一角：
//   ① `tickSleep` **早就在按分钟减困意**（N2 -0.15/分、N3 -0.45/分），
//      但它只被 `自动作息`（20 分钟）调 —— 面板 20 分钟跳一次。
//   ② `状态推进` 写 `body.困 = sleeping ? 0 : …` —— 她一整夜面板上都写着「困 0」。
//   ③ `困意.mjs` 睡着时 `awakeHours = 0` 重算 `sleepy` 并 `st.困意 = sleepy` ——
//      把 tickSleep 分钟级减下来的值整个盖掉。
// 现在：tickSleep 每分钟跑（心跳新任务）、body.困 读 state.困意、困意.mjs 睡着时不写这个字段。
// 另外主人要的「舒适度」= 睡在哪决定恢复倍率（家 1.0 / 能趴的地方 0.7 / 别处 0.5）。
import { test, after } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => readFileSync(p, 'utf8')
const 指纹 = (p) => { try { const s = statSync(p); return `${s.size}:${s.mtimeMs}` } catch { return '(无)' } }
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

function 沙盒({ 睡着 = true, 前几分钟 = 40, 位置 = '家', 困意 = 80, energy = 40 } = {}) {
  const d = mkdtempSync(join(tmpdir(), 't564-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  for (const f of ['饱渴.json', '饥饿.json', '疾病.json', '体温.json', '工作.json', '物品.json']) {
    try { writeFileSync(join(d, f), 读(join(真档, f))) } catch { writeFileSync(join(d, f), '{}') }
  }
  const now = Date.now()
  const startMs = now - 前几分钟 * 60e3
  writeFileSync(join(d, '资产.json'), JSON.stringify({ 位置, 钱: 500, 记录: [] }))
  writeFileSync(join(d, '状态.json'), JSON.stringify({
    困意, energy, hoursAwake: 3,
    layers: { physical: 40, emotional: 50, cognitive: 60, existential: 50 },
    mood: { intensity: 0 }, 熬夜: { over: 0 },
  }))
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: 睡着, since: bj(startMs).slice(0, 16) }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({
    sleeping: 睡着, sleepSince: startMs,
    live: 睡着 ? { phase: 'N1', cycle: 1, deep_min: 0, light_min: 0, rem_min: 0, start: bj(startMs), startMs, lastTick: startMs } : null,
    segments: 睡着 ? [{ start: bj(startMs), phases: [] }] : [],
    records: [], awakeSince: startMs,
  }))
  return d
}

function 跑(d, 脚本, argv = []) {
  const r = spawnSync(process.execPath, [join(工具, 脚本), ...argv], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ST_BASE: d, QQ_SLEEP_MEM: d, QQ_AUTONOMY_MEM: d, NAP_MEM: d, QQ_SLEEPY_MEM: d, QQ_HUNGER_MEM: d, LOG_PREFIX_OFF: '1' },
  })
  return String((r.stdout || '') + (r.stderr || ''))
}

test('A1 舒适度判据只有一份（睡态.睡在哪倍率），整觉和打盹都问它', () => {
  // COMFORT（批次564c）：倍率表原来写在 睡眠阶段 里，而打盹的回血在 状态推进 ——
  // 两处各写一张表就是本项目反复踩的分叉。现在抽到 睡态.mjs，两边都 import。
  const 睡态 = 读(工具 + '/睡态.mjs')
  assert.match(睡态, /export function 睡在哪倍率\(位\)/, '睡态.mjs 没有 睡在哪倍率')
  const i倍 = 睡态.indexOf('export function 睡在哪倍率')
  const 段 = 睡态.slice(i倍, i倍 + 500)
  assert.match(段, /p === '家'\) return 1\.0/, '家 不是 1.0')
  assert.match(段, /return 0\.7/, '能趴的地方不是 0.7')
  assert.match(段, /return 0\.5/, '别处不是 0.5')

  for (const f of ['睡眠阶段.mjs', '状态推进.mjs']) {
    const s = 读(工具 + '/' + f)
    assert.ok(s.includes('睡在哪倍率'), f + ' 没问 睡在哪倍率')
    assert.ok(!/咖啡店[^\n]*图书馆[^\n]*公园/.test(s), f + ' 自己又写了一张地方表（分叉）')
  }

  const 睡阶 = 读(工具 + '/睡眠阶段.mjs')
  assert.match(睡阶, /state\.困意 -= 0\.15 \* __decay \* __舒适/, 'N2 的困意衰减没乘舒适度')
  assert.match(睡阶, /state\.困意 -= 0\.45 \* __decay \* __舒适/, 'N3 的困意衰减没乘舒适度')
  assert.match(睡阶, /ENERGY_DECOR|state\.energy \+= 0\.35 \* __decay \* __舒适/, 'N3 缺少注释说明或舒适度倍率')
  // SLEEPY_BODY_SYNC：面板读的是 body.困，只有 状态推进（15 分钟）同步的话「每分钟实时」是假的
  assert.match(睡阶, /state\.body\['困'\] = Math\.round\(state\.困意\)/, 'tickSleep 没同步 body.困')

  const 状推 = 读(工具 + '/状态推进.mjs')
  assert.match(状推, /\? 18 \* __盹舒适/, '打盹的体力回血没乘舒适度')
  assert.match(状推, /12 \* __盹舒适/, '打盹的认知回血没乘舒适度')
})

test('A2 睡眠阶段要有 --tick 命令行入口（心跳每分钟调它）', () => {
  const s = 读(工具 + '/睡眠阶段.mjs')
  assert.ok(s.includes("process.argv.includes('--tick')"), '没有 --tick 入口')
  // 必须带「直接执行」判断，否则别的脚本 import 时带 --tick 会误触发
  assert.match(s, /fileURLToPath\(import\.meta\.url\) === process\.argv\[1\]/, '没判「是直接执行的」')
})

test('A3 心跳表里要有一条每分钟、睡着也跑的 睡眠心跳', () => {
  const d = JSON.parse(读(工具 + '/心跳表.json'))
  const t = (d['任务'] || []).find((x) => x['名'] === '睡眠心跳')
  assert.ok(t, '心跳表里没有 睡眠心跳')
  assert.equal(t['脚本'], '睡眠阶段.mjs')
  assert.deepEqual(t['参数'], ['--tick'])
  assert.equal(t['间隔分'], 1, '不是每分钟')
  assert.equal(t['睡着跑'], true, '睡着了就不跑，那还实时什么')
})

test('A4 状态推进 睡着时不许把 body.困 抹成 0', () => {
  const s = 读(工具 + '/状态推进.mjs')
  assert.ok(!/b\['困'\] = sleeping \? 0 :/.test(s), '还是 sleeping ? 0')
  assert.match(s, /sleeping \? Number\(st\['困意'\] \?\? 0\)/, '睡着时没读 state 的困意')
})

test('A5 困意.mjs 睡着时不许覆盖 st.困意（那是 tickSleep 的字段）', () => {
  const s = 读(工具 + '/困意.mjs')
  assert.ok(s.includes('if (!__sleeping) st.困意 = sleepy'), '没加 __sleeping 守卫')
  // 醒着时还得写（批次540 的一致性不能回退）
  assert.ok(!/^\s*st\.困意 = sleepy$/m.test(s), '还有一处无条件写 st.困意')
})

test('B1 沙盒：睡着 40 分钟跑一次 --tick → 困意按 N1+N2 精确下降，体力回升', () => {
  const d = 沙盒({ 前几分钟: 40, 位置: '家', 困意: 80, energy: 40 })
  try {
    const 前 = JSON.parse(读(join(d, '状态.json')))
    const 前tick = Number(JSON.parse(读(join(d, '睡眠.json'))).live.lastTick)
    跑(d, '睡眠阶段.mjs', ['--tick'])
    const 后 = JSON.parse(读(join(d, '状态.json')))
    const 睡 = JSON.parse(读(join(d, '睡眠.json')))
    // 别按「40 分钟应该有 25 个 N2 分钟」估 —— deltaMin 是 floor(now - lastTick)，
    // 造沙盒到真跑之间有几十毫秒，正好跨一分钟时就会算成 41 分钟（26 个 N2），
    // 这条当场红过一次。改断言**本质关系**：衰减总量必须等于 light_min × 0.15。
    const 降 = 前['困意'] - 后['困意']
    const 应降 = Number(睡.live.light_min) * 0.15
    assert.ok(Math.abs(降 - 应降) < 0.01, '衰减 ' + 降.toFixed(3) + ' 不等于 N2 分钟数×0.15 = ' + 应降.toFixed(3))
    assert.ok(降 > 3 && 降 < 5, '40 分钟降了 ' + 降.toFixed(2) + '（量级不对）')
    // ENERGY_DECOR: 体力恢复归 状态推进.mjs 管，tickSleep 只减 困意
    assert.equal(后.energy, 前.energy, 'tickSleep 不应再直接改 energy')
    // 面板每轮读的就是这个字段：跑完一次 tick，它必须等于刚减完的困意
    assert.equal(Number(后.body?.['困']), Math.round(Number(后['困意'])),
      'body.困 没跟 tick 同步：' + (后.body?.['困']) + ' vs ' + 后['困意'])
    // 别写 `x > y ? true : true`（恒真）。比一下推进前后的真实值。
    assert.ok(Number(睡.live.lastTick) > 前tick, 'lastTick 没推进：' + 前tick + ' → ' + 睡.live.lastTick)
    // 40 分钟落在 N1(15) + N2(25)，跨一分钟抖动允许 24~27
    const n2 = Number(睡.live.light_min)
    assert.ok(n2 >= 24 && n2 <= 27, 'N2 分钟数 ' + n2 + '（期望 24~27）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B2 沙盒：同样 40 分钟，咖啡店比家里恢复慢（0.7 倍）', () => {
  const 家 = 沙盒({ 前几分钟: 40, 位置: '家', 困意: 80 })
  const 店 = 沙盒({ 前几分钟: 40, 位置: '咖啡店', 困意: 80 })
  const 街 = 沙盒({ 前几分钟: 40, 位置: '便利店', 困意: 80 })
  try {
    const 降 = (d) => {
      const a = JSON.parse(读(join(d, '状态.json')))['困意']
      跑(d, '睡眠阶段.mjs', ['--tick'])
      return a - JSON.parse(读(join(d, '状态.json')))['困意']
    }
    const a = 降(家), b = 降(店), c = 降(街)
    assert.ok(a > b && b > c, '恢复速度没区分地方：家 ' + a.toFixed(2) + ' / 咖啡店 ' + b.toFixed(2) + ' / 便利店 ' + c.toFixed(2))
    // 家是第一份「较快但不能太快」的基准：40 分钟里降不到一半
    assert.ok(a < 10, '家里 40 分钟就降了 ' + a.toFixed(2) + ' —— 太快了')
  } finally {
    for (const d of [家, 店, 街]) rmSync(d, { recursive: true, force: true })
  }
})

test('B3 沙盒：没在睡时 --tick 静默退出，一个字都不写', () => {
  const d = 沙盒({ 睡着: false })
  try {
    const 守 = ['状态.json', '睡眠.json', '睡醒.json'].map((f) => [f, 指纹(join(d, f))])
    const out = 跑(d, '睡眠阶段.mjs', ['--tick'])
    assert.equal(out.trim(), '', '没在睡却有输出：' + out.slice(0, 200))
    for (const [f, v] of 守) assert.equal(指纹(join(d, f)), v, f + ' 被写了')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B4 沙盒：状态推进 睡着时 body.困 等于 state.困意，不是 0', () => {
  const d = 沙盒({ 睡着: true, 前几分钟: 20, 困意: 42 })
  try {
    跑(d, '状态推进.mjs', ['--force'])
    const st = JSON.parse(读(join(d, '状态.json')))
    assert.ok(Number(st.body['困']) > 0, '睡着时 body.困 还是 0（主人要实时显示）')
    // 不要求严格相等：这次推进里 状态推进 自己也会重算一次 sleepy 并写回 困意，
    // 两个快照之间差 1~2 是正常的。要锁的是「读的是同一个来源、不是 0」。
    // 容差 5：这次推进里 状态推进 自己也会重算一次 sleepy 并写回 困意，
    // 两个快照之间差几点是正常的（实测 42 vs 45）。要锁的是「读的是同一个来源、不是 0」。
    // 批次569 修：**别钉「差 <= 5」。** 这次推进里 状态推进 会 spawn 困意.mjs 重算一次困意，
    // 重算幅度跟着她的真实数据走（实测同一份用例两次跑出 差 3 / 差 7，就红了 —— 红的是数据漂移不是功能）。
    // 要锁的只有一件事：body.困 来自**同一个来源** —— 它必须是「推进前的 42」或「推进后的困意」。
    const 后 = Math.round(Number(st['困意']))
    assert.ok([42, 后].includes(Number(st.body['困'])),
      'body.困 是 ' + st.body['困'] + '，既不是推进前的 42 也不是推进后的 ' + 后 + '（不是同一个来源）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B5 沙盒：困意.mjs 睡着时不许改 state.困意（tickSleep 减到哪就是哪）', () => {
  const d = 沙盒({ 睡着: true, 前几分钟: 30, 困意: 37 })
  try {
    // 37 是「睡到一半」的值，困意.mjs 若按 awakeHours=0 重算会写成一个完全不同的数
    跑(d, '困意.mjs')
    const st = JSON.parse(读(join(d, '状态.json')))
    assert.equal(Number(st['困意']), 37, '睡着时 困意 被 困意.mjs 覆盖成 ' + st['困意'])
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// GUARD_BY_VALUE 同上：线上 睡眠心跳 每分钟写 状态.json / 睡眠.json，mtime 不可能是静止的。
// 这里只用「特征值」判：t564 造的沙盒是 physical 40 + 困意 42/37，
// 真档同时出现这两个值就是 env 漏了。
after(() => {
  const st = JSON.parse(读(join(真档, '状态.json')))
  const 撞 = Number(st.layers?.physical) === 40 && [42, 37].includes(Number(st['困意']))
  assert.ok(!撞, '真档 状态.json 出现 t564 的特征值（体力 40 + 困意 ' + st['困意'] + '）—— 沙盒变量漏了')
  // 睡醒.json 只在她真的睡/醒时变，不受每分钟 tick 影响 —— 这个可以按「值」查
  const flag = JSON.parse(读(join(真档, '睡醒.json')))
  assert.ok(typeof flag.sleeping === 'boolean', '真档 睡醒.json 结构被写了：' + JSON.stringify(flag))
})
