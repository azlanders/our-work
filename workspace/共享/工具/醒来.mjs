// 醒来.mjs —— 被群聊/私聊叫醒时结算这一觉（2026-11-03）
import { 写档, 解析北京 } from './_底层.mjs'
import { 改 as 改自主, 真位 } from './自主状态.mjs'
import { endSleep } from './睡眠阶段.mjs'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, renameSync, appendFileSync, existsSync, mkdirSync } from 'node:fs'
// 2026-11-04 修：状态.json 多脚本共写，整份覆盖会丢别人刚写的字段；改合并写入，见 _状态.mjs
import { saveState, clone } from './_状态.mjs'
// RECOVER_CURVE 2026-11-06（批次122）：目标值和融合公式统一到 恢复目标.mjs。
import { 体力封顶, 情绪目标, 醒来融合 } from './恢复目标.mjs'
import * as 饥饿 from './饥饿.mjs' // HUNGER_ONE 2026-11-14（批次415）：见下方 饿着

// 限制状态数值范围，避免异常睡眠数据把状态推出 0～100。
const clamp = n => Math.max(0, Math.min(100, n))

// SLEEP_SHORT 2026-11-06（批次149）：这两个要在 finally 里用，而 finally 是另一个块，
// 拿不到 try 里的 const。先声明，try 里赋值。
let __本觉小时 = 0
let __短睡 = false
// WAKE_GRUMP 2026-11-16（批次567）：起床气要在 finally 里用，先拎到块外
let __起床气 = null
// 醒来前的「清醒起点」：必须在 endSleep 之前读 —— 睡眠阶段.mjs 关段时会把
// 睡醒.json.since 改写成 last.end（现在），之后就拿不到「这一觉之前醒了多久」。
/**
 * SANDBOX_ALL 2026-11-16（批次556）：这个脚本里原来有 **7 处**硬编码的
 * `{{BOT_ROOT}}/记忆/...` —— 它根本不走 ST_BASE。
 * 后果：任何测试只要 spawn 一次 `醒来.mjs`，就会去读写**线上真档**的 睡眠/睡醒/状态，
 * 而 `t353` 正是这么调它的（它设了 QQ_SLEEP_MEM，可这个脚本一个字都不看）。
 * `t353` 的「真档指纹」只盯了 资产/穿着/天气/状态 四个文件，**没盯 睡醒.json / 睡眠.json**，
 * 所以写真档了也看不见。批次555 追「谁在半夜叫醒她」时就是在这个坑里绕了很久。
 *
 * 现在统一成一个 MEM，并且**顺手把 ST_BASE 对齐** ——
 * `睡眠阶段.mjs` 的 `__base` 读的是 ST_BASE，两边不一致会「读真档、写沙盒」。
 */
const MEM = process.env.ST_BASE || process.env.QQ_SLEEP_MEM || '{{BOT_ROOT}}/记忆'
if (MEM !== '{{BOT_ROOT}}/记忆' && !process.env.ST_BASE) process.env.ST_BASE = MEM

let __醒前Since = null

