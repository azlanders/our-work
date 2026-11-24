// t573 —— 激素 → 她（批次573）
//
// 主人要的三层：身体反应 / 行为倾向 / 说话方式。
//
// 现状（批次571 时实测）：激素只到两处 —— `mood.intensity` 的回落目标（±0.35）
// 和 `eBase` 情绪基线（±3）。她做事的倾向、说话的样子、身体的反应，一样都没有。
//
// 更要命的是 `mood` 里三个字段**全是死的**：
//   · `arousal` —— 全仓没有写点，也没有读点（`状态.json` 里那个 1 是初始值）
//   · `valence` —— 只有 poll.js 读（算「心 X」），没有写点 → 永远 50
//   · `drive`   —— poll.js 读 3 处、outbound.js 读 1 处（anxious → 打字停顿 ×0.7），
//                  但**没有写点** → 永远 'calm'，那段分支从上线起没跑过
//
// 所以这一批不是「新造字段」，是**把三个死字段接活** —— 这正是「没有出口的字段就是
// 第二个 existential」的反面：有出口、没输入，也一样是摆设。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync } from 'node:fs'

const 工具 = '{{BOT_ROOT}}/共享/工具'

process.env.QUIET_NOTE = '1'

const 总 = await import(工具 + '/_总线.mjs')
const 基线 = () => ({ v: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 } })
const 叠 = (o) => ({ v: { ...基线().v, ...o } })

// ══════════ A 情绪轴（valence / arousal / drive） ══════════
test('A1 平静时：valence 中性、arousal 低、drive 是 calm', () => {
  const 轴 = 总.算情绪轴(基线())
  assert.ok(Math.abs(轴.valence) < 0.05, '平静时 valence 是 ' + 轴.valence)
  assert.ok(轴.arousal < 0.1, '平静时 arousal 是 ' + 轴.arousal)
  assert.equal(轴.drive, 'calm')
})

test('A2 被夸之后：valence 转正，drive 变 eager（有兴趣）', () => {
  const 轴 = 总.算情绪轴(叠({ dopamine: 55, oxytocin: 44 }))
  assert.ok(轴.valence > 0.1, '被夸了 valence 还是 ' + 轴.valence)
  assert.equal(轴.drive, 'eager', '被夸了 drive 是 ' + 轴.drive)
})

test('A3 被骂之后：valence 转负（负面要比正面更重，别拉平）', () => {
  const 轴 = 总.算情绪轴(叠({ dopamine: 41, oxytocin: 32, cortisol: 39 }))
  assert.ok(轴.valence < -0.1, '被骂了 valence 只有 ' + 轴.valence)
  const 夸 = 总.算情绪轴(叠({ dopamine: 55, oxytocin: 44 })).valence
  assert.ok(Math.abs(轴.valence) > Math.abs(夸), '一次被骂还不如一次被夸重 —— negative bias 丢了')
})

test('A4 争吵之后：drive 变 anxious（压力 + 心跳一起上来）', () => {
  const 轴 = 总.算情绪轴(叠({ cortisol: 37, adrenaline: 28 }))
  assert.equal(轴.drive, 'anxious', '吵完架 drive 是 ' + 轴.drive)
})

test('A5 看恐怖片：arousal 明显抬起来（这是"心跳加速"唯一的载体）', () => {
  const 轴 = 总.算情绪轴(叠({ adrenaline: 44, cortisol: 31 }))
  assert.ok(轴.arousal > 0.35, '吓完 arousal 只有 ' + 轴.arousal)
})

test('A6 泡完澡：GABA 上来，arousal 被压低', () => {
  const 轴 = 总.算情绪轴(叠({ gaba: 62, adrenaline: 14 }))
  assert.ok(轴.arousal < 0.05, '泡完澡 arousal 是 ' + 轴.arousal)
})

test('A7 三个字段都在合法范围内（valence -1~1，arousal 0~1）', () => {
  const 极 = [
    叠({ dopamine: 100, oxytocin: 100, cortisol: 0, gaba: 100, adrenaline: 100 }),
    叠({ dopamine: 0, oxytocin: 0, cortisol: 100, gaba: 0, adrenaline: 0 }),
  ]
  for (const h of 极) {
    const 轴 = 总.算情绪轴(h)
    assert.ok(轴.valence >= -1 && 轴.valence <= 1, 'valence 越界：' + 轴.valence)
    assert.ok(轴.arousal >= 0 && 轴.arousal <= 1, 'arousal 越界：' + 轴.arousal)
    assert.ok(['calm', 'anxious', 'eager'].includes(轴.drive), 'drive 是野值：' + 轴.drive)
  }
})

// ══════════ B 行为倾向 ══════════
test('B1 基线时两个倾向都是 1（不偏不倚）', () => {
  const 倾 = 总.算激素倾向(基线())
  assert.ok(Math.abs(倾.想动 - 1) < 0.02, '基线 想动 = ' + 倾.想动)
  assert.ok(Math.abs(倾.想缩 - 1) < 0.02, '基线 想缩 = ' + 倾.想缩)
})

