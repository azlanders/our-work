// 实时续跑.js —— 2026-11-12（主人：实时模式 = 她对话任务不停下来）
//
// 做什么：她回完一轮后，如果这一轮**动过工具**（说明活还没干完），隔几秒把一句「接着做」
// 投回同一会话，让她自己继续，直到某一轮不再动工具（= 收尾了）或者到次数上限。
//
// 为什么只认「动过工具」：纯聊天的回合续跑会变成自问自答 —— 她说什么都没人接，
// 下一轮还会继续说，直到把配额烧完。动手的回合才有明确的「做完/没做完」。
//
// 安全阀：
//   · 只在私聊续（群里续跑等于刷屏）；
//   · 队列里已经有新消息（用户刚说话/还没发完）→ 这一轮不续，交给人；
//   · 连跑上限（默认 6）+ 到顶冷却（默认 20 分钟），计数 10 分钟没动就清零；
//   · 开关文件 `{{DSH_ROOT}}/fish-realtime.json` 默认不存在 = 关。
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { note, DATA_DIR } from './env.js'
// WAIT_CLOCK 2026-11-16（批次514）：续跑要知道「他已经等了多久」
import { incomingAgeMs, targetKey } from './rhythm.js'
// TOPIC 2026-11-12：任务收尾后她可以自己挑个话题说一句（材料来自 话题.mjs，话仍由她定）。
import { 话题池, 挑新鲜 } from './话题.mjs'
import { getConfig } from './config.js'
import { targetAllowed } from './proactive.js'
// LIVE_CHAT 2026-11-17（批次591）：补一句也要挑她没睡着的时候
import { 睡着, 记忆目录 } from './sleepgate.js'

const 档 = process.env.DSH_REALTIME_FILE || join(DATA_DIR, 'fish-realtime.json')
const 连跑 = new Map()   // sessionId -> { 次, 最后 }
const 冷却 = new Map()   // sessionId -> 冷却到（ms）
const 上轮动过 = new Map() // sessionId -> 上一回合有没有动过工具（判断「刚收尾」）
const 上次话题 = new Map() // sessionId -> 上次「收尾聊一句」的时间（单独限流）
const 续话账 = new Map()   // sessionId -> { 次, 上封来信, 排at }
const 缺省 = { 上限: 6, 间隔秒: 4, 冷却分: 20 }
const 续话缺省 = { 分: 12, 每段: 1 }

const 催等下限 = 40e3        // 40 秒：更短是正常节奏，催了像催命
const 催等上限 = 10 * 60e3    // 10 分钟：再往上说明那已经不是「他在等」，是她在自己干活

/**
 * 续跑时该不该提醒她「他在等」—— 返回要拼进注入的那句，或空串。
 *
 * 为什么是纯函数：这段的边界（39 秒 / 40 秒 / 10 分钟零 1 秒）是最容易写错、
 * 也最容易被人「顺手放宽」的地方，必须能被单测按数值钉住。
 * 等了 null（没收到过消息、主动搭话后的续跑）一律不催。
 */
export function 该催他了吗(等了Ms, 续跑轮次) {
  if (等了Ms === null || 等了Ms === undefined) return ''
  const ms = Number(等了Ms)
  if (!Number.isFinite(ms) || ms < 催等下限 || ms > 催等上限) return ''
  const 轮 = Number(续跑轮次)
  const 催 = Number.isFinite(轮) && 轮 >= 1
  return '（他最后那句到现在已经 ' + Math.round(ms / 1000) + ' 秒了，还在等你。'
    + (催 ? '别再往下查了，' : '') + '先回他一句让他知道你在弄，剩下的做完再补。）'
}

