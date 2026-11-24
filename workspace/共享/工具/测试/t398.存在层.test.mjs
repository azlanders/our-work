// 存在层（existential）的事件源测试。批次386。
// A 段：涨存在() 的边界；B 段：学完记一笔() 只记心气、不动认知；C 段：状态推进的静默衰减/回归。
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 沙 = '/tmp/sb398'
const 清 = () => {
  fs.rmSync(沙, { recursive: true, force: true })
  fs.mkdirSync(沙, { recursive: true })
  fs.mkdirSync(沙 + '/日志', { recursive: true })
  fs.mkdirSync(沙 + '/.locks', { recursive: true })
}
const 写状态 = (o) => fs.writeFileSync(沙 + '/状态.json', JSON.stringify(o), 'utf8')
const 读状态 = () => JSON.parse(fs.readFileSync(沙 + '/状态.json', 'utf8'))

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])

const { 涨存在, 学完记一笔 } = await import(工具 + '/_总线.mjs')

// ── A. 涨存在 ──
清()
写状态({ energy: 40, layers: { physical: 40, emotional: 50, cognitive: 60, existential: 49 } })
let r = 涨存在(沙, 0.8)
加('A1 49 +0.8 → 49.8', r.existential, 49.8)
加('A1 真写进盘了', 读状态().layers.existential, 49.8)

清()
写状态({ layers: { existential: 49 } })
加('A2 49 -0.5 → 48.5', 涨存在(沙, -0.5).existential, 48.5)

清()
写状态({ layers: { existential: 49 } })
加('A3 加 0 → 不变', 涨存在(沙, 0).existential, 49)

清()
写状态({ layers: { existential: 94.8 } })
加('A4 上限 95（94.8+0.8）', 涨存在(沙, 0.8).existential, 95)

清()
写状态({ layers: { existential: 10.2 } })
加('A5 下限 10（10.2-0.8）', 涨存在(沙, -0.8).existential, 10)

清()
加('A6 没有状态.json → 从 50 起', 涨存在(沙, 0.8).existential, 50.8)

清()
写状态({ energy: 40 })
加('A7 没有 layers → 从 50 起', 涨存在(沙, 0).existential, 50)

清()
写状态({ layers: { existential: 'abc' } })
加('A8 脏值 → 从 50 起（不是 NaN）', 涨存在(沙, 0).existential, 50)

清()
// 精力由三层（生理/情绪/认知）算，existential 不参与。所以「加 0」和「加 20」两次调用的
// energy 必须相同 —— 不能拿手写的 energy 当基准（手写的和公式算出来的本来就不一致）。
写状态({ layers: { physical: 40, emotional: 50, cognitive: 60, existential: 49 } })
const 能量A = 涨存在(沙, 0).energy
写状态({ layers: { physical: 40, emotional: 50, cognitive: 60, existential: 49 } })
const 能量B = 涨存在(沙, 20).energy
加('A9 返回值带 energy 字段', typeof 能量A, 'number')
加('A10 精力不受存在层影响（+0 和 +20 算出来一样）', 能量A, 能量B)

清()
写状态({ layers: { existential: 49 } })
加('A11 加 NaN → 当 0（不写 NaN）', 涨存在(沙, NaN).existential, 49)

// ── B. 学完记一笔：只记心气，不动认知（批次571 改的语义）──
// 原来这里给 layers.cognitive +1.5（封 95），于是「此刻脑子清不清」和「学到多少」
// 挤在一个数里，实测出现过 cognitive 86.6 高于设计目标 82。
// 现在 cognitive 只表示「此刻清醒度」：醒着只掉、睡着收敛回 82，事件不许往上推。
清()
写状态({ energy: 40, layers: { physical: 40, emotional: 50, cognitive: 60, existential: 49 } })
r = 学完记一笔(沙)
加('B1 认知一点不动（60 还是 60）', r.cognitive, 60)
加('B2 存在 49+0.4 = 49.4', r.existential, 49.4)
加('B3 返回值两样都带', typeof r.cognitive === 'number' && typeof r.existential === 'number', true)
加('B4 真写进盘了：认知没被改', 读状态().layers.cognitive, 60)

清()
写状态({ layers: { cognitive: 94.5, existential: 94.8 } })
r = 学完记一笔(沙)
加('B5 认知 94.5 不会再被顶到 95', r.cognitive, 94.5)
加('B6 存在封顶 95', r.existential, 95)

清()
写状态({})
r = 学完记一笔(沙)
加('B7 空档：存在从 50 起', r.existential, 50.4)
加('B8 空档：不凭空造 cognitive 字段', typeof r.cognitive, 'undefined')

