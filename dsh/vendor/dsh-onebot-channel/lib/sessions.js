/**
 * sessions.js —— 会话列表 + 冷启动。
 *
 * 列会话合并三个来源，任何一个挂了都不至于变成「0 个可选会话」：
 *   1. sessions 服务 —— 只有「活着」的会话，但能问到折叠后的标题；
 *   2. 落盘目录 ~/.dsh/sessions/<编码后的 cwd>/ —— 全部会话（没打开的也在）；
 *   3. 浏览器端再补一次 —— ctx.sessions.list 里有 displayTitle（见 lib/client.js）。
 */
import { getConfig } from './config.js'
import { note, serviceOf } from './env.js'
import { normCwd, scanSessionDirs } from './title.js'

/** 来源一：活着的会话。 */
export function listLiveSessions(ctx, want) {
  const out = []
  try {
    const svc = serviceOf(ctx, 'sessions')
    if (svc === null || svc === undefined || typeof svc.list !== 'function') {
      note('api', 'sessions 服务取不到 list()')
      return out
    }
    // 标题存在投影里，得问 sessionTitle 服务；它没在 inject 里，取不到会抛，必须兜住
    let titleSvc
    try {
      titleSvc = serviceOf(ctx, 'sessionTitle')
    } catch (error) {
      note('api', `sessionTitle 不可用: ${error instanceof Error ? error.message : error}`)
      titleSvc = undefined
    }
    for (const session of svc.list() ?? []) {
      const header = session?.header ?? {}
      const cwd = String(header.cwd ?? '')
      if (want !== '' && cwd !== '' && normCwd(cwd) !== normCwd(want)) continue
      const id = String(header.id ?? session?.id ?? '')
      if (id === '') continue
      let title = ''
      if (titleSvc !== undefined && titleSvc !== null && typeof titleSvc.get === 'function') {
        try {
          const folded = titleSvc.get(session)
          if (typeof folded === 'string') title = folded
        } catch (error) {
          note('api', `sessionTitle.get failed: ${error instanceof Error ? error.message : error}`)
        }
      }
      if (title === '') title = String(session?.title ?? header.title ?? '')
      out.push({ id, title, cwd, updatedAt: String(header.updatedAt ?? header.createdAt ?? '') })
    }
  } catch (error) {
    note('api', `sessions.list failed ${error instanceof Error ? error.message : error}`)
  }
  return out
}

export function listWorkspaceSessions(ctx) {
  const want = String(getConfig().workspaceCwd ?? '')
  const merged = new Map()
  const put = (item) => {
    const old = merged.get(item.id)
    if (old === undefined) {
      merged.set(item.id, item)
      return
    }
    // 标题留着有的那个；时间留新的那个
    merged.set(item.id, {
      id: item.id,
      cwd: item.cwd !== '' ? item.cwd : old.cwd,
      title: item.title !== '' ? item.title : old.title,
      updatedAt: item.updatedAt > old.updatedAt ? item.updatedAt : old.updatedAt
    })
  }
  for (const item of listLiveSessions(ctx, want)) put(item)
  for (const item of scanSessionDirs(want)) put(item)
  // 空壳会话排到最后（前缀跟 client.js 里保持一致）
  const rank = (item) => (item.title.startsWith('（空会话') ? 1 : 0)
  return [...merged.values()].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b)
    return a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0
  })
}

/** 候选会话：先给配置指定的，再按「最近更新」排其它会话。 */
export function sessionCandidates(ctx, preferredId) {
  const ids = []
  if (typeof preferredId === 'string' && preferredId !== '') ids.push(preferredId)
  try {
    const sessions = serviceOf(ctx, 'sessions')
    const list = sessions !== undefined && sessions !== null && typeof sessions.list === 'function' ? sessions.list() ?? [] : []
    const sorted = [...list].sort((a, b) => {
      const sa = String(a?.header?.updatedAt ?? a?.header?.createdAt ?? '')
      const sb = String(b?.header?.updatedAt ?? b?.header?.createdAt ?? '')
      return sa < sb ? 1 : sa > sb ? -1 : 0
    })
    for (const session of sorted) {
      const id = String(session?.header?.id ?? session?.id ?? '')
      if (id !== '' && !ids.includes(id)) ids.push(id)
    }
  } catch (error) {
    note('session', `candidates failed ${error instanceof Error ? error.message : error}`)
  }
  return ids
}

