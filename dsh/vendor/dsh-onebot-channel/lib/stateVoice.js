/**
 * stateVoice.js —— 批次197：她每轮的状态提示从「每批正文开头」挪进 systemPrompt.context()。
 *
 * 为什么挪：原来 poll.js 把 stateHintOf()+voiceHintOf() 拼在每批消息正文的最前面，
 * 那段 ~2400 字**进了对话历史**——每批一份，会话文件里同样的 [态] 行重复上百遍，
 * 白烧历史空间；而且它本来就不是「某一方说的话」，混在正文里她分不清哪句是谁说的。
 * systemPrompt.context() 的语义（见 dsh-hippocampus 的用法）：不进历史、每回合刷新一次。
 *
 * 这里的三件事：
 *   · markVoiceTarget：deliver 在投递前写「这一批是跟谁说话」（唯一写点，所有投递必经）
 *   · voiceTargetOf：context 的 text 在生成时读，10 分钟外的残留不算「正在跟人说话」
 *     —— 自主行动等非投递触发生成不该带聊天状态段
 *   · buildVoiceText：text 回调本体。stateHintOf/voiceHintOf 由 index.js 注入，
 *     这里不 import poll.js（poll → deliver → 本文件，再回头 import poll 会成环）
 *
 * 判据都在这一个小文件里，测试不 import 也跑不了别的模块。
 */
const targets = new WeakMap() // agent -> { peer, isPrivate, mute, at }

/** deliver 投递前写：这批消息是跟谁说的。peer 空串不记（拿不到就当没有）。 */
export function markVoiceTarget(agent, t) {
  if (!agent) return
  if (!t || String(t.peer ?? '') === '') return
  targets.set(agent, {
    peer: String(t.peer),
    isPrivate: Boolean(t.isPrivate),
    mute: Boolean(t.mute),
    // 批次206：当轮消息文本（截断），给 stateHintOf 的临场提示用（接他的口/惦记追问）
    lastText: String(t.lastText ?? '').slice(0, 120),
    at: Number(t.at || Date.now()),
  })
}

/** 读「这轮在跟谁说话」。now 可注入（单测造过期用）。过期/没有都返回 null。 */
export function voiceTargetOf(agent, now = Date.now()) {
  const t = agent ? targets.get(agent) : null
  if (!t) return null
  if (now - Number(t.at || 0) > 10 * 60 * 1000) return null
  return t
}

/** 主人私聊的全权段（原 poll.js 批次 2026-11-06 那句，一字未动；现在跟着状态段一起走 context）。 */
export const FULL_ACCESS_LINE =
  '（主人已经给你完全权限了：你自己的代码、参数、工具想改就改，不用等谁点头。'
  + '改之前先备份、改完自己跑一遍验证，别把自己弄哑；改坏了能自己回滚。）\n'
  // TECH_SILENT 2026-11-14（批次477）：私聊这条链原来只有「全权」没有「别念技术细节」——
  // poll.js 那段 modeHint 只拼在群聊正文里，私聊 body = 状态段 + 消息，一个字都进不去。
  // 于是她把「会话文件涨到 34.5MB（session-2d2c5 / 6fdf5 / 5fe1c）」直接当消息发给了主人，
  // 而面板待办里「会话体检」早就写着同一条。主人原话：「把这个在聊天栏停了，我已经让她搞到 webui 页面里面了」。
  + '技术/运维的事（会话文件多大、session id、磁盘、进程、部署、端口、日志路径、参数）别当消息念给他 —— 那些他面板待办里都看得见。真要他点头，就说「有件事等你点头」，一句带过；细节写面板待办或留言板。\n'

/**
 * 生成 context 的 text 回调。deps 里 stateHintOf/voiceHintOf 由调用方注入（防循环 import）。
 * 任何一步出错都返回 '' —— 状态提示是锦上添花，绝不能把生成弄哑。
 */
// STYLE_NO_SUPPORT 2026-11-15（批次506b）：她的群聊文字 2249 条里「我这边」154 条（6.8%）、
// 「这边」173 条（7.7%），而「其实/确实/有点」都在 1% 上下 —— 这是典型的客服腔，不像人。
// 放静态段：每轮都在，但不进正文、不改前缀（它不随时间变，Prefix Cache 照样命中）。
// SEND_FIRST 2026-11-15（批次507d）：先开口，再干活。
// SPEAK_FIRST 2026-11-16（批次521b）：三条规则合并成一条。
//
// 原来分别叫 SEND_FIRST_RULE / URGENT_LAST_RULE / BODY_NOT_SENT_RULE，讲的是同一件事的三个侧面：
//   · 批次506b 数据：358 个有开口的回合里 66 个（18%）在 qq_send 前先调工具，每次多 5.2 秒
//   · 批次515 实录：01:11:20 他说「你记在台账或者什么地方捏」，她先翻了两分钟收藏夹才回
//   · 批次518 实录：03:56 她看完视频把点评写在正文里没调 qq_send，主人干等 5 分钟
// 三条合计 262 字，每轮都注入，语义大量重叠（都在说「先说话」）。
// 合并成 150 字，要点一个不少，且省下 112 字/轮 × 一天几百轮。
// 关键词「先开口 / 还没回话 / 正文只有你自己看得见 / qq_send 放第一个动作」
// 被 t507 S6/S7、t515 U1、t518 B1/B2 分别钉着，改措辞时别动它们。
const SPEAK_FIRST_RULE =
  '（他发来消息、你还没回话时：qq_send 是唯一能让他看到话的出口，正文只有你自己看得见，' +
  '不调它他一个字都收不到；想说什么写进 qq_send 的 text/segments。' +
  '先聊、先查还是先整理，都由你定。翻收藏夹、预览表情、删收藏、整理文件这些事，' +
  '晚一点也不会丢；他等着的时候会以为你没看见，这是时间的代价，不是命令。）\n'

