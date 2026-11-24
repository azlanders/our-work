// 工作.mjs —— 她有班要上：打卡、迟到、在班上睡着被抓、客人进店、下班结工资
//
// 批次112（2026-11-06）主人三条要求，都在这份里：
//   ① 工作时间睡懒觉，每分钟有概率被发现，发现了扣工资；
//   ② 客人会进来，也会把她吵醒；
//   ③ 有些地方有关闭时间，有些地方根本不让睡、或者没地方睡。
//
// 设计上守两条闸：
//   · **上不上班是她的事**。这份脚本只记事实（几点到的、在岗多少分钟、睡了几次、扣了多少），
//     不替她决定"今天该不该去"。去不去由 缺口.mjs / 自主行动 抽，抽到了才走这一趟。
//   · **罚的是行为，不是态度**。睡岗是监控看见的、迟到是墙上钟表算的，都不是"判她懒"。
//     所以每一条罚都带具体来源（监控 / 老板电话 / 客人），不写"你应该更努力"这种话。
//
// 用法：
//   node 工作.mjs --tick            # cron 每分钟跑一次：生成班次、打卡、判睡岗、结算
//   node 工作.mjs --班              # 今天的班，带状态
//   node 工作.mjs --看              # 信用、统计、最近几条
//   node 工作.mjs --打卡            # 手动打卡（工具调用用）
//   node 工作.mjs --下班            # 手动结算（工具调用用）
import { 睡着 } from './睡态.mjs'
// LOCK_RMW 2026-11-08（批次260）：钱走锁内读-改-写，见下面结算那段
import { 改档 } from './_底层.mjs'
import { 改 as 改自主 } from './自主状态.mjs'
// SICK_LEAVE 2026-11-08（批次224）：病得起不来还去站柜台会穿帮，班次里要能请假。
import * as 疾病 from './疾病.mjs'
import { 算在岗 } from './占用.mjs'
import { 该有的班 as 共享该有的班 } from './排班判据.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { 读档 as 读地点, 营业中, 能睡吗 } from './地点.mjs'

// SANDBOX：测试要能把记忆和工具目录都指走。子脚本（醒来.mjs）认自己那套路径，
// 所以沙盒里只测判定，不测真叫醒。
const MEM = process.env.WORK_MEM || '{{BOT_ROOT}}/记忆'
const TOOLS = process.env.WORK_TOOLS || '{{BOT_ROOT}}/共享/工具'
const 工P = path.join(MEM, '工作.json')
const 配P = path.join(TOOLS, '工作.json')
const NODE = '/usr/local/bin/node'

const 读 = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
// ATOMIC：cron 每分钟一次，撞上 自主行动 也不能留半截 JSON。
const 存 = (p, o) => {
  const tmp = p + '.tmp-' + process.pid + '-' + Date.now()
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2))
  fs.renameSync(tmp, p)
}

const bj = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 日 = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 10)
const 星期 = (ms) => new Date(Number(ms) + 8 * 3600e3).getUTCDay()   // 0=周日
const 次日 = (d) => 日(Date.parse(d + 'T00:00:00+08:00') + 86400e3)
// BJTIME：裸字符串必须补 +08:00，直接 new Date 差 8 小时（批次102 的教训）。
const ts = (s) => Date.parse(String(s).replace(' ', 'T') + '+08:00')
const 分钟 = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
const 在段内 = (t, 起, 止) => {
  const a = 分钟(起), b = 分钟(止)
  if (a === b) return true
  if (a < b) return t >= a && t < b
  return t >= a || t < b
}

/** 空档案。第一次跑就是这个样子。 */
export function 空档() {
  return {
    在职: [],
    信用: 100,
    加薪: {},
    班次: [],
    统计: { 出勤: 0, 迟到: 0, 睡岗: 0, 缺勤: 0, 吵醒: 0, 连清: 0, 奖金: 0, 完成: {} },
    最近: [],
  }
}

/**
 * 某一天该有的班。周配的是 0-6（0=周日），跨夜的止日算次日。
 * 只生成「排了班」的活；发传单那种 周=[] 的临时工不排班，想去就手动开。
 */
export function 该有的班(配, 日期, 周 = null, 已有班次 = []) {
  const w = 周 === null ? 星期(ts(日期 + ' 12:00')) : 周
  return 共享该有的班(配, 日期, w, 已有班次)
}

/** 这一刻店里有没有人推门。白天多、后半夜少 —— 便利店凌晨三点也会有人来买烟。 */
export function 客人率(配, now) {
  const c = 配.客人 || {}
  const t = new Date(Number(now) + 8 * 3600e3)
  const m = t.getUTCHours() * 60 + t.getUTCMinutes()
  const 夜 = 在段内(m, c.夜里起 || '23:00', c.夜里止 || '06:00')
  return Number(夜 ? (c.夜里每分钟 ?? 0.03) : (c.白天每分钟 ?? 0.1))
}

/**
 * 这一分钟发生了什么。纯函数：只读局面，返回动作清单，不写任何文件。
 * 掷骰作为参数传进来，测试才能把「一定被抓」「一定没客人」跑成确定的结果。
 *
 * 局 = { 配, 工, 资, 睡(布尔), 睡起(毫秒, 可空), now, 掷 }
 */
