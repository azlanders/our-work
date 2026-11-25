#!/usr/bin/env node
// 状态推进.mjs —— 让她的状态跟着时间走，不是「醒来那一下定终身」（2026-11-02）
//
// 用法（cron 每 15 分钟）：
//   node 状态推进.mjs            # 按上次更新到现在过去多久，推进状态
//   node 状态推进.mjs --dry      # 只看会变成什么样，不写
//
// 为什么这么写：
//   · 主人 7 点把她弄醒，12 点还挂着「刚醒，有点懵」——这不是穷，是懒。
//     状态是活的：醒来后精力先回一点、然后随清醒时间往下走，标签也要跟着换。
//   · 推进只做「时间能解释的那部分」：精力、四层能量、心情标签的过渡。
//     心情强度这种由事件决定的东西，不硬编（那是奖惩的事）。
//   · 每次推进写回 `更新时间`，所以重复跑不会叠加——幂等。
import { 睡着, 睡在哪倍率 } from './睡态.mjs'
import { 写档, 解析北京 } from './_底层.mjs'
import { 改 as 改自主 } from './自主状态.mjs'
// OCCUPY 2026-11-07（批次167）：占用态判据只在 占用.mjs 一份
import { 在打盹 } from './占用.mjs'
import { 是歇着, 一次性动作 } from './在干嘛.mjs'
// BUS 2026-11-07（批次207）：「激素 → 情绪基线」的判据唯一在 _总线.mjs
import { 激素偏置, 算情绪轴 } from './_总线.mjs'
import * as 饥饿 from './饥饿.mjs' // HUNGER_ONE 2026-11-14（批次415）：见 __封顶192
// DISEASE 2026-11-07（批次221）：病与体温罚。依赖方向固定：状态推进 → 疾病/体温（它们不反过来读状态推进）
import * as 疾病 from './疾病.mjs'
import * as 体温 from './体温.mjs'
import { readFileSync } from 'node:fs'
// 2026-11-04 修：状态.json 多脚本共写，整份覆盖会丢别人刚写的字段；改合并写入，见 _状态.mjs
import { saveState, clone } from './_状态.mjs'
// RECOVER_CURVE 2026-11-06（批次122）：目标值和恢复曲线统一到 恢复目标.mjs。
// 原来 78/82/70 在这里写一遍，醒着那边又用 0.9×认知当软顶（最高 90），两套上限打架。
import { 体力目标, 睡着后, 精力, 体力封顶 } from './恢复目标.mjs'
// 2026-11-02 参数化：拟人阈值统一从 参数.json 的「拟人」段读，读不到用默认值
import { readFileSync as _rf } from 'node:fs'
let _PJ = {}
try { _PJ = JSON.parse(_rf('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)

// 精力改了之后，这三种「本来就是按精力算」的标签要跟着改；刚醒/困得厉害/睡着各有判据，不动。
function 按精力改标签(s) {
  const lb = String(s.mood?.label || '')
  if (!/^(还算有精神|平常|有点乏)$/.test(lb)) return
  const e = Number(s.energy) || 0
  const want = e >= H('状态推进_精神足', 60) ? '还算有精神' : e >= H('状态推进_有点乏', 35) ? '平常' : '有点乏'
  if (want !== lb) s.mood.label = want
}

import { execFileSync } from 'node:child_process'
import * as 饱渴 from './饱渴.mjs'

// ST_BASE 给测试指沙盒：不然测一次要动她真实的状态文件。
const base = process.env.ST_BASE || '{{BOT_ROOT}}/记忆'
const stP = base + '/状态.json'
const tools = '{{BOT_ROOT}}/共享/工具'
const dry = process.argv.includes('--dry')
// FORCE_FLAG 2026-11-03：--force 跳过「最小推进分钟」限制，醒来/手动调状态时用
const force = process.argv.includes('--force')

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const st = load(stP, {})
const __snap = clone(st)
// JSON 可能被写坏：layers 不是普通对象时重置，避免向字符串等值写入属性。
if (st.layers === null || typeof st.layers !== 'object' || Array.isArray(st.layers)) {
  st.layers = {};
}

// 四个层级字段必须是有限数字，否则各自清零。
for (const key of ['physical', 'cognitive', 'emotional', 'existential']) {
  if (!Number.isFinite(st.layers[key])) {
    st.layers[key] = 0;
  }
}
const now = Date.now()
// 2026-11-02 修：这里存的是北京时间字符串，服务器跑 UTC——必须按 +08:00 解析，
// 否则会算出负数分钟（刚定过一样），推进永远不触发。
const parseBJ = (v) => {
  const t = String(v || '').trim()
  if (t === '') return 0
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t)) return Date.parse(t.replace(' ', 'T') + ':00+08:00')
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(t)) return Date.parse(/(Z|[+-]\d{2}:?\d{2})$/.test(t) ? t : t + '+08:00')
  const n = Number(t)
  return Number.isFinite(n) ? n : 0
}
// PARSE_GUARD 2026-11-04：时间字段解析失败要留痕，别静默当成「现在」（那样推进永远停在 0 分钟）
const __rawUpdated = st['更新时间'] || st.birth?.at
const last = parseBJ(__rawUpdated) || now
if (__rawUpdated && !parseBJ(__rawUpdated)) console.warn('⚠️ 更新时间无法解析：' + String(__rawUpdated).slice(0, 40) + '，已按现在重置')
const mins = Math.max(0, Math.round((now - last) / 60e3))

if (!force && mins < H('状态推进_最小推进分钟', 10)) { console.log(`才过 ${mins} 分钟，不推进`); process.exit(0) }

// —— 1) 读困意（现算，不猜）
let sleepy = null
try {
  const out = execFileSync('/usr/local/bin/node', [tools + '/困意.mjs'], { encoding: 'utf8', timeout: 20000 })
  const m = out.match(/困意\s*(\d+)\/100/)
  if (m) sleepy = Number(m[1])
} catch { /* 读不到就不动困意 */ }

