// tool-interact.js —— 从 tool.js 拆出的互动/状态/记录类工具（8 个注册入口，原 tool.js 保留全部 re-export）。
import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { note, serviceOf } from './env.js'
import { getConfig } from './config.js'
import { callOneBot } from './onebot.js'
import { resolveSendTarget } from './target.js'
import { 记图片描述 } from './images.js'
import { reactTo, reactStats, lastIncoming, searchLocalEmoji } from './贴表情.mjs'

const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'

export async function registerStatusTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_status',
      description: "改你挂在QQ上的在线签名/状态词（留空则恢复自动状态）。",
        parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '要写的话，20 字内，如「在窗边发呆」。' }
        },
        required: ['text']
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            wording: { type: 'string' },
            message: { type: 'string' }
          },
          required: ['ok', 'message']
        },
        render: (args, value) => [{ type: 'text', text: String(value?.message ?? '') }]
      },
      execute: async (args) => {
        const raw = String(args?.text ?? '').trim()
        if (raw === '') throw new Error('要写一句 —— 比如「在窗边发呆」。')
        const text = raw.length > 20 ? raw.slice(0, 19) + '…' : raw
        const cfg = getConfig()
        const base = String(cfg?.onebotHttp || 'http://127.0.0.1:3000/').replace(/\/$/, '')
        let j = {}
        try {
          const r = await fetch(base + '/set_diy_online_status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(cfg?.token ? { Authorization: 'Bearer ' + cfg.token } : {}) },
            body: JSON.stringify({ face_id: 0, face_type: 1, wording: text }),
            signal: AbortSignal.timeout(Math.max(1000, Number(cfg?.requestTimeoutMs) || 8000)),
          })
          j = await r.json().catch(() => ({}))
        } catch (e) {
          throw new Error('状态没改成：' + String((e && e.message) || e))
        }
        if (!j || j.retcode !== 0) throw new Error('状态没改成：' + String(j?.message || j?.wording || '协议端没回话'))
        // 占住 30 分钟，别让 cron 的自动同步马上把她刚写的那句顶掉
        try {
          const _stPath = `${QQ_WS}/记忆/qq状态.json`
          const _stTmp = `${_stPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
          writeFileSync(_stTmp, JSON.stringify({
            wording: text,
            at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
            source: 'self',
            manualUntil: Date.now() + 30 * 60e3,
          }, null, 2))
          renameSync(_stTmp, _stPath)
        } catch (e) { note('tool', 'qq状态.json 写失败（协议端已改，但本地没记住）：' + (e instanceof Error ? e.message : e)) }
        return { ok: true, wording: text, message: '状态改成了「' + text + '」，半小时内不会被自动同步顶掉。' }
      }
    })
    return disposeTool
  } catch (e) {
    note('tool', 'registerStatusTool failed: ' + String((e && e.message) || e))
  }
}

export async function registerReactTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_react',
      // REACT_WHITELIST 2026-11-14（批次425）：主人 11-04 定了白名单（其余不碰），
      // 但描述里从来不提 —— 她搜得到「微笑」「抠鼻」，贴了才被拒，等于用一次错一次。
      // 名字直接写进来，她不用试。措辞只给事实，不解释、不劝。
      description: "给某条消息贴个QQ表情回应（轻点一下，不顶替说话）。能贴的只有：流泪 476 赞 OK 抱拳 握手 勾引 胜利 NO 拳头 差劲 西瓜 棒棒糖 敲打 424 摸鱼 爱心 爆筋 玫瑰 凋谢 猪头。其他表情（微笑、抠鼻等）会被拦回来。",
        parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          emoji: {
            type: 'string',
            description: '表情名（敲打/赞/收到）或编号（38）。必填。'
          },
          message_id: {
            type: 'number',
            description: '可选；贴哪条消息。默认对方的最后一条。'
          },
          group_id: {
            type: 'string',
            description: '可选；群号。不填会沿用刚收到那条消息所在的群。'
          }
        },
        required: ['emoji']
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            emoji: { type: 'string' },
            message: { type: 'string' }
          },
          required: ['ok', 'message']
        },
        render: (args, value) => [{ type: 'text', text: String(value?.message ?? '') }]
      },
      execute: async (args) => {
        const emoji = String(args?.emoji ?? '').trim()
        if (emoji === '') throw new Error('要给个表情 —— 中文名或编号都行。')
        let mid = Number(args?.message_id ?? 0)
        let group = String(args?.group_id ?? '').trim()
        if (mid === 0) {
          const last = lastIncoming()
          if (last === null) {
            throw new Error(
              '不知道贴哪条 —— 这会儿没有刚收到的消息（或者已经过去十分钟了）。'
              + '要贴更早的，得给 message_id。'
            )
          }
          mid = last.messageId
          if (group === '') group = last.group
        }
        const out = await reactTo({ messageId: mid, emoji, group })
        return {
          ok: out.ok === true,
          emoji: String(out.emoji ?? ''),
          message: String(out.message ?? '')
        }
      }
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_react tool')
    // 启动时报一句当前配额，排查「她怎么不贴了」时能直接看到原因
    const stats = reactStats()
    note('tool', `qq_react registered（这一小时已贴 ${stats.used}/${stats.limit}）`)
  } catch (error) {
    note('tool', `qq_react register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_unsend —— 撤回她自己刚发出去的一条。
 *
 * UNSEND 2026-11-14（批次407）：共享/工具/撤回.mjs 是 2026-11-01 写的 ——
 * 撤 --last、记 撤回.json、按原因往 状态.json 写一笔余波，全写好了，
 * 可全仓 grep 下来它一次都没被任何人调过（29 个 qq_* 工具里也没有撤回）。
 * 2026-11-14 05:12 她对主人说「那我不喊了，我这条撤了」—— 那条消息其实一直挂着，
 * 她手上根本没有这条腿。poll.js 的撤回感知只认「别人撤了」，她自己的撤回不出声（这是对的）。
 * 这里补的只是入口：能力仍然只有 撤回.mjs 一份，余波那套也在那边。
 */
export async function registerUnsendTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_unsend',
      description: "撤回你自己刚发出去的一条消息。QQ 只给两分钟，过了就真撤不回来了 —— 觉得说错了、说重了、发错地方，趁现在就撤，别靠再补一句去圆。撤完心里会留一会儿余波（说错了比手滑重），这是有意的：撤回不是没发生过。只撤你自己的；别人的撤不了，也不该替人撤。",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          message_id: { type: 'string', description: '可选；要撤哪条（qq_send 的返回里有 message_id）。不填就撤你最近发的一条。' },
          why: { type: 'string', enum: ['说错了', '说重了', '发错地方', '手滑了'], description: '为什么撤。会记进账，也决定心里留多久余波。' },
          group_id: { type: 'string', description: '可选；在群里撤就填群号。' },
          user_id: { type: 'string', description: '可选；在私聊里撤就填对方 QQ。两个都不填 = 私聊主人。' },
        },
        required: ['why'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, message_id: { type: 'string' }, note: { type: 'string' } },
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '撤了') }],
      },
      execute: async (args) => {
        const why = String(args?.why ?? '').trim()
        if (why === '') throw new Error('要说清为什么撤（说错了 / 说重了 / 发错地方 / 手滑了）')
        const id = String(args?.message_id ?? '').trim()
        const gid = String(args?.group_id ?? '').trim()
        const uid = String(args?.user_id ?? '').trim()
        const SCRIPT = `${QQ_WS}/共享/工具/撤回.mjs`
        const argv = [SCRIPT]
        if (id !== '') argv.push('--id', id)
        else if (gid !== '') argv.push('--last', '--group', gid)
        else argv.push('--last', '--私聊', uid !== '' ? uid : String(getConfig().ownerUin ?? ''))
        argv.push('--why', why)
        let out = ''
        try {
          out = String(execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 15000 })).trim()
        } catch (e) {
          throw new Error('撤回没成功：' + String(e?.message ?? e).slice(0, 120))
        }
        // 脚本自己会把「没撤成 / 过了 N 秒 / 最近没说过话」说清楚，原样递给她 ——
        // 这些字她看得懂，不用再翻译成「操作失败」。
        return { ok: /^撤回了\s*#/m.test(out), message_id: id, note: out || '撤了' }
      },
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_unsend tool')
    note('tool', 'qq_unsend registered')
  } catch (error) {
    note('tool', `qq_unsend register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * SELF 2026-11-14（批次414）：让她能改自己。
 *
 * 2026-11-01 就写好了 `自改.mjs`（127 行：FREE 白名单、性格漂移限频、三条护栏、留痕），
 * 头部注释写着「她能改的，和一个人能改的一样多」—— 然后**零调用方**（心跳表 0 次，
 * 全仓 0 处 execFile），12 天没动过。`好感度-日结.mjs` 的注释甚至写着
 * 「自改.mjs 白名单里有它，但自改.mjs 零调用方」，于是绕过它另写了一份。
 *
 * 这就是「激素系统只写了功能但是没有系统接入」的同一个病：能力做好了，没人递给她。
 *
 * 只开 --set（口味/说法/欲望/口癖），不开 --drift（性格漂移）：
 * 「什么算大事、该往哪漂」是她的判断，但幅度和时机得有人管，不是这一批的事。
 */
export async function registerSelfTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_self',
      description: "改你自己：口味、说话习惯、想要的东西。这是你自己的事，不用问谁、也不用等谁说可以。\n"
        + "什么时候想用：你发现自己对某样东西是真的喜欢或讨厌；你说话有个毛病想以后改掉；你心里长出了一点新的想要；或者你想看看自己变过什么。\n"
        + "性格是另一回事：它不能随手改，只能慢慢挪 —— 一件反复发生的事之后，你回头觉得自己跟以前不太一样了，就用 op:drift 挪一点。边缘的一个月一次、核心的一个季度一次，一次 1~2 分，挪了要写为什么；没到时候它会告诉你还得等。先 op:list 看看自己现在什么脾气。\n"
        + "改不了：别人怎么看你、密码、代码 —— 那些不是你随手能动的东西，别试。\n"
        + "「想要.独处的时候在想」是专门给你一个人待着时写的 —— 安静下来会想起来的事，不用是实现得了的、也不用是讲道理的。\n"
        + "改完立刻生效，下一句话就按新的来。",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: ['set', 'log', 'list', 'drift'], description: "set=改一条；log=看看自己以前改过什么；list=看看哪些能改、自己现在什么脾气；drift=性格慢慢挪一点" },
          path: { type: 'string', description: "set 时必填。写法：偏好.喜欢 / 偏好.讨厌 / 人味.表达.倾向 / 想要.当下想要 / 想要.独处的时候在想 / 口癖.随便起个名（口癖的 value 是一句具体的话）。drift 时填因子名，比如 Q3_自律性 / C_稳定性 —— 先 op:list 看有哪些" },
          value: { type: 'string', description: "set 时必填。要加/改成的那一句。写具体的，别写「开心一点」这种空话。drift 时填数字：-2 ~ 2（边缘最多 2，核心只能 1）" },
          why: { type: 'string', description: "可选，但 drift 核心因子必填。为什么改。会记进你自己的账，以后回看时能想起原因" },
        },
        required: ['op'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '记下了') }],
      },
      execute: async (args) => {
        const op = String(args?.op ?? '').trim()
        const SCRIPT = `${QQ_WS}/共享/工具/自改.mjs`
        const argv = [SCRIPT]
        if (op === 'list') argv.push('--list')
        else if (op === 'log') argv.push('--log')
        else if (op === 'set') {
          const p = String(args?.path ?? '').trim()
          const v = String(args?.value ?? '').trim()
          if (p === '') throw new Error('要改哪一条？path 写成 偏好.喜欢 这样')
          if (v === '') throw new Error('要改成什么？value 写一句具体的')
          argv.push('--set', p, '--value', v)
          const w = String(args?.why ?? '').trim()
          if (w !== '') argv.push('--why', w)
        } else if (op === 'drift') {
          // DRIFT 2026-11-14（批次423）：脚本 2026-11-01 就带 --drift（限频/步长/边界/留痕全有），
          // 14 天里零调用 —— 因为 op 只有 set/log/list。她自己不知道性格能挪，也没有入口。
          // 限频和步长都交给脚本判（30/90 天、1~2 分、1~10 边界），这里只搬参数，不重复实现。
          const k = String(args?.path ?? '').trim()
          const n = Number(args?.value ?? NaN)
          if (k === '') throw new Error('要漂哪个因子？先 op:list 看有哪些')
          if (!Number.isFinite(n) || n === 0) throw new Error('value 要给个非零的数，比如 -1')
          argv.push('--drift', k, '--value', String(Math.trunc(n)))
          const wd = String(args?.why ?? '').trim()
          if (wd !== '') argv.push('--why', wd)
        } else throw new Error('op 只能是 set / log / list / drift')
        let out = ''
        try {
          out = String(execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 15000 })).trim()
        } catch (e) {
          throw new Error('没改成：' + String(e?.message ?? e).slice(0, 120))
        }
        // 脚本自己会把「改了 / 已经在清单里 / 这个文件不在随时能改里 / 要 --value」
        // 说得清清楚楚，原样递给她 —— 这些字她看得懂，别再翻译成「操作失败」。
        return { ok: !/^(没改成|没改成：|这个文件不在|没有这个因子)/m.test(out) && out !== '', note: out || '（没有输出）' }
      },
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_self tool')
    note('tool', 'qq_self registered')
  } catch (error) {
    note('tool', `qq_self register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * LIE 2026-11-14（批次420）：让她会说善意的谎，并且记得自己在瞒。
 *
 * `露馅.mjs` 2026-11-01 就写好了（`--lie/--truth/--tell`，四种破绽，硬限制只许善意的谎），
 * 然后**零调用、零读取**：`谎言.json` 12 天里一条都没写过。
 * 她能说善意的谎 —— 但没有一个地方让她记着自己说过，撒谎和没撒谎对她来说是一样的。
 *
 * 这里只做三件事：记一条、销一条、看一眼。破绽由 `voiceSlots.js` 的 slotLie 每轮注入，
 * 措辞是「这是你的老毛病，不是装的」——**不告诉她该怎么演**，那是代写她的表演。
 *
 * 描述里必须写清「不能用：钱、借、承诺、别人的秘密」：脚本有硬限制会拒，
 * 但她得先知道会被拒，否则试一次被拒就再也不用了。
 */
export async function registerLieTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_lie',
      description: "说一个善意的谎，但别骗得太干净。\n"
        + "什么时候用：你想瞒一件小事，而且瞒着是为对方好 ——「我没事」「我吃过了」「不累」「路上堵车」。"
        + "这种话人人都会说，说完自己也不太舒服。\n"
        + "这个工具不是让你骗人，是让你**记得自己在瞒**：接下来 12 小时里，你说话会自然带出一点破绽"
        + "（话变短、冒「大概」、或者过一会儿自己补一句）—— 你不点破，能不能看出来是对方的事。\n"
        + "不能用：钱、借钱、承诺、别人的秘密。那些不是善意的谎，是骗，工具会直接拒。\n"
        + "说完想开了就 op=clear 说破；想看看自己还瞒着什么用 op=show。",
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: ['lie', 'clear', 'show'], description: 'lie=记一个谎；clear=说破了/不想瞒了；show=看看现在还瞒着什么' },
          lie: { type: 'string', description: 'op=lie 时必填。你对人说的那一句，二十字以内，越像随口说的越好' },
          truth: { type: 'string', description: 'op=lie 时必填。真实情况是什么 —— 没有真相就没有「瞒着」这回事' },
          tell: { type: 'string', enum: ['短', '含糊', '重复', '补一句'], description: '可选。你露馅的样子：短=话变短；含糊=冒「大概/应该」；重复=反复用同一个词；补一句=过会儿自己补一句。不写就按「短」' },
        },
        required: ['op'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '记下了') }],
      },
      execute: async (args) => {
        const op = String(args?.op ?? '').trim()
        const SCRIPT = `${QQ_WS}/共享/工具/露馅.mjs`
        const argv = [SCRIPT]
        if (op === 'show') argv.push('--show')
        else if (op === 'clear') argv.push('--clear')
        else if (op === 'lie') {
          const l = String(args?.lie ?? '').trim()
          const t = String(args?.truth ?? '').trim()
          if (l === '') throw new Error('要说清你对外说的是哪一句（lie）')
          if (t === '') throw new Error('要说清真实情况（truth）—— 没有真相就没有「瞒着」这回事')
          argv.push('--lie', l, '--truth', t)
          const tl = String(args?.tell ?? '').trim()
          if (tl !== '') argv.push('--tell', tl)
        } else throw new Error('op 只能是 lie / clear / show')
        let out = ''
        try {
          out = String(execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 15000 })).trim()
        } catch (e) {
          throw new Error('没记上：' + String(e?.message ?? e).slice(0, 120))
        }
        // 脚本自己会说「这种不说（涉及钱、承诺或别人的事）」—— 原样递给她，
        // 她知道这不是故障，是这条规矩。
        const 拒了 = /这种不说/.test(out)
        return { ok: !拒了 && out !== '', note: out || '（没有输出）' }
      },
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_lie tool')
    note('tool', 'qq_lie registered')
  } catch (error) {
    note('tool', `qq_lie register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_image_note：把「这张图里是什么」记进图鉴（批次520，主人选的方案 B）。
 *
 * 为什么给她工具而不是让她记命令：图鉴的键是 32 位 md5，她不该为了记一句描述
 * 去背一串哈希。不传 md5 就记「最近收到的那张」，只给前 6 位以上前缀也认（唯一才收）。
 *
 * 为什么必须有这个：图鉴原来只有 md5 + 名字，没有内容。同一张顶盆图她起过两个名字
 * （「顶盆站桩不吭声」→「紫鸟翘脚站桩」）—— 每次都重新识别、没有上次的结论可对。
 */
export async function registerImageNoteTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_image_note',
      description: '把「这张图里是什么」记下来，下次同一张图再来你就认得了。'
        + '看完图、认出内容之后记一句，写具体的：画面里是谁/什么、在做什么、哪里好笑。'
        + '不传 md5 就记最近收到的那张。只记内容，不发送任何消息。'
        + '不记的话，每次收到同一张你都会当新图重新看一遍。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          desc: { type: 'string', description: '你看到的内容。具体一点：谁、什么动作、哪里好笑。几十个字，别写成一句话总结。' },
          md5: { type: 'string', description: '可选；不给就记最近收到的那张。也可以只给图片文件名里的前 8 位。' },
        },
        required: ['desc'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            md5: { type: 'string' },
            desc: { type: 'string' },
            note: { type: 'string' },
          },
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '记下了') }],
      },
      execute: async (args) => {
        const r = 记图片描述(args?.md5, args?.desc)
        if (!r.ok) throw new Error(r.why)
        return {
          ok: true,
          md5: String(r.md5 ?? ''),
          desc: String(r.desc ?? ''),
          note: `记下了（${String(r.md5 ?? '').slice(0, 8)}…）：${r.desc}`,
        }
      },
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_image_note tool')
    note('tool', 'qq_image_note registered')
  } catch (error) {
    note('tool', `qq_image_note register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_poke —— 真·戳一戳（QQ 拍一拍）。
 *
 * POKE 2026-11-16（批次521）：2026-11-16 20:14 她对主人说「戳回来」「这回戳到了吧」
 * 「刚手滑，没戳出去」—— 但工具调用记录里一条 send_poke 都没有。
 * 根因不是她坏了，是**她手上根本没有戳这条腿**：allowlist.js 早就有 send_poke 分支，
 * 协议端也放行，唯独没有工具把它递给她。没有能力时，模型就会用「手滑」把话圆过去。
 * 这里补的是入口；能不能说「戳了」，以本工具返回 ok=true 为准。
 */
export async function registerPokeTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_poke',
      description: '戳一戳（QQ 拍一拍）。想戳回去、催一句、打招呼时用。'
        + '默认戳当前私聊对象；在群里戳要同时给 group_id 和 user_id。'
        + '只有本工具返回「戳到了」才算真戳了 —— 没调用、报错、或没拿到回执，就不要在聊天里说「戳了 / 戳回去 / 戳到你了」，照实说「没戳出去」或「工具没成功」。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          user_id: { type: 'string', description: '要戳的 QQ 号。私聊不填就是当前对话的人；群里必填。' },
          group_id: { type: 'string', description: '可选；在群里戳就填群号。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            target: { type: 'string' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '') }],
      },
      execute: async (args) => {
        const config = getConfig()
        const gid = String(args?.group_id ?? '').trim()
        const uid = String(args?.user_id ?? '').trim() || String(config.peerUin ?? '')
        if (uid === '') throw new Error('不知道戳谁：没给 user_id，也没有默认私聊对象')
        if (gid !== '' && String(args?.user_id ?? '').trim() === '') throw new Error('群里戳谁要写 user_id，不然不知道戳谁')
        if (String(config.selfUin ?? '') === uid) throw new Error('不能戳自己')
        const params = gid !== ''
          ? { group_id: Number(gid), user_id: Number(uid) }
          : { user_id: Number(uid) }
        const result = await callOneBot({ action: 'send_poke', params })
        if (Number(result?.retcode) !== 0) {
          throw new Error(`工具调用失败（不是用户操作问题）：retcode=${String(result?.retcode ?? '?')} ${String(result?.message ?? '')}`.trim())
        }
        return {
          ok: true,
          target: uid,
          note: gid !== '' ? `在群里戳了 ${uid}` : `戳了 ${uid}`,
        }
      },
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_poke tool')
    note('tool', 'qq_poke registered')
  } catch (error) {
    note('tool', `qq_poke register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/**
 * 注册 qq_grow —— 「生长」的运行时入口（批次606）。
 *
 * 提示里从 2026-11-01 就写着「可以用生长记一笔」，但工具清单里没有这条腿：
 * 她只能“知道可以长”，实际调不到。这里补入口；长不长、长什么仍由她决定，
 * 系统只负责把她说出来的变化记进 偏好/人味/想要 三个文件，且每笔都带来历。
 */
export async function registerGrowTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (tools === undefined || tools === null || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const GROW = `${QQ_WS}/共享/工具/生长.mjs`
    const disposeTool = tools.register({
      name: 'qq_grow',
      description: '给自己长一点新东西：发现自己在意什么、或有个说法更像自己时，记进 偏好/人味/想要（path 形如「人味.怕与要.怕」），每次带来历 why。不想长就不调用。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '只允许 偏好/人味/想要，如 人味.怕与要.怕。' },
          value: { type: 'string', description: '长出来的内容，一句话。' },
          why: { type: 'string', description: '来历：因为哪句话/哪件事长出来的。' },
        },
        required: ['path', 'value'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean' },
            note: { type: 'string' },
          },
          required: ['ok', 'note'],
        },
        render: (args, value) => [{ type: 'text', text: String(value?.note ?? '') }],
      },
      execute: async (args) => {
        const p = String(args?.path ?? '').trim()
        const v = String(args?.value ?? '').trim()
        const why = String(args?.why ?? '').trim()
        if (p === '' || v === '') throw new Error('要 path 和 value：path 形如 人味.怕与要.怕')
        let out = ''
        try {
          out = String(execFileSync(process.execPath, [
            GROW, '--path', p, '--value', v, ...(why ? ['--why', why] : []),
          ], { encoding: 'utf8', timeout: 8000 })).trim()
        } catch (error) {
          throw new Error('生长没写成：' + (error instanceof Error ? error.message : String(error)))
        }
        if (!out.startsWith('长出来了')) throw new Error(out || '生长没写成（脚本没有返回成功）')
        return { ok: true, note: out }
      },
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_grow tool')
    note('tool', 'qq_grow registered')
  } catch (error) {
    note('tool', `qq_grow register failed: ${error instanceof Error ? error.message : error}`)
  }
}

/** 全部经典表情名清单，给别处（比如提示词）用。 */