try {
  // 先正常结束睡眠，让刚结束的这一觉成为可结算的完整记录。
  // 关段时 start 可能被写成"现在"，先记下这一觉真正开始的时间做兜底
  const __sleepBefore = JSON.parse(readFileSync(MEM + '/睡眠.json', 'utf8'))
  const liveStart = __sleepBefore && __sleepBefore.live && __sleepBefore.live.start ? __sleepBefore.live.start : null
  // 同一时刻把 睡醒.json 的原值记下来（endSleep 会覆盖它，见上面 __醒前Since 的注释）
  try { __醒前Since = JSON.parse(readFileSync(MEM + '/睡醒.json', 'utf8')).since || null } catch { /* 读不到就不保护 */ }

  // WAKE_ONCE 2026-11-06（批次148）：没有在睡记录就直接退出，不许再结算一遍。
  //
  // 实测今晚：23:30 她刚躺下，23:30-23:32 之间 工作.mjs（睡岗被抓）、自主行动（到点选动作）、
  // 自动作息（判该不该醒）三个 cron 各叫了一次 —— 每个进程都以为「还有一觉要结」。
  // 这个脚本的取段是 `segments.filter(s => s.start && s.end).at(-1)`，
  // 关过的段还是最后一段，于是同一觉被结算三遍：体力 7.3 → 42 → 56 → 61。
  // 两分钟的觉，回了五十四点体力；夜班睡岗扣的那五块钱也就白扣了。
  // live 没了就说明这一觉已经结过，只把「醒着」标记扶正（脏数据也能自愈），不碰状态。
  if (!liveStart) {
    try {
      const fp = MEM + '/睡醒.json'
      const f = JSON.parse(readFileSync(fp, 'utf8'))
      if (f.sleeping === true) {
        f.sleeping = false
        f.since = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
        写档(fp, f)   // 批次164：裸写改了原子写，面板此刻正在轮询这个文件
      }
    } catch { /* 标记改不过来也不影响：结算本来就不该再来一次 */ }
    console.log('已经醒了（没有在睡的记录），不重复结算')
    process.exit(0)
  }

// 这一觉睡了多久：必须在 endSleep 之前算 —— 关段会改 live，之后拿不到原点。
  const 本觉小时 = (() => {
    if (!liveStart) return 0
    const t = String(liveStart).trim().replace(' ', 'T')
    const 补 = /T\d{2}:\d{2}$/.test(t) ? t + ':00' : t
    const t0 = Date.parse(补 + '+08:00')
    const h = (Date.now() - t0) / 3600000
    return Number.isFinite(h) && h > 0 && h < 24 ? h : 0
  })()

  // 不到 20 分钟算打个盹：不算「起床」，不清清醒时长、不动困意。
  // 20 分钟是 N1 到 N2 的分界（真正睡着至少要跨过这一段）。
  __本觉小时 = 本觉小时
  __短睡 = 本觉小时 > 0 && 本觉小时 < 0.33

  // WAKE_EARLY_FLAG 2026-11-16（批次556）：**先把她叫醒，再慢慢结算。**
  //
  // `endSleep` 里 `data.sleeping = false` 只是改内存 —— 真正落盘要等
  // 做梦(≤20s) + saveState + 激素(≤8s) 之后那一句 `writeFlag(false, …)`。
  // 而 `睡态.mjs` 的判据是「标记优先」：`睡醒.json.sleeping` 还是 true，她就没醒。
  //
  // 实测 11-16：主人 08:39:13 私聊说了句话 → `poll.js` spawn 了 `醒来.mjs`
  // （detached、stdio: ignore、没有超时），可她 08:44:22 才被结束 —— 中间**五分钟**。
  // 面板上那五分钟是「睡着」，而她其实早就在醒来的路上。
  //
  // 这里只提前写**镜像**（`睡醒.json`），不碰 `睡眠.json` —— 结算仍然是原子的那一次。
  // 批次418 的注释写过「不在这里提前写 睡眠.json」是对的，那条针对的是 `睡眠.json`；
  // 镜像本来就是给门控读的，先写它只会让「叫醒」变快，不会让账落一半。
  try {
    const fp0 = MEM + '/睡醒.json'
    const f0 = JSON.parse(readFileSync(fp0, 'utf8'))
    if (f0.sleeping === true) {
      f0.sleeping = false
      f0.since = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
      f0.提前醒于 = f0.since
      写档(fp0, f0)
    }
  } catch { /* 写不了就退回原来的顺序，不影响结算 */ }

  const r = endSleep('woken')

  // 取最后一段已经结束的睡眠，用实际时长补足结算结果里缺失的阶段比例。
  const sleepLog = JSON.parse(readFileSync(MEM + '/睡眠.json', 'utf8'))
  const last = (sleepLog.segments || []).filter(s => s && s.start && s.end).at(-1)
  let lastHours = 0
  if (last) {
    const hours = (Date.parse(last.end) - Date.parse(last.start)) / 3600000
    if (Number.isFinite(hours) && hours > 0) lastHours = hours
  }
  // LIVE_FIRST 2026-11-06（批次148）：这一觉到底睡多久，以 live.start 到现在为准。
  //
  // 上面取的是 `segments.filter(s => s.start && s.end).at(-1)` —— 那是**上一觉**。
  // 实测造一觉 2 分钟的：日志写「睡了 0.50 小时（按 6% 结算）」，0.50 是今天凌晨那一觉的时长。
  // 用上一觉的长度给这一觉发恢复，短睡就永远按上一次整觉算。
  if (false) {
    const t0 = Date.parse(String(liveStart).replace(" ", "T").replace(/(\d{2}:\d{2})$/, "$1:00") + "+08:00")
    const h = (Date.now() - t0) / 3600000
    if (Number.isFinite(h) && h > 0 && h < 24) lastHours = h
  }
  if (本觉小时 > 0) lastHours = 本觉小时
  // 时长为 0 说明段的时间戳不可信（start 被写成现在），用睡觉开始时间兜底
  if (!(lastHours > 0) && liveStart) {
    // 批次164：原来是 replace(' ','T') + ':00+08:00'。liveStart 是带秒的（06:02:23），
    // 拼出来是 06:02:23:00+08:00 → Date.parse 直接 NaN，这条兜底从来没生效过。
    const t0 = 解析北京(liveStart)
    const h = (Date.now() - t0) / 3600000
    if (Number.isFinite(h) && h > 0 && h < 24) lastHours = h
  }

  // 在写入前读取最新状态，避免覆盖其他流程刚刚保存的字段。
  const statePath = MEM + '/状态.json'
  const st = JSON.parse(readFileSync(statePath, 'utf8'))
const __snap = clone(st)
// WAKE_GRUMP：endSleep 刚记下的那一份（沙盒/线上都经 st，别另读文件）
__起床气 = st['起床气'] && typeof st['起床气'] === 'object' ? st['起床气'] : null
  if (!st.layers || typeof st.layers !== 'object') st.layers = {}

  // 优先使用睡眠结算返回的阶段分钟数，缺失时按既有的默认比例估算。
  const totalMinutes = lastHours * 60
  const deepRatio = lastHours > 0
    ? (r && Number(r.deep_min) > 0 ? Number(r.deep_min) : totalMinutes * 0.2) / totalMinutes
    : 0.2
  const remRatio = lastHours > 0
    ? (r && Number(r.rem_min) > 0 ? Number(r.rem_min) : totalMinutes * 0.22) / totalMinutes
    : 0.22

  // 根据深睡和 REM 占比计算恢复目标，沿用原结算公式的上限。
  // RECOVER_CAP 2026-11-06（批次122）：上限原来写 100，深睡占比一高（或段时长算短了）
  // 目标就冲到 100，再按 0.6 权重融合 → 体力 89。设计目标就是 78 / 70，不往上抬。
  // HUNGER_CAP+SLEEP_DEBT 2026-11-07（批次192）：体力结算目标带上欠觉/饿的封顶。
  // 欠觉账由 睡眠阶段 endSleep 唯一结算，这里只读 —— sleepLog 是 endSleep 之后读的，
  // 欠 已是结完这一觉的最新值。饿（饱腹≤10）只压上限，不扣当前值。
  // HUNGER_ONE 2026-11-14（批次415）：原来这里连路径都是硬编码的（连沙盒变量都没有），
  // 读的还是 饥饿.json 里那个死字段（`吃()` 从不写它，停在 55）。
  // 现在走 饥饿.饿着()：现算，且跟另外两处同一个判据。
  const 饿着 = 饥饿.饿着(10)
  const physicalTarget = Math.min(体力封顶(Number(sleepLog.欠 || 0), 饿着), Math.round(35 + deepRatio * 150))
  const emotionalTarget = Math.min(情绪目标, Math.round(30 + remRatio * 140))

  // 将旧状态与恢复目标按四六比例融合，避免睡醒后状态跳变过大。
  const oldPhysical = Number.isFinite(st.layers.physical) ? st.layers.physical : 0
  // 批次245：兜底从 0 改成 45 —— 状态里缺 emotional 时，原来会直接判成「情绪归零」，
  // 再按长度融合反而把抑郁拉满；0 不是中性，45 才是。
  const oldEmotional = Number.isFinite(st.layers.emotional) ? st.layers.emotional : 45
  const cognitive = Number.isFinite(st.layers.cognitive) ? st.layers.cognitive : 0
  // SLEEP_LEN 2026-11-06（批次148）：融合权重按这一觉的实际时长走。
  //
  // 原来不管睡多久都是「旧值四成 + 目标六成」：2 分钟的觉和 8 小时的觉拿一样的钱。
  // 现在 8 小时拿完整的四六融合，2 分钟几乎不动（按 lastHours/8 线性插值）。
  // 目标值本身没改（deep 占比算出来仍是 65），改的只是「这一觉值多少」。
  const 够 = lastHours > 0 ? Math.min(1, lastHours / 8) : 0
  const 按长度 = (旧, 目标) => Math.round(旧 + (醒来融合(旧, 目标) - 旧) * 够)
  const physical = 按长度(oldPhysical, physicalTarget)
  // MOOD_ONCE 2026-11-08（批次245）：情绪不在醒来的这一刻二次融合 —— 睡眠期间已经按 0.06 收敛过。
  // 这里再按四六拉一次，35（抑郁）会被拉到 61，等于睡一觉治好。体力仍然按长度融合，不动。
  const emotional = Math.round(oldEmotional)
  st.layers.physical = physical
  st.layers.emotional = emotional

  // 用更新后的体力、认知和情绪重算精力，并在睡醒后清零清醒累计。
  st.energy = clamp(Math.round(physical ** 0.6 * cognitive ** 0.4 * (0.8 + 0.4 * emotional / 100)))
  // SLEEP_SHORT 2026-11-06（批次149）：2 分钟的觉不该把「已经清醒 23 小时」清零。
  // 原来无条件写 0，实测 23:30 她趴了 2 分钟被叫醒，23:40 困意 64 → 22，
  // 之后整夜都不困 —— 睡岗那一套等于白设。
  // 按这一觉值多少退：8 小时归零，2 分钟只退千分之四。
  const 旧清醒 = Number(st.hoursAwake || 0)
  st.hoursAwake = Math.max(0, 旧清醒 * (1 - 够))

  // 立即持久化结算结果，保证后续桥接流程读到的是醒后的状态。
  saveState(statePath, st, __snap)

  // 输出一行可读摘要，方便桥接日志核对本次被叫醒的结算结果。
  console.log(`被叫醒：睡了 ${lastHours.toFixed(2)} 小时（按 ${(够 * 100).toFixed(0)}% 结算），体力 → ${physical}，情绪 → ${emotional}，精力 → ${st.energy}`)

  // 保留原作息通知，让其他依赖该命令的流程继续正常运行。
  // NOTIFY_MOVED 2026-11-04：通知挪到 finally，结算出错也要发
} catch (e) {
  // 桥接调用不能因文件、数据或外部命令异常而崩溃，只记录失败原因。
  try {
    // WAKE_LOG 2026-11-15（批次497）：这条路的 stdout 被 poll 的 spawn(stdio:'ignore') 丢掉，
    // 控制台那行只有手动跑的时候有人看见。落到跟 endSleep 同一个文件里。
    const dir = MEM + '/日志'
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    appendFileSync(dir + '/醒来.log', at + ' 醒来结算失败：'
      + String((e && (e.stack || e.message)) || e).replace(/\n/g, ' | ').slice(0, 400) + '\n')
  } catch { /* 日志失败不影响后面 finally 的通知 */ }
  console.log('醒来失败：' + (e && e.message))
} finally {
  // 不管结算成没成，都要把「醒着」这层通知发出去，避免睡眠标记挂着
  try {
    // SLEEP_SHORT 2026-11-06（批次149）：作息.mjs --醒了 会把 睡醒.since 写成现在，
    // 而 困意.mjs 正是用 since 算「清醒多久」。趴 2 分钟也重置 = 这段觉白熬。
    // 短睡时先记下 since，叫完再放回去（sleeping=false 保持，门控照常放行）。
    // 用关段之前存下的值（endSleep 已经把文件里的 since 改成「现在」了）
    const __原Since = __醒前Since
    execFileSync('/usr/local/bin/node', ['{{BOT_ROOT}}/共享/工具/作息.mjs', '--醒了'], {
      encoding: 'utf8',
      // 醒来.mjs 已经按这一觉的长度算过体力/情绪/精力。作息.mjs 里那一段是第二份公式
      //（而且没有时长权重），带这个标记让它跳过，只关段、改标记、定计划。
      // SANDBOX_LEAK 2026-11-16（批次556）：**这一行漏了 QQ_SLEEP_MEM。**
      // `作息.mjs` 的 base 是 `QQ_SLEEP_MEM || 真档` —— 它**不认 ST_BASE**，
      // 而 `醒来.mjs` 自己走的是 ST_BASE。两个变量不同名，于是：
      // 「设了 ST_BASE 的调用方」以为自己在沙盒里，`作息 --醒了` 那一句却写真档。
      // 实测 09:09 我跑一次沙盒验证，真档 睡醒.json 的 since 就从 08:39:34 被改成 09:09。
      // 现在把两个都传下去，怎么设都不会漏。
      env: { ...process.env, QQ_SETTLED: '1', QQ_SLEEP_MEM: MEM },
    })
    if (__短睡 && __原Since) {
      try {
        const fp = MEM + '/睡醒.json'
        const f = JSON.parse(readFileSync(fp, 'utf8'))
        f.sleeping = false
        f.since = __原Since
        写档(fp, f)   // 批次164：同上
        console.log(`（只睡了 ${(__本觉小时 * 60).toFixed(0)} 分钟，按打盹算：清醒时长仍是 ${__原Since} 起）`)
      } catch { /* 放不回去也不影响这一觉 */ }
    }
  } catch (e2) { console.log('通知作息失败：' + (e2 && e2.message)) }

  // AUT_SYNC 2026-11-06（批次110）：醒来立刻把自主状态从「睡觉」改回来。
  // 状态推进.mjs 有这段逻辑，但它是 15 分钟一轮 —— 主人 00:49 叫醒她，
  // 面板和 QQ 签名又挂了十分钟「睡觉」，看起来像没叫醒。
  // 只做「睡眠 → 待命」这一件事：做什么仍归 自主行动 下一分钟自己挑，
  // 位置按 资产 的真实值对齐（作息刚跑完，位置才是最终值）。
  try {
    const 目录 = MEM
    let 位 = ''
    // 批次169：锁内改。原来「锁外读 → 改 → 写档」，醒来那一刻 自主行动 正好在写就被抹掉。
    const r = 改自主(目录, (aut) => {
      if (!/睡/.test(String(aut.state || ''))) return false
      位 = 真位(目录) || String(aut.place || '')
      aut.state = '待命'
      aut.since = Date.now()
      aut.doneAt = Date.now()
      aut.nextAt = 0            // 放开，让 自主行动 下一分钟重新挑
      // WAKE_GRUMP 2026-11-16（批次567）：起床气期间 note 说实话，别再写「被叫醒了」这种出厂默认
      aut.note = (__起床气 && __起床气.已还 === false && Number(__起床气.untilMs) > Date.now())
        ? '被人硬拽起来，脑子还是木的'
        : '被叫醒了'
      if (位) aut.place = 位
    })
    if (r) console.log('自主状态已同步：睡觉 → 待命（' + (位 || '位置未知') + '）')
  } catch (e3) { console.log('同步自主状态失败：' + (e3 && e3.message)) }

  // CATCHUP_AT_GATE 2026-11-07（批次199）：补课已挪到 睡眠阶段.mjs 的 endSleep（唯一关卡）。
  // 原来挂在这里（被叫醒路径），自然醒走 自动作息 绕过了它 —— 11-07 真实事故：她自然醒，补课没跑。
}