// STRAIN_RELOAD 2026-11-06（批次123）：困意.mjs 熬穿时会扣 cognitive/emotional 并自己写盘，
// 而下面整段用的是开工前读的 st。mergeDiff 的规则是「我改过的键以我为准」，
// 这里恰好要重算 cognitive —— 于是子进程的扣分被父进程手里的旧值盖回去。
// 熬夜惩罚从上线到现在一次都没生效，就是这个原因。重读一次再算。
try {
  const __fresh = load(stP, {})
  if (__fresh && typeof __fresh === 'object') Object.assign(st, __fresh)
} catch { /* 读不到就沿用旧值 */ }

const flag = load(base + '/睡醒.json', {})
// SLEEP_SINGLE_TRUTH 2026-11-04：以 睡眠.json 的 live 为准，标记只当镜像——
// 只信 睡醒.json 会跟自动作息打架（一边当她在睡、一边按醒着扣体力），夜里能把状态扣坏
let __sleep = null
try { __sleep = load(base + '/睡眠.json', {}) } catch { /* 读不到就只看标记 */ }
// 批次164：判据收口。原来这里自己合了一次（标记 || live），和缺口那一派在
// 「endSleep 抛异常、作息只改了标记」时给出相反答案。__sleep 后面还要用，留着。
const sleeping = 睡着(base)
// live 仍在但睡眠标记未同步时，以 live 为准补写在睡状态。
  if (sleeping === true && flag.sleeping !== true) {
    try {
      flag.sleeping = true
      flag.since = flag.since || __sleep.live.start || ''
      flag.自愈于 = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
      写档(base + '/睡醒.json', flag)
      console.log('睡眠标记自愈：以 live 为准写成在睡')
    } catch (error) {
      console.log('睡眠标记自愈失败：' + error.message)
    }
  }

  // live 已清空但睡眠标记仍为真时，将标记恢复为醒着。
  if (sleeping === false && flag.sleeping === true && !(__sleep && __sleep.live)) {
    try {
      flag.sleeping = false
      flag.自愈于 = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')
      写档(base + '/睡醒.json', flag)
      console.log('睡眠标记自愈：live 已清空，标记改回醒着')
    } catch (error) {
      console.log('睡眠标记自愈失败：' + error.message)
    }
  }
const hoursAwake = mins / 60

const before = {
  energy: st.energy,
  label: st.mood?.label,
  layers: { ...(st.layers || {}) },
}