export function 判定(局) {
  const { 配, 工, 资, now } = 局
  const 掷 = typeof 局.掷 === 'function' ? 局.掷 : Math.random
  const 位 = String((资 && 资.位置) || '家')
  const 途中 = !!((资 && 资.在途) && Number(资.在途.arriveAt) > now)
  const 睡中 = !!局.睡
  const 动作 = []
  // ONDUTY 2026-11-06（批次133）：她正在这一班上班时，别让「打烊」把她当闲人赶出去。
  // 原来 ⑥ 那段只管「随便在哪儿睡着」，没看有没有班：家教 16:00-18:00 在学校，
  // 学校 17:30 关门，她 17:35 打个盹就会被记成「打烊了，被赶出来了」—— 可她是在上班。
  // 上班时睡着该怎么算，②（监控/巡店）已经写清楚了，不需要 ⑥ 再来一遍。
  let 在这上班 = false
  const 班次 = Array.isArray(工.班次) ? 工.班次 : []
  const 罚 = 配.罚 || {}

  for (const 班 of 班次) {
    if (!班 || ['完成', '缺勤', '辞退'].includes(String(班.状态))) continue
    const 起 = ts(班.起), 止 = ts(班.止)
    if (!Number.isFinite(起) || !Number.isFinite(止)) continue

    // ① 过了结束时间 → 结算。有没有打卡决定是发工资还是记缺勤。
    if (now >= 止) { 动作.push({ t: '结算', id: 班.id }); continue }

    // SICK_LEAVE 2026-11-08（批次224）：病重 ≥0.5、还没打卡、已经到开工前 30 分钟 →
    // 请假（扣信用、不扣钱）。不加这条，她会「病得起不来还去站柜台」。
    if (String(班.状态 || '') === '待上' && !String(班.打卡At || '') && now >= 起 - 30 * 60e3) {
      try {
        const 病 = 疾病.读(now)
        if (病.重 >= 0.5) { 动作.push({ t: '病假', id: 班.id, 重: 病.重 }); continue }
      } catch { /* 病读不出来就照常上班 */ }
    }
    if (now < 起) continue

    // 批次172：判据只有 占用.算在岗 一处（原来这里自己写了一遍 `位 === 班.点 && !途中`，
    // 而 占用.在岗的班 只看「状态=在岗」—— 同一个事实两套判据，推出来的答案不一样）。
    const 在岗 = 算在岗(班, 资, now)
    if (在岗) 在这上班 = true

    // ONDUTY_MIN 2026-11-06（批次145）：在岗要一分钟一分钟地算，不是「打了卡就算一整班」。
    //
    // 原来结算是「打卡At 到 下班」，所以她 22:00 打上卡就能回家睡一整宿，06:00 照样拿满 6 小时的钱。
    // 那不是考勤，是签到表。主人要的「干完活按表现给钱」，前提是「干了多久」得是真的。
    //
    // 每次 tick 把「上一次 tick 到现在」这段累进 班.在岗分钟；人不在店里就不加。
    // 单次最多补 10 分钟 —— cron 停了半小时再起来，不能一口气把她没待的时间也补上。
    if (在岗) {
      // 第一次 tick（还没打过卡）从「现在」起算：她 22:20 才到，22:00-22:20 不该算在岗。
      // 之后每次从上次 tick 起算，单次最多补 10 分钟。
      const 起点 = Number(班.上次Tick || 0) || now
      const 段 = Math.min(10 * 60e3, now - 起点)
      if (段 > 0) 班.在岗分钟 = Math.round((Number(班.在岗分钟 || 0) + 段 / 60e3) * 10) / 10
      班.在岗计过 = true
    }
    班.上次Tick = now

    if (在岗) {
      if (班.状态 !== '在岗') 动作.push({ t: '打卡', id: 班.id })
      if (睡中) {
        // ② 在班上睡着：监控/老板每分钟掷一次。
      // NAP_CAP 2026-11-24（主人定 3.A）：每班次数上限原来写死 3，
      // 而实测各班的期望是 3.00（咖啡店帮工）/ 3.60（便利店）/ 4.80（家教）/ 6.00（发传单）——
      // 上限 3 意味着除了最短的班，几乎每次都会打满，「每分钟 2% 发现概率」这个设定
      // 完全形同虚设。现在按班次时长动态算：期望 × 1.5，最少 6 次，
      // 让概率重新成为真正的随机变量（偶尔一次、偶尔五六次），而不是恒定 3 次。
        // 老板不会守着看她一宿，抓三次之后要么她被叫起来、要么老板懒得管了。
        const 上限 = 睡岗上限(班, 配)
        if (Number(班.睡岗次数 || 0) < 上限 && 掷() < Number(班.睡岗每分钟 || 0.02)) {
          动作.push({ t: '睡岗', id: 班.id, 因: '监控/巡店看见她趴在柜台上' })
        }
        // ③ 客人进来。睡着的人听不见门铃，但客人会走到柜台前。
        if (掷() < 客人率(配, now)) 动作.push({ t: '吵醒', 点: 班.点, 因: '有客人推门进来，在柜台前站着' })
      }
    } else {
      // ④ 人没到：按钟点累计迟到，5 分钟一档。
      // 批次172：这里原来只判「现在不在店里」，把「来过又走了」也算成「人没到」——
      // 实测她 22:00 准点打卡、守到 05:54 走回家，被判「迟到 474 分钟」，扣 20 块、
      // 统计里还留了一条迟到记录。迟到是「还没到过」的事；打过卡的人离开是早退，
      // 人不在的那段时间本来就不累计在岗分钟（上面那段），已经扣过一次，不能再扣一次。
      const 迟到分 = Math.floor((now - 起) / 60e3)
      if (!班.临时 && !String(班.打卡At || '') && 迟到分 >= 5 && 迟到分 > Number(班.记迟到 || 0)) {
        动作.push({ t: '迟到', id: 班.id, 分钟: 迟到分 })
      }
      // ⑤ 该上班的点她还在睡：只有签了固定合同的排班才会打电话催；单日临时工不去就不去，绝不电话催命扣钱！
      if (睡中 && !班.临时) {
        const 上限 = 睡岗上限(班, 配)
        if (Number(班.睡岗次数 || 0) < 上限 && 掷() < Number(班.睡岗每分钟 || 0.02) * 0.5) {
          动作.push({ t: '睡岗', id: 班.id, 在家: true, 因: '老板打电话过来，问人到哪了' })
        }
      }
    }
  }

  // ⑥ 不在上班时间、只是随便在哪儿睡着：客人/店员/打烊都会把她弄醒。
  //
  // CLOSED_FIRST 2026-11-06（批次133）：原来这段是 `if (位 !== '家' && 歇.能)` 套着
  // 「打烊了就赶」——**那条永远不会执行**：能睡吗() 在关门时直接返回 {能:false, 为什么:'已经关门了'}，
  // 所以「打烊赶人」这半句是死代码。后果是她在 22 点关门的咖啡店里睡着，之后整夜没有任何人叫醒她，
  // 面板上就成「在一家关着门的店里睡了一宿」。
  // 现在先判营业，再判能不能打盹：关门就是要走人，跟这儿让不让打盹是两件事。
  // 走在路上不算（位 还是上一个地方，那时候赶人是假的）。
  if (睡中 && !在这上班 && !途中 && !动作.some((a) => a.t === '吵醒')) {
    const 档 = 读地点(MEM)
    const 营 = 营业中(位, 档)
    const 歇 = 能睡吗(位, 档)
    const 上限 = Number(歇.上限分钟 || 0)
    const 睡了分 = 局.睡起 && Number(局.睡起) > 0 ? (now - Number(局.睡起)) / 60e3 : 0
    const 分 = Math.round(睡了分)
    // 三条互斥：打烊了赶人 → 打盹超时赶人 → 有客人推门。一条都不该和另一条同时发生，
    // 同时喊两次会让她在同一分钟"被赶"两次，账上像两个人来撵她。
    if (位 !== '家' && !营.ok) {
      动作.push({ t: '被赶', 点: 位, 因: '打烊了，' + 营.因, 分钟: 分 })
    } else if (位 !== '家' && 歇.能) {
      // 打盹有上限：睡过头会被赶（图书馆不给睡那种在 能睡吗 里就挡掉了）。
      if (上限 > 0 && 睡了分 >= 上限) {
        动作.push({ t: '被赶', 点: 位, 因: 歇.话 || '这儿只能打个盹', 分钟: 分 })
      } else if (掷() < 客人率(配, now)) {
        动作.push({ t: '吵醒', 点: 位, 因: '店里有人进来' })
      }
    }
  }

  return 动作
}

