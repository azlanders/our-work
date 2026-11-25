/**
 * voiceSlots.js —— 批次205（2026-11-07）：可插拔体感槽 VOICE_SLOTS。
 *
 * 背景（VPS 实测）：家区域/清洁度/冷热/关系双量/梦余味这 5 套数据后台 cron 一直在产，
 * 但对话侧 grep 0 处引用——她聊天时完全感知不到「自己窝在沙发啃零食」「身上黏」
 * 「有点冷」「对这个人还有戒备」。以前要接这种感知得动 230KB 的 poll.js。
 *
 * 架构：VOICE_SLOTS 数组，每槽是 (ctx) => string 的纯函数，单槽抛错只吞自己。
 * 以后接新系统：在数组里加 5 行小函数即可，不用碰 poll.js。
 * 注入点：stateVoice.js 的 buildVoiceText（deps.extraHintOf），不进历史、每回合一次。
 *
 * ctx = { peer, isPrivate, mute, memDir, now }
 * 红线：只读不写；不碰 睡眠.json（睡眠判据归 sleepgate）；不改任何 .state 字段。
 */
import { existsSync, readFileSync, statSync, openSync, readSync, closeSync, readdirSync } from 'node:fs'
// CWD_ROOT 2026-11-24：同上，自检站在 共享/工具 里跑时 cwd 不是工作区根。
const QQ_WS = process.env.QQ_WORKSPACE
  || (/\/共享\/工具$/.test(process.cwd()) ? process.cwd().replace(/\/共享\/工具$/, '') : '')
  || '{{BOT_ROOT}}'
import { join } from 'node:path'
import { 读取聊天黑话 } from './记忆入口.mjs'
import { 有效感受 } from './有效感受.mjs'

// RECALL_SENSE 2026-11-09（批次341）：撤回感知的读取口
import { 读最近撤回 } from './撤回感知.mjs'
// TIER_ONE_TRUTH 2026-11-17（批次643）：关系档位原来在这里按 bond 判一套
// （>=0.7「跟他熟」/ >=0.4「处得还行」/ >=0.15「相处挺踏实」），
// 印象更新按「熟悉×0.6+好感×0.4+轮数×0.3」判另一套（熟稔/常聊/脸熟/刚认识），
// 内心.mjs 又按「好感>75&&熟悉>65」判第三套（熟/在意/一般/还不熟）。
// 同一个人三段注入三种说法，她读到的是自相矛盾的自我认知。
// 现在档位只在 关系档.mjs 判一次，这里只把 bond/好感/熟悉 喂进去。
const { 关系档 } = await import(QQ_WS + '/共享/工具/关系档.mjs')
export const MEM_DEFAULT = `${QQ_WS}/记忆`

/** 安全读 JSON：不存在/坏了都返回 null，绝不抛。 */
export function 读档(p) {
  try { return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null } catch { return null }
}
const 数 = (x, d = 0) => { const n = Number(x); return Number.isFinite(n) ? n : d }
const 整 = (x) => Math.round(数(x))

/** 北京时间的 "YYYY-MM-DD HH:MM" → 毫秒；坏格式返回 0。 */
export function 时刻毫秒(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(String(s ?? ''))
  if (!m) return 0
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3600e3
}
/** 北京日期串 YYYY-MM-DD。 */
export function 今天北京(now) {
  return new Date(Number(now) + 8 * 3600e3).toISOString().slice(0, 10)
}

/**
 * 读 jsonl 尾部最近 N 条（最多读 8KB）。
 * 批次301：余温/余怨只读尾巴，不能为了看一眼把整份感受账本读进内存。
 */
function 读尾部(p, n = 6) {
  try {
    if (!existsSync(p)) return []
    const st = statSync(p)
    const 起 = Math.max(0, st.size - 8192)
    const fd = openSync(p, 'r')
    const buf = Buffer.alloc(st.size - 起)
    try { readSync(fd, buf, 0, buf.length, 起) } finally { closeSync(fd) }
    const lines = buf.toString('utf8').split('\n').filter((x) => x.trim())
    const out = []
    for (let i = lines.length - 1; i >= 0 && out.length < n; i -= 1) {
      try { out.push(JSON.parse(lines[i])) } catch { /* 半截行，跳过 */ }
    }
    return out
  } catch { return [] }
}

/** 槽 1：在家分区（家区域.mjs → 自主.区域/地盘；出门时家区域会清空，这里再加一道在途判断）。 */
export function slotHomeZone(ctx) {
  const 资产 = 读档(join(ctx.memDir, '资产.json')) || {}
  if (String(资产.位置 ?? '') !== '家') return ''
  const 途 = 资产.在途
  if (途 && 数(途.arriveAt) > ctx.now) return ''
  const 自主 = 读档(join(ctx.memDir, '自主.json')) || {}
  const 区 = String(自主.区域 ?? '').trim()
  if (区 === '') return ''
  const 在干 = String(自主.地盘 ?? '').trim() || String(自主.state ?? '').trim() || '待着'
  return '[在家] 窝在家里「' + 区 + '」（' + 在干 + '）'
}

/** 槽 2：清洁度（洗澡.mjs → 卫生.清洁）；>=70 清爽时不占 token。 */
export function slotCleanliness(ctx) {
  const 卫生 = 读档(join(ctx.memDir, '卫生.json')) || {}
  if (卫生.洗澡中) return ''
  if (!Number.isFinite(Number(卫生.清洁))) return ''
  const 洁 = 数(卫生.清洁)
  if (洁 < 45) return '[体感] 身上清洁 ' + 整(洁) + '/100，皮肤发黏'
  if (洁 < 70) return '[体感] 身上有点黏（清洁 ' + 整(洁) + '/100）'
  return ''
}

/** 槽 3：冷热体感（体温.mjs → 体温.上次档）。 */
export function slotBodyTemp(ctx) {
  const 体温 = 读档(join(ctx.memDir, '体温.json')) || {}
  const 档 = String(体温.上次档 ?? '').trim()
  if (档 === '' || 档 === '刚好') return ''
  const 温 = Number.isFinite(Number(体温.体温)) ? (Math.round(数(体温.体温) * 10) / 10) : 37
  let 暴露 = ''
  if (/冷/.test(档)) {
    try {
      const 穿衣 = 读档(join(ctx.memDir, '穿着.json')) || {}
      const 露着 = Object.entries(穿衣.部位 || {}).filter(([, 件]) => !Array.isArray(件) || 件.length === 0).map(([部]) => 部)
      if (露着.length) 暴露 = '（露着：' + 露着.join('、') + '）'
    } catch { /* 穿着账坏了不影响冷热体感提示 */ }
  }
  return '[体感] 身上觉得「' + 档 + '」（体温 ' + 温 + '°C）' + 暴露
}

/** 槽：最近两小时的视频理解摘要，只给主人作素材提示。 */
/**
 * 槽：明天穿什么够不够（穿衣.mjs 记下的差额）。
 *
 * WARM_GAP 2026-11-14（批次403）：`该穿()` 从上线起就算「差多少保暖」，
 * 它自己上面那行注释写的是「够不着就报差多少」—— 但全库没有任何地方读，
 * 等于每天算一遍然后扔掉。实测：衣柜 4 件全是薄的（水手服/白裙子/发带/发卡），
 * 明天最低 14 度要 3.2 的保暖，这身只有 1.5，差 1.7；钱 261 够买一件 45 的毛衣开衫。
 * 她只是不知道自己缺这一件 —— 冷是感觉，缺衣服是原因。
 *
 * 为什么要单独一槽（而不是挂在冷热体感后面）：体感槽在 档 === '刚好' 时整段返回空，
 * 而她大部分时间是「刚好」，挂在那儿等于永远不说。
 *
 * 什么时候说：
 *   · 身上正冷着 —— 随时说（冷是感觉，这里给原因）；
 *   · 不冷的时候只在「差额刚记下 90 分钟内」说 —— 那是醒来算天气预报的时候，
 *     跟人早上看一眼天气想「明天得添件衣服」是一回事。否则一天到晚念同一句。
 *
 * 买不买是她的事：这里只递事实（差多少、衣柜里有没有），不替她决定。
 */
