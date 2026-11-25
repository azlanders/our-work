/**
 * dsh-mnemonic — 自研长期记忆。
 *
 * 设计取舍（都是拿别的插件实测换来的）：
 * - 静态成本压到最低：2 个工具（约 1.2k 字）+ 一张 ≤300 字状态卡，不用 14 个工具换 21k 字。
 * - 每轮最多注入一块 ≤900 字的回忆，且在分数闸门之下宁可不投——防“刚说完就忘”变成“见缝就翻旧账”。
 *   900 是基准换来的：600/700 字在多条命中+纪律尾注下容易把末条截断，题就答「记不清」。
 * - 检索全本地：BM25（中文 bigram）+ 关键词/标签加分 + 重要度/新鲜度加权 + MMR 去冗余，不依赖云端 embedding。
 * - 存储是纯 JSONL，一条一行，坏行跳过；正文去重，靠 hash 防复读把库撑爆。
 * - 只归档与检索真人用户发言，过滤 runtime-context/checkpoint/plugin 合成消息。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store, defaultStorePath } from './lib/store.js'
import { buildIndex, search } from './lib/recall.js'
import { diversify } from './lib/diversify.js'
import { renderCard, renderRecallBlock, renderClock } from './lib/card.js'
import { messageText, roleOf, clip, hash32 } from './lib/text.js'

export const name = 'dsh-mnemonic'
export const inject = ['tools']

const DAY = 86400000
const REWRITE_TTL_MS = 5 * 60 * 1000
const NON_USER_KINDS = new Set([
  'runtime-context',
  'compact-checkpoint',
  'spine-checkpoint',
  'repeat-tool-reminder',
  'time-context',
  'skill-catalog',
  'memory_revision',
  'nudge',
])

/** 仅放行真人发言：排除 runtime-context / checkpoint / 插件注入等非真人 user 角色消息。 */
export function isHumanUserMessage(msg) {
  if (roleOf(msg) !== 'user') return false
  const kind = msg?.source?.kind ?? msg?.message?.source?.kind
  if (kind) {
    if (String(kind).startsWith('plugin:')) return false
    if (NON_USER_KINDS.has(kind)) return false
    if (kind !== 'user') return false
  }
  const txt = messageText(msg).trim()
  if (!txt) return false
  if (txt.startsWith('Current runtime context.')) return false
  return true
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const cfg = {
    storePath: config.storePath || defaultStorePath(home),
    injectChars: Number(config.injectChars ?? 900),
    itemChars: Number(config.itemChars ?? 200),
    cardChars: Number(config.cardChars ?? 300),
    limit: Number(config.limit ?? 4),
    minScore: Number(config.minScore ?? 2.4),
    minHits: Number(config.minHits ?? 1),
    injectCooldownMs: Number(config.injectCooldownMs ?? 0),
    autoArchive: config.autoArchive ?? true,
    archiveChars: Number(config.archiveChars ?? 400),
    rerank: config.rerank ?? false,
    rerankPool: Number(config.rerankPool ?? 12),
    queryRewrite: config.queryRewrite ?? true,
  }

  const store = new Store(cfg.storePath).load()
  let index = buildIndex(store.records)
  let indexSize = store.records.length
  let indexDirty = false
  let lastInject = { at: 0, text: '' }
  const archivedMsgIds = new Set()
  const rewriteCache = new Map()

  const ensureIndex = () => {
    if (indexDirty || indexSize !== store.records.length) {
      index = buildIndex(store.records)
      indexSize = store.records.length
      indexDirty = false
    }
    return index
  }

  const recall = (query, limit = cfg.limit, pool = limit) => {
    // 新库（<50 条）词项 df 几乎等于 n，分数天然低，2.4 的闸门会一条都不召回。
    const minScore = store.records.length < 50 ? Math.min(cfg.minScore, 1.2) : cfg.minScore
    return search(ensureIndex(), store.records, query, { limit: pool, minScore, minHits: cfg.minHits })
  }

  // 把用户那句话翻成检索词再查库。
  // 基准实测（P16 123 题）：不改写 91，改写 99，只加重排不改写 90 —— 有效的就是这一步。
  const REWRITE_SYS = `把用户的这句话转成往旧聊天记录里检索用的词。只输出词，空格分隔，8-12 个。
要写人名、物件、动作，以及同义词和上位词（问"喝的"写 咖啡 美式 拿铁 茶；问"吃的"写 抄手 面 饭 早饭）。
不要解释，不要句子。`
  const llmAndModel = () => {
    try {
      const llm = ctx.get('llm')
      const sel = ctx.get('defaultModel')?.currentSelection?.()
      if (!llm || typeof llm.stream !== 'function' || !sel?.provider || !sel?.model) return null
      return { llm, sel }
    } catch {
      return null
    }
  }
  const streamText = async (llm, sel, system, user, maxTokens) => {
    let out = ''
    const stream = llm.stream({
      provider: sel.provider,
      model: sel.model,
      system,
      messages: [{ role: 'user', content: user }],
      temperature: 0,
      maxTokens,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta') out += chunk.text
    }
    return out.trim()
  }
  /** 改写失败就用原句，不能因为这一步把整轮卡住；同问短时缓存避免工具循环重复调模型。 */
  async function rewriteQuery(query) {
    if (!cfg.queryRewrite) return query
    const cacheKey = query.trim()
    const cached = rewriteCache.get(cacheKey)
    const ts = Date.now()
    if (cached && ts - cached.at < REWRITE_TTL_MS) return cached.expanded
    const svc = llmAndModel()
    if (!svc) return query
    try {
      const words = (await streamText(svc.llm, svc.sel, REWRITE_SYS, query, 120)).replace(/\n+/g, ' ')
      const expanded = words ? `${query} ${words}` : query
      if (rewriteCache.size >= 64) {
        const firstKey = rewriteCache.keys().next().value
        if (firstKey !== undefined) rewriteCache.delete(firstKey)
      }
      rewriteCache.set(cacheKey, { expanded, at: ts })
      return expanded
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 查询改写失败，用原句: ${error?.message || error}`) } catch {}
      return query
    }
  }

  // 重排保留但默认关：基准里单独加重排不提分（P16 91 → 90）。
  const RERANK_SYS = `你是记忆检索排序器。给定查询和编号候选记忆，选出与查询真正相关的最多 ${cfg.limit} 条，按相关度从高到低。只输出 JSON：{"picks":[序号,...]}。完全不相关的不要选，不要解释。`
  async function rerank(query, hits) {
    if (!cfg.rerank || hits.length <= cfg.limit) return hits.slice(0, cfg.limit)
    const svc = llmAndModel()
    if (!svc) return diversify(hits, { limit: cfg.limit })
    try {
      const lines = hits
        .slice(0, cfg.rerankPool)
        .map((h, i) => `${i + 1}. ${String(h.rec.text).slice(0, 140).replace(/\s+/g, ' ')}`)
        .join('\n')
      const out = await streamText(svc.llm, svc.sel, RERANK_SYS, `查询: ${query}\n候选:\n${lines}`, 200)
      const m = out.match(/\{[\s\S]*\}/)
      if (!m) return diversify(hits, { limit: cfg.limit })
      const picks = JSON.parse(m[0]).picks
      if (!Array.isArray(picks)) return diversify(hits, { limit: cfg.limit })
      const out2 = []
      const seen = new Set()
      for (const p of picks) {
        const i = Number(p) - 1
        if (!Number.isInteger(i) || i < 0 || i >= hits.length || seen.has(i)) continue
        seen.add(i)
        out2.push(hits[i])
        if (out2.length >= cfg.limit) break
      }
      return out2.length ? out2 : diversify(hits, { limit: cfg.limit })
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 重排失败，回退去重顺序: ${error?.message || error}`) } catch {}
      return diversify(hits, { limit: cfg.limit })
    }
  }

  // 每轮把「用户这句 + 上一句回复」顺手存一条：零模型成本，保证刚说过的也检索得到。
  const archiveTurn = (messages, lastUserIndex) => {
    const userMsg = messages[lastUserIndex]
    if (!isHumanUserMessage(userMsg)) return
    const msgKey = userMsg?.id ? `id:${userMsg.id}` : `txt:${hash32(messageText(userMsg))}`
    if (archivedMsgIds.has(msgKey)) return
    if (archivedMsgIds.size >= 128) {
      const oldest = archivedMsgIds.values().next().value
      if (oldest !== undefined) archivedMsgIds.delete(oldest)
    }
    archivedMsgIds.add(msgKey)

    const user = messageText(userMsg) || ''
    if (!user.trim()) return
    let prevAssistant = ''
    for (let i = lastUserIndex - 1; i >= 0; i -= 1) {
      const role = roleOf(messages[i])
      if (role === 'assistant') { prevAssistant = messageText(messages[i]) || ''; break }
      if (isHumanUserMessage(messages[i])) break
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
          indexDirty = true
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
          const pool = recall(String(args?.query || ''), limit, Math.max(limit * 2, cfg.rerankPool))
          const hits = diversify(pool, { limit })
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
      const lastUserIndex = messages.reduce((found, m, i) => (isHumanUserMessage(m) ? i : found), -1)
      if (lastUserIndex < 0) return decision
      const query = messageText(messages[lastUserIndex])
      // 每轮把当前这句和上一句回复顺手存档：零模型成本，保证“刚说完”的也检索得到。
      if (cfg.autoArchive) archiveTurn(messages, lastUserIndex)
      // 同回合工具循环后续步若已注入回忆，跳过重复检索与注入。
      if (messages[lastUserIndex + 1]?.source?.kind === 'plugin:dsh-mnemonic') return decision
      // 太短的招呼不打捞，省一轮检索和一块注入。
      if (query.trim().length < 6) return decision
      const ts = Date.now()
      if (cfg.injectCooldownMs && ts - lastInject.at < cfg.injectCooldownMs) return decision
      const expanded = await rewriteQuery(query)
      const pool = recall(expanded, cfg.limit, cfg.rerankPool)
      const hits = cfg.rerank ? await rerank(expanded, pool) : diversify(pool, { limit: cfg.limit })
      if (!hits.length) return decision
      const block = renderRecallBlock(hits, { maxChars: cfg.injectChars, itemChars: cfg.itemChars, now: ts })
      if (!block || block === lastInject.text) return decision
      const message = await memoryMessage(block)
      if (!message) return decision
      messages.splice(lastUserIndex + 1, 0, message)
      lastInject = { at: ts, text: block }
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