// REST_SCOPE 2026-11-17（批次602）：原来的 `act/resting` 只在「醒着」分支里声明，
// 下面疾病段（:532）却要用 resting —— 作用域根本够不到，改完直接 ReferenceError，
// 被那个 try/catch 吞掉，整段疾病/体温罚都不会执行。提到外层，睡着时保持 false。
let act = ''
let resting = false
if (!sleeping) {
  st.layers = st.layers || {}
  // 醒着：认知仍随清醒时长掉；体力与情绪按「她在干嘛」决定增减
  // REST_RECOVER 2026-11-02：发呆/摸鱼/翻旧账/学东西 是歇着，能回一点；走动/打工 仍在耗
  // SANDBOX 2026-11-06（批次122）：这一行原来写死生产路径，ST_BASE 沙盒里永远读不到
  // 测试的自主状态，resting 恒为 false —— 醒着分支的恢复曲线根本测不到。
  try {
    const __au = JSON.parse(readFileSync(base + '/自主.json', 'utf8'))
    act = __au.state || ''
    // DONE_SHOT 2026-11-16（批次539）：`state` 只是「最近做过什么」的标签，不是「正在做」。
    // 她做完一件几十秒的事（喝点水/吃点东西/拍张照）之后只是待在原地，这条曲线却按
    // 「起身干活」扣 -2.4/h。活动.mjs 那边 批次538 已经改成「待着」不扣了，这里还在扣 ——
    // 同一件事两个账。实测 11-16 凌晨：她在便利店「喝完水站着」两个多小时，physical 12.6，
    // 再待下去会一路掉到 energy=4 才被 自动作息 强制睡。
    // 判据跟 活动.mjs 同一份、同一个 5 分钟门槛：一次性动作 + doneAt 早于 5 分钟前 → 「待着」（= 歇着，回血）。
    const __done = Number(__au.doneAt || 0)
    if (__done > 0 && Date.now() - __done > 5 * 60e3 && 一次性动作.has(act)) act = '待着'
  } catch { /* 忽略 */ }
  // 批次170：哪个 state 算歇着，判据在 在干嘛.mjs。
  // 原来这里、困意.mjs、饱渴.mjs 各有一份，已经开始打架（看B站/逛贴吧 这里按干活扣体力、
  // 困意 按坐着不动攒），而且都是「写的时候手边有哪些 state」列的 —— 加新动作的人不会回来补。
  resting = 是歇着(act)
  const P0 = Number(st.layers.physical ?? 40)
  const C0 = Number(st.layers.cognitive ?? 40)
  const E0 = Number(st.layers.emotional ?? 45)
  const Ex0 = Number(st.layers.existential ?? 50)
  const hourNow = Number(new Date(Date.now() + 8 * 3600e3).toISOString().slice(11, 13))
  const night = hourNow >= 23 || hourNow < 6 ? 1 : 0
  // NUMFIX 2026-11-04（kimi k3.1-pro 出码）：夜间阶跃 → 连续睡眠压力；清醒恢复软顶跟认知挂钩
  const awakeTotal = Number(st.hoursAwake || 0) + hoursAwake
  const sleepPressure = Math.min(1, awakeTotal / 24)
  // RECOVER_CAP 2026-11-06（批次122）：体力软顶原来只跟认知走（0.9×C0，最高 90），
  // 而睡眠那边以 78 为目标 —— 认知一高，白天歇着就能把体力顶到 89，睡醒再融合一次更过。
  // 软顶不高于设计目标。
  const head = Math.max(1, Math.min(体力目标, 0.9 * C0))
  // TUNE 2026-11-04（kimi 网格搜索）：恢复 5.0→8.0、非休息 1.8→2.4，白天回得动、晚上仍会掉
  // NAP_RECOVER 2026-11-06（批次134）：打盹是浅睡，比「歇着」回得快，但不进整觉的账。
  // 每小时体力 +18 / 认知 +12：20~40 分钟回 6~12 点，够撑到晚上，不足以当一觉。
  // 不写 睡醒.json 就是为了这个 —— 写了会把一夜的清醒时长清零。
  // OCCUPY 2026-11-07（批次167）：判据在 占用.mjs —— 跟 睡态.打盹中 同一份
  // （先看 `到毫秒`，退回 `到`）。原来这里是第四份实现，而且只读到分，比 到毫秒 粗几十秒。
  const __napping = 在打盹(base)
  // 2026-11-07 主人：「其他的也根据这个改改」——消耗跟着 饱渴.倍率() 走，
  // 站柜台 1.25 就是比静着多一点点，跑起来才翻倍；不再所有非休息一律 -2.4。
  const 活动倍 = (() => { try { return Number(饱渴.倍率()) || 1 } catch { return 1 } })()
  // COMFORT（批次564）：**打盹也要有舒适度。** 整觉那边在 tickSleep 里按分钟乘，
  // 打盹没有 tick（只有 打盹.json 的到点），回血全在这一处按小时给 ——
  // 判据同样问 睡态.睡在哪倍率，不在这个文件里另写一张表。
  const __盹舒适 = (() => { try { return Number(睡在哪倍率(load(base + '/资产.json', {}).位置)) || 1 } catch { return 1 } })()
  // LEDGER 2026-11-17（批次687）：干活/守店的体力原来被扣两遍 ——
  // 活动.mjs 每 30 分钟按实际在岗扣 -5 / -2.5，这里又按 饱渴.倍率（打工 1.8）× -2.4/小时 再扣一遍，
  // 8 小时合计约 -114。40 分钟内有过打工/值班的活动账，就认定体力归活动账本管：
  // 这里只留睡眠压力和夜里那点，不再乘活动倍率。判据读 活动台账.json，不另造一份状态。
  const __活动接管 = (() => {
    try {
      const log = load(base + '/活动台账.json', {}).log || []
      const last = log[log.length - 1]
      if (!last) return false
      if (!/打工|值班|干活|守店/.test(String(last.kind || '') + String(last.活动 || ''))) return false
      const t = Date.parse(String(last.at || '').replace(' ', 'T') + ':00+08:00')
      return Number.isFinite(t) && Date.now() - t <= 40 * 60e3
    } catch { return false }
  })()
  const dPhys = __napping
    ? 18 * __盹舒适
    : resting
      ? 8.0 * Math.max(0, (head - P0) / head) - 2.4 * sleepPressure - 0.8 * night
      : __活动接管
        ? -2.4 * sleepPressure - 0.8 * night
        : -2.4 * 活动倍 - 2.4 * sleepPressure - 0.8 * night
  const dCog = __napping ? 12 * __盹舒适 : (resting ? -0.8 : -1.6)
  // 2026-11-04 修：这套消耗/恢复是按「每小时 tick 一次」标定的，但停机几小时后
  // 第一个 tick 的 hoursAwake 会是整个停机时长，一次性乘上去就会把体力/认知打到底。
  // 实测（沙盒造 12 小时空档）：体力 40 → 0、精力 39 → 3，人会「一重启就虚脱」。
  // 单步最多按 2 小时算；累计清醒时长 hoursAwake 仍按真实值累加，不虚报休息。
  const stepHours = Math.min(hoursAwake, 2)
  // HORMONE_BASE 2026-11-07（批次207）：激素反哺情绪基线 —— 多巴胺高+皮质醇低 +2，
  // 皮质醇高压 -3（判据唯一在 _总线.mjs）。只动「收敛目标」，不手算精力公式。
  const __hb = (() => { try { return 激素偏置(base).情绪基线 } catch { return 0 } })()
  const eBase = 55 + 0.15 * (Ex0 - 50) + __hb
  // EMO_EXACT 2026-11-04：用指数回归，漏跑几个小时也不会冲过基线再反弹
  st.layers.physical = Math.max(0, Math.min(100, P0 + stepHours * dPhys))
  st.layers.cognitive = Math.max(0, Math.min(100, C0 + stepHours * dCog))
  st.hoursAwake = awakeTotal // 睡眠压力要按累计清醒算，睡醒时由作息脚本清零
  st.layers.emotional = Math.max(0, Math.min(100, eBase + (E0 - eBase) * Math.exp(-0.25 * stepHours)))
  // EXI_DRIFT 2026-11-14（批次386）：existential 从来没有推进逻辑 —— 它唯一的写方
  // 奖惩.mjs:232（条件 `if (k.存在能量)`）随 认事.mjs 在批次63 一起停用了，
  // 这个值从 11-04 冻在 49（状态变更.log 26 行全是 physical，它零命中）。
  // 事件那一半在 涨存在()/学完记一笔() 里，这里只补「时间」这一半：
  //   ① 超过 18 小时没人跟他说话 → 每小时 -0.06，且只在 Ex > 45 时生效（别被打穿）
  //   ② 其余时间向 50 缓慢回归 0.5%/h（时间常数约 8 天，只在偏太远时起作用）
  // 用 stepHours 而不是 hoursAwake：跟上面三层一致，停机后不一巴掌打到底。
  {
    let 静默小时 = 0
    try {
      const 账路 = process.env.QQ_PROACTIVE_FILE || '{{DSH_ROOT}}/qq-bridge-proactive.json'
      const 账 = JSON.parse(readFileSync(账路, 'utf8')) || {}
      const 们 = Object.values(账).map((v) => Number(v && v.lastIncomingAt) || 0).filter((x) => x > 0)
      const 上 = 们.length ? Math.max(...们) : 0
      if (上 > 0) 静默小时 = Math.max(0, (now - 上) / 3600e3)
    } catch { /* 账读不到就只走回归，不衰减 */ }
    let Ex1 = Ex0
    if (静默小时 > 18 && Ex1 > 45) Ex1 -= 0.06 * Math.min(stepHours, 静默小时 - 18)
    Ex1 += (50 - Ex1) * 0.005 * stepHours
    // 2 位小数：回归 0.5%/h 在 15 分钟的 tick 上只有 0.0125，存 1 位会被四舍五入吃掉
    st.layers.existential = Math.max(10, Math.min(95, Math.round(Ex1 * 100) / 100))
  }
  st.energy = 精力(st.layers)   // 批次171：合成公式只在 恢复目标.mjs 一处

} else {
  // SLEEP_ENERGY_FIX 2026-11-04：睡着原来只回生理情绪、认知不动，熬久了认知归零就永远回不来；
  // 总精力也还走「两数平均」，和醒着的木桶公式不一致。这里三件事一起补上。
  st.layers = st.layers || {} // 保留原状态结构，仅用阻尼回血避免长时间睡眠后顶格
  // SLEEP_LOW_AROUSAL 2026-11-16（批次573）：睡着时唤醒一定低。
  // 不写的话 `状态.json` 里那个初始值 arousal:1（= 极度唤醒）会一直挂到醒来 ——
  // 跟「睡着」自相矛盾，谁看面板都会以为出错了。
  st.mood = st.mood || {}
  // 直接赋值，不做平滑：睡着就是「一下子松下来」，不是逐渐放松。
  // （第一版用了 ×0.3 的平滑，结果一次 tick 只从 1 降到 0.736，要跑五次才像睡着 —— 写复杂了。）
  st.mood.arousal = 0.12
  st.mood.drive = "calm"
  const SP = Number(st.layers.physical ?? 40) // 从当前体力计算目标差距，用阻尼让恢复量随差距缩小
  const SE = Number(st.layers.emotional ?? 45) // 从当前情绪计算目标差距，用阻尼替代固定速率回血
  const SC = Number(st.layers.cognitive ?? 40) // 从当前认知计算目标差距，用阻尼避免线性恢复过度
  // RECOVER_CURVE 2026-11-06（批次122）：原来这三行是线性式子，只在「每次推进都 1 小时」时
  // 才对得上；停机一阵后的第一个 tick 会把小时数一次乘满 —— 实测体力 11.5 直接顶到 100。
  // 换成指数（恢复目标.mjs 的 睡着后），分几次跑结果一样，再长的间隔也不会越过去。
  // HUNGER_CAP+SLEEP_DEBT 2026-11-07（批次192）：睡着的体力收敛目标带上欠觉/饿的封顶。
  // 欠由 睡眠阶段 endSleep 唯一结算，这里只读；读不到就按没有欠（= 原体力目标 78）。
  const __封顶192 = (() => {
    try {
      // HUNGER_ONE 2026-11-14（批次415）：`饥饿.json.饱腹` 是死字段（停在 55），
      // 这里判「饿不饿」的输入是常数 = 从来没生效。改问 饥饿.饿着()（现算）。
      return 体力封顶(Number((load(base + '/睡眠.json', {}) || {})['欠'] || 0), 饥饿.饿着(10))
    } catch { return 体力封顶(0, false) }
  })()
  // STRAIN_CAP 2026-11-16（批次568）：连续熬夜把「睡着后的目标」压低（82→70 / 55→47）。
  // 账由 睡眠阶段.endSleep 结算，这里只读 —— 判据与上限都只有 恢复目标.mjs 一份。
  const __熬账 = (__sleep && typeof __sleep === 'object' && __sleep['熬夜账']) || null
  const 恢复 = 睡着后({ physical: SP, cognitive: SC, emotional: SE }, hoursAwake, __封顶192, __熬账)
  st.layers.physical = 恢复.physical
  st.layers.cognitive = 恢复.cognitive
  st.layers.emotional = 恢复.emotional
  st.energy = 精力(st.layers) // 批次171：合成公式只在 恢复目标.mjs 一处（阻尼只改层级回血速度）
}