/** 这一班该拿多少：真在岗分钟 × 时薪 / 60，含累计加薪。 */
export function 应发(班, 工, now) {
  const 加 = Number((工.加薪 || {})[班.活] || 0)
  let 分 = 0
  if (班.在岗计过) {
    // 有累计就只认累计：人在店里待了多久，就拿多久的钱
    // ROUND_MIN 2026-11-06（批次146）：累计是小数（每次 tick 差几十毫秒）。
    // 118.99 分钟按 59.495 算出来是 59 块 —— 少一块不是「四舍五入」，是把她干的那一分钟吞了。
    // 先把分钟取整，再乘时薪。
    分 = Math.round(Number(班.在岗分钟 || 0))
  } else {
    // 一次 tick 都没落到（服务重启 / 班次刚补出来那几分钟）——
    // 退回按打卡算。宁可多给这一回，也不能因为定时任务没跑就让她白干一宿。
    const 起 = ts(班.打卡At || 班.起)
    const 到 = Math.min(Number(now), ts(班.止))
    分 = Number.isFinite(起) ? Math.max(0, (到 - 起) / 60e3) : 0
  }
  return Math.round((分 / 60) * (Number(班.时薪 || 0) + 加))
}

/** 睡岗罚多少：当天这一班应发的 10%，最低 5 块（少也要疼一下）。 */
export function 睡岗罚款(班, 工, now, 配) {
  const 罚 = 配.罚 || {}
  const 比 = Number(罚.睡岗扣当天比例 ?? 0.1)
  const 底 = Number(罚.睡岗最低扣 ?? 5)
  return Math.max(底, Math.round(应发(班, 工, now) * 比))
}

// ── 执行层：把动作落到文件上 ───────────────────────────────────────────

