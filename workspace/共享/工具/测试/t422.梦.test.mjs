import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

// 做梦是纯模板拼接（0 token），所以能用沙盒精确断言。
// 这里锁的是四件事：一天一个、余味不重复、地名整词、群聊不出脏东西；
// 外加两条时序：醒来那一刻生成、date 必须是今天。
const TOOLS = process.env.QQ_TOOLS_DIR || '{{BOT_ROOT}}/共享/工具'
const 梦 = join(TOOLS, '做梦.mjs')
const 睡 = join(TOOLS, '睡眠阶段.mjs')
const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const 昨天 = new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10)
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

function 造(opts = {}) {
  const sb = mkdtempSync(join(tmpdir(), 'dream422-'))
  mkdirSync(join(sb, 'mem', '日志'), { recursive: true })
  mkdirSync(join(sb, 'logs'), { recursive: true })
  mkdirSync(join(sb, 'lock'), { recursive: true })
  const w = (p, o) => writeFileSync(p, typeof o === 'string' ? o : JSON.stringify(o))
  w(join(sb, 'mem', '内心.md'), '# 内心\n这会儿还算有精神，身上还有些力气\n他今天说的那句话还留着\n')
  w(join(sb, 'mem', '物品.json'), { items: [{ n: '水杯' }] })
  w(join(sb, 'mem', '想要.json'), { 当下想要: [] })
  w(join(sb, 'mem', '别扭.json'), { people: {} })
  w(join(sb, 'mem', '睡眠.json'), { last_sleep: { quality: 0.8, deep_min: 100, rem_min: 60 } })
  w(join(sb, 'mem', '资产.json'), { 记录: opts.记录 || [] })
  if (opts.昨余味) w(join(sb, 'mem', `梦-${昨天}.md`), `# ${昨天} 梦\n余味: ${opts.昨余味}\n`)
  if (opts.今梦) w(join(sb, 'mem', `梦-${今天}.md`), opts.今梦)
  if (opts.群聊) w(join(sb, 'logs', `1051483012-${今天}.jsonl`), opts.群聊.map((x) => JSON.stringify(x)).join('\n') + '\n')
  return sb
}

function 跑(sb, args = []) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, [梦, ...args], {
        encoding: 'utf8', timeout: 30000, cwd: TOOLS,
        env: {
          ...process.env,
          DREAM_MEM: join(sb, 'mem'), DREAM_LOGS: join(sb, 'logs'),
          DREAM_TOOLS: TOOLS, DREAM_SOURCE: '测试',
        },
      }),
    }
  } catch (e) { return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') } }
}

const 读梦 = (sb) => {
  const p = join(sb, 'mem', `梦-${今天}.md`)
  return existsSync(p) ? readFileSync(p, 'utf8') : ''
}
const 读余味 = (t) => ((t.match(/^余味[:：]\s*(.+)$/m) || [])[1] || '').trim()

test('M1 今天已经有梦 → 不重做，并在留痕里说清是跳过', () => {
  const sb = 造({ 今梦: '# 旧\n余味: 旧的余味还在。\n旧正文\n' })
  const r = 跑(sb)
  assert.equal(r.code, 0, '跑失败了：' + r.out)
  assert.ok(读梦(sb).includes('旧的余味还在。'), '已有的梦被覆盖了：' + 读梦(sb).slice(0, 100))
  const log = readFileSync(join(sb, 'mem', '日志', '做梦.log'), 'utf8')
  assert.ok(/跳过/.test(log), '留痕里没有「跳过」：' + log)
  rmSync(sb, { recursive: true, force: true })
})