// AWAKE_FROM_FLAG 2026-11-16（批次562）：**「醒着的起点」只有一处权威 —— 睡醒.json 的 since。**
//
// 下面 AWAKE_LABEL 和 372 行那两处原来都从 `睡眠.json.last_sleep.end` 倒推，
// 而那个字段**只有 endSleep 写**（`睡眠阶段.mjs`）——`作息.mjs --醒了` 关段时只写 segments。
// 实测 11-16：今天 7 段睡眠全是 `--醒了` 关的，`last_sleep` 停在 11-15 11:40，
// 于是她一觉醒来「清醒时长」就是 **22 小时**：
//   · 「刚醒」这个标签永远挂不上（要 < 2 小时）
//   · `自主行动` 的「打盹最短清醒 3 小时」永远满足 → 一醒就允许再打盹
//   · 醒了超过两小时就把 st.情绪 里的「刚醒」清掉 —— 醒来第一秒就被清
// 醒着的起点本来就只有一处：`作息 --醒了` 写 `flag.since`，`--想睡` 也写它（那时是睡下的时刻，
// 但清醒时长只在 `!sleeping` 时用，所以取到的必然是「醒来那一刻」）。
const 清醒起点 = () => {
  const a = 解析北京(flag.since, 0)
  if (a > 0) return a
  // 标记不在（首次运行 / 文件被删）才退回 last_sleep.end
  try {
    const sj = JSON.parse(readFileSync(base + '/睡眠.json', 'utf8'))
    const end = String(sj?.last_sleep?.end || '')
    const m = end.match(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/)
    return m ? Date.parse(end.slice(0, 16).replace(' ', 'T') + ':00+08:00') : 0
  } catch { return 0 }
}

// AWAKE_LABEL 2026-11-04：判断「刚醒」要按醒来多久，不能按这次推进间隔（每 15 分钟一次，永远到不了 60 分钟）
const awakeMinForLabel = (() => {
  const ms = 清醒起点()
  return ms > 0 ? Math.max(0, (Date.now() - ms) / 60e3) : 0
})()

