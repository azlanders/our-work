/**
 * sleep.js —— 注册 qq_sleep：她能真的睡下去（批次134）
 *
 * 主人 11-06 说：「我现在叫她去睡她应了……但是她没睡」。
 * 查下来又是一次「没有腿」：
 *   · 17 个工具里没有一个能让她睡（qq_go 管腿、qq_send 管嘴、qq_photo 管眼、qq_item 管手）；
 *   · 自主行动 里「打瞌睡」只把 state 写成三个字，既不睡也不回血；
 *   · 于是主人叫她去睡，她只能嘴上答应 —— 跟批次106「说了走却不迈腿」同一个坑。
 *
 * 判断权在她：睡不睡、什么时候睡、睡多久，都由她调不调这个工具决定。
 * 系统不因为主人说了一句「去睡」就替她睡（那是代她做决定）。
 *
 * 判成功只看 睡醒.json / 打盹.json，不看脚本打印了什么。
 */
import { readFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { note, serviceOf } from './env.js'
import { 有效感受 } from './有效感受.mjs'

const 跑 = promisify(execFile)

const 记忆目录 = () => process.env.QQ_SLEEP_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`
const 工具目录 = () => process.env.QQ_SLEEP_TOOLS || `${QQ_WS}/共享/工具`
const 读档 = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
const 北京 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 解析 = (s) => {
  const t = String(s || '').trim()
  // PARSE_SECONDS 2026-11-16（批次561）：原来只认 16 字符的 `YYYY-MM-DD HH:MM`。
  // 全项目其他解析（_底层.解析北京 / 作息.toMs / 自动作息.toMs）都认带秒，
  // 班次时间、endSleep 写的段起点都可能是带秒的 —— 只有这里不认就是静默算成 NaN。
  const m = t.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/)
  if (!m) return Number.NaN
  return Date.parse(`${m[1]}T${m[2]}${m[3] || ':00'}+08:00`)
}

// NAP_ONE_SOURCE 2026-11-16（批次561）：**打盹的到点不再自己解析。**
// 这个文件原来有三处 `解析(盹.到)`，只认 16 字符、不认 `到毫秒` —— 而 `到毫秒`
// 是 打盹.mjs `save` 时必写的字段，`睡态.打盹中()` 认的正是它。
// 同一个 打盹.json 于是有三个答案：睡态说在打盹、这里说没在打、--tick 说要醒。
// 现在统一问共享工具的 睡态.盹到点（跟下面 睡眠阶段.mjs 的动态 import 同一个写法）；
// 共享工具目录不在（别的部署）才退回本地三级。
let __盹到点 = undefined
async function 盹到点(n) {
  if (!n || typeof n !== 'object') return 0
  if (__盹到点 === undefined) {
    try {
      const m = await import('file://' + join(工具目录(), '睡态.mjs').replace(/\\/g, '/'))
      __盹到点 = typeof m.盹到点 === 'function' ? m.盹到点 : null
    } catch { __盹到点 = null }
  }
  if (__盹到点) { try { return Number(__盹到点(n)) || 0 } catch { /* 退回本地 */ } }
  const ms = Number(n['到毫秒'])
  if (Number.isFinite(ms) && ms > 0) return ms
  const t = 解析(n['到'])
  if (Number.isFinite(t)) return t
  const s = 解析(n['开始'])
  const mm = Number(n['分钟'])
  return (Number.isFinite(s) && Number.isFinite(mm) && mm > 0) ? s + mm * 60e3 : 0
}

async function 跑脚本(name, argv, opt = {}) {
  const tools = opt.tools || 工具目录()
  const mem = opt.mem || 记忆目录()
  try {
    const r = await 跑(process.execPath, [join(tools, name), ...argv], {
      encoding: 'utf8',
      // WAKE_EXPLICIT 2026-11-16（批次558）：加一个可选的附加 env。
      // 「她自己说要醒」必须能让 作息.mjs 的门卫放行（见下面的 醒过来）。
      env: { ...process.env, QQ_AUTONOMY_MEM: mem, NAP_MEM: mem, QQ_SLEEPY_MEM: mem, ST_BASE: mem, QQ_SLEEP_MEM: mem, ...((opt && opt.env) || {}) },
      timeout: 30e3,
    })
    return String(r.stdout || '').trim()
  } catch (e) {
    return String((e && (e.stdout || e.message)) || '').trim()
  }
}

/** 整觉：先回家，再开睡眠段。不在家就先走，走成了告诉她到家再睡。 */
export async function 睡整觉(opt = {}) {
  const mem = opt.mem || 记忆目录()
  const 资 = 读档(join(mem, '资产.json'), {})
  const 位 = String(资.位置 || '家')
  const 途 = 资.在途
  if (途 && Number(途.arriveAt) > Date.now()) {
    return { ok: false, message: `你还在去${途.to}的路上，到了再说` }
  }
  const 工 = 读档(join(mem, '工作.json'), null)
  const 班 = (工 && Array.isArray(工.班次))
    ? 工.班次.find((b) => {
      if (!b || String(b.状态) !== '在岗') return false
      const a = 解析(b.起), z = 解析(b.止)
      return Number.isFinite(a) && Number.isFinite(z) && Date.now() >= a && Date.now() < z
    })
    : null
  if (班) return { ok: false, message: `你还在${班.点}上班，走不开；真困了可以「眯」一会儿` }

  if (位 !== '家') {
    const out = await 跑脚本('走路.mjs', ['--去', '家'], opt)
    const 后 = 读档(join(mem, '资产.json'), {})
    if (后.在途 && String(后.在途.to) === '家') {
      const 分钟 = Math.max(1, Math.ceil((Number(后.在途.arriveAt) - Date.now()) / 60e3))
      return { ok: true, message: `先回家（路上 ${分钟} 分钟），到了再睡。${out ? '' : ''}` }
    }
    return { ok: false, message: '现在回不去，先在原地歇会儿' }
  }

  // NAP_UPGRADE 2026-11-15（批次499）：整觉和打盹会同时开着。
  // 11-15 03:19 自主行动 让她打盹（到 03:43），03:22 她又 qq_sleep 睡整觉 ——
  // startSleep 不检查 打盹.json，于是 自主.state='打瞌睡' 和 睡眠.json.live 并排跑，
  // 两分钟后整觉就断了（03:22:05 → 03:24），records 一条没进。
  // 她说「我睡了」的时候，打盹该被升级成整觉，不是两个并排。
  {
    const __盹 = 读档(join(mem, '打盹.json'), null)
    if (__盹 && (await 盹到点(__盹)) > Date.now()) {
      try { await 跑脚本('打盹.mjs', ['--醒'], opt) } catch { /* 收不掉也不挡着睡整觉 */ }
    }
  }

  // 跟 自动作息 一样：先开睡眠段（阶段推进要有 live），再写睡醒标记。
  // ST_BASE 是 睡眠阶段.mjs 的沙盒变量，而这个 import 发生在当前进程 ——
  // 临时改一下再恢复，别让宿主进程（dsh-bot）的全局环境带上测试路径。
  const __oldST = process.env.ST_BASE
  process.env.ST_BASE = mem
  // ALREADY_ASLEEP 2026-11-16（批次550）：`startSleep()` 有防重入
  // （`if (data.sleeping) return fail()`），**返回值原来一个字都没看**。
  // 于是她连喊两次「我要睡了」，两次都报成功 —— 因为下面 作息 --想睡 会无条件
  // 把 sleeping 写成 true，工具那条判据就过了。主人看到的「她应了但没睡」就是这么来的。
  let __开成 = null
  try {
    const m = await import('file://' + join(工具目录(), '睡眠阶段.mjs').replace(/\\/g, '/'))
    if (typeof m.startSleep === 'function') __开成 = m.startSleep()
  } catch { /* 阶段开不起来也能睡，只是没有分期的账 */ } finally {
    if (__oldST === undefined) delete process.env.ST_BASE
    else process.env.ST_BASE = __oldST
  }
  // 无论成败都喊一次 —— 作息 --想睡 现在是幂等的（批次550），
  // 它只扶正 sleeping 标记，有开着的段就**保住清醒起点不动**。
  await 跑脚本('作息.mjs', ['--想睡'], opt)

  const flag = 读档(join(mem, '睡醒.json'), {})
  if (flag.sleeping === true) {
    const 已在睡 = __开成 && __开成.ok === false
    return {
      ok: true,
      message: 已在睡
        ? `你已经在睡了（${北京()}），不用再躺一次 —— 清醒起点没被重置。`
        // SLEEP_NOT_YET 2026-11-17（批次684）：回执要把「现在」放在最前 ——
        // 睡下去的那一秒她还是醒着，别让她把这句当成「睡完了」。
        : `现在 ${北京()}，躺下了。睡着以后群里没 @ 就不会吵你。`,
    }
  }
  return { ok: false, message: '没睡成，睡醒标记没写进去' }
}

/** 打盹：20~40 分钟的短睡，不进整觉的账。 */
export async function 眯一会儿(分钟, opt = {}) {
  const mem = opt.mem || 记忆目录()
  const 资 = 读档(join(mem, '资产.json'), {})
  const 位 = String(资.位置 || '家')
  const 途 = 资.在途
  if (途 && Number(途.arriveAt) > Date.now()) return { ok: false, message: `在路上（去${途.to}），到了再眯` }
  // 咖啡馆/图书馆/公园能趴一会儿；马路和店里柜台后面不行 —— 但不是铁律，别处也能坐。
  const 能眯 = ['家', '咖啡店', '图书馆', '公园', '学校', '电影院', '澡堂'].includes(位)
  if (!能眯 && !opt.force) return { ok: false, message: `在${位}不太好睡，回家或者找个能坐的地方` }

  const n = Math.max(10, Math.min(60, Math.round(Number(分钟) || 25)))
  // WHY398 2026-11-14（批次398）：原来这里写死 '自己觉得困'，模型填的 why 一个字都到不了。
  // 打盹.mjs 本来就支持 `--开始 [分钟] [为什么]` 并存进 打盹.json 的「为什么」，
  // 只是工具层从来没把她的原话递下去 —— 又一个「声明了但没接」。
  const 因 = String((opt && opt.why) || '').trim().slice(0, 60) || '自己觉得困'
  const out = await 跑脚本('打盹.mjs', ['--开始', String(n), 因], opt)
  const 盹 = 读档(join(mem, '打盹.json'), null)
  if (盹 && (await 盹到点(盹)) > Date.now()) return { ok: true, message: out || `眯 ${n} 分钟` }
  return { ok: false, message: out || '没眯成' }
}

/** 醒：整觉或打盹都能叫停。 */
export async function 醒过来(opt = {}) {
  const mem = opt.mem || 记忆目录()
  const 盹 = 读档(join(mem, '打盹.json'), null)
  const flag = 读档(join(mem, '睡醒.json'), {})

  // WAKE_NAP_CHECK 2026-11-16（批次561）：**这是批次558 漏掉的另一半。**
  // 文件头自己写着「判成功只看 睡醒.json / 打盹.json，不看脚本打印了什么」，
  // 可这条分支恰恰只看打印：`打盹.mjs --醒` 在「没在打盹」时也输出「没在打盹」并 exit 0，
  // 写档失败时也 exit 0 —— 两种都报「醒了」，而 打盹.json 还挂在那里。
  //
  // 另外批次499 说整觉和打盹会**并排开着**，所以醒要把两条都收掉，不能收完打盹就 return
  // （原来那条 `return` 让整觉分支根本没机会跑）。
  const 在盹 = Boolean(盹) && (await 盹到点(盹)) > Date.now()
  const 在睡 = Boolean(flag) && flag.sleeping === true
  if (!在盹 && !在睡) return { ok: false, message: '你现在本来就醒着' }
  let 话 = ''
  if (在盹) {
    const out = await 跑脚本('打盹.mjs', ['--醒'], opt)
    const 后盹 = 读档(join(mem, '打盹.json'), null)
    // WAKE_FAIL_TEXT 2026-11-16（批次561）：**失败时一个字都不能用脚本的输出当文案。**
    // `打盹.mjs --醒` 成功时打的就是「醒了」两个字；它要是没写成功（或压根没在打盹），
    // `out` 仍然是「醒了」—— 于是 `ok:false` 配一句「醒了」，她读到会以为自己醒了。
    // 失败就是失败：先说没醒成，脚本输出只作附注。
    if (后盹 && (await 盹到点(后盹)) > Date.now()) {
      return { ok: false, message: '没醒成（打盹还在，到 ' + 北京(await 盹到点(后盹)) + ' 才结束）' + (out ? '｜' + out : '') }
    }
    话 = out || '醒了'
  }
  if (在睡) {
    // WAKE_EXPLICIT 2026-11-16（批次558）：**这里原来无条件报成功，是个真账。**
    // 作息.mjs 批次552 加了「不到 10 分钟不许醒」的门卫（防别的脚本误调），
    // 门卫只放行 QQ_SETTLED=1（醒来.mjs 正式结算）。她睡 5 分钟说「我醒了」时
    // 走的就是这一行 —— 门卫把她挡回去、exit 0 输出「先不结束」，而这里照样
    // return ok:true，睡醒.json.sleeping 还是 true：她被告知醒了，其实还睡着。
    // 两条一起改：①带上「本人在醒」的标记，门卫无条件放行；
    // ②回来复查标记，没落下去就如实报失败（别再说「醒了」）。
    const out = await 跑脚本('作息.mjs', ['--醒了'], { ...opt, env: { ...((opt && opt.env) || {}), QQ_WAKE_EXPLICIT: '1' } })
    const 后 = 读档(join(mem, '睡醒.json'), {})
    if (后 && 后.sleeping === true) {
      // 同上：门卫拒绝时 out 是「这一觉才 5 分钟，先不结束」（有意义的附注），
      // 但「没醒成」这三个字必须自己写，不能指望脚本。
      return { ok: false, message: '没醒成（睡醒标记还在）' + (out ? '｜' + out : '') }
    }
    话 = out || 话 || '醒了'
  }
  return { ok: true, message: 话 || '醒了' }
}

/**
 * 今天有没有记过感受。
 * 数据是 记忆/感受.jsonl，每行一条，`at` 是北京时间 `YYYY-MM-DD HH:MM`。
 * 读不到就当没记过（宁可多提一句，也别让这条链再哑三天）。
 */
function 今天记过感受() {
  try {
    const 今 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    const 文 = readFileSync(join(记忆目录(), '感受.jsonl'), 'utf8')
    return 有效感受(文).some((row) => String(row.at || '').startsWith(今))
  } catch { return false }
}

/** 注册 qq_sleep。 */
export async function registerSleepTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      return note('tool', 'registerSleepTool: no tools service')
    }

    const disposeTool = tools.register(
      {
        name: 'qq_sleep',
        // SLEEP_PARAM_FIX 2026-11-14（批次448）：这句描述三处都是错的 ——
        // ① 参数叫 action，不叫 mode（additionalProperties=false，照描述填 mode 直接校验失败）；
        // ② 枚举里没有 '熬'（代码只认 睡/眯/醒），熬夜走的是 记忆/熬夜.json；
        // ③ 真正的第三个值 '醒' 一个字没提 —— 而它是她唯一能自己结束一觉的入口，
        //    6 次真实调用全是「睡」，这个分支从上线起就没人用过。
        description: "真去睡觉、打盹或醒：action='睡'回家睡整觉（要先在家）；'眯'小憩 20~40 分钟（minutes 默认 25）；'醒'起来。只认这三个值。",
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['睡', '眯', '醒'],
              description: '睡=整觉（要先在家），眯=打盹，醒=起来。',
            },
            minutes: {
              type: 'integer',
              description: '打盹分钟数 10~60，默认 25；整觉不用填。',
            },
            why: {
              type: 'string',
              description: '可选；为什么现在睡。',
            },
          },
          required: ['action'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        execute: async (args) => {
          const act = String(args?.action ?? '')
          if (act === '睡') {
            const r = await 睡整觉()
            let message = String(r.message || '')
            // SLEEP_FEEL 2026-11-09（批次340）：把 qq_feel 挂到睡前。
            // 它 142 次工具调用里 0 次 —— 余温槽、夜里自评、关系的即时更新全断在源头。
            // 主人定的方案是「跟睡前绑，一次就够」。这里不追问内容，只提一句，记不记还是她的事。
            if (r.ok && !今天记过感受()) {
              message += '\n\n（今天还没记过感受。要是这会儿心里还留着什么事，调一次 qq_feel 记一笔就够 —— 不记也行。）'
            }
            return { ok: !!r.ok, message }
          }
          if (act === '眯') {
            const r = await 眯一会儿(args?.minutes, { why: String(args?.why ?? '') })
            return { ok: !!r.ok, message: String(r.message || '') }
          }
          if (act === '醒') {
            const r = await 醒过来()
            return { ok: !!r.ok, message: String(r.message || '') }
          }
          return { ok: false, message: '只能是：睡 / 眯 / 醒' }
        },
      }
    )

    note('tool', 'qq_sleep registered')
    return disposeTool
  } catch (err) {
    note('tool', 'registerSleepTool failed: ' + String((err && err.message) || err))
  }
}