test('B2 肾上腺素高 → 想动（坐不住）', () => {
  const 倾 = 总.算激素倾向(叠({ adrenaline: 44 }))
  assert.ok(倾.想动 > 1.3, '吓完还坐得住：想动 = ' + 倾.想动)
})

test('B3 皮质醇高 + GABA 低 → 想缩着', () => {
  const 倾 = 总.算激素倾向(叠({ cortisol: 45, gaba: 35 }))
  assert.ok(倾.想缩 > 1.25, '压力大还不想缩：想缩 = ' + 倾.想缩)
})

test('B4 两个倾向有上下限（不许把票数拉到 0 或无穷）', () => {
  const 倾 = 总.算激素倾向(叠({ adrenaline: 0, cortisol: 0, gaba: 100 }))
  assert.ok(倾.想动 >= 0.5, '想动 低到 ' + 倾.想动)
  assert.ok(倾.想缩 >= 0.5, '想缩 低到 ' + 倾.想缩)
})

// ══════════ C 接线（三个死字段必须真的被写） ══════════
test('C1 状态推进 真的把 valence / arousal / drive 写回 mood', () => {
  const 源 = readFileSync(工具 + '/状态推进.mjs', 'utf8')
  assert.match(源, /算情绪轴/, '状态推进 没调 算情绪轴')
  for (const k of ['valence', 'arousal', 'drive']) {
    assert.match(源, new RegExp('mood\\.' + k + '\\s*='), '状态推进 没写 mood.' + k)
  }
})

test('C2 自主行动 真的用了 想动 / 想缩', () => {
  const 源 = readFileSync(工具 + '/自主行动.mjs', 'utf8')
  assert.match(源, /算激素倾向/, '自主行动 没调 算激素倾向')
  const 用 = (源.match(/想动|想缩/g) || []).length
  assert.ok(用 >= 4, '只出现 ' + 用 + ' 次 —— 算了但没接到票数上')
})

test('C3 困意 真的读 激素.json 的肾上腺素（被吓醒不过来）', () => {
  const 源 = readFileSync(工具 + '/困意.mjs', 'utf8')
  assert.match(源, /adrenaline/, '困意 没读肾上腺素')
  assert.match(源, /激素\.json/, '困意 没打开 激素.json')
})

// ══════════ D 身体反应：肾上腺素压困意（行为测，不钉写法） ══════════
test('D1 同一个状态，肾上腺素高时困意更低', async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')

  const 造 = (adv) => {
    const d = mkdtempSync(join(tmpdir(), 't573-'))
    mkdirSync(join(d, '日志'), { recursive: true })
    const now = Date.now()
    const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    writeFileSync(join(d, '状态.json'), JSON.stringify({
      energy: 60, 困意: 30, hoursAwake: 6, 测试标记: 't573',
      layers: { physical: 70, emotional: 55, cognitive: 70, existential: 50 },
      mood: { intensity: 0 }, body: { 困: 30 }, 更新时间: bj(now - 15 * 60e3),
    }))
    writeFileSync(join(d, '睡眠.json'), JSON.stringify({ sleeping: false, records: [], 欠: 0 }))
    writeFileSync(join(d, '激素.json'), JSON.stringify({
      v: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: adv },
      B: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
      lastTick: now, repeats: {}, daily: { date: bj(now).slice(0, 10), used: {} },
    }))
    return d
  }
  const 算 = (adv) => {
    const d = 造(adv)
    try {
      const r = spawnSync(process.execPath, [工具 + '/困意.mjs', '--json'], {
        encoding: 'utf8', timeout: 30e3,
        env: { ...process.env, QQ_SLEEPY_MEM: d, QUIET_NOTE: '1' },
      })
      // 困意.mjs 的 `--json` 直接打 result，sleepy 在顶层的
      try { return Number(JSON.parse(String(r.stdout || '{}')).sleepy) } catch { return null }
    } finally { rmSync(d, { recursive: true, force: true }) }
  }
  const 低 = 算(18)
  const 高 = 算(50)
  assert.ok(低 !== null && 高 !== null, '困意 dry 没打印出数值（低 ' + 低 + ' 高 ' + 高 + '）')
  assert.ok(高 < 低, '肾上腺素 50 的困意(' + 高 + ') 不低于 18 的(' + 低 + ')')
})