// WORK_STATE 2026-11-06（批次146）：上班也是「占用型」状态，得写进 自主.json。
//
// 原来 工作.mjs 一个字节都不碰 自主.json，于是三处都在猜她是不是在上班：
//   ① 状态推进.mjs 按 自主.state 判「歇着还是干活」——state 还停在「去上班」「待命」，
//      6 小时班下来体力掉得跟躺着差不多（主人原话：上班不掉体力）；
//   ② 困意.mjs 的 _活动倍速 认 /走动|逛街|打工/，state 不是「打工」就不加速消退；
//   ③ 面板和对话侧看不出她正在上班，只知道「最近做过什么」。
// 只在状态真的变了时写：cron 每分钟一次，每次都整份 save 会跟 自主行动.mjs 抢文件。
function 同步上班(班, now, 在岗) {
  try {
    const p = path.join(MEM, '自主.json')
    if (!fs.existsSync(p)) return false   // 文件不在就不造一份残缺的（跟原来 读(p,null) 同义）
    if (在岗) {
      // SLEEP_WINS 2026-11-06（批次148）：上班时睡着，state 归 睡眠 管，这里不许抢。
      //
      // 实测今晚：她 22:00 打卡，体力一路掉到 7.3、精力 13，00:00 前后必到强制睡线（energy<=8）。
      // 自动作息 会把她放倒在柜台后面（批次107 写的「睡哪儿」），sleep.js 写 state=睡觉；
      // 可这个函数每分钟跑一次，一写「打工」就把「睡觉」盖掉 —— 面板显示在打工、
      // 工作.mjs 自己下一分钟还在判睡岗扣钱，两处说的是两件事。
      // 睡醒后 睡眠.json.live 清掉，下一分钟自然写回「打工」，不用额外补。
      if (睡着(MEM)) return false   // 批次164：判据在 睡态.mjs（它自己带 catch）
      // MEAL_WINS 2026-11-06（批次149）：值班吃一口也写 state=吃饭（吃饭.mjs 的 记自主）。
      // 这里每分钟一写「打工」就盖掉了 —— 面板看不到她在吃东西，doneAt 还从
      //「12 分钟后吃完」跳成「6 小时后下班」。跟睡着同理：正在吃就让给 吃饭.mjs，
      // 吃完 吃饭.json 被删，下一分钟自然写回「打工」。
      try {
        const 饭 = 读(path.join(MEM, '吃饭.json'), {})
        const 到 = 饭 && 饭.到 ? Date.parse(String(饭.到).replace(' ', 'T') + ':00+08:00') : 0
        if (Number.isFinite(到) && 到 > now) return false
      } catch { /* 读不到就当没在吃 */ }
    }
    const 止 = ts(班.止)
    // 批次169：判断和写都挪进锁里。原来是「锁外读 → 判断 → 整份存」，
    // 自主行动 在这几十毫秒里写的 nextAt/state 会被旧副本抹掉。
    const r = 改自主(MEM, (aut) => {
      if (在岗) {
        // 已经在上班就不重复写（这也是「自主行动 把 state 改掉了」的纠正点：
        // 只要 state 不再是「打工」，下一分钟就写回来）
        if (String(aut.state || '') === '打工' && Number(aut.doneAt || 0) === 止) return false
        aut.state = '打工'
        aut.since = now
        aut.form = '线下'
        aut.place = String(班.点 || '')
        aut.doneAt = 止
        aut.last = {
          at: bj(now), what: '打工',
          note: '在' + 班.点 + '上' + 班.活 + '，到 ' + String(班.止).slice(11) + ' 下班',
          feel: '', feelKind: '',
        }
      } else {
        if (String(aut.state || '') !== '打工') return false
        aut.state = '待命'
        aut.since = now
        aut.doneAt = 0
        // 只放行下一件事，不替她定做什么 —— 跟 吃饭.mjs 结算同一个写法
        aut.nextAt = now
      }
    })
    return r !== null
  } catch { return false } // 写不进去不影响考勤
}

function 记事件(工, 文本, now) {
  工.最近 = Array.isArray(工.最近) ? 工.最近 : []
  工.最近.push({ at: bj(now), 啥: 文本 })
  工.最近 = 工.最近.slice(-12)
}

// 迟到扣款。只算「新增」：扣到封顶就不再涨，同一段也不会重复扣。
// 批次145 之前这段逻辑只写在动作执行处，而「人不在店里」那条分支永远进不去——
// 她一到店就打卡了，判定里 `if (在岗)` 先命中，迟到的 else 根本走不到。
function 记迟到(班, 工, 配, 分钟, now) {
  const 档 = Math.floor(Number(分钟) / 5)
  const 每 = Number((配.罚 || {}).迟到每5分钟 ?? 2)
  const 顶 = Number((配.罚 || {}).迟到封顶 ?? 20)
  // FINE_MODEL 2026-11-24：睡岗罚是「当天应发的 10%」，迟到罚却是「每 5 分钟定额 2 块、
  // 封顶 20」—— 同一件事（扣当天工资）两套模型。后果：时薪 60 的家教迟到 30 分钟
  // 只扣 12 块（干 12 分钟就赚回来），时薪 24 的便利店同样扣 12（要干 30 分钟）——
  // 高薪工作几乎无痛，罚不到人身上。
  //
  // 改成「定额」与「按迟到占班次比例折算的应发」取较大者：
  //   · 定额侧：档 × 每（保住「每 5 分钟 2 块」这个可读的旧口径）
  //   · 比例侧：应发 × 迟到比例 × (迟到分钟 / 班次总分钟)
  //     迟到占比越大罚越重，且跟着工资缩放 —— 高薪也不再无痛
  // 两条最后都过 迟到封顶（可预测性），避免一次迟到把整班工资扣光（那是劝退不是教育）。
  // 班次总分钟：用同文件既有的 分钟(str) 解析「HH:MM」；跨零点（22:00→01:00）要 +1440。
  const __到分 = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  const 班分 = (() => {
    const a = __到分(班.起), b = __到分(班.止)
    const d = b > a ? b - a : (b + 1440 - a)
    return d > 0 ? d : (Number(班.时长分钟) || 180)
  })()
  const 应发额 = Math.max(0, Number(应发(班, 工, now)) || 0)
  const 比 = Number((配.罚 || {}).迟到扣应发比例 ?? 0.3)
  const 比例侧 = Math.round(应发额 * 比 * Math.min(1, Number(分钟) / 班分))
  const 应扣 = Math.min(顶, Math.max(档 * 每, 比例侧))
  const 新增 = Math.max(0, 应扣 - Number(班.扣 || 0))
  if (新增 <= 0) return 0
  const 首次 = Number(班.记迟到 || 0) === 0
  班.扣 = Math.min(顶, Number(班.扣 || 0) + 新增)
  班.记迟到 = 分钟
  if (首次) 工.统计.迟到 = Number(工.统计.迟到 || 0) + 1
  工.信用 = Math.max(0, Number(工.信用 || 100) + Number((配.罚 || {}).信用_迟到 ?? -1))
  记班事件(班, '迟到 ' + 分钟 + ' 分钟，扣 ' + 新增, now)
  return 新增
}