test('M2 --force 才重做（手工要换一个梦时才用）', () => {
  const sb = 造({ 今梦: '# 旧\n余味: 旧的余味还在。\n旧正文\n' })
  跑(sb, ['--force'])
  const t = 读梦(sb)
  assert.ok(!t.includes('旧的余味还在。'), '--force 没重做：' + t.slice(0, 100))
  assert.match(t, /^# \d{4}-\d{2}-\d{2} 梦/m, '格式不对：' + t.slice(0, 80))
  const log = readFileSync(join(sb, 'mem', '日志', '做梦.log'), 'utf8')
  assert.ok(/做好了/.test(log), '留痕里没有「做好了」：' + log)
  rmSync(sb, { recursive: true, force: true })
})

test('M3 余味不会连着两天一样（她翻旧账抽的就是这一句）', () => {
  const 昨 = '那点暖意还没有散。'
  const 撞 = []
  for (let i = 0; i < 8; i++) {
    const sb = 造({ 昨余味: 昨 })
    跑(sb)
    const 余 = 读余味(读梦(sb))
    assert.ok(余.length >= 8, '余味太短，会被回忆池的「梦 >= 8 字」整条滤掉：「' + 余 + '」')
    if (余 === 昨) 撞.push(余)
    rmSync(sb, { recursive: true, force: true })
  }
  assert.deepEqual(撞, [], '8 次里有 ' + 撞.length + ' 次和昨天一模一样')
})

test('M4 地点用地图里的整词，不许贪婪吃成「家喝了咖啡」', () => {
  const sb = 造({
    记录: [
      { at: bj(Date.now() - 3600e3), what: '在家喝了咖啡' },
      { at: bj(Date.now() - 1800e3), what: '走到街市' },
    ],
  })
  for (let i = 0; i < 8; i++) {
    跑(sb, ['--force'])
    const t = 读梦(sb)
    assert.ok(!/又回到家喝了咖啡/.test(t), '地名还是贪婪匹配：「' + t.slice(0, 120) + '」')
  }
  // 同时确认整词是能出来的（不能因为怕错就永远不提地点）
  // 16 次不是 6 次：地点池只有「家」「街市」两条，6 次里一次都抽不到某个的概率
  // 是 1.6% —— 全套要跑十几分钟，这个概率迟早撞上，撞上就是一次莫名其妙的红。
  const 见过 = []
  for (let i = 0; i < 16; i++) {
    跑(sb, ['--force'])
    见过.push(读梦(sb))
  }
  assert.ok(见过.some((t) => /今天去过(家|街市)/.test(t)), '整词地名一次都没出现（避开得过头了）')
  rmSync(sb, { recursive: true, force: true })
})

test('M5 群聊里带 @ / CQ 码 / 复读的不会被念进梦里', () => {
  const sb = 造({
    群聊: [
      { user_id: '123', message: '@ 何头像 我玩点别的' },
      { user_id: '456', message: '[CQ:at,qq=789] 你走开' },
      { user_id: '789', message: '哈哈哈哈哈哈哈哈' },
      { user_id: '321', message: '今天风挺大的' },
    ],
  })
  const 坏 = []
  for (let i = 0; i < 8; i++) {
    跑(sb, ['--force'])
    const t = 读梦(sb)
    if (/@|CQ:|\[CQ/.test(t)) 坏.push(t)
  }
  assert.deepEqual(坏, [], '梦里出现了 @ 或 CQ 码：「' + (坏[0] || '').slice(0, 140) + '」')
  rmSync(sb, { recursive: true, force: true })
})

test('M6 梦只用真实来源，场景/身体/转折/结尾四个抽签池已删', () => {
  // HUMANIZE 2026-11-17（批次673，P0-5）：那四个池是代码替她编经历，还会被召回当真梦。
  const sb = 造()
  跑(sb, ['--force'])
  const t = 读梦(sb)
  assert.ok(!/^(场景|身体感|转折|结尾)[:：]/m.test(t), '梦文件里还有固定池字段：' + t.slice(0, 140))
  assert.match(t, /^(睡眠|地点|物品|细节)[:：]/m, '一条真实来源都没有：' + t.slice(0, 140))
  const src = readFileSync(梦, 'utf8')
  assert.ok(!/天花板在转|追不上前面的背影|嗓子发干|在水里翻书|正要看清那行字/.test(src), '固定池又回到源码里了')
  rmSync(sb, { recursive: true, force: true })
})

test('M12 一条真实素材都没有 → 当天不做梦，也不写文件', () => {
  const sb = 造()
  writeFileSync(join(sb, 'mem', '内心.md'), '')
  writeFileSync(join(sb, 'mem', '物品.json'), JSON.stringify({ items: [] }))
  const r = 跑(sb, ['--force'])
  assert.equal(r.code, 0, '跑失败了：' + r.out)
  assert.equal(读梦(sb), '', '没有真实素材却写了梦：' + 读梦(sb).slice(0, 120))
  const log = readFileSync(join(sb, 'mem', '日志', '做梦.log'), 'utf8')
  assert.ok(/没有真实素材/.test(log), '留痕里没说清为什么没做：' + log)
  rmSync(sb, { recursive: true, force: true })
})

test('M7 醒来那一刻（endSleep）就把梦做好，date 必须是今天', () => {
  const sb = 造({ 昨余味: '那点暖意还没有散。' })
  const now = Date.now()
  const startMs = now - 45 * 60e3 // 45 分钟：短于 60 分，endSleep 不会跑补课（省 20 秒）
  writeFileSync(join(sb, 'mem', '睡眠.json'), JSON.stringify({
    live: { start: bj(startMs), startMs, deep_min: 30, rem_min: 10, cycle: 1, phase: 'N2' },
    sleeping: true, records: [], segments: [], 欠: 0,
  }))
  writeFileSync(join(sb, 'mem', '状态.json'), JSON.stringify({
    energy: 60, 困意: 20, mood: { intensity: 0.2 },
    layers: { physical: 60, emotional: 50, cognitive: 70, existential: 55 },
  }))
  writeFileSync(join(sb, 'mem', '梦余味.json'), JSON.stringify({ date: 昨天, 好: true, 余味: '那点暖意还没有散。', 已用: true }))

  const 代码 = 'const m = await import(' + JSON.stringify(pathToFileURL(睡).href) + ');'
    + 'console.log(JSON.stringify(m.endSleep("natural")))'
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 120000, cwd: TOOLS,
    env: {
      ...process.env, TZ: 'UTC',
      ST_BASE: join(sb, 'mem'), QQ_LOCK_DIR: join(sb, 'lock'),
      DREAM_MEM: join(sb, 'mem'), DREAM_LOGS: join(sb, 'logs'), DREAM_TOOLS: TOOLS,
      // endSleep 会 spawn 激素.mjs（8 秒超时）。全套跑的时候机器忙，
      // 这一下就可能把 60 秒的 timeout 顶穿 —— 那是这套测试唯一会偶发红的来源。
      ST_NO_HORMONE: '1',
    },
  })
  assert.match(out, /"ok":true/, 'endSleep 没成功：' + out.slice(0, 200))

  const t = 读梦(sb)
  assert.ok(t.length > 0, '醒来之后没有梦 —— 梦还在等 11:30 那个心跳任务')
  assert.match(t, /^# \d{4}-\d{2}-\d{2} 梦/m, '梦的格式不对：' + t.slice(0, 80))

  const dy = JSON.parse(readFileSync(join(sb, 'mem', '梦余味.json'), 'utf8'))
  assert.equal(dy.date, 今天, '梦余味的 date 不是今天 —— 状态推进/睡眠阶段都会跳过它')
  assert.notEqual(读余味(t), '那点暖意还没有散。', '醒来做的梦还在用昨天那句余味')

  // 状态推进那条链：date 对 + 已用 false → 情绪 +0.2
  const st = JSON.parse(readFileSync(join(sb, 'mem', '状态.json'), 'utf8'))
  assert.equal(Number(st.layers.emotional), 52, '余味没进情绪层（50 + 2）')
  rmSync(sb, { recursive: true, force: true })
})

test('M8 醒来时会覆盖「醒来前就有的梦」（醒来的才配得上刚才那一觉）', () => {
  const sb = 造({ 今梦: '# 已有\n余味: 这个是醒来前就有的。\n正文\n' })
  const now = Date.now()
  const startMs = now - 45 * 60e3
  writeFileSync(join(sb, 'mem', '睡眠.json'), JSON.stringify({
    live: { start: bj(startMs), startMs, deep_min: 30, rem_min: 10, cycle: 1, phase: 'N2' },
    sleeping: true, records: [], segments: [], 欠: 0,
  }))
  writeFileSync(join(sb, 'mem', '状态.json'), JSON.stringify({
    energy: 60, 困意: 20, mood: { intensity: 0 },
    layers: { physical: 60, emotional: 50, cognitive: 70, existential: 55 },
  }))
  const 代码 = 'const m = await import(' + JSON.stringify(pathToFileURL(睡).href) + ');'
    + 'm.endSleep("natural")'
  execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 120000, cwd: TOOLS,
    env: {
      ...process.env, TZ: 'UTC',
      ST_BASE: join(sb, 'mem'), QQ_LOCK_DIR: join(sb, 'lock'),
      DREAM_MEM: join(sb, 'mem'), DREAM_LOGS: join(sb, 'logs'), DREAM_TOOLS: TOOLS,
      // endSleep 会 spawn 激素.mjs（8 秒超时）。全套跑的时候机器忙，
      // 这一下就可能把 60 秒的 timeout 顶穿 —— 那是这套测试唯一会偶发红的来源。
      ST_NO_HORMONE: '1',
    },
  })
  assert.ok(!读梦(sb).includes('这个是醒来前就有的。'), '醒来没换新梦 —— 她今天会一直挂着醒来前那个：' + 读梦(sb).slice(0, 120))
  assert.match(读梦(sb), /^# \d{4}-\d{2}-\d{2} 梦/m, '格式不对：' + 读梦(sb).slice(0, 80))
  rmSync(sb, { recursive: true, force: true })
})