// TONE_NAME_IT 2026-11-24：批次506b 的实测数据是「我这边」6.8%、「这边」7.7%，
// 而「其实/确实/有点」都在 1% 上下 —— 判据是这两个词，可原措辞只说「别写成客服套话」，
// 一个具体词都没点。同理于「不点名她不会改」：只给抽象规则，她按旧习惯继续用。
// 现在把词点出来，但**不加行为命令**（不说「必须改」「不要说」），只给事实性提示 ——
// 这跟批次666/676 的拟人化红线一致：系统递事实，表达方式归她自己。
// 静态段、不含时间 → 每轮都在且不击穿 Prefix Cache。
const NO_SUPPORT_TONE =
  '（说话别把每句都写成客服腔。像「我这边」「这边处理好了」这类说法，' +
  '是客服话术的口头禅，不像人平时说话。只有真要说明功能边界或处理进度时才解释，' +
  '措辞按上下文自然说；不用固定开场，也不必为了礼貌硬垫一句。）\n'

// TODO_WHERE 2026-11-16（批次514）：他说「记在台账里」，她翻了 20 轮文件找「台账在哪」
// （目录与文件规矩 / 计划.json / 待办.json / 待办.mjs 源码 / 变更.md…），4 分 48 秒才回。
// 台账一直只有一个：共享/工具/待办.mjs。把路径写死在这，省掉整段摸索。
const TODO_WHERE_RULE =
  '（以后要做的事记在待办台账：`node 共享/工具/待办.mjs --加 "……"`。' +
  '路径放在这里，省得你翻找；什么时候记、先回话还是先记，由你定。）\n'
// PARALLEL_JUDGE 2026-11-16（批次532）：实测 1092 次 memory_judge，**每次让模型晚开口中位 4.8 秒**
// （p90 9.2 秒）——因为它是单独一条消息发出去的，得等打分回填完才轮到 qq_send。
// 而 4755 条带工具调用的消息里，4521 条只有 1 个工具：她几乎从不并行调用。
// 打分结果是给记忆库用的，跟他什么时候看到回复无关，完全可以和发言并列发。
const PARALLEL_JUDGE_RULE =
  '（memory_judge 只是给记忆库记录评分，不等于已经对外回复；是否调用、何时调用，看这轮事情是否需要。）\n'

const STATE_BOUNDARY_RULE =
  '（状态边界：用户明确说的属于用户报告；你写出的语气和角色话属于模型表达；时间、队列、回执和当前会话来源属于可观测运行状态。不要把沉默、短回复、延迟或拟人化措辞当成用户心理事实，也不要让角色表达改变工具权限。）\n'


