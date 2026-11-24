/**
 * go.js —— 注册 qq_go：她自己迈腿。
 *
 * 批次106（2026-11-06）：主人截图报「嘴上说着 实际没动」。
 * 00:01 她说「行了，这就走」，00:15 说「走着呢」，00:16 面板还写着
 * 「她现在在便利店」，资产.json 里 在途=undefined、位置没变。
 *
 * 查下来不是她说谎 —— 她 15 个工具里**没有一个能让她动**：
 * qq_send 只管嘴、qq_status 只改那行签名。搬人的只有两个 cron
 * （缺口.mjs 每 30 分钟、自主行动.mjs 每分钟挑动作），都不听她说话。
 * 也就是说：她连「迈腿」这个动作都不存在，只能在嘴上答应。
 *
 * 这个工具把腿还给她：调它 → 走路.mjs --去 X → 资产.在途 真的出现，
 * 面板显示「正在去X的路上，还剩N分钟」，到点 cron 结算、位置才变。
 *
 * 判断权在她：走不走、去哪、什么时候走，都由她调不调这个工具决定。
 * 系统不按她的话正则搬人（「滚」= 回滚 那次教训：正则判语义 47 条里几乎全错），
 * 只在她真的调的时候执行。
 */
import { readFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { note, serviceOf } from './env.js'
// SLEEP_ONE 2026-11-07（批次168）：判睡眠只问这一处（它再转调 工具/睡态.mjs）
import { 睡着 } from './sleepgate.js'
// EAT_DRINK 2026-11-16（批次551）：「咖啡」不能配「吃」。判据只有一份，在 在干嘛.mjs。
const { 吃喝动词 } = await import((process.env.QQ_WORKSPACE || process.cwd()) + '/共享/工具/在干嘛.mjs')
const 跑 = promisify(execFile)

// SANDBOX：测试要把两个目录都指走。走路.mjs 自己认 QQ_AUTONOMY_MEM，
// 所以调它的时候必须显式把同一个值传下去，不然它会写真目录。
const 记忆目录 = () => process.env.QQ_GO_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`
const 工具目录 = () => process.env.QQ_GO_TOOLS || `${QQ_WS}/共享/工具`

const 读档 = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
// MOVE_SINGLE 2026-11-07（批次166）：这里的 存档() 删了 —— 它只被下面第 8 步的
// 「同步自主」用过，那一步整段交给 走路.mjs → 移动.出发() 了。
// 留着的坏处不是多几行：它的临时名不带随机、也没有锁，跟 移动.mjs 的 改档() 是两套写法，
// 下一个改字段的人只会改一处，另一处就静默过期。

/** 地图上能去的地方。读一份，不在插件里另抄一遍名单。 */
export function 地点表(工具 = 工具目录()) {
  const m = 读档(join(工具, '地图.json'), { 地点: {} })
  const 表 = (m && m.地点) || m || {}
  return Object.keys(表)
}

/**
 * 走一趟。opt 里 mem / tools / now 都可以覆盖，供测试指沙盒。
 * 不抛异常：走不成都返回 { ok:false, why, message }，话是给她看的话。
 */
export async function 走一趟(where, opt = {}) {
  const now = Number(opt.now) || Date.now()
  const mem = opt.mem || 记忆目录()
  const tools = opt.tools || 工具目录()
  const 到 = String(where ?? '').trim()

  const 资产 = 读档(join(mem, '资产.json'), { 位置: '家' })
  const 位 = String(资产.位置 || '家')
  const 途 = 资产.在途 || null

  // 1) 已经在路上：路上改不了道，先到再说
  if (途 && 途.arriveAt && now < Number(途.arriveAt)) {
    const 剩 = Math.max(1, Math.ceil((Number(途.arriveAt) - now) / 60e3))
    return { ok: false, why: 'onTheWay', message: `你还在去${途.to}的路上，还有 ${剩} 分钟。到了再改主意` }
  }

  const 名单 = 地点表(tools)
  // 2) 没说要走
  if (到 === '') {
    return { ok: false, why: 'noWhere', message: '要去哪儿？给个地名。能去的是：' + 名单.join('、') }
  }

  // 3) 洗澡：手上是水，门还没出就一身沫
  const 卫生 = 读档(join(mem, '卫生.json'), {})
  const 洗到 = Date.parse(String(卫生?.洗澡中?.结束 || '').replace(' ', 'T') + ':00+08:00')
  if (Number.isFinite(洗到) && 洗到 > now) {
    const 剩 = Math.max(1, Math.round((洗到 - now) / 60e3))
    return { ok: false, why: 'showering', message: `你正在洗澡，还有 ${剩} 分钟出来 —— 擦干了再走` }
  }

  // 3.5) 正在吃饭（批次144）：坐下来吃是要时间的，饭还没吃完就站起来走不合适。
  // 「吃」以前是一瞬间的事，加了时长之后必须先挡一下 —— 不然她一边说在吃火锅，
  // 一边被 qq_go 搬去便利店，主人一看面板就知道对不上。
  const 饭 = 读档(join(mem, '吃饭.json'), null)
  const 饭到 = 饭 ? Date.parse(String(饭.到 || '').replace(' ', 'T') + ':00+08:00') : 0
  if (Number.isFinite(饭到) && 饭到 > now) {
    const 剩 = Math.max(1, Math.round((饭到 - now) / 60e3))
    return { ok: false, why: 'eating', message: `你正坐在${饭.在哪 || '家'}${吃喝动词(饭.吃啥)}${饭.吃啥}，还有 ${剩} 分钟 —— ${吃喝动词(饭.吃啥)}完再走` }
  }

  // 4) 睡着 / 打瞌睡：这时候说走，多半是梦话
  // SLEEP_ONE 2026-11-07（批次168）：判据问 sleepgate → 工具目录的 睡态.mjs。
  // 原来读 自主.state 里有没有「睡」字 —— 那是派生字段：状态推进 每 15 分钟才刷一次，
  // 工作结算 / 自主行动 还会把它写回别的值。
  // 反过来的坑更疼：她明明醒了（睡醒.json=false），state 还挂着「睡觉」，
  // 这个守卫就不让她走 —— 主人看到的是「说醒了，可她说走不动」。
  if (await 睡着(mem, tools)) {
    return { ok: false, why: 'sleeping', message: '你已经睡着了 —— 醒了再走，别梦游' }
  }

  // 5) 地图上没有这个地方
  if (!名单.includes(到)) {
    return { ok: false, why: 'unknown', message: `地图上没有「${到}」。能去的是：` + 名单.join('、') }
  }

  // 6) 已经在这儿了
  if (到 === 位) {
    return { ok: false, why: 'already', message: `你就在${位}，不用走` }
  }

  // 7) 真走。走路.mjs 负责算路、写 在途、算到达时刻
  let out = ''
  try {
    const r = await 跑(process.execPath, [join(tools, '走路.mjs'), '--去', 到], {
      encoding: 'utf8',
      env: { ...process.env, QQ_AUTONOMY_MEM: mem },
      timeout: 15e3,
    })
    out = String(r.stdout || '').trim()
  } catch (e) {
    out = String((e && (e.stdout || e.message)) || '').trim()
  }

  // 判成功只看结果文件，不看它打印了什么 —— 输出改了不该让她白走一趟
  const 后 = 读档(join(mem, '资产.json'), {})
  const 新途 = 后.在途 || null
  if (!新途 || String(新途.to) !== 到) {
    return { ok: false, why: 'failed', message: out || `没走动 —— 可能是${到}这会儿去不了` }
  }

  const 分钟 = Math.max(1, Math.round((Number(新途.arriveAt) - now) / 60e3))
  const 到点 = new Date(Number(新途.arriveAt) + 8 * 3600e3).toISOString().slice(11, 16)

  // 8) 同步自主状态：不在这儿做了（批次166）。
  //    走路.mjs --去 现在自己调 移动.出发()，写的六个字段
  //    （state / since / form / place=出发地 / doneAt / nextAt=到达+30s）
  //    跟这里原来那份【逐字相同】—— 同一件事写两遍，改一份就分叉。
  //    删掉是安全的：上面确认过 新途 真的出现，说明 走路.mjs 跑成功了，
  //    它的同步已经落盘；这里再写一遍只会覆盖成同样的值。

  // 关门提示直接从它说的话里带出来：这个点关着门，但去不去她自己定
  const 关门 = (out.match(/（[^）]*关[^）]*）/) || [])[0] || ''
  return {
    ok: true,
    why: 'walking',
    minutes: 分钟,
    arriveAt: Number(新途.arriveAt),
    message: `从${位}往${到}走，路上 ${分钟} 分钟，大约 ${到点} 到${关门}`,
  }
}

/** 注册 qq_go：她自己挪地方。 */
export async function registerGoTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    // 早期几次 apply 里 ctx.tools 还没就绪（其他 14 个工具同样会撞），
    // 这次不成不影响后面 —— 跟它们一样只记一笔，不抛。
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      return note('tool', 'registerGoTool: no tools service')
    }

    const disposeTool = tools.register(
      {
        name: 'qq_go',
        description: "迈腿去地图上的另一个地方，在途按真实分钟走。",
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            where: {
              type: 'string',
              description: '地名：家、便利店、咖啡店、街市、公园、图书馆、水族馆、海边。',
            },
          },
          required: ['where'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              minutes: { type: 'number' },
              arriveAt: { type: 'number' },
            },
            required: ['ok', 'message'],
          },
          render: (args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        execute: async (args) => {
          const r = await 走一趟(args?.where)
          return {
            ok: !!r.ok,
            message: String(r.message || ''),
            minutes: Number(r.minutes || 0),
            arriveAt: Number(r.arriveAt || 0),
          }
        },
      }
    )

    // 成功也留一条 —— 没有它，光看「no tools service」根本分不清到底是
    // 全都失败了（她没腿）还是最后一次成了（只是前面几次赶时间）。
    note('tool', 'qq_go registered')
    return disposeTool
  } catch (err) {
    note('tool', 'registerGoTool failed: ' + String(err && err.message || err))
  }
}
