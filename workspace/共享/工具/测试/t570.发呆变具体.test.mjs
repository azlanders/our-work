// t570 —— 发呆拆成「刷手机 / 玩电脑」（批次570）
//
// 主人原话：「发呆可以修改一下　发呆的时候可以转换为刷手机玩电脑　以此类推」
//
// 「发呆」这个词在她的状态里挂了很久 —— 但一个人不会真的坐着空白，手上总有手机；
// 在家还会开电脑。所以：
//   · **刷手机**：哪都能刷（她本来就有手机，QQ 都在这上面）
//   · **玩电脑**：只在家（电脑桌是 家区域 里的一块地方，不是随身物品）
//
// 「以此类推」这一批只做到「具体化」这一层：名字换成人真会做的事，判据（坐着/歇着/档）不动。
// 摸鱼、待着这些以后再照这个路子拆 —— 一次只动一件事。
//
// 两个必须守住的坑：
//   ① **判据不能分叉**：新名字必须进口 在干嘛.mjs 的 `坐着`，否则 是歇着 判 false，
//      她刷手机反而按「干活」掉体力（-2.4/h），越歇越累。
//   ② **电脑只在家**：外面（便利店/图书馆）抽到「玩电脑」要退回「刷手机」。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync, unlinkSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => JSON.parse(readFileSync(p, 'utf8'))
const bj16 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

// t453：文件里出现插件路径就要闭嘴（note 不许写生产日志 —— 也免得测试往真档灌「registered」）
process.env.QUIET_NOTE = '1'

const { 档, 是歇着, 坐着 } = await import(工具 + '/在干嘛.mjs')

// ══════════ A 判据（最重要：不能让她刷手机反而更累）══════════
test('A1 刷手机 / 玩电脑 都算「坐着歇着」—— 档是歇、体力按歇着回', () => {
  for (const 态 of ['刷手机', '玩电脑']) {
    assert.equal(是歇着(态), true, 态 + ' 不算歇着 —— 她刷手机会按干活掉体力')
    assert.equal(档(态), '歇', 态 + ' 的档是 ' + 档(态))
  }
})

test('A2 两个名字都进了 坐着 清单（判据只有 在干嘛.mjs 一份）', () => {
  assert.ok(坐着.includes('刷手机'), '坐着 里没有 刷手机')
  assert.ok(坐着.includes('玩电脑'), '坐着 里没有 玩电脑')
})

// ══════════ B 行为：电脑只在家 ══════════
function 造盒(位置) {
  const d = mkdtempSync(join(tmpdir(), 't570-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  for (const f of ['资产.json', '饱渴.json', '饥饿.json', '卫生.json', '工作.json', '天气.json', '疾病.json']) {
    try { writeFileSync(join(d, f), readFileSync(join(真档, f))) } catch { writeFileSync(join(d, f), '{}') }
  }
  // 卫生.json 是「在洗澡」的唯一判据；真档此刻正在洗澡，搬进来会让整轮早退。
  writeFileSync(join(d, '卫生.json'), '{}')
  const now = Date.now()
  writeFileSync(join(d, '状态.json'), JSON.stringify({
    energy: 55, 困意: 25, hoursAwake: 6, 测试标记: 't570', 更新时间: bj16(now - 15 * 60e3),
    layers: { physical: 65, cognitive: 78, emotional: 55, existential: 50 },
    mood: { intensity: 0 }, body: { 困: 25 },
  }))
  writeFileSync(join(d, '自主.json'), JSON.stringify({ state: '待命', since: now, doneAt: now, nextAt: 0, log: [], place: 位置, form: '线下' }))
  const 产 = 读(join(d, '资产.json'))
  产.位置 = 位置
  delete 产.在途
  writeFileSync(join(d, '资产.json'), JSON.stringify(产))
  writeFileSync(join(d, '活动台账.json'), JSON.stringify({ today: [], log: [] }))
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj16(now - 6 * 3600e3) }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({ sleeping: false, live: null, segments: [], records: [], 欠: 0, 测试标记: 't570' }))
  for (const f of ['打盹.json', '吃饭.json', '压制.json', '链.md']) { try { unlinkSync(join(d, f)) } catch { /* 没有 */ } }
  return d
}
function 跑(d, 旗) {
  const r = spawnSync(process.execPath, [join(工具, '自主行动.mjs'), '--tick', ...旗], {
    encoding: 'utf8', timeout: 90000,
    env: { ...process.env, QQ_AUTONOMY_MEM: d, ST_BASE: d, QQ_SLEEP_MEM: d, NAP_MEM: d, QQ_SLEEPY_MEM: d, QQ_ACT_MEM: d, QUIET_NOTE: '1', QQ_NO_MICROSLEEP: '1', LOG_PREFIX_OFF: '1' },
  })
  return { 态: String(读(join(d, '自主.json')).state || ''), out: String((r.stdout || '') + (r.stderr || '')) }
}

test('B1 在家 + 试玩电脑 → state 是「玩电脑」', () => {
  const d = 造盒('家')
  try {
    const r = 跑(d, ['--试玩电脑'])
    assert.equal(r.态, '玩电脑', '在家却没玩电脑：' + r.out.slice(-300))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B2 在外面 + 试玩电脑 → 退回「刷手机」（电脑不是随身物品）', () => {
  const d = 造盒('便利店')
  try {
    const r = 跑(d, ['--试玩电脑'])
    assert.equal(r.态, '刷手机', '在外面玩起电脑了：' + r.out.slice(-300))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B3 在家 + 试刷手机 → 就是「刷手机」', () => {
  const d = 造盒('家')
  try {
    const r = 跑(d, ['--试刷手机'])
    assert.equal(r.态, '刷手机', '刷手机没生效：' + r.out.slice(-300))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// ══════════ C 静态：别留两套名字 ══════════
test('C1 自主行动 里不再把「发呆」当动作名（注释不算）', () => {
  const s = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
    .split('\n').filter((ln) => { const t = ln.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') }).join('\n')
  assert.ok(!/'发呆'/.test(s), '还有代码把 发呆 当动作名 —— 两套名字会分叉')
})

test('C2 poll.js 的说法表里要有这两个名字（不然她不知道自己刚才在干嘛）', () => {
  const s = readFileSync('{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js', 'utf8')
  assert.match(s, /刷手机:\s*'/, 'poll.js 的 state 说法表没有 刷手机')
  assert.match(s, /玩电脑:\s*'/, 'poll.js 的 state 说法表没有 玩电脑')
})

// ══════════ D 真档防线 ══════════
// T5：自主/状态 每分钟都在被真心跳写，比全文或比 state 都会假红 —— 只比「这一觉的骨架」。
// T5：自主/状态 每分钟都在被真心跳写 —— 真档防线用特征值（沙盒带 `测试标记`）。
test('D1 跑了三轮沙盒，她真档里没有「测试标记」', () => {
  const d = 造盒('家')
  跑(d, ['--试刷手机'])
  rmSync(d, { recursive: true, force: true })
  const 脏 = ['状态.json', '睡眠.json', '睡醒.json'].filter((f) => { try { return readFileSync(join(真档, f), 'utf8').includes('测试标记') } catch { return false } })
  assert.deepEqual(脏, [], '真档被写了：' + 脏.join('、'))
})

test('D2 反向自检：沙盒里真的落了「刷手机」', () => {
  const d = 造盒('家')
  try {
    跑(d, ['--试刷手机'])
    assert.equal(String(读(join(d, '自主.json')).state || ''), '刷手机', '沙盒没写进去 —— env 没生效')
  } finally { rmSync(d, { recursive: true, force: true }) }
})
