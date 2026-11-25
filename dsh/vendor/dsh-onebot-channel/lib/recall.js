/**
 * recall.js —— 注册 qq_recall：她自己翻旧账（2026-11-07 批次189）。
 *
 * 之前她只有「系统塞给她」：链尾两三条、印象一句话。想不起某件事时没有任何办法。
 * 隔壁 qq_msg_history 能翻 QQ 聊天记录 —— 但那是**别人说的话**，
 * 手账/梦/链是**她自己过的日子**，两套东西，之前后者一条路都没有。
 *
 * 判据：只读，不写盘；查不到就说查不到，不编。
 */
import { execFile } from 'node:child_process'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { note, serviceOf } from './env.js'
import { getConfig } from './config.js'
import { 工具回合角色, 生活记忆角色, 查询记忆提供方 } from './记忆核心.mjs'

const 跑 = promisify(execFile)
const 工具目录 = () => process.env.QQ_RECALL_TOOLS || `${QQ_WS}/共享/工具`

/**
 * 这次 qq_recall 是谁在问？只有「主人私聊」才拿得到日记的私有段。
 *
 * 只认显式的聊天归属。工具执行时从当前宿主会话取归属。
 */
export function recallRoleOf(delivery = null, cfg = null) {
  try {
    return 生活记忆角色(delivery, cfg ?? getConfig())
  } catch { return 'guest' }
}

/**
 * TRUNC 2026-11-17（批次639）：把「只列了前 12 条」这件事说出来。
 *
 * 回忆.mjs 的 12 条上限原来完全静默：她翻到 12 条就当成「只有 12 条」照实讲，
 * 主人问「你记不记得我说过几次」时等于给了个假数。现在 说明 里带总数，
 * 这里既进 JSON 的 note，也拼在正文末尾 —— 两个出口都必须能看到，缺一个她就会漏读。
 *
 * 单独导出是为了能测：不用起插件，直接喂一个 value 就能验渲染结果。
 */
export function renderRecall(value) {
  if (value?.detail) return [{ type: 'text', text: value.detail }]
  const list = Array.isArray(value?.items) ? value.items : []
  const note = String(value?.note ?? '').trim()
  if (list.length === 0) return [{ type: 'text', text: note || '翻了一圈，没找到。' }]
  const lines = list.map((x) => `[${x.day}] ${x.source}：${x.text}`)
  const tail = note === '' ? '' : `\n\n（${note}）`
  return [{ type: 'text', text: `翻到 ${list.length} 条：\n${lines.join('\n')}${tail}` }]
}

async function 查询历史(source, args, exec) {
  const word = String(args?.word ?? '').trim()
  const day = String(args?.day ?? '').trim()
  const 标签 = source === 'rofm' ? '聊天归档' : '海马体原话'
  if (!word && !day) return { ok: false, count: 0, note: '请提供关键词或日期。', items: [] }
  if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return { ok: false, count: 0, note: '聊天归档和原话使用 YYYY-MM-DD 日期。', items: [] }
  }
  const allow = getConfig().工具白名单
  const toolName = source === 'rofm' ? 'memory_recall' : 'recall'
  if (Array.isArray(allow) && allow.length > 0 && !allow.includes(toolName)) {
    return { ok: false, count: 0, note: `${标签}在当前配置未开放。`, items: [] }
  }
  try {
    const query = source === 'rofm'
      ? { ...(word ? { keywords: word } : {}), ...(day ? { timeFrom: day, timeTo: day } : {}) }
      : { query: word, when: day }
    const result = await 查询记忆提供方(source, query, exec)
    if (!result) return { ok: false, count: 0, note: `${标签}在当前会话不可用。`, items: [] }
    return { ok: true, count: 0, items: [], detail: `[${标签}]\n${result}` }
  } catch (error) {
    note('recall', `${标签}查询失败：${error instanceof Error ? error.message : String(error)}`)
    return { ok: false, count: 0, note: `${标签}查询失败。`, items: [] }
  }
}

export async function registerRecallTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      return note('tool', 'registerRecallTool: no tools service')
    }

    const disposeTool = tools.register(
      {
        name: 'qq_recall',
        // DESC_DIARY 2026-11-17（批次658，审计 P1-5）：621/624 已经把日记接进来了，
        // 描述还写着「手账、梦和记忆链」—— 她按描述选工具，会以为翻不到日记。
        // 顺带写明权限：日记的私有段只有主人私聊能看到（群聊/客人只拿公开段）。
        description: '查记忆：默认查自己的手账、日记、梦和记忆链。可按关键词或日期。日记私有段仅主人私聊可见。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            source: { type: 'string', enum: ['life', 'rofm', 'hippocampus'], description: '记忆来源，默认 life。' },
            day: {
              type: 'string',
              description: '日期 YYYY-MM-DD；生活记忆也接受 今天/昨天/前天/3天前。',
            },
            word: {
              type: 'string',
              description: '查询词，如「超市」「图书馆」。',
            },
            days: {
              type: 'number',
              description: '没给日期和词时往回看几天，默认 3，最多 7。',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              count: { type: 'number' },
              total: { type: 'number' },
              note: { type: 'string' },
              detail: { type: 'string' },
              items: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    source: { type: 'string' },
                    day: { type: 'string' },
                    text: { type: 'string' },
                  },
                  required: ['source', 'day', 'text'],
                },
              },
            },
            required: ['ok', 'count', 'items'],
          },
          render: (args, value) => renderRecall(value),
        },
        execute: async (args, exec) => {
          if (args?.source === 'rofm' || args?.source === 'hippocampus') return 查询历史(args.source, args, exec)
          const 参 = []
          const day = String(args?.day ?? '').trim()
          const word = String(args?.word ?? '').trim()
          if (day) 参.push('--日', day)
          if (word) 参.push('--词', word)
          if (!day && !word) 参.push('--最近', String(Number(args?.days ?? 3) || 3))
          参.push('--json')

          let stdout = ''
          try {
            const r = await 跑(process.execPath, [join(工具目录(), '回忆.mjs'), ...参], {
              timeout: 15000,
              maxBuffer: 1 << 20,
              encoding: 'utf8',
              // 角色决定日记能翻到多少：群聊/客人只拿公开段（见 日记.mjs 给角色()）。
              env: { ...process.env, QQ_RECALL_ROLE: 工具回合角色(exec?.agent?.session, getConfig()) },
            })
            stdout = String(r.stdout || '')
          } catch (error) {
            return {
              ok: false,
              count: 0,
              note: '翻不动：' + String(error && error.message ? error.message : error).slice(0, 80),
              items: [],
            }
          }

          let o = null
          try {
            o = JSON.parse(stdout)
          } catch {
            return { ok: false, count: 0, note: '翻出来的东西读不懂（不是 JSON）', items: [] }
          }

          const items = (Array.isArray(o?.条目) ? o.条目 : []).map((x) => ({
            source: String(x?.来源 ?? ''),
            day: String(x?.日 ?? ''),
            text: String(x?.文 ?? ''),
          }))

          return {
            ok: !!o?.ok,
            count: items.length,
            total: Number.isFinite(Number(o?.总数)) ? Number(o.总数) : items.length,
            note: String(o?.说明 ?? ''),
            items,
          }
        },
      }
    )

    note('tool', 'qq_recall registered')
    return disposeTool
  } catch (err) {
    note('tool', 'registerRecallTool failed: ' + String((err && err.message) || err))
  }
}