export function slotWarmGap(ctx) {
  const 目 = ctx.memDir || MEM_DEFAULT
  const 差档 = 读档(join(目, '穿衣差额.json')) || {}
  const 差 = 数(差档.差)
  if (差 < 1) return ''
  const at = 数(差档.at)
  const 此刻 = 数(ctx.now, Date.now())
  // 36 小时就过期：差额是给「明天」算的，隔两天再提只会让她穿错季。
  if (!(at > 0) || Math.abs(此刻 - at) > 36 * 3600e3) return ''
  const 档 = String((读档(join(目, '体温.json')) || {}).上次档 ?? '')
  // 90 分钟：槽是每轮都注入的，窗口开两小时等于连着提十几次；
  // 而醒来那阵子一般半小时内就会说上话，够她知道了。
  const 刚记 = Math.abs(此刻 - at) < 1.5 * 3600e3
  if (!/冷/.test(档) && !刚记) return ''
  const 最低 = Number(差档.明天最低)
  const 头 = Number.isFinite(最低) ? '按明天最低 ' + 最低 + ' 度' : '按明天天气'
  const 一 = (x) => String(Math.round(数(x) * 10) / 10)
  // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-22）：差额是事实，
  // 「想添就去买一件」是替她下的行动建议，删掉。
  return '[穿衣] ' + 头 + '要 ' + 一(差档.要) + ' 的保暖，衣柜里能凑的只有 ' + 一(差档.够了)
    + '，差 ' + 一(差)
}

