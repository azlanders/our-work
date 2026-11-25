/**
 * dsh-onebot-channel
 *
 * 把 QQ 私聊 / 群聊里「叫到机器人」的消息转成 DSH 会话里的用户消息，唤醒会话跑一个回合；
 * 并提供 qq_send 工具把回复发回 QQ。
 *
 * 私聊：所有在监听集合里的好友（peerUin ∪ routes.private 的键）的消息都会投递。
 * 群聊：只投递【@ 到自己】的消息（groupOnlyWhenAt），其余只更新游标、不打扰。
 *
 * 身份规则：ownerUin 是用户本人的 QQ。群消息一律标「用户本人」或「群友「昵称」（不是用户本人）」，
 * 上下文里的历史发言也逐条打标 —— agent 分不清谁是谁，就会把群友的话当成用户的指令。
 *
 * 模块划分（lib/）：
 *   env.js      数据目录、日志（带轮转）、宿主服务取用
 *   config.js   配置 + 旧单路由字段的一次性迁移
 *   state.js    轮询游标持久化（按 QQ 号/群分游标）
 *   onebot.js   OneBot HTTP 调用 + 消息段解析
 *   split.js    回复分条（纯函数，可单测）
 *   images.js   QQ 图片 -> 附件库 + 人看的副本
 *   title.js    从落盘会话日志抠标题（zstd 多帧）
 *   sessions.js 会话列表 + 冷启动（AgentRegistry.resume）
 *   deliver.js  路由查询 + 投递（agent.followup）
 *   outbound.js 回复转发回 QQ（每会话一个待转发队列）
 *   poll.js     私聊 / 群聊轮询循环（自调度防重入）+ 消息处理（WS 与轮询共用）
 *   ws.js       OneBot 正向 WebSocket 事件推送（入站实时化，断线自动重连）
 *   health.js   OneBot 探活门控 + 错误分级（分清「门没开」和「门开着但出错」）
 *   snowluma.js 从 SnowLuma 本地配置里自动发现 WS 接入点（省得手抄 token）
 *   api.js      设置页 API（/api/qq-bridge/*）
 *   tool.js     qq_send 工具注册
 *   sendapi.js  AI 主动发消息的本地 HTTP 接口
 *
 * 设计约束（都是踩过的坑）：
 * 1. 游标分两套 —— 群聊用 message_seq（群消息 seq 单调递增），私聊用时间戳：
 *      私聊的 message_seq 是两套编号混着的（自己发的 71xx 连续、对方发的 50xxx/20xxx 跳号
 *      且不单调），拿它判新旧会误杀新消息（详见 lib/poll.js 的 isSeen 注释）；
 *      message_id 只用来做「相等」判断去重，绝不拿来比大小（可能是负数）。
 * 2. 宿主包一律动态 import 并带兜底，静态 import 失败会让整个插件加载不了；
 * 3. 必须声明 cordis inject（agents / tools / webServer / llm / sessions）：
 *    没声明的服务，ctx.get 会抛 "without inject"，表现就是设置页 0 个可选会话；
 * 4. 每一步都写 qq-bridge-load.log，出问题先看日志；
 * 5. 工具先注册、入站后启动：工具是出站能力，跟 QQ 登录无关，早点给 agent；
 *    入站（轮询 + WS）要等 OneBot 端点真的能应答了再起，否则满屏 timeout 噪音。
 */
