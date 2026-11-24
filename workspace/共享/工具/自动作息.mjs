#!/usr/bin/env node
// 自动作息.mjs —— 她按困意自己躺、自己醒，不用人喊（2026-11-02 第五条后半）
//
// 用法（通常交给 cron，每 20 分钟一次）：
//   node 自动作息.mjs            # 判断一次：该不该睡、该不该醒
//   node 自动作息.mjs --dry      # 只说不做
//
// 为什么这么写：
//   · 「几点睡」是钟表的事，「困不困」才是她的事。所以判据是困意值，不是钟点。
//   · 但纯困意也不行——困意一直不到线就永远不睡，那就熬穿了。所以留一条兜底：
//     清醒超过一定小时数，困意再低也躺。
//   · 醒了要满足两个条件之一：睡够目标时长，或者困意已经回落到阈值以下。
//   · 阈值都放参数表，读不到用默认；她自己的选择保留在日志里，能回看。
import { 写档, 解析北京 } from './_底层.mjs'
import { 睡着 } from './睡态.mjs'
// OCCUPY 2026-11-07（批次167）：在岗判据只在 占用.mjs 一份
import { 在岗的班, 在打盹 } from './占用.mjs'
import fs, { readFileSync, writeFileSync, existsSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs' // REQUIRE_FIX 2026-11-03：补默认导入，原来 require 在 ESM 里会抛错被吞
// 2026-11-04 修：状态.json 多脚本共写，整份覆盖会丢别人刚写的字段；改合并写入，见 _状态.mjs
import { saveState, clone } from './_状态.mjs'
import { startSleep, tickSleep, endSleep, 刚醒 } from './睡眠阶段.mjs'
// SLEEP_AT_HOME 2026-11-06（批次107）：睡觉前先看人在不在家。纯函数，单独一个文件好测。
import { 读资产再判 } from './睡在哪.mjs'
// RECOVER_UNIFY 2026-11-06（批次123）：自然醒这条路原来自己写了一份「目标上限 100」的公式，
// 而被叫醒那条（醒来.mjs）已经封顶 78/70 —— 同一觉两条路，自然醒会顶到 >78（11-04 的 89 就从这儿来）。
import { 体力封顶, 情绪目标, 醒来融合, 精力 } from './恢复目标.mjs'
import * as 饥饿 from './饥饿.mjs' // HUNGER_ONE 2026-11-14（批次415）：饿不饿只问它一处
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// CLI_GUARD 2026-11-17（批次616B）：审计 P0-6。
// 以前 --help 会落入默认自动判断，可能真睡/真醒；拼错 --dry 也一样。
const args = process.argv.slice(2)
const 用法 = [
  '用法：',
  '  node 自动作息.mjs          # 判断一次：该不该睡、该不该醒',
  '  node 自动作息.mjs --dry    # 只说不做：不写状态、不调有副作用的子脚本',
  '  node 自动作息.mjs --help   # 只打印用法',
].join('\n')
if (args.includes('--help') || args.includes('-h')) {
  console.log(用法)
  process.exit(0)
}
const 未知参数 = args.filter((a) => a !== '--dry')
if (未知参数.length > 0) {
  console.error('未知参数：' + 未知参数.join('、'))
  console.error(用法)
  process.exit(2)
}

// SANDBOX 2026-11-06（批次123）：加 ST_BASE，自然醒结算才能在沙盒里验，不用拿她生产试。
const base = process.env.ST_BASE || '{{BOT_ROOT}}/记忆'
const flagP = base + '/睡醒.json'
const sleepP = base + '/睡眠.json'
// SANDBOX 2026-11-06（批次123）：沙盒里指向一个只放桩的临时目录，
// 不然它会跑生产的 作息.mjs --醒了，把她的自主状态改成「待命」。
const tools = process.env.TOOLS_DIR || '{{BOT_ROOT}}/共享/工具'
const 节点 = process.env.NODE_BIN || '/usr/local/bin/node'
const dry = args.includes('--dry')

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)

// DRY_WRITE 2026-11-17（批次616B）：提醒文件也必须服从 dry。
// 原来两个分支无条件写 该睡了.json，--dry 排障会留下真实提醒。
const 写该睡了 = (值) => {
  if (dry) return false
  try {
    writeFileSync(base + '/该睡了.json', JSON.stringify(值, null, 2))
    return true
  } catch { return false }
}