/**
 * 每班睡岗次数上限（NAP_CAP 2026-11-24）。
 *
 * 为什么不再是固定 3：各班的「每分钟被发现概率 × 时长」实测期望是
 * 3.0~6.0 次，固定 3 等于让长班每次都打满上限 —— 概率退化成常数。
 * 现在用「期望 × 1.5，最少 6」：
 *   · 期望 3.0（150 分钟班）→ 上限 6
 *   · 期望 4.8（家教 120 分钟 × 4%）→ 上限 7
 *   · 期望 6.0（发传单 120 分钟 × 5%）→ 上限 9
 * 这样「这一班睡几次」才是真的随机；参数表里显式写 睡岗每班上限 仍然优先。
 */
function 睡岗上限(班, 配) {
  const 显式 = Number((配.罚 || {}).睡岗每班上限)
  if (Number.isFinite(显式) && 显式 > 0) return 显式
  const 分 = (() => {
    const __到分 = (s) => { const [h, m] = String(s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0) }
    const a = __到分(班.起), b = __到分(班.止)
    const d = b > a ? b - a : (b + 1440 - a)
    return d > 0 ? d : (Number(班.时长分钟) || 180)
  })()
  const 概率 = Number(班.睡岗每分钟) || 0.02
  const 期望 = 分 * 概率
  return Math.max(6, Math.round(期望 * 1.5))
}

function 记班事件(班, 文本, now) {
  班.记 = Array.isArray(班.记) ? 班.记 : []
  班.记.push({ at: bj(now), 啥: 文本 })
}

