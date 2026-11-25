/**
 * dsh-mnemonic — 自研长期记忆。
 *
 * 设计取舍：
 * - 静态成本压到最低：2 个工具（mem_save / mem_recall）+ 一张 ≤300 字状态卡。
 * - 增量倒排索引（O(1) 追加）+ BM25 + 关键词/标签 + 中文相对时间窗加权 + MMR 去冗余（复用已建 grams）。
 * - 防自我回声、防提示词注入污染、容量自动压实（maxRecords）、UTC+8 北京时间渲染、上游超时熔断。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store, defaultStorePath } from './lib/store.js'
import { buildIndex, indexRecord, search } from './lib/recall.js'
import { diversify } from './lib/diversify.js'
import { loadAliasGroups, expandAliases } from './lib/aliases.js'
import { renderCard, renderRecallBlock, renderClockDate, ymd } from './lib/card.js'
import { messageText, roleOf, clip, hash32, parseEventTimestamp, isLowValueOrInjection, isDegradedAssistantText, isMultiNeedQuery, attributeKeywords, sanitizeMemoryText } from './lib/text.js'

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

/** 回忆注入消息的判据只留一份：相邻消息检查和 120s 去重共用。 */
export function isMnemonicRecallMessage(msg) {
  const kind = msg?.source?.kind ?? msg?.message?.source?.kind
  return kind === 'plugin:dsh-mnemonic'
}

export function effectiveMinScore(recordCount, targetMinScore) {
  const low = Math.min(targetMinScore, 1.2)
  if (recordCount <= 30) return low
  if (recordCount >= 200) return targetMinScore
  const ratio = (recordCount - 30) / (200 - 30)
  return Math.round((low + (targetMinScore - low) * ratio) * 100) / 100
}