// ══════════ C4 真跑（批次573 自己栽的：静态断言不算验证） ══════════
test('C4 自主行动 **真能跑起来**（const 不提升，grep 到名字不等于能用）', async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')

  const d = mkdtempSync(join(tmpdir(), 't573c4-'))
  try {
    mkdirSync(join(d, '日志'), { recursive: true })
    const now = Date.now()
    const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    // 最小状态：只给自主行动真正会读的那几份，其余走它自己的兜底
    writeFileSync(join(d, '状态.json'), JSON.stringify({
      energy: 60, 困意: 20, hoursAwake: 6, 测试标记: 't573chk', 更新时间: bj(now - 15 * 60e3),
      layers: { physical: 70, emotional: 55, cognitive: 70, existential: 50 },
      mood: { intensity: 0, valence: 0, arousal: 0.2, drive: 'calm' }, body: { 困: 20 },
    }))
    writeFileSync(join(d, '自主.json'), JSON.stringify({ state: '待命', since: now, doneAt: 0, nextAt: 0, log: [], place: '家', form: '线下' }))
    writeFileSync(join(d, '资产.json'), JSON.stringify({ 钱: 100, 位置: '家' }))
    writeFileSync(join(d, '激素.json'), JSON.stringify({
      v: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
      B: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
      lastTick: now, repeats: {}, daily: { date: bj(now).slice(0, 10), used: {} },
    }))
    const r = spawnSync(process.execPath, [工具 + '/自主行动.mjs', '--试刷手机'], {
      encoding: 'utf8', timeout: 30e3,
      env: { ...process.env, QQ_AUTONOMY_MEM: d, QUIET_NOTE: '1' },
    })
    assert.equal(r.status, 0, '自主行动 起不来（退出码 ' + r.status + '）：' + String(r.stderr || '').slice(0, 400))
    assert.match(String(r.stdout || ''), /刷手机/, '跑起来了但没有执行动作：' + String(r.stdout || '').slice(0, 200))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════ D2 睡着时唤醒一定低（不然 arousal:1 跟「睡着」自相矛盾） ══════════
test('D2 睡着跑一次推进：arousal 降到低位、drive 是 calm', async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')

  const d = mkdtempSync(join(tmpdir(), 't573d2-'))
  try {
    mkdirSync(join(d, '日志'), { recursive: true })
    const now = Date.now()
    const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    writeFileSync(join(d, '状态.json'), JSON.stringify({
      energy: 60, 困意: 20, hoursAwake: 0, 测试标记: 't573d2', 更新时间: bj(now - 15 * 60e3),
      layers: { physical: 70, emotional: 55, cognitive: 70, existential: 50 },
      // 初始值就是 1（极度唤醒）—— 这是真档里现在那个值
      mood: { label: '睡着', intensity: 0, valence: 0, arousal: 1, drive: 'calm' },
    }))
    writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: true, since: bj(now - 3 * 3600e3) }))
    writeFileSync(join(d, '激素.json'), JSON.stringify({
      v: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
      B: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
      lastTick: now, repeats: {}, daily: { date: bj(now).slice(0, 10), used: {} },
    }))
    const r = spawnSync(process.execPath, [工具 + '/状态推进.mjs'], {
      encoding: 'utf8', timeout: 30e3,
      env: { ...process.env, ST_BASE: d, QUIET_NOTE: '1' },
    })
    assert.equal(r.status, 0, '状态推进 失败：' + String(r.stderr || '').slice(0, 300))
    const m = JSON.parse(readFileSync(join(d, '状态.json'), 'utf8')).mood
    assert.ok(m.arousal < 0.3, '睡着时 arousal 还是 ' + m.arousal)
    assert.equal(m.drive, 'calm', '睡着时 drive 是 ' + m.drive)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════ D3 醒着时三轴真的跟着激素走（只验睡着那一半是不够的） ══════════
test('D3 醒着 + 肾上腺素高：跑一次推进 → arousal 抬起来、drive 变成 anxious', async () => {
  const { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { spawnSync } = await import('node:child_process')

  const d = mkdtempSync(join(tmpdir(), 't573d3-'))
  try {
    mkdirSync(join(d, '日志'), { recursive: true })
    const now = Date.now()
    const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    writeFileSync(join(d, '状态.json'), JSON.stringify({
      energy: 60, 困意: 40, hoursAwake: 6, 测试标记: 't573d3', 更新时间: bj(now - 15 * 60e3),
      layers: { physical: 70, emotional: 55, cognitive: 70, existential: 50 },
      mood: { label: '还行', intensity: 0, valence: 0, arousal: 0, drive: 'calm' },
    }))
    // 醒着
    writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj(now - 6 * 3600e3) }))
    // 刚吵完架：皮质醇 +12、肾上腺素 +10
    writeFileSync(join(d, '激素.json'), JSON.stringify({
      v: { dopamine: 45, cortisol: 37, oxytocin: 40, gaba: 50, adrenaline: 28 },
      B: { dopamine: 45, cortisol: 25, oxytocin: 40, gaba: 50, adrenaline: 18 },
      lastTick: now, repeats: {}, daily: { date: bj(now).slice(0, 10), used: {} },
    }))
    writeFileSync(join(d, '自主.json'), JSON.stringify({ state: '待命', since: now, doneAt: 0, nextAt: 0, log: [], place: '家', form: '线下' }))
    const r = spawnSync(process.execPath, [工具 + '/状态推进.mjs'], {
      encoding: 'utf8', timeout: 30e3,
      env: { ...process.env, ST_BASE: d, QUIET_NOTE: '1' },
    })
    assert.equal(r.status, 0, '状态推进 失败：' + String(r.stderr || '').slice(0, 300))
    const m = JSON.parse(readFileSync(join(d, '状态.json'), 'utf8')).mood
    assert.ok(m.arousal > 0.1, '吵完架 arousal 还是 ' + m.arousal)
    assert.equal(m.drive, 'anxious', '吵完架 drive 是 ' + m.drive + '（不是 anxious）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