// WORK_HOLD 2026-11-06（批次112）：上班时间走不开。
//
// 原来「该睡了」这个分支只会「先回家再睡」—— 可她 22:00 在便利店守着夜班，
// 体力掉到 4 的时候，这一支会把她往家赶，等于上班上到一半人没了。
// 现在先看她有没有在岗的班：有就留在店里，柜台后面眯一会儿，不走。
// 而且这正好接上主人要的那条 —— 上班时间睡着=睡岗，工作.mjs 每分钟掷一次，被抓就扣钱。
// 我们不替她决定「该不该睡」，只决定「睡在哪儿」。
// WORK_HOLD_ONE 2026-11-07（批次167）：这里原来有一份 在岗的班()，跟 缺口.mjs 的同名不同判据 ——
// 这份只认「状态=在岗」，缺了「待上 + 已到点 + 人在点上」那一档。
// 结果是上班第一分钟体力见底时，它认为她没在上班 → 读资产再判 → 把她往家赶，
// 人就从班上走了（这正是这段代码当初要防的事，只是漏了第一分钟）。判据现在在 占用.mjs。

// 阈值（可由 参数.json 覆盖）
// SLEEP_FIX 2026-11-03：清醒上限从 22 收到 18，另加夜里兜底
// DEADCFG_FIX 2026-11-03：清掉不再生效的配置项，只留真在用的
// RENAME_AWAKE_CAP 2026-11-03：这 18 小时只是「该提醒她睡了」，不是硬上限（硬的是 36/48 与体力见底）
let T = { 睡意阈值: 78, 提醒睡觉清醒小时: 18 }
try {
  const pj = JSON.parse(readFileSync(tools + '/参数.json', 'utf8'))
  T = { ...T, ...(pj['作息'] || {}) }
} catch { /* 用默认 */ }