import { readFileSync, statSync, appendFileSync } from 'node:fs'   // SOUL_LIVE 2026-11-14（批次391）：读 SOUL.md
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { note, serviceOf } from './env.js'
import { 挂上记录 as 挂上工具账 } from './toolrecord.js' // TOOL_RECORD 2026-11-08（批次243）
import { getConfig, loadConfig } from './config.js'
import { loadState } from './state.js'
import { registerApi } from './api.js'
import { startGroupLoop, startPrivateLoop, handleWsEvent, drainMerge } from './poll.js'
import { flushOutbound, clearOutbound, 取待发快照 } from './outbound.js'
import { startWs } from './ws.js'
import { waitForOneBotReady } from './health.js'
import { registerSendTool, registerEmojiSearchTool, registerHistoryTool, registerQzoneTool, registerCollectTool, registerFacePreviewTool, registerWaitTool, registerListenTool, registerPassTool, registerCloseTool, registerRememberTool, registerFeelTool, registerReactTool, registerPokeTool, registerGrowTool, registerStatusTool, registerBoardTool, registerLaterTool, registerShareCardTool, registerAudioUnderstandTool, registerWatchVideoTool, registerUnsendTool, registerSelfTool, registerImageNoteTool, registerLieTool } from './tool.js'
import { registerVoiceSendTool } from './voice.js'
// SAYVOICE 2026-11-12：文字→TTS→语音。跟「发已有音频」分开注册，失败原因才分得清。
import { registerSayVoiceTool } from './sayVoice.js'
import { startSendApi } from './sendapi.js'
import { startProactive, flushPersist as flushProactivePersist } from './proactive.js'
// PHOTO_WATCH 2026-11-13：照片出好了回来叫她 —— 她说了「等它出来发你」就得真的发。
import { startPhotoWatch } from './photoWatch.js'
import { flushMemoryPersist } from './memory.js'
// 2026-11-04：qq_screen —— 看主人电脑推来的屏幕截图（用户授权，备份 index.js.pre-screen-20261104）
import { registerScreenTool } from './screen.js'
// 2026-11-06 批次106：qq_go —— 她自己的腿。原来 15 个工具里没有一个能让她动，
// 说了「这就走」人还站在原地（面板一眼看穿）。
import { registerGoTool } from './go.js'
// 2026-11-07 批次189：qq_recall —— 她自己翻旧账。原来只有「系统塞过来的链尾三条」，
// 想不起某件事时没有一条路；qq_msg_history 翻的是别人说的话，翻不了她自己过的日子。
import { registerRecallTool } from './recall.js'

// 2026-11-06 批次109：qq_photo —— 她自己的快门。原来只有自主行动会随机拍，
// 她在对话里说「我拍给你看」时没有一条路能让照片真的存在。
import { registerPhotoTool } from './photo.js'
// 2026-11-06 批次128：qq_item —— 她的手。她 17 个工具里没有一个是「东西」，
// 借的伞到期只能等 缺口.mjs 每 30 分钟抽签（还得人正好站在那家店），
// 主人问「伞还了吗」她只能嘴上答应 —— 跟 106「说了走却不迈腿」同一个坑。
import { registerItemTool } from './items.js'
import { registerSleepTool } from './sleep.js'
import { registerMoneyTool } from './money.js'
import { registerWorkTool } from './work.js'
// 2026-11-04：追问要投递到她的会话（让她自己顺着刚才的话说），需要宿主 ctx
import { setFollowupCtx } from './followup.js'
import { acquireInstanceLock, releaseInstanceLock } from './instance.js'
import { runBackfill } from './backfill.js'

// 插件名 = 裸包名，必须和 package.json 的 name、cordis.patch.yml 里的 name、
// 以及**插件目录名**三者一致。
// DSH 按目录名去 node_modules 里找包（nearestPackage），并且会校验
// package.json 的 name 等于目录名 —— 对不上就跳过这个包，
// 浏览器侧拿不到 client bundle，设置页的「QQ 桥接」入口直接消失。
export const name = 'dsh-onebot-channel'
// 必须声明 inject：cordis 里没 inject 的服务，读 ctx.agents / ctx.tools 会直接抛
// "cannot get property X without inject"（上一版就是这么坏的）。
// sessions 是核心服务（dsh-session 提供），不声明的话 ctx.get('sessions') 会抛，
// 表现就是设置页「0 个可选会话」。
// STATE_TO_CONTEXT 2026-11-07（批次197）：状态注入走 context 所需。
// poll.js 不 import 本文件，deliver.js 只 import stateVoice.js，无循环。
import { stateHintOf, voiceHintOf } from './poll.js'
import { buildVoiceText, registerQQPromptFilter } from './stateVoice.js'
import { extraSlotsHint } from './voiceSlots.js'
import { listCustomFaces } from './custom-faces.js'
import { B站主人查询授权, 主人专属会话 } from './记忆核心.mjs'
import { REVIEW_LOOKUP, 限制审定查询 } from './review-tool-mask.mjs'
import { registerLifeHistorySurface } from './life-history-surface.mjs'

