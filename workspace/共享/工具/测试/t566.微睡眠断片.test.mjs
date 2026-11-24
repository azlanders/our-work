// t566 —— 微睡眠：困意爆表之后，行为上得有表现（批次566）
//
// 主人原话（那套设计的第四条）：
//   「100-150 透支，已经进入睡眠债务区域，角色开始出现微睡眠（几秒钟断片）、
//     视线模糊、走路撞墙。150 以上随时可能原地昏倒。」
//
// 我们之前只有数值层面的扣分（熬夜三档认知/情绪），行为上什么都没有 ——
// 困意 150 的她跟困意 20 的她做的事一模一样，只是数字难看。
//
// 这一批只做「断片」：这一轮什么也没做成，几十秒后回神。
// 它是**生理事实**不是她的选择 —— 所以不是「她决定不做事」，是「她想做但断片了」。
// 概率随困意线性涨（100 起、每点 0.6%、封顶 45%）：困得越狠越容易断，但不是必然。
import { test } from 'node:test'
import assert from 'node:assert'
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, rmSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 真档 = '{{BOT_ROOT}}/记忆'
const 读 = (p) => readFileSync(p, 'utf8')
const bj = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

function 沙盒({ 困意 = 60, energy = 50, physical = 60 } = {}) {
  const d = mkdtempSync(join(tmpdir(), 't566-'))
  mkdirSync(join(d, '日志'), { recursive: true })
  // 状态.json 也在复制清单里 —— 下面要读它再改，第一版漏了，三条 B 用例全 ENOENT
  for (const f of ['状态.json', '资产.json', '饱渴.json', '饥饿.json', '卫生.json', '工作.json', '天气.json', '疾病.json']) {
    try { writeFileSync(join(d, f), 读(join(真档, f))) } catch { writeFileSync(join(d, f), '{}') }
  }
  // 占位档清掉 —— 有它们会在「在打盹 / 在吃饭」那几步直接 exit，看不到池子
  for (const f of ['打盹.json', '吃饭.json', '压制.json']) {
    try { unlinkSync(join(d, f)) } catch { /* 本来就没有 */ }
  }
  const st = JSON.parse(读(join(d, '状态.json')))
  st['困意'] = 困意
  st.energy = energy
  st.layers = { ...(st.layers || {}), physical }
  delete st['熬夜']
  delete st['清醒时长']
  writeFileSync(join(d, '状态.json'), JSON.stringify(st))
  writeFileSync(join(d, '睡醒.json'), JSON.stringify({ sleeping: false, since: bj(Date.now() - 6 * 3600e3).slice(0, 16) }))
  writeFileSync(join(d, '睡眠.json'), JSON.stringify({ sleeping: false, live: null, segments: [], records: [], 欠: 0 }))
  writeFileSync(join(d, '自主.json'), JSON.stringify({ state: '待命', since: Date.now(), nextAt: 0, log: [] }))
  const 卫 = JSON.parse(读(join(d, '卫生.json')) || '{}')
  delete 卫['洗澡中']
  卫['清洁'] = 80
  writeFileSync(join(d, '卫生.json'), JSON.stringify(卫))
  return d
}

function 跑(d, extra = []) {
  const r = spawnSync(process.execPath, [join(工具, '自主行动.mjs'), '--dry', ...extra], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, QQ_AUTONOMY_MEM: d, ST_BASE: d, QQ_SLEEP_MEM: d, NAP_MEM: d, QQ_SLEEPY_MEM: d, LOG_PREFIX_OFF: '1' },
  })
  const out = String((r.stdout || '') + (r.stderr || ''))
  const m = out.match(/现在去「(.+?)」/)
  return {
    动作: m ? m[1] : '',
    断片: out.includes('断片'),
    秒: (() => { const x = out.match(/断片 (\d+) 秒/); return x ? Number(x[1]) : 0 })(),
    out,
  }
}

