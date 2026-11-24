// t562 —— 「醒着的起点」只能有一处：睡醒.json 的 since（批次562）
//
// `状态推进.mjs` 有两处从 `睡眠.json.last_sleep.end` 倒推「醒来多久」：
//   · AWAKE_LABEL（决定「刚醒」这个标签挂不挂）
//   · hoursAwake（写进 状态.json，自主行动 / 困意 / 情绪都读它）
// 而 `last_sleep` **只有 endSleep 写**（睡眠阶段.mjs）—— `作息.mjs --醒了` 关段时只写 segments。
//
// 实测 11-16：今天 7 段睡眠全是 `--醒了` 关的，`last_sleep` 停在 11-15 11:40。
// 沙盒对照（先后同一份沙盒、只换脚本）：
//   改后 hoursAwake = 3.00   （since 是三小时前）
//   改前 hoursAwake = 22.11  （last_sleep 停在昨天中午）
// 后果：她一觉醒来就「清醒了 22 小时」——「刚醒」标签永远挂不上、
// 打盹的「最短清醒 3 小时」永远满足（一醒就允许再打盹）、醒来第一秒就被判「醒了超两小时」。
import { test, after } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => readFileSync(p, 'utf8')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
// 心跳每分钟都会写状态，不能用「mtime 没变」判断沙盒有没有漏写。
// 改成检查沙盒里独有的时间戳和 hoursAwake：真漏写时这些值会出现在生产档。
const 沙盒标记 = new Set()
const 沙盒小时 = []

function 沙盒({ since, sleeping = false, lastEnd = '2026-11-15 11:40:01' } = {}) {
  const d = mkdtempSync(join(tmpdir(), 't562-'))
  for (const f of ['状态.json', '资产.json', '饱渴.json']) {
    try { writeFileSync(join(d, f), 读(join(真档, f))) } catch { writeFileSync(join(d, f), '{}') }
  }
  // 状态里不许先带 hoursAwake —— 带了就走不到倒推那条路
  const st = JSON.parse(读(join(d, '状态.json')))
  delete st.hoursAwake
  writeFileSync(join(d, '状态.json'), JSON.stringify(st))
  const 醒点 = since || ''
  if (醒点) 沙盒标记.add(醒点)
  if (lastEnd && lastEnd !== '2026-11-15 11:40:01') 沙盒标记.add(String(lastEnd))
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping, since: 醒点 }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({
    segments: [], records: [],
    last_sleep: lastEnd ? { start: '2026-11-15 05:26:01', end: lastEnd } : undefined,
  }))
  return d
}

function 跑(d) {
  const r = spawnSync(process.execPath, [join(工具, '状态推进.mjs'), '--force'], {
    encoding: 'utf8', timeout: 60000,
    env: { ...process.env, ST_BASE: d, QQ_SLEEP_MEM: d, QQ_AUTONOMY_MEM: d, NAP_MEM: d, QQ_SLEEPY_MEM: d, QQ_HUNGER_MEM: d },
  })
  const st = JSON.parse(读(join(d, '状态.json')))
  if (Number.isFinite(Number(st.hoursAwake))) 沙盒小时.push(Number(st.hoursAwake))
  return { out: String((r.stdout || '') + (r.stderr || '')), st }
}

test('A1 清醒起点只认 睡醒.json 的 since，先于 last_sleep', () => {
  const s = 读(工具 + '/状态推进.mjs')
  assert.ok(s.includes('const 清醒起点 = () =>'), '没有 清醒起点')
  const i = s.indexOf('const 清醒起点 = () =>')
  const 段 = s.slice(i, i + 900)
  assert.match(段, /解析北京\(flag\.since, 0\)/, '没先读 flag.since')
  // 退回 last_sleep 只能在 since 没有的时候（注释里也说清楚了）
  assert.ok(段.indexOf("解析北京(flag.since, 0)") < 段.indexOf('last_sleep'), '顺序反了：先看 last_sleep 再看 since')
})

test('A2 两处（AWAKE_LABEL / hoursAwake）都走同一个来源', () => {
  const s = 读(工具 + '/状态推进.mjs')
  const n = (s.match(/清醒起点\(\)/g) || []).length
  assert.ok(n >= 2, '清醒起点() 只用了 ' + n + ' 处')
  // 去掉注释、并**挖掉 清醒起点 函数体本身**（那里的 last_sleep.end 是 sanctioned 兜底），
  // 再查「还有别的地方从 last_sleep 倒推」。
  const i起 = s.indexOf('const 清醒起点 = () =>')
  const i尾 = s.indexOf('// AWAKE_LABEL', i起)
  assert.ok(i起 > 0 && i尾 > i起, '找不到 清醒起点 的边界')
  const 其余 = (s.slice(0, i起) + s.slice(i尾))
    .split('\n').filter((ln) => !ln.trim().startsWith('//') && !ln.trim().startsWith('*')).join('\n')
  const 违规 = 其余.split('\n').filter((ln) => /last_sleep\?\.end/.test(ln))
  assert.deepEqual(违规.map((x) => x.trim()), [], '这些行还在从 last_sleep.end 倒推：\n' + 违规.join('\n'))
})