// 1) 读困意（跑一次困意脚本，解析「困意 N/100」和「清醒 X 小时」）
// DRY_ISOLATE 2026-11-17（批次616B）：困意.mjs 在困意 >=100 或存在熬夜标记时会写
// 状态.json / 状态变更.log。--dry 不能碰真档：把困意读的那几份拷进一次性目录，
// 让它只写临时目录，跑完整个删掉。正常裸跑仍直读真档，行为不变。
function 跑困意() {
  let 临时 = null
  let env = process.env
  if (dry) {
    try {
      临时 = mkdtempSync(join(tmpdir(), 'auto-sleep-dry-'))
      for (const f of ['状态.json', '睡眠.json', '睡醒.json', '激素.json', '熬夜.json', '自主.json', '天气.json', '压制.json']) {
        const p = join(base, f)
        if (existsSync(p)) copyFileSync(p, join(临时, f))
      }
      env = { ...process.env, QQ_SLEEPY_MEM: 临时, QQ_LOCK_DIR: join(临时, '.locks') }
    } catch {
      if (临时) { try { rmSync(临时, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ } }
      throw new Error('dry 只读沙盒建不起来')
    }
  }
  try {
    const 选项 = { encoding: 'utf8', timeout: 20000, env }
    if (临时) 选项.cwd = 临时
    return execFileSync(节点, [tools + '/困意.mjs'], 选项)
  } finally {
    if (临时) { try { rmSync(临时, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ } }
  }
}

let sleepy = null
let awakeHours = null
try {
  const out = 跑困意()
  const m1 = out.match(/困意\s*(\d+)\/100/)
  const m2 = out.match(/清醒\s*([\d.]+)\s*小时/)
  if (m1) sleepy = Number(m1[1])
  if (m2) awakeHours = Number(m2[1])
} catch (e) { console.log('困意脚本跑不动：' + e.message); process.exit(0) }

// STAY_UP 2026-11-03：她想熬夜就让她熬——只要她自己声明了，就不强制她睡；代价是更困
let stayUpUntil = 0
try {
  const sp = base + '/熬夜.json'
  if (existsSync(sp)) {
    const sj = JSON.parse(readFileSync(sp, 'utf8'))
    const until = Date.parse(String(sj.until || '').replace(' ', 'T') + '+08:00')
    if (Number.isFinite(until) && until > Date.now()) stayUpUntil = until
  }
} catch { /* 没声明就按正常作息 */ }
// HARD_LIMIT_SOFT 2026-11-03：她声明熬夜时，硬底从 20 小时延到 24 小时；不声明就是 20 小时
// HARD_LIMIT_LONG 2026-11-03：人能熬很久，硬底改成「36 小时（声明熬夜则 48）」+ 体力见底两条
const __hardBase = Number(T.强制睡眠清醒小时 || 36)
const __hardCap = stayUpUntil > 0 ? Math.max(__hardBase, 48) : __hardBase
let __energyNow = 100
try {
  const sp2 = base + '/状态.json'
  if (existsSync(sp2)) __energyNow = Number(JSON.parse(readFileSync(sp2, 'utf8')).energy ?? 100)
} catch { /* 读不到就不看体力 */ }
const hardLimit = (awakeHours !== null && awakeHours >= __hardCap) || __energyNow <= 8
if (stayUpUntil > 0 && !hardLimit) {
  console.log('她自己声明要熬夜到 ' + new Date(stayUpUntil + 8 * 3600e3).toISOString().slice(11, 16) + '，这轮不强制睡')
}
if (sleepy === null) { console.log('读不到困意值，这轮不动'); process.exit(0) }

const flag = load(flagP, { sleeping: false })
const sleep = load(sleepP, { segments: [] })
const open = (sleep.segments || []).filter((s) => !s.end)
// SINGLE_TRUTH 2026-11-03：是否在睡只看 睡眠.json 的 live，睡醒.json 只当镜像
// 批次164：判据收口（见 睡态.mjs）。sleep 后面算段时长还要用，留着。
const sleeping = 睡着(base)

console.log(`困意 ${sleepy}/100，清醒 ${awakeHours ?? '?'} 小时，现在${sleeping ? '在睡' : '醒着'}`)

// SLEEP_FIX：醒着标记粘住超过 12 小时且夜里 —— 自动纠正回睡着，别让「醒着」永远粘着
try {
  if (!sleeping && flag && flag.sleeping === false && flag.since) {
    const sinceMs = Date.parse(String(flag.since).replace(' ', 'T') + '+08:00')
    const stuckHours = Number.isFinite(sinceMs) ? (Date.now() - sinceMs) / 3600e3 : 0
// TDZ_FIX 2026-11-03：__bjH 必须先声明，别在使用点后面
const __bjH = new Date(Date.now() + 8 * 3600 * 1000).getUTCHours()
const __lateNight = __bjH >= 1 && __bjH < 6
    // STUCK_48 2026-11-15（批次501）：原来是 >=12 小时。主人明确「熬夜可以熬 48 小时」——
// 凌晨 1-7 点醒着 12 小时不是「标记粘住」，是她真的醒着（下午三点醒、凌晨三点睡就是这种形状）。
// 12 小时的线会把她按回睡；改成 48，跟熬夜线一致。真·标记粘连由 睡态 那边兜（live 在就算睡）。
    if (stayUpUntil === 0 && stuckHours >= 48 && (__bjH >= 1 && __bjH < 7) && sleepy >= 45) { // STAY_UP：自己声明熬夜就别纠正
      console.log('醒着标记粘了 ' + stuckHours.toFixed(1) + ' 小时，纠正回睡着')
      if (!dry) {
      try { startSleep() } catch (e) { console.log('初始化睡眠阶段失败：' + e.message) }
      // 批次121：这一行原来还夹着一次 startSleep（括号里那个 IIFE），
      // 上一行刚把 sleeping 置 true，它必然被挡回来 —— 纯粹让人以为「这里要调两次」。
      execFileSync(节点, [tools + '/作息.mjs', '--想睡'], { encoding: 'utf8' })
    }
      process.exit(0)
    }
  }
} catch (e) { /* 纠错失败就按原逻辑走 */ }

// 2) 醒着：困到线就该睡；或者清醒超上限（兜底，防熬穿）
// NO_15H_FORCE 2026-11-03：删掉「凌晨+清醒15小时就强制睡」，这条是替她做决定

// STAGE_HOOK 2026-11-03：睡着时先按分钟推进睡眠阶段（N1→N2→N3→REM）
if (sleeping) {
  if (dry) {
    console.log('（dry：不推进睡眠阶段）')
  } else {
    try {
      const r = tickSleep()
      if (r && r.ok) console.log('阶段推进：' + (r.phase || '?') + ' 深睡 ' + Math.round(r.deep_min || 0) + ' 分 · REM ' + Math.round(r.rem_min || 0) + ' 分')
    } catch (e) { console.log('推进阶段失败：' + e.message) }
  }
}

if (!sleeping) {
  const tooSleepy = sleepy >= T.睡意阈值
  const __提醒线 = Number(T.提醒睡觉清醒小时 ?? T.清醒上限小时 ?? 18)
  const tooLong = awakeHours !== null && awakeHours >= __提醒线 && (stayUpUntil === 0 || hardLimit) // STAY_UP：声明熬夜就不按 18 小时催
  // REMIND_NOT_FORCE 2026-11-03：到点只提醒她，熬不熬她自己定；72 小时才是真底线
  const __absolute = awakeHours !== null && awakeHours >= 72
  if (tooLong && !__absolute) {
    const 写了 = 写该睡了({ at: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '), why: '清醒 ' + (awakeHours ?? '?') + ' 小时，困意 ' + sleepy })
    if (写了) {
      console.log('到点了，提醒一句就行：她已经清醒 ' + awakeHours + ' 小时')
    } else if (dry) {
      console.log('到点了，提醒一句就行：她已经清醒 ' + awakeHours + ' 小时（dry：没写 该睡了.json）')
    }
  }
  // NO_15H_FORCE：困意高、清醒久都只是提醒；只有 72 小时或体力见底才真拦
  const __energyLow = (() => {
    try {
      const p = base + '/状态.json'
      const j = JSON.parse(readFileSync(p, 'utf8'))
      return Number(j.energy ?? 100) <= 5
    } catch { return false }
  })()
  if (tooSleepy || tooLong) {
    const 写了 = 写该睡了({ at: new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' '), why: '困意 ' + sleepy + '，清醒 ' + (awakeHours ?? '?') + ' 小时' })
    if (写了) {
      console.log('只是提醒：困意 ' + sleepy + '、清醒 ' + (awakeHours ?? '?') + ' 小时')
    } else if (dry) {
      console.log('只是提醒：困意 ' + sleepy + '、清醒 ' + (awakeHours ?? '?') + ' 小时（dry：没写 该睡了.json）')
    }
  }
  // WAKE_GRACE 2026-11-06（批次110）：刚被叫醒的 30 分钟里，不按体力判「该睡了」。
  // 她 00:20 被 energy=4 判睡，主人 00:39 / 00:42 私聊叫醒两次；
  // 醒来结算会把体力拉回四成左右，但万一结算那一下没成（live 已空），
  // 下一轮（20 分钟后）又按 energy<=5 把她按回去 —— 主人看到的就是「怎么叫都叫不醒」。
  // 只放过「体力见底」这一条；72 小时硬线（__absolute）照旧，该拦还拦。
  const __justWoke = (() => {
    try { return 刚醒(JSON.parse(readFileSync(base + '/睡醒.json', 'utf8'))) } catch { return false }
  })()
  const __isNapping = !!在打盹(base)
  // DEEP_SLEEPY 2026-11-15（批次499）：原来的强制线只有「72 小时」和「体力 <= 5」。
  // 11-15 这一夜她困意 99~111、清醒 24 小时，全程只有碎片打盹，一次整觉都没成 ——
  // 打盹不清困意账（那是批次134 的设计，防止 20 分钟抹掉一夜），于是「打盹→还是困→再打盹」
  // 可以无限循环，自动作息每一轮都只说「只是提醒」。困意过 95 再叠上清醒 20 小时，
  // 已经不是「她的选择」，是身体撑不住了 —— 这一档按头睡。
  // 主人 2026-11-15 04:58 明确：熬夜可以熬 48 小时 —— 20 小时不算熬穿，她自己的选择。
  const __deepSleepy = Number(sleepy) >= 95 && Number(awakeHours ?? 0) >= 48
  if (__absolute || __deepSleepy || (__energyLow && !__justWoke && !__isNapping)) {
    // NAP_UPGRADE 2026-11-15（批次499）：强制睡之前先收掉打盹。两个睡眠系统并排跑的时候，
    // 打盹 --tick 到点会把 自主.state 改成「待命」，整觉的 live 还挂着 —— 谁也不知道她在不在睡。
    if (!dry) {
      try { execFileSync(节点, [tools + '/打盹.mjs', '--醒'], { encoding: 'utf8', stdio: 'ignore' }) } catch { /* 没在打盹就算了 */ }
    }
    const why = __deepSleepy
      ? `困意 ${sleepy}、清醒 ${awakeHours} 小时 —— 熬穿了，不是「再撑一会儿」的事`
      : __energyLow && !__absolute ? `体力见底（精力仅剩 ${__energyNow}），撑不住得躺下回血` : (tooSleepy ? `困意 ${sleepy} 过了 ${T.睡意阈值} 的线` : `清醒 ${awakeHours} 小时，超过 ${__hardCap} 小时的硬底线`)
    console.log('该睡了：' + why)
    // SLEEP_AT_HOME 2026-11-06（批次107）：睡觉前先在家。
    // 00:20 那次 energy=4 触发强制睡，可她人还在便利店（21:49 到的，一动没动），
    // startSleep 只写 睡醒.json —— 面板于是成了「她现在在便利店」+「在床上睡着了」，
    // QQ 状态写着「睡着了」，三处各说各的。
    // 一个人不会「在便利店床上睡」：先走回家，到了下一轮（最多 20 分钟）再睡；
    // 已经在往家走的就别在半路开始睡。
    const __班 = 在岗的班(base)
    const __哪 = __班
      ? { 走: false, 在路上: false, 位: String(__班.点 || ''), 话: '在' + String(__班.点 || '') + '上班（' + String(__班.活 || '') + '），走不开，柜台后面眯一会儿' }
      : 读资产再判(base)
    if (__班) console.log(__哪.话)
    if (__哪.走) {
      console.log(__哪.话)
      let 走成了 = false
      if (!dry) {
        try {
          execFileSync(节点, [tools + '/走路.mjs', '--去', '家'], { encoding: 'utf8' })
          const 后 = load(base + '/资产.json', {})
          走成了 = !!(后.在途 && String(后.在途.to || '') === '家')
        } catch (e) { console.log('回家没走成：' + String((e && e.message) || e)) }
      }
      if (dry) console.log('（dry：没真走）')
      // 连走都走不成（地图/锁坏了），也不能让她永远不睡 —— 原地将就，明天再说。
      // 这条兜底必须留：72 小时那条硬线走的是同一个分支，卡住就等于取消兜底。
      if (!dry && !走成了) {
        console.log('走不成，先在' + __哪.位 + '将就睡')
        try { startSleep() } catch { /* 忽略 */ }
        execFileSync(节点, [tools + '/作息.mjs', '--想睡'], { encoding: 'utf8' })
      }
    } else if (__哪.在路上) {
      console.log(__哪.话)
    } else {
      // DRY_FIX 2026-11-06（批次112）：这一行原来长这样 ——
      //   if (!dry) startSleep(); execFileSync(作息 --想睡)
      // 分号后面那个 execFileSync 不在 if 的管辖里，于是 `--dry` 照样把「想睡」
      // 写进 睡醒.json（sleeping=true），而 睡眠.json 的 live 是空的 —— 两处对不上，
      // 她明明醒着却谁都搬不动。今晚验「在岗时该睡」就是这么把真数据写脏的。
      if (dry) {
        console.log('（dry：没真睡）')
      } else {
        try { startSleep() } catch { /* 忽略 */ }
        execFileSync(节点, [tools + '/作息.mjs', '--想睡'], { encoding: 'utf8' })
      }
    }
  } else {
    console.log('还不用睡')
  }
  process.exit(0)
}

// 3) 在睡：睡够，或困意回落，就该醒
// LIVE_START_TRUTH 2026-11-04：段可能已被关掉（open 为空），此时按 live.start 算睡多久，
// 否则 sleptHours 恒为 0，只能等困意掉到阈值才醒，容易凌晨四五点就被叫起来。
const seg = (sleep.live && sleep.live.start)
  ? { start: sleep.live.start }
  : open[open.length - 1]
let sleptHours = 0
if (seg) {
  // SLEEPHOURS_FIX 2026-11-03：统一按北京时间解析，负数当 0，超 24 小时强制结账
    const __raw = String(seg.start || '')
    const __ms = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(__raw)
      ? Date.parse(__raw.slice(0, 16).replace(' ', 'T') + ':00+08:00')
      : Date.parse(__raw)
    sleptHours = Number.isFinite(__ms) ? Number((((Date.now() - __ms) / 3600e3)).toFixed(2)) : 0
    if (sleptHours < 0) sleptHours = 0
    if (sleptHours > 24) {
      console.log('睡超过 24 小时，结账')
      if (!dry) { try { endSleep('long') } catch { /* 忽略 */ } }
    }
}
// WAKE_TUNE 2026-11-03（gemini 调参）：自然醒要睡够 6 小时且困意降到 15 以下；7.7 小时强制醒
// SLEEP_TUNE_PARAM 2026-11-03：阈值不再写死在代码里，统一从 参数.json 的「作息」段读
let __够强制 = Number(T['起床_睡够强制小时'] ?? 7.7)
// SLEEP_DEBT 2026-11-04：通宵/熬穿之后按欠债补睡——每 10 点「熬穿超额」多睡 1 小时，最多补到 14 小时。
// 原来 7.7 小时一到就强醒，通宵完了也只能睡 7.7 小时，等于没补回来。
try {
  const __st2 = JSON.parse(readFileSync(base + '/状态.json', 'utf8'))
  const __over = Number(__st2?.熬夜?.over ?? 0)
  if (__over > 0) __够强制 = Math.min(14, __够强制 + Math.min(6, __over / 10))
} catch { /* 读不到就按原值 */ }
const __够回笼 = Number(T['起床_睡够回笼小时'] ?? 6)
const __困意线 = Number(T['起床_困意阈值'] ?? 15)
const enough = sleptHours >= __够强制
const recovered = sleptHours >= __够回笼 && sleepy <= __困意线
if (enough || recovered) {
  const why = enough ? `已经睡了 ${sleptHours} 小时` : `困意回落到 ${sleepy}`
  console.log('该醒了：' + why)
  if (!dry) {
    try {
      // 关段时 start 会被写成「现在」，先在关段前记下这一觉真正开始的时间
      let __lsStart = null
      try { const __s0 = load(sleepP, {}); __lsStart = (__s0.live && __s0.live.start) || null } catch { /* 读不到就算了 */ }
const r2 = endSleep('natural')
      // WAKE_FEEL 2026-11-03：把这一觉的质量记下来，醒来那几轮她能照实说感觉
      try {
        const fs2 = fs
        const bj2 = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
        fs2.writeFileSync(base + '/刚醒.json', JSON.stringify({
          at: bj2,
          quality: (r2 && r2.quality) || 0,
          deep_min: (r2 && r2.deep_min) || 0,
          rem_min: (r2 && r2.rem_min) || 0,
          inertia: Boolean(r2 && r2.inertia),
        }, null, 2))
      } catch { /* 记不下来就算了 */ }
      if (r2 && r2.ok) console.log('睡醒结算：质量 ' + (r2.quality ?? '?') + '，深睡 ' + Math.round(r2.deep_min || 0) + ' 分')
      // WAKE_LASTSLEEP_FIX 2026-11-03：endSleep 已经把段关掉了，随后调 作息.mjs --醒了 时
      // 它找不到「还开着的段」，直接退出，状态里的 lastSleep.hours / todayTotal 就一直是 0。
      // 这里自己按刚关掉的那一段算，写回状态。
      try {
        const bjNow = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')
        const today = bjNow.slice(0, 10)
        const sj = load(sleepP, { segments: [] })
        // P0 2026-11-04：时间戳有两种精度，原来一律在后面拼 ":00"，
        // 遇到 endSleep 写的 "07:00:01"（带秒）会解析成 NaN，整段结算静默算成 0。
        const toMs = (v) => {
          const s = String(v || '').trim()
          const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/)
          if (m) return Date.parse(`${m[1]}T${m[2]}${m[3] || ':00'}+08:00`)
          return Date.parse(s)
        }
        const segs = (sj.segments || []).filter((x) => x.end && String(x.start || '').startsWith(today))
        let total = 0
        for (const sg of segs) {
          const st0 = toMs(sg.start), en0 = toMs(sg.end)
          if (Number.isFinite(st0) && Number.isFinite(en0) && en0 > st0) total += (en0 - st0) / 3600e3
        }
        total = Number(total.toFixed(2))
        // P0 2026-11-04：这一觉的真相在 last_sleep 里（endSleep 刚写的）。
        // segments 是另一条写入路径（作息.mjs）留下的残段，半夜 02:1x 被关过一次，
        // 拿它算只会得到 1.18 小时。所以：last_sleep 够新就以它为准。
        const ls = sj && sj.last_sleep
        const ls0 = toMs(ls && ls.start), ls1 = toMs(ls && ls.end)
        const lsHours = Number.isFinite(ls0) && Number.isFinite(ls1) && ls1 > ls0 ? (ls1 - ls0) / 3600e3 : 0
        const lsFresh = Number.isFinite(ls1) && Math.abs(Date.now() - ls1) < 3600e3
        const lastSeg = segs[segs.length - 1]
        let lastHours = 0
        if (lsFresh && lsHours > 0) lastHours = Number(lsHours.toFixed(2))
        // 拿不到时长时给一个下限，避免后面 0 除把状态算成 NaN（LOWER_BOUND）
if (!(lastHours > 0.5) && __lsStart) {
          // 批次165：__lsStart 是 last_sleep.start，带秒（06:02:23）。旧写法拼成
          // 06:02:23:00+08:00 → Date.parse 返回 NaN，这条「拿不到时长就给个下限」的
          // 兜底从来没生效过（实测记忆目录 826 个时间串里 102 个带秒）。
          const __t0 = 解析北京(__lsStart)
          const __h = (Date.now() - __t0) / 3600e3
          if (Number.isFinite(__h) && __h > 0 && __h < 24) lastHours = __h
        }
        if (!(lastHours > 0)) lastHours = 0.1
        if (!(lastHours > 0.5) && lastSeg) {
          const st0 = toMs(lastSeg.start), en0 = toMs(lastSeg.end)
          if (Number.isFinite(st0) && Number.isFinite(en0) && en0 > st0) lastHours = Number(((en0 - st0) / 3600e3).toFixed(2))
        }
        // P0 2026-11-04：今日总时长把刚睡完这一觉算进去。取 max 而不是相加，
        // 因为 segments 里同一觉可能留了两条残段，相加会翻倍。
        if (lsFresh && lsHours > 0) total = Number(Math.max(total, lsHours).toFixed(2))
        const stP = base + '/状态.json'
        const st2 = load(stP, {})
        const snap2 = clone(st2)
        // P0 2026-11-04：结束时间也以 last_sleep 为准，别用 segments 里那条半夜的残段结尾。
        st2.lastSleep = { end: lsFresh && ls.end ? String(ls.end) : (lastSeg ? String(lastSeg.end) : bjNow), hours: lastHours, todayTotal: total }
        st2.hoursAwake = 0 // 自然醒后重新累计清醒时长，避免睡前的睡眠压力带到新一天
        const deepRatio = lastHours > 0 ? (r2 && Number(r2.deep_min) > 0 ? Number(r2.deep_min) : lastHours * 60 * 0.2) / (lastHours * 60) : 0.2 // 优先采用实际深睡占比，缺失时按 20% 估算，并在睡眠时长无效时避免除零
        const remRatio = lastHours > 0 ? (r2 && Number(r2.rem_min) > 0 ? Number(r2.rem_min) : lastHours * 60 * 0.22) / (lastHours * 60) : 0.22 // 优先采用实际 REM 占比，缺失时按 22% 估算，并在睡眠时长无效时避免除零
        // HUNGER_CAP+SLEEP_DEBT 2026-11-07（批次192）：endSleep 刚把欠觉账写回 sleepP，
        // 重读拿最新值。饿（饱腹≤10）只压上限。RECOVER_UNIFY 的「上限收到 78」不变。
        const __欠192 = Number((load(sleepP, {}) || {})['欠'] || 0)
        // HUNGER_ONE 2026-11-14（批次415）：原来是 `load('饥饿.json').饱腹 <= 10`。
        // 而那个字段是死的（`吃()` 存的时候从不写它，停在 55），三处判据的输入是常数，
        // 等于从来没生效过。现在问 饥饿.饿着()，它现算（当前 98）。
        const __饿192 = 饥饿.饿着(10)
        const physicalTarget = Math.min(体力封顶(__欠192, __饿192), Math.round(35 + deepRatio * 150))
        // MOOD_ONCE 2026-11-08（批次245）：这里原来把情绪再融合一次（旧*0.4 + 目标*0.6），
        // 可睡眠期间 状态推进 已经按 0.06 的指数收敛过一遍 —— 二次拉平等于把抑郁治好。
        // 情绪保留收敛后的值，不在醒来的这一刻再动它。emotionalTarget 只剩参考意义。
        const emotionalTarget = Math.min(情绪目标, Math.round(30 + remRatio * 140))
        const oldPhysical = Number.isFinite(st2.layers.physical) ? Number(st2.layers.physical) : 40 // 缺少体力字段时用 40 兜底，避免混合计算产生 NaN
        const oldEmotional = Number.isFinite(st2.layers.emotional) ? Number(st2.layers.emotional) : 45 // 缺少情绪字段时用 45 兜底，避免混合计算产生 NaN
        st2.layers.physical = 醒来融合(oldPhysical, physicalTarget) // RECOVER_UNIFY：与 醒来.mjs 同一个融合函数，两条路不可能再分叉
        st2.layers.emotional = Math.round(oldEmotional) // 批次245 MOOD_ONCE：不二次融合
        // 批次173：这里是第六份手抄的木桶（批次171 收「五处」时漏了它）。
        // 契约检查加了断言之后才露出来 —— 手抄的公式靠人记是记不全的。
        st2.energy = 精力(st2.layers)
        saveState(stP, st2, snap2)
        // P0 2026-11-04：今日总时长写回 睡眠.json。原来只有 作息.mjs 在关段时写，
        // 自然醒这条路 endSleep 先把段关了，作息 --醒了 找不到开着的段直接退出，
        // 于是这个值一直是 0，面板和手账都读它。
        try {
          const sj2 = load(sleepP, {})
          if (sj2 && typeof sj2 === 'object') {
            sj2.todayTotalHours = total
            writeFileSync(sleepP, JSON.stringify(sj2, null, 2), 'utf8')
          }
        } catch { /* 写不进去不影响醒 */ }
      } catch { /* 算不出来就算了，别影响醒 */ }
    } catch (e) { console.log('结算睡眠失败：' + e.message) }
    // DRY_FIX 同上：--dry 不该真醒。原来的 dry 只看前面几步，最后这一句照样执行。
    // WHO_WAKE 2026-11-16（批次553）：这里是「自动作息」这条路唯一的叫醒口。
    if (!dry) {
      try {
        const dir = base + '/日志'
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        // 这个文件里没有 bj()，时间要自己拼（批次553 我第一次就写错了 bj(now)，
        // ReferenceError 被上面的 try/catch 吞掉 —— 日志一辈子写不出来）。
        const __at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
        fs.appendFileSync(dir + '/醒来.log', __at + ' 自动作息 要叫醒她（睡够了 ' + (why || '') + '）\n')
      } catch { /* 日志失败不影响 */ }
      execFileSync(节点, [tools + '/作息.mjs', '--醒了'], { encoding: 'utf8' })
    }
    // WAKE_JOURNAL 2026-11-03：醒完立刻补一次手账。原来手账只在别的流程里刷，
    // 醒来这一段没人写，于是「这一觉」那行经常缺（验收会红）。
    // DRY_WAKE 2026-11-17（批次616B）：手账/状态推进也是写盘路径，dry 下明确不调。
    if (!dry) {
      try { execFileSync(节点, [tools + '/手账.mjs'], { encoding: 'utf8', timeout: 20000 }) } catch { /* 写不出来不影响醒 */ }
    }
    // WAKE_STATE_FORCE 2026-11-03：醒完立刻推进一次状态，把「睡着」标签换成「刚醒」，
    // 顺便让身体感受按清醒时长重算（不这样的话要等下一个 15 分钟的心跳）。
    if (!dry) {
      try { execFileSync(节点, [tools + '/状态推进.mjs', '--force'], { encoding: 'utf8', timeout: 20000 }) } catch { /* 刷不动不影响醒 */ }
    }
    // WAKE_GO_HOME 2026-11-06（批次107）：醒来那一刻如果不在家，第一件事是回家。
    // 睡前那条（SLEEP_AT_HOME）只管「以后别在外面睡」；可这一觉已经睡在便利店了，
    // 醒来总不能蹲在便利店开始新的一天 —— 她本来就是要回家的，只是昨晚没腿。
    if (!dry) {
      try {
        const __醒 = 读资产再判(base)
        if (__醒.位 !== '家' && !__醒.在路上) {
          execFileSync(节点, [tools + '/走路.mjs', '--去', '家'], { encoding: 'utf8' })
          console.log('醒了，人在' + __醒.位 + ' —— 先回家')
        }
      } catch (e) { console.log('醒来回家没走成：' + String((e && e.message) || e)) }
    }
  }
  if (dry) console.log('（dry：没真醒）')
} else {
  console.log(`继续睡（已睡 ${sleptHours} 小时，困意 ${sleepy}）`)
}