export function buildVoiceText(agent, deps) {
  const stateHintOf = deps && deps.stateHintOf
  const voiceHintOf = deps && deps.voiceHintOf
  const ownerUin = String((deps && deps.ownerUin) ?? '')
  const onFirst = deps && deps.onFirst
  let logged = false
  // CACHE_IN_TURN 2026-11-08（批次279）：一轮之内 context 只算一次。
  // stateHintOf 里带「现在北京时间 18:09」这种逐分钟变的东西，每步都重算 →
  // system 前缀每步都变 → 整个上下文按全价重算。实测一半的请求是这样：
  //   in 42922  cache  2176（命中 5%）  ← 全价
  //   in  4498  cache 35840（命中 89%） ← 命中
  // 缓存价是全价的 1/10，这一半未命中就是最大的浪费。
  // 判据用 markVoiceTarget 写的 at：它每轮投递只写一次，at 变了才是新一轮；
  // 同一轮内所有 step 复用同一个字符串，前缀就稳了。
  let 缓存键 = ''
  let 缓存值 = ''
  let 状态片 = ''
  let 状态片值 = ''
  let 状态片全值 = ''
  return () => {
    try {
      const t = voiceTargetOf(agent)
      if (!t || t.mute) return ''
      const 当前轮键 = `${t.at}:${t.isPrivate ? 'private' : 'group'}:${t.peer}`
      if (缓存键 === 当前轮键) return 缓存值
      // 批次301：三段各自 try —— 一个槽抛错不能让整段状态消失。
      // 原来整块一个 try/catch，stateHintOf 里任何一处读文件失败都会让
      // voiceHint/体感槽一起静默消失，而外面看不出来（只是「她今天有点空」）。
      let s = ''
      // CACHE_BUCKET_ALL 2026-11-12：原来只对 stateHintOf 做了 10 分钟分桶，而下面的 voiceHintOf / extraHintOf
      // 却每轮跟着 lastText 与分钟数重算，导致跨轮连聊时 system prompt 末尾每句都变，把 3 万+ token 的 Prefix Cache 击穿！
      // 现在把整段慢变体感全部收进同一个 10 分钟分桶（当轮瞬态已由正文开头的 stateFastHintOf 携带），10 分钟内跨轮 100% 命中缓存！
      // CACHE_STATIC 2026-11-14（批次484）：批次358 的注释写着「开关打开时 stateVoice 同步跳过」，
      // 但批次301 重构这个函数时没实现跳过 —— 3008 字慢变段照旧挂在 system 末尾，
      // 每 10 分钟把 3~6 万 token 的 Prefix Cache 整体击穿（今天实测 214 次、652 万 token 全额计费）。
      // 现在真的跳过：system 只剩 personaPrefix + SOUL.md + FULL_ACCESS_LINE，全是静态的。
      // 慢变段由 poll.js 的 慢变段() 拼进正文（同批次加的）。
      const 跳过状态片 = !!(deps && deps.状态进正文 === true)
      const bucket = `${Math.floor(Date.now() / (10 * 60 * 1000))}:${t.isPrivate ? 'private' : 'group'}:${t.peer}`
      if (!跳过状态片 && bucket !== 状态片) {
        状态片 = bucket
        let built = ''
        try {
          if (stateHintOf) {
            // System context is cached across turns: exclude per-message text/history and key by recipient.
            状态片值 = String(stateHintOf({ text: '', history: [], peerUin: t.peer, isPrivate: t.isPrivate }) || '')
            built += 状态片值
          }
        } catch { /* 状态段坏了，下面两段照走 */ }
        try { built += String(voiceHintOf ? voiceHintOf(t.peer, { isPrivate: t.isPrivate }) : '') } catch { /* 说话段坏了，体感槽照走 */ }
        if (typeof (deps && deps.extraHintOf) === 'function') {
          try {
            const extra = String(deps.extraHintOf({ peer: t.peer, isPrivate: t.isPrivate, mute: t.mute, lastText: '' }) || '')
            if (extra !== '') built += (built === '' || built.endsWith('\n') ? '' : '\n') + extra
          } catch { /* 槽出错只丢自己，不影响基础状态 */ }
        }
        状态片全值 = built
      }
      if (!跳过状态片) s += 状态片全值
      // 主人私聊的全权段：每轮都要在，不然她还会按日常模式自我限制（原 poll.js 逻辑一致）
      if (t.isPrivate && ownerUin !== '' && t.peer === ownerUin) s = FULL_ACCESS_LINE + s
      // 批次301：三段全空时给一句最低限度的底 —— 「这一轮没有任何底色」本身不该发生。
      // 不学 dsh-longing 那套长篇中性块，只留一句，成本约 10 token。
      if (s === '') s = '[态] 平常，正常聊。\n'
      // 放在兜底之后：这句话永远在，而且和状态无关（静态、可缓存）
      // 新规则一律追加在最后：前缀缓存按最长公共前缀算，动末尾影响最小。
      s = SPEAK_FIRST_RULE + NO_SUPPORT_TONE + TODO_WHERE_RULE + PARALLEL_JUDGE_RULE + STATE_BOUNDARY_RULE + s
      if (s && !logged) {
        logged = true
        if (typeof onFirst === 'function') { try { onFirst(s) } catch { /* 日志失败不影响注入 */ } }
      }
      缓存键 = 当前轮键
      缓存值 = s
      return s
    } catch { return '' }
  }
}

/** 普通QQ投递不带Web GUI开发定位；工程、过期及非QQ回合保留原装配。 */
export function filterQQDevContext(assembly, target) {
  if (!target || target.mute) return assembly
  const devNames = new Set(['harness:source', 'app:web-surface'])
  const keep = (entry) => entry.required === true || !devNames.has(entry.name)
  return {
    ...assembly,
    sections: assembly.sections.filter(keep),
    contexts: assembly.contexts.filter(keep),
  }
}

/** 走宿主的装配流水线；不修改工具集合、执行权限及原始注册。 */
export function registerQQPromptFilter(ctx, config) {
  return ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembly = await next()
    if (config.精简QQ开发提示 === false) return assembly
    return filterQQDevContext(assembly, voiceTargetOf(context.agent))
  })
}