export function 读开关() {
  try {
    const j = JSON.parse(readFileSync(档, 'utf8'))
    return {
      开: j.实时 === true,
      聊天续话: j.聊天续话 === true,
      收尾聊一句: j.收尾聊一句 === true,
      上限: Math.max(1, Math.min(20, Number(j.上限) || 缺省.上限)),
      间隔秒: Math.max(2, Math.min(60, Number(j.间隔秒) || 缺省.间隔秒)),
      冷却分: Math.max(1, Math.min(180, Number(j.冷却分) || 缺省.冷却分)),
      // LIVE_CHAT 2026-11-17（批次591）：纯聊天收尾后隔多久允许补一句、每段对话最多补几次。
      // 这两个数只影响「聊天」，不占主动搭话的日配额。
      续话分: Math.max(3, Math.min(60, Number(j.续话分) || 续话缺省.分)),
      续话每段: Number.isFinite(Number(j.续话每段))
        ? Math.max(0, Math.min(5, Number(j.续话每段)))
        : 续话缺省.每段,
    }
  } catch {
    return { 开: false, 聊天续话: false, 收尾聊一句: false, ...缺省, ...续话缺省 }
  }
}

export function 设置聊天续话(enabled) {
  if (typeof enabled !== 'boolean') throw new TypeError('聊天续话开关须为布尔值')
  let settings = {}
  try { settings = JSON.parse(readFileSync(档, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new TypeError('实时配置格式不正确')
  const temporary = `${档}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ ...settings, 聊天续话: enabled }, null, 2), { mode: 0o600 })
    renameSync(temporary, 档)
  } finally { try { unlinkSync(temporary) } catch (_err) { console.error('[onebot:实时续跑]', _err?.message || _err) } }
  if (!enabled) {
    for (const reservation of 续话账.values()) clearTimeout(reservation.定时器)
    续话账.clear()
  }
  return enabled
}

async function 投递续话(ctx, sessionId, target, lines, materials, stillCurrent, reservation) {
  const text = [...lines, ...materials.map(({ id, 类, 文 }) => `- (${id}) [${类}] ${文}`),
    '只想说文字时，用一次 qq_send 并指定当前对象。实际用了哪些材料，就在 proactive_material_ids 填哪些编号；编号不写进正文。不想说就 qq_pass。'].join('\n')
  const { deliver } = await import('./deliver.js')
  return deliver(ctx, sessionId, text, target, undefined, {
    proactive: true, sourceKind: 'nudge', proactiveReceiptToken: randomUUID(),
    proactiveMaterialIds: materials.map(({ id }) => id), proactiveChargeDailyQuota: false,
    proactiveBeforeStage: stillCurrent, proactiveGuardToken: reservation?.id,
  })
}

/** 由 outbound 在「这一回合已经发完」的地方调用。 */
/**
 * 续跑要投给她的那句话（SEND_OR_PASS 批次518，批次521d 抽成纯函数）。
 *
 * 为什么抽出来：原来这段字符串内联在 setTimeout 里，只能靠「源码里有没有这句话」来测 ——
 * 把「想说的话必须调 qq_send」删掉、或者把「不要发任何消息」加回来，
 * 源码断言可能漏，行为一定会错。
 *
 * 教训就在这段里：批次509/513 时它写的是「这一轮**不要发任何消息**，直接调 qq_pass」，
 * 她照做了 —— 看完视频写好点评，一个字都没发出去，主人干等 5 分钟。
 *
 * @param {string} 等待句 由 该催他了吗() 生成的「他已经等了 N 秒」，可以是空串
 */
export function 续跑提示(等待句 = '') {
  return '[接着做] 上一轮你动过工具，事情大概还没收尾，继续把它做完。'
    + '**想说的话必须调 qq_send 发出去** —— 只写正文，他那边一个字都收不到。'
    + '真要收尾就调 qq_pass（它不会发出去），但别发「我不出声了 / 这轮不动了」这种说明。'
    + String(等待句 ?? '')
}

/**
 * 这条事件在不在本回合的 seq 区间里。
 *
 * TURN_RANGE 2026-11-16（批次580）：events 是「从 scanFrom 起的一整段历史」，
 * 不按 from/endSeq 裁，前几轮的 bash / web_search 会一直被算进「这一轮」。
 * from/endSeq 缺失时退回「全收」，保持老调用方的行为。
 */
export function 在回合内(e, from, endSeq) {
  const seq = Number(e?.seq)
  if (!Number.isFinite(seq)) return false
  const lo = Number(from)
  const hi = Number(endSeq)
  if (Number.isFinite(lo) && seq <= lo) return false
  if (Number.isFinite(hi) && seq >= hi) return false
  return true
}

/** 本回合真正调过的工具名（按 seq 裁过区间）。 */
export function 本回合工具(events, from, endSeq) {
  return (events || [])
    .filter((e) => String(e?.type || '') === 'tool/call' && 在回合内(e, from, endSeq))
    .map((e) => String(e?.data?.name ?? ''))
}

export function 回合结束(ctx, sessionId, entry, events, from, endSeq, { accepted = false } = {}) {
  try {
    const c = 读开关()
    // 关掉的时候把「上轮动过」清掉：否则关了几天再打开，第一次收尾会拿几天前的旧标记触发一句话题
    if (!c.开 && !c.聊天续话) { 上轮动过.delete(sessionId); return }
    if (!entry || entry.target?.kind !== 'private' || entry.proactive === true) return
    // PASS_TERMINAL 2026-11-15（批次509）：qq_pass / qq_close 是「这轮我不说话，收尾」，
    // 但它们本身是**工具调用** —— 下面的判据「动了工具就再推一轮」于是把每一次「我不说话」
    // 都当成「还在干活」，接着再推 5 轮。实测 20:59 那串：:10 / :16 / :26 / :37 全是 qq_pass，
    // 一路推到 6 轮上限，白烧 6 次请求，还让出站队列一直等 turn/end（「队头条目已等 30s」）。
    // 她自己决定收尾就真的收尾，别再推她。
    // SEND_ALSO_TERMINAL 2026-11-15（批次513）：**说话也算收尾**。
    // 批次509 只认 qq_pass，可实测她刷屏那几轮用的是 qq_send：
    // 发一句 → 判据「动了工具」→ 再推一轮「接着做」→ 她又说一句，4 分钟连发 5 条，
    // 同期 4 次「队头条目已等 30s」。她要说的已经说了，再推只会让她接着说。
    // 例外：这一轮还调过**干活的**工具（bash / web_search / read_image …）就别停，
    // 那是真在办事情，话只是中间一句。
    // TURN_RANGE 2026-11-16（批次580）：这里原来只判 type==='tool/call'，**没判 seq 范围**。
    // events 是「从 scanFrom 起的一整段历史」，里面混着前几轮的工具调用 ——
    // 只要当天用过一次 bash / web_search，之后每一轮都会看到它，干过活永远为 true，
    // 主动收尾永远不成立，于是每轮都多推一次「接着做」，白烧一整轮模型时间，
    // 也让出站队列一直等 turn/end。实测 164 次 [realtime] 续跑，绝大多数是这么来的。
    const 这一轮工具 = 本回合工具(events, from, endSeq)
    const 说过话 = 这一轮工具.some((n) => n === 'qq_send' || n === 'qq_pass' || n === 'qq_close')
    // 「干活」= 不是 qq_* 也不是记账类。qq_remember / memory_judge / qq_feel / qq_react 都算收尾动作。
    const 记账号 = new Set(['memory_judge', 'qq_remember', 'qq_feel', 'qq_react', 'qq_later'])
    const 干过活 = 这一轮工具.some((n) => n !== '' && !n.startsWith('qq_') && !记账号.has(n))
    const 主动收尾 = 说过话 && !干过活
    if (主动收尾) {
      连跑.delete(sessionId)
      上轮动过.set(sessionId, false)
      // LIVE_CHAT 2026-11-17（批次591）：这里原来直接 return ——「接着做」是给干活的，
      // 聊天确实不该续跑；但副作用是「她还想再说一句」也被一起堵死了：
      // 只要这一轮没动过活，之后就不会再有任何主动开口，只能干等 42 分钟的主动钟。
      // 现在改成「隔一会儿再补一句」：不是立刻追问，而是等他 12 分钟没接、
      // 手里又真有新鲜材料，才允许补一次；他一说话这段计数就归零。
      if (accepted && c.聊天续话) 排续话(ctx, sessionId, entry)
      return
    }

    if (!c.开) { 上轮动过.delete(sessionId); return }

    const 动过 = (events || []).some((e) => {
      const t = String(e?.type || '')
      return (t === 'tool/call' || t === 'tool/result') && 在回合内(e, from, endSeq)
    })

    const now = Date.now()
    const 曾经动过 = 上轮动过.get(sessionId) === true
    上轮动过.set(sessionId, 动过)
    if (!动过) {
      // 上一轮在干活、这一轮不干活了 —— 事情收尾了。这时候她才有可能「想说点别的」。
      连跑.delete(sessionId)
      if (曾经动过 && c.收尾聊一句) 收尾聊一句(ctx, sessionId, entry)
      return
    }
    if (now < (冷却.get(sessionId) || 0)) return
    const 前 = 连跑.get(sessionId)
    const 次 = (前 && now - 前.最后 < 10 * 60e3) ? 前.次 : 0
    if (次 >= c.上限) {
      连跑.delete(sessionId)
      冷却.set(sessionId, now + c.冷却分 * 60e3)
      note('realtime', `${sessionId} 连跑 ${次} 轮到上限，歇 ${c.冷却分} 分钟`)
      return
    }
    连跑.set(sessionId, { 次: 次 + 1, 最后: now })
    note('realtime', `${sessionId} 第 ${次 + 1}/${c.上限} 轮续跑，${c.间隔秒} 秒后投「接着做」`)

    const 定时 = setTimeout(async () => {
      try {
        const { outbound } = await import('./outbound.js')
        const q = outbound.get(sessionId)
        if (Array.isArray(q) && q.length > 0) {
          note('realtime', `${sessionId} 队列里已有新消息，这次不续`)
          return
        }
        const { deliver } = await import('./deliver.js')
        // NUDGE_NO_META 2026-11-12：原来写「安静停下」，她把这句理解成「发一条我不出声了」，
        // 结果每次收尾都往 QQ 发一句元话（「已经收尾了，我这轮就不出声了」）。
        // 必须写清楚：停下 = 调 qq_pass，不是发条消息说明自己停下。
        // WAIT_CLOCK 2026-11-16（批次514）：续跑的注入里原来一句时间信息都没有。
        // 实测 01:11:20 主人说「你记在台账或者什么地方捏」，她连查 20 轮文件、
        // 4 分 48 秒后才回 —— 中间每一轮「[接着做]」都让她以为还在即时对话里。
        const 等了他 = (() => {
          try { return incomingAgeMs(targetKey(entry?.target)) } catch { return null }
        })()
        const 等待句 = 该催他了吗(等了他, 次)
        // SEND_OR_PASS 2026-11-16（批次518）：原来这里写「这一轮**不要发任何消息**」，
        // 她照做了 —— 看完视频写好点评，全落在正文里，一个字都没发出去（03:56 那轮）。
        // 文案与边界现在在 续跑提示() 里，t518 直接喂参数测它的输出。
        if (!读开关().开) return
        const 话 = 续跑提示(等待句)
        await deliver(ctx, sessionId, 话, entry.target, undefined, { proactive: true, sourceKind: 'nudge' })
      } catch (e) {
        note('realtime', `续跑投递失败：${e instanceof Error ? e.message : e}`)
      }
    }, c.间隔秒 * 1000)
    if (定时 && typeof 定时.unref === 'function') 定时.unref()
  } catch (e) {
    note('realtime', `续跑判断失败：${e instanceof Error ? e.message : e}`)
  }
}

/**
 * 纯聊天收尾后，隔一段时间允许她补一句。
 *
 * 为什么不是立刻补：连发两句就是刷屏。她刚说完，正常节奏是等对方接；
 * 只有对方 12 分钟没接、而她手里确实还有材料，补一句才像人。
 * 每段对话最多补一次（`续话每段`），他一开口就重新计数；
 * 不占主动搭话的日配额 —— 那是「隔了很久想起你」，这是「话还没说完」。
 */
function 排续话(ctx, sessionId, entry) {
  try {
    const c = 读开关()
    if (!c.聊天续话 || c.续话每段 <= 0) return
    if (!entry || entry.target?.kind !== 'private') return
    const now = Date.now()
    const 谁 = targetKey(entry.target)
    if (!可续话目标(sessionId, entry.target)) return
    let 龄 = null
    try { 龄 = incomingAgeMs(谁) } catch { 龄 = null }
    if (龄 === null || !Number.isFinite(Number(龄))) return
    const 上封 = now - Number(龄)
    const 前 = 续话账.get(sessionId)
    // 已经排过一条还没到点的，别再排：她连发三条不该攒出三个定时器
    if (前?.上封来信 === 上封 && now - Number(前.排at || 0) < c.续话分 * 60e3) return
    // 他上次说话比记录的新 = 新的一段对话，补话次数归零
    const 次 = 前?.上封来信 === 上封 ? 前.次 : 0
    if (次 >= c.续话每段) return
    const reservation = 预约聊天续话(sessionId, entry.target, { 次, 上封来信: 上封, 排at: now })
    const 定时 = setTimeout(async () => {
      try {
        const { outbound } = await import('./outbound.js')
        const q = outbound.get(sessionId)
        // 队列里有东西 = 他刚说话 / 她还没发完，交给人，别插嘴
        if (Array.isArray(q) && q.length > 0) {
          if (续话账.get(sessionId) === reservation) 续话账.delete(sessionId)
          return
        }
        const stillCurrent = (receiptToken = '') => {
          const pending = outbound.get(sessionId) || []
          return 聊天续话仍有效({
            sessionId, target: entry.target, guardToken: reservation.id, receiptToken, queue: pending,
            agent: ctx.agents.get(sessionId),
          })
        }
        if (!stillCurrent()) {
          if (续话账.get(sessionId) === reservation) 续话账.delete(sessionId)
          return
        }
        try { if (await 睡着()) return } catch { return }
        const 池 = 挑新鲜(话题池(Date.now()), 谁, Date.now()).slice(0, 2)
        if (池.length === 0) {
          if (续话账.get(sessionId) === reservation) 续话账.delete(sessionId)
          return
        }
        const 行 = ['[暂未收到新来信] 上一轮已经结束。']
        行.push('可以再补一句 —— 但只说你自己真想说的，别催、别问「在吗」。')
        行.push('手上有这些是真的（用不用、用哪条都你定）：')
        if (!await 投递续话(ctx, sessionId, entry.target, 行, 池, stillCurrent, reservation)) {
          if (续话账.get(sessionId) === reservation) 续话账.delete(sessionId)
          return
        }
        if (续话账.get(sessionId) === reservation) Object.assign(reservation, { 次: 次 + 1, 排at: 0 })
        note('realtime', `${sessionId} 间隔续话已入队待平台确认（第 ${次 + 1}/${c.续话每段} 次尝试）`)
      } catch (e) {
        note('realtime', `续话投递失败：${e instanceof Error ? e.message : e}`)
      }
    }, c.续话分 * 60e3)
    reservation.定时器 = 定时
    if (定时 && typeof 定时.unref === 'function') 定时.unref()
  } catch (e) {
    note('realtime', `续话判断失败：${e instanceof Error ? e.message : e}`)
  }
}

/**
 * 任务收尾了，问一句「要不要自己找个话题」。
 *
 * 为什么单独限流：这条跟「接着做」不一样，它不解决任何任务，纯粹是聊天。
 * 每收尾一次就搭一句会变成话痨，所以 45 分钟最多一次，而且只在实时模式（她本来就在连着聊）。
 */
function 收尾聊一句(ctx, sessionId, entry) {
  try {
    const c = 读开关()
    if (!c.开) return
    const now = Date.now()
    if (now - (上次话题.get(sessionId) || 0) < 45 * 60e3) return
    const 谁 = 'private:' + String(entry?.target?.id ?? '')
    const 池 = 挑新鲜(话题池(now), 谁, now).slice(0, 4)
    if (池.length === 0) return
    const age = incomingAgeMs(谁)
    const lastIncoming = Number.isFinite(age) ? now - age : null
    上次话题.set(sessionId, now)
    const 定时 = setTimeout(async () => {
      try {
        const { outbound } = await import('./outbound.js')
        const q = outbound.get(sessionId)
        if (Array.isArray(q) && q.length > 0) return
        const 行 = ['[收尾了] 刚才那件事做完了。这会儿可以你自己想个话题跟他说一句 —— 不想说就安静，别硬找。']
        行.push('你手上这些是真的（用不用、用哪条都你定）：')
        行.push('说哪件、怎么开口，你自己定；不要复述提示或问「在干嘛」。')
        const stillCurrent = () => {
          const currentAge = incomingAgeMs(谁)
          const currentIncoming = Number.isFinite(currentAge) ? Date.now() - currentAge : null
          return 上次话题.get(sessionId) === now && !outbound.get(sessionId)?.length && currentIncoming === lastIncoming
        }
        if (!await 投递续话(ctx, sessionId, entry.target, 行, 池, stillCurrent)) return
        note('realtime', `${sessionId} 收尾续话与 ${池.length} 条候选材料已入队待平台确认`)
      } catch (e) {
        note('realtime', `收尾话题投递失败：${e instanceof Error ? e.message : e}`)
      }
    }, 3000)
    if (定时 && typeof 定时.unref === 'function') 定时.unref()
  } catch (e) {
    note('realtime', `收尾话题判断失败：${e instanceof Error ? e.message : e}`)
  }
}

/** 用户真的说话了 / 换会话时，把计数清掉。 */
export function 重置(sessionId) {
  if (sessionId) {
    连跑.delete(String(sessionId))
    冷却.delete(String(sessionId))
    上轮动过.delete(String(sessionId))
    上次话题.delete(String(sessionId))
    const key = String(sessionId)
    clearTimeout(续话账.get(key)?.定时器)
    续话账.delete(key)
  }
}

function 预约聊天续话(sessionId, target, { 次 = 0, 上封来信, 排at = Date.now() } = {}) {
  const key = String(sessionId)
  const old = 续话账.get(key)
  if (old?.定时器) clearTimeout(old.定时器)
  const reservation = {
    id: randomUUID(), 次: Number(次) || 0, 上封来信: Number(上封来信), 排at: Number(排at),
    targetKey: targetKey(target), ordinal: 次 + 1,
  }
  续话账.set(key, reservation)
  return reservation
}

function 可确认清醒() {
  try {
    return JSON.parse(readFileSync(join(记忆目录(), '睡醒.json'), 'utf8'))?.sleeping === false
  } catch (error) {
    if (error.code !== 'ENOENT') return false
    try {
      const sleep = JSON.parse(readFileSync(join(记忆目录(), '睡眠.json'), 'utf8'))
      return sleep !== null && typeof sleep === 'object' && !Array.isArray(sleep) && sleep.live === null
    } catch { return false }
  }
}

function 可续话目标(sessionId, target) {
  const config = getConfig()
  if (config.enabled === false || target?.kind !== 'private' || !targetAllowed(config, targetKey(target))) return false
  const routes = config.routes
  if (routes?.private?.[target.id]?.sessionId !== sessionId) return false
  const bindings = [...Object.values(routes.private), ...Object.values(routes.group ?? {})]
  return bindings.filter(binding => binding?.sessionId === sessionId).length === 1
}

export function 聊天续话仍有效({ sessionId, target, guardToken, receiptToken, queue = [], agent, sourceMessageId }) {
  const reservation = 续话账.get(String(sessionId))
  const config = 读开关()
  const key = targetKey(target)
  const age = incomingAgeMs(key)
  const hasReceipt = String(receiptToken ?? '') !== ''
  const inbox = agent?.inbox
  return config.聊天续话 && String(guardToken ?? '') !== '' && reservation?.id === String(guardToken)
    && agent?.session?.id === sessionId && ![...(inbox?.nextTurn ?? []), ...(inbox?.nextStep ?? [])].some(message => !sourceMessageId || message.id !== sourceMessageId)
    && 可续话目标(sessionId, target)
    && reservation.ordinal <= config.续话每段 && reservation.targetKey === key && Number.isFinite(age) && age >= config.续话分 * 60e3
    && Date.now() - age <= reservation.上封来信 + 1 && Date.now() - age >= reservation.上封来信 - 1
    && 可确认清醒()
    && (hasReceipt ? queue.length === 1 && !queue[0].dropped && queue[0].proactiveReceiptToken === receiptToken : queue.length === 0)
}
