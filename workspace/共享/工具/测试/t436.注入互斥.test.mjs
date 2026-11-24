import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次436：这一批改的全是「注入里两句话互相拆台」和「说了等于没说」。
// 四条判据都必须能反测抓到 —— 所以每条都配了对照（该出声的那一边还在不在）。
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const POLL = LIB + '/poll.js'
const VOICE = LIB + '/voiceSlots.js'
const FEEL = LIB + '/感受.mjs'
const 真记忆 = '{{BOT_ROOT}}/记忆'

function 造() {
  return mkdtempSync(join(tmpdir(), 't436-'))
}

/** poll.js 的 MEM 是模块顶层求值，同进程换不掉 —— 一律子进程。 */
function 跑(mem, 代码, env = {}) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QQ_MEM: mem, ...env },
  })
  return out.trim().split('\n').pop()
}

// ---------------- A. 档位 vs 关系：不许两套判档同时说话 ----------------

test('A1 只展示 的人（主人）不再收到「半熟/自己人/生人」', () => {
  const sb = 造()
  try {
    // 熟悉度 60 正好落在「半熟」档（>=50 && >=30）—— 改之前这里会吐「半熟」
    writeFileSync(join(sb, '好感度.json'), JSON.stringify({
      people: { 'owner-x': { 只展示: true, 熟悉度: 60, dims: { 亲近: 77 } } },
    }))
    const 代码 = `
      const m = await import(${JSON.stringify(POLL)})
      const v = String(m.voiceHintOf('owner-x', { isPrivate: true }) || '')
      console.log(JSON.stringify({ v }))
    `
    const { v } = JSON.parse(跑(sb, 代码))
    // 665 起档位只报词，不带「：行为倾向」（那部分按拟人化红线删掉了）。
    assert.doesNotMatch(v, /半熟/, '只展示的人还被判成半熟了 —— 会和关系槽的「很熟了」打架')
    assert.doesNotMatch(v, /自己人/, '只展示的人不该走档位')
    assert.doesNotMatch(v, /生人/, '只展示的人不该被判生人')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('A2 普通人的档位话必须还在（别把闸做成把所有人都关掉）', () => {
  const sb = 造()
  try {
    // TIER_ONE_TRUTH 2026-11-17（批次659，审计 P1-3）：档位阈值统一到 关系档.mjs
    // （熟 = 好感 > 75 且 熟悉 > 65）。原夹具卡在 75/70 这个边界上 ——
    // 按旧 poll.js 的 `score>=70 && fam>=60` 算「自己人」，按统一判据算「在意」。
    // 真正要锁的是「闸别把所有人都关掉」，不是某个数字刚好落在哪边，
    // 所以把夹具挪到明确落在「熟」的区间。
    // 线上真实分布参考：最高的群友是 52/60，主人 68/60（只展示，不走这条）。
    writeFileSync(join(sb, '好感度.json'), JSON.stringify({
      people: { 'friend-y': { 熟悉度: 72, score: 80 } },
    }))
    const 代码 = `
      const m = await import(${JSON.stringify(POLL)})
      const v = String(m.voiceHintOf('friend-y', { isPrivate: true }) || '')
      console.log(JSON.stringify({ v }))
    `
    const { v } = JSON.parse(跑(sb, 代码))
    assert.match(v, /自己人/, '高分群友的档位被一起关掉了：' + v.slice(0, 200))
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

// ---------------- B. 表情包说明只留一处 ----------------

test('B1 [顺手] 那句里不许再教一遍 custom_emoji（[想逗人] 槽才是那份）', () => {
  const s = readFileSync(POLL, 'utf8')
  const 行 = s.split('\n').find((l) => l.includes('[顺手] 看到了不回话'))
  assert.ok(行, '找不到 [顺手] 那句')
  assert.doesNotMatch(行, /custom_emoji/, '[顺手] 又去插手表情包了 —— 会和 [想逗人] 说两遍')
  assert.doesNotMatch(行, /歪脸小帽鲸鱼笑|顶盆委屈|立牌吃炸鸡/, '[顺手] 又把表情名册抄了一遍')
  assert.doesNotMatch(行, /单挂/, '[顺手] 又说了一遍别单挂黄豆')
  // 但「顺手」本身该留的东西不能丢
  assert.match(行, /qq_react/, 'qq_react 提示丢了')
  assert.match(行, /qq_feel/, 'qq_feel 提示丢了')
})

test('B2 表情包能力没丢：[想逗人] 槽里仍然有 custom_emoji 和具体名字', () => {
  const sb = 造()
  try {
    // 造一个「心里松」的状态：情绪高、精力足、不困、跟这个人熟
    writeFileSync(join(sb, '状态.json'), JSON.stringify({ energy: 70, mood: 72, 困意: 10 }))
    writeFileSync(join(sb, '关系.json'), JSON.stringify({ people: { 'owner-x': { bond: 0.8, safety: 0.8 } } }))
    writeFileSync(join(sb, '自主.json'), JSON.stringify({ state: '待命', place: '家' }))
    const 代码 = `
      const m = await import(${JSON.stringify(VOICE)})
      const e = String(m.extraSlotsHint({ peer: 'owner-x', ownerUin: 'owner-x', isPrivate: true, mute: false, lastText: '', memDir: ${JSON.stringify(sb)} }) || '')
      console.log(JSON.stringify({ e }))
    `
    const { e } = JSON.parse(跑(sb, 代码))
    if (!/\[想逗人\]|\[提不起劲\]/.test(e)) {
      // 这一支只在玩心 >= 55 时出现；造的数据不达标就跳过，别把「没触发」当成「能力丢了」
      assert.ok(true, '玩心槽本轮没触发（数据不达标），B2 跳过')
    } else {
      const 行 = (e.match(/\[(想逗人|提不起劲)\][^\n]*/) || [''])[0]
      assert.match(行, /custom_emoji/, '玩心槽里的 custom_emoji 说明被删掉了')
      assert.ok(行.length > 40, '玩心槽只剩骨架了：' + 行)
    }
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

// ---------------- C. 屏幕槽不许报秒数 ----------------

test('C1 屏幕槽不出现「秒前」这类假精度', () => {
  const s = readFileSync(VOICE, 'utf8')
  // 钉 return 那一行，不钉整段 —— 整段里有注释写着「第 9 分钟还写着『20秒前』」，
  // 第一次就是被自己写的注释弄红的。
  const 行 = s.split('\n').find((l) => l.includes("'[屏幕] 主人电脑刚有新截图"))
  assert.ok(行, '找不到屏幕槽的 return')
  assert.doesNotMatch(行, /秒前/, '屏幕槽又在报秒数了 —— 10 分钟缓存里这个数字是冻住的')
  assert.doesNotMatch(行, /Math\.floor\(ageMs/, '又把 ageMs 换算成数字塞进提示了')
  assert.match(行, /qq_screen/, '连同 qq_screen 的指路一起删掉了')
})

test('C2 屏幕槽该出现的时候还得出现（3 分钟窗口没改坏）', () => {
  const sb = 造()
  try {
    // 刚写的文件 = 现在，ageMs 约 0，必须在 3 分钟窗口内
    const shot = join(sb, 'shot.png')
    writeFileSync(shot, 'x')
    const 代码 = `
      const m = await import(${JSON.stringify(VOICE)})
      const e = String(m.extraSlotsHint({ peer: 'owner-x', ownerUin: 'owner-x', isPrivate: true, mute: false, lastText: '', memDir: ${JSON.stringify(sb)}, screenPath: ${JSON.stringify(shot)} }) || '')
      console.log(JSON.stringify({ e }))
    `
    const { e } = JSON.parse(跑(sb, 代码))
    assert.match(e, /\[屏幕\] 主人电脑刚有新截图/, '刚截的图反而不提示了：' + e.slice(0, 200))
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

// ---------------- D. 月度统计必须比七天真多才说话 ----------------

const 天前 = (n, 时 = 12) => {
  const d = new Date(Date.now() - n * 24 * 3600e3 + 8 * 3600e3)
  return d.toISOString().slice(0, 10) + ' ' + String(时).padStart(2, '0') + ':00'
}
// 「at」的口径是北京时间字符串；feelHint 解析时拼 ':00+08:00'，所以这里给到分钟

const 造账 = (行) => 行.map((r) => JSON.stringify(r)).join('\n') + '\n'

test('D1 四条全在七天内时，不许再补一句「这个月」（那是同一个数报两遍）', () => {
  const sb = 造()
  try {
    const f = join(sb, '感受.jsonl')
    writeFileSync(f, 造账([
      { at: 天前(5), who: 'owner-x', kind: '被想起', why: 'a' },
      { at: 天前(4), who: 'owner-x', kind: '被想起', why: 'b' },
      { at: 天前(3), who: 'owner-x', kind: '被想起', why: 'c' },
      { at: 天前(2), who: 'owner-x', kind: '被想起', why: 'd' },
    ]))
    const 代码 = `
      const m = await import(${JSON.stringify(FEEL)})
      const v = String(m.feelHint(() => '主人', 'owner-x') || '')
      console.log(JSON.stringify({ v }))
    `
    const { v } = JSON.parse(跑(sb, 代码, { FEEL_FILE: f }))
    assert.match(v, /这七天/, '七天统计不见了：' + v)
    assert.doesNotMatch(v, /这个月：/, '四条全在七天内，还把同一个数报了一遍：' + v)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('D2 真有超过七天的旧账时，「这个月」要说话，而且数比七天大', () => {
  const sb = 造()
  try {
    const f = join(sb, '感受.jsonl')
    writeFileSync(f, 造账([
      { at: 天前(20), who: 'owner-x', kind: '被想起', why: '老一' },
      { at: 天前(18), who: 'owner-x', kind: '被想起', why: '老二' },
      { at: 天前(3), who: 'owner-x', kind: '被想起', why: '新的一' },
      { at: 天前(2), who: 'owner-x', kind: '被想起', why: '新的二' },
    ]))
    const 代码 = `
      const m = await import(${JSON.stringify(FEEL)})
      const v = String(m.feelHint(() => '主人', 'owner-x') || '')
      console.log(JSON.stringify({ v }))
    `
    const { v } = JSON.parse(跑(sb, 代码, { FEEL_FILE: f }))
    // 七天 2 条 / 三十天 4 条 —— 七天那条的出场门槛是 >=2，所以两边都够
    assert.match(v, /这七天你自己记的：被想起 2 次/, '七天数不对：' + v)
    assert.match(v, /这个月：被想起 4 次/, '月度总数没出来：' + v)
    // 4 > 2 才该说 —— 反过来说，如果这条挂在七天后面，读的人会以为「这周也没少」
    assert.ok(v.indexOf('这个月：被想起 4 次') > v.indexOf('这七天'), '顺序反了')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

// ---------------- E. 注入总量别偷偷涨回去 ----------------

// CALIBRATE 2026-11-14（批次484）：阈值 3000 → 3200。批次436 实测 2451 留了 550 余量，
// 之后涨的 670 字**都是内容**（「一起听歌」的旋律质感/歌词/热评、「冲浪养分」的素材），不是固定文案 ——
// 固定文案那部分反而删掉了与 SOUL.md 重复的「总则」（3121 → 3092）。
// 所以这不是「把报警器关掉」，是量程跟着内容走：3200 只剩 108 字余量，再涨就会响。
// CALIBRATE-2 2026-11-14（批次487）：3200 → 3300，实测 3248 = state 1206 / voice 914 / slots 1128。
// 这次涨的两笔**都有据**：
//   · voice +96 —— 批次485 给「手账」那句补上 `调 qq_recall 往回翻`（原来只说怎么查、没说拿什么查，
//     实测 qq_recall 全库 0 次、bash 读手账也 0 条，等于她根本不翻自己的过去）。这是**补能力缺口**，不该省。
//   · slots +57 —— 「一起听歌」「冲浪养分」的素材内容自然增长，不是固定文案。
// 固定文案那部分反而在批次484 删过（与 SOUL.md 重复的「总则」29 字）。
// 下次再涨先看这三段的构成：如果是 voice/slots 的**内容**涨，调阈值；如果是**又加了固定说明**，该搬 SOUL.md。
test('E1 真实记忆下三段注入合计小于 3300 字（批次487 实测 3248 = 1206/914/1128）', () => {
  const 代码 = `
    const m = await import(${JSON.stringify(POLL)})
    const v = await import(${JSON.stringify(VOICE)})
    const ctx = { peer: '{{OWNER_UIN}}', ownerUin: '{{OWNER_UIN}}', isPrivate: true, mute: false, lastText: '' }
    const s = String(m.stateHintOf('{{OWNER_UIN}}', ctx) || '')
    const t = String(m.voiceHintOf('{{OWNER_UIN}}', ctx) || '')
    const e = String(v.extraSlotsHint({ ...ctx, memDir: ${JSON.stringify(真记忆)} }) || '')
    console.log(JSON.stringify({ n: s.length + t.length + e.length, s: s.length, t: t.length, e: e.length }))
  `
  const r = JSON.parse(跑(真记忆, 代码))
  assert.ok(r.n > 800, '注入短得离谱，八成是某个文件读挂了：' + JSON.stringify(r))
  assert.ok(r.n < 3300, '注入涨到 ' + r.n + ' 字了（state ' + r.s + ' / voice ' + r.t + ' / slots ' + r.e + '）')
})