// AUT_SLEEP 2026-11-04：睡着时把自主状态也对齐成「睡觉」，别让底层还挂着「发呆」
// 批次169：改走 自主状态.改()（锁内 + 原子写）。原来是裸 writeFileSync：
// 进程正好在那一刻断掉，落盘就是半截 JSON，state/since/log 一起没。
try {
  const __since = Date.parse(String(flag.since || '').replace(' ', 'T') + ':00+08:00')
  改自主(base, (aut) => {
    if (sleeping) {
      if (String(aut.state || '') === '睡觉') return false   // 已经对齐，不重复写
      aut.state = '睡觉'
      aut.since = Number.isFinite(__since) ? __since : Date.now()
      aut.note = '睡着了'
    } else {
      if (String(aut.state || '') !== '睡觉') return false
      aut.state = '待命'
      aut.since = Date.now()
      aut.note = '醒了'
    }
  })
} catch { /* 自主状态写不进去不影响推进 */ }

// —— 2) 标签过渡：刚醒的标签只留一小时
st.mood = st.mood || {}
if (/刚醒/.test(String(st.mood.label || '')) && awakeMinForLabel >= H('状态推进_刚醒分钟', 60)) {
  st.mood.label = st.energy >= H('状态推进_精神足', 60) ? '还算有精神' : st.energy >= H('状态推进_有点乏', 35) ? '平常' : '有点乏'
}
// 夜里熬到困意高，标签也该说实话
if (sleepy !== null && sleepy >= H('状态推进_困得厉害', 78) && !sleeping) st.mood.label = '困得厉害了'
// SLEEPY_LABEL 2026-11-06（批次134）：78 才挂「困得厉害了」，可她 71 时已经撑不住 ——
// 困意在 poll.js 里只当「开不开口」的门槛，她自己看不到。加一档「有点困」，
// 她读到标签才知道该歇（判断权在她：系统只递事实，睡不睡她自己定）。
else if (sleepy !== null && sleepy >= H('状态推进_有点困', 60) && !sleeping && !/困/.test(String(st.mood.label || ''))) st.mood.label = '有点困'
// TIRED_LABEL 2026-11-04：困意降下来后别一直挂着「困得厉害了」
if (!sleeping && /困得厉害/.test(String(st.mood.label || '')) && (sleepy === null || sleepy < H('状态推进_困得厉害', 78))) {
  st.mood.label = st.energy >= H('状态推进_精神足', 60) ? '还算有精神' : st.energy >= H('状态推进_有点乏', 35) ? '平常' : '有点乏'
}
if (sleeping) st.mood.label = '睡着'
// BODY_SYNC 2026-11-03：醒着却还挂着「睡着」标签——原来只有「刚醒超过一小时」才会换标签，
// 睡着→醒着这一步没人管，于是醒来后一直显示「睡着」跟「刚醒」打架。
if (!sleeping && /睡着/.test(String(st.mood.label || ''))) {
  st.mood.label = st.energy >= H('状态推进_精神足', 60) ? '还算有精神' : st.energy >= H('状态推进_有点乏', 35) ? '平常' : '有点乏'
}
// LABEL_DRIFT 2026-11-05（批次103）：上面四条只在「刚醒过期 / 困意过线 / 睡着→醒」时换标签。
// 白天精力从 70 一路掉到 13，标签还挂着早上那句「还算有精神」——
// 于是提示里出现「精力 13/100，心情「还算有精神」」，她自己也照这句说。
// 这里只修三种「本来就是按精力算出来的」标签，让它们跟着精力回落；
// 刚醒 / 困得厉害了 / 睡着 各有各的判据，不在这条里动。
按精力改标签(st)

// HORMONE_MOOD 2026-11-05：激素是底色，心情是当下。
// 原来两者只共享事件：激素升了，mood 该往哪偏没人管，等于「身体」和「心情」两张皮——
// 她可能皮质醇很高还挂着「还算有精神」，也可能多巴胺满格却写着「有点乏」。
// 这里只做一件事：给 mood.intensity 一个「朝哪儿回落」的目标，让它慢慢靠过去。
//   · 多巴胺高 → 往正；催产素高 → 往正；皮质醇高 → 往负；GABA 低（静不下来）→ 往负。
//   · 上限只给 ±0.35（mood 本身 ±2），速度 6%/次（15 分钟一次，约 4 小时收敛）。
//     这么慢是故意的：奖惩刚给的 ±1 得留得住，激素只决定它最后落回哪儿，不抢当下的戏。
if (!sleeping) {
  try {
    const __hj = JSON.parse(readFileSync(base + '/激素.json', 'utf8'))
    const __偏 = (k, b0) => {
      const v = Number(__hj?.v?.[k])
      const b = Number(__hj?.B?.[k] ?? b0)
      if (!Number.isFinite(v) || !Number.isFinite(b)) return 0
      return Math.max(-1, Math.min(1, (v - b) / Math.max(1, 100 - b)))
    }
    const __底 = Math.max(-1, Math.min(1,
      0.45 * __偏('dopamine', 45)
      + 0.30 * __偏('oxytocin', 40)
      - 0.50 * __偏('cortisol', 25)
      + 0.15 * __偏('gaba', 50)))
    const __目标 = 0.35 * __底
    const __cur = Number(st.mood.intensity) || 0
    st.mood.intensity = Math.max(-2, Math.min(2, Number((__cur + (__目标 - __cur) * 0.06).toFixed(3))))
    // MOOD_AXES 2026-11-16（批次573）：valence / arousal / drive 三个字段一直是死的 ——
    // poll.js 的「心 X」永远 50、驱动永远 calm、outbound 的打字停顿分支从没跑过。
    // 判据在 _总线.算情绪轴 一处；这里只做平滑 + 落盘。
    // 两个速度**不一样**：
    //   · valence 慢（0.10）：心情有惯性，不该被一次事件甩到底。
    //   · arousal **直接赋值**：它反映的是「此刻身体绷不绷」，不该有惯性 ——
    //     肾上腺素的半衰期只有 21 分钟，而 状态推进 是 15 分钟一拍；
    //     用 0.35 的平滑，一次 tick 只走到目标的 35%，要一小时才追上「刚吵完架」，
    //     那时架早吵完了（t573 D3 实测：0.073，比 0.1 的门槛还低）。
    try {
      const __轴 = 算情绪轴(__hj)
      const __滑 = (旧, 新, 速) => Number(((Number(旧) || 0) + (新 - (Number(旧) || 0)) * 速).toFixed(3))
      st.mood.valence = __滑(st.mood.valence, __轴.valence, 0.10)
      st.mood.arousal = __轴.arousal
      st.mood.drive = __轴.drive
    } catch { /* 算不动就保持原值 */ }
  } catch { /* 没有激素文件就保持现状 */ }
}