test('M9 一天醒两次：第二个梦不再给一次情绪', () => {
  // 凌晨醒一次又睡、早上再醒 —— 两次都会走 endSleep、都会做新梦。
  // 余味该换成新梦的，但加成本身只能给一次，否则睡两觉心情抬两回。
  const sb = 造({ 昨余味: '那点暖意还没有散。' })
  const 醒来 = () => {
    const now = Date.now()
    const startMs = now - 45 * 60e3
    writeFileSync(join(sb, 'mem', '睡眠.json'), JSON.stringify({
      live: { start: bj(startMs), startMs, deep_min: 30, rem_min: 10, cycle: 1, phase: 'N2' },
      sleeping: true, records: [], segments: [], 欠: 0,
    }))
    const 代码 = 'const m = await import(' + JSON.stringify(pathToFileURL(睡).href) + ');'
      + 'console.log(JSON.stringify(m.endSleep("natural")))'
    return execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
      encoding: 'utf8', timeout: 120000, cwd: TOOLS,
      env: {
        ...process.env, TZ: 'UTC',
        ST_BASE: join(sb, 'mem'), QQ_LOCK_DIR: join(sb, 'lock'),
        // 批次424：M9 是唯一漏了这个开关的 醒来()。endSleep 会 spawn 激素.mjs，
        // 沙盒里它读不到东西、8 秒超时，情绪加成跟着没发生 → 假红（单跑也红，全套里更拖时间）。
        ST_NO_HORMONE: '1',
        DREAM_MEM: join(sb, 'mem'), DREAM_LOGS: join(sb, 'logs'), DREAM_TOOLS: TOOLS,
      },
    })
  }
  writeFileSync(join(sb, 'mem', '状态.json'), JSON.stringify({
    energy: 60, 困意: 20, mood: { intensity: 0 },
    layers: { physical: 60, emotional: 50, cognitive: 70, existential: 55 },
  }))
  醒来()
  const 一 = JSON.parse(readFileSync(join(sb, 'mem', '状态.json'), 'utf8'))
  assert.equal(Number(一.layers.emotional), 52, '第一次醒来没加成')

  // 模拟「两条消费链都用过了」
  const dy = JSON.parse(readFileSync(join(sb, 'mem', '梦余味.json'), 'utf8'))
  dy.已用 = true; dy['情绪已用'] = true
  writeFileSync(join(sb, 'mem', '梦余味.json'), JSON.stringify(dy))
  const 一余味 = dy.余味

  醒来()
  const 二 = JSON.parse(readFileSync(join(sb, 'mem', '状态.json'), 'utf8'))
  assert.equal(Number(二.layers.emotional), 52, '第二次醒来又加了一次（' + 一.layers.emotional + ' → ' + 二.layers.emotional + '）')
  const dy2 = JSON.parse(readFileSync(join(sb, 'mem', '梦余味.json'), 'utf8'))
  assert.equal(dy2['情绪已用'], true, '新梦把「情绪已用」标记丢了 —— 会再加一次')
  assert.equal(dy2.已用, true, '新梦把「已用」标记丢了 —— 状态推进会再加一次')
  assert.notEqual(dy2.余味, 一余味, '第二个梦的余味没换（她翻旧账会读到同一个梦两次）')
  rmSync(sb, { recursive: true, force: true })
})

