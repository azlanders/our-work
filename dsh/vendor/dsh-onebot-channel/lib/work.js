/**
 * work.js —— 注册 qq_work：她的自由日结零工板（2026-11-12）
 *
 * 没有死合同、不去绝不扣信用：
 *   · action='看'  ：看当前能接哪些单日日结零工（地点、时薪、时长）以及今天有没有在干的活
 *   · action='打工'：挑一份喜欢的零工接单开干（人在店里直接开工；不在店里会自动出发走过去）
 *   · action='下班'：干累了或有事随时收工下班，按已干分钟数当场结算日结工资进钱包！
 */
import { readFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { note, serviceOf } from './env.js'
import { 睡着 } from './sleepgate.js'

const 跑 = promisify(execFile)
const 记忆目录 = () => process.env.WORK_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`
const 工具目录 = () => process.env.WORK_TOOLS || `${QQ_WS}/共享/工具`
const 读档 = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }

export async function 处理零工(args = {}, opt = {}) {
  const mem = opt.mem || 记忆目录()
  const tools = opt.tools || 工具目录()
  const act = String(args.action || '看').trim()
  const job = String(args.job || '').trim()
  const mins = Number(args.minutes || 0)

  const 配 = 读档(join(tools, '工作.json'), { 活: {} }).活 || {}
  const 资 = 读档(join(mem, '资产.json'), { 位置: '家', 钱: 0 })
  const 位 = String(资.位置 || '家')

  if (act === '看') {
    const 列表 = Object.entries(配).map(([k, c]) => {
      const m = Number(c.时长分钟) || 120
      return `· ${k}（@${c.点}，时薪 ${c.时薪} 块，约 ${Math.round(m / 60 * 10) / 10} 小时）：${c.说明 || ''}`
    }).join('\n')
    const r = await 跑(process.execPath, [join(tools, '工作.mjs'), '--班'], {
      encoding: 'utf8', env: { ...process.env, WORK_MEM: mem, WORK_TOOLS: tools, NODE_OPTIONS: '' }, timeout: 10000
    }).catch((e) => ({ stdout: e?.stdout || '' }))
    return {
      ok: true,
      message: `你现在在「${位}」，现金 ${资.钱 ?? 0} 块。\n【今日状态】${String(r.stdout || '').trim() || '今天还没接零工'}\n【可选的单日日结零工（随心去，不去不扣分）】\n${列表}`,
    }
  }

  if (await 睡着(mem, tools)) {
    return { ok: false, message: '你还在睡觉呢，醒了再去打零工吧' }
  }

  if (act === '下班') {
    const r = await 跑(process.execPath, [join(tools, '工作.mjs'), '--下班'], {
      encoding: 'utf8', env: { ...process.env, WORK_MEM: mem, WORK_TOOLS: tools, NODE_OPTIONS: '' }, timeout: 15000
    })
    return { ok: true, message: String(r.stdout || '').trim() || '已经收工结算啦' }
  }

  if (act === '打工') {
    if (!job || !配[job]) {
      return { ok: false, message: `要接哪份零工？可选：${Object.keys(配).join('、')}` }
    }
    const 目标点 = String(配[job].点 || '')
    if (位 !== 目标点) {
      const w = await 跑(process.execPath, [join(tools, '走路.mjs'), '--去', 目标点], {
        encoding: 'utf8', env: { ...process.env, QQ_AUTONOMY_MEM: mem, NODE_OPTIONS: '' }, timeout: 15000
      })
      return { ok: true, message: `${String(w.stdout || '').trim()} —— 等走到${目标点}就能开干「${job}」啦` }
    }
    const argv = [join(tools, '工作.mjs'), '--临时', '--活', job]
    if (mins >= 30) argv.push('--分钟', String(Math.min(360, Math.round(mins))))
    const r = await 跑(process.execPath, argv, {
      encoding: 'utf8', env: { ...process.env, WORK_MEM: mem, WORK_TOOLS: tools, NODE_OPTIONS: '' }, timeout: 15000
    })
    return { ok: true, message: String(r.stdout || '').trim() }
  }

  return { ok: false, message: 'action 只能是 看 / 打工 / 下班' }
}

export async function registerWorkTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (!tools || typeof tools.register !== 'function') return
    const dispose = tools.register({
      name: 'qq_work',
      description: '日结零工（无合同，不去不扣信用）：看=看所有零工，打工=接一份，下班=提前收工结算。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['看', '打工', '下班'], description: '看板/接单/收工。' },
          job: { type: 'string', description: '打工时填零工名，如 水族馆导览、家教、便利店值班。' },
          minutes: { type: 'integer', description: '可选；干多少分钟（30~360）。' },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, message: { type: 'string' } }, required: ['ok', 'message'] },
        render: (_a, v) => [{ type: 'text', text: String(v?.message || '') }],
      },
      execute: (args) => 处理零工(args),
    })
    if (typeof dispose === 'function') ctx.effect(() => dispose, 'dsh-onebot-channel: qq_work tool')
    note('tool', 'qq_work registered')
  } catch (e) {
    note('tool', `qq_work register failed: ${e instanceof Error ? e.message : e}`)
  }
}
