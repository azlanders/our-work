// t541 —— 醒了 19.5 小时，困意只算出 34（批次540）
//
// 事故：2026-11-16 07:08，`node 困意.mjs` 打印「困意 34/100（清醒 7.8 小时）」，
// 可她 11-15 11:40 就醒了（`睡醒.json` 的 since 和 `睡眠.json` 末段的 end 都写着 11:40），
// 到那时已经 19.5 小时。
//
// 根因：`睡眠.json` 的 `segments` 累加那一段（批次498 加的，想修「腺苷账被抹掉」）
// **只走 segments 里的段，最后一段 end 之后到「现在」的时间从来没加**：
//   39.19（历史腺苷账） × (1 - 6.23/7.7) = 7.5
// 然后这 7.5 **无条件覆盖**掉前面用 `睡醒.json` 算对的 19.5。
// 腺苷 (7.5-8)*4.5 = 0 → 困意只剩「身体 28」→ 她「身体很累却不困」，
// 一路熬到 energy=4 才被 自动作息 强制睡。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'

const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

function 造盒(wakeMsAgo) {
  const b = mkdtempSync(join(tmpdir(), 't541-'))
  const now = Date.now()
  const wake = bj(now - wakeMsAgo * 3600e3)
  writeFileSync(join(b, '睡醒.json'), JSON.stringify({ sleeping: false, since: wake }))
  writeFileSync(join(b, '睡眠.json'), JSON.stringify({
    records: [],
    segments: [{ start: bj(now - (wakeMsAgo + 6.23) * 3600e3), end: wake, hours: 6.23 }],
    sleeping: false,
  }))
  writeFileSync(join(b, '状态.json'), JSON.stringify({
    energy: 26, 困意: 34, hoursAwake: wakeMsAgo, 更新时间: bj(now - 15 * 60e3),
    layers: { physical: 12.6, cognitive: 83, emotional: 51, existential: 52 },
    mood: { intensity: 0.26 }, body: { 困: 33 },
  }))
  return b
}
const 跑 = (b) => execFileSync(process.execPath, [join(工具, '困意.mjs')], {
  encoding: 'utf8', timeout: 20000, env: { ...process.env, QQ_SLEEPY_MEM: b },
})

test('Q1 醒了 19.5 小时 → 困意必须高（>= 90），不能只剩「身体那 28 分」', () => {
  const b = 造盒(19.5)
  const out = 跑(b)
  const m = out.match(/困意\s*(\d+)\/100/)
  assert.ok(m, '没打印困意：' + out.slice(0, 120))
  const 困 = Number(m[1])
  assert.ok(困 >= 90, `只有 ${困}（原样：${out.split('\n')[0]}）—— 清醒时长没算上「最后一段之后到现在」`)
  assert.equal(/清醒\s*(19|20|21|22|23|24)\.?\d*\s*小时/.test(out), true, '清醒小时数不对：' + out.split('\n')[0])
  rmSync(b, { recursive: true, force: true })
})

test('Q2 刚醒 0.5 小时 → 困意要低（不许把「刚醒」算成熬了一夜）', () => {
  const b = 造盒(0.5)
  const out = 跑(b)
  const 困 = Number(out.match(/困意\s*(\d+)\/100/)[1])
  assert.ok(困 < 55, `刚醒 0.5 小时就有 ${困} 困意 —— 方向反了`)
  rmSync(b, { recursive: true, force: true })
})

test('Q3 熬穿时「困意」字段要跟 熬夜档 一起写，别让面板显示「困意 34 + 档 钝」', () => {
  const b = 造盒(19.5)
  跑(b)
  const st = JSON.parse(readFileSync(join(b, '状态.json'), 'utf8'))
  assert.ok(Number(st.困意) >= 90, '状态.json 的困意没跟着更新：' + st.困意)
  assert.ok(st.熬夜 && st.熬夜.over > 0, '熬夜档没写')
  // 两个字段自洽：over ≈ 困意 - 100
  assert.equal(Math.abs(Number(st.熬夜.over) - (Number(st.困意) - 100)) <= 2, true,
    `困意 ${st.困意} 与 熬夜.over ${st.熬夜.over} 对不上`)
  rmSync(b, { recursive: true, force: true })
})

test('Q4 源码：补「段后到现在」的那一段必须在（删了它就回到 7.8 小时）', () => {
  const src = readFileSync(join(工具, '困意.mjs'), 'utf8')
  assert.match(src, /__累计 \+= Math\.max\(0, \(Date\.now\(\) - __上次止\) \/ 3600e3\)/,
    '「最后一段结束后到现在」那段被删了 —— 清醒时长会退回按段累加')
  assert.match(src, /if \(Number\.isFinite\(__上次止\) && !__sleeping\)/,
    '在睡的时候不该补（清醒时长要冻结）')
})