/** 我们替它冷启动出来的会话 agent（会话本来没开着时）。 */
const resumedAgents = new Map()
// 2026-11-04 修：原来这条缓存只有「加」没有「减」，一个「活着但上下文已死」的 agent
// 会被永久复用，越攒越多。加 30 分钟 TTL 和 50 条上限，过期就重新 resume 一次。
const RESUMED_TTL_MS = 30 * 60 * 1000
const RESUMED_MAX = 50
const lastResumeAttempt = new Map()

/** 按会话记录里的 preset 组装修复 setup —— 和 UI 打开会话时做的事一致。 */
async function composeSetup(ctx, sessionId) {
  try {
    const presets = serviceOf(ctx, 'agentPresets')
    const sessions = serviceOf(ctx, 'sessions')
    const session = sessions !== undefined && sessions !== null && typeof sessions.get === 'function' ? sessions.get(sessionId) : undefined
    const presetId = session?.header?.agentPreset
    if (
      presets === undefined || presets === null ||
      typeof presets.resolve !== 'function' || typeof presets.mount !== 'function' ||
      typeof presetId !== 'string' || presetId === ''
    ) {
      return () => Promise.resolve()
    }
    const resolved = await presets.resolve(presetId)
    return async (agentCtx) => {
      await presets.mount(agentCtx, resolved.id)
    }
  } catch (error) {
    note('resume', `compose setup failed: ${error instanceof Error ? error.message : error}`)
    return () => Promise.resolve()
  }
}

/**
 * 取会话活着的 agent；没有就冷启动它。
 * AgentRegistry.resume 是 DSH 给「重新打开一个旧会话」用的接口
 * （better-sidebar 复活侧边对话也走这条），所以只认一个会话也够用，不必兜底。
 */
/**
 * 写缓存：带上写入时间，并按上限裁剪最旧的一条（2026-11-04）。
 *
 * SCOPE_FIX 2026-11-12：这个函数原来被贴在 ensureAgent 的函数体中间，只有 ensureAgent 自己看得见。
 * forceResume 也调它 —— resume 成功之后必抛 ReferenceError，被 catch 当成「resume 失败」退回 ensureAgent，
 * 而 ensureAgent 第一步就是查注册表：正好把 forceResume 要绕开的那个死 agent 原样拿回来。
 * 同时改存 agent 本体：原来存的是 resume 返回的 handle，缓存命中时 `cached.agent` 给出去的是 handle 不是 agent。
 */
function rememberResumed(sessionId, handle) {
  resumedAgents.set(sessionId, { agent: handle?.agent ?? handle, at: Date.now() })
  if (resumedAgents.size > RESUMED_MAX) {
    const oldest = [...resumedAgents.entries()].sort((a, b) => Number(a[1]?.at ?? 0) - Number(b[1]?.at ?? 0))[0]
    if (oldest !== undefined) resumedAgents.delete(oldest[0])
  }
}