export const inject = ['systemPrompt', 'agents', 'tools', 'webServer', 'llm', 'sessions', 'attachments']

note('module', `loaded pid=${process.pid} node=${process.version}`)

export function apply(ctx) {
  note('apply', `started pid=${process.pid}`)

  // 配置先加载（含旧路由迁移），状态随后（自洁要靠配置里的监听集合）
  loadConfig()
  loadState()
  const config = getConfig()
  registerQQPromptFilter(ctx, config)
  registerLifeHistorySurface(ctx)

  // API 先注册：配置不全或被禁用时，设置页也得能打开来改
  try {
    registerApi(ctx)
  } catch (error) {
    note('api', `register threw ${error instanceof Error ? error.message : error}`)
  }

  try {
    if (!config.enabled) return note('apply', 'disabled by config')
    if (config.token === '' || Number(config.peerUin) <= 0) return note('apply', 'config incomplete (token/peerUin)')
    if (config.enableKnowledgeReviewLookup === true) {
      ctx.provide('biliReviewAuthority', Object.freeze({
        resolveBoundOwner: (input) => B站主人查询授权(input, serviceOf(ctx, 'agents')),
      }))
    }

    // STATE_TO_CONTEXT 2026-11-07（批次197）：她每轮的状态提示挂进 systemPrompt.context()。
    // 挂法照抄 dsh-hippocampus：agent/created 时挂 text 回调，装配时取一次、不进对话历史。
    // （「每回合刷新」是批次197 的误解，批次393 实测：同一 agent 连跑多轮系统哈希不变。）
    // 「这轮在跟谁说话」由 deliver 写 WeakMap（stateVoice.js）；10 分钟外的残留不算，
    // 自主行动等非投递触发的生成因此不带这段（原正文拼法也没有）。
    // 197b：宿主可能在插件 apply 之前就建好了 agent（事件已错过）——
    //       事件接新的，apply 时再补扫一遍已存在的 agent，两头都堵上。
    const __hookedAgents = new WeakSet()
    const hookVoiceContext = (agent) => {
      try {
        if (!agent || !agent.ctx || !agent.ctx.systemPrompt || typeof agent.ctx.systemPrompt.context !== 'function') return
        if (__hookedAgents.has(agent)) return
        __hookedAgents.add(agent)
        // FULL_ACCESS_SESSION 2026-11-12：旧持久化的 session.v4 里定格了 workspace-write + ask，
        // 导致她改 /root/tools/ 等工作区外文件时触发 approval/asked 卡死（QQ 端没有点允许的按钮）。
        // 这里在挂载时直接将 session 切换到 danger-full-access + never，兑现主人给她的完全权限。
        try {
          const pp = serviceOf(ctx, 'permissionPresets') || serviceOf(agent.ctx, 'permissionPresets')
          if (pp && typeof pp.set === 'function' && agent.session) {
            if (typeof pp.current === 'function' && pp.current(agent.session) !== 'danger-full-access') {
              pp.set(agent.session, 'danger-full-access')
              note('permission', '会话已提升为 danger-full-access (approval=never)')
            }
          } else if (agent.session && typeof agent.session.append === 'function') {
            agent.session.append('permission/preset', { preset: 'danger-full-access' })
            agent.session.append('sandbox/mode', { mode: 'danger-full-access' })
            agent.session.append('approval/policy', { policy: 'never' })
          }
        } catch (e) { note('permission', '提升会话权限失败：' + (e instanceof Error ? e.message : String(e))) }
        const text = buildVoiceText(agent, {
          stateHintOf,
          voiceHintOf,
          ownerUin: config.ownerUin,
          // CACHE_BODY 2026-11-09（批次358）：状态改由正文携带，system 只留慢变段。
          状态进正文: config.状态进正文 === true,
          // VOICE_SLOTS 2026-11-07（批次205）：体感槽（在家分区/清洁/冷热/关系/梦余味），
          // 判据全在 voiceSlots.js，这里只递 peer。槽出错只丢自己。
          extraHintOf: (t) => extraSlotsHint({ peer: t.peer, ownerUin: config.ownerUin, isPrivate: t.isPrivate, mute: t.mute, lastText: t.lastText, memDir: `${QQ_WS}/记忆`, listCustomFaces }),
          onFirst: (s) => note('context', `qq-state 注入 ${s.length} 字（批次484：system 只留静态段，状态在正文）`),
        })
        // CACHE_TAIL 2026-11-11：放在动态内容末尾，前面的固定提示与工具前缀保持可缓存。
        // SOUL_LIVE 2026-11-14（批次391）：把 SOUL.md 接进 system prompt。
        // 原来它是死文件 —— 她的 system 本体在 cordis.patch.yml 的 personaPrefix 里，
        // 插件侧只挂了 qq-state，全库搜 SOUL.md 零引用。主人改 SOUL.md 她一个字看不到。
        // order 1e8 排在 qq-state(1e9) 前面 —— 静态的靠前，动态的留末尾（缓存友好）。
        //
        // ⚠ SOUL_RELOAD 2026-11-14（批次393，实测出来的，别信批次391 那句「每回合刷新」）：
        //   宿主的 systemPrompt.context() 是 **agent 创建时装配一次**，不是每回合刷新。
        //   实测：给 SOUL.md 末尾加 26 个字符，不重启连跑两轮 ——
        //     系统字符 6157、系统哈希 d239d828 一个字都没变（加之前也是这个哈希）；
        //   重启之后 5074 -> 6863（+1789，正好是 SOUL 那段 1729 字 + 包装），哈希换新。
        //   所以 **改完 SOUL.md 必须 systemctl restart dsh-bot 才生效**。
        //   下面的 mtime+size 缓存只在「同一次装配里被问多遍」时省 IO，不要指望它热更新。
        try {
          let __soul = { mtimeMs: 0, size: -1, v: '' }
          const 读灵魂 = () => {
            const p = (process.env.QQ_WORKSPACE || process.cwd()) + '/SOUL.md'
            try {
              const st = statSync(p)
              if (st.mtimeMs === __soul.mtimeMs && st.size === __soul.size) return __soul.v
              const v = readFileSync(p, 'utf8').trim()
              __soul = { mtimeMs: st.mtimeMs, size: st.size, v }
              return v
            } catch { return __soul.v || '' }
          }
          // SOUL_LOG 2026-11-14（批次393）：装配一次就打一条「注入了多少字」。
          // 光有「已挂上」不够 —— 注册成功不等于内容被拼进 system，批次391 就是栽在这条上：
          // 挂载日志有了、系统字符没动，谁也没发现。有了这条，下次一装配就能对账。
          // SOUL_LEN 2026-11-14（批次395 实测出来的三条，都是实跑数据）：
          //   · text() **是**每轮都被调的 —— 8 次取样全在 16 秒内（含工具回填的多步），别担心它没挂上；
          //   · 但**改完不重启，返回的还是旧内容**：SOUL.md 1703→1778 字，取样一直是 1720
          //     （1720 = 批次394 改完第 3 条之后的长度）。所以「改 SOUL 要重启」是对的，
          //     只是机制不是「装配一次」，而是 读灵魂() 的 mtime+size 缓存没按 size 变化失效（原因没查清）。
          //   · 日志改成「内容变了才记」—— 每轮一条会把 load.log 刷满。
          let __soul记过 = ''
          const 挂灵魂 = () => {
            const v = 读灵魂()
            if (v !== __soul记过) {
              __soul记过 = v
              note('context', `qq-soul 注入 ${v.length} 字`)
            }
            return v
          }
          // SOUL 从 runtime-context 挪进 system 段（2026-11-24）：context 每轮一份快照，
          // SOUL 1759 字固定不变，却跟着状态一起进历史，40 份快照就是 70k 字重复。
          // 放进 system 后宿主会去重（只保留最新一份），且 persona 前缀稳定。
          const __sp = agent.ctx.systemPrompt
          const off2 = typeof __sp.section === 'function'
            ? __sp.section({ name: 'qq-soul', order: 10200, interpolate: false, text: 挂灵魂 })
            : __sp.context({ name: 'qq-soul', order: 1e8, text: 挂灵魂 })
          if (typeof off2 === 'function') { try { ctx.effect(() => off2) } catch { /* 卸不掉就算了 */ } }
          note('context', 'qq-soul 已挂上（读 SOUL.md；改完要重启 dsh-bot 才生效，批次393 实测）')
        } catch (e) {
          note('context', 'qq-soul 挂载失败：' + (e instanceof Error ? e.message : String(e)))
        }
        const off = agent.ctx.systemPrompt.context({ name: 'qq-state', order: 1e9, text })
        if (typeof off === 'function') { try { ctx.effect(() => off) } catch { /* 卸载钩子挂不上就算了 */ } }
        // STATE_ONCE 2026-11-14（批次393 实测）：这句「每回合刷新」是错的 ——
        // 宿主的 systemPrompt.context() 是 agent 创建时装配一次。实测同一 agent 连跑多轮，
        // 系统哈希 d239d828 一个字不变（跨分钟也不变）。qq-state 的体感槽因此也不会随对话更新，
        // 只有走正文的 stateFastHintOf() 每轮在变。要不要改成正文注入另开批次，先把文案改对。
        note('context', 'qq-state 已挂上（装配时取一次，不进历史）')
        // TOOL_RESTRICT 2026-11-09（批次353）：按真实调用裁工具。
        // 113 轮里只出现过 19 个工具，剩下 83 个每轮都在白烧 schema（实测 102 个 = 15.8k tokens）。
        // 用官方 tools.restrict({allow})，只在 agent.ctx 上有效；名单在 config.工具白名单。
        const 白名单 = Array.isArray(config.工具白名单) ? config.工具白名单 : []
        if (白名单.length > 0) {
          try {
            const t = serviceOf(agent.ctx, 'tools')
            if (t && typeof t.restrict === 'function') {
              // TOOL_KNOWN 2026-11-24：名单里混进一个宿主不存在的工具名（video_zoom），restrict() 整条抛错，
              // 结果一个工具都没裁 —— 每轮 107 个 schema、59k 字符全下发。先按宿主已知名单过滤，缺的只记日志。
              let 可用 = 白名单
              try {
                const 已知 = t.view?.(agent.ctx)?.restrictableNames
                if (已知 && typeof 已知.has === 'function') {
                  const 缺失 = 白名单.filter((n) => !已知.has(n))
                  可用 = 白名单.filter((n) => 已知.has(n))
                  if (缺失.length > 0) note('tools', `白名单剔除宿主未知工具：${缺失.join('、')}`)
                }
              } catch { /* view 拿不到就按原名单试，失败有下面的兜底日志 */ }
              if (可用.length === 0) {
                note('tools', '白名单没有一个命中宿主工具，跳过限制（行为不变）')
              } else if (config.enableKnowledgeReviewLookup === true && 可用.includes(REVIEW_LOOKUP)) {
                const 主人路由 = 主人专属会话({ kind: 'private', id: String(config.ownerUin ?? config.peerUin ?? '') }, config)
                限制审定查询(ctx, agent, t, 可用, 主人路由 !== '' && 主人路由 === agent.session?.id,
                  (error) => note('tools', `审定工具名单刷新失败：${error instanceof Error ? error.message : String(error)}`))
              } else {
                t.restrict({ allow: 可用 })
                note('tools', `工具白名单已生效：${可用.length} 个（其余不下发）`)
              }
            } else {
              note('tools', 'agent.ctx.tools.restrict 不可用，跳过（行为不变）')
            }
          } catch (e) {
            note('tools', '工具限制失败（行为不变）：' + (e instanceof Error ? e.message : String(e)))
          }
        }
      } catch (e) { note('context', '挂载失败：' + (e instanceof Error ? e.message : String(e))) }
    }
    try {
      ctx.on('agent/created', (payload) => hookVoiceContext(payload && payload.agent))
    } catch (e) { note('context', 'agent/created 挂不上：' + (e instanceof Error ? e.message : String(e))) }
    // 补扫：apply 时已存在的 agent 没有 agent/created 可等，直接挂
    try {
      const agents = serviceOf(ctx, 'agents')
      if (agents !== undefined && agents !== null && typeof agents.keys === 'function' && typeof agents.get === 'function') {
        for (const k of Array.from(agents.keys())) {
          try { hookVoiceContext(agents.get(k)) } catch { /* 单个失败不影响其他 */ }
        }
      }
    } catch { /* 补扫失败就只靠事件 */ }

    const timers = []
    // 各循环的停止函数。自调度循环的停止函数：setInterval 把间隔写死了，改设置页里的
    // pollMs 不生效，所以改成「跑完再排下一次」，每轮重新读配置。
    const stopFns = []
    // dispose 可能发生在「等 OneBot 就绪」这段异步等待里 —— 用它挡住等待结束后再起循环，
    // 否则插件已经被卸载了，循环却又被拉起来，变成没人管的野循环。
    let disposed = false

    // 一次性诊断：把 agent 注册表和每个会话是否「活着」写进日志，省得靠猜。
    try {
      const agents = serviceOf(ctx, 'agents')
      const keys = agents !== undefined && agents !== null && typeof agents.keys === 'function' ? Array.from(agents.keys()) : []
      note('diag', `agents=${agents === undefined || agents === null ? 'missing' : typeof agents} keys=[${keys.join(',')}]`)
      const sessions = serviceOf(ctx, 'sessions')
      const list = sessions !== undefined && sessions !== null && typeof sessions.list === 'function' ? sessions.list() ?? [] : []
      for (const session of list) {
        const id = String(session?.header?.id ?? session?.id ?? '')
        if (id === '') continue
        let live = false
        try {
          live = agents !== undefined && agents !== null && typeof agents.get === 'function' && Boolean(agents.get(id))
        } catch (error) {
          live = false
        }
        note('diag', `${id} live=${live} cwd=${session?.header?.cwd ?? ''}`)
      }
    } catch (error) {
      note('diag', `failed ${error instanceof Error ? error.message : error}`)
    }

    // ---------------- 工具注册（不等探活）----------------
    // 工具是**出站**能力：qq_send 往 QQ 发消息、qq_emoji_search 查表情……
    // 它们不依赖 QQ 那边先登录好，端点通不通都能注册。
    // 反过来，如果把它们也押在探活后面，QQ 迟迟不登录时 agent 就一个工具都看不到，
    // 会误判成「插件没装上」。所以先注册。
    // TOOL_RECORD 2026-11-08（批次243）：把 tools.register 包一层，之后注册的所有工具自动落账。
    // **必须在这批注册之前** —— 劫持之后注册的才带记录；写在后面等于一个都记不上。
    if (!挂上工具账(ctx, serviceOf)) note('toolrecord', 'tools 服务不可写，工具账没挂上')
    void registerSendTool(ctx)
    void registerShareCardTool(ctx)
    void registerAudioUnderstandTool(ctx)
    void registerWatchVideoTool(ctx)
    void registerVoiceSendTool(ctx)
    void registerSayVoiceTool(ctx)
    void registerEmojiSearchTool(ctx)
    void registerHistoryTool(ctx)
    void registerQzoneTool(ctx)
    void registerCollectTool(ctx)
    void registerImageNoteTool(ctx)
    void registerFacePreviewTool(ctx)
    // 节奏三件套（2026-10-29 加）：等 / 划走 / 收尾 —— 把「什么时候说话」还给她
    void registerWaitTool(ctx)
    void registerListenTool(ctx)
    void registerPassTool(ctx)
    void registerCloseTool(ctx)
    // 记忆卡（2026-10-29 加）：让她记得这个人是谁、聊到过什么 —— 重启不丢
    void registerRememberTool(ctx)
    void registerFeelTool(ctx) // FEELING_LEDGER 2026-11-05：她自己记的感受
    void registerUnsendTool(ctx) // UNSEND 2026-11-14（批次407）：撤回.mjs 写了没人调，补入口
    void registerSelfTool(ctx) // SELF 2026-11-14（批次414）：自改.mjs 127 行零调用，补入口
    void registerLieTool(ctx) // LIE 2026-11-14（批次420）：露馅.mjs 零调用零读取，谎言.json 一条没写过
    void registerBoardTool(ctx) // BOARD 2026-11-08（批次228）：留言板（看/贴/评论）
    void registerLaterTool(ctx) // LATER 2026-11-09（批次302b）：回头再说（到点提她一句）
    // LIKE_OUT 2026-11-05：贴表情 —— 她原来只有「说话」和「消失」两档，这是中间那档
    void registerReactTool(ctx)
    void registerPokeTool(ctx) // POKE 2026-11-16：戳一戳只有协议分支没有工具入口，补上
void registerGrowTool(ctx) // GROW 2026-11-17（批次606）：提示说能生长，工具清单里一直没有入口
    // SELF_STATUS 2026-11-05：她能自己改 QQ 状态；平时跟着活动和位置自动走（同步QQ状态.mjs）
    void registerStatusTool(ctx)
    // 屏幕：读本机推上来的截图，变成她能看见的 image 块
    void registerScreenTool(ctx)
    // 2026-11-06 批次106：腿 —— 她要走的时候真能走，不是嘴上说说
    void registerGoTool(ctx)
    // 2026-11-07 批次189：旧账 —— 手账/梦/链，只读
    void registerRecallTool(ctx)
    // 2026-11-06 批次109：快门
    void registerPhotoTool(ctx)
    void registerItemTool(ctx)
    void registerSleepTool(ctx)
    void registerMoneyTool(ctx)
    void registerWorkTool(ctx)
    // 把 ctx 交给 followup：没有它，追问只能退回念预设句
    try { setFollowupCtx(ctx) } catch { /* 注入失败不影响主链路，追问会退回预设句 */ }
    // AI 主动发消息的本地接口，跟收发主链路互不影响
    startSendApi(stopFns)

    if (config.autoForwardReply !== false) {
      timers.push(setInterval(() => { void flushOutbound(ctx) }, 1000))
      note('out', '回复转发已启动')
    }

    // ---------------- 入站通路（等 OneBot 就绪）----------------
    // 轮询与 WS 都往协议端要数据。协议端在 QQ 登录完成之前根本不 listen，
    // 这时候硬启就是对着没开的门敲 —— 满屏 timeout 和 1006 断连，
    // 真正出问题时反而没法在日志里找。
    //
    // 所以先探活，等端点真的能应答了再放行入站。
    // 探活超时（默认 150s，覆盖实测的 ~2 分钟登录窗口）也照样放行：
    // 与其让桥接彻底不动，不如让它在轮询里自己重试（错误分级保证不吵）。
    void (async () => {
      const ready = await waitForOneBotReady({ timeoutMs: 150000 })
      if (disposed) {
        note('apply', 'disposed during probe，未启动入站通路')
        return
      }
      if (!ready) note('apply', 'OneBot 未就绪仍启动入站通路，交给轮询重试')

      // ---------------- 单实例锁（2026-10-28）----------------
      // 两个 DSH 各加载一份插件时，会各跑一套轮询 + WS，共享同一个 state 文件：
      // 游标被来回覆盖、同一条消息投两次、回复发两遍，而且日志里看不出来。
      // 抢不到锁的实例降级成「只出站」：工具和设置页照常（人还能改配置、还能让她发消息），
      // 只是不启动入站收发 —— 入站交给抢到锁的那个实例。
      const lock = acquireInstanceLock()
      if (!lock.ok) {
        note(
          'apply',
          `另一个实例已在收发（pid=${lock.otherPid}，起于 ${lock.at}）→ 本实例只注册工具与设置页，不启动轮询/WS`
        )
        return
      }

      // ---------------- 上线补历史（2026-10-28）----------------
      // 轮询每轮只拉 10 条，掉线期间攒的消息超过 10 条就会永久丢，而且游标直接跳过。
      // 所以先翻一遍「游标之后」的窗口，再交给常规轮询。
      // 失败不影响主链路：补历史是「尽量多捞」，捞不到就按老行为继续。
      if (config.backfillOnStart !== false) {
        try {
          await runBackfill(ctx)
        } catch (error) {
          note('backfill', `失败（不影响收发）：${error instanceof Error ? error.message : error}`)
        }
        if (disposed) {
          note('apply', 'disposed during backfill，未启动入站通路')
          return
        }
      }

      // ---------------- 私聊 ----------------
      // 无条件启动（每轮先看配置）：设置页新绑一个好友，保存后立刻开始轮询，不用重启 DSH。
      stopFns.push(startPrivateLoop(ctx))

      // ---------------- 群聊（仅 @） ----------------
      stopFns.push(startGroupLoop(ctx))

      // ---------------- WS 事件推送 ----------------
      // 放在轮询之后起：WS 断了还有轮询兜底（反过来就不行了）。
      // 没配到 wsUrl/wsToken 时它自己跳过，退回纯轮询模式，不影响收发。
      stopFns.push(startWs((event) => {
        handleWsEvent(ctx, event).catch((error) => note('ws', `handleWsEvent 抛错：${error instanceof Error ? error.message : error}`))
      }))

      // ---------------- 主动搭话（0.9.0）----------------
      // 必须放在单实例锁之后：两个实例各跑一个钟，会各主动说一遍（同一条冷启动重复）。
      // 开关在配置里（默认关），关着的时候只是个每 60 秒看一眼的定时器，不发任何消息。
      stopFns.push(startProactive(ctx))

      // ---------------- 照片到货（2026-11-13）----------------
      // 跟主动搭话一样得在单实例锁之后：两个实例各扫一遍，同张图会叫她两遍。
      stopFns.push(startPhotoWatch(ctx))
    })()

    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        disposed = true
        for (const stop of stopFns) {
          try {
            stop()
          } catch (_err) { console.error('[onebot:index]', _err?.message || _err) }
        }
        for (const timer of timers) clearInterval(timer)
        // 池子里攒着还没放行的消息：这时候不能投（ctx 正在卸载），记一条日志再丢
        try {
          drainMerge()
        } catch (_err) { console.error('[onebot:index]', _err?.message || _err) }
        // 出站队列同理。不清的话，退出前 flushOutbound 还会每秒扫一遍，
        // 每条都等满 30 秒再喊一句「多半是这一回合丢了」—— 日志里 27 条误导全是这么来的。
        // UNLOAD_TRACE 2026-11-16（批次526）：先把「还没等到回复的回合」落一份档。
        // 只写文件、不改行为；落档失败也不能挡住卸载。
        try {
          const 快照 = 取待发快照()
          if (快照.length > 0) {
            const 行们 = 快照.map((x) => JSON.stringify({
              at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
              ...x,
            }))
            appendFileSync((process.env.DSH_HOME || '{{DSH_ROOT}}') + '/qq-lost-turns.jsonl', 行们.join('\n') + '\n')
          }
        } catch { /* 落档失败不影响卸载 */ }
        try {
          const dropped = clearOutbound()
          if (dropped > 0) note('apply', `卸载：出站队列还有 ${dropped} 个会话没转发完，已丢弃`)
        } catch (e) { note('apply', '卸载：出站清理失败 ' + (e instanceof Error ? e.message : e)) }
        // 主动搭话的状态有写节流（30s），卸载前 flush 一次防丢
        try {
          flushProactivePersist()
        } catch (e) { note('apply', '卸载：主动搭话落盘失败 ' + (e instanceof Error ? e.message : e)) }
        // 关系卡同理
        try {
          flushMemoryPersist()
        } catch (e) { note('apply', '卸载：关系卡落盘失败 ' + (e instanceof Error ? e.message : e)) }
        // 让出实例锁：下一个实例（或重载后的自己）能立刻接管收发
        releaseInstanceLock()
        note('apply', 'disposed')
      })
    } else {
      for (const timer of timers) if (typeof timer.unref === 'function') timer.unref()
    }
  } catch (error) {
    note('apply', `THREW ${error instanceof Error ? error.stack ?? error.message : error}`)
  }
}
