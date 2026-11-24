#!/usr/bin/env node
// 困意.mjs —— 算「现在有多困」，睡眠由它自己决定，机制只给数和边界（2026-11-01）

// NIGHT_BONUS 2026-11-03：夜里到点就该困，不靠早上一次算死的腺苷
function nightBonus(hour, minute) {
  const t = hour + minute / 60
  const d = Math.min((t - 3 + 24) % 24, (3 - t + 24) % 24)   // 以凌晨 3 点为峰
  return Math.round(30 * Math.exp(-(d * d) / (2 * 1.6 * 1.6)))
}
function awakePressure(awakeHours) {
  const t = Math.min(1, Math.max(0, (awakeHours - 12) / 10))
  return Math.round(20 * t * t * (3 - 2 * t))
}
//
// 用法：
//   node 困意.mjs            # 打印困意值、建议窗口、是否越过硬边界
//   node 困意.mjs --json
//
// 四个输入（都在文件里，不用人喂）：
//   1 清醒时长：上次起床到现在多久（腺苷累积，最硬的一条）
//   2 昼夜节律：几点。凌晨和下午各有一次天然低谷
//   3 情绪消耗：情绪能量越低越困（吵过架、被冒犯过会显著加）
//   4 存在能量：没事可干更容易困；有在意的事会硬撑
//
// 两个硬边界：最早 22:30 之前不睡（睡太早会破坏节律），最晚 02:30 之后必须睡，
// 清醒超过 18 小时强制。其余全由她自己定——熬不熬夜是她的选择，后果也是她的。
import * as 饱渴 from './饱渴.mjs'
import { 档 } from './在干嘛.mjs'
import { 精力 } from './恢复目标.mjs'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
// 2026-11-04 修：状态.json 多脚本共写，整份覆盖会丢别人刚写的字段；改合并写入，见 _状态.mjs
import { saveState, clone } from './_状态.mjs'
// 2026-11-02 参数化：拟人阈值统一从 参数.json 的「拟人」段读，读不到用默认值
import { readFileSync as _rf } from 'node:fs'
let _PJ = {}
try { _PJ = JSON.parse(_rf('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)

// 2026-11-01：参数集中——阈值来自 参数.json，读不到才用下面的默认值
let PARAMS = {}
try {
  const pj = '{{BOT_ROOT}}/共享/工具/参数.json'
  if (existsSync(pj)) PARAMS = JSON.parse(readFileSync(pj, 'utf8'))
} catch { /* 用默认 */ }

import { join } from 'node:path'

// SLEEPY_MEM 2026-11-06（批次104）：加沙盒变量。原来这里写死，测一次就动她真实的困意。
const base = process.env.QQ_SLEEPY_MEM || (process.platform === 'win32' ? 'B:/肥鱼/记忆' : '{{BOT_ROOT}}/记忆')
const readJson = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：null/标量回落默认值

const state = readJson(join(base, '状态.json'), {})
const sleepDb = readJson(join(base, '睡眠.json'), { records: [] })

const now = new Date()
// BJ_HOUR 2026-11-03：一律按北京时间算，别信服务器时区
const __bjHourSrc = new Date(Date.now() + 8 * 3600 * 1000)
const hour = __bjHourSrc.getUTCHours() + __bjHourSrc.getUTCMinutes() / 60

// 1) 清醒时长
// AWAKE_TRUTH 2026-11-03：三处记录互相打架时，按「最后一条真实记录」算，别再拿默认值糊
let awakeHours = Number(PARAMS.困意?.默认清醒小时 ?? 14)
// 在睡的时候，「困意账」不该再加——睡着的人不会因为两小时前那顿饭更困。
let __sleeping = false
try {
  const flagPath = join(base, '睡醒.json')
  const flag = JSON.parse(readFileSync(flagPath, 'utf8'))
  if (flag && flag.sleeping === false && flag.since) {
    const sinceMs = Date.parse(String(flag.since).replace(' ', 'T') + '+08:00')
    if (Number.isFinite(sinceMs)) awakeHours = Math.max(0, (Date.now() - sinceMs) / 3600e3)
  } else if (flag && flag.sleeping === true) {
    awakeHours = 0
    __sleeping = true
  }
} catch { /* 没这份记录就继续用睡眠记录算 */ }
const lastSleep = (sleepDb.records || []).slice(-1)[0]
if (lastSleep?.date && lastSleep?.wake) {
  const [h, m] = String(lastSleep.wake).split(':').map(Number)
  const wakeAt = new Date(lastSleep.date + 'T00:00:00')
  wakeAt.setHours(h, m, 0, 0)
  const byRecord = Math.max(0, (now - wakeAt) / 3600e3)
  // 睡眠记录比睡醒标记更近时才覆盖（取更近的那条，别让旧记录把新的压掉）
  if (!Number.isFinite(awakeHours) || byRecord < awakeHours) awakeHours = byRecord
  if (awakeHours > H('困意_清醒封顶小时', 24)) awakeHours = H('困意_清醒封顶小时', 24)  // 跨天了就别无限加
}

// AWAKE_CARRY 2026-11-15（批次496，批次498 改成累加）：
// 原来「在睡」就把清醒时长清零、醒来又从 0 起算 —— 她一闭眼腺苷账全被抹掉。
// 批次496 只按「末段 + 上一段」算了一次，漏了一种情况：**连着几个短觉**
// （11-14 23:18 睡 13 分钟、11-15 03:22 又睡），第二个短觉的「睡前清醒」只从
// 上一个段的 end 算起，前面 20 小时被丢掉 —— 实测 03:23 算出 3.8 小时、困意 30，
// 而真实是熬了 24 小时（她因此「不困」，又去发呆）。
// 现在从最近 6 段正序累加：每段先加上「距上次醒来醒了多久」，再按睡时长折减。
{
  const __段时 = (x) => {
    const t = Date.parse(String(x || '').replace(' ', 'T') + '+08:00')
    return Number.isFinite(t) ? t : NaN
  }
  const __segs = (Array.isArray(sleepDb.segments) ? sleepDb.segments : []).filter((x) => x && typeof x === 'object')
  const __取 = __segs.slice(-6)
  if (__取.length) {
    // 子段之前最近一次醒来（更早一段的 end）—— 用来给第一段补上「醒着多久」
    let __前置止 = NaN
    const __首位 = __segs.length - __取.length
    for (let i = __首位 - 1; i >= 0; i--) {
      const e = __段时(__segs[i].end)
      if (Number.isFinite(e)) { __前置止 = e; break }
    }
    // CARRY_FIRST 2026-11-15（批次498）：只有一段历史时 __前置止 是空的。
    // 这时候不能给 NaN（整段跳过 = 退回 flag 逻辑，可能算出 0 小时），
    // 用参数里的默认清醒小时顶第一段之前那段未知的清醒。
    let __累计 = Number.isFinite(__前置止)
      ? Math.max(0, (__段时(__取[0].start) - __前置止) / 3600e3)
      : Number(PARAMS.困意?.默认清醒小时 ?? 14)
    // 接不上（超过两天）就别硬算，留给上面的兜底
    if (Number.isFinite(__累计) && __累计 <= 48) {
      let __上次止 = NaN
      for (const __段 of __取) {
        const __起 = __段时(__段.start)
        if (!Number.isFinite(__起)) continue
        if (Number.isFinite(__上次止)) __累计 += Math.max(0, (__起 - __上次止) / 3600e3)
        const __止 = __段.end ? __段时(__段.end) : NaN
        // 末段没有 end = 现在在睡：时长算到「现在」，账号随之往下走
        const __睡h = Number.isFinite(__止)
          ? Math.max(0, (__止 - __起) / 3600e3)
          : Math.max(0, (Date.now() - __起) / 3600e3)
        __累计 = __累计 * (1 - Math.min(1, __睡h / 7.7))
        __上次止 = Number.isFinite(__止) ? __止 : Date.now()
      }
      // PENDING_AWAKE 2026-11-16（批次540）：循环只走 segments 里的段 ——
      // **最后一段 end 之后到「现在」这段时间从来没加进 __累计**。
      // 实测：她 11-15 11:40 醒（睡醒.json 的 since 也写着 11:40），到 11-16 07:08 已经 19.5 小时，
      // 可这里算出 7.5（39.19 × (1-6.23/7.7)），然后**无条件覆盖**掉前面用 睡醒.json 算对的 19.5。
      // 腺苷 (7.5-8)*4.5 = 0 → 困意只剩「身体 28」，于是「身体很累却不困」，
      // 她一路熬到 energy=4 才被 自动作息 强制睡。批次498 想修「腺苷账被抹掉」，修了段内、漏了段后。
      if (Number.isFinite(__上次止) && !__sleeping) {
        __累计 += Math.max(0, (Date.now() - __上次止) / 3600e3)
      }
      // SLEEPY_AWAKE_GUARD 2026-11-24（批次691）：段累加算出来的是「醒着多久」，
      // 但末段没有 end 就是「现在在睡」—— 原来先无条件覆盖 awakeHours、下一行才补
      // __sleeping，于是睡着时报「清醒 14.1 小时」（沙盒实测），腺苷按醒着算、困意虚高。
      // 先判在睡，再决定要不要覆盖。
      const __末 = __取[__取.length - 1]
      if (__末 && !__末.end) __sleeping = true
      if (!__sleeping) awakeHours = Math.min(__累计, H('困意_清醒封顶小时', 24))
    }
  }
}

// NAP_ADENOSINE 2026-11-17（批次677）：打盹期间不累计腺苷。
//
// 原来 `awakeHours` 只认 睡眠.json.segments；打盹不写段，于是最后一段 end 之后
// 「到现在」这段无条件全加进去 —— 眯 30 分钟，腺苷反而继续涨 2.25。这里不新写公式，
// 只把「醒来之后、这次打盹覆盖的那段」从待累计时间里扣掉；整觉前的旧盹已经被段折减，
// 不会重复扣。`腺苷暂停比例` 默认 1.0，可以按参数调成 0.5（半暂停）。
if (!__sleeping) {
  try {
    const 毫秒 = (x) => {
      const s = String(x || '').trim()
      if (!s) return 0
      const t = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') : s.replace(' ', 'T') + '+08:00')
      return Number.isFinite(t) ? t : 0
    }
    const 盹参 = (PARAMS['打盹'] && typeof PARAMS['打盹'] === 'object') ? PARAMS['打盹'] : {}
    const 暂停比 = Math.max(0, Math.min(1, Number(盹参['腺苷暂停比例'] ?? 1)))
    if (暂停比 > 0) {
      // 这一段腺苷账的起点：最后一次整觉醒来。没有段就用 睡醒.since。
      let 醒起 = 0
      const 段们 = (Array.isArray(sleepDb.segments) ? sleepDb.segments : []).filter((x) => x && typeof x === 'object')
      if (段们.length) {
        const 末止 = 毫秒(段们[段们.length - 1].end)
        if (末止 > 醒起) 醒起 = 末止
      }
      try {
        const flag = JSON.parse(readFileSync(join(base, '睡醒.json'), 'utf8'))
        if (flag && flag.sleeping === false) {
          const t = 毫秒(flag.since)
          if (t > 醒起) 醒起 = t
        }
      } catch { /* 没有睡醒标记就用段尾 */ }
      let 盹起 = 0
      let 盹止 = 0
      const 在盹 = readJson(join(base, '打盹.json'), null)
      if (在盹) {
        盹起 = Number(在盹['开始毫秒']) || 毫秒(在盹['开始'])
        盹止 = Math.min(Date.now(), Number(在盹['到毫秒']) || 毫秒(在盹['到']) || Date.now())
      } else {
        // 刚醒来的那一次：打盹.mjs 已经写了 打盹-末次.json（开始/到/醒毫秒）。
        const 末次 = readJson(join(base, '打盹-末次.json'), null)
        if (末次) {
          盹起 = Number(末次['开始毫秒']) || 毫秒(末次['开始'])
          盹止 = Number(末次['醒毫秒']) || 毫秒(末次['醒']) || 毫秒(末次['到'])
        }
      }
      if (盹起 > 0 && 盹止 > 盹起) {
        const 重叠 = Math.max(0, Math.min(盹止, Date.now()) - Math.max(盹起, 醒起))
        if (重叠 > 0) awakeHours = Math.max(0, awakeHours - (重叠 / 3600e3) * 暂停比)
      }
    }
  } catch { /* 打盹档坏了不影响整条困意 */ }
}

// 2) 昼夜节律：凌晨 3 点、下午 3 点两个谷
const _k = PARAMS.困意 || {}
// CIRCADIAN_RING 2026-11-15（批次497）：原来直接算 `hour - 3`，23:00 时差 20.98 小时，
// exp(-73) ≈ 0 —— 一夜里最该困的那一个小时，「到点该困」的加成凭空消失
// （0 点以后 hour<3 又好了，所以只在 23:00–24:00 断一段）。
// 时段是环形的，用最短距离；下午那个谷同理（凌晨 1 点离 15 点该按 10 小时算）。
const 环距 = (a, b) => { const d = Math.abs(a - b) % 24; return Math.min(d, 24 - d) }
const circadian = Math.exp(-Math.pow(环距(hour, _k.凌晨谷位 ?? 3), 2) / 6) * (_k.凌晨谷权重 ?? 22) + Math.exp(-Math.pow(环距(hour, _k.下午谷位 ?? 15), 2) / 8) * (_k.下午谷权重 ?? 12)

// 3) 情绪消耗 + 4) 存在能量
const emo = Number(state?.layers?.emotional ?? 60)
const exi = Number(state?.layers?.existential ?? 60)
const emoPart = (60 - emo) * 0.35
const exiPart = (60 - exi) * 0.2
// ADRENALINE 2026-11-16（批次573）：急性唤醒压困意 —— 被吓一跳的当下不困，
// 药效一过（半衰期 21 分钟）困意自己回来。所以**只减当前值，不记「欠」**：
// 压下去的那部分不需要事后补，半衰期一到它自然就回来了。
// 上限 -15：够把「困到 70」压回「55」，压不到 0 —— 人再兴奋也是会困的。
const advPart = (() => {
  try {
    const hj = JSON.parse(readFileSync(base + '/激素.json', 'utf8'))
    const a = Number(hj && hj.v && hj.v.adrenaline)
    if (!Number.isFinite(a)) return 0
    return -Math.min(15, Math.max(0, (a - 18) * 0.55))
  } catch { return 0 }
})()

// BODY_TIRED 2026-11-06（批次134）：困意的四个输入里原来没有体力/认知。
// 11-06 她整夜没睡：生理 8.8、认知 15.9、精力 11，困意只有 39 —— 自动作息一直说
// 「还不用睡」，她在电脑前打游戏。腺苷算的是「该困了」，不是「已经撑不住了」。
// 木桶取更低的那项，系数 0.6、上限 36（约三成），不盖过清醒时长这条主线。
const _phy = Number(state?.layers?.physical ?? 60)
const _cog = Number(state?.layers?.cognitive ?? 60)
const _bodyLow = Math.min(Number.isFinite(_phy) ? _phy : 60, Number.isFinite(_cog) ? _cog : 60)
const bodyPart = Math.min(36, Math.max(0, (60 - _bodyLow) * 0.6))

// SLEEP_DEBT 2026-11-17（批次595）：睡眠债已经由 睡眠阶段.endSleep 结算进
// 睡眠.json 的「欠」，体力上限也一直按它压；但困意公式从来没读过它。
// 结果就是：欠了 12.8 小时、体力被压到 63 的她，凌晨两点困意只有 34 ——
// 「身体已经欠账，主观却不困」，跟批次134「身体很累却不困」是同一个病。
// 这里只补主观困意，不改体力：体力仍走 恢复目标.体力封顶 那一条。
// 系数 1.6 / 封顶 18：欠 8 小时约 +12.8，欠 12 小时到顶 +18，
// 够把「有点困」推到「该睡了」，又不至于一欠觉就直接 80+。
const 睡眠债 = Math.max(0, Math.min(24, Number(sleepDb.欠) || 0))
const debtPart = Math.min(
  Number(_k.睡眠债封顶 ?? 18),
  Math.max(0, 睡眠债 * Number(_k.睡眠债系数 ?? 1.6)),
)

// 腺苷：清醒多久，困意涨多快
const adenosine = Math.min(60, Math.max(0, (awakeHours - 8) * 4.5))

let sleepy = Math.round(adenosine + circadian + emoPart + exiPart + bodyPart + advPart + debtPart)

// NIGHT_BONUS：北京时间的小时与分钟
const __bj = new Date(Date.now() + 8 * 3600 * 1000)
const __nb = 0  // AWAKE_TRUTH：夜间加分已由 circadian 提供，这里不再叠
const __ap = awakePressure(awakeHours)
// STAYUP_COST 2026-11-03：熬着就更困（+12），硬撑着不是没有代价
// STAYUP_OVER100 2026-11-05（批次101）：这里原来先 Math.min(100) 再往下累加，
// 于是 100 以上的三段（100~120 钝 / 120~140 重 / 140+ 崩）永远进不去 ——
// 「困意可超 100」写进了设计，代码里却把它钉死在 100。现在只夹总上限 160。
// SPLIT_CLOSE 2026-11-17（批次 680）：+12 原来只加到总分、没进 parts，
// 面板上「困意 71」和分项加起来 55 对不上，主人以为算错了。现在每一项都能对账。
let __熬夜 = 0
try {
  const sup = base + '/熬夜.json' // SANDBOX 2026-11-06（批次123）：走 QQ_SLEEPY_MEM
  if (existsSync(sup)) {
    const suj = JSON.parse(readFileSync(sup, 'utf8'))
    const u = Date.parse(String(suj.until || '').replace(' ', 'T') + '+08:00')
    if (Number.isFinite(u) && u > Date.now()) { sleepy = sleepy + 12; __熬夜 = 12 }
  }
} catch { /* 忽略 */ }
sleepy = Math.max(0, sleepy + __ap)

// SLEEPY_LEDGER 2026-11-06（批次104）：吃喝/打工对困意的影响，以前是直接改 `状态.困意`，
// 而下一次 `状态推进.mjs` 会用本脚本**从头现算**的值覆盖掉它 —— 一顿饭的 -6、一杯咖啡的 -22、
// 六小时夜班的 +14，最多活 15 分钟。所以改成记「欠账」，每次现算时按时间折算：
//   { kind, at, 值, 半衰 }   指数衰减：喝咖啡 -22 半衰 4 小时、糖 1 小时、普通吃喝 45 分钟、打工的累 8 小时
//   { kind, at, 峰, 持续 }   食困（餐后警觉性下降）：t=0 不困，中途到顶，到「持续」那一刻正好归零。
//     生理上它不是一个常数：血糖升→胰岛素→色氨酸进脑→血清素/褪黑素，副交感接手，
//     血糖回落就退。轻度（几口甜的、一小块点心）20~40 分钟就过去，一顿大餐 1~2 小时。
//   只在醒着的时候算；睡着的人不会因为两小时前那顿饭更困。
let __账增 = 0
if (!__sleeping && Array.isArray(state['困意账'])) {
  const __nowMs = Date.now()
  // MEAL_MOD 2026-11-06（批次104）：食困不是只由吃了什么决定，餐后做什么也在改它。
  //   · 起身走动 / 干活：肌肉直接消耗血里的葡萄糖，血糖落得快，困意退得也快
  //   · 饭后立刻坐着躺着：副交感占上风，拖得更久
  //   · 白天有光：光抑制褪黑素，峰值压低一点
  // 系数只作用在「饭后」那一项，提神/打工的账不受影响。
  let __活动倍速 = 1
  try {
    const __autS = String(readJson(join(base, '自主.json'), {}).state || '')
    // 2026-11-07 跟 饱渴.倍率() 对齐：站柜台 1.25、走动 1.4、逛街 1.6、搬货 1.9、跑 2.0；
    // 坐着不动那几样仍旧拖长，倍速 0.75。
    // 批次170：判据在 在干嘛.mjs（原来这里有一份正则、状态推进 有一份数组、饱渴 有一份 if 链）。
    // 注意只认「盹」和「歇」：整觉（档=睡）原来就不在慢速清单里，它走 饱渴.倍率() 的 0.4。
    // 这两个系数差得不多，但「睡觉 0.75」是没写过的行为，别顺手改。
    const __d = 档(__autS)
    if (__d === '盹' || __d === '歇') __活动倍速 = 0.75
    else { try { __活动倍速 = Math.max(0.6, Number(饱渴.倍率()) || 1) } catch { __活动倍速 = 1 } }
  } catch { /* 读不到就按中速 */ }
  let __光系数 = 1
  try {
    const __w = readJson(join(base, '天气.json'), {})
    const toMin = (t) => { const m = String(t || '').match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
    const sr = toMin(__w['日出']), ss = toMin(__w['日落'])
    const nowMin = __bjHourSrc.getUTCHours() * 60 + __bjHourSrc.getUTCMinutes()
    if (sr !== null && ss !== null && nowMin >= sr && nowMin < ss) __光系数 = 0.85
  } catch { /* 没有天气就按满值 */ }
  for (const e of state['困意账']) {
    const at = Number(e && e['at'])
    if (!Number.isFinite(at) || at <= 0) continue
    const dt = (__nowMs - at) / 60000
    if (dt < 0 || dt > 480) continue            // 8 小时前的账不再算
    const v = Number(e['值'] || 0)
    if (v !== 0) {
      const half = Math.max(10, Number(e['半衰'] || 60))
      __账增 += v * Math.pow(0.5, dt / half)
    }
    const peak = Number(e['峰'] || 0)
    if (peak !== 0) {
      const dur = Math.max(20, Number(e['持续'] || 0) || Number(e['峰位'] || 0) * 2 || 60)
      const eff = dt * __活动倍速
      if (eff < dur) {
        // sin²：两端为 0，正中间到顶，到「持续」那一刻自动归零 —— 不用再另判什么时候清账
        const w = Math.sin(Math.PI * eff / dur)
        __账增 += peak * __光系数 * w * w
      }
    }
  }
}
// SUPPRESS 2026-11-16（批次565）：**硬扛行为的代价（主人给的设计）。**
// 压制期间扣（被注意力强行压下去的那部分），行为结束时「待结算」里那笔带利息的正值
// 会在半小时里把她打回来 —— 「刷到凌晨三点手机锁屏、困意瞬间飙上去」就是这么来的。
// 这个文件只读不写：压制.json 的写者是 自主行动。
if (!__sleeping) {
  try {
    const __压 = readJson(join(base, '压制.json'), {})
    if (__压 && __压['当前'] && typeof __压['当前'] === 'object') {
      __账增 -= Number(H('自主_压制值', 14))
    }
    const __待 = Array.isArray(__压 && __压['待结算']) ? __压['待结算'] : []
    for (const __e of __待) {
      const __at = Number(__e && __e['at'])
      if (!Number.isFinite(__at) || __at <= 0) continue
      const __dt = (Date.now() - __at) / 60000
      if (__dt < 0 || __dt > 480) continue
      const __half = Math.max(10, Number(__e['半衰'] || 40))
      __账增 += Number(__e['值'] || 0) * Math.pow(0.5, __dt / __half)
    }
  } catch { /* 没有这个文件 = 没在压制 */ }
}
if (__账增 !== 0) sleepy = sleepy + __账增

// 2026-11-02 熬夜惩罚：不再封顶 100。0~100 是困，100 以上是熬穿。
sleepy = Math.max(0, Math.min(160, sleepy))
sleepy = Math.round(sleepy)
// 2026-11-02：测试用——强制一个困意值，验惩罚分支（生产不会带这个参数）
const _fi = process.argv.indexOf("--force-sleepy")
if (_fi > 0 && process.argv[_fi+1]) sleepy = Number(process.argv[_fi+1])
// 三段加重（只在超过 100 后生效，且写回状态，让她真的被扣）：
//   100~120 钝：认知 -8，说话变短
//   120~140 重：认知 -15、情绪 -10，容易记错
//   140+   崩：认知 -25、情绪 -18，随时可能断片
let strain = null
// STRAIN_FIX 2026-11-03：困意被 clamp 到 100，原来的「>100」永远不成立；改成「到顶」也算熬穿
const __strainAt = Number(H('困意_熬夜起算', 100))
if (sleepy >= __strainAt) {
  const over = Math.max(0, sleepy - __strainAt)
  const cog = over <= H('困意_轻档', 20) ? 8 : over <= H('困意_重档', 40) ? 15 : 25
  const emo = over <= H('困意_轻档', 20) ? 0 : over <= H('困意_重档', 40) ? 10 : 18
  strain = { over: Number(over.toFixed(1)), 认知扣: cog, 情绪扣: emo, 档: over <= H('困意_钝档上限', 20) ? '钝' : over <= H('困意_重档上限', 40) ? '重' : '崩' }
  try {
    const stP = base + '/状态.json' // SANDBOX 2026-11-06（批次123）：走 QQ_SLEEPY_MEM
    const st = JSON.parse(readFileSync(stP, 'utf8'))
const __snap = clone(st)
    st.layers = st.layers || {}
    // STRAIN_ONCE 2026-11-06（批次123）：这个脚本被 状态推进（15 分钟）和 自动作息（20 分钟）
    // 各调一次，原来只要困意过 100 就每次都扣 —— 一小时能扣 60~100 点，熬半天直接失能。
    // 改成「跨档才扣」：钝 8 / 重 15 / 崩 25，每档只扣一次；困意回落就清空，下次熬穿重新计。
    const __档序 = strain.档 === '钝' ? 1 : strain.档 === '重' ? 2 : 3
    const __已扣到 = Number((st.熬夜 || {}).已扣到 || 0)
    if (__档序 > __已扣到) {
      st.layers.cognitive = Math.max(0, Math.min(100, Number(st.layers.cognitive ?? 40) - cog))
      if (emo) st.layers.emotional = Math.max(0, Math.min(100, Number(st.layers.emotional ?? 45) - emo))
      // 批次171：合成公式只在 恢复目标.mjs 一处（原来是手抄的第二份，注释还写着「跟状态推进 同一套」）
      st.energy = 精力(st.layers)
    }
    // LAYER_PRECISION 2026-11-17（批次649 顺带）：这个文件是状态档的写方之一，
    // 但它从来不做「一位小数」收口 —— `状态推进` 只在它自己那条保存路径里 round。
    // 实测线上落成 `cognitive: 20.799999999999997`，然后原样进了每轮注入的
    // 「分层 生理55.5/情绪27.9/认知20.799999999999997」，t421 当场红（注入里出现了 15 位数字）。
    // 三层统一收到 1 位；energy 在下一行已经按新 layers 重算过，不受影响。
    for (const k of ['physical', 'cognitive', 'emotional']) {
      if (Number.isFinite(Number(st.layers[k]))) st.layers[k] = Math.round(Number(st.layers[k]) * 10) / 10
    }
    // over 每轮都更新（面板要看当前熬到哪一档），已扣到只升不降
    // WRITE_SLEEPY 2026-11-16（批次540）：这里原来只写 layers 和 熬夜，**不写「困意」字段**。
    // 于是「熬穿」那一刻 状态.json 是「困意 34 + 熬夜档 钝」—— 自相矛盾；
    // 而 自主行动 读的正是 状态.困意（第 150 行），它看到 34 就不睡，
    // 只有等 状态推进（15 分钟一次）把本脚本的打印回写进去。现在顺手写掉，两边当场一致。
    // SLEEPY_OWNER 2026-11-16（批次564）：**睡着时「困意」这个字段归 睡眠阶段.tickSleep 管。**
    // tickSleep 每分钟按阶段往下减（N2 -0.15、N3 -0.45）；而这里 awakeHours=0 重算出来的
    // 是「刚醒时该有多少困意」的静态值 —— 写回去就把分钟级衰减盖掉了，
    // 于是「睡觉时困意」要么恒 0（状态推进 原来那句）、要么跳回一个高值。
    // 醒着照旧写（批次540 就是为了让两边当场一致）。
    if (!__sleeping) st.困意 = sleepy
    st.熬夜 = { ...strain, 已扣到: Math.max(__已扣到, __档序) }
    saveState(stP, st, __snap)
  } catch (e) { console.log('写状态失败：' + (e && e.message)) } // WRITE_WARN 2026-11-04：别静默吞掉写失败
} else {
  // STRAIN_RESET 2026-11-06（批次123）：困意回落到 100 以下就清掉熬夜标记 ——
  // 下次再熬穿要能重新扣一轮，不然「已扣到」一辈子留着，惩罚只生效一次。
  // 没有标记就不写盘（每 20 分钟白写一次没必要）。
  try {
    const stP = base + '/状态.json'
    const st = JSON.parse(readFileSync(stP, 'utf8'))
    if (st.熬夜) {
      const __snap = clone(st)
      delete st.熬夜
      saveState(stP, st, __snap)
    }
  } catch { /* 清不掉不影响困意输出 */ }
}

// 硬边界
const toHM = (x) => `${String(Math.floor(x) % 24).padStart(2, '0')}:${String(Math.round((x % 1) * 60)).padStart(2, '0')}`
let barrier = ''
// CAP_KEY_FIX 2026-11-03：这里用「困意封顶」的语义，别和强制睡眠线混为一谈
// FALLBACK_FIX 2026-11-03：兜底跟 自动作息.mjs 对齐（36），别再 18/36 分裂
// DEADCFG_134 2026-11-06（批次134）：最早入睡 / 最晚入睡 这两个参数躺在 参数.json 里
// 一直没人读，这两个点写死在下面两行。现在接上，跟配置同一处。
const __最早H = (() => { const [h, m] = String(_k.最早入睡 ?? '22:30').split(':').map(Number); return (h || 0) + (m || 0) / 60 })()
const __最晚H = (() => { const [h, m] = String(_k.最晚入睡 ?? '02:30').split(':').map(Number); return (h || 0) + (m || 0) / 60 })()
if (awakeHours >= (_k.困意封顶清醒小时 ?? _k.强制睡眠清醒小时 ?? 36)) barrier = '已经清醒 ' + awakeHours.toFixed(1) + ' 小时，该睡了'
else if (hour >= __最晚H && hour < 6) barrier = '过了 ' + (_k.最晚入睡 ?? '02:30') + '，必须睡'
else if (hour >= __最早H || hour < __最晚H) barrier = sleepy >= H('困意_该睡门槛', 60) ? '到点了，困意也够，该睡' : '到点了但还不想睡，可以再撑一会儿'
// NAP_HINT 2026-11-06（批次134）：白天困了能眯一会儿，别让她以为只有夜里能睡。
else if (hour >= 12 && hour < 16 && sleepy >= H('困意_午睡门槛', 65)) barrier = '这个点困了，可以眯一会儿'
else barrier = '还没到最早睡的点（' + (_k.最早入睡 ?? '22:30') + '），撑着'

// SPLIT_CLOSE 2026-11-17（批次 680）：parts 必须能把 sleepy 加回来。
// 原来漏了「唤醒」「熬夜 +12」「憋着（awakePressure）」「账（困意账/压制/待结算）」，
// 面板显示 71、分项加起来 55，主人没法判断是哪一项在推高。
const parts = {
  腺苷: Math.round(adenosine),
  节律: Math.round(circadian),
  情绪: Math.round(emoPart),
  存在: Math.round(exiPart),
  身体: Math.round(bodyPart),
  唤醒: Math.round(advPart),
  睡眠债: Math.round(debtPart),
  熬夜: __熬夜,
  憋着: Math.round(__ap),
  账: Math.round(__账增),
}
const 分项和 = Object.values(parts).reduce((a, b) => a + b, 0)
const result = {
  sleepy,
  awakeHours: Number(awakeHours.toFixed(1)),
  睡眠债: Number(睡眠债.toFixed(1)),
  hour: toHM(hour),
  parts,
  分项和,
  闭合差: sleepy - 分项和,
  barrier,
}

if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2))
else {
  console.log(`困意 ${result.sleepy}/100（清醒 ${result.awakeHours} 小时）`)
  console.log(`  来源：腺苷 ${parts.腺苷} · 节律 ${parts.节律} · 情绪 ${parts.情绪} · 存在 ${parts.存在} · 身体 ${parts.身体}`
    + ` · 唤醒 ${parts.唤醒} · 睡眠债 ${parts.睡眠债}（欠 ${result.睡眠债} 小时）`
    + ` · 熬夜 ${parts.熬夜} · 憋着 ${parts.憋着} · 账 ${parts.账 >= 0 ? '+' : ''}${parts.账}`)
  console.log(`  分项和 ${分项和}，闭合差 ${result.闭合差}（四舍五入 + 160 上限内的误差）`)
  console.log(`  ${result.barrier}`)
}