test('B1 沙盒：since 三小时前 + last_sleep 停在昨天 → hoursAwake ≈ 3（不是 22）', () => {
  const 三小时前 = bj(Date.now() - (3 * 3600e3 + 7 * 60e3 + 13e3))
  const d = 沙盒({ since: 三小时前, sleeping: false })
  try {
    const { st } = 跑(d)
    const h = Number(st.hoursAwake)
    assert.ok(Math.abs(h - 3) < 0.15, 'hoursAwake = ' + h + '（期望 ~3，旧代码会是 ~22）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B2 沙盒：since 缺失 → 才退回 last_sleep.end（三小时前）≈ 3', () => {
  const 三小时前 = bj(Date.now() - (2 * 3600e3 + 55 * 60e3 + 31e3))
  const d = 沙盒({ since: '', sleeping: false, lastEnd: 三小时前 })
  try {
    const { st } = 跑(d)
    const h = Number(st.hoursAwake)
    assert.ok(Math.abs(h - 3) < 0.15, 'since 缺失时的兜底没生效，hoursAwake = ' + h)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B3 沙盒：睡着时 hoursAwake 必须归零（否则「渴」会拿一整天往睡眠里加）', () => {
  const 十分钟前 = bj(Date.now() - (10 * 60e3 + 13e3))
  const d = 沙盒({ since: 十分钟前, sleeping: true })
  try {
    const { st } = 跑(d)
    assert.equal(Number(st.hoursAwake), 0, '睡着时 hoursAwake = ' + st.hoursAwake)
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// 这一条必须写「刚醒 30 分钟 → 不许摘」。写成「6 小时 → 要摘」是假通过：
// 旧代码算出 22 小时，`>= 2` 同样成立、同样会摘 —— 两边一样，断言抓不住任何东西。
test('B4 沙盒：才醒 30 分钟 → 「刚醒」不许被摘（要 >= 2 小时才摘）', () => {
  const 半小时前 = bj(Date.now() - (30 * 60e3 + 17e3))
  const d = 沙盒({ since: 半小时前, sleeping: false })
  try {
    const st0 = JSON.parse(读(join(d, '状态.json')))
    st0['情绪'] = '刚醒'
    writeFileSync(join(d, '状态.json'), JSON.stringify(st0))
    const { st, out } = 跑(d)
    assert.equal(String(st['情绪'] || ''), '刚醒',
      '才醒 30 分钟「刚醒」就被摘了 —— 旧代码按 last_sleep 算成 22 小时就会这样\n' + out.slice(-200))
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B5 沙盒：醒着 6 小时 → 「刚醒」要摘（另一半，防「永远不摘」）', () => {
  const 六小时前 = bj(Date.now() - (6 * 3600e3 + 11 * 60e3 + 7e3))
  const d = 沙盒({ since: 六小时前, sleeping: false })
  try {
    const st0 = JSON.parse(读(join(d, '状态.json')))
    st0['情绪'] = '刚醒'
    writeFileSync(join(d, '状态.json'), JSON.stringify(st0))
    const { st } = 跑(d)
    assert.equal(String(st['情绪'] || ''), '', '醒了 6 小时还挂着「刚醒」')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// 真档防线：B1~B4 全靠 ST_BASE，漏一个变量就会写她真档。
// 不能拿 mtime 当唯一判据 —— 心跳每分钟都会合法写一次 状态.json。
after(() => {
  const 真文 = ['睡醒.json', '睡眠.json', '状态.json', '自主.json']
    .map((f) => { try { return 读(join(真档, f)) } catch { return '' } }).join('\n')
  for (const 标 of 沙盒标记) assert.ok(!真文.includes(标), '真档出现沙盒时间戳：' + 标)
  const 真状态 = (() => { try { return JSON.parse(读(join(真档, '状态.json'))) } catch { return {} } })()
  const 真醒 = (() => { try { return JSON.parse(读(join(真档, '睡醒.json'))) } catch { return {} } })()
  const 真小时 = Number(真状态.hoursAwake)
  for (const h of 沙盒小时) {
    if (Math.abs(h) < 0.1) {
      if (真醒.sleeping !== true) assert.notEqual(真小时, 0, '真档 hoursAwake 被沙盒写成 0（B3 泄漏）')
      continue
    }
    assert.ok(Math.abs(真小时 - h) > 0.01, '真档 hoursAwake 命中沙盒值 ' + h)
  }
})