// ── C. 状态推进的漂移（子进程，真跑）──
// 把真实记忆目录的 JSON 复制进沙箱（不带子目录），这样推进脚本能跑起来
const 真 = '{{BOT_ROOT}}/记忆'
for (const f of fs.readdirSync(真)) {
  if (!f.endsWith('.json')) continue
  try { fs.copyFileSync(真 + '/' + f, 沙 + '/' + f) } catch {}
}

const 跑推进 = (静默小时, 初值) => {
  // 每次重置状态里的 existential，避免上一轮污染
  const st = 读状态()
  st.layers = st.layers || {}
  st.layers.existential = 初值
  // 必须是 `YYYY-MM-DD HH:MM`（不带秒）—— 状态推进的 parseBJ 只认这个格式和带 T 的 ISO，
  // 带秒的空格格式两边都不匹配，会回落到 now，hoursAwake 变成 0，stepHours=0，什么都不动。
  st['更新时间'] = new Date(Date.now() + 8 * 3600e3 - 30 * 60000).toISOString().slice(0, 16).replace('T', ' ')
  fs.writeFileSync(沙 + '/状态.json', JSON.stringify(st), 'utf8')

  const 账 = {}
  if (静默小时 !== null) {
    账['private:1'] = { lastIncomingAt: Date.now() - 静默小时 * 3600e3, lastProactiveAt: 0 }
  }
  fs.writeFileSync(沙 + '/proactive.json', JSON.stringify(账), 'utf8')

  const env = {
    ...process.env,
    ST_BASE: 沙,
    QQ_AUTONOMY_MEM: 沙,
    FISH_SANDBOX_DIR: 沙,
    QQ_LOCK_DIR: 沙 + '/.locks',
    QQ_PROACTIVE_FILE: 沙 + '/proactive.json',
    HUNGER_MEM: 沙,
    TEMP_MEM: 沙,
    HJ_BASE: 沙,   // 激素.mjs 认这个，不设它会写真实记忆目录
  }
  const p = spawnSync(process.execPath, [工具 + '/状态推进.mjs'], {
    env, encoding: 'utf8', timeout: 60000,
  })
  let 后 = null
  try { 后 = JSON.parse(fs.readFileSync(沙 + '/状态.json', 'utf8')) } catch {}
  return { 后, 码: p.status, 错: (p.stderr || '').split('\n').slice(0, 2).join(' | ').slice(0, 120) }
}

const c1 = 跑推进(1, 60)
加('C1 刚说过话（1 小时）→ 跑完退出码 0', c1.码, 0)
加('C2 静默 1 小时：60 向 50 回落（<60）', c1.后 && c1.后.layers.existential < 60, true)
加('C3 静默 1 小时：幅度很小（>59）', c1.后 && c1.后.layers.existential > 59, true)

const c2 = 跑推进(24, 60)
加('C4 静默 24 小时：比静默 1 小时更低', c2.后 && c2.后.layers.existential < c1.后.layers.existential, true)

// 一次 tick 只推进 30 分钟，单次衰减只有 -0.03；连跑 4 次（2 小时）看累积。
// 断言值定在 0.1 而不是更大：真实生产是 15 分钟 tick，一天 96 次才 -1.44。
let 连 = 60
for (let i = 0; i < 4; i++) {
  const x = 跑推进(24, 连)
  连 = x.后.layers.existential
}
加('C5 静默 24h 连跑 4 次：累计掉 0.1 以上（衰减真在累积）', 60 - 连 > 0.1, true)

// ★ 回归只在「偏离大」时可见：0.5%/h 在 30 分钟的 tick 上，
//   Ex=70 时变 -0.05（能存成 69.95），Ex=49 时只有 +0.0025（被 2 位小数吃掉）。
//   接近 50 本来就不需要回归，这是死区不是 bug —— 所以断言用 Ex=70 验。
const c4 = 跑推进(1, 70)
加('C7 Ex=70：回归向下（偏离大时才可见）', c4.后 && c4.后.layers.existential < 70, true)

const c3 = 跑推进(24, 44)
加('C6 Ex=44（低于 45）：不衰减，被回归往上拉', c3.后 && c3.后.layers.existential >= 44, true)

const c5 = 跑推进(null, 60)
加('C8 账里没有 lastIncomingAt → 只回归不崩', c5.后 && c5.后.layers.existential < 60, true)

fs.rmSync(沙, { recursive: true, force: true })

let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (实 === 期) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
