/**
 * items.js —— 注册 qq_item：她的手，能拿能还。
 *
 * 批次128（2026-11-06）：主人说「还伞系统没搞好」。
 * 查下来不是 `物品.mjs --还` 坏了 —— 沙箱实测它完全正常（钱 308→318、伞移除、包更新、账本追加）。
 * 坏的是**她够不到它**：
 *   · 她 17 个工具里没有一个是「东西」（qq_go 管腿、qq_send 管嘴、qq_photo 管眼，没有管手的）；
 *   · 伞到期只能等 `缺口.mjs` 每 30 分钟抽一次签，抽中「还伞」还得人正好站在借伞那家店；
 *   · 于是主人问「伞还了吗」，她只能嘴上答应 —— 跟批次106「说了走却不迈腿」、
 *     批次109「说了拍却没快门」是同一个坑。
 *
 * 判断权在她：还不还、什么时候还、要不要借，都由她调不调这个工具决定。
 * 这里不做「她说了还就替她还」的正则搬家（「滚」=回滚 那次教训）。
 *
 * 判成功只看结果文件，不看脚本打印了什么：
 *   打印是给她看的话，措辞随时会改；物品.json / 资产.json 才是事实。
 */
import { readFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { note, serviceOf } from './env.js'
// SLEEP_ONE 2026-11-07（批次168）：跟 qq_go 同一处判据
import { 睡着 } from './sleepgate.js'

const 跑 = promisify(execFile)

// SANDBOX：测试要把两个目录都指走。物品.mjs 自己认 QQ_AUTONOMY_MEM，
// 调它时必须显式把同一个值传下去，不然它会写真目录。
const 记忆目录 = () => process.env.QQ_ITEM_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`
const 工具目录 = () => process.env.QQ_ITEM_TOOLS || `${QQ_WS}/共享/工具`
const 读档 = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }

/** 能做的动作。跟 物品.mjs 的子命令一一对应，多一个都不放。 */
// 吃 / 收 是批次144 加的：主人要「零食牛奶能买回家放着」。
// 买回来的吃喝进了包，得能放进家（收）、也得能真的吃掉（吃）—— 否则「买了吃不上」。
const 动作表 = ['看', '拿', '放', '借', '还', '用', '买', '吃', '收']
const 扩展动作表 = ['看', '拿', '放', '借', '还', '用', '买', '吃', '收', '接水', '喝杯']

/** 物品.mjs 拒绝时会说的话。用它判 ok —— 这几句是拒，不是成功。 */
const 拒绝话 = /借不到|已经有一把|还没还呢|借不了|没有借过|不在身上|得回|不能放回家|在家里|手上没有|有点怪|这里（|吃不上|还在吃|没有能放进家|人不在家/

/** 只取「物品在哪、钱、包」这三个会变的事实，用来判断这次到底改没改。 */
function 快照(mem) {
  const 物 = 读档(join(mem, '物品.json'), { items: [] })
  const 资 = 读档(join(mem, '资产.json'), {})
  const items = Array.isArray(物.items) ? 物.items : []
  return JSON.stringify({
    // BATCH144：吃一份是「数 2 → 1」，n/在/来 三个字全都不变 —— 只比这三样的话，
    // 吃完一份会被判成「没成」（实测：脚本说吃了，工具说没吃成）。份数必须进快照。
    items: items.map((x) => [String(x.n), String(x.在), String(x.来), Number(x.数) || 1, x.容器 ? JSON.stringify(x.容器) : '']),
    钱: 资.钱,
    包: 资.包,
  })
}

/**
 * 动一件东西。opt 里 mem / tools 可以覆盖，供测试指沙盒。
 * 不抛异常：做不成都返回 { ok:false, why, message }，message 是给她看的话。
 */
export async function 动一下(动作, 名, opt = {}) {
  const mem = opt.mem || 记忆目录()
  const tools = opt.tools || 工具目录()
  const act = String(动作 ?? '').trim()
  const what = String(名 ?? '').trim()

  if (!扩展动作表.includes(act)) {
    return { ok: false, why: 'badAction', message: '只能做：看 / 拿 / 放 / 借 / 还 / 用 / 买' }
  }
  // 收是整包一起收，不需要点名（批次144）
  if (!['看', '收', '接水', '喝杯'].includes(act) && !what) {
    return { ok: false, why: 'noItem', message: '要动哪件东西？给个名字（雨伞、水杯……）' }
  }

  // 睡着了手上没准头。醒来再弄。
  // SLEEP_ONE 2026-11-07（批次168）：这里是同一份判据的第二份实现
  // （原来两处都写 `/睡/.test(自主.state)`，一起错）。现在都问 sleepgate。
  if (await 睡着(mem, tools)) {
    return { ok: false, why: 'sleeping', message: '你已经睡着了 —— 醒了再弄东西' }
  }

  const 前 = 快照(mem)
  if (act === '用' && what === '水杯') {
    const r1 = await 跑(process.execPath, [join(tools, '物品.mjs'), '--接水'], { encoding: 'utf8', env: { ...process.env, QQ_AUTONOMY_MEM: mem }, timeout: 15e3 }).catch((e) => ({ stdout: e?.stdout || '' }))
    const r2 = await 跑(process.execPath, [join(tools, '物品.mjs'), '--喝杯', '300'], { encoding: 'utf8', env: { ...process.env, QQ_AUTONOMY_MEM: mem }, timeout: 15e3 }).catch((e) => ({ stdout: e?.stdout || '' }))
    const msg = [String(r1.stdout || '').trim(), String(r2.stdout || '').trim()].filter(Boolean).join('；')
    return { ok: true, why: '', message: msg || '接水喝了几口' }
  }
  const argv = [join(tools, '物品.mjs'), '--' + act]
  if (!['看', '收', '接水'].includes(act) && what) argv.push(what)
  else if (act === '喝杯') argv.push(what || '300')

  let out = ''
  try {
    const r = await 跑(process.execPath, argv, {
      encoding: 'utf8',
      env: { ...process.env, QQ_AUTONOMY_MEM: mem },
      // 买是链式调用（物品.mjs → 花钱.mjs），给宽一点，别让外层先掐断
      timeout: 30e3,
    })
    out = String(r.stdout || '').trim()
  } catch (e) {
    // 脚本非零退出也算「没成」，但把它说的话带给她，别让她不知道卡在哪
    out = String((e && (e.stdout || e.message)) || '').trim()
  }

  // OK 怎么判：
  //   · 会改状态的动作（拿/放/借/还/买）：看文件变没变。没变就是被拒了，把她听到的那句话给她。
  //   · 看：只读，永远算成。
  //   · 用：不改状态，只能看它说了什么。
  let ok
  if (act === '看') ok = true
  else if (act === '用') ok = !拒绝话.test(out)
  else ok = 快照(mem) !== 前

  return { ok, why: ok ? '' : 'rejected', message: out || (ok ? '好了' : '没成') }
}

/** 注册 qq_item：她的手。 */
export async function registerItemTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      return note('tool', 'registerItemTool: no tools service')
    }

    const disposeTool = tools.register(
      {
        name: 'qq_item',
        description: "管理手边物品：看、拿、放、借、还、买、用、吃、收。归还须回原借店，不在时先 qq_go。买什么、借不借由你决定；买到食物不等于吃了。",
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            action: {
              type: 'string',
              enum: 动作表,
              description: '看=清点，拿=家→包，放=包→家，借/还=店里，买=花钱，用=拿出来用。',
            },
            what: {
              type: 'string',
              description: '东西名，如雨伞、水杯（看 可不填）。',
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
          const r = await 动一下(args?.action, args?.what)
          return { ok: !!r.ok, message: String(r.message || '') }
        },
      }
    )

    // 成功也留一条 —— 只看「no tools service」分不清「没这条能力」和「最后一次成了」。
    note('tool', 'qq_item registered')
    return disposeTool
  } catch (err) {
    note('tool', 'registerItemTool failed: ' + String((err && err.message) || err))
  }
}
