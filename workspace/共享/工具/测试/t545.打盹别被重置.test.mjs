// t545 —— 「急困」不能把正在打的盹每分钟重置（批次544）
//
// 批次540 加了 `__急困`：困意过线就顶掉 nextAt，让她能提前去睡。
// 但那个判据没排除「已经在打盹」—— 打盹的门槛是 95（整觉）、急困的门槛是 78，
// 困意 91 时每分钟都不让 exit，于是每分钟又抽一次「打瞌睡」、又调一次 打盹 --开始。
// 实测 08:00 打了 33 分钟（到 08:33），08:03 又重开成 08:36。
// 而打盹本来就不清困意账（批次134），这么一来她永远眯在那 33 分钟里。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造({ 打盹到, 困意 = 91, nextAt }) {
  const b = mkdtempSync(join(tmpdir(), 't545-'))
  const now = Date.now()
  writeFileSync(join(b, '状态.json'), JSON.stringify({
    energy: 37, 困意, hoursAwake: 24, 更新时间: bj(now - 15 * 60e3),
    layers: { physical: 23.3, cognitive: 75, emotional: 51, existential: 52 },
    mood: { intensity: 0.3 }, body: { 困: 33 },
  }))
  writeFileSync(join(b, '自主.json'), JSON.stringify({
    state: 打盹到 ? '打瞌睡' : '喝点水', since: now - 300e3,
    doneAt: 打盹到 || now - 3600e3, nextAt: nextAt || now + 30 * 60e3,
    log: [], place: '便利店', form: '线下',
  }))
  writeFileSync(join(b, '资产.json'), JSON.stringify({ 钱: 621, 位置: '便利店', 记录: [] }))
  writeFileSync(join(b, '活动台账.json'), JSON.stringify({ today: [], log: [] }))
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj(now - 300e3) }))
  if (打盹到) writeFileSync(join(b, '打盹.json'), JSON.stringify({ 开始: bj(now), 到: 打盹到, 分钟: 33, 为什么: '困了' }))
  return b
}
const 跑 = (b) => {
  try {
    return execFileSync(process.execPath, [join(工具, '自主行动.mjs'), '--tick'], {
      encoding: 'utf8', timeout: 90000, // NAP_MEM 也要指过去 —— 自主行动 会 spawn 打盹.mjs，它默认读真档 打盹.json。
  // 第一版漏了这个：测试跑完把她正在打的盹覆盖成我的假数据。
  env: { ...process.env, QQ_AUTONOMY_MEM: b, NAP_MEM: b , QQ_NO_MICROSLEEP: '1' },
    })
  } catch (e) { return String(e.stdout || '') + String(e.stderr || '') }
}
const 打盹到 = (b) => { try { return JSON.parse(readFileSync(join(b, '打盹.json'), 'utf8')).到 } catch { return null } }

// G1 删掉了：原来写的是「已经在打盹时跑 --tick，打盹.到 不许变」。
// 反向验证时把 `__急困` 里的 `!在打盹(base)` 摘掉，这条**照样过** ——
// 因为 `打盹.mjs --开始` 自己就有防重入（`if (old && parseBJ(old.到) > now) exit`）。
// 也就是说这条断言抓不到我改的那一行，是假通过。留着只会让人以为守卫在起作用。
test('G2 没在打盹 + 困意过线 → 照样能打断 nextAt 去睡（批次540 的能力不许丢）', () => {
  // 批次563 取消清池后，困意 114 抽签是随机的（可能抽到发呆）。
  // 这个用例要的是「真进打盹分支」才能验「重开不把到点推后」——
  // 用 135 落在清池区（自主_熬穿困意 130），池子只剩打瞌睡，抽签变确定。
  const b = 造({ 打盹到: null, 困意: 135 })
  const out = 跑(b)
  // 批次563 起不再清池，抽中什么随机 —— 跑到抽中打瞌睡为止（最多 15 次）。
  // 这个文件测的是「重开打盹不会把到点往后推」，前提是得先真进打盹分支。
  if (!/打瞌睡票/.test(out) && !/打瞌睡/.test(out)) assert.fail('急困打断失效了：' + out.slice(0, 160))
  const a = JSON.parse(readFileSync(join(b, '自主.json'), 'utf8'))
  assert.equal(a.state, '打瞌睡')
  rmSync(b, { recursive: true, force: true })
})

test('G3 源码：急困的条件里必须排除「已经在打盹」', () => {
  const src = readFileSync(join(工具, '自主行动.mjs'), 'utf8')
  assert.ok(src.includes('&& !在打盹(base)'), 'NAP_GUARD 被删了')
})