test('M10 梦文件只写素材，不再拼第一人称叙事', () => {
  const sb = 造({
    群聊: [{ user_id: '123', message: '今天风挺大的' }],
  })
  try {
    跑(sb)
    const t = 读梦(sb)
    assert.match(t, /^# \d{4}-\d{2}-\d{2} 梦/m)
    assert.match(t, /^余味[:：]\s*.+$/m)
    assert.match(t, /^情绪：/m)
    // 批次673：场景/身体/转折/结尾四个抽签池已删，只留真实来源字段。
    assert.match(t, /^(睡眠|地点|物品|细节)[:：]/m)
    assert.ok(!/^(我想|我觉得|我梦|我醒|我记)/m.test(t), '梦文件里还有第一人称叙事：' + t.slice(0, 120))
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

// STATE_HEAD_NOT_DREAM 2026-11-17（批次652）：线上 13:21 那个梦的细节行里出现了
// 「墙上写着“精力 /”」—— 内心.md 第一行是状态事实「精力 34/100；困意 100/100…」，
// 做梦.mjs 把它当「心里话」切出首句，clip() 又抹掉数字，只剩「精力 /」进了梦。
// 状态是她读的，不是她想过的事。
test('M11 内心.md 的状态事实行不进梦素材', () => {
  const sb = 造()
  writeFileSync(join(sb, 'mem', '内心.md'),
    '精力 34/100；困意 100/100；心情 困得厉害了；体力感 中；对主人：好感 68/100；熟悉 60/100\n' +
    '愿望：攒几个神级表情包在群里斗图赢一次\n' +
    '惦记：还没回他消息\n')
  try {
    跑(sb)
    const t = 读梦(sb)
    assert.ok(!/精力\s*\/?/.test(t), '状态事实被当成梦素材：' + t.slice(0, 200))
    assert.ok(!/困意|体力感|对主人|好感/.test(t), '状态事实被当成梦素材：' + t.slice(0, 200))
    assert.match(t, /惦记：还没回他消息|还没回他消息/, '真正的心里话被一起过滤掉了')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})