test('A1 概率公式：100 起算、每点 0.8%、封顶 45%（不是靠一个硬阈值）', () => {
  const s = 读(工具 + '/自主行动.mjs')
  assert.ok(s.includes("自主_微睡眠困意线"), '没有困意线参数')
  assert.match(s, /\(__s - __线\) \* Number\(H\('自主_微睡眠斜率', 0\.008\)\)/, '斜率不是 0.008')
  assert.match(s, /Math\.min\(Number\(H\('自主_微睡眠上限', 0\.45\)\)/, '没有上限（会变成必然断片）')
  assert.ok(s.includes('--试断片'), '没有 --试断片 旗标（那就没法验这条分支）')
})

test('A2 断片那一轮什么也不做（不是「换个动作」，是真的没做成）', () => {
  const s = 读(工具 + '/自主行动.mjs')
  const i = s.indexOf("if (pick === '断片')")
  assert.ok(i > 0, '没有断片分支')
  const 段 = s.slice(i, i + 500)
  assert.match(段, /note = '眼皮一沉/, 'note 没写断片')
  // 分支里不许调任何 execFileSync（那就不叫「什么也没做」了）
  assert.ok(!/execFileSync/.test(段), '断片分支里还在执行动作')
})

test('A3 断片只有几十秒，不许落进「15 分钟」那个下限', () => {
  const s = 读(工具 + '/自主行动.mjs')
  // nextAt 要认断片到点
  assert.match(s, /\(pick === '断片' && 断片到点 > Date\.now\(\)\) \? 断片到点/, 'nextAt 没认断片到点')
  // nextMinutes 要按实际秒数覆盖 clamp 的下限
  assert.match(s, /if \(pick === '断片' && 断片到点 > Date\.now\(\)\) \{\s*\n\s*nextMinutes = Math\.max\(1, Math\.round/, 'nextMinutes 还是 15 分钟下限')
  // 输出文案也要说秒，不是「N 分钟后再看情况」
  assert.match(s, /断片 \$\{Math\.max\(1, Math\.round\(\(断片到点 - Date\.now\(\)\) \/ 1000\)\)\} 秒/, '输出没写秒数')
})

test('B1 困意 60（没过线）跑 25 次：一次断片都不许有', () => {
  const d = 沙盒({ 困意: 60 })
  try {
    let 断 = 0
    for (let i = 0; i < 25; i += 1) if (跑(d).断片) 断 += 1
    assert.equal(断, 0, '困意 60 断了 ' + 断 + ' 次 —— 概率公式没生效')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

test('B2 强制断片：时长落在 20~90 秒（不是几分钟也不是 0）', () => {
  const d = 沙盒({ 困意: 60 })
  try {
    const r = 跑(d, ['--试断片'])
    assert.equal(r.动作, '断片', '没进断片分支：' + r.out.slice(-200))
    assert.ok(r.秒 >= 20 && r.秒 <= 90, '断片时长 ' + r.秒 + ' 秒（期望 20~90）')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

// 用 120：断片区是 100~130（130 以上清池去睡，不断片）。
// 第一版写 160，实测 0 次 —— 因为 160 早就清池了，她根本不会去做别的事。
test('B3 困意 120 跑 60 次：会断，但不是每次都断（概率不是 100%）', () => {
  const d = 沙盒({ 困意: 120 })
  try {
    let 断 = 0
    for (let i = 0; i < 60; i += 1) if (跑(d).断片) 断 += 1
    // (120-100)*0.008 = 16%，但断片只覆盖「普通抽签」的轮次（急渴/急饿/该睡都不算），
    // 实测有效概率约 13%，60 次期望 8 次左右。本用例的本意是「有，但不是全部」——
    // 原判据写死 >=2（40 次），尾部概率约 2%，全量跑十几次就会假红一次（批次647 抓到）。
    assert.ok(断 >= 1, '困意 120 断了 0 次 / 60 —— 概率公式没生效')
    assert.ok(断 < 60, '每次都断 —— 上限 45% 没生效')
  } finally { rmSync(d, { recursive: true, force: true }) }
})

const 真档特征 = () => {
  try {
    const st = JSON.parse(读(join(真档, '状态.json')))
    return { 困意: Number(st['困意']), 体力: Number(st.layers?.physical) }
  } catch { return { 困意: NaN, 体力: NaN } }
}
test('B4 真档防线：测试造的特征值（困意 160 / 体力 60）没落进她真档', () => {
  const 后 = 真档特征()
  assert.ok(!(后.困意 === 120 && 后.体力 === 60), '真档出现 t566 的特征值（困意 120 + 体力 60）—— 沙盒变量漏了')
})