export async function ensureAgent(ctx, sessionId) {
  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') return undefined

  // 注册表里的键不一定是裸 id：有的地方用 "session-<uuid>"。
  // 先按两种写法都找一遍，找到就是「会话开着」，直接用它，别再 resume。
  const ids = sessionId.startsWith('session-') ? [sessionId, sessionId.slice('session-'.length)] : [sessionId, `session-${sessionId}`]
  for (const id of ids) {
    try {
      const live = agents.get(id)
      if (live !== undefined && live !== null) {
        if (id !== sessionId) note('resume', `用 ${id} 找到了活 agent（裸 id 查不到）`)
        return live
      }
    } catch (error) {
      note('resume', `agents.get(${id}) threw: ${error instanceof Error ? error.message : error}`)
    }
  }

  // 已经替它冷启动过就直接复用，否则每 10 秒会重复 resume 出一堆 agent。
  const cached = resumedAgents.get(sessionId)
  if (cached !== undefined) {
    if (Date.now() - Number(cached.at ?? 0) < RESUMED_TTL_MS) return cached.agent
    resumedAgents.delete(sessionId)
  }
  if (getConfig().resumeColdSession === false) return undefined

  if (typeof agents.resume !== 'function') {
    note('resume', 'agents.resume 不可用')
    return undefined
  }

  const last = lastResumeAttempt.get(sessionId) ?? 0
  if (Date.now() - last < 10000) return undefined
  lastResumeAttempt.set(sessionId, Date.now())

  try {
    // 先把会话从持久层「摸」一下：resume 只认注册表里已知的会话，
    // 有些版本要先经过 sessions.get 才会把它载入索引。
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
      try {
        const known = sessions.get(sessionId)
        note('resume', `内存${known === undefined || known === null ? '无（走冷启动）' : '有（已载入）'}`)
      } catch (error) {
        note('resume', `sessions.get(${sessionId}) threw: ${error instanceof Error ? error.message : error}`)
      }
    }

    const setup = await composeSetup(ctx, sessionId)
    const agentOptions = getConfig().agentOptions
    let handle
    let usedId = sessionId
    try {
      handle = await agents.resume({ resumeSessionId: sessionId, setup, agentOptions })
    } catch (firstError) {
      // 有的版本索引用带前缀的完整 id；换一种写法再试一次。
      const alternate = sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : `session-${sessionId}`
      note('resume', `${sessionId} 直接 resume 失败（${firstError instanceof Error ? firstError.message : firstError}），改用 ${alternate}`)
      handle = await agents.resume({ resumeSessionId: alternate, setup, agentOptions })
      usedId = alternate
    }

    const agent = handle?.agent
    if (agent === undefined || agent === null) {
      note('resume', `${usedId} resume 没返回 agent`)
      return undefined
    }
    rememberResumed(sessionId, handle)
    note('resume', `${usedId} 冷启动成功`)
    return agent
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('resume', `${sessionId} 冷启动失败：${message}`)
    // 「已被活跃写句柄占用」通常意味着会话其实开着、只是注册表键不同，再查一遍。
    for (const id of ids) {
      try {
        const again = agents.get(id)
        if (again !== undefined && again !== null) {
          note('resume', `占用冲突后重查 ${id} 命中`)
          return again
        }
      } catch {
        /* 忽略 */
      }
    }
    return undefined
  }
}


/**
 * forceResume（2026-10-31）：ensureAgent 会返回缓存里那个「活着但上下文已死」的 agent，
 * 所以这里先把缓存清掉再走一遍完整 resume，逼出新的 agent。
 */
export async function forceResume(ctx, sessionId) {
  // 2026-10-31 小肥鱼修：原来的实现只删了插件自己的两个 Map，
  // 但 ensureAgent 一进来先查 agents.get()，注册表里那个「活着但上下文已死」的 agent
  // 会被原样返回 —— 等于换了半天还是同一个死人。这里改成直接走 agents.resume，
  // 绕开注册表那一步；失败才回退到 ensureAgent（保持旧行为）。
  try { resumedAgents.delete(sessionId) } catch { /* 忽略 */ }
  try { lastResumeAttempt.delete(sessionId) } catch { /* 忽略 */ }

  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.resume !== 'function') {
    note('diag', `forceResume ${sessionId} agents.resume 不可用，回退 ensureAgent`)
    return ensureAgent(ctx, sessionId)
  }

  try {
    const setup = await composeSetup(ctx, sessionId)
    const agentOptions = getConfig().agentOptions
    let handle
    let usedId = sessionId
    try {
      handle = await agents.resume({ resumeSessionId: sessionId, setup, agentOptions })
    } catch (firstError) {
      // 有的版本索引用带前缀的完整 id；换一种写法再试一次。
      const alternate = sessionId.startsWith('session-')
        ? sessionId.slice('session-'.length)
        : `session-${sessionId}`
      note('diag', `forceResume ${sessionId} 首试失败（${firstError instanceof Error ? firstError.message : firstError}），改用 ${alternate}`)
      handle = await agents.resume({ resumeSessionId: alternate, setup, agentOptions })
      usedId = alternate
    }
    const agent = handle?.agent
    if (agent === undefined || agent === null) {
      note('diag', `forceResume ${sessionId} 直接 resume 没返回 agent，回退 ensureAgent`)
      return ensureAgent(ctx, sessionId)
    }
    rememberResumed(sessionId, handle)
    lastResumeAttempt.set(sessionId, Date.now())
    note('diag', `forceResume ${usedId} 直接 resume 成功（绕过注册表缓存）`)
    return agent
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('diag', `forceResume ${sessionId} 直接 resume 失败：${message}，回退 ensureAgent`)
    return ensureAgent(ctx, sessionId)
  }
}
