/**
 * dsh-mnemonic — 自研长期记忆。
 *
 * 设计取舍（都是拿别的插件实测换来的）：
 * - 静态成本压到最低：2 个工具（约 1.2k 字）+ 一张 ≤300 字状态卡，不用 14 个工具换 21k 字。
 * - 每轮最多注入一块 ≤600 字的回忆，且在分数闸门之下宁可不投——防“刚说完就忘”变成“见缝就翻旧账”。
 * - 检索全本地：BM25（中文 bigram）+ 关键词加分 + 重要度/新鲜度加权，不依赖云端 embedding。
 * - 存储是纯 JSONL，一条一行，坏行跳过；正文去重，靠 hash 防复读把库撑爆。
 * - 没命中就返回空，不编造；回忆块明确标注“原文，不是推测”。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store, defaultStorePath } from './lib/store.js'
import { buildIndex, search } from './lib/recall.js'
import { renderCard, renderRecallBlock, renderClock } from './lib/card.js'
import { messageText, roleOf, clip } from './lib/text.js'

export const name = 'dsh-mnemonic'
export const inject = ['tools']

const DAY = 86400000

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const cfg = {
    storePath: config.storePath || defaultStorePath(home),
    injectChars: Number(config.injectChars ?? 600),
    itemChars: Number(config.itemChars ?? 120),
    cardChars: Number(config.cardChars ?? 300),
    limit: Number(config.limit ?? 3),
    minScore: Number(config.minScore ?? 2.4),
    minHits: Number(config.minHits ?? 1),
    injectCooldownMs: Number(config.injectCooldownMs ?? 0),
    autoArchive: config.autoArchive ?? true,
    archiveChars: Number(config.archiveChars ?? 400),
  }

  const store = new Store(cfg.storePath).load()
  let index = buildIndex(store.records)
  let indexSize = store.records.length
  let lastInject = { at: 0, text: '' }

  const ensureIndex = () => {
    if (indexSize !== store.records.length) {
      index = buildIndex(store.records)
      indexSize = store.records.length
    }
    return index
  }

  const recall = (query, limit = cfg.limit) =>
    search(ensureIndex(), store.records, query, {
      limit,
      minScore: cfg.minScore,
      minHits: cfg.minHits,
    })

  // 每轮把「用户这句 + 上一句回复」顺手存一条：零模型成本，保证刚说过的也检索得到。
  const archiveTurn = (messages, lastUserIndex) => {
    const user = messageText(messages[lastUserIndex]) || ''
    if (!user.trim()) return
    let prevAssistant = ''
    for (let i = lastUserIndex - 1; i >= 0; i -= 1) {
      const role = roleOf(messages[i])
      if (role === 'assistant') { prevAssistant = messageText(messages[i]) || ''; break }
      if (role === 'user' && messageText(messages[i])) break
    }
    const text = prevAssistant
      ? `用户：${clip(user, cfg.archiveChars)}\n我：${clip(prevAssistant, cfg.archiveChars)}`
      : `用户：${clip(user, cfg.archiveChars)}`
    store.add({ text, keywords: [], tags: [], importance: 0.35, eventAt: Date.now(), source: { kind: 'auto' } })
  }

  // ── 工具：写档 / 检索 ─────────────────────────────────────────────────
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => {
      const save = tctx.tools.register({
        name: 'mem_save',
        description: '把一条值得长期记住的事写进记忆库：约定、偏好、人物、参数、结论。正文写清“谁、什么时候、什么事”，别写流水账。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', description: '一句话事实，带必要的时间/人物/数字' },
            keywords: { type: 'array', items: { type: 'string' }, description: '3-8 个检索词，覆盖人物/地点/事件/参数' },
            tags: { type: 'array', items: { type: 'string' }, description: '分类标签，如 偏好/约定/人物/项目' },
            importance: { type: 'number', description: '0.05-1，越重要越高；日常寒暄给 0.2' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { ok: { type: 'boolean' }, id: { type: 'string' }, total: { type: 'number' }, text: { type: 'string' } },
          },
          render(_args, value) {
            return [{ type: 'text', text: value.text }]
          },
        },
        async execute(args) {
          const rec = store.add({
            text: args?.text,
            keywords: args?.keywords || [],
            tags: args?.tags || [],
            importance: args?.importance ?? 0.5,
            source: { kind: 'tool' },
          })
          if (!rec) return { ok: false, id: '', total: store.records.length, text: '没写进去：正文是空的。' }
          return { ok: true, id: rec.id, total: store.records.length, text: `已存（库内 ${store.records.length} 条）。` }
        },
      })

      const recallTool = tctx.tools.register({
        name: 'mem_recall',
        description: '按关键词翻记忆库。只有需要过去的经历/约定/参数/人物细节时才调；没有命中就如实说没记到，不要编。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['query'],
          properties: {
            query: { type: 'string', description: '要查的事，用名词和关键细节' },
            limit: { type: 'number', description: '最多几条，默认 5，上限 10' },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: { hits: { type: 'number' }, text: { type: 'string' } },
          },
          render(_args, value) {
            return [{ type: 'text', text: value.text }]
          },
        },
        async execute(args) {
          const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5))
          const hits = recall(String(args?.query || ''), limit)
          if (!hits.length) return { hits: 0, text: '记忆库里没有相关的存档。' }
          const body = hits.map((h, i) => `${i + 1}. ${clip(h.rec.text, 200)}`).join('\n')
          for (const h of hits) store.touch(h.rec.id)
          return { hits: hits.length, text: body }
        },
      })

      return () => { save(); recallTool() }
    }, 'dsh-mnemonic: tools')
  })

  // ── 常驻状态卡：只报数，不命令 ────────────────────────────────────────
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:clock',
      order: 59,
      interpolate: false,
      text: () => renderClock(),
    }), 'dsh-mnemonic: clock')
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:card',
      order: 60,
      interpolate: false,
      text: () => renderCard(store.records, { maxChars: cfg.cardChars }),
    }), 'dsh-mnemonic: card')
  })

  // ── 每轮自动回忆：紧跟最后一条真人消息注入，闸门不过就不投 ─────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const messages = decision.messages
      const lastUserIndex = messages.reduce((found, m, i) => (roleOf(m) === 'user' && messageText(m) ? i : found), -1)
      if (lastUserIndex < 0) return decision
      const query = messageText(messages[lastUserIndex])
      // 每轮把当前这句和上一句回复顺手存档：零模型成本，保证“刚说完”的也检索得到。
      if (cfg.autoArchive) archiveTurn(messages, lastUserIndex)
      // 太短的招呼不打捞，省一轮检索和一块注入。
      if (query.trim().length < 6) return decision
      const now = Date.now()
      if (cfg.injectCooldownMs && now - lastInject.at < cfg.injectCooldownMs) return decision
      const hits = recall(query, cfg.limit)
      if (!hits.length) return decision
      const block = renderRecallBlock(hits, { maxChars: cfg.injectChars, itemChars: cfg.itemChars, now })
      if (!block || block === lastInject.text) return decision
      const message = await memoryMessage(block)
      if (!message) return decision
      messages.splice(lastUserIndex + 1, 0, message)
      lastInject = { at: now, text: block }
      for (const h of hits) store.touch(h.rec.id)
      return { ...decision, messages }
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 自动回忆失败: ${error?.message || error}`) } catch {}
      return decision
    }
  }, { prepend: true })

  // ── 只读自检：让 WebUI/运维能确认库是活的 ────────────────────────────
  ctx.inject(['webServer'], (wctx) => {
    const route = {
      kind: 'prefix',
      path: '/mnemonic',
      handler: async (req, res) => {
        if (req.url?.startsWith('/mnemonic/health')) {
          const body = JSON.stringify({
            total: store.records.length,
            newest: store.records.at(-1)?.createdAt || null,
            todayAdded: store.records.filter((r) => now() - (r.createdAt || 0) < DAY).length,
            storePath: cfg.storePath,
          })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(body)
          return true
        }
        return false
      },
    }
    wctx.effect(() => wctx.webServer.register(route), 'dsh-mnemonic: health route')
  })

  // 使用计数是原地修改，攒一会儿再整体落盘；丢了也只是计数不准，不影响记忆内容。
  const flushTimer = setInterval(() => { try { store.flush() } catch {} }, 30000)
  flushTimer.unref?.()

  return () => {
    try { clearInterval(flushTimer); store.flush() } catch {}
    ctx.logger?.info?.('dsh-mnemonic unloaded')
  }
}

function now() {
  return Date.now()
}

let createUserMessage = null
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'))
} catch {
  createUserMessage = null
}

async function memoryMessage(text) {
  if (createUserMessage) {
    return createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'plugin:dsh-mnemonic', form: 'recall' },
    })
  }
  return {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin:dsh-mnemonic', form: 'recall' },
  }
}