// DREAM_MOOD 2026-11-05：梦里带出来的那点情绪，早上要留得住。
// 原来是两套东西：梦写梦的文件，状态算状态的心情，醒来心情永远跟昨天一样。
// 现在只在醒来后第一次推进时用一次——好梦把心情抬 0.2，坏梦压 0.2，然后标记已用。
// 之所以要「一次」：一个梦不该管她一整天，那点余味只该是起床时的底色。
if (!sleeping) {
  try {
    const __dp = base + '/梦余味.json'
    const __d = JSON.parse(readFileSync(__dp, 'utf8'))
    const __today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    if (__d && __d.date === __today && __d.已用 !== true) {
      const __偏 = __d.好 ? 0.2 : -0.2
      const __cur = Number(st.mood.intensity) || 0
      st.mood.intensity = Math.max(-2, Math.min(2, Number((__cur + __偏).toFixed(2))))
      __d.已用 = true
      写档(__dp, __d)
    }
  } catch { /* 没梦就跳过 */ }
}

// BODY_SYNC：身体感受原来是个死字段（困 2、渴 1 挂了很久没人写），改成每次按真实状态重算：
// 困 = 困意；渴 = 按清醒时长累积；累的那种痒 = 体力低才会痒；说不清的不舒服 = 熬夜或情绪低。
try {
  // AWAKE_HOURS_FIX 2026-11-03：原来读「清醒时长」，可这个字段根本没人写（一直是 undefined），
  // 于是渴永远是 0。改成用「上次睡醒的结束时间」倒推，醒来多久就是多久。
  let __awakeH = Number(st['清醒时长'])
  if (!Number.isFinite(__awakeH) || __awakeH <= 0) {
    // AWAKE_FROM_FLAG（批次562）：跟上面 AWAKE_LABEL 同一个来源，别再从 last_sleep 倒推。
    const __ms = 清醒起点()
    __awakeH = __ms > 0 ? (Date.now() - __ms) / 3600e3 : 0
  }
  // SLEEP_AWAKE_FIX 2026-11-05：睡着的时候清醒时长归零，否则「渴」会拿一整天的清醒时长
  // 往睡眠里加，睡一觉起来渴还是 100（主人在调试页看到的就是这个）
  const hoursAwake = sleeping ? 0 : Math.max(0, Math.min(24, Number(__awakeH) || 0))
  st.hoursAwake = hoursAwake   // 顺手把这个字段维护起来，别再让它一直是脏值
  // 醒了超过两小时就别再挂着「刚醒」了
  if (hoursAwake >= 2 && String(st['情绪'] || '') === '刚醒') st['情绪'] = ''
  const physical = Number(st.layers?.physical ?? 45)
  const emotional = Number(st.layers?.emotional ?? 45)
  // STRAIN_SHAPE 2026-11-04：strain 里根本没有「强度」字段（只有 over/认知扣/情绪扣/档），
  // 原来取 .强度||1 等于恒为 1，熬夜后「不舒服」永远只算 30。改成按档位换算。
  const 熬夜档 = (() => {
    const su = st['熬夜']
    if (!su) return 0
    const d = String(su['档'] ?? '')
    if (d === '崩') return 3
    if (d === '重') return 2
    if (d === '钝') return 1
    return Number(su.over ?? 0) > 20 ? 2 : 1
  })()
  const b = st.body && typeof st.body === 'object' ? st.body : {}
  // SLEEPY_SHOW 2026-11-16（批次564）：**睡觉时困意要实时显示。**
  // 原来这一行是 `sleeping ? 0 : …` —— 她一整夜面板上都写着「困 0」，
  // 主人要的是「困意值也要在睡觉的时候实时显示」。
  // 睡着时这个值由 睡眠阶段.tickSleep 每分钟往下减（N2 -0.15/分、N3 -0.45/分），
  // 所以读 state 的「困意」就是当下真实值，不该在这里抹掉。
  b['困'] = Math.max(0, Math.min(100, Math.round(sleeping ? Number(st['困意'] ?? 0) : (sleepy ?? Number(st['困意'] ?? 0)))))
  // THIRST_TIME 2026-11-04：睡着时渴的衰减按经过时间算，别按「跑了几次」算
  // THIRST_SLEEP 2026-11-04：睡着时渴不该越睡越归零（原来按 0.6 每次衰减），改成缓慢上升
  // 睡着时渴不动（睡着的人不喝水，也不该继续涨）；醒着按清醒时长算
  // THIRST_DRINK 2026-11-07（主人原话「口渴还是95 出bug了吗」）：渴原来是拿清醒时长硬算的，
  // 不管喝没喝水都照样涨——喝一整瓶也还是 95，等于没这条路。改成从「上次喝水」那一刻起算。
  // 喝水由 物品.mjs 落一笔 记忆/喝水.json；没这记录就退回按清醒时长算。
  // THIRST_GONE 2026-11-14（批次434）：上面这条已经是历史 —— 渴退休了，这条链路整段作废，
  // 物品.mjs 那边的写入也摘了、文件删了。留着这段注释只是为了让「为什么删」可查。
  // THIRST_RETIRE 2026-11-07（主人原话「身体和心情的那个渴可以退休了」）：渴单独立了一条，
  // 身体这层直接把它删掉，免得同一件事看见两套数。
  delete b['渴']
  // WEAK_HUNGER 2026-11-07：老是吃不饱会把体力上限往下压（最多压 25 点），睡够也补不回来。
  try {
    const 虚 = 饱渴.虚弱(Date.now())
    if (虚 > 0 && st.layers && Number.isFinite(Number(st.layers.physical))) {
      const 顶 = 100 - Math.round(虚 * 25)
      if (Number(st.layers.physical) > 顶) st.layers.physical = 顶
      st["虚弱"] = 虚
    } else if (st["虚弱"]) delete st["虚弱"]
  } catch (_err) { console.error('[状态推进]', _err?.message || _err) }

  // MOOD_HUNGER 2026-11-07：饱腹感即时影响情绪、千卡长期影响底色，一次只挪一点点，别让面板跳。
  //
  // MOOD_SCALE 2026-11-08（批次263）：这条挪动量原来把整个情绪系统压死了 —— 实测她
  // 情绪从 42.5 掉到 19.4，睡 8 小时都上不来，就是因为这里。
  //
  // 算一下就清楚：这个函数 15 分钟跑一次。
  //   · 醒着向基线收敛：每轮 1-exp(-0.25*0.25) ≈ 6.1%，离基线 10 点才挪 0.6 点；
  //     睡着更慢，每轮 1-exp(-0.06*0.25) ≈ 1.5%，离基线 10 点只挪 0.15 点。
  //   · 而这里的挪是 ±2/轮 ＝ ±8/小时，比收敛强 5~13 倍，还常年贴在下限（有点饿就是 -1.24）。
  //   结果：只要她不是全饱，情绪就被按在 22 上下，睡多久都回不来。
  //
  // 两处改：
  //   ① 按小时折算 —— 原来写的是「一次只挪一点点」，那就该是 ±2/小时（±0.5/轮），不是 ±2/轮。
  //   ② 睡着不挪 —— 睡觉这段时间只做「向基线收敛」，这才是「睡一觉把情绪摊平一点」的本意；
  //      睡着了还在为饿不饿扣分，等于一觉白睡。
  try {
    const 修 = 饱渴.心情修正(Date.now())
    if (!sleeping && st.layers && Number.isFinite(Number(st.layers.emotional))) {
      const 挪 = Math.max(-0.5, Math.min(0.5, 修.即时 * 0.15 + 修.长期 * 0.1))
      // LOG_MOOD 2026-11-08（批次262）：把这一轮的心情挪动量留给下面那行日志。
      // 情绪从 42.5 掉到 19.4 查了半天算不出来，就是因为日志只打认知/生理，
      // 情绪这条线在日志里完全看不见。用 globalThis 传是为了不跨作用域改结构。
      try { globalThis.__心情挪 = 挪 } catch (_err) { console.error('[状态推进]', _err?.message || _err) }
      st.layers.emotional = Math.max(0, Math.min(100, Math.round((Number(st.layers.emotional) + 挪) * 10) / 10))
    }
  } catch (_err) { console.error('[状态推进]', _err?.message || _err) }

  b['累的那种痒'] = Math.max(0, Math.min(100, Math.round((48 - physical) * 2)))
  b['说不清的不舒服'] = 熬夜档 > 0 ? Math.min(100, 20 + 熬夜档 * 10) : emotional < 30 ? 20 : 0
  st.body = b
} catch { /* 算不出来就保持原样 */ }

