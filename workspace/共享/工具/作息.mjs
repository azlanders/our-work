#!/usr/bin/env node
// 作息.mjs —— 她自己决定睡不睡，不是钟表决定（2026-11-02，对应主人第五条）
//
// 用法：
//   node 作息.mjs --想睡                      # 她觉得困了，去睡（可半夜、可白天）
//   node 作息.mjs --醒了                      # 醒了；如果之前刚睡过一段，算「回笼觉」里的下一段
//   node 作息.mjs --看看                      # 现在她是什么作息状态
//
// 为什么这么写：
//   · 原来睡眠是写死的两点到九点，那不叫作息，叫门禁。人熬夜、白天补、睡回笼觉都正常。
//   · 但「自由」不等于没账——睡多睡少都要落账：睡够第二天有精神，熬穿第二天就蔫。
//   · 回笼觉就是「一天里好几段睡」，所以睡眠记录改成段列表，一段一条，累加算总时长。
//   · 睡醒标记（睡醒.json）是给桥看的门控：sleeping=true 时群里不 @ 她就不吵她。
import { 写档, 改档 } from './_底层.mjs'
import { saveState, clone } from './_状态.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
// SLEEP_ONE_SEG 2026-11-06（批次121）：判据见 睡眠段.mjs —— 一次觉只该有一条段。
import { 找开着的段 } from './睡眠段.mjs'
import { 精力 } from './恢复目标.mjs'

// SANDBOX 2026-11-06（批次134）：原来写死，测一次 qq_sleep 就写她真实的睡醒标记。
const base = process.env.QQ_SLEEP_MEM || (process.platform === 'win32' ? 'B:/肥鱼/记忆' : '{{BOT_ROOT}}/记忆')
const stateP = join(base, '状态.json')
const sleepP = join(base, '睡眠.json')
const flagP = join(base, '睡醒.json')
const args = process.argv.slice(2)

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)

const now = Date.now()
const bj = new Date(now + 8 * 3600e3)
const stamp = bj.toISOString().slice(0, 16).replace('T', ' ')
const today = bj.toISOString().slice(0, 10)

const sleep = load(sleepP, { records: [], segments: [] })
sleep.segments = Array.isArray(sleep.segments) ? sleep.segments : []
const flag = load(flagP, { sleeping: false })

if (args.includes('--看看')) {
  const open = sleep.segments.filter((s) => !s.end)
  console.log(flag.sleeping ? '现在在睡' : '现在醒着')
  console.log('今天睡了几段：' + sleep.segments.filter((s) => String(s.start || '').startsWith(today)).length)
  if (open.length) console.log('这段还没结束，从 ' + open[open.length - 1].start + ' 开始')
  process.exit(0)
}