export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const cfg = {
    storePath: config.storePath || defaultStorePath(home),
    maxRecords: Number(config.maxRecords ?? 5000),
    injectChars: Number(config.injectChars ?? 900),
    itemChars: Number(config.itemChars ?? 200),
    cardChars: Number(config.cardChars ?? 300),
    limit: Number(config.limit ?? 4),
    // 多要点问句的放大档：只在 isMultiNeedQuery 命中时用，普通闲聊仍走上面的小预算。
    multiInjectChars: Number(config.multiInjectChars ?? 1800),
    multiItemChars: Number(config.multiItemChars ?? 260),
    multiLimit: Number(config.multiLimit ?? 8),
    minScore: Number(config.minScore ?? 2.4),
    minHits: Number(config.minHits ?? 1),
    injectCooldownMs: Number(config.injectCooldownMs ?? 0),
    autoArchive: config.autoArchive ?? true,
    archiveChars: Number(config.archiveChars ?? 400),
    rerank: config.rerank ?? false,
    rerankPool: Number(config.rerankPool ?? 12),
    queryRewrite: config.queryRewrite ?? true,
    rewriteTimeoutMs: Number(config.rewriteTimeoutMs ?? 4000),
    rerankTimeoutMs: Number(config.rerankTimeoutMs ?? 5000),
  }

  const store = new Store(cfg.storePath, { maxRecords: cfg.maxRecords }).load()
  const aliasGroups = loadAliasGroups(cfg.storePath, config.aliases)
  let index = buildIndex(store.records)
  let indexedCount = store.records.length
  let indexedGen = store.generation
  let indexDirty = false
  const lastInjectByScope = new Map()
  let queryCount = 0
  let totalQueryMs = 0
  const archivedMsgIds = new Set()
  const rewriteCache = new Map()

  /** 增量同步索引：仅追加新记录时 O(1) 增量更新，删除/压实/改写元数据时才全量重建。 */
  const ensureIndex = () => {
    if (indexDirty || store.dirty || indexedGen !== store.generation || indexedCount > store.records.length) {
      index = buildIndex(store.records)
      indexedCount = store.records.length
      indexedGen = store.generation
      indexDirty = false
      store.dirty = false
      return index
    }
    while (indexedCount < store.records.length) {
      indexRecord(index, store.records[indexedCount], indexedCount)
      indexedCount += 1
    }
    return index
  }

  const recall = (query, limit = cfg.limit, pool = limit, { expandedTerms = '', excludeIds = null, scope = '', nowTs = Date.now() } = {}) => {
    const t0 = performance.now()
    const minScore = effectiveMinScore(store.records.length, cfg.minScore)
    const idx = ensureIndex()
    const aliasTerms = expandAliases(query, aliasGroups)
    const res = search(idx, store.records, query, {
      limit: pool,
      minScore,
      minHits: cfg.minHits,
      expandedTerms,
      aliasTerms,
      excludeIds,
      scope,
      now: nowTs,
    })
    queryCount += 1
    totalQueryMs += performance.now() - t0
    return res
  }

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

  const streamText = async (llm, sel, system, user, maxTokens, timeoutMs) => {
    let timer = null
    const ac = typeof AbortController !== 'undefined' ? new AbortController() : null
    const run = async () => {
      let out = ''
      const stream = llm.stream({
        provider: sel.provider,
        model: sel.model,
        system,
        messages: [{ role: 'user', content: user }],
        temperature: 0,
        maxTokens,
        ...(ac ? { signal: ac.signal } : {}),
      })
      for await (const chunk of stream) {
        if (chunk?.type === 'text-delta') out += chunk.text
      }
      return out.trim()
    }
    if (!timeoutMs || timeoutMs <= 0) return run()
    try {
      return await Promise.race([
        run(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            ac?.abort()
            reject(new Error(`timeout after ${timeoutMs}ms`))
          }, timeoutMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  async function rewriteQueryTerms(query) {
    if (!cfg.queryRewrite) return ''
    const clipped = clip(query, 300)
    if (!clipped) return ''
    const cached = rewriteCache.get(clipped)
    const ts = Date.now()
    if (cached && ts - cached.at < REWRITE_TTL_MS) return cached.words
    const svc = llmAndModel()
    if (!svc) return ''
    try {
      const words = (await streamText(svc.llm, svc.sel, REWRITE_SYS, clipped, 120, cfg.rewriteTimeoutMs)).replace(/\n+/g, ' ').trim()
      if (words) {
        if (rewriteCache.size >= 64) {
          const firstKey = rewriteCache.keys().next().value
          if (firstKey !== undefined) rewriteCache.delete(firstKey)
        }
        rewriteCache.set(clipped, { words, at: ts })
      }
      return words
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 查询改写失败，用原句: ${error?.message || error}`) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      return ''
    }
  }

  const rerankSys = (cap) => `你是记忆检索排序器。给定查询和编号候选记忆，选出与查询真正相关的最多 ${cap} 条，按相关度从高到低。只输出 JSON：{"picks":[序号,...]}。完全不相关的不要选，不要解释。`
  async function rerank(query, hits, cap = cfg.limit) {
    if (!cfg.rerank || hits.length <= cap) return hits.slice(0, cap)
    const svc = llmAndModel()
    if (!svc) return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
    try {
      const lines = hits
        .slice(0, Math.max(cfg.rerankPool, cap * 3))
        .map((h, i) => `${i + 1}. ${String(h.rec.text).slice(0, 140).replace(/\s+/g, ' ')}`)
        .join('\n')
      const out = await streamText(svc.llm, svc.sel, rerankSys(cap), `查询: ${query}\n候选:\n${lines}`, 200, cfg.rerankTimeoutMs)
      const m = out.match(/\{[\s\S]*\}/)
      if (!m) return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
      const picks = JSON.parse(m[0]).picks
      if (!Array.isArray(picks)) return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
      const out2 = []
      const seen = new Set()
      for (const p of picks) {
        const i = Number(p) - 1
        if (!Number.isInteger(i) || i < 0 || i >= hits.length || seen.has(i)) continue
        seen.add(i)
        out2.push(hits[i])
        if (out2.length >= cap) break
      }
      return out2.length ? out2 : diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 重排失败，回退去重顺序: ${error?.message || error}`) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      return diversify(hits, { limit: cap, gramsIndex: ensureIndex().grams })
    }
  }

  // 作用域取会话 id（private:/group:）。拿不到就留空，退化成不隔离，避免把老记录全屏蔽。
  const sessionScope = (agent) => {
    const id = agent?.session?.id
    return id ? String(id) : ''
  }

  // pre-step 时当前这条用户消息还没得到回复，配上一轮的助手回复会张冠李戴。
  // 存「上一轮完整的一问一答」：先找最近的助手回复，再找它前面那条真人用户消息。
  const archiveTurn = (messages, lastUserIndex, scope = '') => {
    let asstIndex = -1
    for (let i = lastUserIndex - 1; i >= 0; i -= 1) {
      if (roleOf(messages[i]) === 'assistant') { asstIndex = i; break }
    }
    if (asstIndex < 0) return null
    let userIndex = -1
    for (let i = asstIndex - 1; i >= 0; i -= 1) {
      if (isHumanUserMessage(messages[i])) { userIndex = i; break }
    }
    if (userIndex < 0) return null
    const userMsg = messages[userIndex]
    const user = messageText(userMsg) || ''
    if (isLowValueOrInjection(user)) return null
    const asstMsg = messages[asstIndex]
    const prevAssistant = messageText(asstMsg) || ''
    const cleanUser = sanitizeMemoryText(clip(user, cfg.archiveChars))
    const usableAsst = isDegradedAssistantText(prevAssistant) ? '' : prevAssistant
    const cleanAsst = usableAsst ? sanitizeMemoryText(clip(usableAsst, cfg.archiveChars)) : ''
    const text = cleanAsst ? `用户：${cleanUser}\n我：${cleanAsst}` : `用户：${cleanUser}`

    const asstId = asstMsg?.id || hash32(prevAssistant)
    const msgKey = `${scope || '__global__'}|${userMsg?.id ? `id:${userMsg.id}` : `txt:${hash32(user)}`}|${asstId}`
    if (archivedMsgIds.has(msgKey)) {
      return store.findByText(text, scope)?.id || null
    }
    if (archivedMsgIds.size >= 128) {
      const oldest = archivedMsgIds.values().next().value
      if (oldest !== undefined) archivedMsgIds.delete(oldest)
    }
    archivedMsgIds.add(msgKey)

    const msgTs = parseEventTimestamp(asstMsg?.createdAt ?? asstMsg?.timestamp ?? userMsg?.createdAt ?? userMsg?.timestamp) || Date.now()
    const rec = store.add({ text, keywords: attributeKeywords(text), tags: [], importance: 0.35, eventAt: msgTs, source: { kind: 'auto' }, scope })
    return rec?.id || null
  }

  // ── 工具：写档（含纠错替代与事件日期） / 检索 ───────────────────────────
  ctx.inject(['tools'], (tctx) => {
    tctx.effect(() => {
      const save = tctx.tools.register({
        name: 'mem_save',
        description: '把一条值得长期记住的事写进记忆库：约定、偏好、人物、参数、结论。正文写清“谁、什么时候、什么事”，别写流水账；若纠正旧记录可传 supersedes 旧 ID。',
        parameters: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', description: '一句话事实，带必要的时间/人物/数字' },
            keywords: { type: 'array', items: { type: 'string' }, description: '3-8 个检索词，覆盖人物/地点/事件/参数' },
            tags: { type: 'array', items: { type: 'string' }, description: '分类标签，如 偏好/约定/人物/项目' },
            importance: { type: 'number', description: '0.05-1，越重要越高；日常寒暄给 0.2' },
            eventAt: { type: 'string', description: '可选：事件发生日期，如 2026-11-24' },
            supersedes: { type: 'string', description: '可选：要覆盖/作废的旧记忆 ID（来自 mem_recall）' },
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
        async execute(args, exec) {
          if (!sanitizeMemoryText(args?.text)) {
            return { ok: false, id: '', total: store.records.length, text: '没写进去：正文是空的。' }
          }
          let replaced = false
          if (args?.supersedes && typeof args.supersedes === 'string') {
            replaced = store.remove(args.supersedes.trim())
            if (replaced) indexDirty = true
          }
          const rec = store.add({
            text: args?.text,
            keywords: [...new Set([...(Array.isArray(args?.keywords) ? args.keywords : []), ...attributeKeywords(args?.text)])],
            tags: args?.tags || [],
            importance: args?.importance ?? 0.5,
            eventAt: args?.eventAt ?? null,
            source: { kind: 'tool' },
            scope: sessionScope(exec?.agent),
          })
          if (!rec) return { ok: false, id: '', total: store.records.length, text: '没写进去：正文是空的。' }
          if (replaced) {
            store.flush()
            indexDirty = true
          }
          const extra = replaced ? `（已替换旧条 ${args.supersedes}）` : ''
          return { ok: true, id: rec.id, total: store.records.length, text: `已存 ${rec.id}${extra}（库内 ${store.records.length} 条）。` }
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
        async execute(args, exec) {
          const limit = Math.min(10, Math.max(1, Number(args?.limit) || 5))
          const pool = recall(String(args?.query || ''), limit, Math.max(limit * 2, cfg.rerankPool), { scope: sessionScope(exec?.agent) })
          const hits = diversify(pool, { limit, gramsIndex: ensureIndex().grams })
          if (!hits.length) return { hits: 0, text: '记忆库里没有相关的存档。' }
          const body = hits.map((h, i) => {
            const when = ymd(h.rec.eventAt || h.rec.createdAt)
            return `${i + 1}. [${h.rec.id}] (${when}) ${clip(h.rec.text, 200)}`
          }).join('\n')
          for (const h of hits) store.touch(h.rec.id)
          return { hits: hits.length, text: body }
        },
      })

      return () => { save(); recallTool() }
    }, 'dsh-mnemonic: tools')
  })

  // ── 常驻状态卡 ────────────────────────────────────────────────────────
  ctx.inject(['systemPrompt'], (sctx) => {
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:clock',
      order: 59,
      interpolate: false,
      text: () => renderClockDate(),
    }), 'dsh-mnemonic: clock')
    sctx.effect(() => sctx.systemPrompt.section({
      name: 'dsh-mnemonic:card',
      order: 60,
      interpolate: false,
      text: () => renderCard(store.records.filter((r) => !r.scope), { maxChars: cfg.cardChars }),
    }), 'dsh-mnemonic: card')
  })

  // ── 每轮自动回忆 ──────────────────────────────────────────────────────
  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    try {
      if (decision?.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
      const messages = decision.messages
      const scope = sessionScope(payload?.agent)
      const lastUserIndex = messages.reduce((found, m, i) => (isHumanUserMessage(m) ? i : found), -1)
      if (lastUserIndex < 0) return decision
      // 同一轮工具调用续步（最后一条真人消息后已有助手消息）不再重跑改写与回忆插队，保住历史与 KV cache
      if (messages.slice(lastUserIndex + 1).some((m) => roleOf(m) === 'assistant')) return decision
      const query = messageText(messages[lastUserIndex])
      const currentTurnId = cfg.autoArchive ? archiveTurn(messages, lastUserIndex, scope) : null
      if (isMnemonicRecallMessage(messages[lastUserIndex + 1])) return decision
      const qTrim = query.trim()
      if (qTrim.length < 3 || isLowValueOrInjection(qTrim, { minLen: 3 })) return decision
      const ts = Date.now()
      const scopeKey = scope || '__global__'
      const lastInject = lastInjectByScope.get(scopeKey) || { at: 0, sig: '' }
      if (cfg.injectCooldownMs && ts - lastInject.at < cfg.injectCooldownMs) return decision
      const expandedTerms = await rewriteQueryTerms(query)
      const excludeIds = currentTurnId ? new Set([currentTurnId]) : null
      const budget = isMultiNeedQuery(qTrim)
        ? { limit: cfg.multiLimit, inject: cfg.multiInjectChars, item: cfg.multiItemChars }
        : { limit: cfg.limit, inject: cfg.injectChars, item: cfg.itemChars }
      const pool = recall(query, budget.limit, Math.max(cfg.rerankPool, budget.limit * 3), { expandedTerms, excludeIds, nowTs: ts, scope })
      const hits = cfg.rerank
        ? await rerank(expandedTerms ? `${query} ${expandedTerms}` : query, pool, budget.limit)
        : diversify(pool, { limit: budget.limit, gramsIndex: ensureIndex().grams })
      if (!hits.length) return decision
      const sig = hits.map((h) => h.rec.id).join(',')
      // 2026-11-25：原来只看 120s + sig，宿主不持久化临时注入消息或上下文裁剪后，连续追问会被静默吞掉回忆；
      // 仅当当前 messages 窗口内仍保留上次注入消息时才跳过。
      const hasPrevInjectInWindow = messages.some(isMnemonicRecallMessage)
      if (hasPrevInjectInWindow && sig === lastInject.sig && ts - lastInject.at < 120000) return decision
      const block = renderRecallBlock(hits, { maxChars: budget.inject, itemChars: budget.item, now: ts })
      if (!block) return decision
      const message = await memoryMessage(block)
      if (!message) return decision
      messages.splice(lastUserIndex + 1, 0, message)
      if (lastInjectByScope.size >= 256 && !lastInjectByScope.has(scopeKey)) {
        const oldest = lastInjectByScope.keys().next().value
        if (oldest !== undefined) lastInjectByScope.delete(oldest)
      }
      lastInjectByScope.set(scopeKey, { at: ts, sig })
      for (const h of hits) store.touch(h.rec.id)
      return { ...decision, messages }
    } catch (error) {
      try { ctx.logger?.warn?.(`dsh-mnemonic: 自动回忆失败: ${error?.message || error}`) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      return decision
    }
  }, { prepend: true })

  // ── 只读自检（含性能与分层统计，不暴露宿主机完整绝对路径） ───────────
  ctx.inject(['webServer'], (wctx) => {
    const route = {
      kind: 'prefix',
      path: '/mnemonic',
      handler: async (req, res) => {
        if (req.url?.startsWith('/mnemonic/health')) {
          const toolCount = store.records.filter((r) => r.source?.kind === 'tool').length
          const body = JSON.stringify({
            total: store.records.length,
            toolCount,
            autoCount: store.records.length - toolCount,
            indexedCount,
            maxRecords: cfg.maxRecords,
            avgQueryMs: queryCount ? Math.round((totalQueryMs / queryCount) * 100) / 100 : 0,
            newest: store.records.at(-1)?.createdAt || null,
            todayAdded: store.records.filter((r) => now() - (r.createdAt || 0) < DAY).length,
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

  const flushTimer = setInterval(() => { try { store.flush() } catch (_err) { console.error('[mnemonic]', _err?.message || _err) } }, 30000)
  flushTimer.unref?.()

  return () => {
    try { clearInterval(flushTimer); store.flush() } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
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
