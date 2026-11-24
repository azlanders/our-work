/**
 * money.js —— 注册 qq_money：她的钱包（批次136）
 *
 * 主人 11-06 选「给全的」：能自己买吃的、买衣服。
 * 在这之前她真没有花钱的口子 ——「我这边动不了钱」是真话，
 * 消费全靠 缺口/活动 那些自动流程替她挑。
 *
 * 判断权在她：买什么、买不买、什么时候买，都由她调不调这个工具决定。
 * 系统不替她挑（不按心情推「你该吃火锅了」），也不替她拦（除了余额和售卖点这两条硬事实）。
 *
 * 和 qq_item 的分工：
 *   · qq_item  = 东西（伞、杯子、衣服）—— 能拿、能放、能还、能长期留着
 *   · qq_money = 吃渴（饭、咖啡、糖）—— 当场消费，吃完就没了
 *
 * 判成功看 资产.钱 和 资产.记录，不看脚本打印了什么。
 */
import { readFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { note, serviceOf } from './env.js'

const 跑 = promisify(execFile)

const 记忆目录 = () => process.env.QQ_MONEY_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`
const 工具目录 = () => process.env.QQ_MONEY_TOOLS || `${QQ_WS}/共享/工具`
const 读档 = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }

/**
 * 把「这个月 / 上个月 / 2026-10 / -2」翻成 钱账.mjs --月 认的写法（批次435）。
 *
 * 为什么不直接把这串字递给脚本：`钱账.mjs` 只认 `-N` 和 `YYYY-MM`，而她会说「上个月」。
 * 翻译放在这一层，脚本那边保持一个窄接口。
 */
export function 月号(输入) {
  const t = String(输入 ?? '').trim()
  if (/^-\d+$/.test(t)) return t // 脚本自己的相对写法，原样递过去
  if (/^\d{4}-\d{1,2}$/.test(t)) {
    const [y, m] = t.split('-')
    return y + '-' + String(m).padStart(2, '0') // 2026-1 → 2026-01
  }
  if (t === '上个月' || t === '上月') return '-1'
  if (t === '上上个月' || t === '上上月') return '-2'
  // 「这个月 / 本月 / 不填」都按北京时间当月 —— 用服务器本地月份会在月初错一个月
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 7)
}

/**
 * 调 钱账.mjs 看某个月的进出（批次435）。
 *
 * 这个脚本 2026-11-14 就写好了（`--月` 支持 `-1`/`-2`/`YYYY-MM`/`--细`），
 * 但**没有任何工具层入口** —— 她问「我上个月花了多少」，系统里没有一条路能答。
 * 现在接在 qq_money 的 action='账' 上。
 *
 * 边界必须说清：`资产.记录` 是**滚动 200 条**（2026-11-14 实测最早 11-03），
 * 所以比 11-03 更早的账**根本不存在**，不是算错。她在描述里被要求「答不出就说答不出」。
 */
async function 调账(月, 细) {
  const tools = 工具目录()
  const mem = 记忆目录()
  const argv = [join(tools, '钱账.mjs'), '--月', String(月)]
  if (细) argv.push('--细')
  try {
    const r = await 跑(process.execPath, argv, {
      encoding: 'utf8',
      env: { ...process.env, MONEY_MEM: mem },
      timeout: 25e3,
    })
    return String(r.stdout || '').trim()
  } catch (e) {
    return String((e && (e.stdout || e.message)) || '').trim()
  }
}

async function 调(参数, opt = {}) {
  const tools = opt.tools || 工具目录()
  const mem = opt.mem || 记忆目录()
  try {
    const r = await 跑(process.execPath, [join(tools, '花钱.mjs'), ...参数], {
      encoding: 'utf8',
      env: { ...process.env, QQ_AUTONOMY_MEM: mem },
      timeout: 25e3,
    })
    return String(r.stdout || '').trim()
  } catch (e) {
    return String((e && (e.stdout || e.message)) || '').trim()
  }
}

/** 商店清单：只读，按售卖点筛过的才给。 */
function 清单(mem) {
  const 店 = 读档(join(工具目录(), '商店-生活.json'), { 商品: {} })
  const 资 = 读档(join(mem, '资产.json'), {})
  const 位 = String(资.位置 || '家')
  const 商品 = 店.商品 || {}
  const out = []
  for (const [名, it] of Object.entries(商品)) {
    if (!it || typeof it !== 'object') continue
    const 点 = Array.isArray(it.售卖点) ? it.售卖点 : []
    // 售卖点为空＝任意；家只放行吃/零食/喝（外卖），跟 花钱.mjs 的规则一致
    const 能买 = 点.length === 0 ? true : 点.includes(位)
    const 家特例 = 位 === '家' && ['吃', '零食', '喝'].includes(String(it.类别 || ''))
    if (!能买 && !家特例) continue
    out.push({ 名, 价: Number(it.价 || 0), 说明: String(it.说明 || it.效果说明 || '') })
  }
  return { 位, 钱: Number(资.钱 || 0), 商品: out.sort((a, b) => a.价 - b.价) }
}

export async function 看钱(opt = {}) {
  const mem = opt.mem || 记忆目录()
  const { 位, 钱, 商品 } = 清单(mem)
  if (!商品.length) return { ok: true, message: `现在有 ${钱} 块。${位}这儿没有卖吃的的。` }
  const 几句 = 商品.slice(0, 10).map((x) => `${x.名} ${x.价} 块`).join('、')
  return {
    ok: true,
    message: `现在有 ${钱} 块。${位}能买到：${几句}${商品.length > 10 ? `……（共 ${商品.length} 样，想知道哪样就说「价 名字」）` : ''}`,
  }
}

export async function 问价(名, opt = {}) {
  const what = String(名 || '').trim()
  if (!what) return { ok: false, message: '想问哪样的价？' }
  const mem = opt.mem || 记忆目录()
  const { 商品, 钱, 位 } = 清单(mem)
  const 命中 = 商品.filter((x) => x.名.includes(what) || what.includes(x.名))
  if (!命中.length) return { ok: false, message: `${位}这儿没有「${what}」。` }
  const x = 命中[0]
  return { ok: true, message: `${x.名} ${x.价} 块${x.说明 ? ' —— ' + x.说明 : ''}。你现在有 ${钱} 块。` }
}

export async function 买东西(名, opt = {}) {
  const what = String(名 || '').trim()
  if (!what) return { ok: false, message: '想买什么？' }
  const mem = opt.mem || 记忆目录()
  const 前 = 读档(join(mem, '资产.json'), {})
  const 前钱 = Number(前.钱 || 0)
  const 前账 = Array.isArray(前.记录) ? 前.记录.length : 0

  const out = await 调(['--买', what], opt)

  const 后 = 读档(join(mem, '资产.json'), {})
  const 后钱 = Number(后.钱 || 0)
  const 后账 = Array.isArray(后.记录) ? 后.记录.length : 0
  // 判据：钱少了或者账本多了一条，才算真买了。脚本打印什么只当话听。
  const 成了 = 后钱 < 前钱 || 后账 > 前账
  if (成了) return { ok: true, message: out || `买了${what}，花了 ${前钱 - 后钱} 块，剩 ${后钱}。` }
  return { ok: false, message: out || `没买成（现在有 ${后钱} 块）` }
}

export async function registerMoneyTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      return note('tool', 'registerMoneyTool: no tools service')
    }

    const disposeTool = tools.register(
      {
        name: 'qq_money',
        description: "零花钱与消费：看=余额与在售，价=问单价，买=买吃喝衣服（堂食坐下吃，带走进包），账=看某月进出。账只记到 2026-11-03，更早的已清掉，问起就直说记不得，别估。",
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: ['看', '价', '买', '账'],
              description: '看=余额和能买啥，价=问价，买=掏钱，账=看某月花费。',
            },
            what: {
              type: 'string',
              description: '东西名，如咖啡、一顿饭、小蛋糕（看 可不填）。',
            },
            // LEDGER_VIEW 2026-11-14（批次435）：钱账.mjs 的 --月 写了 12 天没人调，
            // 因为工具层根本没有这个参数 —— 她问「上个月花了多少」时没有任何一条路能答。
            月: {
              type: 'string',
              description: "账时用：这个月/上个月/2026-10/-2；默认这个月。",
            },
            细: {
              type: 'boolean',
              description: "账时用：是否列每笔明细。",
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
          if (act === '看') return await 看钱()
          if (act === '价') return await 问价(args?.what)
          if (act === '买') return await 买东西(args?.what)
          if (act === '账') {
            const out = await 调账(月号(args?.月), Boolean(args?.细))
            return { ok: out !== '', message: out || '这个月还没有钱进出。' }
          }
          return { ok: false, message: '只能是：看 / 价 / 买 / 账' }
        },
      }
    )

    note('tool', 'qq_money registered')
    return disposeTool
  } catch (err) {
    note('tool', 'registerMoneyTool failed: ' + String((err && err.message) || err))
  }
}