if (args.includes('--想睡')) {
  // IDEMPOTENT 2026-11-16（批次550）：**已经在睡就别改 since。**
  //
  // `睡醒.json` 的 `since` 是 `困意.mjs` 算「清醒多久」的起点（它直接决定腺苷那一项）。
  // 这里原来无条件写成当前时刻 —— 于是她**每多喊一次「我要睡了」，清醒时长就被清零一次**。
  //
  // 实测 2026-11-16：主人叫她去睡，她 08:21:35 调了一次 `qq_sleep 睡`、08:23:14 又调一次
  // （都是 ok=true，因为 `作息 --想睡` 无条件把 sleeping 写成 true，工具那条判据就过了）。
  // 两次之后 `since` 从 07:59（她真醒来的时刻）变成了 08:23 —— 那 24 分钟的清醒账凭空消失，
  // 而这正是「她明明熬了一夜、困意却算得很低」的一个来源。
  //
  // 判据只认「有没有开着的段」，不认 flag.sleeping ——
  // 那个标记自己会分叉（08:32 就是 sleeping=false 而段已关、live 已空）。
  // 只认段的话：有段 = 真的有一觉在跑 → 保住 since；没段 = 从醒到睡 → 重置 since。
  const __已在睡 = !!(找开着的段(sleep.segments) || {}).段
  flag.sleeping = true                      // 总要扶正：有段就该是 true
  if (!__已在睡) {
    flag.since = stamp                      // 只有真的从醒到睡才重置清醒起点
  } else {
    console.log('已经在睡了（' + stamp + '），清醒起点保持 ' + String(flag.since || '?') + ' 不动')
  }
  save(flagP, flag)
  // SLEEP_ONE_SEG 2026-11-06（批次121）：自动作息 是**先** startSleep() 再喊我 --想睡，
  // 那条段已经开着了；我以前不管三七二十一又推一条，于是同一次觉在账上变成两条：
  // 一条带 phases 的明细、一条只有起止的影子，差一秒。面板要专门去重、自动作息不敢相加，
  // 全是给这两条擦屁股。现在：有开着的段就用它，没有才新开。
  const 已有段 = 找开着的段(sleep.segments)
  if (已有段.收掉的.length) console.log('顺手收掉 ' + 已有段.收掉的.length + ' 条一直没关的残段')
  if (已有段.段) {
    if (args.includes('--被吵醒')) 已有段.段.woke = true
  } else {
    sleep.segments.push({ start: stamp, end: null, woke: args.includes('--被吵醒') })
  }
  // RMW_GUARD 2026-11-16（批次543）：这里原来是 `save(sleepP, sleep)` ——
  // 把**本进程启动时**读到的整个对象写回去。而 `自主行动` 的顺序是
  // 「先 startSleep() 再喊我 --想睡」，这几十毫秒里只要有人动过 sleeping / live，
  // 这一写就把它盖回旧值。
  // 实测 11-16 凌晨她的 live.start 被重置三次（07:12 → 07:15 → 07:43），
  // 每段只有 3 分钟 / 27 分钟就被「重新开始」，睡够 6 小时这件事永远攒不够。
  // 现在只覆盖 segments 这一个字段；sleeping / live / 欠 一律以文件里最新的为准。
  const 盘 = load(sleepP, null)
  if (盘 && typeof 盘 === 'object') {
    盘.segments = sleep.segments
    save(sleepP, 盘)
  } else {
    save(sleepP, sleep)   // 真读不到就只能整份写（跟原来一样）
  }
  // THIRST_RESET 2026-11-05：睡前抿了口水——不然睡前清醒太久（渴=100）会一路带进整觉，
  // 睡到一半起来还是满格渴，看着像坏了（主人就在调试页指着这个问过）
  try {
    const stP = join(base, '状态.json')
    const st0 = load(stP, {})
    const __st0快照 = clone(st0)   // 批次173
    st0.body = st0.body && typeof st0.body === 'object' ? st0.body : {}
    st0.body['渴'] = Math.min(25, Number(st0.body['渴'] ?? 0))
    saveState(stP, st0, __st0快照)
  } catch (e) { /* 状态写不进去也别挡着睡觉 */ }
  // 已经在睡就别再说一遍「去睡了」——她调两次 qq_sleep 时那句话会让她以为自己刚躺下
  if (!__已在睡) console.log('去睡了（' + stamp + '）。群里没 @ 她就不会被吵。')
  process.exit(0)
}