function 叫醒() {
  // 只在真的在睡时调。醒来.mjs 会把这一觉结算掉、把 自主.state 从睡觉改待命。
  // stdio 收进管道：沙盒里没有 醒来.mjs 是预期情况，别让它把 ENOENT 喷到 cron 日志。
  try {
    execFileSync(NODE, [path.join(TOOLS, '醒来.mjs')], {
      encoding: 'utf8', timeout: 20e3, stdio: ['ignore', 'pipe', 'pipe'],
    })
    return true
  } catch { return false }
}
export function 跑(opt = {}) {
  const now = Number(opt.now) || Date.now()
  const 掷 = typeof opt.掷 === 'function' ? opt.掷 : Math.random
  const 干跑 = opt.干跑 === true

  const 配 = 读(配P, null)
  if (!配) return { ok: false, 说: '读不到 工作.json' }
  let 工 = 读(工P, null) || 空档()
  for (const k of Object.keys(空档())) if (工[k] === undefined) 工[k] = 空档()[k]
  工.统计 = Object.assign(空档().统计, 工.统计 || {})
  工.统计.完成 = 工.统计.完成 && typeof 工.统计.完成 === 'object' ? 工.统计.完成 : {}
  工.加薪 = 工.加薪 && typeof 工.加薪 === 'object' ? 工.加薪 : {}
  工.班次 = Array.isArray(工.班次) ? 工.班次 : []

  // 2026-11-12 零工制重构：不再默认把所有工作强行塞进「在职」绑成固定合同！
  // 只有显式签了排班（周.length > 0）的才算固定在职；其余全是自由日结零工，随她心意想去哪份就接哪份。
  if (!Array.isArray(工.在职)) {
    工.在职 = Object.entries(配.活 || {}).filter(([, c]) => Array.isArray(c?.周) && c.周.length > 0).map(([k]) => k)
  }

  // ① 补班次：今天和明天该有的都生成（跨夜班要提前存在，不然 06:00 结不了）。
  const 已有 = new Set(工.班次.map((b) => b && b.id))
  let 新生 = 0
  for (const d of [日(now), 次日(日(now))]) {
    for (const b of 该有的班(配, d, null, 工.班次)) {
      if (已有.has(b.id)) continue
      if (!工.在职.includes(b.活)) continue
      工.班次.push(b)
      新生 += 1
    }
  }

  const 资 = 读(path.join(MEM, '资产.json'), { 位置: '家' })
  const 睡眠 = 读(path.join(MEM, '睡眠.json'), {})
  // SINGLE_TRUTH：真在不在睡看 睡眠.json 的 live，睡醒.json 只是镜像。
  const 睡中 = 睡着(MEM)   // 批次164：判据在 睡态.mjs
  const 睡起 = 睡眠 && 睡眠.live && 睡眠.live.start ? ts(String(睡眠.live.start).replace(/:00$/, '')) : 0

  // WORK_STATE 校对：已经在岗的班，每次 tick 把 自主.state 写回「打工」。
  // 判定() 是纯函数（只读局面、返回动作），文件写入必须留在这一层。
  // 这一句挡的是 自主行动 / 手改 / 别的脚本把 state 挪走 —— 挪走一分钟，
  // 状态推进.mjs 就按「歇着」给她回体力（+8/h），夜班白熬。
  if (!干跑) {
    for (const b of 工.班次) {
      if (!b || String(b.状态) !== '在岗') continue
      const 起 = ts(b.起), 止 = ts(b.止)
      if (!(Number.isFinite(起) && Number.isFinite(止) && now >= 起 && now < 止)) continue
      // 批次172：人不在店里就别把 state 按回「打工」。原来这里不看位置，
      // 她 05:54 走回家后每分钟都被按回「打工」，于是六个地方都说她在上班。
      // 不在岗就走 同步上班 的 else 分支，把 state 放回「待命」。
      同步上班(b, now, 算在岗(b, 资, now))
    }
  }

  const 局 = { 配, 工, 资, 睡: 睡中, 睡起: Number.isFinite(睡起) ? 睡起 : 0, now, 掷 }
  const 动作 = 判定(局)
  const 说 = []
  // 一 tick 里只真叫醒一次：判定是拿"这一分钟开始时的睡没睡"算的，
  // 三四个动作同时喊醒会把 醒来.mjs 连跑几遍（每次都结算一次这一觉）。
  let 已叫 = false
  const 醒一次 = () => {
    if (已叫 || !睡中) return false
    已叫 = true
    // WHO_WAKE 2026-11-16（批次553）：她 11-16 一晚上被结束 7 次，最短 30 秒，
    // 而 作息--醒了 的调用栈看不见父进程。这里是「工作」这条路唯一的叫醒口，
    // 真调了就留一笔 —— 下次醒来.log 里要是出现这一行，就是它。
    try {
      const dir = MEM + '/日志'
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const 动作名 = 动作.map((x) => (x && (x.t || x.什么)) || '?').join(',')
      fs.appendFileSync(dir + '/醒来.log',
        bj(now) + ' 工作.mjs 要叫醒她（动作: ' + 动作名 + '，睡中=是）\n')
    } catch { /* 日志失败不影响叫醒 */ }
    return 叫醒()
  }

  for (const a of 动作) {
    const 班 = a.id ? 工.班次.find((b) => b && b.id === a.id) : null
    if (a.t === '打卡' && 班) {
      班.状态 = '在岗'
      班.打卡At = bj(now)
      记班事件(班, '到岗打卡', now)
      说.push('打卡 ' + 班.活)
      // 打卡即占用：这一分钟起 自主.state=打工，体力按「在干活」掉、困意按干活速度退
      if (!干跑) 同步上班(班, now, true)
      // LATE_AT_CLOCK 2026-11-06（批次145）：迟到的判据是「打卡那一刻比班次晚了几分钟」。
      // 原来只在人还没到店时才判，可人到店的那一分钟就打上卡了 —— 实测迟到 20 分钟，
      // 扣款 0、信用 100。现在打卡时立刻结这一笔，之后不再重复扣。
      const 晚 = Math.floor((now - ts(班.起)) / 60e3)
      if (晚 >= 5) {
        const 扣了 = 记迟到(班, 工, 配, 晚, now)
        班.状态 = '在岗'
        if (扣了 > 0) 说.push('迟到 ' + 晚 + ' 分，扣 ' + 扣了)
      }
    } else if (a.t === '病假' && 班) {
      班.状态 = '请假'
      班.请假At = bj(now)
      工.信用 = Math.max(0, Number(工.信用 || 100) + Number((配.罚 || {}).信用_病假 ?? -1))
      工.统计.请假 = Number(工.统计.请假 || 0) + 1
      const 话 = 班.活 + ' 病着请了假（重 ' + Math.round(Number(a.重 || 0) * 100) + '%），信用 -1'
      记班事件(班, 话, now)
      记事件(工, 话, now)
      说.push(话)
    } else if (a.t === '迟到' && 班) {
      // 人一直没到店：每 5 分钟一档，扣到封顶为止。到了之后由上面那条接手。
      const 扣了 = 记迟到(班, 工, 配, a.分钟, now)
      班.状态 = 班.状态 === '在岗' ? '在岗' : '迟到'
      if (扣了 > 0) 说.push('迟到 ' + a.分钟 + ' 分，扣 ' + 扣了)
    } else if (a.t === '睡岗' && 班) {
      // 在家睡过头不能按「当天应发」罚 —— 她压根没上班，应发是 0，按比例罚会变成 0 块。
      // 这种情况罚底价，性质也更像"旷工被扣钱"，不像"在岗被逮"。
      const 款 = a.在家
        ? Number((配.罚 || {}).睡岗最低扣 ?? 5)
        : 睡岗罚款(班, 工, now, 配)
      班.睡岗次数 = Number(班.睡岗次数 || 0) + 1
      班.扣 = Number(班.扣 || 0) + 款
      工.信用 = Math.max(0, Number(工.信用 || 100) + Number((配.罚 || {}).信用_睡岗 ?? -3))
      工.统计.睡岗 = Number(工.统计.睡岗 || 0) + 1
      const 话 = a.在家
        ? '上班时间人在' + String(资.位置 || '家') + '睡着，' + a.因 + '，扣 ' + 款
        : '在' + 班.点 + '上班时睡着，' + a.因 + '，扣 ' + 款
      记班事件(班, 话, now)
      记事件(工, 话, now)
      说.push(话)
      // 被抓了要真醒 —— 老板不会让她接着睡。但「在家睡过头」不叫醒：
      // 她可能本来就在自己的床上，叫醒是主人/群里的事，不是老板能做的。
      if (!a.在家) 醒一次()
    } else if (a.t === '吵醒') {
      工.统计.吵醒 = Number(工.统计.吵醒 || 0) + 1
      记事件(工, '在' + a.点 + '睡着，' + a.因 + '，被吵醒了', now)
      说.push('在' + a.点 + '被吵醒')
      醒一次()
    } else if (a.t === '被赶') {
      记事件(工, '在' + a.点 + '睡了 ' + a.分钟 + ' 分钟，' + a.因 + '，被赶出来了', now)
      说.push('在' + a.点 + '被赶')
      醒一次()
    } else if (a.t === '结算' && 班) {
      const 打卡 = String(班.打卡At || '')
      const 应 = 打卡 ? 应发(班, 工, now) : 0
      const 扣 = Number(班.扣 || 0)
      const 净 = Math.max(0, 应 - 扣)
      if (!打卡 && 班.状态 === '请假') {
        // 病假结掉：不算缺勤、不发钱，班次收口。
        班.状态 = '完成'
        班.应发 = 0
        班.实发 = 0
        说.push(班.活 + ' 病假结束')
      } else if (!打卡 && 班.临时) {
        // 单日临时工没去打卡：自动视作放弃这单零工，不扣信用、不扣钱！
        班.状态 = '完成'
        班.应发 = 0
        班.实发 = 0
        记事件(工, '临时零工「' + 班.活 + '」改主意没去，已自动取消（不扣信用）', now)
        说.push(班.活 + ' 临时取消')
      } else if (!打卡) {
        班.状态 = '缺勤'
        工.信用 = Math.max(0, Number(工.信用 || 100) + Number((配.罚 || {}).信用_缺勤 ?? -10))
        工.统计.缺勤 = Number(工.统计.缺勤 || 0) + 1
        工.统计.连清 = 0
        记事件(工, 班.活 + ' 整班没去（' + 班.起.slice(11) + '-' + 班.止.slice(11) + '），信用 -10', now)
        说.push(班.活 + ' 缺勤')
      } else {
        班.状态 = '完成'
        // 结算用的是累计的真在岗分钟（见 判定 里的 ONDUTY_MIN），不再用「打卡到下班」
        班.在岗分钟 = 班.在岗计过
          ? Math.round(Number(班.在岗分钟 || 0))
          : Math.round((Math.min(now, ts(班.止)) - ts(打卡)) / 60e3)
        班.应发 = 应
        班.实发 = 净
        工.统计.出勤 = Number(工.统计.出勤 || 0) + 1
        工.统计.完成[班.活] = Number(工.统计.完成[班.活] || 0) + 1
        if (扣 === 0) {
          工.统计.连清 = Number(工.统计.连清 || 0) + 1
          工.信用 = Math.min(Number((配.罚 || {}).信用满分 ?? 100), Number(工.信用 || 100) + Number((配.罚 || {}).信用_全勤 ?? 1))
        } else {
          工.统计.连清 = 0
        }
        // 加薪：同一份活干满 N 班，时薪 +2（有上限）。奖励不是白给，是"干熟了"。
        const 每 = Number((配.奖 || {}).加薪每班 ?? 10)
        const 顶 = Number((配.奖 || {}).加薪上限 ?? 10)
        const 干了 = Number(工.统计.完成[班.活] || 0)
        const 应加 = Math.min(顶, Math.floor(干了 / 每) * Number((配.奖 || {}).加薪金额 ?? 2))
        if (应加 > Number((工.加薪 || {})[班.活] || 0)) {
          工.加薪[班.活] = 应加
          记事件(工, 班.活 + ' 干满 ' + 干了 + ' 班，时薪涨到 ' + (Number(班.时薪) + 应加) + ' 块', now)
        }
        // 全勤奖：连续 N 班没被罚过一次。
        const 全勤标 = Number((配.奖 || {}).全勤周奖金 ?? 60)
        if (工.统计.连清 > 0 && 工.统计.连清 % 7 === 0) {
          工.统计.奖金 = Number(工.统计.奖金 || 0) + 全勤标
          工.信用 = Math.min(Number((配.罚 || {}).信用满分 ?? 100), Number(工.信用 || 100) + Number((配.奖 || {}).全勤周信用 ?? 5))
          记事件(工, '连着 7 班没被罚，全勤奖 ' + 全勤标 + ' 块', now)
          说.push('全勤奖 ' + 全勤标)
        }
        if (净 > 0) {
          // LOCK_RMW 2026-11-08（批次260）：工资入账改成「锁内重读 → 改 → 写」。
          // 原来是 读 → 改 → 存，存的锁只护住「写」那一下，读和写之间撞上别的入账
          // （门票、房间、她自己的开销）就各丢一笔。沙盒 20 并发实测：现状丢 9~11 块，
          // 改档 丢 0。判据在 _锁.mjs + _底层.改档，别在别处再写一份。
          const 入账 = (a) => {
            a.钱 = Number(a.钱 || 0) + 净
            a.记录 = Array.isArray(a.记录) ? a.记录 : []
            a.记录.push({ at: bj(now), what: '上班：' + 班.活 + '（' + 班.在岗分钟 + ' 分钟，' + 净 + ' 块' + (扣 ? '，扣了 ' + 扣 : '') + '）' })
            if (a.记录.length > 200) a.记录 = a.记录.slice(-200)
          }
          if (!干跑) 改档(path.join(MEM, '资产.json'), 入账, { 钱: 0, 记录: [] })
        }
        说.push(班.活 + ' 结算 +' + 净 + (扣 ? '（扣 ' + 扣 + '）' : ''))
      }
      // 下了班就不再占用她：state 从「打工」放回待命，nextAt 放行。
      // 缺勤也要清 —— 不然她人没去、state 却挂一整天「打工」，体力一直按干活掉。
      if (!干跑) 同步上班(班, now, false)
      // 辞退：信用归零。她得自己重新去找活 —— 系统不替她安排。
      if (Number(工.信用 || 0) <= Number((配.罚 || {}).辞退线 ?? 0)) {
        工.在职 = 工.在职.filter((x) => x !== 班.活)
        工.信用 = 0
        记事件(工, '信用掉到 0，' + 班.活 + ' 把她辞了', now)
        说.push(班.活 + ' 被辞退')
      }
    }
  }

  // 班次只留最近 7 天，这是记录不是档案。
  const 线 = now - 8 * 86400e3
  工.班次 = 工.班次.filter((b) => b && ts(b.止) > 线).slice(-60)

  if (!干跑) 存(工P, 工)
  return { ok: true, 动作, 说, 新生, 睡: 睡中, 位置: String(资.位置 || ''), 信用: 工.信用 }
}