// —— 3) 熬夜惩罚接上（困意超 100 由 困意.mjs 自己写；这里只补 100 以内的累）
// SLEEPY_OWNER_FIX 2026-11-24（批次691）：睡着时 `困意` 归 睡眠阶段.tickSleep 管（每分钟
// N2 -0.15 / N3 -0.45）。困意.mjs 自己守着这条规矩（`if (!__sleeping) st.困意 = sleepy`），
// 但这里没守 —— 睡着时拿 困意.mjs 的静态值无条件盖回去，把分钟级衰减整块抹掉。
// 实测：34 → 0（tickSleep 补算）→ 18（这里抬回）→ 18，睡眠期间面板困意来回跳。
if (sleepy !== null && !sleeping) st['困意'] = sleepy
st['更新时间'] = new Date(now + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

// ── DISEASE_TEMP 2026-11-08（批次222）────────────────────────
// 疾病值 0-1000：常驻 -8/小时，恶劣条件往上推；到 600 得病、800 加重（不是概率抽卡）。
// 体力上限改成「比例相乘 + 加法项」：病/虚弱按比例压（不会互相叠加成 50），
// 熬夜、失温/中暑、极低情绪是加法。病重 100% 时上限砍一半 —— 40 度确实动弹不了。
try {
  const __t = Date.now()
  const __温读 = 体温.读(__t)
  const __环 = 体温.区域温度(__t)
  const __快照 = {
    体温: __温读.体温,
    体感: Number((__温读.体感 || {}).值 ?? 23),
    雨: !!__环.雨,
    风折: Number(__环.风折) || 0,
    熬夜: !!(st.熬夜 && (st.熬夜.档 || Number(st.熬夜.over) > 0)),
    虚弱: 饱渴.虚弱(__t),
    卡百分比: 饱渴.读(__t).卡百分比,
  }
  if (!dry) {
    // REST_FIX 2026-11-17（批次602）：第 4 个参数是「歇着」，原来恒传 0 ——
    // 她在家躺一天，疾病值仍按 -8/h 走，歇着的 -10/h 从来没生效。resting 在外层 :151 定义。
    疾病.累(__快照, __t, sleeping ? 1 : 0, resting ? 1 : 0)
    const __中 = 疾病.判(__快照, __t, false)
    // SICK_HORMONE 2026-11-08（批次224）：发病那一下发一次「生病」，不是每轮刷。
    // 用日期+病名做 id，同一场病只记一次。
    if (__中 && __中.中 && !__中.加重) {
      try {
        const __id = '生病-' + new Date(__t + 8 * 3600e3).toISOString().slice(0, 10) + '-' + String(__中.病 || '')
        execFileSync('/usr/local/bin/node', [tools + '/激素.mjs', '--event', '生病', '--id', __id], { encoding: 'utf8', timeout: 8000 })
      } catch { /* 激素失败不影响推进 */ }
    }
    疾病.推进(__t)
  }
  const __病 = 疾病.读(__t)
  if (__病.重 > 0) st.layers.emotional = Math.max(0, Number(st.layers.emotional) - __病.重 * 0.20)
  // 批次613：把「其中有多少是发烧」传进档位 —— 39 度的发烧封顶在「很热」（罚 2），
  // 不再按「中暑」（罚 3）扣体力上限；心情罚下面还有一层病理热减半。
  const __档 = 体温.档(__温读.体温, __病.发烧偏移) || {}
  const 罚 = Number(__档.罚) || 0
  const 病理热 = __病.发烧偏移 > 0.2 && __温读.体温 >= 37.5
  // 体温心情罚（和上限分开算）
  if (罚 >= 3) st.layers.emotional = Math.max(0, Number(st.layers.emotional) - (病理热 ? 0.2 : 0.4))
  else if (罚 >= 2) st.layers.emotional = Math.max(0, Number(st.layers.emotional) - (病理热 ? 0.1 : 0.2))
  // ── 体力上限：比例 × 加法 ──
  let 比例 = 1
  if (__病.重 > 0) 比例 *= (1 - __病.重 * 0.5)
  const 虚 = Math.max(0, Number(st['虚弱']) || 0)
  if (虚 > 0) 比例 *= (1 - Math.min(0.4, 虚 * 0.25))
  let 加法 = 0
  const 熬档 = String((st.熬夜 && st.熬夜.档) || '')
  if (熬档 === '崩') 加法 += 15
  else if (熬档 === '重') 加法 += 10
  else if (熬档 === '钝') 加法 += 5
  if (罚 >= 3) 加法 += 12
  else if (罚 >= 2) 加法 += 5
  const emo0 = Number(st.layers.emotional ?? 55)
  if (emo0 < 25) 加法 += 10
  else if (emo0 < 40) 加法 += 5
  const 上限 = Math.max(20, Math.round(100 * 比例 - 加法))
  if (Number(st.layers.physical) > 上限) st.layers.physical = 上限
  // 病况给面板/注入用（症状是事实，不是指令）
  if (__病.重 > 0) st['病'] = { 名: __病.名, 重: __病.重, 症状: __病.症状, 发烧: __病.发烧偏移, 值: __病.值 }
  else delete st['病']
  st['疾病值'] = __病.值
} catch { /* 疾病算不出来不影响主流程 */ }

// WAKE_GRUMP 2026-11-16（批次567）：起床气到期，把当时扣的那一份还回去 —— **只还一次**。
// 扣是 睡眠阶段.endSleep 干的（深睡被硬叫醒，-1.1）；还归这里，因为 intensity 的收敛本来就归 状态推进。
// 只认 `已还 === false`：还过置 true；中间又睡了一觉的，endSleep 会标成「睡过去了」。
try {
  const __气 = st['起床气']
  if (__气 && typeof __气 === 'object' && __气.已还 === false) {
    const __到 = Number(__气.untilMs)
    if (Number.isFinite(__到) && now > __到) {
      const __还 = Number(__气.还)
      if (Number.isFinite(__还) && __还 > 0) {
        st.mood = st.mood || { intensity: 0 }
        st.mood.intensity = Math.max(-2, Math.min(2, Number(((Number(st.mood.intensity) || 0) + __还).toFixed(3))))
      }
      __气.已还 = true
      __气['还于'] = new Date(now + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    }
  }
} catch { /* 还不了不影响推进 */ }

if (!dry) {
  // ENERGY_RECALC 2026-11-17（批次602）：上面的疾病/体温段改了 layers（压情绪、封顶体力），
  // 但 energy 是 :231/:267 算的旧值；不重算就会把「病着却精力很高」的假数写进盘。
  st.energy = 精力(st.layers)
  按精力改标签(st)
  // 保留一位小数，别让文件里全是长数字
  for (const k of ['cognitive', 'physical', 'emotional']) st.layers[k] = Math.round(Number(st.layers[k]) * 10) / 10
  saveState(stP, st, __snap)
}

const after = { energy: st.energy, label: st.mood.label, layers: st.layers }
console.log(`推进 ${mins} 分钟（${sleeping ? '在睡' : '醒着'}）`)
console.log(`  精力 ${before.energy} → ${after.energy}`)
console.log(`  心情 ${before.label} → ${after.label}`)
// LOG_MOOD 2026-11-08（批次262）：情绪和「挪」也打出来。原来只打认知/生理，
// 情绪这条线在日志里是隐形的 —— 出问题只能靠反推公式猜。
console.log(`  认知 ${before.layers.cognitive ?? '-'} → ${after.layers.cognitive}，生理 ${before.layers.physical ?? '-'} → ${after.layers.physical}`
  + `，情绪 ${before.layers.emotional ?? '-'} → ${after.layers.emotional}`
  + (globalThis.__心情挪 ? `（饱渴挪 ${globalThis.__心情挪}）` : ''))
if (sleepy !== null) console.log(`  困意 ${sleepy}/100`)
if (dry) console.log('（dry：没写回）')

// HORMONE_TICK 2026-11-04：每次状态推进顺带让激素走一步（激素自己管文件、设定点、去重缓存）
if (!dry) {
  try { execFileSync('/usr/local/bin/node', [tools + '/激素.mjs', '--tick'], { encoding: 'utf8', timeout: 15000 }) } catch { /* 激素推进失败不影响主流程 */ }
}

// THIRST_HORMONE 2026-11-08（批次223，主人「激素事件接上」）：渴到一半以下、或血糖掉到 3.5 以下，
// 3 小时最多发一次 —— 用 id 分桶去重（激素.mjs 自己会挡），不另存状态。
// 原来只有「饿」，而且是 缺口.mjs 在她决定忍着那一刻发的；长期渴 / 低血糖一直压不到底色。
if (!dry) {
  try {
    const 肚 = 饱渴.读()
    const 桶 = Math.floor((Date.now() + 8 * 3600e3) / (3 * 3600e3))
    const 发 = (名, id) => {
      try { execFileSync('/usr/local/bin/node', [tools + '/激素.mjs', '--event', 名, '--id', id], { encoding: 'utf8', timeout: 8000 }) } catch { /* 单条失败不影响推进 */ }
    }
    if (肚.水百分比 < 50) 发('渴', '渴-' + 桶)
    if (肚.血糖 < 3.5) 发('饿', '低糖-' + 桶)
  } catch { /* 读不出来就跳过 */ }
}