if (args.includes('--醒了')) {
  // WAKE_AUDIT 2026-11-16（批次558）：**每一次 --醒了 都留一行**，不管时长。
  // 原来的日志只在「短觉（<60 分钟）」和「自动作息 自家叫醒」时写，于是
  // 08:44 那次（5 分钟被结束）里谁调的，至今查不出来 —— 那时 553 的日志还没上线。
  // 现在连「正常醒来」也记：谁调的（父进程命令行）、带了什么标记、当时开着哪一段。
  try {
    const dirA = join(base, '日志')
    if (!existsSync(dirA)) mkdirSync(dirA, { recursive: true })
    let 父A = ''
    try { 父A = readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 200) } catch { /* 拿不到就算了 */ }
    const __openA = sleep.segments.filter((s) => !s.end)
    const 段A = __openA[__openA.length - 1]
    appendFileSync(join(dirA, '醒来.log'),
      stamp + ' [醒了调用] 父进程: ' + (父A || '(拿不到)')
      + '｜SETTLED=' + String(process.env.QQ_SETTLED || '')
      + '｜EXPLICIT=' + String(process.env.QQ_WAKE_EXPLICIT || '')
      + '｜WAKE_BY=' + String(process.env.QQ_WAKE_BY || '')
      + '｜开着的段: ' + (段A ? String(段A.start) : '(无)') + '\n')
  } catch { /* 日志失败不影响醒 */ }
  // MIN_NAP 2026-11-16（批次552）：**这一觉还不到 5 分钟就别结束。**
  //
  // 实测 2026-11-16 她一晚上被结束 7 次（07:11 30秒 / 07:12 3分 / 07:15 27分 /
  // 07:43 16分 / 08:23 8分 / 08:39 5分 / 08:44 5分），而所有已知的「醒来」路径都不该在
  // 那么短的时候触发：自动作息 要睡够 6 小时或 7.7 小时，工作.mjs 的睡岗要她有班（她 在职: []），
  // qq_sleep 醒 会记工具调用（08:44 没有）。批次544/550b 加的调用栈只能证明「是 作息--醒了 干的」，
  // **看不见是谁调的**（顶层执行，父进程不在栈里）。
  //
  // 所以先止血：5 分钟内不算一觉，拒掉。正常醒来（6 小时以上）不受影响；
  // `醒来.mjs` 正式结算会带 QQ_SETTLED=1（被吵醒/睡岗），也不受这条限制。
  {
    const __open0 = sleep.segments.filter((s) => !s.end)
    const __seg0 = __open0[__open0.length - 1]
    const __m0 = String((__seg0 && __seg0.start) || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/)
    const __起0 = __m0 ? Date.parse(`${__m0[1]}T${__m0[2]}${__m0[3] || ':00'}+08:00`) : NaN
    const __分钟0 = Number.isFinite(__起0) ? Math.round((now - __起0) / 60000) : 9999
    // 门槛 10 分钟，不是 5 —— 实测那几次是 5 分钟（08:39）/5 分钟（08:44），
    // 写 `< 5` 会把它们全放过去（`5 < 5` 是 false）。人不会睡 5~10 分钟就自然醒。
    // 打盹是 20~40 分钟、整觉 6 小时以上，都碰不到这条。
    // WAKE_EXPLICIT 2026-11-16（批次558）：QQ_SETTLED 是「醒来.mjs 正式结算」，
    // QQ_WAKE_EXPLICIT 是「她自己说要醒」（桥的 qq_sleep 醒）。两个都该放行 ——
    // 这条门卫只是防别的脚本误调，不该拦她本人的意思。
    if (__分钟0 < 10 && process.env.QQ_SETTLED !== '1' && process.env.QQ_WAKE_EXPLICIT !== '1') {
      // 把「谁在乱调」记下来（含父进程命令行），但**不改 sleeping、不关段、不动 since**。
      try {
        const dir0 = join(base, '日志')
        if (!existsSync(dir0)) mkdirSync(dir0, { recursive: true })
        let 父 = ''
        try { 父 = readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 180) } catch { /* 忽略 */ }
        appendFileSync(join(dir0, '醒来.log'),
          stamp + ' 拒绝结束：这一觉才 ' + __分钟0 + ' 分钟（父进程: ' + (父 || '拿不到') + '）\n')
      } catch { /* 日志失败也不影响 */ }
      console.log('这一觉才 ' + __分钟0 + ' 分钟，先不结束（可能是别的脚本误调）')
      process.exit(0)
    }
  }
  flag.sleeping = false
  flag.since = stamp
  save(flagP, flag)
  const open = sleep.segments.filter((s) => !s.end)
  const seg = open[open.length - 1]
  // WAKE_TRACE 2026-11-16（批次550b）：**这是关段的第二条路，批次544 只给 endSleep 加了栈。**
  // 实测 08:23 那一觉 8 分钟就结束（segments 08:23:14 → 08:31），而 endSleep 的
  // SHORT_WAKE_TRACE 一行都没写 —— 因为结束它的不是 endSleep，是这里（醒来.mjs 会调 --醒了）。
  // 现在两条路都往 日志/醒来.log 写，格式一致，一眼看出是谁关的。
  const __记短觉 = (分钟, 谁) => {
    try {
      if (!(分钟 < 60)) return
      const dir = join(base, '日志')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const 栈 = String(new Error().stack || '').split('\n').slice(2, 6).map((x) => x.trim()).join(' <- ')
      // WHO_CALLED 2026-11-16（批次552）：栈里只有「作息.mjs:150」和 Node 内部帧 —— 因为
      // 这是顶层直接执行（别人 execFileSync 调它），父进程在栈里根本看不见。
      // 所以去 /proc/<ppid>/cmdline 把父进程的命令行抄下来。以后再短觉，一眼知道是谁。
      let 调用方 = ''
      try {
        调用方 = readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8').split('\0').filter(Boolean).join(' ').slice(0, 180)
      } catch { /* 拿不到就算了 */ }
      appendFileSync(join(dir, '醒来.log'),
        stamp + ' 短觉 ' + 分钟 + ' 分钟被「' + 谁 + '」结束｜父进程: ' + (调用方 || '(拿不到)')
        + '｜叫醒人=' + String(process.env.QQ_WAKE_BY || '(没传)')
        + '｜QQ_SETTLED=' + String(process.env.QQ_SETTLED || '') + '｜调用栈: ' + 栈 + '\n')
    } catch { /* 日志失败不影响关段 */ }
  }
  if (!seg) {
    __记短觉(0, '作息--醒了/没有开着的段')
    // WAKE_CLEAN 2026-11-07（批次168）：这条早退也要把这一觉关干净 ——
    // 段没了不代表 live 没了（qq_sleep 的「醒」原来就是只关段、不清 live）。
    sleep.sleeping = false
    sleep.live = null
    sleep.awakeSince = now
    save(sleepP, sleep)
    console.log('醒来时没有在睡的记录——标记和睡眠段都清干净了')
    process.exit(0)
  }
  seg.end = stamp
  // 关段了就顺手记一笔（短觉才有意义）
  {
    const __起 = (() => {
      const m = String(seg.start || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/)
      return m ? Date.parse(`${m[1]}T${m[2]}${m[3] || ':00'}+08:00`) : NaN
    })()
    if (Number.isFinite(__起)) __记短觉(Math.max(0, Math.round((now - __起) / 60000)), '作息--醒了')
  }
  // 算时长：毫秒差
  // 2026-11-04 修：时间戳可能带秒（endSleep 写的 "07:00:01"），原来一律拼 ":00" 会解析成
  // 非法时间，hours 变 NaN，写进状态就是 null，把 自动作息 刚算好的正确值盖掉。
  const toMs = (s) => {
    const t = String(s || '').trim()
    const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/)
    if (m) return Date.parse(`${m[1]}T${m[2]}${m[3] || ':00'}+08:00`)
    return Date.parse(t)
  }
  const __diff = now - toMs(seg.start)
  const hours = Number.isFinite(__diff) ? Math.max(0, __diff / 3600e3) : 0
  seg.hours = Number(hours.toFixed(2))

  // 一天里所有段加总（含回笼觉）
  const todaySegs = sleep.segments.filter((s) => s.end && String(s.start).startsWith(today))
  const total = Number(todaySegs.reduce((a, s) => a + Number(s.hours || 0), 0).toFixed(2))
  sleep.todayTotalHours = total
  // WAKE_CLEAN 2026-11-07（批次168）：这里原来只给段补 end/hours，不清 live、
  // 也不把 睡眠.json.sleeping 置回 false。走这条路的醒来（qq_sleep 的「醒」
  // 直接调它，不经过 endSleep）会留下一段永不关闭的觉：
  //   · 睡眠阶段.mjs 的 tickSleep 还认 sleeping && live —— 她已经醒了，深睡分钟继续涨；
  //   · 同一个守卫让 startSleep 永远 return fail() —— 她再也睡不着。
  // 沙盒实测：作息 --醒了 之后 startSleep {ok:false}、tickSleep {ok:true,phase:'N3'}。
  // 自然醒（自动作息）与被叫醒（醒来.mjs）都先走 endSleep，到这里 live 已是 null，
  // 所以这两条路上这段是空操作 —— 只在 qq_sleep 那条路上真正生效。
  sleep.sleeping = false
  sleep.live = null
  sleep.awakeSince = now
  save(sleepP, sleep)

  // 接到状态：睡得多提生理，睡太少提困意
  //
  // SETTLE_ONCE 2026-11-06（批次149）：醒来.mjs 已经按这一觉的长度算过体力/情绪/精力，
  // 这里是第二份公式（而且没有时长权重）。同一条规则写两处必然分叉 —— 它今天差点把
  // 2 分钟的觉再按整觉融一遍（那次是被「没有开着的段」提前挡住才没出事）。
  // 带 QQ_SETTLED=1 调进来时只跳过这一段，关段/标记/定计划/早间简报照跑。
  const __已结算 = process.env.QQ_SETTLED === '1'
  const st = load(stateP, {})
  // 批次173：这一份要跨过下面两个 execFileSync（计划 / 早间简报 都可能写 状态.json），
  // 差量基准必须在这一刻留 —— 晚一步就会把子进程刚写的字段按旧值盖回去。
  const __st快照 = clone(st)
  if (!__已结算) {
  const deep = Math.max(0, total * 0.2)
  const rem = Math.max(0, total * 0.22)
  // 2026-11-04 修：原来倍率 300/320，而 deep/rem 是按比例估出来的，
  // 算下来 physical 恒 90、emotional 恒 100，一睡就顶格；再用 Math.max 写回，只升不降。
  // 现在倍率压到 150/140（0.2 深睡→约 65、0.22 REM→约 61），写回改成新旧 4:6 混合，能升也能降。
  const physical = Math.min(100, Math.round(35 + (total > 0 ? deep / total : 0) * 150))
  const emotional = Math.min(100, Math.round(30 + (total > 0 ? rem / total : 0) * 140))
  st.layers = st.layers || {}
  st.layers.physical = Math.round(Number(st.layers.physical || 40) * 0.4 + physical * 0.6)
  st.layers.emotional = Math.round(Number(st.layers.emotional || 40) * 0.4 + emotional * 0.6)
  // ENERGY_SYNC 批次171：这里原来是「生理+情绪 两数平均」，而 状态推进/困意/洗澡 用的是
  // 木桶公式 physical^0.6 × cognitive^0.4 × (0.8+0.4×emotional/100)。
  // 实测她认知 25 时（体力 60 / 情绪 55）：平均 58、木桶 43 —— 睡醒写 58，
  // 10 分钟后 状态推进 一重算变 43，面板上就是「一觉醒来体力掉 15」。
  st.energy = 精力(st.layers)
  st.hoursAwake = 0 // 睡醒清零，睡眠压力重新从 0 算
  } // end if (!__已结算)
  // WAKE_HOME 2026-11-05：睡醒必然在家——睡前可能在街市/公司，不处理就会出现
  // 「刚睡醒但人在游乐园」这种对不上的状态；顺手把在途清掉，别带着半路的账醒来
  // WAKE_PLACE 2026-11-06（批次110）：醒来不再把她瞬移回家。
  // 原来这里是 `a.位置 = '家'` 无条件覆盖：她 00:20 在便利店被强制睡，
  // 00:49 被主人叫醒，一睁眼就被搬到「家」，而 到此At 还停在便利店的 21:49 ——
  // 位置和到达时刻对不上，那段路也没人走过。
  // 睡在哪归 睡在哪.mjs（睡前先回家）、醒来回不回也归她自己（qq_go / 走路.mjs）。
  // 这里只清在途，不动位置：她在哪儿醒，就在哪儿。
  try {
    // 批次578（P0-2 残留）：只清 在途，却整档写回会盖掉并发账目；改用 改档 只改这一格。
    改档(join(base, '资产.json'), (a) => {
      if (a.在途) delete a.在途
    }, { 位置: '家' })
  } catch (e) {
    console.error('醒来清在途失败：' + String((e && e.message) || e).slice(0, 80))
  }
  // 工具目录从 base 推出来（base 末尾是「记忆」）——沙盒测试时自动指向沙盒，不会写到真实目录
  const toolsDir = base.replace(/记忆$/, '共享/工具')
  // WAKE_PLAN 2026-11-05：一睁眼就把今天想做的事定下来，别等下一个 40 分钟的 tick
  try {
    const { execFileSync } = await import('node:child_process')
    execFileSync('/usr/local/bin/node', [join(toolsDir, '计划.mjs'), '--tick', '--强制'], { encoding: 'utf8', timeout: 20000 })
    // WAKE_MORNING 2026-11-05：醒来先把「早」说出去，别等 08:30 那个定时——
    // 她七点醒、八点半才说早，中间那段就像没睡醒也没打招呼。同一天重复写会替换，不会重复。
    try { execFileSync('/usr/local/bin/node', [join(toolsDir, '早间简报.mjs'), '--tick'], { encoding: 'utf8', timeout: 20000 }) } catch (e) { console.log('（早安没说成：' + String(e.message).slice(0, 60) + '）') }
  } catch (e) { console.log('（醒来没定成计划：' + String(e.message).slice(0, 60) + '）') }

  try {
    const a = load(join(base, '资产.json'), {})
    if (String(a.位置 || '') === '家') {
      const clothing = await import(pathToFileURL(join(toolsDir, '穿衣.mjs')).href + '?wake=' + now)
      const changed = clothing.自动按天气换衣(now)
      if (changed) console.log('醒来加衣：' + changed)
    }
  } catch (e) { console.log('（醒来穿衣没调成：' + String(e.message).slice(0, 50) + '）') }

  // 2026-11-04 修：算不出有效时长（段起点缺失/格式坏）时不要写 lastSleep，
  // 否则会用 0 或 NaN 覆盖掉 自动作息 已经写好的结算。
  if (hours > 0.05) st.lastSleep = { end: stamp, hours: Number(hours.toFixed(2)), todayTotal: total }
  saveState(stateP, st, __st快照)

  const how = todaySegs.length > 1 ? `（今天第 ${todaySegs.length} 段，回笼觉也算）` : ''
  console.log(`醒了：这段睡了 ${hours.toFixed(1)} 小时${how}，今天合计 ${total} 小时`)
  process.exit(0)
}

console.log('用法：--想睡 / --醒了 / --看看')