// ── CLI ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const 有 = (k) => args.includes(k)
const val = (k, d = '') => { const i = args.indexOf(k); return i >= 0 ? String(args[i + 1] ?? d) : d }

// 批次172：只有直接 `node 工作.mjs` 才跑主流程。
// 原来没有这层判断 —— 任何脚本 import 这个模块（测试、自检）都会把命令行分支
// 跑一遍；父进程参数里正好有 --tick 就真去打卡/结算了。
const 是主 = !!(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
if (是主 && 有('--tick')) {
  const r = 跑({})
  if (!r.ok) { console.log(r.说); process.exit(0) }
  // --quiet：cron 每分钟跑，没事就别往日志里刷。
  if (!有('--quiet') || r.说.length) {
    console.log('[' + bj(Date.now()) + '] ' + (r.说.length ? r.说.join('；') : '没事') + '（信用 ' + r.信用 + '，位置 ' + r.位置 + (r.睡 ? '，在睡' : '') + '）')
  }
} else if (是主 && 有('--班')) {
  const 工 = 读(工P, 空档())
  const t = 日(Date.now())
  const 今 = (工.班次 || []).filter((b) => b && (String(b.起).startsWith(t) || String(b.止).startsWith(t)))
  if (!今.length) console.log('今天没班')
  for (const b of 今) {
    console.log(b.起.slice(11) + '-' + b.止.slice(11) + ' ' + b.活 + ' @' + b.点 + ' · ' + b.状态 + (b.扣 ? ' · 扣 ' + b.扣 : '') + (b.睡岗次数 ? ' · 睡岗 ' + b.睡岗次数 + ' 次' : ''))
  }
} else if (是主 && 有('--看')) {
  const 工 = 读(工P, 空档())
  const s = 工.统计 || {}
  console.log('在职：' + (工.在职 || []).join('、'))
  console.log('信用：' + 工.信用 + '/100　出勤 ' + (s.出勤 || 0) + '　缺勤 ' + (s.缺勤 || 0) + '　迟到 ' + (s.迟到 || 0) + '　睡岗 ' + (s.睡岗 || 0) + '　被吵醒 ' + (s.吵醒 || 0))
  console.log('连着没被罚：' + (s.连清 || 0) + ' 班　累计奖金 ' + (s.奖金 || 0) + ' 块')
  const 加 = Object.entries(工.加薪 || {}).filter(([, v]) => Number(v) > 0)
  if (加.length) console.log('加薪：' + 加.map(([k, v]) => k + ' +' + v).join('、'))
  for (const e of (工.最近 || []).slice(-6)) console.log('  ' + e.at + '  ' + e.啥)
} else if (是主 && 有('--临时')) {
  // TEMP_SHIFT 2026-11-06（批次146）：发传单这类「不排班」的活原来没有入口。
  //   · 缺口 只留它当临时工（排了班的三活走班次），可「去打工」那一票从来是 0；
  //   · 到了 打工点 也没有任何动作能开工；
  //   · 挣钱只剩 花钱.mjs --打工，那条已经停了（批次145）。
  // 结果：这条活在系统里等于不存在（工作.json 里 周:[] 就注定了）。
  //
  // 现在它跟正经班次走同一套考勤：人已经在招工点 → 起一个「现在开始、时长按时段算」的班，
  // 之后的每分钟在岗、迟到、睡岗、结算一个不少。想去就去，干多久拿多久的钱。
  const 活 = String(val('--活') || '').trim()
  const 配 = 读(配P, null)
  const 工 = 读(工P, null) || 空档()
  const 资 = 读(path.join(MEM, '资产.json'), { 位置: '家' })
  const c = 活 ? (配 && 配.活 || {})[活] : null
  if (!c) {
    console.log('没有这个活：' + (活 || '（空）') + '。能开的有：' + Object.keys((配 && 配.活) || {}).join('、'))
    process.exit(0)
  }
  const 位 = String(资.位置 || '')
  if (位 !== String(c.点 || '')) {
    console.log('人在' + 位 + '，不在' + c.点 + '，开不了' + 活)
    process.exit(0)
  }
  工.班次 = Array.isArray(工.班次) ? 工.班次 : []
  const 活着的 = 工.班次.find((b) => b && b.活 === 活 && !['完成', '缺勤', '辞退'].includes(String(b.状态)))
  if (活着的) {
    console.log('还有一班' + 活 + '没结（' + 活着的.状态 + '，到 ' + 活着的.止 + '）')
    process.exit(0)
  }
  const now = Date.now()
  const 指定分 = Number(val('--分钟') || 0)
  let 分 = 指定分 >= 30 ? Math.min(360, Math.round(指定分)) : (Number(c.时长分钟) || (分钟(c.止) - 分钟(c.起)))
  if (分 <= 0) 分 += 24 * 60
  const 止 = now + 分 * 60e3
  const b = {
    id: 活 + '-' + 日(now).replace(/-/g, '') + '-' + bj(now).slice(11).replace(':', '') + '-临',
    活,
    点: String(c.点 || ''),
    起: bj(now),
    止: bj(止),
    时薪: Number(c.时薪) || 0,
    睡岗每分钟: Number(c.睡岗每分钟) || 0.02,
    状态: '待上',
    打卡At: '',
    在岗分钟: 0,
    扣: 0,
    睡岗次数: 0,
    记迟到: 0,
    临时: true,
    记: [{ at: bj(now), 啥: '临时工开班（' + 分 + ' 分钟）' }],
  }
  工.班次.push(b)
  存(工P, 工)
  const r = 跑({ now })
  console.log('开了临时工：' + 活 + ' @' + b.点 + '，' + 分 + ' 分钟（到 ' + b.止.slice(11) + '）'
    + (r && r.说 && r.说.length ? '；' + r.说.join('；') : ''))
} else if (是主 && 有('--打卡')) {
  const r = 跑({})
  console.log(r.说.length ? r.说.join('；') : '这一分钟没什么可打卡的')
} else if (是主 && 有('--下班')) {
  // 支持随时提前收工下班（特别是单日临时工：干了多久就结多久的日结工资，立刻恢复自由身！）
  const 工 = 读(工P, 空档())
  const now = Date.now()
  const 在上 = (工.班次 || []).find((b) => b && !['完成', '缺勤', '辞退'].includes(String(b.状态)) && ts(b.起) <= now)
  if (在上) {
    在上.止 = bj(now)
    存(工P, 工)
  }
  const r = 跑({ now })
  console.log(r.说.length ? r.说.join('；') : '这会儿没有正在上的班')
} else if (是主) {
  console.log('用法：--tick [--quiet] / --班 / --看 / --打卡 / --下班')
}