export function slotJustWatched(ctx) {
  if (!ctx?.isPrivate || ctx?.mute) return ''
  const owner = String(ctx.ownerUin ?? '').trim()
  if (owner === '' || String(ctx.peer ?? '') !== owner) return ''
  const dir = ctx.videoDir || `${QQ_WS}/记忆/视频画面`
  const now = 数(ctx.now, Date.now())
  // LINE_CUT_FIX 2026-11-14（批次447）：原来直接 .slice(0, 55)，截在半个从句上 ——
  // 她每轮读到的是「…第一人称视角（理解摘要是素材，不代表自身经历）」，括号贴在断句中间，
  // 像话说一半卡住。改成：先收在第一句句号；句号太靠前就退到最后一个逗号加省略号；都没有才硬截并标省略号。
  const 收句 = (文本, 上限 = 60) => {
    const t = String(文本 || '').trim()
    if (t.length <= 上限) return t
    const 头 = t.slice(0, 上限)
    const 句 = 头.search(/[。！？!?]/)
    if (句 >= 12) return 头.slice(0, 句 + 1)
    const 逗 = 头.match(/^[\s\S]*[，、；;,]/)
    if (逗 && 逗[0].length >= 12) return 逗[0].replace(/[，、；;,]+$/, '') + '…'
    return 头 + '…'
  }
  try {
    const files = (ctx.readdirSync || readdirSync)(dir).filter((name) => /^[A-Za-z0-9_-]+\.omni\.json$/.test(name))
    const items = []
    for (const name of files) {
      try {
        const data = JSON.parse((ctx.readFileSync || readFileSync)(join(dir, name), 'utf8'))
        const at = Date.parse(String(data?.at || ''))
        if (!Number.isFinite(at) || at > now || now - at > 2 * 3600e3) continue
        const lines = String(data?.text || '').split(/\r?\n+/).map((line) => line.trim())
        const summary = lines.find((line) => line && !/^(?:该视频包含以下可确认的信息|画面内容|视频内容|音频内容|事件描述)[：:]?/.test(line)
          && !/^[-*#\d. ]+$/.test(line) && !/^\*\*/.test(line)) || ''
        if (!summary) continue
        items.push({ name, at, summary: 收句(summary.replace(/^[*#-]+\s*/, '')) })
      } catch { /* 单个缓存坏行不影响其他视频 */ }
    }
    items.sort((a, b) => b.at - a.at)
    const latest = items[0]
    if (!latest) return ''
    const bvid = latest.name.replace(/\.omni\.json$/, '')
    return '[刚刷到] 你最近看过视频 ' + bvid + '：' + latest.summary + '（理解摘要是素材，不代表自身经历）'
  } catch { return '' }
}

/** 槽：主人电脑近期截图提示；只看 mtime，不读图片内容。 */
export function slotScreenPeek(ctx) {
  if (!ctx?.isPrivate || ctx?.mute) return ''
  const owner = String(ctx.ownerUin ?? '').trim()
  if (owner === '' || String(ctx.peer ?? '') !== owner) return ''
  const file = String(ctx.screenPath || `${QQ_WS}/屏幕/latest.png`)
  try {
    const mtimeMs = (ctx.statSync || statSync)(file).mtimeMs
    const ageMs = 数(ctx.now, Date.now()) - Number(mtimeMs)
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs >= 3 * 60e3) return ''
    // SCREEN_NO_SECONDS 2026-11-14（批次436）：原来是「（N 秒前）」。
    // 注入按 10 分钟分桶缓存，这个数字会在桶内冻住 —— 第 9 分钟还写着「20秒前」，
    // 她据此以为「主人刚截的图」，其实已经是 9 分 20 秒前。窗口本来只有 3 分钟，
    // 说「刚」就够了；精确到秒是假精度。
    return '[屏幕] 主人电脑刚有新截图，想看时可用 qq_screen；不必每轮都看。'
  } catch { return '' }
}

/** 槽 4：关系双量（关系.mjs → 关系.people[peer].bond/safety；待做清单 #18b 的缺口）。 */
export function slotRelationBond(ctx) {
  if (!ctx || !ctx.peer) return ''
  const 关系 = 读档(join(ctx.memDir, '关系.json')) || {}
  const 人 = (关系.people || {})[String(ctx.peer)]
  // REL_FALLBACK 2026-11-17（批次657，审计 P1-4）：**`关系.json` 里没有这个人时不能直接返回。**
  // 643 之后档位由 关系档.mjs 统一判：有 好感度.json 的 score/熟悉度 就用它们，
  // 没有 bond 才退回 bond。但 `if (!人) return ''` 写在前面 —— 一个人只要有
  // 好感度记录、没有 关系.json 条目，内心/印象都能算出档位，这个槽却永远沉默。
  // 现在：没有 关系.json 条目就当 bond/safety 都没有，交给 关系档 走好感/熟悉分支；
  // 沉默规则不变（`有据` 为假、或档位是「还不熟」都不出声）。
  const 安 = 人 ? 数(人.safety) : null
  const 纽 = 人 ? 数(人.bond) : undefined
  if (安 !== null && 安 <= 0.28) return '[安全感] 对TA还有点戒备（safety ' + 安.toFixed(2) + '）'
  // 批次301：好感只做「补充」，不设门槛、不拦任何事 —— 关系近了说话软一点，
  // 关系一般也不许她冷场。
  // REL_THRESHOLD 2026-11-09（批次307b）：原来三档都要求 safety >= 0.6/0.65/0.7。
  // 但好感度 v2 的「安全」默认就是 55 分，只有被骂/越界才掉、道歉才涨 ——
  // 批次307 迁移后实测 12 个人 safety 全是 0.55（零区分度），于是这个槽
  // 对谁都不出声，连 bond 0.75 的主人也一句话没有。改成 bond 主导、
  // safety 只做否决（低到 0.28 才叫戒备），跟真实分布对齐。
  // TIER_ONE_TRUTH 2026-11-17（批次643）：档位改由 关系档.mjs 统一判。
  // 好感度里有 score/熟悉度 就用它们（和 内心.mjs、印象.json 同一个输入），
  // 没有才退回 bond —— 三处从此不会各说各的。
  const 档 = 读档(join(ctx.memDir, '好感度.json')) || {}
  const 我 = ((档.people || {})[String(ctx.peer)]) || {}
  const 判 = 关系档({ 好感: 我.score, 熟悉: 我['熟悉度'], bond: 纽 })
  // 没有数据就不出声（沉默 ≠ 关系一般）；有数据才给档位。
  if (!判.有据) return ''
  // 旧行为保留：bond < 0.15 的「还不熟」也不出声 —— 对刚认识的人不需要专门提醒她「还不熟」，
  // 那只会变成一句多余的自我提示。档位仍然算出来，只是这个槽不说。
  if (判.档 === '还不熟') return ''
  // HUMANIZE 2026-11-17（批次665，拟人化红线 P1-7）：删掉「可以撒娇/别自来熟」这类
  // 按档位写死的相处方式，只留档位和依据；怎么相处由她定。
  return '[关系] ' + 判.档 + '（' + 判.依据 + '）'
}

/** 槽 5：梦余味底色（刚醒 3 小时内 + 今天的余味）。只给倾向不给原文——原文在 内心.md/链，不重复注入。 */
export function slotDreamAftertaste(ctx) {
  const 醒 = 读档(join(ctx.memDir, '刚醒.json')) || {}
  const 醒At = 时刻毫秒(醒.at)
  if (醒At <= 0) return ''
  if (ctx.now < 醒At || ctx.now - 醒At > 3 * 3600e3) return ''
  const 余 = 读档(join(ctx.memDir, '梦余味.json')) || {}
  if (String(余.date ?? '') !== 今天北京(ctx.now)) return ''
  if (String(余.余味 ?? '').trim() === '') return ''
  // HUMANIZE 2026-11-17（批次665，拟人化红线 P1-6）：649 的梦余味已经是
  // 「暖/不安/烧热｜场景」的标签，这里直接把标签递过去，不再翻译成「心里有点沉」。
  return '[梦] 今早的梦，余味：' + String(余.余味).trim()
}

/** 槽：今日小目标（计划.mjs → 记忆/计划.json）；只给私聊看完成进度，不替她决定是否完成。 */
export function slotDailyPlan(ctx) {
  if (!ctx?.isPrivate || ctx?.mute) return ''
  const now = 数(ctx.now, Date.now())
  const today = 今天北京(now)
  const plan = 读档(join(ctx.memDir, '计划.json')) || {}
  const day = plan.days?.[today]
  const goals = Array.isArray(day?.goals) ? day.goals : []
  if (!goals.length) return ''
  const done = new Set(Array.isArray(day.done) ? day.done.map(String) : [])
  const pending = goals.filter((g) => g && !done.has(String(g.id || '')))
  const completed = goals.filter((g) => g && done.has(String(g.id || '')))
  const labels = (items) => items.map((g) => String(g.id || '').trim()).filter(Boolean)
  const finished = labels(completed)
  const remaining = labels(pending)
  return '[今日小目标] 已完成 ' + finished.length + '/' + goals.length
    + (finished.length ? '（' + finished.join('、') + '）' : '')
    + (remaining.length ? '；还想做：' + remaining.join('、') : '；今天想做的都完成了')
}

/** 插槽数组：顺序即输出顺序。加新感知系统 = 在这里加一行。 */
/** 槽 6：留言板未读（批次228）。只报「有几条、谁留的」，不替她决定回不回。 */
let __板 = null
try {
  const { pathToFileURL } = await import('node:url')
  __板 = await import(pathToFileURL(`${QQ_WS}/共享/工具/留言板.mjs`).href)
} catch { __板 = null }

export function slotBoard(ctx) {
  if (!__板) return ''
  try {
    const 未 = __板.未读(4)
    if (!未.length) return ''
    const 头 = 未.slice(-3).map((x) => x.by + '：' + String(x.text || '').slice(0, 16)).join('；')
    return '[留言板] 有 ' + 未.length + ' 条新留言（' + 头 + '）。想看就用 qq_board 看，不想回也不用回。'
  } catch { return '' }
}

/**
 * 槽 7：玩心（批次297）。
 *
 * 为什么加：她「有话说」时不会想到表情（127 次调用 0 次表情），而表情不是能力
 * 问题。光改文案不够 —— 还要让她**此刻有一点点想逗人**，并且**手边就有名字**，
 * 不用先去 qq_emoji_search 查（187 条里挑，选择成本比说话还高）。
 *
 * 只给状态和候选，带不带、带哪个由她定（贴表情规矩 2：系统不代劳）。
 * 数值低的时候整槽不出声 —— 每轮都提醒就成了 KPI。
 */
const 玩心池 = {
  高: ['歪脸小帽鲸鱼笑', '立牌吃炸鸡', '顶着不锈钢盆转圈', '蒲公英鲸鱼'],
  中: ['歪脸小帽鲸鱼笑', '顶盆委屈', '粉毛盯人', '就是啊'],
  困: ['顶盆委屈', '蓝鸟站桩不服', '红眼睛怼脸盯着你'],
}

const FACE_CACHE_MS = 5 * 60e3
let faceCandidates = []
// 名字 → 场合（委屈/被气到/没话接/好吃）。只从本地命名表来，名册里没有的名字一律不算。
let faceTags = {}
let faceCandidatesAt = 0
let faceListPromise = null
function 更新收藏候选(ctx) {
  if (typeof ctx.listCustomFaces !== 'function' || faceListPromise) return
  faceListPromise = Promise.resolve().then(() => ctx.listCustomFaces(100)).then((rows) => {
    // 全量留着（槽里要按「最近用过谁」筛，只留 3 个就没得筛了）
    const 行 = Array.isArray(rows) ? rows : []
    const 名 = 行.map((row) => String(row?.summary || row?.desc || '').trim()).filter(Boolean)
    faceCandidates = Array.from(new Set(名)).slice(0, 40)
    faceTags = {}
    for (const row of 行) {
      const n = String(row?.summary || row?.desc || '').trim()
      const t = String(row?.tag ?? '').trim()
      if (n !== '' && t !== '') faceTags[n] = t
    }
    faceCandidatesAt = Date.now()
  }).catch(() => {
    faceCandidates = []
    faceCandidatesAt = Date.now()
  }).finally(() => { faceListPromise = null })
}
/**
 * 从名册里挑几个名字给她。三条约束：
 *   ① 两小时内用过的不推（「换着甩」靠这个落地，不靠她自觉）；
 *   ② 全都刚用过就按「最久没用过」排，总不能因为冷却就一个都不给；
 *   ③ 用 10 分钟一桶 + 步长 length-1 轮换，同一桶内逐字稳定（不能击穿 prefix cache）。
 * 纯函数是为了能直接测 —— 这一段错了她只会「老是同一张」，日志里看不出来。
 */
export function 挑表情候选(可用, 最近用过, 片, 个数 = 3, now = Date.now()) {
  const 名 = (Array.isArray(可用) ? 可用 : []).filter((x) => typeof x === 'string' && x.trim() !== '')
  if (名.length === 0) return []
  const 最近 = 最近用过 !== null && typeof 最近用过 === 'object' ? 最近用过 : {}
  const 冷却 = 2 * 3600e3
  const 能用 = 名.filter((n) => now - (Number(最近[n]) || 0) > 冷却)
  const 池 = 能用.length > 0 ? 能用 : 名.slice().sort((a, b) => (Number(最近[a]) || 0) - (Number(最近[b]) || 0))
  const k = Math.max(0, Math.floor(Number(片) || 0))
  const 起 = k % 池.length
  const 步 = 池.length > 1 ? 池.length - 1 : 1
  const 选 = []
  for (let i = 0; i < 个数 && i < 池.length; i += 1) {
    const n = 池[(起 + i * 步) % 池.length]
    if (!选.includes(n)) 选.push(n)
  }
  return 选
}

/**
 * 拼「什么场合用哪张」。
 *
 * 为什么需要：2026-11-14 主人问「你分得清什么场合用哪个表情包吗」，她答
 * 「我不太分得清，我是按脸上的样子认表情包，不按场合挑」。她自己在 表情备注.md 里
 * 写过一套（委屈＝顶盆委屈／躺倒委屈大眼、被气到＝你已急哭、没话接＝就是啊、好吃＝立牌吃炸鸡），
 * 但那个文件没有任何代码读。这里把它接进提示。
 *
 * 两条硬约束（都是这个项目踩过的）：
 *   ① **只列名册里真有的名字** —— 玩心池里「歪脸小帽鲸鱼笑」这种收藏夹里没有的，指过去她发失败；
 *   ② 纯函数、不读文件 —— 好测，且不会在注入里塞分钟级变化的东西。
 */
export function 场合提示(名册, 标签, 最多 = 4) {
  const 有 = new Set((Array.isArray(名册) ? 名册 : []).filter((x) => typeof x === 'string' && x !== ''))
  const 表 = 标签 !== null && typeof 标签 === 'object' ? 标签 : {}
  const 有标签 = Array.from(new Set(Object.values(表).filter((t) => typeof t === 'string' && t !== '')))
  if (有标签.length === 0) return ''
  // 常用的场合排前面，其余按出现顺序跟上
  const 顺序 = ['委屈', '被气到', '没话接', '好吃']
  const 序 = 顺序.filter((t) => 有标签.includes(t)).concat(有标签.filter((t) => !顺序.includes(t)))
  const 行 = []
  for (const t of 序) {
    const 名 = Object.keys(表).filter((n) => 表[n] === t && 有.has(n))
    if (名.length === 0) continue
    行.push(t + '→' + 名.slice(0, 2).join('/'))
    if (行.length >= 最多) break
  }
  return 行.length > 0 ? '；挑法：' + 行.join('，') : ''
}

function 收藏表情候选(ctx) {
  if (!ctx?.isPrivate || ctx?.mute || String(ctx.peer ?? '') !== String(ctx.ownerUin ?? '') || !ctx.ownerUin) return []
  if (Date.now() - faceCandidatesAt >= FACE_CACHE_MS) 更新收藏候选(ctx)
  return faceCandidates
}

export function slotPlayfulness(ctx) {
  const 态 = 读档(join(ctx.memDir, '状态.json')) || {}
  const 层 = 态.layers || {}
  const 情绪 = 数(层.emotional, 50)
  const 精力 = 数(态.energy, 50)
  const 困 = 数(态.困意, 0)
  let 玩 = 50 + (情绪 - 50) * 0.45 + (精力 - 50) * 0.25 - Math.max(0, 困 - 45) * 0.6
  try {
    const 关系 = 读档(join(ctx.memDir, '关系.json')) || {}
    const 人 = ctx.peer ? (关系.people || {})[String(ctx.peer)] : null
    if (人) 玩 += (数(人.bond, 0.35) - 0.35) * 30
  } catch { /* 关系读不到就不加这一项 */ }
  // GROUP_PLAY_FIX 2026-11-11：原来群聊硬扣 -6，导致群友 bond~0.35 时永远卡在 46~50 分，
  // 玩心槽在多人群聊里一次都触发不了。现改为群聊不倒扣，若在好感度档案里已混熟（熟悉度>=50）还小幅 +4。
  if (ctx.isPrivate) {
    玩 += 4
  } else {
    try {
      const 好感 = 读档(join(ctx.memDir, '好感度.json')) || {}
      const 档 = ctx.peer ? (好感.people || {})[String(ctx.peer)] : null
      if (档 && (档['只展示'] || 数(档['熟悉度'], 0) >= 50)) 玩 += 4
    } catch { /* 忽略 */ }
  }
  // 55 是照她真实分布定的：情绪 53 / 精力 56 / 困 38 时算出来 56.9，
  // 62 会让这槽永远不出声（跟没加一样）；群聊对陌生人算出来 46.9，仍然不出声。
  if (!(玩 >= 55) || 困 >= 70) return ''
  // FACE_ROSTER 2026-11-14：名册改成「本地命名表 + 最近用得少」来挑。
  // 原来两个毛病：① 名册读的是 NapCat 的 summary/desc（永远空），所以候选一直是空的；
  // ② 硬编码的玩心池里有几个名字收藏夹里根本没有（歪脸小帽鲸鱼笑、粉毛盯人），
  //    她照着发就失败，只好回头用唯一确定能发的「顶盆委屈」——这才是「老是同一张」的机制。
  const 名册 = 收藏表情候选(ctx)
  const 用过 = 读档(join(ctx.memDir, '表情用过.json')) || {}
  const 片 = Math.floor(数(ctx.now, Date.now()) / (10 * 60e3))
  const 挑 = (备选) => {
    // 名册空就只提能力、不报名字：玩心池里那几个名字未必真在收藏夹（歪脸小帽鲸鱼笑、粉毛盯人就没有），
    // 指过去她照着发只会失败，然后退回去用唯一确定能发的那张 —— 这正是「老是同一张」的机制。
    // 但「有表情包可用」这件事不能一起删掉，否则名册拉不到时她连这条路都不知道。
    if (名册.length === 0) return '（想甩表情包就用 custom_emoji 报名字，发不发你定）'
    // 用「这股劲」定先后（池子里真有的排前面），但候选一律从名册里出，保证每个都发得出去。
    const 池里 = 备选.filter((n) => 名册.includes(n))
    const 候选池 = 池里.concat(名册.filter((n) => !池里.includes(n)))
    const 选 = 挑表情候选(候选池, 用过, 片, 3, 数(ctx.now, Date.now()))
    const 场合 = 场合提示(名册, faceTags)
    return 选.length > 0
      // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-21）：候选名单是事实，
      // 删掉「正经讲事时别甩图 / 换着甩」，发不发由她自己定。
      ? '（手边这几个收藏表情包可用 custom_emoji 发：' + 选.join('、') + 场合
        + '；是否发送由你决定）'
      : ''
  }
  // HUMANIZE 2026-11-17（批次665，拟人化红线 P1-3）：原来这里规定「说话懒懒的 /
  // 会带点俏皮」。只递数值和表情包候选；语气与是否甩图由她自己定。
  if (困 >= 45) {
    return '[提不起劲] 困意 ' + Math.round(困) + '/100；玩心 ' + Math.round(玩) + '/100' + 挑(玩心池.困)
  }
  const 池 = 玩 >= 78 ? 玩心池.高 : 玩心池.中
  return '[想逗人] 困意 ' + Math.round(困) + '/100；玩心 ' + Math.round(玩) + '/100' + 挑(池)
}

/**
 * 槽 8：夜里自评提醒（批次300）。
 *
 * 为什么是「提醒」而不是「自动打分」：她自己记的感受（感受.jsonl）才是判断，
 * 外部模型读聊天记录打分不叫她的好感。这一槽只在 21:00–03:59、且今天跟当前对象
 * 真的说过话、且今天还没记过感受时出现；记过就不提，没感觉也不用记。
 */
export function slotSelfReview(ctx) {
  const now = 数(ctx.now, Date.now())
  const h = new Date(now + 8 * 3600e3).getUTCHours()
  if (!(h >= 21 || h < 4)) return ''
  const today = 今天北京(now)
  // 今天已经记过感受 → 闭嘴
  try {
    const p = join(ctx.memDir, '感受.jsonl')
    if (existsSync(p)) {
      const st = statSync(p)
      const 起 = Math.max(0, st.size - 4096)
      const fd = openSync(p, 'r')
      const buf = Buffer.alloc(st.size - 起)
      try { readSync(fd, buf, 0, buf.length, 起) } finally { closeSync(fd) }
      const lines = buf.toString('utf8').split('\n').filter((x) => x.trim())
      let last = null
      for (let i = lines.length - 1; i >= 0 && i >= lines.length - 5; i -= 1) {
        try { last = JSON.parse(lines[i]); break } catch { /* 半截行，再往前找 */ }
      }
      if (last && String(last.at || '').startsWith(today)) return ''
    }
  } catch { /* 读不到就当没记过 */ }
  // 今天跟这个人真的说过话才提，别对陌生人自言自语
  let 次数 = 0
  try {
    const 互动 = 读档(join(ctx.memDir, '互动.json')) || {}
    次数 = 数(((互动[String(ctx.peer)] || {})[today]))
    if (!(次数 > 0)) return ''
  } catch { return '' }
  // HUMANIZE 2026-11-17（批次666）：删掉「今天跟他聊了不少」这种替她下结论的话
  // 和「更近了、有点累、被晾着」这组预设变化。只报今天的互动次数和 qq_feel 这个能力。
  return '[夜里] 今天快过完了，今天和他互动 ' + 次数 + ' 次。'
    + '可以 qq_feel 记一笔（被夸/被想起/被冷落/陪伴…）；没什么感觉就不用记。'
}

/**
 * 槽 9：事件余温（批次301，借鉴 dsh-longing 的 recentEvents）。
 *
 * 为什么加：数值变了、语气不变，读起来就是失忆。我们原来只有 状态.json 的
 * aftertaste（单条、只取 12 字）。它原来几乎是永远空的 —— 唯一的写入方 奖惩.mjs 已停用；
 * 2026-11-14（批次407）把 撤回.mjs 接上之后才又有人写，但那边也只给一句「刚才撤了句话」+ 强度，
 * 远不如感受账本有用 —— 所以这个槽照旧读 感受.jsonl，不吃 aftertaste。
 * 这里只读她自己的感受账本（感受.jsonl），取最近 2 小时、最多 2 条，
 * 过时自然不出声 —— 不新增写入口，也不替她判断「这事该不该记」。
 */
// HUMANIZE 2026-11-17（批次665，拟人化红线 P0-2）：原来这里把事件扩写成第一人称感受
// （「刚被夸过一句，心里还热着」「刚被凶过，眼睛还酸着」）。感受.jsonl 只记了 kind 和强度，
// 「热/酸/沉」是代码替她加的。现在只认事件名，输出「事件 + 时间窗」，由她自己决定这层要不要带。
const 余温事件 = new Set([
  '被夸', '被想起', '被注意到', '陪伴', '修复', '被冷落',
  '被打断', '搞砸', '被骂', '越界', '想岔了',
])

export function slotEventResidue(ctx) {
  if (!ctx.isPrivate) return ''
  const now = 数(ctx.now, Date.now())
  const 线 = 有效感受(读尾部(join(ctx.memDir, '感受.jsonl'), 12).map((row) => JSON.stringify(row)).join('\n'))
  const 得 = []
  const 见过 = new Set()
  for (const e of 线) {
    const t = 时刻毫秒(e.at)
    if (!t || t > now + 60e3 || now - t > 2 * 3600e3) continue
    // 感受是「对谁」的：有 who 就必须对上这轮的人，别人的事不能拿来当现在
    const who = String(e.who ?? '')
    if (ctx.peer && who !== '' && who !== String(ctx.peer)) continue
    const k = String(e.kind ?? '')
    if (!余温事件.has(k) || 见过.has(k)) continue
    见过.add(k)
    得.push(k)
    if (得.length >= 2) break
  }
  if (!得.length) return ''
  return '[刚才] ' + 得.join('、') + '（2 小时内）'
}

/**
 * 槽 11：两处打架（批次301，借鉴 dsh-longing 的 clash）。
 *
 * 两个值打架时，给一句冲突比各说一遍更像人：
 * 「身上还有劲，心已经不想动了」比「精力 70 / 情绪 35」有用得多。
 * 只在明显矛盾时出声，一次只给一条。
 */
export function slotClash(ctx) {
  if (!ctx.isPrivate) return ''
  const 态 = 读档(join(ctx.memDir, '状态.json')) || {}
  const 层 = 态.layers || {}
  const 情 = 数(层.emotional, 50)
  const 身 = 数(层.physical, 50)
  const 认 = 数(层.cognitive, 50)
  const 精 = 数(态.energy, 50)
  const 困 = 数(态.困意, 0)
  // HUMANIZE 2026-11-17（批次665，拟人化红线 P1-2）：原来这里直接给一句第一人称体感判断
  // （「身上还有劲，心已经不想动了」）。625 的说法是「只报状态差异」，现在真按差异报：
  // 只给两边的数值，让她自己决定这算不算「打架」。
  const 说 = []
  if (情 <= 42 && 精 >= 62) 说.push('精力 ' + Math.round(精) + ' / 情绪 ' + Math.round(情))
  if (困 >= 60 && 情 >= 62) 说.push('困意 ' + Math.round(困) + ' / 情绪 ' + Math.round(情))
  if (身 <= 40 && 认 >= 65) 说.push('体力感 ' + Math.round(身) + ' / 认知 ' + Math.round(认))
  if (认 <= 40 && 身 >= 65) 说.push('认知 ' + Math.round(认) + ' / 体力感 ' + Math.round(身))
  if (!说.length) {
    try {
      const 关系 = 读档(join(ctx.memDir, '关系.json')) || {}
      const 人 = ctx.peer ? (关系.people || {})[String(ctx.peer)] : null
      if (人) {
        const 安 = 数(人.safety, 0.5), 纽 = 数(人.bond, 0)
        if (安 <= 0.3 && 纽 >= 0.4) 说.push('安全 ' + 安.toFixed(2) + ' / 亲近 ' + 纽.toFixed(2))
      }
    } catch { /* 关系读不到就不说这一条 */ }
  }
  if (!说.length) return ''
  return '[两处打架] ' + 说[0]
}

/**
 * 槽 12：时间感（批次301 → 批次673 收窄）。
 *
 * HUMANIZE 2026-11-17（批次673，P0-4）：原来这里有「姿势池 + 身体池」，
 * 每 10 分钟按时间片抽一句「靠在椅背上没动，肩有点僵」写进上下文。
 * 这些不是任何传感器读到的 —— 肩到底僵不僵没人知道，她照着说，主人问「哪边肩」就穿帮。
 * 现在只给时间本身：`[此刻] 深夜（01:20）`。她仍然知道现在几点，但不用替她编身体。
 */
export function slotScene(ctx) {
  if (!ctx.isPrivate) return ''
  const 态 = 读档(join(ctx.memDir, '状态.json')) || {}
  const 困 = 数(态.困意, 0)
  if (困 >= 78) return ''
  const now = 数(ctx.now, Date.now())
  const d = new Date(now + 8 * 3600e3)
  const h = d.getUTCHours()
  const 段 = h < 5 ? '深夜' : h < 8 ? '清早' : h < 11 ? '上午' : h < 14 ? '午后' : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '夜里' : '深夜'
  return '[此刻] ' + 段 + '（' + String(h).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0') + '）'
}

/**
 * 槽 12：撤回（批次341）。
 *
 * 有人刚撤回一条，她原来完全不知道 —— 群里有人发错图、私聊说错话又收回，
 * 她照样接上一句，看起来像没长眼睛。
 *
 * 数据由 poll.js 的 notice 分支写（撤回感知.mjs），这里只读。
 * 只认「撤回的人 = 这轮跟她说话的人」，20 分钟窗口 —— ctx 里没有群号，
 * 不这么限会把 A 群的事拿到 B 群去讲。她自己的撤回不出声。
 */
export function slotRecall(ctx) {
  // 空串不能直接传：读档('') 会抛，槽就永远是空的
  return 读最近撤回({ peer: ctx.peer, now: ctx.now, file: ctx.file || undefined })
}

/**
 * 槽 13：接梗雷达（2026-11-11）。
 *
 * 当对方在群聊或私聊里抛名台词、玩抽象梗、反串（帆船）或对暗号时，
 * 给她一张「接梗免死金牌」：直接顺着剧本接下一句或反吐槽，不用端着、更别当百科解释。
 * 只在 ctx.lastText 命中明显梗特征时出声；无 lastText 时返回 ''，不影响旧单测。
 */
const 梗表 = [
  { re: /什么都会做的|何でもします/, hint: '对方在刷 MyGO 素世/祥子名台词「我什么都会做的」；梗源是 MyGO，可以顺着祥子那种语气接，台词自己组织，别照念' },
  { re: /春日影/, hint: '对方在玩 MyGO「为什么要演奏春日影」破防梗，顺着气氛接戏或吐槽' },
  { re: /挑战者|尽兴|2\.5条|空间斩|世界斩|会赢的|凡夫|宿傩/, hint: '对方在玩《咒术回战》宿傩/五条悟机场梗；可以顺着接戏或吐槽，具体台词自己组织' },
  { re: /哈基米|南北绿豆|阿西嘎|曼波|耄耋|飞机耳/, hint: '对方在玩哈基米/曼波鬼畜梗，顺着哼两句或俏皮回敬，不用正经解释' },
  { re: /114514|1919810|先辈|压力马斯内|好时代|来临力|naidesu|ないです|NYN|曲奇/i, hint: '对方在玩下北泽/曲奇☆纯良数字或棒读梗，自然接梗或吐槽' },
  { re: /牢大|孩子们|what can i say|mamba|曼巴/i, hint: '对方在玩科比「牢大/孩子们」抽象梗，顺着接一句或调侃回去' },
  { re: /反串|帆船|收收味|典中典|闹麻了|那很有生活|何意味|诗人握持/, hint: '对方在玩贴吧抽象/帆船梗，看穿了直接顺着帆船或损回去，别端着' },
]

export function slotMemeCue(ctx) {
  const txt = String((ctx && ctx.lastText) || '').trim()
  if (txt === '') return ''
  try {
    const 黑话表 = 读取聊天黑话(ctx.target, ctx.memDir)
    if (Array.isArray(黑话表)) {
      for (const it of 黑话表.toReversed()) {
        const w = String(it?.词 || '').trim()
        if (w.length >= 2 && !/^\d+$/.test(w) && txt.includes(w)) {
          const ex = String(it?.例 || '').trim().slice(0, 24)
          const 义 = String(it?.义 || '').trim().slice(0, 60)
          // SLANG_WHO 2026-11-14（批次476）：外号「指的是谁」必须按 QQ 号**现查显示名**。
          // 原来把群名片写死在释义里 —— 他一改名她就认不出（主人原话「用不是真数的东西不行吧」）。
          // 号码只当查询键，**绝不进注入**（t421 I5 的红线）；查不到就直说查不到，不编一个名字。
          const 指 = String(it?.指 || '').trim()
          let 是谁 = ''
          if (指 !== '') {
            try {
              const f = ctx && typeof ctx.nameOf === 'function' ? ctx.nameOf : null
              if (f) 是谁 = String(f(指) || '').trim()
            } catch { 是谁 = '' }
          }
          // SLANG_HOW 2026-11-14（批次394）：梗知识并进黑话库后，每条多了一个「接」字段
          // （怎么顺着接下一句）。原来只有「义」——她知道「春日影是什么歌」，
          // 但不知道该怎么接那句玩笑。这一行把「接」也递给她。
          const 接 = String(it?.接 || '').trim().slice(0, 60)
          // SLANG_MEANING 2026-11-14（批次388）：原来这里不分青红皂白都说
          // 「群里的词……别当生词解释」—— 等于教她装懂。主人反复解释同一个梗她却记不住，
          // 根因就在这句：系统从来没给过释义，还让她别问。现在分两种：
          //   有释义 → 正常接话（她真懂了）
          //   没释义 → 明说她不知道，问不问由她定（判断权在她，但事实不能给错）
          if (义) {
            const 谁句 = 指 === '' ? '是' : (是谁 !== '' ? '指的是「' + 是谁 + '」' : '指聊天里的人，名字不确定')
            return '[本聊天黑话] 对方提到的「' + w + '」' + 谁句 + '：' + 义
              + (接 ? '。怎么接：' + 接 : '')
              + (ex ? '（群友常说：「' + ex + '」）' : '') + '。懂了就自然接话，别当百科念'
          }
          return '[本聊天黑话] 对方提到了「' + w + '」' + (ex ? '（用例：「' + ex + '」）' : '')
            + '，但你其实不知道它什么意思。想弄清楚就顺口问一句「这词啥意思啊」，别硬装懂'
        }
      }
    }
  } catch { /* 忽略 */ }
  // 2026-11-19：本聊天解释过的词优先，没学过才参考公共梗。
  const 公共梗 = 梗表.find((item) => item.re.test(txt))
  if (公共梗) return '[接梗] ' + 公共梗.hint + '——接不接、怎么接由你定。'
  return ''
}

/** 槽：最近刷到的群聊内容，只给主人私聊作素材，不改写成自己的经历。 */
export function slotGroupPeek(ctx) {
  if (!ctx?.isPrivate || ctx?.mute) return ''
  const now = 数(ctx.now, Date.now())
  const owner = String(ctx.ownerUin ?? '').trim()
  if (owner !== '' && String(ctx.peer ?? '') !== owner) return ''
  const data = 读档(join(ctx.memDir, '刷到的.json'))
  const items = Array.isArray(data?.条目) ? data.条目 : []
  const fresh = items.filter((x) => {
    const at = 时刻毫秒(x?.时)
    return at > 0 && at <= now + 60e3 && now - at <= 30 * 60e3 && String(x?.话 || '').trim() !== ''
  }).slice(-3)
  if (!fresh.length) return ''
  // SANITIZE 2026-11-14（批次463）：注入里不许出现裸号。
  // t421 的 I5 抓到这一个槽把陌生群友的号原样注入了：「promised：「@1942513544」」。
  // 定义放在函数体内，是因为 t353 会把这个函数**整段抽出来**在沙盒里跑（helpers 里没有外部常量）。
  const 去号 = (s) => String(s || '')
    .replace(/@\s*\d{5,12}/g, '@某人')
    .replace(/\b\d{8,12}\b/g, '（号码略）')
  const lines = fresh.map((x) => {
    const who = 去号(String(x.谁 || '群友').trim()).slice(0, 16)
    const words = 去号(String(x.话 || '').replace(/\s+/g, ' ').trim()).slice(0, 50)
    return who + '：「' + words + '」'
  })
  return '[群聊素材] 刚刷到的群友原话（不是你自己的经历）：' + lines.join('；')
    + '。想聊就当素材，不必逐条回应。'
}


/** 槽 14：B站与贴吧冲浪感悟（把 dsh-bili-humanism 的 human-world.md 与 dsh-tieba-dive 的 bar-styles.json 接进对话感知）。 */
export function slotSurfInsights(ctx) {
  if (ctx?.mute) return ''
  const parts = []
  try {
    const hwPath = (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/bili-humanism/human-world.md'
    if (existsSync(hwPath)) {
      const txt = readFileSync(hwPath, 'utf8')
      // DATE_CARRY 2026-11-12（批次367）：这段原本只取引述正文，把 `## 2026-11-10` 那行丢了。
      // 后果是两天前记下的感悟被她说成「最近刷到一条」——内容没错，时间错。
      // 现在按「引述前最近的那个日期标题」给它配日期。
      const 日期段 = [...txt.matchAll(/^##\s*(\d{4}-\d{2}-\d{2})\s*$/gm)].map((m) => ({ 日: m[1], 位置: m.index }))
      const 带日 = []
      for (const m of txt.matchAll(/^>\s*(.+)$/gm)) {
        const 话 = m[1].trim()
        if (话.length < 8) continue
        let 日 = ''
        for (const d of 日期段) if (d.位置 < m.index) 日 = d.日
        带日.push({ 日, 话 })
      }
      if (带日.length > 0) {
        const seed = Math.floor(数(ctx.now, Date.now()) / (10 * 60e3))
        const 中 = 带日[seed % 带日.length]
        const 标 = 中.日 ? 中.日.slice(5) + ' ' : ''
        // 截断优先落在标点上：断在半句（「…或者干脆承」）她复述时会顺着编完。
        let 引 = 中.话.slice(0, 90)
        if (引.length > 65) {
          const 断 = Math.max(引.lastIndexOf('。'), 引.lastIndexOf('；'), 引.lastIndexOf('，'), 引.lastIndexOf('、'))
          引 = 断 >= 30 ? 引.slice(0, 断 + 1) : 引.slice(0, 65)
        }
        parts.push(标 + '看B站攒下的：「' + 引 + '」')
      }
    }
  } catch (_err) { console.error('[onebot:voiceSlots]', _err?.message || _err) }
  try {
    const bsPath = (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/tieba-duty/bar-styles.json'
    if (existsSync(bsPath)) {
      const bs = JSON.parse(readFileSync(bsPath, 'utf8')) || {}
      const 样本们 = []
      for (const b of Object.values(bs)) {
        const 日 = String(b?.updatedAt || '').slice(5, 10)
        for (const s of (Array.isArray(b?.samples) ? b.samples : [])) {
          if (typeof s === 'string' && s.length >= 4 && s.length <= 45) 样本们.push({ 日, 话: s })
        }
      }
      if (样本们.length > 0) {
        const seed = Math.floor(数(ctx.now, Date.now()) / (10 * 60e3))
        const s1 = 样本们[seed % 样本们.length]
        parts.push((s1.日 ? s1.日 + ' ' : '') + '逛贴吧记下的真人短句味：「' + s1.话 + '」')
      }
    }
  } catch (_err) { console.error('[onebot:voiceSlots]', _err?.message || _err) }
  if (!parts.length) return ''
  // 口径写死在尾巴上：这些是攒的，不是今天刷的；被问就照实说，没看就说没看。
  // 2026-11-12 那次唯一的编造（「剩下全是刷小说」）就是从「没有这层口径」来的。
  // LOOKBACK_FIX 2026-11-14（批次438）：尾巴上原来指的是 bili_humanism_memory（查的是
  // 「AI 自己的理解 / 用户明确说的偏好」）和 tieba_diary_read（读日记）—— 两个都跟
  // 「我最近看了什么」无关，读不到任何观看记录。
  // 那两句是 11-12 她编「刷小说」被抓之后加的补丁，结果把「编造」换成了另一种错：
  // 明明昨天看过 7 个视频，照它去查只会得到一堆偏好和日记，最后说「没看」。
  // 真记录一直在这两处，之前没写进提示：记忆/视频画面/<BV号>.omni.json（at + text），
  // 记忆/刷到的.json（群里刷到的话）。她会用 bash（7 天 702 次），给路径就够。
  return '[冲浪养分] ' + parts.join('；')
    + '（这些只是素材，不是你今天刷的。被问到「你最近看了什么」，你有记录可查：'
    + '看过的视频在 记忆/视频画面/*.omni.json（at 是 UTC，加 8 小时是北京时间；text 是讲的什么），'
    + '群里刷到的在 记忆/刷到的.json。用 bash 翻一眼就知道，别凭印象编，也别看过说没看。'
    + '学那种活人接话的松弛劲，别照抄原句）'
}


/** 槽 15：网易云同号一起听歌（一起听歌.mjs → 记忆/一起听.json）。 */
export function slotMusicTogether(ctx) {
  if (ctx?.mute) return ''
  const owner = String(ctx.ownerUin ?? '').trim()
  if (owner !== '' && String(ctx.peer ?? '') !== owner && !ctx.isPrivate) return ''
  const omniCfg = 读档((process.env.DSH_HOME || '{{DSH_ROOT}}') + '/fish-omni.json')
  if (omniCfg?.一起听?.开启 === false) return ''
  const m = 读档(join(ctx.memDir || MEM_DEFAULT, '一起听.json'))
  if (!m || !m.ok || m.disabled || !m.name) return ''
  const now = 数(ctx.now, Date.now())
  const durMs = (Number(m.durationSec) || 240) * 1000
  const ageMs = m.playTime ? (now - Number(m.playTime)) : 999e6
  const ageMin = Math.max(0, Math.round(ageMs / 60000))
  const isPlayingWindow = ageMs >= -60000 && ageMs <= Math.min(12 * 60e3, Math.max(180e3, durMs + 75e3))
  if (isPlayingWindow) {
    const loopHint = Number(m.replayCount) >= 2 ? `，已经单曲重放第 ${m.replayCount} 遍了` : ''
    let line = `[一起听歌] 鱼片手机网易云刚点播了《${m.name}》${m.artist ? '（' + m.artist + '）' : ''}（${ageMin <= 1 ? '刚点开' : ageMin + '分钟前开始播'}${loopHint}；注：云端只同步切歌/重播时刻，看不到他中途是否按了暂停）`
    if (m.omniFeel) line += `｜你亲耳听到的旋律质感：${m.omniFeel}`
    if (m.lyrics && m.lyrics !== '（暂无歌词）') line += `｜歌词摘录：${m.lyrics}`
    if (m.hotComment) line += `｜热评：「${m.hotComment}」`
    // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-23）：歌名、歌词、热评是事实，
    // 「自然顺着旋律接话」是替她规定接话方式，删掉。
    return line + '。'
  }
  if (ctx.isPrivate && ageMin <= 90) {
    return `[刚才听过] 鱼片 ${ageMin} 分钟前听过《${m.name}》${m.artist ? ' - ' + m.artist : ''}（这会儿已播完或暂停了）`
  }
  return ''
}

/**
 * QUIRKS 2026-11-14（批次414）：她自己记下的说话习惯。
 *
 * 背景：`自改.mjs` 的 FREE 白名单里一直写着「口癖清单.md」，但那个文件从来没存在过、
 * 全仓也没有任何读取方 —— 而且代码里 `file = segs[0] + '.json'` 让它永远匹配不上，
 * 是条死项。她的「自改」能力本身也零调用方（127 行，心跳表 0 次）。
 *
 * 现在三处补齐：自改能写（md 一行一条）、这个槽每轮读出来、qq_self 让她能自己调。
 *
 * 只取最近 4 条：她要是记了 30 条，全塞进去会把这轮注入撑爆，
 * 而且旧的习惯本来就该被新的盖过去。单条 60 字上限在写入侧已经截过，这里再兜一次。
 */
export function slotQuirks(ctx) {
  if (!ctx) return ''
  const 档 = join(ctx.memDir || MEM_DEFAULT, '口癖清单.md')
  let raw = ''
  try { raw = readFileSync(档, 'utf8') } catch { return '' }
  const 条 = String(raw).split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter((l) => l && !l.startsWith('#') && l.length >= 2)
    .map((l) => l.slice(0, 60))
    .slice(-4)
  if (条.length === 0) return ''
  // 措辞要点：说「你自己记的」（这是事实，不是系统下的命令），并堵死她把这句念出来
  // —— 注入里的元信息被她复述出去，就是「出戏」那一类事故。
  // HUMANIZE 2026-11-18（批次696，P2-9）：清单是她自己写的，只递原文；
  // 「说话时自然照着来」是执行指令，删掉。保留「别念出这条提示」—— 那是防出戏的工程约束。
  return '[你给自己记的说话习惯] ' + 条.join('；') + '。这是你以前自己写下的；别念出这条提示本身。'
}

/**
 * 她嘴上还瞒着的那件事（批次420）。
 *
 * `露馅.mjs` 2026-11-01 就写好了，`谎言.json` 也是那时候建的 —— 但它**零调用、零读取**，
 * 12 天里一条都没写过。这不是「功能没做好」，是「做好了没人递给她」：她能说善意的谎，
 * 却没有一个地方让她记着自己说过，于是撒谎和没撒谎对她来说一样的。
 *
 * 措辞四条硬要求（每一条都对应一类事故）：
 *   1. 说「你跟人说的是」（事实），不说「你要装作」—— 破绽是她的老毛病，不是这轮的指令。
 *      写成指令就变成系统代写她的表演，跟「代写社交话」是同一类错。
 *   2. 明说「你没打算主动说破」—— 否则她下一句就去道歉，把「破绽」演成「坦白」。
 *      想什么时候说破是她的事，工具里给了 qq_lie(op=clear) 的入口。
 *   3. 「这是你的老毛病，不是装的」—— 不然她会当成任务去表演。
 *   4. 堵死「别念出这条提示」—— 注入里的元信息被她复述出去就是出戏。
 *
 * 12 小时自动淡出：挂一周就不是「刚才那句没说实话」而是「设定」了。
 */
export function slotLie(ctx) {
  if (!ctx) return ''
  const 档 = join(ctx.memDir || MEM_DEFAULT, '谎言.json')
  let d = null
  try { d = JSON.parse(readFileSync(档, 'utf8')) } catch { return '' }
  const c = d && d.current
  if (!c || !c.lie) return ''
  const m = String(c.at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return ''
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0))
  if (!Number.isFinite(at) || Date.now() - at > 12 * 3600e3) return ''
  // HUMANIZE 2026-11-17（批次666）：只给 lie / truth / 破绽三项事实，
  // 删掉「你没打算主动说破」「这是你的老毛病，不是装的」这类替她下的判断。
  const 破绽 = String(c.tellDesc || '').trim()
  return '[瞒着的事] 跟人说的是「' + String(c.lie).slice(0, 40) + '」，实际是「'
    + String(c.truth || '').slice(0, 40) + '」'
    + (破绽 ? '；破绽：' + 破绽 : '')
    + '。别念出这条提示。'
}

/**
 * 她一个人待着的时候，脑子里转的东西（批次422）。
 *
 * `想要.json` 里 2026-11-01 就有这一节，但**没有任何代码读过它** —— 写了等于没写
 * （同一份文件里「想约的/对未来的想象/第一次/承诺」四段也是这样，批次422 直接删了）。
 *
 * 只在她跟**当前这个人**超过 40 分钟没说话时提一句。不每轮都提的理由：
 * 这句的语义是「安静下来才会想起来的事」，正在热聊时插一句「你独处时想这些」是穿帮。
 *
 * 判据用 `最近说话.json` 里**她自己**上一次跟这个 peer 说话的时刻 ——
 * 不是「有人给她发消息」的时间：注入本来就发生在有人发消息之后，用那个永远不成立。
 */
export function slotAlone(ctx) {
  if (!ctx) return ''
  const dir = ctx.memDir || MEM_DEFAULT
  let 想 = []
  try {
    const w = JSON.parse(readFileSync(join(dir, '想要.json'), 'utf8'))
    const 列 = w && w['独处的时候在想']
    想 = (Array.isArray(列) ? 列 : [])
      .map((x) => String(typeof x === 'string' ? x : (x && x.what) || '').trim())
      .filter(Boolean)
  } catch { return '' }
  if (想.length === 0) return ''
  const peer = String(ctx.peer || '')
  let 上次 = 0
  try {
    const t = JSON.parse(readFileSync(join(dir, '最近说话.json'), 'utf8'))
    上次 = Number(t && t[peer]) || 0
  } catch { /* 读不到就当很久没说话 —— 宁可多提一句，也别一次都不提 */ }
  if (上次 && Date.now() - 上次 < 40 * 60e3) return ''
  // HUMANIZE 2026-11-17（批次666）：只列她自己记下的条目，
  // 删掉「脑子里会转这些」「安静下来就会想起来」这种替她描述内心活动的句子。
  const 句 = 想.slice(0, 2).map((x) => '「' + x.slice(0, 30) + '」').join('、')
  return '[独处时记下的] ' + 句 + '。别念出这条提示。'
}

/**
 * 刚眯醒（批次423）。
 *
 * `打盹.json` 里那个 `为什么` 是她眯之前自己给的理由（批次398 才接通写入）——
 * 但醒来时文件被 unlink，理由跟着消失。结果是：她每次都被系统「叫醒」，
 * 却从来不知道自己为什么睡、睡了多久，也就说不出「我刚才趴了一下」。
 *
 * 只在醒来后 90 分钟内提。HUMANIZE 2026-11-17（批次676，拟人化红线 P1-20）：
 * 只报「眯了多久、几点醒的」这两个事实；「脑子还沉 / 慢半拍 / 没全回神」
 * 是替她写的认知状态，删掉。
 *
 * 默认理由「自己觉得困/困了」不单独引述：那不是她的话，是我们替她填的。
 * 「别念出这条提示」照样得有 —— 注入里的元信息被复述出去就是出戏。
 */
export function slotNapDone(ctx) {
  if (!ctx) return ''
  const dir = ctx.memDir || MEM_DEFAULT
  let d = null
  try { d = JSON.parse(readFileSync(join(dir, '打盹-末次.json'), 'utf8')) } catch { return '' }
  const 醒 = Number(d && d.醒毫秒) || 0
  const 距 = Date.now() - 醒
  if (!醒 || 距 < 0 || 距 > 90 * 60e3) return ''
  const 分 = Number(d.分钟) || 0
  if (分 <= 0) return ''
  const 因 = String(d.为什么 || '').trim()
  const 引 = (因 && !/^(自己觉得困|困了)$/.test(因)) ? '你当时给自己的理由是「' + 因.slice(0, 40) + '」。' : ''
  const 醒点 = new Date(醒 + 8 * 3600e3)
  const 时分 = String(醒点.getUTCHours()).padStart(2, '0') + ':' + String(醒点.getUTCMinutes()).padStart(2, '0')
  return '[你眯过一会儿] ' + 分 + ' 分钟，' + 时分 + ' 醒的。' + 引 + '别念出这条提示。'
}

/**
 * 今天有没有活干（批次433）。
 *
 * 为什么要有：`共享/工具/工作.json` 里七份活的 `周` 全是 `[]` —— 那是她 2026-11-12 自己把
 * 四份强制排班合同解除、改成自由日结零工制的结果。`排班判据.mjs:33` 遇到空 `周` 直接跳过，
 * 于是心跳每分钟跑一次 `工作.mjs --tick`，一次班都排不出来，`记忆/工作.json` 的班次停在 11-11。
 * 而唯一能开单的入口 `qq_work` 七天 0 次（`工具用量.json`）。她不是不想干，
 * 是「今天没班、手边有零活」这个事实从来没出现在她眼前。
 *
 * 五道闸，全过才出声：只私聊 / 白天 9-21 点 / 今天没有班次 / 不在岗 / 不在睡态。
 * 少一道就会变成每轮念一遍的 KPI 噪音。
 *
 * 三条措辞红线：
 *   1. 只递事实 + 「想去就去，不去不欠谁」，不写「你该去挣点钱」—— 替她做决定就是代写。
 *   2. 不许有分钟数/随机数：注入走 stateVoice 的 10 分钟桶，内容一变就击穿 prefix cache（批次279）。
 *   3. 价目表读不到就只说「有零活」，不硬编名字 —— 编出来的名字她真去调会失败。
 */
export function slotWorkBoard(ctx) {
  if (!ctx || ctx.mute) return ''
  if (!ctx.isPrivate) return '' // 群里说「有零活」会被当成对群友说的
  const now = 数(ctx.now, Date.now())
  const 时 = new Date(now + 8 * 3600e3).getUTCHours()
  if (时 < 9 || 时 >= 21) return '' // 半夜提日结零工，等于催一个该睡的人去打工
  const dir = ctx.memDir || MEM_DEFAULT
  const 工 = 读档(join(dir, '工作.json')) || {}
  const 班次 = Array.isArray(工.班次) ? 工.班次 : []
  if (班次.some((b) => b && String(b.状态 || '') === '在岗')) return '' // 正在上班，这句只会跟「在干什么」打架
  const 今天 = 今天北京(now)
  if (班次.some((b) => b && String(b.起 || '').startsWith(今天))) return '' // 今天本来就有班，该说的是几点去
  const 自主 = 读档(join(dir, '自主.json')) || {}
  if (String(自主.state || '') === '睡觉') return ''
  let 份 = []
  try {
    const 配 = 读档(join(ctx.toolsDir || `${QQ_WS}/共享/工具`, '工作.json')) || {}
    for (const [名, c] of Object.entries(配.活 || {})) {
      const 薪 = Number(c && c.时薪)
      if (!(薪 > 0)) continue
      const 分钟 = Number(c.时长分钟) || 120
      份.push(名 + ' ' + Math.round(分钟 / 6) / 10 + ' 小时 ' + 薪 + '/时')
    }
  } catch { /* 配置坏了就退化成不带价目的一句 */ }
  const 引 = 份.length
    ? '（' + 份.slice(0, 2).join('、') + (份.length > 2 ? ' 等 ' + 份.length + ' 份' : '') + '）'
    : ''
  return '[手边的活] 今天没排班。手边有日结的零活' + 引 + '，想去就去，不去也不欠谁的，累了随时能走。'
}

export const VOICE_SLOTS = [
  slotHomeZone,
  slotCleanliness,
  slotBodyTemp,
  slotWarmGap,
  slotScreenPeek,
  slotJustWatched,
  slotRelationBond,
  slotRecall,
  slotClash,
  slotDreamAftertaste,
  slotBoard,
  slotPlayfulness,
  slotSelfReview,
  slotMemeCue,
  slotDailyPlan,
  slotWorkBoard, // WORK_BOARD 2026-11-14（批次433）：今天没排班时让她知道手边有零活
  slotGroupPeek,
  slotSurfInsights,
  slotMusicTogether,
  slotQuirks,
  slotLie,
  slotAlone,
  slotNapDone,
]

/**
 * 汇总所有体感槽。每槽独立 try/catch；mute（工程模式/主动搭话误用）直接空。
 * memDir 可注入沙盒（单测），默认线上记忆目录。
 */
export function extraSlotsHint(ctx) {
  const c = ctx || {}
  if (c.mute) return ''
  const 撞 = {
    peer: String(c.peer ?? ''),
    ownerUin: String(c.ownerUin ?? ''),
    screenPath: c.screenPath ? String(c.screenPath) : '',
    videoDir: c.videoDir ? String(c.videoDir) : '',
    readdirSync: typeof c.readdirSync === 'function' ? c.readdirSync : undefined,
    readFileSync: typeof c.readFileSync === 'function' ? c.readFileSync : undefined,
    statSync: typeof c.statSync === 'function' ? c.statSync : undefined,
    listCustomFaces: typeof c.listCustomFaces === 'function' ? c.listCustomFaces : undefined,
    isPrivate: Boolean(c.isPrivate),
    mute: Boolean(c.mute),
    memDir: String(c.memDir || MEM_DEFAULT),
    // WORK_BOARD：零活价目表在 共享/工具/工作.json —— 不传就只能写死绝对路径，单测造不出沙盒
    toolsDir: String(c.toolsDir || `${QQ_WS}/共享/工具`),
    now: Number(c.now || Date.now()),
    lastText: String(c.lastText ?? ''),
    // 单测注入用；线上不传就是默认路径
    file: c.file ? String(c.file) : '',
  }
  const out = []
  for (const 槽 of VOICE_SLOTS) {
    try {
      const s = String(槽(撞) || '').trim()
      if (s !== '') out.push(s)
    } catch { /* 单槽出错只丢自己 */ }
  }
  return out.join('\n')
}
