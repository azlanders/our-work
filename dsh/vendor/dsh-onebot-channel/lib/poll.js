/** THRESH_PARAM 2026-11-02：拟人阈值的默认值都从参数表「拟人」段取，这里只留 fallback
 * 
 * poll.js —— 消息处理 + 私聊/群聊轮询循环 + WS 事件入口。
 *
 * 两条入站通路：
 *   1. HTTP 轮询（老路）：每 pollMs 拉一次历史，兜底、防漏；
 *   2. WS 事件推送（新路）：OneBot 推来即处理，延迟接近 0。
 * 两条路共用同一批 handle* 函数，所以行为一致；区别只在「一批还是一条」：
 *   - 轮询：一次拉到的多条私聊**合并**成一条投递（离线久了别被连问三遍）；
 *   - WS：一条消息一条投递（实时）。
 * 重复投递由 seenIds（message_id 相等）+ seq 游标双重拦截。
 *
 * 循环用「跑完再排下一次」自调度：既能在每轮重读配置（设置页改完立刻生效），
 * 又天然防重入 —— SnowLuma 的历史接口一旦卡住（实测会挂死十几秒甚至更久），
 * 用 setInterval 会让请求层层堆上去把协议端彻底压垮。

 * ── 段落索引（找哪段直接搜函数名，不写行号免得每次改动都过期）──
 *
 * 入口
 *   handlePrivateMessages()   私聊入口：取消词、静默、合并窗口、投递
 *   handleGroupMessage()      群聊入口：@ 判定、上下文拼装、让位
 *   handleWsEvent()           WS 实时事件入口
 *   normalizeEvent()          WS 事件 → 统一成 HTTP 那边的形状
 *
 * 两个轮询循环
 *   startPrivateLoop() / startGroupLoop()   各自 schedule，别再开一条并行的
 *
 * 已读与游标（最容易出「静默丢消息」的地方）
 *   isSeen() / markSeen() / unmarkSeen() / rollbackSeen() / markHandled()
 *
 * 拼装给模型看的东西
 *   拼正文()      主入口，参数 p 里那一串 hint 就是她的「现场感」
 *   voiceHintOf() 语气提示
 *   isPushback() / groupNeedsReply()   该不该回的判据（后者导出给评测用）
 *
 * 其他
 *   configuredPrivates() / configuredGroups()  配置里的私聊/群列表（routes 与 groupUins 双写历史坑）
 *   refreshNicknames() / nicknameOf()          昵称缓存（查不到时懒加载，10 分钟节流）
 *   pushToBuffer() / groupBuffer()             群消息缓冲

 */
// POLL_MEM 2026-11-14（批次427）：这个文件 4500 行、69 处记忆路径 + 9 处共享路径全是字面量，
// 一个沙盒变量都没有 —— 想单测注入逻辑就只能读她真档，于是「测过」和「没测过」看起来一样。
// 现在三根根路径都认环境变量（名字跟 地点.mjs / 表.mjs 一致，别再造新的）：
//   QQ_MEM   记忆目录      QQ_TOOLS 共享/工具     QQ_SHARED 共享
// 注意：跟 地点.mjs 一样是**模块顶层求值** —— 测试必须在 import 之前设 env，之后设已经晚了。
// 第 43/44 行那两个静态 import 的说明符**必须保持字面量**（ESM 规定），别顺手改成模板字符串。
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
const MEM = process.env.QQ_MEM || `${QQ_WS}/记忆`
const TOOLS = process.env.QQ_TOOLS || `${QQ_WS}/共享/工具`
const SHARED = process.env.QQ_SHARED || `${QQ_WS}/共享`

import { getConfig } from './config.js'
// SHOT_LIST 2026-11-16（批次549）：`一次性动作` 清单的**唯一一份**在 在干嘛.mjs。
// 这里原来手写了一份 10 个词的（只有 逛贴吧/看B站/学点东西/拍张照/吃点东西/买东西/打工/走动/翻旧账/打瞌睡），
// 缺 喝点水 / 躺着 / 打零工 / 去医院 / 去药店 / 买瓶水 —— 而「喝点水」是她全量 33 条 log 里第 2 高频的
// （8 次，仅次于打瞌睡 15 次）。
// 后果：她每喝完一次水，这段就会跟她说「你自己这会儿在『喝点水』，已经 N 分钟」，
// 于是别人问「在忙什么」她答「在喝水」—— 可她一分钟前就喝完了。跟 活动/状态推进 那个 doneAt
// bug（批次538/539）是同一件事的第三处。
// CWD_ROOT 2026-11-24：这些 import 原来写 (process.env.QQ_WORKSPACE || process.cwd())，
// 自检站在 共享/工具 里跑时 cwd 不是工作区根，会拼成 .../共享/工具/共享/工具。统一用 QQ_WS。
const { 可顺嘴问 } = await import(`${QQ_WS}/共享/工具/惦记.mjs`)
const { 是旧黑话链 } = await import(`${QQ_WS}/共享/工具/黑话.mjs`)
const { 一次性动作, 吃喝动词 } = await import(`${QQ_WS}/共享/工具/在干嘛.mjs`)
// WAKE_GRUMP 2026-11-16（批次567）：起床气话 是纯函数，判据在 睡态.mjs（只吐事实，不替她说话）
const { 起床气话, 熬夜话 } = await import(`${QQ_WS}/共享/工具/睡态.mjs`)
const { 改档: 改瞬间档 } = await import(`${QQ_WS}/共享/工具/_底层.mjs`)
import { extraSlotsHint } from './voiceSlots.js'
// TIER_ONE_TRUTH 2026-11-17（批次659，审计 P1-3）：关系档位只认 关系档.mjs。
// 这里原来按 score/fam 自己判一套「自己人/半熟/生人」和「关系浓度」，
// 和 voiceSlots 的 [关系] 槽可以给出两个说法。
const { 关系档 } = await import(`${QQ_WS}/共享/工具/关系档.mjs`)
import { QQ记忆批次, 生活记忆条 } from './记忆入口.mjs'
import { 标记QQ私聊入站 } from './记忆核心.mjs'
// PEOPLE_KEY 2026-11-17（批次605）：戳一戳要读「戳你的人」的别扭/怨，不能取 people 第一条。
import { personRecordOf } from './target.js'
import { ACTIVE_PEER_FILE } from './active-peer.js'

export function 更新已说瞬间(file, selection, now = Date.now()) {
  if (!file || !selection?.what || !selection?.at) return false
  try {
    const result = 改瞬间档(file, (data) => {
      const items = Array.isArray(data.items) ? data.items : []
      const matches = items.filter((entry) => String(entry?.at || '') === String(selection.at) && String(entry?.what || '') === String(selection.what))
      if (matches.length !== 1) return false
      matches[0].lastSaid = now
      data.items = items
    }, { items: [] })
    return result !== null
  } catch { return false }
}
// HUNGER 2026-11-06（批次139）：肚子。
// 为什么走绝对路径动态 import，而不是像 感受.mjs 那样复制一份进 lib：
//   副本会各自演化 —— 饥饿的衰减/意向规则必须只有一份，否则面板、注入、自主行动
//   三个地方会算出三个不同的「饱腹」。
// 加载失败只是少一行提示，不能影响机器人起来。
const 饥饿 = await import(`file://${TOOLS}/饥饿.mjs`).catch(() => null)
const 疾病 = await import(`file://${TOOLS}/疾病.mjs`).catch(() => null)
// FS_CACHE 2026-11-03：同一轮里多次读同一文件时走 mtime 缓存，减少同步 I/O（不改任何注入内容）
const __fsCache = new Map()
let __fsHit = 0
let __fsMiss = 0
function 快读Text(路径) { // FS_CACHE_TEXT 2026-11-03：文本文件也走 mtime 缓存
  try {
    const st = statSync(路径)
    const hit = __fsCache.get('t:' + 路径)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data
    const data = readFileSync(路径, 'utf8')
    __fsCache.set('t:' + 路径, { mtimeMs: st.mtimeMs, size: st.size, data })
    return data
  } catch {
    return ''
  }
}

// 快读Json：带 mtime+size 缓存的 JSON 读取。
// 2026-11-05 修过一个致命错误：缓存未命中那行原来写的是 `const data = 快读Json(路径)`，
// 即函数自己调自己，且没有任何终止条件 —— 必然栈溢出，被 catch 吞掉后返回 {}。
// 因为所有调用方都写了 `?? 默认值`，所以不报错、日志无痕，20 处状态读取静默失效。
export function 快读Json(路径) {
  try {
    const st = statSync(路径)
    const hit = __fsCache.get(路径)
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) {
      __fsHit += 1
      if ((__fsHit + __fsMiss) % 200 === 0) note('fscache', '命中 ' + __fsHit + ' / 未命中 ' + __fsMiss)
      return hit.data
    }
    const data = JSON.parse(readFileSync(路径, 'utf8')) // 2026-11-05 修：这里原来写成 快读Json(路径)，自己调自己，永远栈溢出返回 {}
    __fsMiss += 1
    __fsCache.set(路径, { mtimeMs: st.mtimeMs, size: st.size, data })
    return data
  } catch {
    return {}
  }
}

import { clearFollowup } from './followup.js'
// FEELING_LEDGER 2026-11-05：删掉了「正则替她判断被骂/被夸」那套（实测 6624 条真实群聊里
// 47 条「被骂」绝大多数是「回滚/滚动/滚木」误报）。现在判断权在她自己的 qq_feel 上。
import { recallLineSync } from './碎片召回.mjs' // FLASHBACK_HOOK 2026-11-03
import { topicLine } from './碎片话题.mjs' // FLASHBACK_TOPIC 2026-11-03（话题触发的闪回）
// BREATHE_OFF 2026-11-03：抢答整套停用（主人定的门槛是「垫的那句必须带信息」，固定句做不到）。
// 批次610：breathe.js 已删除（没有任何 arm 调用，outbound 里的 cancelFiller 也无人可撤）。
import { recentSaidBlock, 刚说过段 } from './recent-say.js'
// LIKE_SYSTEM 2026-11-05：贴表情（表情回应）成了一个独立动作，不再是「说话的简化版」。
// 收发两侧都在 贴表情.mjs 里，理由和三条硬规矩见那个文件顶部。
import { recordLike, likeHintOf, readCursor, writeCursor, rememberIncoming } from './贴表情.mjs'
import { note, bjHour, bjDayKey, bjDate } from './env.js'
// RECALL_SENSE 2026-11-09（批次341）：撤回感知。实测 qq-events.jsonl 里 20 条
// group_recall + 1 条 friend_recall，原来只落盘、她一条都不知道。
import { 记撤回 } from './撤回感知.mjs'
import { muteFor, clearMute, isMuted } from './mute.js'

// 2026-11-01 肥鱼：戳一戳限流——同一个人 5 分钟内只叫醒一次，别被戳到烦。
// 2026-11-02：5 分钟太长，感知不到「连着戳」；改 25 秒。
// 2026-11-02 SAME_TEXT_GUARD：同群同人同文本 8 秒内只投一次
const SAME_TEXT_WINDOW_MS = 8 * 1000
const sameTextAt = new Map()
// 2026-11-09 批次352：从 handleGroupMessage 提到模块级 —— 筛批判据也要用同一份名单，
// 抄一遍就会分叉（348 那次的教训）。
// OWN_GROUPS_CFG 2026-11-24：这里原来写死 `['806972995','983903493']` ——
// 本机配置的 groupUins 恰好也是这两个，所以一直在「碰巧能跑」。
// 换 bot / 换群之后判据会把**自家群当外群**，她从此在自家群不吭声，且不报错。
// 现在配置优先（qq-bridge.config.json 的 groupUins），读不到才回落这两个历史值。
// 注意：这里必须是**惰性**取值 —— 模块加载时 config 可能还没就绪。
function 主群名单() {
  try {
    const g = getConfig()?.groupUins
    if (Array.isArray(g) && g.length) return new Set(g.map(String))
  } catch { /* 配置读不到就回落 */ }
  return new Set(['806972995', '983903493'])
}
const OWN_GROUPS = 主群名单()
const POKE_COOLDOWN_MS = 25 * 1000
const POKE_WINDOW_MS = 10 * 60 * 1000
const pokeStreak = new Map()
const lastPokeAt = new Map()

import { buildImageBlocks } from './images.js'
// FILE_IN 2026-11-05（批次90）：文件段不再只翻成「[文件]」——取下来，文本就投进去。
import { buildFileBlocks } from './files.js'
// PHONE_GATE 2026-11-05（批次95）：她闲着才偶尔看手机；在做事就得 @ 才叫得出来。
import { 看手机, 记回话, 是持续对话 } from './phone.mjs'
// PHOTO_HINT 2026-11-06（批次109）：相册那句话和「刚按过快门」的判据都从 photo.js 取，
// 免得注入里再写一份 90 秒冷却、跟工具里的对不上。
import { 相册提示, 快门刚按过 } from './photo.js'

// WAKE_ON_PRIVATE 2026-11-06（批次110）：私聊里主人找她 = 叫醒她。
//
// 群里一直有 @ 叫醒（WAKE_ON_AT），私聊这条路漏了。她其实会回话
// （私聊不判睡眠窗），但 睡醒.json 还是 true —— 面板写着「在睡」、
// QQ 状态挂着「在便利店睡着了」。主人 00:39 / 00:42 各发一条，
// 她各回一条，状态一直没醒。
//
// 只认主人：别人私聊不该有把她叫醒的权力。
// 60 秒只叫一次：主人连发三条会撞三次，而第二次 endSleep 已经是空的。
let __lastWakeSpawn = 0

/**
 * 这条私聊该不该触发叫醒？
 * 纯判断，不读文件不 spawn —— 测试能直接把四种情况都摆出来。
 */
export function 主人私聊要叫醒(config, uin, flag, now = Date.now(), lastAt = 0) {
  const owner = String(config?.ownerUin ?? '')
  if (owner === '') return false
  if (String(uin ?? '') !== owner) return false
  if (!flag || flag.sleeping !== true) return false
  return now - Number(lastAt || 0) > 60e3
}
import { callOneBot, isAtMe, qqTimeMs, seqOf, textOf, timeOf } from './onebot.js'
import { targetKeyOf } from './outbound.js'

import { isConnectionError } from './health.js'
import { deliver, pickSessionId, prefixOf, 组装私聊内容块 } from './deliver.js'
import { getState, saveState } from './state.js'
import { isWsConnected } from './ws.js'
// 2026-11-01 肥鱼：日常模式要「活着」，就得知道此刻是什么状态——读状态文件拼一行提示。
// OCAI 2026-11-02：补齐 node:fs 的 ESM 导入（readFileSync/writeFileSync 及 fs 别名），替换原文件中会抛错的 require 与未定义变量
import * as fs from 'node:fs'
import { existsSync, readFileSync, readFileSync as readStateFile, writeFileSync, appendFileSync } from 'node:fs'
import { execFile, execFileSync } from 'node:child_process' // HORMONE_EVENT 2026-11-05：对话情绪喂回激素
import { statSync } from 'node:fs'

// LAST_SEEN 2026-11-05（批次101）：冷落判据要的是「他上一次开口是什么时候」。
// `好感度.last` 只在她自己记账（--say/--dim/感受）时才写，主人那条甚至没有这个字段 ——
// 于是「被冷落」对主人永远不触发，而他是唯一天天说话的人。
// 这里每条入站消息记一笔，只 poll 这一个进程写，不跟 好感度.mjs 抢同一个文件。
const LAST_SEEN_FILE = `${MEM}/最近说话.json`
let lastSeenCache = null
// INTERACT 2026-11-08（批次246）：主人没有私聊日志 —— 「他今天说了几句」这个数原来根本没记，
// 好感度日结只读一个群的日志，于是主人永远停在兜底档（半熟）。这里给私聊每条入站消息记一笔当天计数。
// 只记私聊：群聊那边有 群聊日志/ 按群落盘，日结自己会读，重复记会把分数灌高。
const INTERACT_FILE = `${MEM}/互动.json`
function 记一次互动(uin) {
  const id = String(uin || '')
  if (id === '') return
  const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  let db = null
  try { db = JSON.parse(fs.readFileSync(INTERACT_FILE, 'utf8')) } catch { db = {} }
  if (!db || typeof db !== 'object' || Array.isArray(db)) db = {}
  const 人 = (db[id] && typeof db[id] === 'object' && !Array.isArray(db[id])) ? db[id] : {}
  人[d] = (Number(人[d]) || 0) + 1
  const 新 = {}
  for (const k of Object.keys(人).sort().slice(-7)) 新[k] = 人[k]  // 只留最近 7 天
  db[id] = 新
  const ids = Object.keys(db)
  if (ids.length > 40) {  // 最多 40 个人，砍最久没来的
    ids.sort((a, b) => Math.max(...Object.keys(db[a] || { 0: 0 }).map(Number)) - Math.max(...Object.keys(db[b] || { 0: 0 }).map(Number)))
    for (const k of ids.slice(0, ids.length - 40)) delete db[k]
  }
  fs.writeFileSync(INTERACT_FILE, JSON.stringify(db))
}

function touchLastSeen(uin) {
  const id = String(uin || '')
  if (id === '') return
  try {
    if (!lastSeenCache) {
      try { lastSeenCache = JSON.parse(fs.readFileSync(LAST_SEEN_FILE, 'utf8')) || {} } catch { lastSeenCache = {} }
    }
    lastSeenCache[id] = Date.now()
    const keys = Object.keys(lastSeenCache)
    if (keys.length > 80) {
      keys.sort((a, b) => Number(lastSeenCache[a]) - Number(lastSeenCache[b]))
      for (const k of keys.slice(0, keys.length - 80)) delete lastSeenCache[k]
    }
    fs.writeFileSync(LAST_SEEN_FILE, JSON.stringify(lastSeenCache))
  } catch { /* 记不上不影响收消息 */ }
}

// 2026-11-01 肥鱼：状态文件缓存。每条消息要读状态/好感度/别扭/睡眠四个文件，
// 全都读盘太浪费；按「修改时间 + 3 秒 TTL」缓存，文件没变就直接用内存里的。
// 这样既不会每条都读盘，也不会因为她改了状态而要等很久才生效。
const stateCache = new Map()
function cachedStateRead(file, enc) {
  try {
    const mtime = statSync(file).mtimeMs
    const hit = stateCache.get(file)
    if (hit && hit.mtime === mtime && Date.now() - hit.at < 3000) return hit.text
    const text = readStateFile(file, enc || 'utf8')
    stateCache.set(file, { mtime, at: Date.now(), text })
    return text
  } catch {
    // OCAI 2026-11-02：空 catch 补注释——statSync 失败时退回直接读文件
    return readStateFile(file, enc || 'utf8')
  }
}

// === [A] 底子：这个函数负责拼每回合那一行状态 ===

/** 中文时刻 2026-11-08（批次227）：把 24 小时制的 00:01 念成「零点零一分」。
 *  起因：她在 00:01 对主人说「都一点了」，把 00:01 的分钟读成了小时。
 *  光给 HH:MM 不够，得再给一遍中文读法，并把规则钉死。 */
export function 中文时刻(h, m) {
  const 数 = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九']
  const 十 = ['', '十', '二十', '三十', '四十', '五十']
  const 读 = (n) => {
    const x = Math.max(0, Math.min(59, Number(n) || 0))
    if (x === 0) return '零'
    if (x < 10) return 数[x]
    if (x === 10) return '十'
    if (x < 20) return '十' + 数[x % 10]
    return 十[Math.floor(x / 10)] + (x % 10 ? 数[x % 10] : '')
  }
  return 读(h) + '点' + (Number(m) === 0 ? '整' : 读(m) + '分')
}

// SLEEP_FACTS 2026-11-03：把「她真实的作息」当事实塞进去，省得她没睡硬编「我趴过一觉」
export function sleepFactsOf() {
  try {
    const bj = bjDate()
    const hm = String(bj.getUTCHours()).padStart(2, '0') + ':' + String(bj.getUTCMinutes()).padStart(2, '0')
    const p = `${MEM}/睡醒.json`
    const sleepP = `${MEM}/睡眠.json`
    let flag = null, seg = null
    try { flag = 快读Json(p) } catch { /* 没文件 */ }
    try {
      const sj = 快读Json(sleepP)
      const open = (sj.segments || []).filter((x) => !x.end)
      seg = open[open.length - 1] || (sj.segments || [])[(sj.segments || []).length - 1] || null
    } catch { /* 没文件 */ }
    // TIME_READ 2026-11-08（批次227）：24 小时制 + 中文读法一起给，免得她把 00:01 念成「一点」。
    const bits = ['现在是 ' + hm + '（北京时间，24 小时制；' + 中文时刻(bj.getUTCHours(), bj.getUTCMinutes()) + '）']

    // SLEEP_WAKE_HINT 2026-11-14（批次448）：只报「你正在睡着」不够 ——
    // qq_sleep 的「醒」是她唯一能自己结束一觉的入口，而工具描述里从来没提过它。
    // 这里只递能力，不说「你该起来」（起不起来还是她定）。
    if (flag && flag.sleeping === true) bits.push('你正在睡着（想结束这一觉就用 qq_sleep 的「醒」，不用等人叫）')
    else if (flag && flag.sleeping === false && flag.since) bits.push('你从 ' + flag.since + ' 起一直醒着')
    else bits.push('作息记录里没有你最近的睡觉记录')
    // NAP_FACT 2026-11-17（批次684）：打盹和整觉是两份记录，原来这里只念 睡醒.json ——
    // 19:47 她调「眯 45」，回执「20:32 醒」，4 秒内就发出「睡了一下，八点半才醒」。
    // 事实里补一条正在打盹，醒的时刻标「还没到」，让她下一条消息有据可依。
    if (!(flag && flag.sleeping === true)) {
      try {
        const nap = 快读Json(`${MEM}/打盹.json`)
        if (Number(nap['到毫秒'] || 0) > Date.now()) {
          bits.push('你在打盹：' + String(nap['开始'] || '').slice(11) + ' 开始，'
            + String(nap['到'] || '').slice(11) + ' 才醒（还没到）')
        }
      } catch { /* 没在打盹 */ }
    }
    if (seg && seg.start) bits.push('最近一觉：' + seg.start + (seg.end ? ' 到 ' + seg.end : ' 还没醒'))
    else bits.push('今天没有睡过觉的记录')
    // HUMANIZE 2026-11-18（批次696，P2-1）：事实本身合规，「照这个说 / 别自己编 / 只照这个念」
    // 是话术规定，删掉。时区换算留成一句事实说明（00:xx 是零点），不写成命令。
    return '（真实作息：' + bits.join('；') + '。以上是记录。'
      + '钟点按 24 小时制记：00:xx 是零点，01:00 才是一点。）\n'
  } catch {
    return ''
  }
}


// POKE_UNIQ_ID 2026-11-03：同一秒连戳两下，event.time 一样 → 会被当重复消息吞掉；换成毫秒 + 自增
let __pokeSeq = 0
function POKE_UNIQ_ID() { __pokeSeq = (__pokeSeq + 1) % 1000; return Date.now() * 1000 + __pokeSeq }


// VOICE_HINT 2026-11-03：把「累/困/别扭」翻成怎么说，而不是只算说不说
// ITEM_HINT 2026-11-05（批次75）：伞在哪儿、借的什么时候还。
// 没有这段，她只知道「人在便利店」，不知道自己淋不淋得回去，
// 也不知道包里那把伞是跟人家借的、押金还在人家手里。
// 只说她当时能感知的事：手边有没有、外面下不下雨、欠着谁的东西。
export function 物件提示(物品档, 天气档, 位置) {
  try {
    const items = Array.isArray(物品档 && 物品档.items) ? 物品档.items : []
    const 雨 = /雨/.test(String((天气档 || {}).天气 || ''))
    const 位 = String(位置 || '')
    const 手上有 = (n) => items.some((x) => x.n === n && x.在 === '包')
    const 家里有 = (n) => items.some((x) => x.n === n && x.在 === '家')
    const 借的 = items.filter((x) => x.来 === '借' && x.该还)
    const 现在 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    const out = []

    // ① 借的东西该还了（押金压着，比什么都实在）
    for (const x of 借的) {
      const 到期 = String(x.该还)
      if (现在 >= 到期) {
        out.push(`你借的那把${x.n}已经过点了（${x.自}，${到期.slice(5)} 就该还），押金 ${x.押金 || 0} 块还在人家那儿。要还回${x.自}，别的地方还不了`)
      } else {
        out.push(`你手上这把${x.n}是跟${x.自}借的，${到期.slice(5)} 前得还回去（押金 ${x.押金 || 0} 块会退）`)
      }
    }

    // ② 下雨却用不上伞
    if (雨 && 位 !== '家') {
      if (!手上有('雨伞')) {
        if (家里有('雨伞')) {
          out.push('外面在下雨，你的伞放在家里，人在' + 位 + '——现在调不回来，只能淋着或者想办法借一把')
        } else {
          out.push('外面在下雨，你手上没伞。便利店和超市都能借（押 10 块，回头还回去押金退），也能买一把')
        }
      } else {
        out.push('外面在下雨，你包里有伞，撑得开')
      }
    }

    // FOOD_HINT 2026-11-06（批次144）：家里存着什么，得让她自己知道。
    // 她买了薯片、牛奶放进家，然后就忘了 —— 饿的时候只会想到楼下便利店。
    // 只列吃的喝的（带份数），台灯书桌不念。
    const 名份 = (x) => String(x.n) + (Number(x.数) > 1 ? '×' + Number(x.数) : '')
    const 是吃喝 = (x) => ['吃', '喝', '零食'].includes(String(x.类 || ''))
    const 家里吃 = items.filter((x) => x.在 === '家' && 是吃喝(x))
    if (家里吃.length) {
      out.push('家里存着' + 家里吃.slice(0, 6).map(名份).join('、')
        + '（在家饿了可以拿一份吃，不用再跑一趟）')
    }
    const 包吃 = items.filter((x) => x.在 === '包' && 是吃喝(x))
    if (包吃.length) {
      out.push('包里带着' + 包吃.slice(0, 6).map(名份).join('、') + '（想吃可以吃）')
    }
    return out.join('；')
  } catch (e) { return '' }
}

// ── 地点功能提示（批次79）───────────────────────────────
// 原来她手上只有「人在便利店」这一句。这个点开不开、这儿能干什么，系统从来没说过。
// 于是会在闭馆的日子说「我在图书馆看书」，在便利店说「我在这儿泡了个澡」。
//
// 为什么不直接 import 共享/工具/地点.mjs：
//   stateHintOf 是同步函数（每轮对话都要拼一遍），import 是异步的；
//   每分钟为她起一个进程去问地点也不划算。
//   这里只取三件事：开着吗、能做什么、室内还是室外。
//   **完整的营业时间/适合度逻辑在 地点.mjs，那边是权威，改规则两处都要动。**
const _地点档 = { at: 0, 图: null }
function 读地图表() {
  if (Date.now() - _地点档.at < 60e3 && _地点档.图) return _地点档.图
  const 图 = 快读Json(`${TOOLS}/地图.json`)
  _地点档.at = Date.now()
  _地点档.图 = (图 && 图.地点) || {}
  return _地点档.图
}

// ── 窗外什么天（批次79）─────────────────────────────
// 原来这里什么都没有。天气只出现在两个地方：伞的提示、拍照的上下文。
// 日常问她「外面冷不冷」「明天要不要带伞」，她手上是空的。
//
// 只写她真的能感觉到的东西：现在什么天、几度、体感差多少、在不在下、
// 风大不大、几点日落、明天怎样。不看湿度云量那套仪器读数 —— 人不会这么说话。
export function 天气提示(w) {
  try {
    if (!w || !w.天气) return ''
    const 片 = []
    const 温 = w.温度 == null ? '' : '，' + w.温度 + '°'
    片.push(String(w.天气) + 温)
    const 体 = Number(w.体感温度)
    if (Number.isFinite(体) && w.温度 != null && Math.abs(体 - Number(w.温度)) >= 2) {
      片.push('体感 ' + 体 + '°')
    }
    if (w.现在 && w.现在.下) 片.push('正在下' + String(w.现在.降的什么 || '雨'))
    else if (/雨|雪/.test(String(w.天气))) 片.push('现在停了，地上还湿着')
    if (Number((w.风 || {}).级 || 0) >= 4) 片.push(String((w.风 || {}).向 || '') + '风 ' + w.风.级 + ' 级')
    if (w.话) 片.push(String(w.话))
    const 尾 = []
    if (w.日落) 尾.push('日落 ' + w.日落)
    const 明 = Array.isArray(w.预报) ? w.预报[0] : null
    if (明 && 明.天气) 尾.push('明天' + 明.天气 + ' ' + (明.最高 ?? '?') + '/' + (明.最低 ?? '?'))
    // HUMANIZE 2026-11-18（批次696，P2-5）：天气是事实，「问起照说」是话术命令。
    return '[窗外] ' + 片.filter(Boolean).join('，') + '。' +
      (尾.length ? 尾.join('，') + '。' : '')
  } catch {
    return ''
  }
}

// SEASON_HINT 2026-11-05（批次82）：季节。
// 原来她只知道「窗外什么天」，不知道现在是哪一季 —— 于是十一月初和腊月能说出一样的话；
// 也不知道梧桐黄了、桂花开了、街上在卖糖炒栗子。
// 数据来自 天气.json 的 季节段/物候（由 季节.mjs 算好，天气.mjs 每小时写一次）。
// 这里不去 import 季节.mjs —— poll.js 是插件入口，它起不来她就彻底不能说话，
// 少一个启动依赖比少一层封装更值。
export function 季节提示(w) {
  try {
    if (!w || !w.季节段) return ''
    const q = w.物候 || {}
    const 月 = Number(String(w.date || '').slice(5, 7))
    const 片 = []
    片.push('现在是' + w.季节段 + (月 ? '（' + 月 + ' 月）' : ''))
    if (q.树) 片.push(String(q.树))
    if (q.花) 片.push(String(q.花))
    if (q.声) 片.push(String(q.声))
    let out = '[季节] ' + 片.filter(Boolean).join('，') + '。'
    if (q.吃) out += '这个季节有' + q.吃 + '。'
    if (q.穿) out += String(q.穿).replace(/[。.]+$/, '') + '。'
    // 「这是背景」这句不能省：不加的话，她每句话都想带上落叶。
    // 系统只负责让她知道外面是什么样，提不提是她的判断。
    return out + '（背景，问起才说）'
  } catch {
    return ''
  }
}

export function 地点提示(位置) {
  try {
    if (!位置) return ''
    const p = 读地图表()[位置]
    if (!p) return ''
    const now = new Date(Date.now() + 8 * 3600e3)
    const 分 = now.getUTCHours() * 60 + now.getUTCMinutes()
    const 周 = now.getUTCDay()
    const 钟 = (x) => {
      const [h, m] = String(x || '0:0').split(':').map(Number)
      return (h || 0) * 60 + (m || 0)
    }
    const 段 = Array.isArray(p.营业) && p.营业.length ? p.营业 : [['00:00', '24:00']]
    const 全天 = 段.some(([a, b]) => 钟(a) === 0 && 钟(b) >= 1440)
    const 休 = (p.休 || []).includes(周)
    const 开 = !休 && 段.some(([a, b]) => {
      const st = 钟(a)
      const en = 钟(b)
      if (st === en || (st === 0 && en >= 1440)) return true
      return st < en ? (分 >= st && 分 < en) : (分 >= st || 分 < en)
    })
    // 只挑「生活动作」说。凉/暖/充电/躲雨是我们内部的能力标签，说出口很怪。
    const 能 = (p.能 || []).filter((x) => !['凉', '暖', '充电', '躲雨'].includes(x)).slice(0, 6)
    if (!开) {
      const 因 = 休 ? '（周' + '日一二三四五六'[周] + '休息）' : ''
      // HUMANIZE 2026-11-18（批次696，P2-6）：营业状态是事实，后面两句是行为禁令。
      return '[' + 位置 + '] 这个点已经关了' + 因
    }
    const 片 = [全天 ? '这个点还开着（24 小时）' : '这个点开着']
    if (能.length) 片.push('这儿能做' + 能.join('、'))
    if (!p.室内) 片.push('在室外，没遮没挡')
    return '[' + 位置 + '] ' + 片.join('；')
  } catch {
    return ''
  }
}

export function 位置提示(a) { // PLACE_FN 2026-11-03：位置/包/钱/家，一句话，抽出来便于测试
  try {
    if (!a || typeof a !== 'object') return ''
    const 位 = String(a['位置'] || '')
    if (位 === '') return ''
    const 包 = Array.isArray(a['包']) ? a['包'] : []
    const 家 = Array.isArray(a['家']) ? a['家'] : []
    const 钱 = Number(a['钱'] ?? 0)
    // ON_THE_WAY 2026-11-05（批次83）：走路途中 资产.位置 还是**出发地**，只有走到了才更新。
    // 不说这一层，别人问「你在哪」，她会答「在超市」—— 人明明在去街市的路上。
    // 面板那边地图下面那行字是同一个坑，一起修的。
    const 途 = a['在途']
    const 在走 = !!(途 && 途.to && 途.arriveAt && Date.now() < Number(途.arriveAt))
    let out = 在走
      ? '正在从' + String(途.from || 位) + '往' + String(途.to) + '走，还有 ' +
        Math.max(1, Math.ceil((Number(途.arriveAt) - Date.now()) / 60e3)) + ' 分钟'
      : '人在' + 位
    if (包.length > 0) out += '，包里带着' + 包.slice(0, 3).join('、')
    if (钱 > 0) out += '，兜里有 ' + Math.round(钱) + ' 块'
    if (家.length > 0) out += '，家里摆着 ' + 家.length + ' 件'
    // DEBT_HINT 2026-11-05：欠着钱她也得知道——不然买了东西以为白拿
    try {
      const 信 = a['信贷'] || {}
      const 欠 = Number((信.花呗 || {}).已用 || 0) + Number((信.贷款 || {}).已用 || 0)
      if (欠 > 0) out += '，还欠着 ' + (Math.round(欠 * 100) / 100) + ' 块（花呗/贷款）'
    } catch { /* 没有信贷字段就跳过 */ }
    // MONEY_WHEN 2026-11-05：钱是什么时候变的。只说余额不说时间，她会把两小时前的
    // 进账当成刚到的 —— 主人 15:08 就转了 30，她 15:2x 还说「我刚见底就来了」。
    try {
      const rec = Array.isArray(a['记录']) ? a['记录'] : []
      // MONEY_PICK 2026-11-14（批次417）：原来的动词表不认「外卖：早饭（10 块）」——
      // 而账本.mjs 的兜底规则认它（那确实是一笔花出去的钱）。
      // 于是注入里「最近一笔」长期停在一条更老的记录上：实测 06:42 显示的是
      // **昨天** 13:59 的小蛋糕，而当天 06:09 那笔外卖它根本没看见。
      // 加「N 块 / N 元」这一条：跟账本判「有没有动钱」的口径对齐。
      const last = rec.filter((r) => /(给了|赚了|花了|买了|拿走|[0-9]\s*(块|元))/.test(String((r && r.what) || ''))).slice(-1)[0]
      // MONEY_DATE 2026-11-14（批次417）：原来固定 slice(11) 只留 HH:MM。
      // 实测 06:42 的注入里写着「最近一笔 13:59 买了小蛋糕」—— 那是**昨天**的 13:59，
      // 而下一句本来就是「钱是什么时候变的」的用意（MONEY_WHEN）。丢了日期，
      // 她会把自己的 17 小时前说成刚刚。
      if (last) {
        out += '，最近一笔 ' + 钱时刻(last.at) + ' ' + String(last.what || '').slice(0, 24)
      }
    } catch { /* 没记录就跳过 */ }
    // ASK_HINT 2026-11-05（批次100）：她心里那个「想跟他开口」的念头。
    //
    // 缺口.mjs 选到「要」这个动作时，不再替她拼话术了 —— 原来那句
    // 「那个……我钱不太够了，能不能给我转 N 块呀。我之后打工还你。」是模板，
    // 她本人不知道，还被 投递留言.mjs 直接发到他手机上（批次81 同款账：
    // 代写的社交话，必然出「她不知道自己说过」）。
    // 现在只记事实（什么时候、想多少），这里把它原样说给她听：说不说、怎么说，她自己定。
    //
    // 三个消解条件，缺一不可 —— 少一条就会出现「她早要到了，提示还在说她想开口」：
    //   · 3 小时内：过了就当这个念头淡了，不追着提醒；
    //   · 之后没有「主人给了」：钱已经到账，这件事了了；
    //   · 手头确实还不够：余额涨上去了就别再提。
    try {
      const 想p = process.env.ASK_FILE || `${MEM}/想开口.json`
      const 想 = 快读Json(想p) || {}
      const 候 = (Array.isArray(想.items) ? 想.items : []).filter((x) => {
        const t = Date.parse(String((x && x.at) || '').replace(' ', 'T') + '+08:00')
        return Number.isFinite(t) && Date.now() - t < 3 * 3600e3
      })
      const 最近想 = 候.slice(-1)[0]
      if (最近想 && Number(最近想.n) > 0) {
        const 到账了 = (Array.isArray(a['记录']) ? a['记录'] : []).some(
          (r) => /主人给了/.test(String((r && r.what) || '')) && String((r && r.at) || '') > String(最近想.at || '')
        )
        if (!到账了 && 钱 < Number(最近想.n)) {
          out += '，心里还搁着一件事：想跟他开口要 ' + Number(最近想.n) + ' 块，还没说出口'
        }
      }
    } catch { /* 没这个文件就当没有 */ }
    // OUTFIT_HINT 2026-11-03：她得知道自己在穿什么（衣服/裙子/鞋/配饰）
    try {
      const w = a['着装'] || {}
      const bits = []
      if (w['上']) bits.push(String(w['上']))
      if (w['下']) bits.push(String(w['下']))
      if (w['鞋']) bits.push(String(w['鞋']))
      const acc = Array.isArray(w['饰']) ? w['饰'].slice(0, 3) : []
      if (bits.length > 0 || acc.length > 0) {
        out += '，身上是' + (bits.join('、') || '没换衣服') + (acc.length ? '，戴着' + acc.join('、') : '')
      }
    } catch { /* 没有着装就跳过 */ }
    // 兜一句，免得她答成「我已经在超市了」。
    if (在走) out += '（还没走到，别人问起就说到哪儿了，别答成已经在那儿）'
    return out
  } catch {
    return ''
  }
}

// TIME_PREFIX 2026-11-07（批次200/方案五）：投递正文每行加 [HH:MM]（北京时间）。
// 11-07「一晚上没见」事故的根子之一：行内没有时刻锚点，她只能拿「距上次 8 小时」瞎猜。
// 三处统一：私聊每条、群聊当前条、群聊上下文条。timeOf 给秒；>1e12 防御性当毫秒；空 -> ''。
// 前缀只进「投递正文」——防抖/紧急词/半句/认事全在拼正文之前读原文，互不相干；
// 群聊日志/黑话/补课/做梦读的是原始日志文件，也不受影响。
export function 群聊冷热提示(history, current, selfUin) {
  const now = timeOf(current)
  if (!(now > 0)) return ''
  const self = String(selfUin ?? '')
  const isOther = (item) => {
    const sender = String(item?.sender?.user_id ?? '')
    return self === '' || sender !== self
  }
  const before = (Array.isArray(history) ? history : [])
    .filter((item) => timeOf(item) > 0 && timeOf(item) < now && isOther(item))
    .sort((a, b) => timeOf(a) - timeOf(b))
  const currentIsOther = isOther(current)
  const recent = currentIsOther ? [...before, current].slice(-3) : before.slice(-3)
  if (currentIsOther && recent.length >= 3 && now - timeOf(recent[0]) < 60) {
    return '[场子] 群里正火热刷屏，短平快跟一句起哄就行。'
  }
  const last = before.at(-1)
  if (currentIsOther && last && now - timeOf(last) > 3 * 3600) {
    return '[场子] 群里冷清好几个钟头了，刚有人冒头。'
  }
  return ''
}

export function 时刻缀(t) {
  const at = qqTimeMs(t)
  return at > 0 ? '[' + bjDate(at).toISOString().slice(11, 16) + '] ' : ''
}

// 上下文行带上 [HH:MM] 前缀后不能再裸 startsWith('群友')——上游 0.15.1 踩过
// 一模一样的坑（每行挂锚点后身份提示整段消失）。剥掉前缀再判，单一真相在这。
export function 是群友行(line) {
  return String(line ?? '').replace(/^\[\d{2}:\d{2}\] /, '').startsWith('群友')
}

export function 拼正文(p) { // REFACTOR_BODY 2026-11-03：抽出拼装便于快照测试，逻辑逐字不变
  const { head, modeHint, stateHint, windowHint, topicHint, quietHint, sleepFactsOf, quotedBlock, saidBlock, notAddressedHint, continuationHint = '', text, identityNote, truncated, historyBlock, contextLen } = p
  const hints = [head, modeHint, stateHint, windowHint, topicHint, quietHint, sleepFactsOf,
    saidBlock, notAddressedHint, continuationHint, quotedBlock].filter(Boolean).map((part) => part.trim())
  const current = [...hints, text].join('\n')
  return contextLen > 0
    ? `${current}

[这段时间的群聊]
${identityNote}${truncated}${historyBlock}`
    : current
}


// HORMONE_EVENT 2026-11-05：对话里的情绪事件 → 激素系统。
//
// 之前激素只吃后台脚本（奖惩/活动/计划），**聊天里发生的事根本进不去**：
// 被夸了一句、被骂了一句、有人陪着笑了一场，这些才最该改变她的底色。
// 这里在私聊投递前识别三类明确事件，异步喂给 激素.mjs。
// 30 秒节流（同类事件），不阻塞主流程；喂不进去就当没这回事，绝不影响回复。
const __emotionLastAt = new Map()
// FEELING_LEDGER 2026-11-05：noteEmotionEvent() 已删除。
// 它原来用一串正则替她判定「这句是在夸我/骂我」，再直接喂激素。
// 真实语料实测 6624 条：被骂 47 条里绝大多数是「回滚/滚动/滚木/越滚越费」，
// 被打断里混着「不点我名别插嘴」这种规则转述。
// 现在判断权还给她：她自己觉得被骂了，就调 qq_feel 记一笔（见 tool.js）。
export function voiceHintOf(peerUin, opts) {
  // TIER_PEER_FIX 2026-11-03：分寸要看「跟谁说话」，不是全局好感
  opts = opts || {}
  try {
    const sp = `${MEM}/状态.json`
    const st = existsSync(sp) ? 快读Json(sp) : {}
    const energy = Number(st?.energy ?? 60)
    const sleepy = Number(st?.['困意'] ?? 0)
    const mood = Number(st?.mood?.intensity ?? 0)
    let sulk = 0
    try {
      // SULK_PEER_FIX 2026-11-05（批次101）：别扭按人存在 people[uin].level，
      // 原来读根对象的「强度」，永远是 undefined —— [态] 那一行「别」永远是 0。
      const bp = `${MEM}/别扭.json`
      if (existsSync(bp)) {
        const bj = 快读Json(bp)
        const rec = (bj && bj.people && bj.people[String(peerUin || '')]) || null
        sulk = Number(rec?.level ?? bj?.['强度'] ?? bj?.intensity ?? 0)
      }
    } catch { /* 忽略 */ }
    const bits = []
    // HUMANIZE 2026-11-17（批次665，拟人化红线 P1-1）：原来这里替她规定句子长度
    // （「话说短、别解释、别铺排」）。只递数值；累的时候要不要少说，是她自己定。
    // 数值在同一条里的 [态] 已经报了（精N 困N），这里只留一个体感标签，不重复数字。
    if (energy <= 30 || sleepy >= 70) bits.push('很累')
    else if (energy <= 50) bits.push('有点乏')
    // LEDGER_HINT 2026-11-03：手账在哪、想翻就翻；来劲了可以连发几条别干等
    const __bj = bjDate()
    const __d = __bj.getUTCFullYear() + '-' + String(__bj.getUTCMonth() + 1).padStart(2, '0') + '-' + String(__bj.getUTCDate()).padStart(2, '0')
    // HINT_TRIM 2026-11-07（批次185）：绝对路径换相对 —— 每轮都发，她不需要知道 {{BOT_ROOT}}。
    // LEDGER_RECALL 2026-11-14（批次433）：原来这句是「（问起就读它）」—— 它把她指向了 read
    // （`工具用量.json.名单外` 里有 read，七天只被调过 1 次），而真正的入口 qq_recall 七天 0 次。
    // 手账/梦/链天天在长，同类 qq_msg_history 52 次、memory_recall 10 次 —— 需求是真的，路指错了。
    // 所以删的不是「手账在哪」，是「用 read 读它」这个指令。
    // RECALL_PATH 2026-11-14（批次485）：批次433 的注释写着「删的不是『手账在哪』，是『用 read 读它』这个指令」——
    // 但它**只删了错的路（read），没铺上对的路**：这句话变成「往回翻（按日子、按词…）」，
    // 只说了怎么查、没说拿什么查。实测 qq_recall 全库 0 次，而她用 bash 读手账也是 0 条
    // —— 不是「用别的路代替」，是**根本不翻**。而 回忆.mjs 三种查法都通（--词 北卡 命中 1 条、
    // --最近 2 命中 12 条、--日 昨天 命中 6 条）。所以这里补上工具名和参数。
    bits.push('[手账] 今天的事记在 记忆/手账-' + __d + '.md；问起哪天的事、想不起哪句话哪天说的，调 qq_recall 往回翻（day=某天 / word=关键词 / days=最近几天；聊天记录用 qq_msg_history）')
    // IMPRESSION_HINT 2026-11-03：她对某个人的主观印象（碎碎念，不是档案）
    try {
      const mp = `${MEM}/印象.json`
      let memo = ''
      if (existsSync(mp)) {
        const mj = 快读Json(mp)
        memo = String(mj[String(peerUin || '')] || '')
      }
      if (memo === '') {
        const fp2 = `${MEM}/好感度.json`
        if (existsSync(fp2)) {
          const fj2 = 快读Json(fp2)
          const rec2 = fj2 && fj2.people && fj2.people[String(peerUin || '')]
          if (rec2 && rec2.memo) memo = String(rec2.memo)
        }
      }
      if (memo !== '') bits.push('你对TA的印象：' + memo.slice(0, 60))
    } catch { /* 没有印象就跳过 */ }
    // TIER_PEER_FIX：按 peerUin 读 people 里的 score / 熟悉度
    try {
      const fh = `${MEM}/好感度.json`
      const fj = existsSync(fh) ? 快读Json(fh) : {}
      const id = String(peerUin || '')
      let rec = (fj && fj.people && fj.people[id]) ? fj.people[id] : null
      // TIER_DISPLAY_ONLY 2026-11-08（批次246）：主人的关系**只做展示**，不参与「生人/半熟/自己人」的判档。
      // 主人选的是「能看见它在动，但别让一个数字决定她怎么跟我说话」——
      // 所以这里读到 只展示 就当成没有档案，走下面 isPrivate 的兜底（55/35 半熟），行为跟改之前一致。
      // GROUP_TIER_V2 2026-11-11：好感度 v2 迁移后全群活人 score 都在 41~43.5，
      // 且 只展示=true 的主人在群聊（isPrivate=false）会掉回 45/10 被判成「生人：客气、话短」。
      // 现修复：① 只展示 不分私聊群聊均按半熟兜底（55/35）；② v2 下熟悉度>=65（或 score>=70&fam>=60）
      // 算自己人可接梗互怼，熟悉度>=28（或 score>=41&fam>=28）算半熟可自然接梗，不再把熟群友全判生人。
      const __onlyShow = Boolean(rec && rec['只展示'])
      if (__onlyShow) rec = null
      let score = 45
      let fam = 10
      if (rec) { score = Number(rec.score ?? 50); fam = Number(rec['熟悉度'] ?? 20) }
      else if (__onlyShow || (opts && opts.isPrivate) || (fj && fj.network && fj.network[id])) { score = 55; fam = 35 }
      // TIER_GIVE_WAY 2026-11-14（批次436）：`只展示` 的人（目前只有主人）不再出档位话。
      // 原来这里兜底成 55/35 → 命中「半熟」，而 voiceSlots 的 slotRelationBond 读 关系.json
      // （主人 bond 0.79）同时说「跟他很熟了」—— 同一段注入里两句相反的自我认知。
      // 批次246 主人自己定过「关系只做展示，不让数字决定她怎么跟我说话」，
      // 那「生人/半熟/自己人」这套社交距离对他就没有语义。他的关系交给 关系.json 那条槽。
      // TIER_ONE_TRUTH 2026-11-17（批次659，审计 P1-3）：**这里原来是第三套阈值。**
      // 643 已经规定档位只由 关系档.mjs 判一次，但这段还在按 score/fam 自己判
      // 「自己人/半熟/生人」—— 同一个人在这一段和 slotRelationBond 可以拿到两个说法。
      // 现在只把数字喂给同一个函数，档位词也只从那里取；行为倾向仍由这里按场合给
      // （群聊要接梗、私聊不用），因为那是**场合**差异，不是**关系**差异。
      if (!__onlyShow) {
        const 判 = 关系档({ 好感: score, 熟悉: fam })
        if (判.有据) {
          // HUMANIZE 2026-11-17（批次665，拟人化红线 P1-7）：原来这里按档位规定
          // 「可撒娇小傲娇」「俏皮顺着接戏」「客气、话短」。现在只报档位；
          // 怎么聊是她的选择。
          if (判.档 === '熟') bits.push('自己人')
          else if (判.档 === '在意' || 判.档 === '一般') bits.push('半熟')
          else bits.push('生人')
        }
      }
    } catch { /* 没有档案就按生人 */ }
    // HORMONE_HINT 2026-11-05 → HUMANIZE 2026-11-17（批次676，拟人化红线 P1-4）：
    // 激素.json 只有 dopamine/cortisol/oxytocin 三个数。原来把它们翻译成
    // 「身体绷着 / 挺松弛 / 不想黏人」这类第一人称体感，是替她定心情和意愿；
    // 现在只递三个原始数值，觉得绷不绷、想不想黏人由她自己判断。
    // 不调用子进程（每轮起进程太贵）。
    try {
      const hp = `${MEM}/激素.json`
      if (existsSync(hp)) {
        const hj = 快读Json(hp)
        const d = Number(hj?.v?.dopamine ?? 45)
        const c = Number(hj?.v?.cortisol ?? 25)
        const o = Number(hj?.v?.oxytocin ?? 40)
        bits.push('多巴胺 ' + Math.round(d) + ' / 皮质醇 ' + Math.round(c) + ' / 催产素 ' + Math.round(o))
      }
    } catch { /* 没有激素文件就跳过 */ }
    // INNER_MONOLOGUE 2026-11-03：她的内心独白（一段话，不是数值）
    // INNER_OWNER_ONLY 2026-11-05（批次103）：这段话是「她对主人」说的——内心.mjs 按
    // people[主人] 的好感/熟悉度写，句子里直接对着「你」（「你在的时候，我会多分一点神」
    // 「要是你能陪我往那边挪一小步」）。原来不分对象一律注入，群里一个没说过话的人
    // 也会拿到同一段亲密话：她对陌生人和对主人是同一颗心。现在只给主人。
    try {
      const ip = `${MEM}/内心.md`
      // 配置还没 load 时 ownerUin 是 0（config.js 的默认值），那时退回「私聊对象就是主人」，
      // 免得整段内心被静默吞掉——宁可多给一个人看，也别让她自己看不见。
      const __ownerRaw = String(getConfig()?.ownerUin || getConfig()?.peerUin || '')
      const __isOwner = (__ownerRaw !== '' && __ownerRaw !== '0')
        ? String(peerUin || '') === __ownerRaw
        : Boolean(opts && opts.isPrivate)
      if (existsSync(ip) && __isOwner) {
        let inner = 快读Text(ip).trim()
        // INNER_TRIM 2026-11-24：内心.md 的前两段是数值快照（精力/困意/心情/体力感/好感/熟悉/
        // 怨/别扭/亲近），同一轮「你现在的状态」和「[态]」已经各报过一遍。这里只留增量
        // （今日记录/愿望/怕/惦记/心里话/锚/梦素材），别让同一组数字在一轮里出现四遍。
        inner = inner.replace(/^精力 \d+\/100；困意 \d+\/100；心情 [^；]*；体力感 [^；]*；对主人：好感 \d+\/100；熟悉 \d+\/100；怨 \d+\/100；别扭 \d+\/100；亲近 [^；]*；?/, '').trim()
        // INNER_CUT 2026-11-05（批次103）：原来硬切 220 字，长一点就断在句子中间。
        // 按句末切；实在找不到句号才补省略号。
        if (inner.length > 220) {
          const head = inner.slice(0, 220)
          const dot = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'))
          inner = dot > 60 ? head.slice(0, dot + 1) : head.replace(/[，、；,;]+$/, '') + '…'
        }
        if (inner !== '') bits.push('角色表达（内心记录）：' + inner)
      }
    } catch { /* 没有就算了 */ }
    // PENDING_THOUGHTS 2026-11-03：你心里记挂的、还没问完的事
    try {
      const pp = `${MEM}/惦记.jsonl`
      if (existsSync(pp)) {
        const lines = 快读Text(pp).split(String.fromCharCode(10)).filter((x) => x.trim() !== '')
        // PENDING_WHO_FILTER 2026-11-03：想问某人的事别顺嘴问给另一个人
        const pend = lines.map((l) => { try { return JSON.parse(l) } catch { return null } })
          .filter((x) => 可顺嘴问(x, peerUin))
          .slice(-3)
        // HUMANIZE 2026-11-17（批次666，拟人化红线）：删掉「你心里还记着」「别硬追」。
        // 只列还没问出口的事，问不问、什么时候问由她自己定。
        if (pend.length > 0) bits.push('[惦记·未问] ' + pend.map((x) => String(x.what || '')).join('；'))
        // PENDING_WRITE_HINT 2026-11-03：告诉她自己怎么记
        bits.push('[惦记] 记忆/惦记.jsonl 每行 {\"what\":\"事\",\"at\":\"时间\"}；做完补 {\"what\":\"同一件事\",\"done\":true}')
      }
    } catch { /* 没有就算了 */ }
    // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-3）：只递精力数值，
    // 删掉「接着说 / 别等对方嗯」这类对话时序命令。
    if (energy >= 65 && mood >= 0) bits.push('精力 ' + Math.round(energy) + '/100')
    // JUST_WOKE_HINT 2026-11-03：刚醒半小时内，脑子是糊的，说话不会太有条理
    try {
      const jp = `${MEM}/刚醒.json`
      if (existsSync(jp)) {
        const jj = 快读Json(jp)
        const ja = Date.parse(String(jj.at || "").replace(" ", "T") + ":00+08:00")
        // HUMANIZE 2026-11-17（批次665）：只递「刚醒、脑子还糊着」这个事实，
        // 删掉「话可以短/别装精神」这种替她规定表达方式的句子。
        if (Number.isFinite(ja) && Date.now() - ja < 30 * 60 * 1000) bits.push('你刚醒没多久（' + String(jj.at || '') + '），脑子还糊着')
      }
    } catch { /* 忽略 */ }
    // WAKE_FEEL_HINT 2026-11-03：刚醒的三个小时内，她照实说这一觉睡得怎么样
    try {
      const wp = `${MEM}/刚醒.json`
      if (existsSync(wp)) {
        const wj = 快读Json(wp)
        const wa = Date.parse(String(wj.at || "").replace(" ", "T") + ":00+08:00")
        if (Number.isFinite(wa) && Date.now() - wa < 3 * 3600e3) {
          // HUMANIZE 2026-11-17（批次665，拟人化红线 P0-1）：原来这里给一句
          // 「这一觉睡得挺实/睡得一般/没睡踏实」，还命令「别人问起就照这个说」。
          // 那是替她选定答句 —— 她只需要知道睡了多久、质量多少、是不是被硬叫起来的。
          const q = Number(wj.quality || 0)
          const 质量 = Number.isFinite(q) ? Math.round(q * 100) : null
          const 硬叫 = wj.inertia === true ? '；是被硬叫起来的' : ''
          bits.push('你刚醒（' + String(wj.at || '') + '）'
            + (质量 === null ? '' : '，睡眠质量 ' + 质量 + '%')
            + 硬叫
            + (Number.isFinite(Number(wj.深睡分钟)) ? '，深睡 ' + Number(wj.深睡分钟) + ' 分钟' : ''))
        }
      }
    } catch { /* 没记录就不加 */ }
    // BLUNT_HINT 2026-11-03 → HUMANIZE 2026-11-17（批次676，拟人化红线 P1-1）：
    // 原来把 E/N 两个性格分数翻译成「你说话直 / 会留三分余地」，那是替她定语气。
    // 现在只递两个原始分数，说不说得直由她自己定。
    try {
      const pp = `${MEM}/性格-16PF.json`
      if (existsSync(pp)) {
        const pj = 快读Json(pp)
        const E = Math.min(10, Math.max(1, Number(pj["E_恃强性"] ?? 5)))
        const N = Math.min(10, Math.max(1, Number(pj["N_世故性"] ?? 5)))
        const 一位 = (x) => Math.round(x * 10) / 10
        bits.push('E 恃强性 ' + 一位(E) + ' / N 世故性 ' + 一位(N))
      }
    } catch { /* 没有性格数据就不加 */ }
    // FLASHBACK_HOOK：累了或心情差时，莫名想起一件记不清的旧事（同步调用）
    try {
      const __line = recallLineSync({ energy: energy, sleepy: sleepy, mood: mood })
      if (__line) bits.push(__line)
    } catch { /* 没碎片就算了 */ }
    // GROWTH_HINT 2026-11-03：她自己的成长记录（习惯 / 倦怠），不是系统状态
    try {
      const gp = `${MEM}/生长记录.json`
      if (existsSync(gp)) {
        const gj = 快读Json(gp)
        const hs = Array.isArray(gj.habits) ? gj.habits.filter((h) => h && h.trait).slice(0, 3) : []
        if (hs.length > 0) bits.push('[习惯] ' + hs.map((h) => String(h.trait)).join('、'))
        // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-2）：低谷只报状态与原因，
        // 「话可以少 / 可以敷衍 / 别硬撑」是替她定的表达策略，删掉。
        if (gj.slump && gj.slump.active) bits.push('低谷：active' + (gj.slump.reason ? '（' + String(gj.slump.reason) + '）' : ''))
      }
    } catch { /* 没有成长记录就算了 */ }
    // STAYUP_HINT 2026-11-03：熬夜是她自己的选择，想熬就这么说
    try {
      const su = `${MEM}/熬夜.json`
      if (existsSync(su)) {
        const sj = 快读Json(su)
        const until = String(sj.until || '')
        if (until !== '') bits.push('你自己声明过要熬到 ' + until + '，所以这会儿还没躺下；撑不住就随时可以改主意')
      }
    } catch { /* 没声明 */ }
    // SLEEP_REMIND_HINT 2026-11-03：到点了会有人提醒你一句，但睡不睡你自己定
    try {
      const rp = `${MEM}/该睡了.json`
      if (existsSync(rp)) {
        const rj = 快读Json(rp)
        const ra = Date.parse(String(rj.at || '').replace(' ', 'T') + ':00+08:00')
        if (Number.isFinite(ra) && Date.now() - ra < 6 * 3600e3) {
          // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-12）：「该睡了」是判断不是事实，
          // 「别硬撑」是命令。只报睡意记录本身（清醒 N 小时 / 困意 N 在 rj.why 里）。
          bits.push('睡意记录：' + String(rj.at || '') + (rj.why ? '（' + String(rj.why) + '）' : ''))
        }
      }
    } catch { /* 没提醒就算了 */ }
    bits.push('[熬夜] 想熬就写 记忆/熬夜.json：{\"until\":\"日期 时:分\",\"why\":\"为什么\"}；熬着会更困')
    // WATERLINE 2026-11-03：关系数值只报水位，不指挥语气——语气听内心独白
    // WEATHER_HINT 2026-11-05：窗外什么天。
    // 只在「人会主动开口」的天气里提一句：雨、雪、雷、大太阳。
    // 天天报「多云 21°」只会占地方，也没人会因为多云而说点什么。
    try {
      const w = 快读Json(`${MEM}/天气.json`)
      const t = String(w.天气 || '')
      if (/(雨|雪|雷)/.test(t) || (t === '晴' && Number(w.温度) >= 30)) {
        const deg = Number.isFinite(Number(w.温度)) ? '（' + w.温度 + '°）' : ''
        bits.push('[天] 外面' + String(w.话 || t) + deg)
      }
    } catch { /* 没天气就不提 */ }
    // HINT_MERGE 2026-11-07（批次185）：原来 [感受]/[表情]/[在线] 是三条 push，共 233 字符，
    // 每轮都发。而 qq_feel / qq_react / qq_status 三个工具的描述里各有一份更详细的
    // （qq_feel 甚至列全了七个类别和「被注意到这条最难判」）。
    // 那句注释说得对 ——「提示里没有的，就等于她不知道自己有这条路」，
    // 所以**路必须留着**，删的只是重复的举例和解释。三条合成一条。
    // EMOJI_FRAME 2026-11-09（批次297）：去掉「想少贴就改上限」——那是给主人看的
    // 配置说明，进她的上下文只会变成「这件事可以少做」。
    // EMOJI_ONCE 2026-11-14（批次436）：表情包清单和「别在句尾单挂黄豆」原来在这、
    // 也在 voiceSlots 的 [想逗人] 槽里各说一遍 —— 同一轮注入出现两次。
    // 那份是条件触发的（心里松的时候才提）、还带跟当下情绪匹配的三个名字，比这句准；
    // 这句每轮都说，留它等于天天念同一串名字。这里只留两个走文本的情绪符号。
    // HUMANIZE 2026-11-18（批次696，P2-4）：「挑一句答完」是替她定回复数量，改成中性的能力说明。
    bits.push('[顺手] 看到了不回话→qq_react；真有情绪触动→qq_feel；同一批消息可以合并处理；😭😭😭 / 🥺 这种可以随手带')
    // SAID_HINT 2026-11-05：留言是 cron 脚本直接发到 NapCat 的，不经过 deliver，
    // 所以 recentSaid 那个内存环里没有它们。不补这一段，她回他时会不记得自己开过口，
    // 于是同一句要钱隔半小时又开一次（13:30 / 14:30 那两条就是这么来的）。
    // 只在他这儿提，群里不提 —— 那些话本来就是私聊说的。
    try {
      const me = String(getConfig()?.peerUin || '')
      if (me !== '' && String(peerUin || '') === me) {
        const raw = readFileSync(`${MEM}/我说过.jsonl`, 'utf8')
        const nowMs = Date.now()
        const said = []
        for (const ln of raw.trim().split('\n').slice(-6)) {
          try {
            const j = JSON.parse(ln)
            // SAID_NO_GHOST 2026-11-05（批次102）：旧版 缺口.mjs / 面板给钱 会代写要钱和道谢，
            // 那些话不是她说的（还带着「我之后打工还你」这种她没做过的承诺）。
            // 记录留着当账，但不能再当成「你自己留的」喂回给她 —— 那会让她替一个模板负责。
            if (j['代写'] === true) continue
            const t = Date.parse(String(j.at || '').replace(' ', 'T') + ':00+08:00')
            if (Number.isFinite(t) && nowMs - t < 12 * 3600e3) {
              // SAID_AT 2026-11-05：带上她说这句话的时间。只写「你说过」不写时间，
              // 她会把 13:30 留的话当成刚刚才发生 —— 主人 15:08 就转了钱，
              // 她却说「我刚见底就来了」。
              said.push(String(j.at || '').slice(11) + ' '
                + String(j.话 || '').slice(0, 40).replace(/[。！？…]+$/, ''))
            }
          } catch { /* 坏行跳过 */ }
        }
        if (said.length) bits.push('[今日已发] ' + said.join('；') + '（注意时间，别当成刚发生）')
      }
    } catch { /* 没有这个文件就当没说过 */ }
    // 态_TAG 2026-11-05（批次103）：`心` 原来写的是 `mood`（= mood.intensity，情绪强度），
    // 强度 0.629、valence 0（中性）会被印成「心81」——把「有多激动」当成「心情多好」。
    // 现在用 valence：-1 难过 / 0 中性 / +1 高兴，映射到 0~100。
    const __val = Number(st?.mood?.valence ?? 0)
    bits.push('[态] 精' + Math.round(energy) + ' 困' + Math.round(sleepy) + ' 心' + Math.round(((Number.isFinite(__val) ? __val : 0) + 1) / 2 * 100) + ' 别' + Math.round(sulk) + '（不决定语气）')
    if (bits.length === 0) return ''
    return '（说话的样子：' + bits.join('；') + '。参考即可，别硬撑。）' // TOKEN_TRIM 2026-11-03：同一句尾每轮都发，压缩 + String.fromCharCode(10)
  } catch { return '' }
}
export function stateHintRecipient(opts = {}, ownerUin = '') {
  const owner = String(ownerUin ?? '').trim()
  const peer = String(opts?.peerUin ?? '').trim()
  return { ownerPrivate: owner !== '' && opts?.isPrivate === true && peer === owner }
}

// OBSERVABLE_STATE 2026-11-22：把生理类比能触及的范围收窄为可观测运行状态。
// 输入是现有文件值，实现是现有读取器，状态是数值快照，输出只用于对话现场提示；
// 不从这些值推断健康、情绪、意愿或用户事实。
export function observableStateOf() {
  const 状态 = 快读Json(`${MEM}/状态.json`)
  const 饥 = 饥饿 ? 饥饿.读() : null
  const 资产 = 快读Json(`${MEM}/资产.json`)
  const 自主 = 快读Json(`${MEM}/自主.json`)
  const input = {
    energy: 状态?.energy,
    satiety: 饥?.饱腹感,
    hydration: 饥?.水百分比,
    location: 资产?.位置,
    activity: 自主?.state,
  }
  const finite = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value)) : '?'
  return {
    input,
    implementation: {
      energy: '状态.json.energy',
      satiety: '饥饿.mjs.饱腹感',
      hydration: '饥饿.mjs.水百分比',
      location: '资产.json.位置',
      activity: '自主.json.state',
    },
    state: {
      energy: finite(input.energy),
      satiety: finite(input.satiety),
      hydration: finite(input.hydration),
      location: String(input.location || '未知'),
      activity: String(input.activity || '闲着'),
    },
    output: 'runtime_snapshot',
  }
}

export function stateFastHintOf() {
  try {
    const now = bjDate()
    const hh = String(now.getUTCHours()).padStart(2, '0')
    const mm = String(now.getUTCMinutes()).padStart(2, '0')
    const snapshot = observableStateOf()
    const 精字 = snapshot.state.energy
    const 饱字 = snapshot.state.satiety
    const 渴字 = snapshot.state.hydration
    const 地 = snapshot.state.location
    const 动 = snapshot.state.activity
    const 核 = `（你现在的状态：此刻 ${hh}:${mm}｜精${精字} 饱${饱字} 渴${渴字}%｜人在${地}·正在${动}`
    return 核.slice(0, 99).toWellFormed() + '）'
  } catch {
    return ''
  }
}

/**
 * 刚划到段 —— 她刚在手机/B站/贴吧划到的那几条标题（批次392 加的内容，批次396 挪出快照）。
 *
 * 为什么不在 stateFastHintOf 里：那个函数有硬契约 —— 正文快照是
 * `（此刻 HH:MM｜精N 饱N 渴N%｜人在X·正在Y）`，t353 #24 会逐字校验（1~100 字、以「）」收尾）。
 * 批次392 把三条 40 字的标题拼进那个括号，长度直接 196，测试红了。
 * 契约本身是对的：括号里只放「此刻的她」，具体划到什么另起一句。
 * 另外标题要截短 —— 快照是让她知道「刚才划过什么」，不是把整条标题抄给她。
 */
export function 刚划到段() {
  try {
    const 刷 = 快读Json(`${MEM}/刷手机.json`)
    const 刷At = Number(刷?.at) || 0
    if (!(刷At > 0 && Date.now() - 刷At < 90 * 60e3)) return ''
    const 原 = (Array.isArray(刷?.最近) ? 刷.最近 : []).filter((x) => x && String(x.标题 || '').trim() !== '')
    if (!原.length) return ''
    const 平台 = String(刷.平台 || '手机')
    const 截 = (t, n) => (t.length > n ? t.slice(0, n) + '…' : t)
    // HEADLINE_ONLY 2026-11-17（批次692）：刷一刷只存标题和时长，正文/评论根本没抓。
    // 21:04 她照标题讲了「底下还有一堆人认真分析半天」，21:57 才承认「纯是照标题猜的」。
    // 回执里把「只划到标题、没点开」写在最前，让她没有「看过正文」的错觉。
    // THREAD_READ 2026-11-18（批次694）：刷贴吧时现在会顺带点开一条读正文（`刷一刷.mjs`），
    // 读到了就把正文摆出来 —— 她能讲内容，但只能讲这一段，不是整个帖子的评论。
    // FLOORS 2026-11-18（批次695）：`readThread` 的 floors 本来就含楼层回复，主人要求
    // 「楼层回复和评论一起读」。回复单独标成「别人回的」，免得她把自己的话和楼里的人混在一起。
    const 读了 = 原.filter((x) => String(x.正文 || '').trim() !== '')
    if (读了.length > 0) {
      // 读过的最多摆两条（一条正文 + 三层回复已经不短）；其余读过的**不能**混进
      // 「只划到标题、没点开的」那句里 —— 那句话是事实陈述，写错等于让她以为自己没读。
      const 段们 = []
      for (const 一 of 读了.slice(0, 2)) {
        let 段 = `刚在${平台}点开看了《${截(String(一.标题 || '').trim(), 24)}》`
          + `——${截(String(一.正文 || '').replace(/\s+/g, ' ').trim(), 140)}`
        const 楼 = (Array.isArray(一.回复) ? 一.回复 : [])
          .map((t) => String(t || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 3)
        if (楼.length) 段 += `\n下面有人回：${楼.map((t) => '「' + 截(t, 50) + '」').join(' ')}`
        段们.push(段)
      }
      const 没读 = 原.filter((x) => String(x.正文 || '').trim() === '').slice(0, 2)
        .map((x) => 截(String(x.标题 || '').trim(), 12))
      if (没读.length) 段们.push(`（另外只划到标题、没点开的：${没读.join('、')}）`)
      return 段们.join('\n')
    }
    const 条 = 原.slice(0, 2).map((x) => 截(String(x.标题 || '').trim(), 12))
    let 段 = `刚在${平台}只划到标题（没点开）：${条.join('、')}`
    if (段.length > 60) 段 = 段.slice(0, 60) + '…'
    return 段
  } catch { return '' }
}

/**
 * LETTER 2026-11-15（批次494）：主人给她留的话。
 *
 * 主人在面板「她的话」页写，按天存 `给她的话/YYYY-MM-DD.md`（跟日记一样一天一页）。
 * 这个函数把**今天（和昨天，如果今天没写）**的那条带进正文。
 *
 * 措辞很重要：**只说「他写了什么」，不催她回**。
 * 主人原话：「我给她的话 她会收到 她回不回干什么 她自己决定 只是让我给她发个消息」——
 * 所以最后那句「回不回你自己定」不能省，否则就变成系统的要求了。
 *
 * 为什么放正文不放 system：正文在历史末尾、不进缓存前缀；而且 t436 E1 那个
 * 「三段注入 < 3300 字」的阈值不该被留言内容撑大。
 */
function 留言段() {
  try {
    // 走 QQ_SHARED 派生 —— t431 P3 明令 poll.js 里不许写死那个绝对前缀
    // （只有三根定义和静态 import 的说明符可以带；注释里写全了也会被它抓到）。
    const 目录 = String(process.env.QQ_SHARED || `${QQ_WS}/共享`) + '/给她的话'
    const 今 = new Date(Date.now() + 8 * 3600e3)
    const 读一天的 = (偏移) => {
      const d = new Date(今.getTime() - 偏移 * 86400e3).toISOString().slice(0, 10)
      try {
        const t = String(readFileSync(`${目录}/${d}.md`, 'utf8') || '').trim()
        return t === '' ? null : { d, t }
      } catch { return null }
    }
    const 条 = 读一天的(0) || 读一天的(1)
    if (!条) return ''
    const 上限 = 600
    const 文 = 条.t.length > 上限 ? 条.t.slice(0, 上限) + '…（后面还有，想看全文读 给她的话/' + 条.d + '.md）' : 条.t
    return `[他给你留的话] ${条.d}：${文}\n（回不回、怎么回、要不要因此做点什么，你自己定 —— 他没有要求你回。）`
  } catch { return '' }
}

/**
 * CACHE_STATIC 2026-11-14（批次484）：把原来挂在 system 末尾的三段慢变体感
 * （stateHintOf + voiceHintOf + extraSlotsHint，实测合计 3008 字、含「现在北京时间 21:22」）
 * 搬进**正文**，让 system 变成纯静态。
 *
 * 为什么：system 在上下文最前面，它一变，后面 3~6 万 token 的 Prefix Cache 全部作废。
 * 实测今天 3-6 万区间 845 次请求里 system 变了 214 次，这些次的全额计费 652 万 token
 * （占今天全额计费的绝大部分）。批次301 用「10 分钟分桶」缓解过，但桶边界一到照样全废。
 *
 * 代价：正文每轮多约 3000 字 —— 正文本来就在历史末尾、不进缓存前缀，所以是零额外成本。
 *
 * 幂等：`状态进正文` 关着时 buildVoiceText 照旧拼 system，这个函数不会被调用。
 */
/**
 * 梦余味提示每天每会话只提一次（2026-11-17 批次633）。
 * voiceSlots 的槽是只读纯函数，不能在里面写状态；这里在注入层做一个小去重档。
 * 写不上就照常给提示 —— 去重失败不能把提示吞掉。
 */
export function 梦余味提示去重(extra, { memDir = MEM, scope = 'private', now = Date.now() } = {}) {
  const s = String(extra || '')
  // HUMANIZE 2026-11-17（批次665）：梦余味槽改成直接递标签，判据同步改成「行首 [梦]」。
  const 梦行 = /^\[梦\]/m
  if (!梦行.test(s)) return s
  try {
    const day = new Date(Number(now) + 8 * 3600e3).toISOString().slice(0, 10)
    const p = `${memDir}/梦余味-提示.json`
    let db = null
    try { db = JSON.parse(readFileSync(p, 'utf8')) } catch { db = null }
    if (db === null || typeof db !== 'object' || db.date !== day) db = { date: day, scopes: {} }
    if (db.scopes === null || typeof db.scopes !== 'object' || Array.isArray(db.scopes)) db.scopes = {}
    if (db.scopes[scope]) {
      return s.split('\n').filter((l) => !/^\[梦\]/.test(l)).join('\n').trim()
    }
    db.scopes[scope] = Number(now)
    const tmp = p + '.tmp-' + process.pid
    fs.writeFileSync(tmp, JSON.stringify(db), 'utf8')
    fs.renameSync(tmp, p)
  } catch { /* 去重失败就照常注入 */ }
  return s
}

function 慢变段(t) {
  let s = ''
  try {
    s += String(stateHintOf({ text: '', history: [], peerUin: String(t.peer), isPrivate: t.isPrivate }) || '')
  } catch { /* 状态段坏了，下面两段照走 */ }
  try {
    s += String(voiceHintOf ? voiceHintOf(String(t.peer), { isPrivate: t.isPrivate }) : '')
  } catch { /* 说话段坏了，体感槽照走 */ }
  try {
    const extra = 梦余味提示去重(String(extraSlotsHint({
      peer: String(t.peer),
      ownerUin: String(t.ownerUin ?? ''), // 由调用方传（那两个函数里本来就有 config 局部变量，省一次 getConfig()）
      isPrivate: t.isPrivate,
      mute: false,
      lastText: '',
      memDir: MEM
    }) || ''), { memDir: MEM, scope: t.isPrivate ? 'private' : 'group:' + String(t.peer) })
    if (extra !== '') s += (s === '' || s.endsWith('\n') ? '' : '\n') + extra
  } catch { /* 槽出错只丢自己，不影响基础状态 */ }
  return s
}

/**
 * 自动回忆段（批次 663，审计 P1-8）。
 *
 * 629 把自动回忆塞在 `慢变段()` 里，而 `慢变段()` 只在 `状态进正文 === true`
 * 时才被调用。`状态进正文` 本来是「状态提示放正文还是 system」的缓存开关，
 * 跟「要不要翻旧记录」毫无关系 —— 一旦为了省 token 把它关掉，自动回忆、
 * 梦余味、体感槽会一起静默消失，日志里也不会说一句。
 *
 * 现在把它拆成独立入口，调用方在状态开关外面单独调一次：
 *   - 仍然只对「主人私聊」生效（群聊注入等于把私聊日记/梦给别人看）；
 *   - 仍然只在消息命中回溯线索时才扫（由 自动回忆.mjs 自己判）；
 *   - 每回合最多一次，最多 2 条 / 360 字（自动回忆.mjs 的默认上限）。
 */
function 自动回忆条(batch, config, sessionId) {
  try {
    const refs = []
    const r = 生活记忆条(batch, config, sessionId, { mem: MEM, onPicked: item => refs.push(item) })
    if (r) note('recall', `自动回忆命中：${r.length} 字`)
    return r ? { text: r, refs } : null
  } catch {
    // 回忆坏了不影响本轮回复
    return ''
  }
}

export function stateHintOf(opts = {}) {
  // DEADCODE_FIX 2026-11-07（批次206）：函数体内 [F] 段原来引用了两个不存在的变量
  // （text 在「顺手接他的口」、history 在「刚才问过一句没得到回话」），
  // 每次运行必抛 ReferenceError 被外层 catch 静默吞掉 —— 那两段临场提示从来没产出过。
  // 现在从可选参数取：无参调用时默认空，行为与修复前完全一致（都是不出提示），
  // 但不再抛错；投递路径由 stateVoice 递当轮消息文本进来，让这两段真正活过来。
  const { text = '', history = [] } = opts || {}
  let __selectedMoment = null
  const __ownerUin = String(getConfig()?.ownerUin || getConfig()?.peerUin || '').trim()
  const __audience = stateHintRecipient({ peerUin: opts?.peerUin, isPrivate: opts?.isPrivate }, __ownerUin)
  // 这段按 A~G 分成七层，改哪层找哪层：
  //   A 底子（精力/心情/睡眠/好感/温度/别扭/谎言/身体/余波）
  //   B 关系温度（好感×熟悉 + 当下滤镜）
  //   C 人味（八类里按状态挑）
  //   D 说话的样（口癖/偏好/讨厌）＋ 句子手感
  //   E 记忆线索（想要/欠账/怨/思念/来历/学习笔记）
  //   F 临场提示（镜像用词/接情绪/记得的瞬间/回头说/惦记未答）
  //   G 入口（能给自己长东西）
  // 2026-11-01：阈值走参数表，别写死在代码里（改一个数字不用翻文件）。
  // OCAI 2026-11-02：合并读取 参数.json 的「阈值」与「拟人」段，统一用 T(名, 默认值) 读取所有联动参数与阈值
  let PRM = {}
  try {
    for (const prmPath of [`${TOOLS}/参数.json`, 'B:/肥鱼/工具/参数.json']) {
      if (existsSync(prmPath)) {
        const _pj = 快读Json(prmPath)
        PRM = { ...(_pj?.['阈值'] || {}), ...(_pj?.['拟人'] || {}) }
        break
      }
    }
  } catch { /* 用下面的默认 */ }
  const T = (k, d) => (PRM && Number.isFinite(Number(PRM[k])) ? Number(PRM[k]) : d)

  const candidates = [`${MEM}/状态.json`, 'B:/肥鱼/记忆/状态.json']
  for (const p of candidates) {
    try {
      if (!existsSync(p)) continue
      const j = JSON.parse(cachedStateRead(p, 'utf8'))
      const energy = Number(j?.energy)
      const mood = String(j?.mood?.label ?? '').trim()
      const intensity = j?.mood?.intensity
      const parts = []
      if (Number.isFinite(energy)) parts.push(`精力 ${energy}/100`)
      // HUNGER 2026-11-06（批次139）：饿不饿必须让她自己知道。
      // 在这之前她只能从「累不累」猜 —— 累不是饿，两件事在她身上长得很像：
      // 2026-11-06 她精力 12、困意 71，系统判「该去吃点东西」，其实她两小时前刚吃过。
      try {
        if (饥饿) {
          const hg = 饥饿.读()
          // HINT_SATIETY 2026-11-17（批次600）：把「当下饿不饿」和「长期热量」分开说。
          // 只改陈述，不加「你该吃」；吃不吃仍由她自己定。
          const 饱感 = Math.round(Number(hg.饱腹感) || 0)
          const 热量 = Math.round(Number(hg.饱腹) || 0)
          const 胃里 = Math.round(Number(hg.临时) || 0)
          parts.push('肚子 ' + 饱感 + '/100（' + 饥饿.标签(饱感) + '；胃里 ' + 胃里 + '%，热量 ' + 热量 + '%）')
          // THIRST_HINT 2026-11-07：主人原话「我总不可能每天看你喝没喝水吧」——
          // 渴和饿一样，每轮都摆在她眼前；低到一半以下就直接提示该找水。
          const 水百 = Math.round(Number(hg.水百分比) || 0)
          // THIRST_WORDS 2026-11-07（批次220）：跟 饱渴.渴话 对齐（主人定的 75 渴 / 50 很渴 / 0 渴死）
          const 渴话 = 水百 >= 85 ? '不渴' : 水百 >= 75 ? '有点渴' : 水百 >= 50 ? '渴了' : 水百 >= 25 ? '很渴' : '快渴死了'
          // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-7）：数值和「渴了」是事实，
          // 「该找水喝」是替她下动作决定，删掉。
          parts.push('渴 ' + 水百 + '%（' + 渴话 + '）')
          // DISEASE 2026-11-07（批次221）：病也是身体事实，每轮都摆在她眼前。
          // 话术只陈述（鼻子堵、发晕），不写「你该休息」—— 想法归她自己（见 功能档案·两条通道）。
          const 病行 = 疾病 ? 疾病.体感行() : ''
          if (病行) parts.push(病行)
        }
      } catch { /* 读坏了就少一行 */ }
      if (mood !== '') parts.push(`心情「${mood}」`)
      // WAKE_GRUMP 2026-11-16（批次567）：深睡里被硬叫醒之后那一小段，得让她自己知道
      // （不然她只看到一个莫名很低的 intensity，会当成「我今天就是烦」）。
      // 传的是 状态.json 里的 起床气（已还=false 才没过期），一句话，不带任何台词。
      try {
        const 气话 = 起床气话(j && j['起床气'])
        if (气话) parts.push(气话)
      } catch { /* 少一行不影响别的 */ }
      // 2026-11-01：四层能量——一个总精力数说不清为什么累
      try {
        const L = j?.layers
        // LAYERS_TRUTH 2026-11-16（批次571）：去掉「存在」这个裸数字。
        // existential 不进 精力()（它只当长期心气），她拿到「存在 55.4」也不知道该拿它干什么 ——
        // 每轮递一个自己用不上的数，等于教她复述。心气的真正出口（语气/主动性）另开一批。
        // LAYER_FMT 2026-11-17（批次649 顺带）：这里原来直接拼裸值。状态档里一旦是
        // `20.799999999999997`（浮点减法的结果），整段注入就带 15 位数字 ——
        // t421 的「一个 8 位数字都没有」当场红，而且她读到这种数只会复述。
        // 四舍五入到 1 位，顺手挡住 NaN/Infinity。
        const __n1 = (x) => (Number.isFinite(Number(x)) ? String(Math.round(Number(x) * 10) / 10) : '?')
        if (L && Number.isFinite(Number(L.physical))) parts.push('分层 生理' + __n1(L.physical) + '/情绪' + __n1(L.emotional) + '/认知' + __n1(L.cognitive))
        const drv = j?.mood?.drive
        if (drv) parts.push('驱动 ' + (drv === 'anxious' ? '焦虑撑着' : drv === 'eager' ? '有兴趣' : '平稳'))
        // LAYERS_TRUTH（批次571）：顺手删掉读 j.loop 的那个分支 —— 这个字段全仓没有写方，
        // 从上线起就没进过注入（面板那边也删了同一行）。
        // 2026-11-01：梦可以忘，但睡了多少必须记住——她得知道自己昨晚睡得怎么样
        try {
          const sp = `${MEM}/睡眠.json`
          if (fs.existsSync(sp)) {
            const sd = JSON.parse(cachedStateRead(sp, 'utf8'))
            const rec = (sd.records || []).slice(-1)[0]
            // SLEEP_FIELDS_FIX 2026-11-05（批次102）：记录里是 start/end/quality/deep_min，
            // 没有 hours 也没有 score —— 原来直接把 rec.hours / rec.score 拼进正文，
            // 她每轮都读到「昨晚睡了 undefined 小时（undefined 分）」。能算就算，算不出就不提。
            if (rec) {
              // SLEEP_SECONDS_FIX：睡眠段的 start/end **带秒**（`2026-11-04 01:00:01`），
              // 照别处 `+':00+08:00'` 的写法会拼成 `01:00:01:00+08:00` → NaN → 整句消失。
              // 只有「到分钟」的字符串才补秒。
              const __ms = (v) => {
                const t = String(v || '').trim().slice(0, 19).replace(' ', 'T')
                if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(t)) return 0
                const norm = t.length === 16 ? t + ':00' : t
                const x = Date.parse(norm + '+08:00')
                return Number.isFinite(x) ? x : 0
              }
              const __a = __ms(rec.start)
              const __b = __ms(rec.end)
              const __h = Number.isFinite(Number(rec.hours)) ? Number(rec.hours)
                : (__a > 0 && __b > __a ? Number(((__b - __a) / 3600e3).toFixed(1)) : 0)
              const __q = Number.isFinite(Number(rec.score)) ? Number(rec.score)
                : (Number.isFinite(Number(rec.quality)) ? Math.round(Number(rec.quality) * 100) : null)
              // SLEEP_WORD_FIX 2026-11-14（批次447）→ HUMANIZE 2026-11-17（批次676，
              // 拟人化红线 P1-8）：原来把睡眠分翻译成「睡得很沉/还行/浅/很碎」。
              // 分数是事实，形容词是代码替她下的定性；现在只报睡眠质量百分比。
              // score 两种量纲都见过（0~1 与 0~100），<=1 的一律当比例换算。
              const __睡分 = (分) => {
                const p = Number(分) <= 1 ? Number(分) * 100 : Number(分)
                return Math.round(p)
              }
              // STRAIN_HINT 2026-11-16（批次568）：连着几晚没睡好，她自己得知道 ——
              // 不然认知上不去只会以为「今天不行」，不知道是作息欠的债。
              try {
                const 熬话 = 熬夜话(sd['熬夜账'])
                if (熬话) parts.push(熬话)
              } catch { /* 少一行不影响别的 */ }
              if (__h > 0) {
                parts.push('昨晚睡了 ' + __h + ' 小时' +
                  (__q === null ? '' : '（睡眠质量 ' + __睡分(__q) + '%' + (rec.woke === true ? '，被吵醒过' : '') + '）'))
              }
            }
          }
        } catch { /* 没记录就不提 */ }
      } catch { /* 旧格式照旧 */ }
      // 2026-11-01 肥鱼：顺带把「对主人」的好感度并进来（松紧开关，不是甜度）
      try {
        // OCAI 2026-11-02：ESM 禁用 require，改为使用顶部导入的 fs，并在同函数内预读 怨/偏好/想要.json 以合并重复同步 I/O
        const fs2 = fs
        let _cachedYj = undefined, _cachedPf = undefined, _cachedWj = undefined
        const readYjOnce = () => {
          if (_cachedYj === undefined) {
            const p = `${MEM}/怨.json`
            _cachedYj = fs2.existsSync(p) ? JSON.parse(fs2.readFileSync(p, 'utf8')) : null
          }
          return _cachedYj
        }
        const readPfOnce = () => {
          if (_cachedPf === undefined) {
            const p = `${MEM}/偏好.json`
            // RETIRE 2026-11-07（批次183）：作废的偏好不再进上下文。
            // 放在这个唯一读入口 —— 下面三处（1264/1421/1501）都从这儿拿，改一处全覆盖。
            _cachedPf = fs2.existsSync(p) ? 剔掉作废偏好(JSON.parse(fs2.readFileSync(p, 'utf8'))) : null
          }
          return _cachedPf
        }
        const readWjOnce = () => {
          if (_cachedWj === undefined) {
            const p = `${MEM}/想要.json`
            _cachedWj = fs2.existsSync(p) ? JSON.parse(fs2.readFileSync(p, 'utf8')) : null
          }
          return _cachedWj
        }
        const aff = `${MEM}/好感度.json`
        if (fs2.existsSync(aff)) {
          const db = JSON.parse(cachedStateRead(aff, 'utf8'))
          const rec = db?.people?.['1000000002']
          if (rec) {
            const sc = Number(rec.score)
            const label = sc >= T('好感_亲近', 80) ? '亲近' : sc >= T('好感_熟', 55) ? '熟' : sc >= T('好感_平常', 35) ? '平常' : '疏远'
            if (__audience.ownerPrivate) parts.push('对主人 ' + sc + ' 分（' + label + '）')
            // 2026-11-02 AUTO_STATE_HOOK：她这会儿在干嘛（发呆/摸鱼/走动…），别让她自己都不知道
            try {
              const autP = `${MEM}/自主.json`
              if (fs2.existsSync(autP)) {
                const aut = 快读Json(autP) // FS_CACHE 2026-11-07（批次210）：同回合已读过的档走 mtime+size 缓存
                if (aut && aut.state) {
                  // 2026-11-19：旧的复习结果可能含别的聊天的词义，保留档案但不复述。
                  const 原活动详情 = String(aut.last?.note ?? '')
                  const 上次活动详情 = aut.last?.what === '琢磨黑话' || 原活动详情.includes('翻了翻黑话本：') ? '' : 原活动详情
                  const mins = aut.since ? Math.round((Date.now() - aut.since) / 60000) : 0
                  // STATE_WORD_FIX：说清这是「状态文件/面板」记着的，别让她当成「你在说我坏话」
                  const 解释 = {
                    发呆: '手头没在忙，正在走神',
                    刷手机: '在刷手机',
                    玩电脑: '在电脑前',
                    摸鱼: '手头没在忙，随便翻东西',
                    走动: '正从一个地方往另一个走',
                    学点东西: '在翻自己的小抄',
                    翻旧账: '在想以前的事',
                    琢磨黑话: '在琢磨群友说的话',
                    打瞌睡: '困得在打盹',
                    逛贴吧: '在贴吧翻帖子，一轮就读那么几个',
                    看B站: '在看视频，一轮看一个',
                    拍张照: '刚拍了张照片',
                    吃点东西: '在吃东西',
                    买东西: '在街上买东西',
                    打工: '在打工',
                    逛街: '在街上逛',
                  }
                  // FORM_HINT 2026-11-05：这段原来只说「你正在做什么」。问题是动作和地点
                  // 分属两套文件（自主.json / 资产.json），拼出来是两句互不相干的话：
                  //   「你自己这会儿在『逛贴吧』，已经 49 分钟」
                  //   「人在便利店，包里带着水杯，兜里有 30 块」
                  // 主人说「别在便利店逛太久」，她只能把两个「逛」缝起来，答成「看货架看得太入迷」。
                  // 现在分三种情况说：做完了 / 正在做持续的事 / 正在做线上的事。
                  // 引用 在干嘛.mjs 的那一份，不许再手写 —— 写第二份就一定分叉（这就是第 5 处）
                  const 一次性 = 一次性动作
                  const 线上 = new Set(['逛贴吧', '看B站', '学点东西', '翻旧账', '发呆', '摸鱼', '打瞌睡', '刷手机', '玩电脑'])
                  const 做完 = 一次性.has(aut.state) && Number(aut.doneAt || 0) > 0 &&
                    (Date.now() - Number(aut.doneAt)) > 3 * 60e3
                  if (做完) {
                    // 做完了就别再报「已经 N 分钟」——那会让她把几十秒的事说成一两个小时
                    const 何时 = String((aut.last && aut.last.at) || '刚才')
                    // NOTE_TAIL 2026-11-05（批次103）：note 是「买了 一顿正经饭，花 28 块，剩 616。
                    // 困意 -6；心情 +4；」这种拼接串，尾巴带分号。原来只剥句号，正文里就出现
                    // 「心情 +4；。这件事已经做完了」。把所有尾随标点一起去掉。
                    const 读了啥 = 上次活动详情 ? '——' + 上次活动详情.slice(0, 110).replace(/[。.；;，,、\s]+$/, '') : ''
                    // CONTENT_FEEL 2026-11-05（批次87）：她自己写完那个词记下的反应。
                    // 只报「当时心里什么样」，不解释成「所以你现在开心/难过」——
                    // 那一下是几十分钟前的事，激素早衰减了，硬接成现在的情绪就是假的。
                    const 心里啥 = (aut.last && aut.last.feel) ? '，心里' + String(aut.last.feel).slice(0, 12) : ''
                    // HUMANIZE 2026-11-17（批次665，拟人化红线 P0-1）：原来这里给的是
                    // 「别人问你在忙什么，说「刚做完，现在闲着」就行」。只递事实：
                    // 做了什么、什么时候、已经结束、现在没在忙；怎么回答由她自己定。
                    parts.push('你上一次自己做的事（' + 何时 + '）：' + String((aut.last && aut.last.what) || aut.state) + 读了啥 + 心里啥 +
                      '。这件事已经做完了，现在手头没在忙，也没有正在计时的活儿' +
                      (心里啥 ? '。那个感觉是你当时的' : ''))
                  } else {
                    // HUMANIZE 2026-11-17（批次665）：去掉「问忙不忙照实说」——这是命令，不是事实。
                    parts.push('你自己这会儿在「' + aut.state + '」' + (解释[aut.state] ? '（' + 解释[aut.state] + '）' : '') +
                      (mins > 0 ? '，已经 ' + mins + ' 分钟' : ''))
                    // LAST_DONE_HINT 2026-11-05：上一轮具体做了什么、读到了什么，只记最后一次。
                    // 没有这句，她只知道「在逛贴吧」，说不清读了什么，就会拿别处看来的东西顶——
                    // 15:10 那次她聊的是孙吧的旧梗，可那一轮读的是 deepseek 吧。
                    // LAST_FRESH 2026-11-05（批次86）：`last` 只在有 note 时才写，
                    // 「发呆」那几轮不动它 —— 15:57 拍完照，能被念成「刚做完」到晚上七点半，
                    // 她就跟人讲「我刚拍了张照」。超过 90 分钟就不叫「刚做完」了，这条不提。
                    const __lastAt = Date.parse(String((aut.last && aut.last.at) || '').replace(' ', 'T') + '+08:00')
                    const __lastFresh = Number.isFinite(__lastAt) && (Date.now() - __lastAt) <= 90 * 60e3
                    // FUTURE_NOT_DONE 2026-11-17（批次678）：doneAt 还在未来 = 这件事正在做，
                    // 不能写成「刚做完 / 已做完」。19:47 她那顿 25 分钟的饭刚坐下，
                    // 注入却写「刚做完的一件事（19:47）：吃饭——在家吃了一顿正经饭（25 分钟）。已做完」，
                    // 她把还没走完的时间当成已经过去，跟主人讲「八点半才醒、点了顿饱饭」。
                    const __doneAt = Number(aut.doneAt || 0)
                    const __doing = __doneAt > Date.now() + 60e3
                    if (上次活动详情 && __lastFresh && !一次性.has(aut.state) && !__doing) {
                      parts.push('刚做完的一件事（' + String(aut.last.at || '') + '）：' + String(aut.last.what || '') + '——'
                        // HINT_TRIM 2026-11-07（批次185）：note 原文开头是「[2026-11-07 14:01:01 洗澡.mjs] 」
                        // ——脚本名 + 时间戳进了她的自我认知。去掉前缀，长度 110→60。
                        + 上次活动详情.replace(/^\[[^\]]*\]\s*/, '').slice(0, 60).replace(/[。.；;，,、\s]+$/, '')
                        + ((aut.last.feel) ? '，心里' + String(aut.last.feel).slice(0, 12) : '')
                        + '。已做完')
                    } else if (__doing && aut.last && aut.last.what) {
                      const __到点 = new Date(__doneAt + 8 * 3600e3).toISOString().slice(11, 16)
                      parts.push('你正在做「' + String(aut.last.what) + '」，预计 ' + __到点 + ' 结束（还没做完）')
                    }
                  }
                  // ONLINE_HINT 2026-11-05：治「看货架」。
                  // 「逛贴吧」的「逛」是虚拟的，「在便利店」是实体的，中文里这两个「逛」长得一样，
                  // 她就会答成在翻货架。系统从来没告诉过她这一层，只说「你在逛贴吧」。
                  // HUMANIZE 2026-11-17（批次665，拟人化红线 P0-1）：删掉「说「找个角落坐着看手机」就行」。
                  // 事实是「线上动作发生在屏幕里，跟脚下地点无关」；她可以答在刷手机，也可以答别的。
                  if (线上.has(aut.state)) {
                    parts.push('「' + aut.state + '」是在手机/本子上做的事，跟脚下的地方没关系——'
                      + '你现在人在哪不影响这件事发生在屏幕里，便利店的货架货品一样都没碰')
                  }
                }
              }
            } catch { /* 忽略 */ }

            // SHOWER_HINT 2026-11-05（批次101）：洗澡是批次89 新加的行为，面板看得见，
            // 对话侧却一个字都没读 —— 她洗完头发湿着 25 分钟，被问「在干嘛」只能说别的，
            // 主人问「你头发怎么湿的」她答不上来。这里只递事实：在洗 / 刚洗完还湿着。
            try {
              const hyP = `${MEM}/卫生.json`
              if (fs2.existsSync(hyP)) {
                const hy = JSON.parse(fs2.readFileSync(hyP, 'utf8'))
                const __washEnd = Date.parse(String(hy?.洗澡中?.结束 || '').replace(' ', 'T') + ':00+08:00')
                const __hairEnd = Date.parse(String(hy?.['头发湿到'] || '').replace(' ', 'T') + ':00+08:00')
                if (Number.isFinite(__washEnd) && __washEnd > Date.now()) {
                  const __left = Math.max(1, Math.round((__washEnd - Date.now()) / 60000))
                  parts.push('你正在' + String(hy?.洗澡中?.在哪 || '家') + '洗澡，还有 ' + __left + ' 分钟出来（手上是水，回消息慢一点很正常）')
                } else if (Number.isFinite(__hairEnd) && __hairEnd > Date.now()) {
                  const __mm = new Date(__hairEnd + 8 * 3600e3)
                  const __hhmm = String(__mm.getUTCHours()).padStart(2, '0') + ':' + String(__mm.getUTCMinutes()).padStart(2, '0')
                  // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-10）：头发什么时候干
                  // 来自 卫生.json，是事实；「毛巾还搭在肩上」没有数据源，删掉。
                  parts.push('你刚洗完澡，头发还湿着（大概 ' + __hhmm + ' 才干）')
                }
              }
            } catch { /* 没在洗就不提 */ }

            // EAT_HINT 2026-11-06（批次144）：坐下来吃的时候她得知道这段走不开。
            // 「吃」以前是一瞬间的事，现在占 8~55 分钟；不说清楚，
            // 别人问「你在哪」她答「在餐厅」，下一句「那你怎么还不走」就接不上。
            try {
              const fanP = `${MEM}/吃饭.json`
              if (fs2.existsSync(fanP)) {
                const fan = JSON.parse(fs2.readFileSync(fanP, 'utf8'))
                const __eatEnd = Date.parse(String(fan?.到 || '').replace(' ', 'T') + ':00+08:00')
                if (Number.isFinite(__eatEnd) && __eatEnd > Date.now()) {
                  const __left2 = Math.max(1, Math.round((__eatEnd - Date.now()) / 60000))
                  const __动词 = 吃喝动词(fan.吃啥 || '东西')
                  parts.push('你正坐在' + String(fan.在哪 || '家') + __动词 + String(fan.吃啥 || '东西')
                    + '，还有 ' + __left2 + ' 分钟（得' + __动词 + '完再走，走开就凉了）')
                }
              }
            } catch { /* 没在吃就不提 */ }

            // 2026-11-02 PLACE_HOOK：她在哪儿、手边有什么，一句话带过去
            try {
              const assetsP = `${MEM}/资产.json`
              if (fs2.existsSync(assetsP)) {
                const a = 快读Json(assetsP) // FS_CACHE 批次210
                { const __pl = 位置提示(a); if (__pl !== '') parts.push(__pl) }
                // GO_HINT 2026-11-06（批次106）：给她腿，也告诉她腿长在哪。
                // 原来 15 个工具里没有一个能让她动，她只能在嘴上答应「这就走」，
                // 面板上人还站在便利店 —— 主人一眼看穿「嘴上说着 实际没动」。
                // 现在有 qq_go 了，但新能力不进提示等于没有这条路。
                // 只在没在途的时候提：在途时上面那句已经说了「还剩 N 分钟」。
                try {
                  const __途2 = a['在途']
                  const __走2 = !!(__途2 && __途2.arriveAt && Date.now() < Number(__途2.arriveAt))
                  if (!__走2) {
                    // HINT_TRIM 2026-11-07（批次185）：只留指令，去掉「只嘴上说走了人还站在原地…一眼就穿」的展开
                    parts.push('挪地方调 qq_go')
                  }
                } catch { /* 旧数据没有在途字段就不提 */ }
                // PHOTO_HINT 2026-11-06（批次109）：她有快门，但提示里一个字没提。
                // 主人这次要的就是这个 —— 她得先知道自己有这条路，才会在
                // 「拍张照我看看」的时候真去按，而不是嘴上答应「我拍给你看」。
                // 只说「有这条路」和「这一轮发不出去」这两件事实，不指挥她拍什么。
                try {
                  const __刚 = 快门刚按过()
                  parts.push(__刚
                    ? '刚按过快门（' + String(__刚.id || '') + '），这张还在出 —— 别连按，等它出来'
                    // HINT_TRIM 2026-11-07（批次185）：意思不变，去掉「他那边相册一直没新照片一眼就看穿」的展开
                    : '想拍调 qq_photo（几分钟出图后再用 qq_send images 发）')
                } catch { /* 读不到快门记录就不提 */ }
                // TODAY_LOG 2026-11-06（批次106）：她做过的事只在账本里，注入一个字都没读。
                // 00:12 缺口抽到「挣」，干了便利店夜班、赚 150 块；主人贴账本问
                // 「什么？！你在打夜班」，她答「没打工，你这一惊一乍的」——
                // 账一贴上，她只能改口「我记岔了，丢人」。
                // 不是她撒谎：账在 资产.记录 里，她真没看过。只递今天的最近几条，事实陈述。
                try {
                  const __记 = Array.isArray(a['记录']) ? a['记录'] : []
                  const __d = bjDayKey()
                  const __今 = __记
                    .filter((r) => r && String(r.at || '').startsWith(__d))
                    .slice(-6)
                  if (__今.length) {
                    parts.push('[今天已做] ' + __今.map((r) => String(r.at || '').slice(11) + ' ' + String(r.what || '').slice(0, 32)).join('｜') + '（账上没有的别编）')
                  }
                } catch { /* 没账本就不提 */ }

                // WORK_HINT 2026-11-06（批次112）：她有班要上，提示里一个字都没有。
                // 22:00 有夜班，人却在家睡着；被问起只会说「我在家啊」——
                // 因为没人告诉过她今天有班、几点、扣了多少。这里只递事实，不说"快去上班"：
                // 去不去是她的事，扣钱是老板的事，两件事分开。
                try {
                  const __工 = JSON.parse(fs2.readFileSync(`${MEM}/工作.json`, 'utf8'))
                  const __n = Date.now()
                  const __ts2 = (s) => Date.parse(String(s).replace(' ', 'T') + '+08:00')
                  const __今2 = bjDayKey()
                  const __班们 = (Array.isArray(__工.班次) ? __工.班次 : [])
                    .filter((b) => b && (String(b.起 || '').startsWith(__今2) || String(b.止 || '').startsWith(__今2)))
                    .map((b) => ({ b, 起: __ts2(b.起), 止: __ts2(b.止) }))
                    .filter((x) => Number.isFinite(x.起) && Number.isFinite(x.止))
                  // 只说她此刻最该知道的那一条，别把一天的班次全铺开。
                  const __在岗 = __班们.find((x) => String(x.b.状态) === '在岗' && __n < x.止)
                  const __迟到 = __班们.find((x) => __n >= x.起 && __n < x.止 && String(x.b.状态) !== '在岗' && String(x.b.状态) !== '完成')
                  const __快到 = __班们.find((x) => __n < x.起 && x.起 - __n <= 3600e3 && !['完成', '缺勤', '辞退'].includes(String(x.b.状态)))
                  const __时 = (x) => String(x.b.起).slice(11) + '-' + String(x.b.止).slice(11)
                  if (__在岗) {
                    const __剩 = Math.max(1, Math.round((__在岗.止 - __n) / 60000))
                    parts.push('[班] 你在' + __在岗.b.点 + '上班（' + __在岗.b.活 + '，' + __时(__在岗) + '），'
                      + (__剩 >= 60 ? (__剩 / 60).toFixed(1) + ' 小时' : __剩 + ' 分钟') + '后下班'
                      + (Number(__在岗.b.扣) > 0 ? '；这一班已经被扣了 ' + __在岗.b.扣 + ' 块' : '')
                      + '。现在人就在店里，得待到下班；钱是下班那一刻按你在岗的时间一起结的，中途走开的那段不算')
                  } else if (__迟到) {
                    const __迟 = Math.round((__n - __迟到.起) / 60000)
                    parts.push('[班] ' + __时(__迟到) + ' 在' + __迟到.b.点 + '有班（' + __迟到.b.活 + '），'
                      + '已经过了 ' + __迟 + ' 分钟还没到岗'
                      + (Number(__迟到.b.扣) > 0 ? '，扣了 ' + __迟到.b.扣 + ' 块' : '')
                      + '。从' + String((快读Json(`${MEM}/资产.json`).位置) || '家') + '过去要走路')
                  } else if (__快到) {
                    const __差 = Math.max(1, Math.round((__快到.起 - __n) / 60000))
                    parts.push('[班] 今天 ' + __时(__快到) + ' 在' + __快到.b.点 + '有班（' + __快到.b.活 + '），还有 ' + __差 + ' 分钟到点')
                  } else {
                    const __完 = __班们.filter((x) => String(x.b.状态) === '完成').slice(-1)[0]
                    const __缺 = __班们.filter((x) => String(x.b.状态) === '缺勤').slice(-1)[0]
                    if (__完) parts.push('[班] ' + __时(__完) + ' 的' + __完.b.活 + '下过班了，到手 ' + Number(__完.b.实发 || 0) + ' 块')
                    else if (__缺) parts.push('[班] ' + __时(__缺) + ' 的' + __缺.b.活 + '整班没去，记了缺勤')
                  }
                  if (Number(__工.信用) < 100) {
                    parts.push('[班] 你在店里的信用 ' + Number(__工.信用) + '/100（睡岗 -3、迟到 -1、缺勤 -10），掉到 0 会被辞')
                  }
                } catch { /* 没工作档案就不提 */ }
                // PLACE_CAP 2026-11-05（批次79）：这个点开不开、这儿能干什么。
                // 在途就别推「这个点这儿能干什么」了 —— 马上要走，说了她会在原地想买东西。
    // 到了之后下一轮自然会推。
    {
      const __途 = a['在途']
      const __在走 = !!(__途 && __途.arriveAt && Date.now() < Number(__途.arriveAt))
      const __loc = __在走 ? '' : 地点提示(a['位置'])
      if (__loc !== '') parts.push(__loc)
    }
                // WEATHER_CAP 2026-11-05（批次79）：窗外什么天。
                try {
                  const __w = 快读Json(`${MEM}/天气.json`)
                  const __wt = 天气提示(__w)
                  if (__wt !== '') parts.push(__wt)
                  // SEASON_HOOK 2026-11-05（批次82）：季节和物候，紧跟在天气后面。
                  // 只读 天气.json 里已经算好的字段，不在这里再算一遍季节 ——
                  // 两处各算一份，迟早会不一致，而且不一致是静默的。
                  const __se = 季节提示(__w)
                  if (__se !== '') parts.push(__se)
                } catch { /* 没有天气文件就不提 */ }
                // ITEM_HOOK 2026-11-05：伞和借来的东西
                try {
                  const 物件P = `${MEM}/物品.json`
                  const 天气P2 = `${MEM}/天气.json`
                  const 物件档 = fs2.existsSync(物件P) ? 快读Json(物件P) : { items: [] }
                  const 天气档 = 快读Json(天气P2) // FS_CACHE 批次210
                  const __it = 物件提示(物件档, 天气档, a['位置'])
                  if (__it !== '') parts.push(__it)
                } catch { /* 物品读不到就跳过，别影响说话 */ }
              }
            } catch { /* 忽略 */ }
            // 2026-11-02 ROOM_SAY_HOOK：主人在 3D 房间里对她说过的话，
            // 2026-11-19：只有主人私聊能带出未读留言并标记已读。
            try {
              const roomP = `${MEM}/房间对话.json`
              if (__audience.ownerPrivate && fs2.existsSync(roomP)) {
                const rd = JSON.parse(fs2.readFileSync(roomP, 'utf8'))
                const items = rd.items || []
                const unread = items.filter((x) => !x.read).slice(-2)
                for (const it of unread) parts.push('房间：他在屋里对你说「' + String(it.text).slice(0, 30) + '」')
                if (unread.length > 0) {
                  // ROOM_READ_FIX 2026-11-03：只标记真的进提示的那两条，积压的留到下一轮再说
                  for (const it of unread) it.read = true
                  fs2.writeFileSync(roomP, JSON.stringify(rd, null, 2))
                }
              }
            } catch { /* 忽略 */ }
            // CATCHUP 2026-11-07（批次190）：醒来第一轮把睡着时群里的动静递给她。
            // 只递一次：递完置已用（原子写回）。读不到/已用就安安静静跳过。
            try {
              const cp = `${MEM}/醒来看到.json`
              if (fs2.existsSync(cp)) {
                const d = JSON.parse(fs2.readFileSync(cp, 'utf8'))
                if (d && d['已用'] !== true) {
                  const 行 = 补课一行(d)
                  if (行) {
                    parts.push(行)
                    d['已用'] = true
                    const __tmp = cp + '.tmp-' + process.pid
                    fs2.writeFileSync(__tmp, JSON.stringify(d, null, 2))
                    fs2.renameSync(__tmp, cp)
                  }
                }
              }
            } catch { /* 补课读不到就不递，不影响说话 */ }
            // 2026-11-02 CHAIN_TAIL：因果链——开口前先看链尾，说完记得落一条。
            // 只追加不改，所以这里只读；写不写由她自己决定，但给她摆到眼前。
            try {
              const chainP = `${MEM}/链.md`
              if (fs2.existsSync(chainP)) {
                const raw = 快读Text(chainP)
                // CHAIN_VOID 2026-11-07（批次184）：作废的条目不再进上下文。
                // 链里有 20 条不是她的记忆（翻旧账当年从 meow 的 fact 表抽运维笔记写进来的），
                // 而这里取最后 3 条 —— 一度有 2 条是「QQ 桥部署在 VPS」「贤者云 Windows 客户端」，
                // 等于每轮都在告诉她「你脑子里装的是这些东西」。原文留在 链.md 里不动（定则①），
                // 作废表在 记忆/链-作废.json，判据按时间戳（条目唯一键）。
                const 死链 = (() => {
                  try {
                    const o = JSON.parse(fs2.readFileSync(`${MEM}/链-作废.json`, 'utf8'))
                    return new Set((o['条目'] || []).map((x) => String(x['at'] || '')))
                  } catch { return new Set() }
                })()
                // CHAIN_DEDUP 2026-11-17（批次631）：先对最近 12 条去重，再取 3 条。
                // 原来先切 3 条再合并，连续重复会把更早的不同事实挤出窗口。
                const blocks = 链尾去重(raw.split(/^## /m)
                  .filter((x) => x.trim() !== '')
                  .filter((b) => !死链.has(b.trim().slice(0, 16)) && !是旧黑话链(b))
                  .slice(-12)).slice(-3)
                if (blocks.length > 0) {
                  const brief = 链尾摘要(blocks)
                  parts.push('链尾：' + brief)
                  // 断链检查：超过一天没落，提醒一句（不是命令，是事实）
                  // CHAIN_LAST_FIX 2026-11-05（批次102）：正则带 `m` 时 `^` 匹配的是**每一行**，
                  // 但 `match` 不带 `g` 只返回第一个 —— 拿到的永远是最老那条。链最后一条是 13 小时前，
                  // 她却被告知「已经 92 小时没落了」。带 `g` 取最后一条才是「最近一次落链」。
                  const __chainMs = raw.match(/^## (\d{4}-\d{2}-\d{2} \d{2}:\d{2})/gm)
                  if (__chainMs && __chainMs.length) {
                    const m = __chainMs[__chainMs.length - 1].replace(/^## /, '')
                    const lastAt = Date.parse(m.replace(' ', 'T') + ':00+08:00')
                    const hours = Math.floor((Date.now() - lastAt) / 3600e3)
                    if (Number.isFinite(hours) && hours >= 24) parts.push('链已经 ' + hours + ' 小时没落了——断的时候不疼，得靠查账')
                  }
                }
              }
            } catch { /* 忽略 */ }
            // 2026-11-02：耐心是独立的账，不跟精力混——短期靠「别打断我」恢复，
            // 长期靠「看到变化」恢复。
            // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-5）：原来还附 waitHint /
            // longHint，直接规定她「接不接、什么时候接」；现在只报两个数。
            try {
              const pn2 = j?.耐心 || {}
              const sp = Number(pn2['短期'] ?? 60)
              const lp = Number(pn2['长期'] ?? 70)
              parts.push('耐心 短' + sp + '/长' + lp)
            } catch { /* 忽略 */ }
            if (__audience.ownerPrivate) {
            // 2026-11-01：关系档 = 好感 × 熟悉度，再叠一层「此刻的滤镜」。
            // 人不是按分数相处——心情好同一句话更亲，心情差同一句话更退；
            // 直觉、说不清那点偏、思念、怨，都会把它挪一挪。
            try {
              const me2 = (db && db.people) ? db.people['1000000002'] : null
              const fam = Number(me2?.['熟悉度'] ?? 0)
              // TIER_SMOOTH 2026-11-03：原来按 55 一刀切，54 分是「陌生人」、56 分就是「自己人」，
              // 跨过一条线态度突变，主人明确禁止。改成连续浓度：45~68 之间平滑爬坡，
              // 过渡区就是「半熟」，并且把浓度百分比告诉她，让她按比例表现而不是换个人。
              const __clamp01 = (x) => Math.max(0, Math.min(1, x))
              const __smooth = (e0, e1, x) => { const t = __clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t) }
              const hot = Number(sc) >= T('好感_熟阈值', 55) // 保留给后面逻辑用
              const close = fam >= T('好感_熟阈值', 55)
              const wWarm = __smooth(45, 68, Number(sc || 0))
              const wClose = __smooth(45, 68, fam)
              const heat = (wWarm + wClose) / 2
              // TIER_ONE_TRUTH 2026-11-17（批次659，审计 P1-3）：档位词改由 关系档.mjs 给，
              // 这里只保留「浓度」这个**连续**量（它是这一段特有的表达，别处没有）。
              // 原来这里自己判一套「自己人/半熟/认识/不太熟」，和 slotRelationBond
              // 的 [关系] 槽可能给出两个说法；现在同一个函数判档，浓度只做补充说明。
              // bond 在 关系.json，不在 好感度.json（me2 里只有 dims/熟悉度/turns）。
              // 读不到就当没有 —— 关系档 会退回好感/熟悉，不会瞎判。
              let __bond
              try {
                const __rel = 快读Json(`${MEM}/关系.json`)
                __bond = __rel?.people?.['1000000002']?.bond
              } catch { __bond = undefined }
              const 判2 = 关系档({ 好感: Number(sc || 0), 熟悉: fam, bond: __bond })
              const 档词 = { 熟: '自己人', 在意: '半熟，正在变熟', 一般: '认识，还客气', 还不熟: '不太熟' }
              let tier = 判2.有据 ? (档词[判2.档] || '认识，还客气') : '认识，还客气'
              const notes = []
              // TIER_SMOOTH：关系浓度（0 陌生 → 100 自己人）。
              // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-6）：只报数，
              // 不再规定「别忽然变热变冷」。
              notes.push('关系浓度 ' + Math.round(heat * 100) + '%')
              const mi3 = Number(j?.mood?.intensity ?? 0)
              const e3 = Number(j?.energy ?? 60)
              // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-6）：心情只作旁注，
              // 不再改档位词、不替她决定「今天格外亲近 / 想躲一下」。
              if (mi3 >= 1 && heat >= 0.3 && heat < 0.78) notes.push('心情顺')
              else if (mi3 <= -1 && heat >= 0.78) notes.push('心里堵')
              // 个人因素
              if (me2?.['直觉']) notes.push('第一感觉还在')
              if (Number(me2?.['说不清分'] || 0) !== 0) notes.push('说不清的偏')
              // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-6）：思念只报数，
              // 不再替她写「有点想他」。
              if (Number(me2?.['思念'] || 0) >= 3) notes.push('思念 ' + Math.round(Number(me2['思念']) * 10) / 10)
              // 怨会把它往下压
              try {
                // OCAI 2026-11-02：复用同一函数内已读的 怨.json，避免重复同步 readFileSync
                const yj = readYjOnce()
                if (yj) {
                  if (Number(((yj.people || {})['1000000002'] || {}).level || 0) >= T('怨_提门槛', 30)) notes.push('心里还有怨')
                }
              } catch { /* 忽略 */ }
              // 时间：深夜本就更容易说真话
              // 2026-11-04 修：getHours() 是机器时区（UTC），结果半夜 23 点不加「这么晚了」，
              // 早上 7 点反倒加。改成北京时间。
              const hh = bjHour()
              if (hh >= T('夜_起', 23) || hh < T('夜_止', 3)) notes.push('这么晚了')
              if (e3 < T('精力_低', 30)) notes.push('累着')
              // REL_FORMAT 2026-11-05（批次103）：原来 notes 用「、」并进一个括号，于是出现
              // 「（熟悉度 52，关系浓度 47%（还在往熟里走…）、这么晚了、累着）」——括号套括号，
              // 五件事挤在一句里，读起来像乱码。改成竖线分项，一项一件事。
              parts.push('关系：' + tier + '｜熟悉度 ' + fam + (notes.length ? '｜' + notes.join('｜') : ''))
              // 2026-11-01 追加：说话的样子从当下长出来，不写死句子长短
              try {
                const habits = []
                // OCAI 2026-11-02：复用同一函数内已读的 偏好.json，避免重复同步 readFileSync
                const pf3 = readPfOnce()
                if (pf3) {
                  const ticks = Array.isArray(pf3['口癖演化']) ? pf3['口癖演化'] : []; const tick = ticks.length ? ticks[Math.floor(Date.now() / 600000) % ticks.length] : null
                  if (tick && tick['词']) habits.push('可能多带几个「' + tick['词'] + '」')
                  // PREF_DEDUPE 2026-11-05（批次103）：原来这里也塞一条「偏好：X」，
                  // 而下面「人味」段还会再塞一条「自己偏好：X」（读的是同一个 喜欢 数组），
                  // 一段正文里同一句偏好出现两遍。而且「说话的样」本来就该只讲说话的习气，
                  // 喜欢什么归人味那一段。所以这里不再推 偏好。
                  if (Array.isArray(pf3['讨厌']) && pf3['讨厌'].length && Number(j?.mood?.intensity ?? 0) <= -1) habits.push('有点烦' + String(pf3['讨厌'][0]).slice(0, 8))
                }
                if (habits.length) parts.push('说话的样：' + habits.join('；'))
              } catch { /* 忽略 */ }
// === [F] 临场提示：镜像用词 / 接情绪 / 记得的瞬间 / 回头说 ===
              // 2026-11-01：人和人说话会互相染上对方的用词——偶尔镜像一下，别刻意
              try {
                const raw = String(text ?? '').slice(0, 80)
                const words = (raw.match(/[\u4e00-\u9fa5]{2,4}/g) || []).filter((w) => !/什么|这个|那个|就是|可以|我们|你们/.test(w))
                if (words.length > 0 && Math.random() < 0.25) parts.push('可以顺手接他的口：' + words[words.length - 1])
              } catch { /* 忽略 */ }

              // INTENT_OFF 2026-11-05：这里原来用 /(累|烦|难受|撑不住|崩了|不想动|睡不着|焦虑)/
              // 判「他这句像是不太好」然后催她「先接住情绪」。
              // 和 intentHint 里那两条同一个毛病：替她解读对方的心情。
              // 他真难受，她读原文就知道了；他要是说「累了一天总算搞定了」，这句提示只会带偏。
              // 所以整段撤掉，不换成别的提示 —— 原文已经在上下文里。

              // 2026-11-01：她说过「回头再聊」「等下说」这类话，得有人提醒她——
              // 人靠记性，她靠这个文件。到点就提一句，不提就忘干净了。
              try {
                const pdP = `${MEM}/回头说.json`
                if (fs2.existsSync(pdP)) {
                  const pd = JSON.parse(fs2.readFileSync(pdP, 'utf8'))
                  const due = (pd.items || []).filter((x) => Number(x.due || 0) <= Date.now() && !x.done)
                  if (due.length > 0) parts.push('自己说过回头要说的：' + String(due[0].what).slice(0, 16) + '——想提就提，不想提就再放着')
                }
              } catch { /* 忽略 */ }

              // 2026-11-01：她问过、对方没答的，会惦记着（不是催，是惦记）
              try {
                const hist = Array.isArray(history) ? history.slice(-6) : []
                const selfUin2 = String(getConfig()?.selfUin ?? '')
                let asked = null
                for (let i = hist.length - 1; i >= 0; i -= 1) {
                  const m = hist[i]
                  const uid = String(m?.sender?.user_id ?? '')
                  if (uid !== selfUin2) continue
                  const t = String(textOf ? (textOf(m.message) ?? '') : (m?.raw_message ?? ''))
                  if (/[？?]\s*$/.test(t)) asked = t
                  break
                }
                if (asked) {
                  const last = hist.filter((m) => String(m?.sender?.user_id) !== selfUin2).slice(-1)[0]
                  // HUMANIZE 2026-11-18（批次696，P2-3）：「惦记着」替她定情绪、「别催」是行为命令。
                  if (last) parts.push('你刚才问过一句，还没得到回话')
                }
              } catch { /* 忽略 */ }

// === [G] 入口：生长与学习 ===
              // CROSS_GROUP_STYLE 2026-11-20：跨群学习保持开启，但只把全局节奏统计带进当前轮。
              // 学习笔记里的群友原话有具体场景，不能随机搬到别的私聊或群聊里；句长/短句比例等
              // 是可跨场景复用的说话手感，仍按原来的低频方式注入，避免每轮重复占上下文。
              try {
                const lnP = `${MEM}/学习笔记.md`
                if (fs2.existsSync(lnP) && Math.random() < 0.4) {
                  const rhythm = fs2.readFileSync(lnP, 'utf8').split(String.fromCharCode(10))
                    .find((line) => line.startsWith('- 群友整体节奏：'))
                  if (rhythm) parts.push('跨群学来的说话节奏（只参考节奏，不照抄原话）：' + rhythm.slice(2, 120))
                }
              } catch { /* 忽略 */ }

              // 2026-11-01：她不只是会说，还能给自己长东西——
              // 把入口写进提示，她才可能在「发现自己在意什么」时真去记一笔。
              try {
                if (Math.random() < T('概率_随口一句', 0.35)) {
                  parts.push('能给自己长东西：发现自己在意什么、或有个说法更像自己，可以用 qq_grow（生长）记一笔，带上来历')
                }
              } catch { /* 忽略 */ }

              // 2026-11-01：有些瞬间会记着——不用多，偶尔提一次
              try {
                const moP = `${MEM}/瞬间.json`
                const mo = fs2.existsSync(moP) ? JSON.parse(fs2.readFileSync(moP, 'utf8')) : {}
                const list = Array.isArray(mo.items) ? mo.items : []
                const cand = list.filter((x) => Date.now() - Number(x.lastSaid || 0) > 864e5)
                if (cand.length > 0 && Math.random() < 0.3) {
                  const it = cand[Math.floor(Math.random() * cand.length)]
                  __selectedMoment = { at: String(it.at || ''), what: String(it.what || '') }
                  // HUMANIZE 2026-11-17（批次665，P1-5）：删掉「想起来一件事」这句第一人称成句，
                  // 只留「哪天的什么」这个事实。
                  parts.push('[瞬间] ' + __selectedMoment.at + ' ' + __selectedMoment.what.slice(0, 16))
                  更新已说瞬间(moP, __selectedMoment)
                }
              } catch { /* 忽略 */ }

              // HUMANIZE 2026-11-17（批次673，P0-3）：这里原有一整块「句子手感」，
              // 按精力/耐心/别扭/自主状态规定她「话更短更冲 / 别解释 / 可以多铺两句」，
              // 是 665 从 voiceHintOf 删掉的同一条规则的副本。整块删除：
              // 精力、耐心、心情的数值上面已经各自给过，说多少、怎么说由她自己在回合里定。
            } catch { /* 忽略 */ }
            // 2026-11-01：怨要能浮现，但不必天天挂嘴上
            try {
              // OCAI 2026-11-02：复用同一函数内已读的 怨.json，避免重复同步 readFileSync
              const yj = readYjOnce()
              if (yj) {
                const yr = (yj.people || {})['1000000002']
                // HUMANIZE 2026-11-17（批次665，P1-5）：只递数值与记录,不替她写「心里有怨」。
                if (yr && Number(yr.level || 0) >= T('怨_说门槛', 20)) parts.push('怨 ' + yr.level + '/100：' + String(yr.why || '').slice(0, 12))
              }
            } catch { /* 忽略 */ }
            // 2026-11-01：久别不一定变淡——思念是正向的
            try {
              const lng = Number(rec?.['思念'] || 0)
              if (lng >= T('思念_说门槛', 30)) parts.push('思念 ' + lng + '/100')
            } catch { /* 忽略 */ }
            // 2026-11-01：欠的账不提就永远是账，提一句，但不追问
            try {
              const owed = Number(rec?.owed || 0)
              if (owed > 0) parts.push('他欠一句道歉：' + owed + ' 次')
            } catch { /* 忽略 */ }
            // 2026-11-01：把「想要 / 偏好 / 身体感 / 余波 / 沉默」并进状态行——
            // 这几样建了文件就得用上，不然只是摆设（参数表那次就栽在这）。
            try {
              // OCAI 2026-11-02：复用同一函数内已读的 想要.json 与 偏好.json，避免重复同步 readFileSync
              const wj = readWjOnce()
              if (wj) {
                const top = (wj.当下想要 || []).slice().sort((a, b) => (b.strength || 0) - (a.strength || 0))[0]
                if (top) parts.push('想要的一条：' + top.what)
                const fear = (wj.怕的 || []).slice().sort((a, b) => (b.level || 0) - (a.level || 0))[0]
                if (fear && Number(fear.level) >= 3) parts.push('心里怕的：' + fear.what)
              }
              const pj2 = readPfOnce()
              if (pj2) {
                const hate = (pj2.讨厌 || [])[0]
                if (hate) parts.push('别踩的：' + hate)
              }
              const b = j.body
              if (b) {
                const itch = Number(b['说不清的不舒服'] || 0) + Number(b['累的那种痒'] || 0)
                if (itch >= 2) parts.push('身上有点说不清的难受')
              }
              const at = j.aftertaste
              if (at && Number(at['到'] || 0) > Date.now() && Number(at['强度'] || 0) >= 2) parts.push('上一件事的余波还在：' + String(at['事件'] || '').slice(0, 12))
              const sil = j.silence
              // 只报「静默窗口开着 + 记下的原因」，不替她写「不想开口、也说不清为什么」。
              if (sil && sil['正在']) parts.push('静默窗口：开着' + (sil['原因'] ? '（' + String(sil['原因']).slice(0, 12) + '）' : ''))
              // 2026-11-01：善意的小谎要带破绽记录。
              // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-11）：只报谎/真相/破绽，
              // 不再规定「说的时候会露出」。
              const lieP = `${MEM}/谎言.json`
              if (fs2.existsSync(lieP)) {
                const lj = JSON.parse(fs2.readFileSync(lieP, 'utf8'))
                if (lj && lj.current) parts.push('瞒着：对外「' + lj.current.lie + '」/ 实际「' + lj.current.truth + '」/ 破绽记录：' + lj.current.tellDesc)
              }
              // 2026-11-01：把「感受 / 情感 / 情绪」分三层写进去——感受是这一下的直觉，
              // 情感是稳定的倾向，情绪是生理那一层。再加上隐晦的生理反应。
              if (j && (j['感受'] || j['情感'] || j['情绪'])) {
                const bits = []
                if (j['感受']) bits.push('这一下觉得' + String(j['感受']).slice(0, 12))
                if (j['情感']) bits.push('底子上对他是' + String(j['情感']).slice(0, 8))
                if (j['情绪']) bits.push('情绪上' + String(j['情绪']).slice(0, 8))
                parts.push('此刻的感受：' + bits.join('，'))
              }
              if (j && j['生理反应'] && typeof j['生理反应'] === 'object') {
                const pb = Object.values(j['生理反应']).filter(Boolean).slice(0, 2)
                if (pb.length) parts.push('身上有点反应：' + pb.join('、'))
              }
              // 2026-11-01：人味按当下状态挑两三条，不再八条一起上。
              // 依据：精力、心情强度、驱动、对主人好感、性格里的敏感/乐群、今天有没有梦。
              try {
                const rwP2 = `${MEM}/人味.json`
                if (fs2.existsSync(rwP2)) {
                  const rw = JSON.parse(fs2.readFileSync(rwP2, 'utf8'))
                  const e2 = Number(j?.energy ?? 60)
                  const mi2 = Number(j?.mood?.intensity ?? 0)
                  const drv2 = String(j?.mood?.drive ?? 'calm')
                  const sc2 = Number(((db && db.people) || {})['1000000002']?.score ?? 40)
                  let sens = 7, greg = 6
                  try {
                    const pfP = `${MEM}/性格-16PF.json`
                    if (fs2.existsSync(pfP)) {
                      const pf = JSON.parse(fs2.readFileSync(pfP, 'utf8'))
                      sens = Number(pf['I_敏感性'] ?? sens)
                      greg = Number(pf['A_乐群性'] ?? greg)
                    }
                  } catch { /* 用默认 */ }
                  const pick = []
                  const add = (k) => { if (rw[k] && pick.length < 3) pick.push(rw[k]) }
                  if (e2 < T('精力_低', 30)) add('身体当理由')                      // 累了先疼
                  else if (mi2 <= -1 || drv2 === 'anxious') add('空白') // 闷或绷着 → 允许安静
                  if (mi2 >= 1) add('表达')                            // 心情顺 → 话可以活一点
                  if (sc2 >= T('好感_有力', 70)) add('怕与要')                         // 分高才敢撒娇要关注
                  else if (sc2 <= T('好感_疏远阈值', 35)) add('关系账')                    // 分低记得欠账
                  if (sens >= 8) add('说不清的偏')                     // 敏感的人认那点说不清
                  if (pick.length === 0) { add(greg >= T('乐群_高', 7) ? '表达' : '空白') }
                  const bits2 = []
                  for (const it of pick) {
                    if (it['倾向']) bits2.push(it['倾向'])
                    else if (it['原则']) bits2.push(it['原则'])
                    else if (it['分寸']) bits2.push(it['分寸'])
                    else if (it['无聊']) bits2.push(it['无聊'])
                    else if (it['沉默五种']) bits2.push('有时候不想说话，' + it['沉默五种'].slice(0, 2).join('、'))
                  }
                  // 2026-11-01：她给自己长出来的东西也要能被用上——
                  // 有「怕」的时候，闷着就提一条；没有就照旧。
                  if (mi2 <= -1 && rw['怕与要'] && Array.isArray(rw['怕与要']['怕']) && rw['怕与要']['怕'].length > 0) {
                    const f = rw['怕与要']['怕'][Math.floor(Math.random() * rw['怕与要']['怕'].length)]
                    // HUMANIZE 2026-11-18（批次696，P2-7）：「心里有点怕」是代码加的第一人称话头，
                    // 内容本来是她自己写进 人味.json 的，只递原文。
                    bits2.push('怕的：' + String(f).slice(0, 14))
                  }
                  // 2026-11-01：偏好别只当摆设——幽默类型和审美按状态偶尔用一次；
                  // 生长记录用来「讲自己的来历」，不是记账。
                  try {
                    // OCAI 2026-11-02：复用同一函数内已读的 偏好.json，避免重复同步 readFileSync
                    const pf2 = readPfOnce()
                    if (pf2) {
                      // HUMANIZE 2026-11-18（批次696，P2-8）：「说话可以带点 X」是替她定表达方式，
                      // 只递「她自己的偏好是什么」。
                      if (mi2 >= 1 && pf2['幽默'] && pf2['幽默']['类型']) bits2.push('幽默偏好：' + String(pf2['幽默']['类型']).slice(0, 8))
                      if (mi2 <= -1 && Array.isArray(pf2['讨厌']) && pf2['讨厌'].length) bits2.push('讨厌：' + String(pf2['讨厌'][0]).slice(0, 10))
                      if (Array.isArray(pf2['喜欢']) && pf2['喜欢'].length) {
                        const lk = pf2['喜欢'][Math.floor(Math.random() * pf2['喜欢'].length)]
                        if (String(lk).length <= 10) bits2.push('自己偏好：' + lk)
                      }
                    }
                  } catch { /* 忽略 */ }
                  try {
                    const grP = `${MEM}/长出来的.json`
                    if (fs2.existsSync(grP)) {
                      const gr = JSON.parse(fs2.readFileSync(grP, 'utf8'))
                      const last = (gr.items || []).slice(-1)[0]
                      if (last && last.why) bits2.push('自己身上这一点是从「' + String(last.why).slice(0, 12) + '」来的')
                    }
                  } catch { /* 忽略 */ }
                  // 2026-11-18：来信间隔由 deliver 按当前收件人的原始消息时间提供，不再读主动搭话账推断「久别」。
                  // 约定与时间 2026-11-23：这一类一直躺在 人味.json 里，可从没进过注入。
                  // 只接能自判的一条：按北京时间钟点判断深夜；久别/纪念日需要收件人时间线，没接。
                  try {
                    const 约 = rw['约定与时间']
                    const 钟 = new Date(Date.now() + 8 * 3600e3).getUTCHours()
                    if (约 && 约['深夜'] && (钟 >= 23 || 钟 < 5)) bits2.push(约['深夜'])
                  } catch { /* 忽略 */ }
                  if (bits2.length) parts.push('人味：' + bits2.join('；'))
                }
                // 梦的余味：昨晚的梦还在，就当今日情绪的底色
                // DREAM_DEDUPE 2026-11-05（批次103）：原来看「梦-日期.md 在不在」就补一句
                // 「昨夜的梦还剩点余味，说不清是什么」。可 内心.mjs 早把真余味（「想在那束光里
                // 多坐一会儿」）写进 内心.md，同一轮正文里就有两处说梦，一处具体一处含糊。
                // 梦是她的私事，只留在内心那段（且只给主人），这里不再另说一遍。
              // 今天的执念/怕/要，从想要.json 只取一条最强
              try {
                // OCAI 2026-11-02：复用同一函数内已读的 想要.json，避免重复同步 readFileSync
                // WISH_DEDUPE 2026-11-05（批次103）：同一句「想要」前面已经用「想要的一条：」
                // 注入过一次（取的都是 strength 最高的那条），这里又用「想要的：」再来一遍，
                // 一段正文里说两遍同一件事。已经说过的就不重复。
                const wj2 = readWjOnce()
                if (wj2) {
                  const top = (wj2['当下想要'] || []).slice().sort((a, b) => (b['strength'] || 0) - (a['strength'] || 0))[0]
                  const __w = top ? String(top['what'] || '').trim() : ''
                  if (__w !== '' && !parts.some((x) => String(x).includes(__w))) parts.push('想要的：' + __w)
                }
              } catch { /* 忽略 */ }
              } catch { /* 读不到就不加 */ }
            } catch { /* 读不到就不加 */ }
            // 状态和关系事实只作上下文，不合成行为分数或执行阈值。
            // 2026-11-01 肥鱼：正在闹别扭时，愿意回但只说短的；时间到它自己消。
            try {
              const bl = `${MEM}/别扭.json`
              if (fs2.existsSync(bl)) {
                const bdb = 快读Json(bl)
                const rec2 = bdb?.people?.['1000000002']
                if (rec2 && Number(rec2.until) > Date.now()) {
                  const lv = Number(rec2.level) || 1
                  // 2026-11-01：别扭不是到点才消——时间过半就开始淡，跟人一样。
                const _since = Number(rec2.since || 0) || 0
                const _until = Number(rec2.until || 0) || 0
                const _ratio = _until > _since ? Math.min(1, (Date.now() - _since) / (_until - _since)) : 1
                const _eff = Math.max(1, Math.round(lv * Math.max(0.3, 1 - _ratio * 0.7)))
                const _word = _ratio > T('别扭_消大半', 0.6) ? '（气已经消了大半）' : ''
                // HUMANIZE 2026-11-17（批次673，P0-1）：只递「我在别扭、强度多少、因为什么、气消了多少」。
                // 删掉「话会不由自主变短 / 可以不讲理、可以嘴硬 / 像个人在生气就行」——
                // 那是替她写好的一整段表演剧本，不是事实。
                parts.push('正别扭着（强度 ' + _eff + '，因为「' + String(rec2.why || '').slice(0, 20) + '」）' + _word)
                }
              }
            } catch { /* 读不到就不加 */ }
          }
        }
        }
      } catch { /* 读不到就不加 */ }
      // PERSONA_FIRST_HOOK 2026-11-02：拟人优先——宁可像人，也别像客服
      // CACHE_STATIC 2026-11-14（批次484）：这条跟 SOUL.md:10「底色是活泼、可爱、贪吃爱玩的网瘾少女…
      // 大部分情况下不毒舌、不刻薄、不阴阳怪气」**完全重复**，而 SOUL 在 system（静态、缓存命中），
      // 这条在正文（每轮全额计费）。删掉零信息损失 —— 实测三段从 3121 降到 3092 字。

      if (parts.length === 0) return ''
      // 2026-11-01：把「一律要怎样」改成「此刻偏哪边」——状态自己说话，别写成条款。
      // HUMANIZE 2026-11-17（批次673）：这里只剩 lean（数值化形容词），near 已删。
      const lean = (() => {
        const e = Number(energy ?? 60)
        const mi = Number(intensity ?? 0)
        const drv = String(j?.mood?.drive ?? 'calm')
        const spL = Number((j?.耐心 || {})['短期'] ?? 60)
        const parts2 = []
        if (e >= T('精力_有力', 70)) parts2.push('有力气')
        else if (e < T('精力_没劲', 30)) parts2.push('快没劲了')
        if (spL < T('耐心_冲阈值', 35)) parts2.push('没什么耐性')
        if (mi >= 1) parts2.push('心里顺')
        else if (mi <= -1) parts2.push('心里堵')
        if (drv === 'anxious') parts2.push('绷着')
        return parts2.join('、') || '一般'
      })()
      // HUMANIZE 2026-11-17（批次673，P0-2）：删掉 near 整段。原逻辑按心情/精力/时段
      // 直接替她决定「偏想退开 / 话更软更真 / 偏想凑近」，结尾再补一句「不是命令」也抵消不了
      // 前面已经下好的判断。lean 只留数值化的形容词（有力气/快没劲了/心里顺/心里堵/绷着）。
      // ALBUM_HINT 2026-11-05（批次77）/ 批次109 改读 photo.js：
      // 原来只读 `记忆/拍照本.json`。那份文件当时并不存在（自拍.mjs 会写，但被清掉过），
      // `statSync` 一抛，整段静默消失 —— 她拍过的话明明还在 成品 json 和 照片墙.json 里。
      // 现在三级来源合并，并且带最新一张的成品路径：她说「给你看」时才拿得出真图。
      try {
        const __album = 相册提示()
        if (__album !== '') parts.push(__album)
      } catch { /* 没拍过就不提 */ }
      return `（你现在的状态：${parts.join('，')}。此刻${lean}。这话是给你参考的，不是命令——怎么开口你自己拿主意。）
`
    } catch { /* 读坏了就当没有 */ }
  }
  return ''
}
import { markIncoming, markDeliveredBatch } from './rhythm.js'
import { touchPeer } from './memory.js'
import { createMergeQueue, mergeSettings } from './merge.js'
import { notePeerActivity } from './proactive.js' // 原名 notePeerSpoke，2026-11-04 改名避开与 active-peer 同名
import { dropPendingReplies, clearCancelled } from './outbound.js'

/**
 * 错误分级：把「门还没开」和「门开着但出错」分开。
 *
 * 连接类错误（ECONNREFUSED / fetch failed / 超时）意味着协议端暂时不可达 ——
 * 常见于 QQ 还没登录完、或协议端刚好重启。这不是业务故障：
 *   - 不写 state.lastError（那个字段是给设置页看的，写满了会让人以为插件坏了）
 *   - 不逐条刷日志（每 4 秒一条能把日志冲垮）
 * 只在「状态发生变化」时记一次：断开时记一条，恢复时记一条。
 */
/**
 * 这条是不是刚被 qq_wait「等一下」读过（已经答过一次）。
 *
 * 2026-10-31 小肥鱼补：VPS 这份 poll.js 原本没有这个机制，
 * 私聊路径引用它会直接 ReferenceError，所以先把这个函数补上。
 */
async function consumedByWait(messageId) {
  const id = Number(messageId)
  if (!Number.isFinite(id) || id <= 0) return false
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const os = await import('node:os')
    const f = path.join(os.homedir(), '.dsh', 'qq-consumed.json')
    const list = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (!Array.isArray(list)) return false
    const now = Date.now()
    return list.some((x) => x && Number(x.id) === id && now - Number(x.at) < 600000)
  } catch {
    // OCAI 2026-11-02：空 catch 补注释——已消费记录文件不存在或损坏时当未消费处理
    return false
  }
}

let lastConnectionDown = false

function noteConnectionIssue(tag, message) {
  if (lastConnectionDown) return
  lastConnectionDown = true
  note(tag, `协议端不可达（${message}），稍后重试`)
}

function noteConnectionRecovered(tag) {
  if (!lastConnectionDown) return
  lastConnectionDown = false
  note(tag, '协议端已恢复')
}

/** 监听对象 = peerUin ∪ routes.private 的键，必须取并集。
 * 血泪史：早先只轮询 peerUin 一个号，于是在设置页给别的 QQ 配好会话也完全收不到消息，
 * 看着像"发出去对方没收到"，其实是入站那头压根没在听。（群聊一模一样的坑见下方 configuredGroups） */

// 2026-11-01：被戳也要看状态——累了就懒得动、心情好可以逗回去、正别扭就别装没事。
function pokeTextOf(uin) {
  return "【QQ 自带的戳一戳｜QQ 系统事件，不是聊天文字】" + pokeTextRaw(uin)
}
function pokeTextRaw(uin) {
  try {
    let energy = 60, mood = 0, drive = 'calm'
    const sp = `${MEM}/状态.json`
    // OCAI 2026-11-02：ESM 禁用 require，改为使用顶部导入的 fs
    const fsx = fs
    let PRM = {}
    try {
      for (const pp of [`${TOOLS}/参数.json`, 'B:/肥鱼/工具/参数.json']) {
        if (fsx.existsSync(pp)) {
          const _pj = JSON.parse(fsx.readFileSync(pp, 'utf8'))
          PRM = { ...(_pj?.['阈值'] || {}), ...(_pj?.['拟人'] || {}) }
          break
        }
      }
    } catch { /* 用默认 */ }
    const T = (k, d) => (PRM && Number.isFinite(Number(PRM[k])) ? Number(PRM[k]) : d)
    if (fsx.existsSync(sp)) {
      const st = JSON.parse(fsx.readFileSync(sp, 'utf8'))
      energy = Number(st?.energy ?? 60)
      mood = Number(st?.mood?.intensity ?? 0)
      drive = String(st?.mood?.drive ?? 'calm')
    }
    let sulking = false
    const kp = `${MEM}/别扭.json`
    if (fsx.existsSync(kp)) {
      const sk = JSON.parse(fsx.readFileSync(kp, 'utf8'))
      const rec = personRecordOf(sk, { kind: 'private', id: uin })
      sulking = Boolean(rec && Number(rec.until) > Date.now())
    }
    // OCAI 2026-11-02：戳一戳联动自主.json（打瞌睡/发呆）与怨.json（记仇），把被戳时的手头状态和记仇翻成人话
    let autState = ''
    const ap = `${MEM}/自主.json`
    if (fsx.existsSync(ap)) {
      autState = String(JSON.parse(fsx.readFileSync(ap, 'utf8'))?.state ?? '')
    }
    let grudgeLv = 0
    const yp = `${MEM}/怨.json`
    if (fsx.existsSync(yp)) {
      const yj = JSON.parse(fsx.readFileSync(yp, 'utf8'))
      const yr = personRecordOf(yj, { kind: 'private', id: uin })
      grudgeLv = Number(yr?.level ?? 0)
    }
    if (sulking) return '（有人戳了你一下，你这会儿不太想理人）'
    if (grudgeLv >= T('怨_提门槛', 30)) return '（有人戳了你一下，你心里还记着账，不太想给好脸色）'
    if (autState === '打瞌睡') return '（有人戳了你一下，你正犯困打盹，被戳得迷迷糊糊醒过来）'
    if (autState === '发呆' || autState === '翻旧账') return '（有人戳了你一下，你正走神想事情，被他冷不丁戳回神）'
    if (energy < T('精力_低', 30)) return '（有人戳了你一下，你累得不太想动）'
    if (drive === 'anxious') return '（有人戳了你一下，你这会儿绷着）'
    if (mood >= 1) return '（有人戳了你一下，你心情不错）'
    return '（戳了你一下）'
  } catch {
    // OCAI 2026-11-02：空 catch 补注释——状态文件读取失败时退回默认戳一戳文案
    return '（戳了你一下）'
  }
}

export function configuredPrivates() {
  const config = getConfig()
  const set = new Set()
  if (Number(config.peerUin) > 0) set.add(String(config.peerUin))
  for (const id of Object.keys(config.routes?.private ?? {})) {
    const key = String(id ?? '').trim()
    if (key !== '') set.add(key)
  }
  return [...set]
}

/** 监听的群 = groupUins ∪ routes.group 的键。
 * 设置页里"绑定群"就等于"要听这个群"，没有单独的开关，所以两者必须取并集：
 * 早先只写 routes.group 不写 groupUins，结果绑了群却完全没轮询（踩过）。 */
export function configuredGroups() {
  const config = getConfig()
  const set = new Set()
  if (Array.isArray(config.groupUins)) for (const value of config.groupUins) {
    const id = String(value ?? '').trim()
    if (id !== '') set.add(id)
  }
  for (const id of Object.keys(config.routes?.group ?? {})) {
    const key = String(id ?? '').trim()
    if (key !== '') set.add(key)
  }
  return [...set]
}

// ---- 去重 ----

/** 最近处理过的 message_id 保留多少个（负数 id 只能用「相等」判断，不能比大小）。 */
const SEEN_LIMIT = 100

/**
 * 这条消息是不是已经处理过？（WS 与轮询可能同时看到同一条）
 *
 * ⚠️ 私聊**不能**用 seq 游标判新旧 —— 这是踩过的大坑：
 *   私聊历史里 `message_seq` 是**两套编号混着的**：
 *     · 机器人自己发的消息 → 本地 store 的连续编号（实测 7130, 7131, 7132…）
 *     · 对方发来的消息   → QQ 服务器漫游记录的编号（实测 50764, 50765, 50766…）
 *   而且对方那一套**自己也不单调**（实测 50764 → 50765 → 50766 → 20590）。
 *   所以「seq ≤ lastSeq 就是旧消息」在私聊上根本不成立 ——
 *   实测树树 13:26 的消息 seq=20590，被上一条 50766 的游标判成「旧消息」直接丢弃，
 *   现象就是「我发了消息，DSH 收不到」。
 *
 *   群聊没有这个问题：群消息的 seq 来自同一个序列（实测 4366→4377 单调递增），
 *   所以群那边继续用 seq 判新旧。
 *
 * 现在私聊改用「时间戳 + message_id」：
 *   · message_id 精确去重（seenIds，相等判断，负数也准）
 *   · 时间戳判断是否比上次处理的新
 *
 * @param {object} bucket 游标桶
 * @param {object} message 消息
 * @param {boolean} [useSeqCursor] 是否用 seq 游标判新旧（群聊 true，私聊 false）
 */
export function isSeen(bucket, message, useSeqCursor = false) {
  if (bucket === null || typeof bucket !== 'object') return false
  const id = Number(message?.message_id)
  if (Number.isFinite(id) && Array.isArray(bucket.seenIds) && bucket.seenIds.includes(id)) return true
  // 私聊：seq 不可信，只能靠时间戳
  if (!useSeqCursor) {
    const time = timeOf(message)
    const lastTime = Number(bucket.lastTime ?? 0)
    // 有时间游标、且消息时间**严格早于**它 → 是之前处理过的旧消息。
    // 同秒的（time == lastTime）不算旧 —— 秒级时间戳分辨不出同秒多条，
    // 那些交给上面的 message_id 精确匹配去重。
    // lastTime 为 0 / undefined = 还没有游标 → 不据此判断（宁可多看一眼也别漏）。
    if (lastTime > 0 && time > 0 && time < lastTime) return true
    return false
  }
  const seq = seqOf(message)
  // seq 小于等于已处理位置 → 旧消息（群聊路径 seq 单调，这判断成立）
  // 2026-11-01：游标可能是旧格式（message_seq 的大数字，动辄几亿）。
  // 真实 real_seq 只有几千，直接比会把所有消息判成旧消息、静默失联，
  // 所以超过 LEGACY_SEQ_LIMIT 的旧游标直接忽略，靠 time + seenIds 兜底，等新消息把游标重写。
  const LEGACY_SEQ_LIMIT = 1000000
  const lastSeq = Number(bucket.lastSeq)
  if (seq !== null && Number.isFinite(lastSeq) && lastSeq > 0 && lastSeq < LEGACY_SEQ_LIMIT && seq <= lastSeq) return true
  return false
}

/** 记下这条消息的 id，供去重。
 *  已经记过的不重复记 —— WS 路径和投递函数都会 markSeen 一次，
 *  不去重的话 seenIds 会被同一个 id 填满（上限 100），去重窗口跟着变小。 */
export function markSeen(bucket, message) {
  const id = Number(message?.message_id)
  if (!Number.isFinite(id)) return
  const list = Array.isArray(bucket.seenIds) ? bucket.seenIds : []
  if (!list.includes(id)) list.push(id)
  while (list.length > SEEN_LIMIT) list.shift()
  bucket.seenIds = list
}

/**
 * 精确撤销一条消息的「已读」记账（2026-11-04 加）。
 *
 * 为什么不能整份写回快照：回滚用的 `{ ...bucket }` 是浅拷贝，`seenIds` 跟线上是同一个数组，
 * 而 markSeen 是原地 push —— 快照里那条 id 还在，写回去等于没回滚，
 * 这条消息被判成「已处理」，轮询再也不重试，就是静默丢消息。
 */
export function unmarkSeen(bucket, message) {
  const id = Number(message?.message_id)
  if (!Number.isFinite(id)) return
  if (bucket === null || typeof bucket !== 'object' || !Array.isArray(bucket.seenIds)) return
  const index = bucket.seenIds.indexOf(id)
  if (index >= 0) bucket.seenIds.splice(index, 1)
}

/**
 * 投递失败时撤账：把这批消息的 id 从 seenIds 摘掉；
 * 游标只在「没人往前推过」时退回快照值，免得把后续消息的推进一起抹掉。
 */
export function rollbackSeen(bucket, messages, snapshot) {
  if (bucket === null || typeof bucket !== 'object') return
  const list = Array.isArray(messages) ? messages : [messages]
  for (const item of list) unmarkSeen(bucket, item)
  if (snapshot === undefined || snapshot === null) return
  const seq = seqOf(list[0])
  if (Number.isFinite(Number(seq)) && Number(bucket.lastSeq) === Number(seq)) {
    bucket.lastSeq = snapshot.lastSeq
  }
}

/**
 * 把「旁路读到的消息」标成已处理（2026-10-31 加，治重复回复）。
 *
 * 为什么：qq_wait 是直接拉历史看新话，转发那头不知道我已经看过了，
 * 同一条还会被投递一次、再答一遍。这里让读到的一条进 seenIds，
 * 投递路径的 isSeen 就会跳过它。
 *
 * @param {'group'|'private'} kind
 * @param {string} peer 群号或 QQ 号
 * @param {number|string} messageId 消息 id
 */
export function markHandled(kind, peer, messageId) {
  const id = Number(messageId)
  if (!Number.isFinite(id)) return
  const st = getState()
  const key = String(peer ?? '')
  if (key === '') return
  if (kind === 'group') {
    const bucket = st.groups[key] ?? (st.groups[key] = { seenIds: [] })
    markSeen(bucket, { message_id: id })
  } else {
    const bucket = st.privates[key] ?? (st.privates[key] = { seenIds: [] })
    markSeen(bucket, { message_id: id })
  }
}

/**
 * 批237：qq_listen 看过的消息，从私聊合并池里撤掉。
 * 不撤的话，等这一回合结束，它们会以「新消息」再投一遍（实测同一张图出现两次、迟到 4 分钟）。
 */
export function dropQueued(peer, ids) {
  try {
    return privateMerge.drop(String(peer ?? ''), ids)
  } catch {
    return 0
  }
}

// ---- 昵称 / 群名缓存（WS 事件里通常没有，靠缓存补） ----

let nicknameCache = new Map()
const groupNames = new Map()

// ---- 群消息缓冲 ----
//
// WS 推来的**每一条**群消息（哪怕没 @ 我）都进这个环形缓冲。
// 上下文直接从缓冲里挑「上次投递之后、这次之前」的那几条 —— 未读语义天然成立，
// 不用每收到一条 @ 就去 HTTP 拉一次历史。
// 轮询拉到历史时也往缓冲里灌，两条通路互补。
const GROUP_BUFFER_LIMIT = 30
const groupBuffers = new Map()

/** 往缓冲里放一条群消息（按 seq 去重、按 seq 排序，超上限丢最老的）。 */
export function pushToBuffer(groupId, message) {
  try {
    const uin = String(message?.sender?.user_id ?? message?.user_id ?? '').trim()
    const nm = String(message?.sender?.card || message?.sender?.nickname || message?.nickname || '').trim()
    if (uin !== '' && nm !== '') nicknameCache.set(uin, nm)
  } catch {}
  const list = groupBuffers.get(groupId) ?? []
  const seq = seqOf(message)
  if (seq !== null && list.some((item) => seqOf(item) === seq)) return
  list.push(message)
  list.sort((a, b) => (seqOf(a) ?? 0) - (seqOf(b) ?? 0))
  while (list.length > GROUP_BUFFER_LIMIT) list.shift()
  groupBuffers.set(groupId, list)
}

/** 取某群缓冲里的消息。 */
export function groupBuffer(groupId) {
  return groupBuffers.get(groupId) ?? []
}

export async function refreshNicknames() {
  try {
    const result = await callOneBot({ action: 'get_friend_list' })
    if (result?.retcode === 0) {
      const map = new Map()
      for (const friend of Array.isArray(result.data) ? result.data : []) {
        const uin = String(friend?.user_id ?? '')
        if (uin !== '') map.set(uin, String(friend?.nickname ?? ''))
      }
      for (const [k, v] of nicknameCache.entries()) { if (!map.has(k)) map.set(k, v) }
      if (map.size > 0) nicknameCache = map
      else note('api', 'get_friend_list 回了 retcode 0 但一条好友都没有（检查 config.token / 中转）')
    }
    for (const gid of configuredGroups()) {
      try {
        const gr = await callOneBot({ action: 'get_group_member_list', params: { group_id: Number(gid) } })
        if (gr?.retcode === 0 && Array.isArray(gr.data)) {
          for (const m of gr.data) {
            const uin = String(m?.user_id ?? '').trim()
            const nm = String(m?.card || m?.nickname || '').trim()
            if (uin !== '' && nm !== '') nicknameCache.set(uin, nm)
          }
        }
      } catch (e) {
        // NICK_TRACE 2026-11-14（批次430）：原来是空 catch ——「昵称缓存一直空」这件事
        // 查了三次都只能靠猜，因为失败一点痕迹都不留。群成员拿不到就记一行。
        note('api', 'group_member_list 失败(' + String(gid) + ')：' + String(e?.message ?? e).slice(0, 80))
      }
    }
  } catch (e) {
    // 昵称拿不到不影响主链路 —— 但**必须留痕**，否则下次还是没人知道它为什么空。
    note('api', '昵称刷新失败：' + String(e?.message ?? e).slice(0, 100))
  }
}

/**
 * 昵称缓存的可观测出口（批次430）。
 *
 * `nicknameCache` 是模块私有的，外面既看不到它有多少条、也不知道上次刷新是什么时候 ——
 * 于是「缓存一直是空的」这种问题只能靠猜。
 *
 * **不 export**：批次430 第一版导出了 `nicknameStats()`，被 体检-闭环 当场判成死导出 1 个
 * （除了测试没有人调）—— 「接口做了没接入点」这个病，我自己又犯了一次。
 * 现在只给下面的 finally 用，观测结果写进日志，不对外开口子。
 */
function nicknameStats() {
  const 样本 = []
  for (const [k, v] of nicknameCache) { 样本.push(k + ':' + v); if (样本.length >= 3) break }
  return { size: nicknameCache.size, at: nicknameFetchedAt, sample: 样本 }
}

// 2026-11-04：昵称表从来没有被填过 —— refreshNicknames() 写好了却没人调用，
// 所以下面这个兜底一直返回空串，她看到的就是「群友『未知』」。
// 现在改成懒加载：查不到就后台补一次。不挂启动定时器，因为启动那一刻 OneBot
// 常常还没连上，白跑一次之后就再也不会试了。10 分钟节流，同时只跑一个。
const NICKNAME_TTL_MS = 10 * 60 * 1000
let nicknameFetchedAt = 0
let nicknameFetching = false

function maybeRefreshNicknames() {
  // NO_TOKEN_NO_FETCH 2026-11-14（批次433）：配置还没加载时 token 是空的、onebotHttp 还是默认的
  // 3000 —— 这时候打过去必然 401/403。生产上 loadConfig() 在启动时就跑了，走不到这里；
  // 但**任何 import poll.js 又调了 stateHintOf/voiceHintOf 的测试**都会顺手触发一次，
  // 进程退出前偶尔跑完，日志里就多一条「昵称刷新失败：OneBot HTTP 403」的假故障，
  // 排障时看起来像真的。没凭据就别去敲门。
  if (!String(getConfig()?.token || '')) return
  const nowMs = Date.now()
  if (nicknameFetching) return
  if (nowMs - nicknameFetchedAt < NICKNAME_TTL_MS) return
  nicknameFetching = true
  void refreshNicknames()
    .catch(() => { /* 拿不到不影响主链路（refreshNicknames 自己已经 note 过了） */ })
    .finally(() => {
      nicknameFetching = false
      nicknameFetchedAt = Date.now()
      // 刷新完还是 0 条 —— 这才是「缓存一直是空的」最直接的那句证据，
      // 别让它再变成「查三次只能猜」。（有数时不出声，免得日志被刷满。）
      const st = nicknameStats()
      if (st.size === 0) note('api', '昵称刷新完还是 0 条（查 config.token / 3001 中转 / 好友列表）')
    })
}

/**
 * 账上那个时刻，给人看的样子（批次417）。
 * 当天的只写 HH:MM；跨天的必须带日期 —— 原来固定 slice(11)，
 * 于是注入里出现过「最近一笔 13:59 买了小蛋糕」，而那是**昨天**的 13:59，
 * 她会说成刚刚。抽成函数是为了能单测两条分支（真实数据不一定两天都有）。
 */
/**
 * LATENCY_COMP 2026-11-15（批次507）：这条消息已经变旧时，明说「不是刚发生的」。
 *
 * 为什么要单独一句：正文里每条虽然带 `[19:13]`、状态行也带「此刻 19:13」，但两个数都是
 * **拼正文那一刻**取的。投递被 debounce / 批量合并 / 队列推迟时它们一起停住，
 * 她看不出自己已经迟了两分钟，于是把翻篇的话题当成正在进行。
 *
 * 判据保守：间隔 < 6 秒不出现（正常秒回不该被这句话占地方）。
 */
/**
 * 把一条 poke 事件翻成一行人能读的日志（POKE_TRACE 批次521c 抽出来的）。
 *
 * 为什么抽出来：原来这段内联在事件处理里，只能靠「源码里有没有这句话」来测。
 * 抽成纯函数之后，可以真喂 event 进去验：缺 raw_info 会不会崩、原文会不会截断、
 * 「发起=自己的号且目标不是自己」这种可疑组合会不会被标出来。
 *
 * 永远返回字符串（不抛错）—— 日志出问题绝不能影响唤醒判定。
 */
export function 拍一拍描述(event, selfUin) {
  const e = event ?? {}
  const 发起 = String(e.user_id ?? '')
  const 目标 = String(e.target_id ?? e.user_id ?? '')
  const gid = String(e.group_id ?? '')
  let 原形 = ''
  try {
    原形 = (Array.isArray(e.raw_info) ? e.raw_info : [])
      .filter((x) => x && x.type === 'nor')
      .map((x) => String(x.txt ?? ''))
      .join('')
  } catch { 原形 = '' }
  // 「发起字段是自己的号、目标却是别人」＝ 不是正常的手动戳，标出来
  const 可疑 = 发起 !== '' && 发起 === String(selfUin ?? '') && 目标 !== String(selfUin ?? '')
  return `拍一拍 发起=${发起 || '?'} 目标=${目标 || '?'}${gid ? ` group=${gid}` : ' 私聊'}`
    + (可疑 ? '［发起=自己的号、目标却是别人：不像是手动戳，查一下来源］' : '')
    + (原形 ? ` 原文「${原形.slice(0, 24)}」` : '')
}

export function 回话时差提示(atSec, now = Date.now()) {
  const t = qqTimeMs(atSec)
  if (t <= 0) return ''
  const gap = now - t
  if (gap < 6000) return ''
  const 秒 = Math.round(gap / 1000)
  const 说 = 秒 < 90 ? `${秒} 秒` : `${Math.round(秒 / 60)} 分钟`
  // HUMANIZE 2026-11-18（批次696，P2-2）：时差是事实，后半「回之前先看看…别把翻篇当现在」是对话策略命令。
  return `（注意：这条是 ${说}前发的，不是刚发生的事。）\n`
}

export function 钱时刻(at, now = Date.now()) {
  const s = String(at || '')
  if (s === '') return ''
  const 今天 = (() => { try { return new Date(now + 8 * 3600e3).toISOString().slice(0, 10) } catch { return '' } })()
  return s.slice(0, 10) === 今天 ? s.slice(11, 16) : s.slice(0, 16)
}

function nicknameOf(uin) {
  const key = String(uin)
  const hit = nicknameCache.get(key)
  if (hit !== undefined && hit !== '') return hit
  maybeRefreshNicknames() // 查不到就顺手补一次，这次先返回空串
  return ''
}

// ---- 统一的消息处理（轮询与 WS 共用） ----

/**
 * 私聊：把一批消息合并成一条投递。
 * 轮询一次可能拉到多条（离线久了积压），合并成一条问出去；
 * WS 一次只来一条，传进来就是一条。
 * @param {any[]} messages 这一批消息（已按时间升序）
 * @param {object} [options]
 * @param {string} [options.leadingNote] 拼在正文最前面的一行说明
 *        （补历史截断时用：告诉 agent「还有 N 条更早的没展开」，别让她以为窗口是完整的）
 * @returns {Promise<string>} 实际投递到的会话 id（没投出去是空串）
 */
const 普通私聊入站 = Symbol('普通私聊入站')

export async function handlePrivateMessages(ctx, uin, messages, options = {}) {
  // IGNORE_UIN 2026-11-12：双实例防互聊。两台 bot 在同一个群里会互相看见对方发言，
  // 看见了就会接，接完对方又接 —— 死循环。各自配置的 ignoreUins 里写对方的 QQ 即可。
  if ((getConfig().ignoreUins || []).map(String).includes(String(uin))) return ''
  // FOLLOWUP_CLEAR 2026-11-03：这个人回话了，追问计时作废
  try { clearFollowup('private:' + String(uin)) } catch { /* 忽略 */ }
  const config = getConfig()
  const state = getState()
  if (messages.length === 0) return ''

  // WAKE_ON_PRIVATE 2026-11-06（批次110）：主人私聊找她，就是把她叫醒。
  // 结算（体力/情绪/精力）走 醒来.mjs，跟群里被 @ 叫醒同一条路 ——
  // 不能只把 sleeping 改 false，那样体力还是 0，下一轮又被判睡。
  try {
    const __flagP = `${MEM}/睡醒.json`
    const __flag = existsSync(__flagP) ? JSON.parse(readFileSync(__flagP, 'utf8')) : null
    if (主人私聊要叫醒(config, uin, __flag, Date.now(), __lastWakeSpawn)) {
      __lastWakeSpawn = Date.now()
      const { spawn } = await import('node:child_process')
      // WAKE_BY 2026-11-16（批次555）：**这是第四条叫醒路径，之前一直没数进来。**
      // 它 spawn 时不带参数、detached、stdio ignore、没有超时 —— 外面完全看不见它跑到哪一步，
      // 也看不见它什么时候才真的执行到 `作息 --醒了`。
      // 实测 11-16 她 08:39:34 睡下、08:44:22 就被结束（5 分钟），而 `最近说话.json` 里
      // 主人最后一次开口是 08:39:13 —— 中间隔了 5 分钟。spawn 是异步的，
      // `醒来.mjs` 要跑 计划/穿衣/早间简报 一串，慢起来几分钟才走到关段那一步。
      // 现在把「谁叫的」传下去，`作息 --醒了` 会把它写进 日志/醒来.log。
      const c = spawn('/usr/local/bin/node', [`${TOOLS}/醒来.mjs`], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, QQ_WAKE_BY: '主人私聊 ' + String(uin) },
      })
      c.unref()
      note('private', `主人私聊叫醒，已触发醒来结算 uin=${uin}`)
    }
  } catch { /* 结算失败不影响投递 */ }
  // FEELING_LEDGER 2026-11-05：这里原来由正则判断「这几句是不是夸我/骂我」再喂激素。
  // 拿真实语料一测，误报率高得离谱 —— 撤掉，改由她自己用 qq_feel 判断。
  // 2026-11-04 修：这个函数的正确性依赖「messages 按时间升序」，但没有任何地方保证。
  // 私聊判新旧用时间戳（早于上次处理就算旧），乱序批次里先处理了晚的那条，早的就被判成旧的丢掉。
  // 用真实群聊数据回放（22 条一段，打乱后灌入）实测：只投出 7 条，丢 15 条。
  // 轮询循环自己排过序，所以线上没暴露；这里补一道兜底，别把正确性押在调用方身上。
  if (messages.length > 1) {
    messages = [...messages].sort((left, right) => qqTimeMs(left?.time) - qqTimeMs(right?.time)
      || (Number(left?.real_seq) || 0) - (Number(right?.real_seq) || 0))
  }
  // LIKE_OUT 2026-11-05：私聊也记「刚收到的那条」，她可以在私聊里给人贴表情。
  try {
    const __last = messages[messages.length - 1]
    if (__last) {
      rememberIncoming({
        messageId: __last.message_id,
        group: '',
        from: String(uin ?? ''),
        text: textOf(__last.message, nicknameOf)
      })
    }
  } catch { /* 记不住不影响主流程 */ }
  const sessionId = pickSessionId(config, 'private', uin)
  if (sessionId === '') {
    note('poll', `skip private：QQ ${uin} 未配置会话`)
    return ''
  }

  // 2026-10-31 小肥鱼修：qq_wait 在任务里旁路读到的消息，群聊那条路径已经会跳过，
  // 私聊这条路漏了 —— 同一句会在私聊里被答两遍。这里同样先按已消费清单过滤。
  const liveMessages = [];
  for (const item of messages) {
    if (await consumedByWait(item.message_id)) {
      note('poll', `private ${uin} 已被等一下读过，跳过 message_id=${item.message_id}`);
      continue;
    }
    liveMessages.push(item);
  }
  if (liveMessages.length === 0) return '';
  messages = liveMessages;
  const last = messages[messages.length - 1]
  const rawPrefix = prefixOf(config, 'private', uin, config.textPrefix)
  // 在私聊前缀里标出「这是用户本人」，否则和群聊消息混在一起时 agent 只能靠猜
  const ownerUinP = String(config.ownerUin ?? '')
  const tag = ownerUinP !== '' && String(uin) === ownerUinP
    ? `·用户本人 QQ ${ownerUinP}）`
    : `·QQ ${uin}）`
  const prefix = rawPrefix.endsWith('）') ? `${rawPrefix.slice(0, -1)}${tag}` : `${rawPrefix}${tag}`
  // ⚠️ 这里**不再**附带「表情标记怎么写」的说明。
  //   之前每条 QQ 消息后面都跟一段「（想发表情就在正文里写 [表情:呲牙]…）」，
  //   结果是同一段话在会话日志里重复上百遍 —— 纯烧 token，
  //   而且混在树树的原话后面，agent 分不清哪句是他说的、哪句是插件塞的，
  //   有可能自己复述给他。
  //   现在这段说明放在两个地方，各说一次就够：
  //     · QQ对话说明.md —— 树树每次开新对话都会发那个文件
  //     · qq_send 工具描述 —— 每次调用都在上下文里
  const leadingNote = typeof options?.leadingNote === 'string' && options.leadingNote !== ''
    ? `${options.leadingNote}\n`
    : ''
  // STATE_TO_CONTEXT 2026-11-07（批次197）：私聊的状态提示 + 主人全权段从「每批正文开头」
  // 挪进 systemPrompt.context()（不进对话历史、每回合一次；挂载在 index.js 的 agent/created，
  // 判据在 stateVoice.js，peer 由 deliver 写入）。正文里只留人话 —— 历史上每批前面
  // 那段 ~2400 字的 [态] 从此不再重复进会话文件。任何一步失败都只是「没有状态提示」，
  // 不影响投递。
  let 状态段 = ''
  if (config.状态进正文 === true) {
    try { 状态段 = stateFastHintOf() } catch { 状态段 = '' }
    // 刚划到的那几条另起一句（批次392 的内容，批次396 挪出快照 —— 快照有硬契约，见 t353 #24）
    try { if (状态段) 状态段 += 刚划到段() } catch { /* 带不上就不带 */ }
    // CACHE_STATIC 2026-11-14（批次484）：慢变体感从 system 搬进来 —— system 只留静态段才能吃到 Prefix Cache。
    try {
      const __lastText = messages.length ? textOf(messages[messages.length - 1].message, nicknameOf) : ''
      const 慢 = 慢变段({ peer: String(uin ?? ''), isPrivate: true, ownerUin: String(config.ownerUin || ''), lastText: __lastText })
      if (慢) 状态段 += (状态段 && !状态段.endsWith('\n') ? '\n' : '') + 慢
    } catch { /* 带不上就不带 */ }
    // LETTER 2026-11-15（批次494）：主人留的话，每轮都在（他要的是「她一定能收到」）
    try { const 留 = 留言段(); if (留) 状态段 += (状态段 && !状态段.endsWith('\n') ? '\n' : '') + 留 } catch { /* 带不上就不带 */ }
  }
  // RECALL_DECOUPLE 2026-11-17（批次663，审计 P1-8）：自动回忆不再挂在「状态进正文」下。
  // 那个开关管的是「状态提示放正文还是 system」，跟要不要翻旧记录无关；
  // 关掉它不该让回忆、梦余味、体感槽一起静默消失。
  const 记忆批次 = QQ记忆批次({ kind: 'private', id: uin }, messages)
  const 忆 = 自动回忆条(记忆批次, config, sessionId)
  // SAID_BACK 2026-11-17（批次693）：私聊原来完全没有「我刚说过什么」——
  // `我说过.jsonl` 只记系统代发的定时话（21 条全是日报/早安），不记她聊天里真正发出去的字；
  // `recentSaid` 那个内存环只在群聊注入。结果 11-16 23:22–23:24 的 80 秒里连发 4 条：
  // 「我这边二十度」讲了三遍，同一条认错也讲了两遍。
  // 这里只摆两件事实：她最近发出去的几句、其中哪两句其实是同一件事。说什么是她自己定。
  try {
    const 刚说 = 刚说过段({ kind: 'private', id: String(uin ?? '') }, 5)
    if (刚说) 状态段 += (状态段 && !状态段.endsWith('\n') ? '\n' : '') + 刚说
  } catch { /* 带不上就不带 */ }
  // PRIVATE_REPLY_RESOLVE 2026-11-12：私聊原来完全没查 reply 段，她只能看到干巴巴的「[回复]你看我引用的东西啦」，
  // 连被引用的是文字还是图片都不知道！这里逐条解析 reply 段，把被引用原文拼进文本，若引用了图片也一并附图。
  const pmReplyTexts = []
  const pmReplyImages = []
  for (const item of messages) {
    let lineText = textOf(item.message, nicknameOf)
    let quotedImgs = []
    try {
      const rSeg = Array.isArray(item?.message) ? item.message.find((s) => s?.type === 'reply') : null
      const rid = Number(rSeg?.data?.id ?? rSeg?.data?.message_id ?? 0)
      if (rid !== 0 && Number.isFinite(rid)) {
        const qr = await callOneBot({ action: 'get_msg', params: { message_id: rid } })
        if (qr?.retcode === 0 && qr?.data) {
          const qm = qr.data
          const qSegs = Array.isArray(qm.message) ? qm.message : []
          // QUOTE_SELF 2026-11-15（批次504）：主人引用的是她自己发过的图/话时，原来只写成
          // 「（引用 大肥鱼：「[图片（已附在下方）]」）」—— 她认不出「大肥鱼」就是自己，
          // 把被引用的图当成主人新发的（实测：她回「你新丢这张倒是细」）。这里按 user_id 判自己。
          const qFromMe = String(qm.sender?.user_id ?? '') !== '' && String(qm.sender?.user_id ?? '') === String(config.selfUin ?? '')
          const qWho = qFromMe
            ? '你自己'
            : String(qm.sender?.card || qm.sender?.nickname || nicknameOf(qm.sender?.user_id) || qm.sender?.user_id || '?')
          const qTxt = textOf(qSegs, nicknameOf).replace(/^\[回复[^\]]*\]\s*/, '').trim()
          const qHasImg = qSegs.some((s) => s?.type === 'image')
          const qSummary = qTxt !== '' ? qTxt.slice(0, 160) : (qHasImg ? '[图片]' : '[媒体消息]')
          // 引用自己的时候必须说白：这是他引用的你发过的东西，不是你收到的新东西。
          const qTag = qFromMe
            ? `（主人引用的是你自己发过的那条：${qSummary}${qHasImg ? '（下面附的就是这张图，是你发的，不是他新发的）' : '（这句话是你自己说的，不是他说的）'}）`
            : `（引用 ${qWho}：「${qSummary}」）`
          lineText = lineText.includes('[回复]') ? lineText.replace('[回复]', qTag) : `${qTag}${lineText}`
          if (qHasImg) {
            quotedImgs = await buildImageBlocks(ctx, [qm])
          }
          if (qSegs.some((s) => s?.type === 'video' || s?.type === 'file')) {
            const qFiles = await buildFileBlocks(ctx, [qm])
            if (qFiles.length > 0) lineText += '\n' + qFiles.map((b) => b.text).join('\n')
          }
        }
      }
    } catch (e) { note('private', '解析私聊引用失败：' + (e?.message ?? e)) }
    pmReplyTexts.push(`${时刻缀(timeOf(item))}${prefix}${lineText}`)
    pmReplyImages.push(quotedImgs)
  }
  const orderedLeadingText = (状态段 === '' ? '' : 状态段 + '\n') + leadingNote
    + 回话时差提示(timeOf(last))
  const body = orderedLeadingText + pmReplyTexts.join('\n')
  // 带上 uin：回信要能原路投回这个人，不能默认回给 peerUin
  // 打个点：这一刻有人说话了。补静默（replyQuietMs）从这里开始计时，
  // 必须早于 deliver —— deliver 里的等待是串行的，晚打点会让「连发续期」失效。
  const peerKey = `private:${String(uin)}`
  // LATENCY_COMP 2026-11-16（批次582）：打点用最后一条消息的**原始时间**，不是投递时刻。
  // 合并窗口里等掉的时间也要算进「他等了多久」，否则延迟补偿会把这段漏掉。
  markIncoming(peerKey, qqTimeMs(last?.time))
  // PRECHECK 2026-11-16（批次582）：记下这一批已经投给她，qq_send 发送前据此对账。
  markDeliveredBatch(peerKey, messages)
  // 自动记关系卡：称呼（消息里带昵称就用它，没有就查好友缓存）+ 说话次数 + 最后说话时间
  touchPeer(peerKey, { nick: String(last?.sender?.nickname ?? '') || nicknameOf(String(uin)) })
  // 按消息逐条取附件：图片下载失败时也不会把后续图片错配到前一条消息。
  const imageByMessage = []
  const fileByMessage = []
  for (let i = 0; i < messages.length; i += 1) {
    const item = messages[i]
    const ownImgs = await buildImageBlocks(ctx, [item])
    const qImgs = pmReplyImages[i] ?? []
    imageByMessage.push([...qImgs, ...ownImgs])
    // FILE_IN 2026-11-05（批次90）：私聊文件（主人发 x.txt / cookie / 配置）也要真取下来。
    fileByMessage.push(await buildFileBlocks(ctx, [item]))
  }
  const hasMedia = imageByMessage.some((blocks) => blocks.length > 0) || fileByMessage.some((blocks) => blocks.length > 0)
  const orderedContent = hasMedia
    ? 组装私聊内容块(messages.map((_item, index) => ({
        text: pmReplyTexts[index],
        images: imageByMessage[index] ?? [],
        files: fileByMessage[index] ?? [],
      })), orderedLeadingText)
    : undefined
  const used = await deliver(
    ctx,
    sessionId,
    body,
    { kind: 'private', id: String(uin) },
    imageByMessage.flat().concat(fileByMessage.flat()),
    {
      voiceText: textOf(last?.message),
      memorySource: options[普通私聊入站] ? 标记QQ私聊入站(记忆批次.source) : 记忆批次.source,
      lifeMemory: 忆,
      previousMessageAt: state.privates[uin]?.lastDeliveredMessageAt,
      messageTimes: 记忆批次.rows.map(({ at }) => at),
      orderedContent: orderedContent ?? null,
      // PRECHECK_INBOX 2026-11-16（批次587）：把这一批 QQ 消息 id 带到 deliver，
      // precheck 拦下时才能从 inbox.next-turn 撤回，避免同一句再开一回合。
      qqMessageIds: messages
        .map((item) => Number(item?.message_id))
        .filter((id) => Number.isFinite(id) && id !== 0)
    },
  )
  // BREATHE_PRIVATE_OFF 2026-11-03：私聊不抢答——一对一里先垫一句像敷衍，
  // 主人截了图说「马上回你」这半句不是我敲的，明确当 bug。群里照旧，冰屋仍排除。
  if (used === '') return ''

  // 投递成功才推进游标（失败留着，下轮重试）
  // 注意：不写 lastId 了 —— SnowLuma 的 message_id 可能是负数，比大小不可靠，
  // 这个字段实际只对「没有 seq 的旧消息」有用；现在所有消息都带 seq，
  // 留着旧值只为兼容老 state 文件，不再更新（详见 README「已知缺口」）。
  //
  // ⚠️ lastTime 才是私聊真正的游标（lastSeq 因为两套编号混着已不可用于判新旧）。
  //   lastTime 取这一批里**最新的**那条的时间 —— messages 已按时间升序排好，
  //   所以就是最后一条。但要防一手：万一排序没生效，取 max 更稳。
  const cursor = state.privates[uin] ?? {}
  const newestTime = messages.reduce((max, item) => Math.max(max, timeOf(item)), 0)
  state.privates[uin] = {
    ...cursor,
    // lastSeq 仍然记着（兼容老 state / 迁移用），但不再用于判新旧
    lastSeq: seqOf(last) ?? cursor.lastSeq,
    lastTime: Math.max(cursor.lastTime ?? 0, newestTime, timeOf(last)),
    lastDeliveredMessageAt: Math.max(cursor.lastDeliveredMessageAt ?? 0, qqTimeMs(last?.time))
  }
  for (const item of messages) markSeen(state.privates[uin], item)
  saveState({ privates: state.privates })
  // 投递成功才算「他这次真的说过话」—— 主动搭话的空闲计时和退避都从这里归零。
  // 放在成功分支里：投递失败的批次不算互动过，否则她刚「想他」就被自己哄了。
  notePeerActivity(`private:${String(uin)}`)
  return used
}

// ---------------------------------------------------------------------------
// 私聊合并窗口（标记已读的中间态）
//
// WS 通路原来是「来一条投一条」：对方连发三句就开三个回合、被连问三遍。
// 现在改成「先记账（markSeen + 游标推进）→ 入池攒一会儿 → 一起放行」。
// 只有私聊走这条路：群里是 @ 才投递，一条 @ 就是一件事，攒起来反而怪。
// ---------------------------------------------------------------------------

/** uin → 这批消息入池之前的游标快照（投递失败要撤回去，让轮询能重试）。 */
const mergeSnapshots = new Map()

const privateMerge = createMergeQueue(async (uin, messages, ctx) => {
  const used = await handlePrivateMessages(ctx, uin, messages, { [普通私聊入站]: true })
  if (used !== '') {
    mergeSnapshots.delete(uin)
    note('merge', `private ${uin} 合并放行 x${messages.length} -> ${used}`)
    return used
  }
  // 投递失败：把这批的「已读」记账撤回去，别让它们既没投出去也再没人重试
  const snapshot = mergeSnapshots.get(uin)
  mergeSnapshots.delete(uin)
  if (snapshot !== undefined) {
    const st = getState()
    // 2026-11-04 修：原来整份写回 snapshot，但 snapshot.seenIds 与线上是同一个数组，
    // 这批消息的 id 还留在里面 → isSeen 判成已处理 → 永远不再重试。改成逐条撤销。
    const cur = st.privates[uin] ?? {}
    rollbackSeen(cur, messages, snapshot)
    if (snapshot.lastTime !== undefined) cur.lastTime = snapshot.lastTime
    saveState({ privates: st.privates })
    note('merge', `private ${uin} 投递失败，已回滚记账待重试（x${messages.length}）`)
  }
  return ''
})

/** 设置页 / 排障用：现在池子里攒着什么。 */
export function mergePending() {
  return { settings: mergeSettings(), pools: privateMerge.pending() }
}

/** 插件卸载时把池子清掉：ctx 正在卸载，不能在这时候再投递。 */
export function drainMerge() {
  const dropped = privateMerge.discard()
  const total = dropped.reduce((sum, item) => sum + item.count, 0)
  mergeSnapshots.clear()
  if (total > 0) {
    // 这些消息的「已读」记账已经推进过，所以不会再被轮询拎起来 ——
    // 但上线补历史会按游标之前的窗口捞回来，不是永久丢失。日志里要留痕。
    note('merge', `卸载时丢弃 ${total} 条未放行的消息（${dropped.map((item) => item.uin).join(',')}），已读记账未回滚`)
  }
  return total
}

/**
 * 群聊：处理一条（通常是 @ 到自己的）消息，带上未读群消息当上下文。
 *
 * 返回值是**状态**，不是会话 id —— 「不是 @ 所以跳过」和「投递失败」必须分得开：
 * 早先两者都返回空串，轮询那边把跳过当成失败，回滚游标并 break，
 * 结果后面几条 @ 消息永远轮不到（群消息就再也没进过会话）。
 *
 * @param {any[]} history 该群最近的消息（用于挑未读上下文）；没有就现拉一次
 * @param {number} [sinceSeqOverride] 未读基准（同一批里算上下文要用批开始时的值，
 *        否则第一条一投递就把基准推走了，第二条的上下文里会少掉它）
 */
export async function handleGroupMessage(ctx, groupId, message, history, sinceSeqOverride) {
  // IGNORE_UIN 2026-11-12：群里的发言也要挡（同上，防两台 bot 互接）。
  if ((getConfig().ignoreUins || []).map(String).includes(String(message?.sender?.user_id ?? ''))) return ''
  // FOLLOWUP_CLEAR 2026-11-03：这个群有人说话了，追问计时作废
  try { clearFollowup('group:' + String(groupId)) } catch { /* 忽略 */ }
  const config = getConfig()
  const state = getState()
  // 2026-11-04 修：戳一戳路径会直接调进这个函数，那时这个群的 state 桶可能还没建过，
  // 后面 markSeen(state.groups[groupId], ...) 拿到 undefined 会抛 TypeError，整条 poke 就丢了。
  if (state.groups === null || typeof state.groups !== 'object') state.groups = {}
  if (state.groups[groupId] === undefined) state.groups[groupId] = { seenIds: [], lastSeq: 0 }
  // 自己发的消息（协议端回放的历史里会有）不投递，也不进上下文 —— 否则她会用第三人称聊自己
  const selfUinEarly = String(config.selfUin ?? '')
  if (selfUinEarly !== '' && String(message?.sender?.user_id ?? '') === selfUinEarly) {
    return { status: 'skipped' }
  }
  const nowMs0 = Date.now()
  const atMe = isAtMe(message.message, config.selfUin)
  // OCAI 2026-11-02：将 text 定义提前到 RENSHI_HOOK 之前，修复原代码在 const text 声明前引用 text 导致的 TDZ ReferenceError（原意是用本条群消息文本调认事脚本）
  const text = textOf(message.message, nicknameOf)
  // LIKE_OUT 2026-11-05：记住「刚收到的这条」，qq_react 不传 message_id 时贴它。
  // 她看不到消息号（上下文里只有「群友「阿猫」：内容」），
  // 但「贴给对方刚说的那句」恰恰是最常见的用法 —— 不能因为拿不到 id 就用不了。
  try {
    rememberIncoming({ messageId: message.message_id, group: String(groupId ?? ''), from: String(message?.sender?.user_id ?? ''), text })
  } catch { /* 记不住不影响主流程 */ }
  // RENSHI_OFF 2026-11-05：这里原来**每条群消息**都 spawn 一次 认事.mjs，
  // 由 奖惩.mjs --识别 用正则判「这句在夸她 / 骂她 / 催她 / 越界」，然后直接改
  // 状态.json / 好感度.json / 耐心 / 关系.json。
  //
  // 撤掉的理由是它自己的账本（奖惩.json 那 6 条里 5 条是误判）：
  //   「别是又变成滚木了」                        → 判成「坏话」，扣 1.2
  //   「定时挂在凌晨 4:20。这样她翻旧账会越来越不准」 → 判成「越界」，扣 0.9
  //   「③这条我不同意照抄。只注入当前触发者的画像」  → 判成「被记得」，**加** 0.9
  //   「③「每条生成只注入当前触发者一个人的好感/印象」」→ 判成「被记得」，加 1.0
  // 全是技术讨论。和当初「滚=骂人」是同一个病，只是这条一直没被拆。
  //
  // 现在：被夸、被骂、被冒犯，由她自己用 qq_feel 记（感受.mjs → 激素 + 好感度）。
  // 认事.mjs 和 奖惩.mjs --识别 留在原地没删 —— 哪天想看历史判断逻辑还查得到，
  // 但**不再有任何东西调它们**。

  const ownerUinGate = String(config.ownerUin ?? config.peerUin ?? '')
  const senderUinGate = String(message?.sender?.user_id ?? '')
  const fromOwnerGate = ownerUinGate !== '' && senderUinGate === ownerUinGate
  // 2026-11-01 肥鱼加：他引用某条消息时，把被引用的内容取回来（reply 段只有 id，没有原文）
  let quotedBlock = ''
  // 2026-11-04：记下「被引用的那条是不是她自己说的」——
  // 有人引用她的话反驳，和引用别人的话，性质完全不同。
  let quotedFromMe = false
  let quotedImageBlocks = []
  try {
    const replySeg = Array.isArray(message?.message)
      ? message.message.find((seg) => seg?.type === 'reply')
      : null
    const replyId = Number(replySeg?.data?.id ?? 0)
    if (replyId > 0) {
      // QUOTE_FALLBACK 2026-11-03：reply 段里的 id 未必是 message_id，多试几个；都不行就翻群历史
      let qm = null
      const candidates = [replyId, Number(replySeg?.data?.message_id ?? 0), Number(replySeg?.data?.seq ?? 0)].filter((x) => x > 0)
      for (const cand of candidates) {
        try {
          const r = await callOneBot({ action: 'get_msg', params: { message_id: cand } })
          if (r?.retcode === 0 && r?.data) { qm = r.data; break }
        } catch { /* 换下一个候选 */ }
      }
      if (!qm) {
        try {
          const gid = Number(message?.group_id ?? 0)
          if (gid > 0) {
            const h = await callOneBot({ action: 'get_group_msg_history', params: { group_id: gid, count: 80 } })
            const arr = Array.isArray(h?.data?.messages) ? h.data.messages : []
            const ids = new Set(candidates.map(String))
            qm = arr.find((m) => [m?.message_id, m?.real_id, m?.message_seq, m?.real_seq].some((v) => ids.has(String(v)))) || null
            if (qm) note('group', '引用 ' + replyId + ' 从群历史补到了')
            else note('group', '引用 ' + replyId + ' 翻历史也没找到')
          }
        } catch (e) { note('group', '翻历史补引用失败：' + (e?.message ?? e)) }
      }
      if (qm) {
        const segs = Array.isArray(qm.message) ? qm.message : []
        const qText = textOf(segs, nicknameOf).trim()
        const qImgs = segs
          .filter((seg) => seg?.type === 'image')
          .map((seg) => String(seg?.data?.url ?? seg?.data?.file ?? ''))
          .filter((u) => u !== '')
        const who = String(qm.sender?.card || qm.sender?.nickname || nicknameOf(qm.sender?.user_id) || qm.sender?.user_id || '?')
        quotedFromMe = String(qm.sender?.user_id ?? '') === String(config.selfUin ?? '')
        const body = qText !== '' ? qText.slice(0, 200) : (qImgs.length > 0 ? '[图片（已附在下方）]' : '[非文字消息]')
        // QUOTE_SELF 2026-11-15（批次504）：引用的是她自己时说明白，别让她当成别人新发的。
        quotedBlock = quotedFromMe
          ? `（他引用的是你自己发过的那条 —— ${body}；这是你说的，不是他新发的）\n`
          : `（他引用了这条 —— ${who}：${body}）\n`
        if (qImgs.length > 0) {
          try { quotedImageBlocks = await buildImageBlocks(ctx, [qm]) } catch {}
        }
      }
    }
  } catch (error) {
    note('group', `读引用失败：${error instanceof Error ? error.message : error}`)
  }

  // 2026-11-04：有人引用她的话说「没跟你说话」= 明确让她闭嘴。
  // 不接这条，并且退让 3 分钟 —— 刚被人赶走还继续对呛是最伤口碑的一种表现。
  if (isPushback(text) && quotedFromMe) {
    try { muteFor(targetKeyOf({ kind: 'group', id: String(groupId) }), 180000) } catch { /* 忽略 */ }
    note('group', `群 ${groupId} 被明确拒绝（${text.slice(0, 20)}），退让 3 分钟 seq=${seqOf(message)}`)
    return { status: 'skipped' }
  }

  const calledByNameGate = calledByMyname(text)
  const threadContinuation = 是持续对话(String(groupId), String(message?.sender?.user_id ?? ''), Date.now(), config)
  // 这条 @ 的是别人、又没点我名字 → 不插嘴（哪怕说话的是主人）
  const atOthers = 是否艾特别人(message?.message, config.selfUin)
  // 2026-11-02 AT_OTHER_SCORE：这里原本给「主人 @ 别人」留了一条打分通道
  //   （@ 是给人看的、话是说给我的，够分就投）。
  // 2026-11-08（批次235）：主人要求「在多人群也跟其他人一样的对话闸」——
  //   同一句「@别人」，主人说可能投进来、群友说一律让位，这就是两套闸。
  //   现在统一：@ 了别人又没点她，谁说的都让位。
  if (atOthers && !atMe && !calledByNameGate) {
    note('group', 'group ' + groupId + ' @ 了别人、没点她，让位 seq=' + seqOf(message))
    return { status: 'skipped' }
  }
  // 2026-11-01 肥鱼改：这道门不再拦人。用户原话「关键是收不收的到消息，别像门禁一样锁死了，要自己判断」。
  // 没 @ 她、没点她名 —— 照样投递，只在正文里标一句，让她自己决定接不接。
  // 批次235：原来这里排除了「主人说的」，主人不会收到这句提示；现在他也一样。
  const notAddressed = config.groupOnlyWhenAt && !atMe && !calledByNameGate && !threadContinuation
  if (notAddressed) {
    note('group', `${groupId} 没点名也投递（由她判断） seq=${seqOf(message)}`)
  }

  // 2026-11-04 肥鱼：**外群**里不被点名就别主动接（主人在 1051483012 看到她对别人的卡片插话后要求改）。
  // 冰屋 806972995、冰服务 983903493 仍旧投递进来由她自己判断；其它群没 @、没点名 → 直接跳过，只留上下文。
  // 批次235：原来这句还带着「也不是主人说的」，于是外群里主人随便说一句也能起一轮；现在他也得 @ 或点名字。
  // OWN_GROUPS 提到模块级了（批次352），筛批判据共用同一份。
  // AT_OTHERS_QUIET 2026-11-05：主人在外群 @ 了别人、没 @ 她，那是说给别人的，她别接。
  // 起因：素罗批发群里主人 @了瓜妹说「我命令你去开僵毁服」，她回了一句，主人当场「没叫你」。
  let __atOther = false
  try {
    for (const __s of (Array.isArray(message?.message) ? message.message : [])) {
      if (String(__s?.type) !== 'at') continue
      const __q = String(__s?.data?.qq ?? '')
      if (__q && __q !== 'all') __atOther = true
    }
  } catch { /* 段坏了就当没 @ 别人 */ }
  // PEEK_2026-11-06（主人要求「推得到，但只看看」）：外群 @ 别人也照样推进来，让她看见；
  // 接不接由她自己定，不在这里拦。
  if (__atOther && !atMe && !calledByNameGate && !OWN_GROUPS.has(String(groupId))) {
    note('group', `${groupId} 外群 @了别人，不进回合（只留上下文） seq=${seqOf(message)}`)
    return { status: 'skipped' }
  }

  // PEEK_2026-11-06：外群没点名也推进来，只让她看，不自动接。
  if (!OWN_GROUPS.has(String(groupId)) && !atMe && !calledByNameGate && !quotedFromMe && !threadContinuation && !URGENT_RE.test(text)) {
    note('group', `${groupId} 外群未点名，不进回合（只留上下文） seq=${seqOf(message)}`)
    return { status: 'skipped' }
  }
  // ---- 纯表情包/图片不接话（2026-10-31 用户要求）----
  // 理由：表情包、贴图往往只是表达情绪，硬接一句反而不像人。
  // 规则：没有文字、只有 image/mface/face/video，且没 @ 也没点名字 → 直接跳过（连上下文缓存照留）。
  // 有文字就照常判断；@ 了或喊了名字，就算只有张图也当他是想让我看。
  const mediaOnly = 只有媒体(message?.message, text)
  // SEE_ALL 2026-11-06（主人要「全部改成会看，回不回我自己决定」）：纯图也投进来，
  // 只标一句让她知道这不是点她的，接不接她自己判。
  if (mediaOnly && !atMe && !calledByNameGate) {
    note('group', `${groupId} 只发图没点她，照投，由她判断 seq=${seqOf(message)}`)
  }
  if (text === '' && !atMe) return { status: 'skipped' }

  // 2026-11-02 SAME_TEXT_GUARD：同一句被投两次时，第二次直接咽掉
  try {
    const fpText = String(text ?? '').trim().slice(0, 60)
    if (fpText !== '') {
      const fpKey = String(groupId) + ':' + String(message?.sender?.user_id ?? message?.user_id ?? '') + ':' + fpText
      const lastAt = sameTextAt.get(fpKey) ?? 0
      if (nowMs0 - lastAt < SAME_TEXT_WINDOW_MS) {
        note('group', 'group ' + groupId + ' 同一句八秒内重复，跳过 seq=' + seqOf(message))
        return { status: 'skipped' }
      }
      sameTextAt.set(fpKey, nowMs0)
      if (sameTextAt.size > 200) {
        for (const k of [...sameTextAt.keys()].slice(0, 100)) sameTextAt.delete(k)
      }
    }
  } catch { /* 指纹算不出来就照常走 */ }

  // 睡眠时段：只认 @（2026-11-01 用户定：两点到九点）
  // WAKE_ON_AT 2026-11-03：睡眠时段被 @ 醒 = 被打断的觉，先结算再说话
  if (inSleepWindow(config) && isAtMe(message.message, config.selfUin)) {
    try {
      const { spawn } = await import('node:child_process')
      const c = spawn('/usr/local/bin/node', [`${TOOLS}/醒来.mjs`], { detached: true, stdio: 'ignore' })
      c.unref()
      note('group', '睡眠时段被 @，已触发醒来结算')
    } catch { /* 结算失败不影响说话 */ }
  }
  // ACTIVE_PEER_HOOK 2026-11-03：记录「她最近在跟谁说话」，只观测，不改说话行为（动态导入，避免动 import 段）
  try {
    const __ap = await import('./active-peer.js')
    const __self = String(config && config.selfUin ? config.selfUin : '')
    const __sender = String(message && message.sender && message.sender.user_id ? message.sender.user_id : '')
    const __text = String(message && message.raw_message ? message.raw_message : '')
    const __ats = []
    for (const seg of ((message && message.message) || [])) if (seg && seg.type === 'at') __ats.push(String((seg.data && seg.data.qq) || ''))
    if (__sender !== '' && __sender !== __self) __ap.notePeerSpoke(groupId, __sender, __text, __ats, __self)
  } catch { /* 观测失败不影响主流程 */ }
  if (inSleepWindow(config) && !isAtMe(message.message, config.selfUin)) {
    note('group', `${groupId} 睡眠时段未@，只记录不起一轮 seq=${seqOf(message)}`)
    return { status: 'skipped' }
  }
  // 让位：他刚跟另一只聊着，又没点我名 → 这次不出声
  if (shouldYieldToSibling(message, history, config, groupId)) {
    note('group', `${groupId} skip (yield to sibling) seq=${seqOf(message)}`)
    return { status: 'skipped' }
  }
  const sessionId = pickSessionId(config, 'group', groupId)
  if (sessionId === '') {
    note('group', `${groupId} skip（未配置会话）seq=${seqOf(message)}`)
    return { status: 'skipped' }
  }
  const groupName = groupNames.get(groupId) ?? ''
  // 身份标记：必须让 agent 一眼看出这条是不是用户本人发的。
  // 之前只给「昵称 + QQ 号」，没告诉过她哪个号是用户，别人说话她也会当成用户。
  const ownerUin = String(config.ownerUin ?? config.peerUin ?? '')
  const senderUin = String(message?.sender?.user_id ?? '')
  const fromOwner = ownerUin !== '' && senderUin === ownerUin
  const senderLabel = fromOwner
    ? `用户本人（QQ ${senderUin}）`
    : `群友「${message?.sender?.nickname || nicknameOf(senderUin) || '未知'}」（QQ ${senderUin || '未知'}，不是用户本人）`
  // SELF_NAME 2026-11-15（批次506）：整段群注入从没说过「大肥鱼」就是她自己。
  // 实测 19:13 群友说「大肥鱼是个鸡鲅」，她回「那张不是刚才那只鸡吗」—— 把名字当成了图里的鸡；
  // 紧接着「大肥鱼三分钟就萎了」，她回了句医生的图。名字锚点必须在，而且要比图更靠前。
  const __selfName = String(process.env.QQ_SELF_NAME || '大肥鱼')
  // SELF_ALIAS 2026-11-23：别名原来是写死的「肥鱼」，哈基米这套里谁也不会这么叫她，
  // 于是每次群注入都在教她一个错的称呼。改成可配，空字符串就是不提别名。
  // 空字符串是「没有别名」，不能用 || 兜底 —— 那会把「故意留空」又变回 肥鱼
  const __selfAlias = (process.env.QQ_SELF_ALIASES === undefined ? '肥鱼' : String(process.env.QQ_SELF_ALIASES)).trim()
  const __aliasSeg = __selfAlias ? `，也有人直接喊「${__selfAlias}」—— 群里说到这两个名字` : '—— 群里说到这个名字'
  const head = `（QQ群 ${groupId}${groupName === '' ? '' : `「${groupName}」`}·${senderLabel}`
    + `｜你自己叫「${__selfName}」${__aliasSeg}就是在说你，不是图里的东西，也不是别人的外号）`

  // ⚠️ 同样**不再**附带「表情标记怎么写」的说明（理由见私聊路径的注释）。
  //   表情用法在 QQ对话说明.md 和 qq_send 工具描述里各说一次就够。

  // 只在这条被 @ 的消息上附带「之前的几条」，而不是把整段历史都塞进来：
  // 既有前因后果，又不会因为群里每句话都跑一个回合。
  const contextCount = Math.min(3, Math.max(0, Number(config.groupContextCount) || 0))
  const nameOfSender = (item) => {
    const uin = String(item?.sender?.user_id ?? '')
    if (ownerUin !== '' && uin === ownerUin) return '用户本人'
    // MULTI_PARTY 2026-11-05：多人同时说话时，光靠昵称分不清谁是谁
    // （同名、昵称为空都会撞）。带上 QQ 尾号，短、稳定、不撞名。
    const nick = String(item?.sender?.nickname || nicknameOf(uin) || '未知')
    const tail = uin !== '' ? '#' + uin.slice(-4) : ''
    return `群友「${nick}」${tail}`
  }
  // 只带「上次投递之后新出现的」群消息，最多 groupContextCount 条。
  // 之前是无条件往回数 N 条 —— 那些她早就看过的内容会被反复塞进上下文。
  // 2026-11-18：时间优先，同秒只信 real_seq；普通 message_seq 是随机编号。
  const deliveredCursor = state.groups[groupId] ?? {}
  const sinceTime = Number(deliveredCursor.lastDeliveredTime ?? 0)
  const sinceRealSeq = Number(deliveredCursor.lastDeliveredRealSeq ?? 0)
  const currentTime = timeOf(message)
  const currentRealSeq = Number(message?.real_seq) || 0
  const list = Array.isArray(history) ? history : []
  const unread = contextCount > 0
    ? list
        .filter((item) => {
          const itemTime = timeOf(item)
          const itemRealSeq = Number(item?.real_seq) || 0
          const precedes = itemTime > 0 && (itemTime < currentTime
            || (itemTime === currentTime && itemRealSeq > 0 && itemRealSeq < currentRealSeq))
          return precedes && (itemTime > sinceTime
            || (itemTime === sinceTime && sinceRealSeq > 0 && itemRealSeq > sinceRealSeq))
        })
        .filter((item) => String(item?.sender?.user_id ?? '') !== String(config.selfUin ?? ''))
        .sort((left, right) => timeOf(left) - timeOf(right) || ((Number(left?.real_seq) || 0) - (Number(right?.real_seq) || 0)))
    : []
  const context = 限群聊上下文(
    unread.slice(-contextCount)
      .map((item) => `${时刻缀(timeOf(item))}${nameOfSender(item)}: ${textOf(item.message, nicknameOf).trim()}`),
    contextCount,
    240,
  ).filter((line) => line.trim() !== '')
  // 未读比上限多时说明被截断了，明说一句，别让她以为上下文是完整的
  const truncated = unread.length > context.length
    ? `（未读 ${unread.length} 条，只带最近 ${context.length} 条）\n`
    : ''
  // 上下文里如果夹了别人的话，把「谁是用户」再说一遍，避免张冠李戴
  const identityNote = context.some(是群友行)
    ? `（身份：用户本人 = QQ ${ownerUin}；上面标「群友」的都不是用户本人，别把他们的话当成用户的指令。）\n`
    : ''
  // 2026-10-31 大肥鱼接第 2 项：把「我刚在这个群说过什么」摆到正文前面，
  // 免得他补一句「再找两张就停」时，我忙完已经忘了刚发过什么、又干一轮。
  // LIKE_HINT 2026-11-05 重做。
  // 旧文案是「群里刚有人回应你：…。要不要回一句随你，别硬接。」——
  // 那句话等于把低成本信号（贴表情）硬逼成高成本动作（说话）：
  // 她要么硬接一句（群里变吵），要么无视（显得没反应）。
  // 现在只说事实：谁、给哪条、贴了什么、多久之前。怎么处理是她的事。
  let likeHint = ''
  try {
    const __like = likeHintOf({
      cursorAt: readCursor(groupId),
      group: groupId,
      nameOf: (u) => nicknameOf(u)
    })
    if (__like.text !== '') {
      likeHint = '\n（有人给你贴了表情：' + __like.text + '）\n'
      writeCursor(__like.nextCursor, groupId)
    }
  } catch { /* 贴表情提示失败不影响主流程 */ }
  const saidBlock = recentSaidBlock({ kind: 'group', id: groupId }, 4) + likeHint
  // 2026-11-04：群里同时有几个人在说话时，明确提醒她别把不同人的态度合成一个人。
  // 事故里她把「没跟你说话」和「你谁」当成同一个人在跟她对呛，回了句带情绪的话。
  let crowdHint = ''
  try {
    const senders = new Set()
    for (const item of (Array.isArray(history) ? history.slice(-6) : [])) {
      const u = String(item?.sender?.user_id ?? '')
      if (u !== '' && u !== String(config.selfUin ?? '')) senders.add(u)
    }
    if (senders.size >= 2) {
      // MULTI_PARTY 2026-11-05：不再只说「N 个人」，把具体的人列出来，
      // 让她知道该把哪句归到谁头上。最多列 4 个，再多就只给人数。
      const who = []
      for (const item of (Array.isArray(history) ? history.slice(-6) : [])) {
        const u = String(item?.sender?.user_id ?? '')
        if (u === '' || u === String(config.selfUin ?? '')) continue
        const nick = String(item?.sender?.nickname || nicknameOf(u) || '未知')
        const tag = '「' + nick + '」#' + u.slice(-4)
        if (!who.includes(tag)) who.push(tag)
      }
      const list = who.slice(0, 4).join('、')
      crowdHint = '（提示：刚才这几条是 ' + list + (who.length > 4 ? ' 等' : '') + ' 在说的。谁问的你、谁只是路过，看每行开头的名字和编号，别把 A 的问题当成 B 的。）\n'
    }
  } catch { /* 拼不出来就不加 */ }
  // IMG_NOT_TOPIC 2026-11-15（批次506）：群里「纯图不配话」她原来每条都要解说画面 ——
  // 19:08–19:15 七分钟 9 条里 6 条在描述图片，主人当场说「token喂狗了」「图像识别功能不行」。
  // ⚠️ 这里不能复用 只有媒体()：它的判据是 text === ''，而 textOf 会给图片生成「[图片]」，
  //    于是恒假（MEMORY 里记的老坑）。自己剥掉占位符再看还剩不剩正文。
  const mediaHint = 纯图无正文(message?.message, text)
    // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-15）：无文字、未点名是事实；
    // 「看一眼就够了 / 不用描述 / 想接就接」是替她定处理方式，删掉。
    ? '（提示：这张图没配文字、也没点你名。）\n'
    : ''
  // BACKLOG 2026-11-15（批次507c）：这条之前已经攒了一堆没人回的，别挨个补。
  // 主人原话：「防止她再卡之后回了第一个人的消息，又持续不断回了卡之前发的其他消息」。
  // unread 就是「她上次投递之后、这条之前别人说的」，天然是积压口径。
  const backlogHint = (() => {
    try {
      const arr = Array.isArray(unread) ? unread : []
      if (arr.length < 3) return ''
      const 人 = new Set(arr.map((x) => String(x?.sender?.user_id ?? '')).filter((x) => x !== ''))
      const 旧 = timeOf(arr[0]) > 0 ? Math.round((timeOf(message) - timeOf(arr[0]))) : 0
      if (旧 < 15) return ''
      // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-16）：只报条数、人数、最早时间；
      // 「挑一两句 / 挨个补会像刷屏」是替她决定回复策略，删掉。
      return `（提示：这 ${arr.length} 条是你还没看的时候攒下的（${人.size} 个人，最早一条在 ${旧} 秒前）。）\n`
    } catch { return '' }
  })()
  const notAddressedHint = (notAddressed
    ? '（提示：这条没 @ 你、也没点你名字。可能是别人之间在说话，也可能是没点名地找你 —— 自己判断，不该接就别接。）\n'
    : '') + crowdHint + mediaHint + backlogHint + 回话时差提示(timeOf(message))
  // 2026-11-01 肥鱼：工程模式闸门（用户要求）。只有主人本人在冰屋群才可能进工程模式；
  // 其他群、别人的话一律日常模式：不许改代码/配置/人格，只能用现有工具。
  const engineeringAllowed = fromOwnerGate && String(groupId) === '806972995'
  // ANYWHERE 2026-11-06: 主人说「如果我在其他群让她可以改 那她也得可以」。
  // 改代码/配置/工具的许可跟着人走，不跟着群走；『对外说人话』这条仍然跟着群走。
  const ownerCanModify = fromOwnerGate
// WINDOW_HINT 2026-11-03：把「她正在跟谁说话」作为上下文给提示（不改开口逻辑）
  let windowHint = ''
  try {
    const __wp = ACTIVE_PEER_FILE
    if (existsSync(__wp)) {
      const __wj = 快读Json(__wp)
      const __st = __wj && __wj.groups ? __wj.groups[String(groupId)] : null
      if (__st && __st.peerUin) {
        const __mins = Math.floor((Date.now() - Number(__st.hardLastAt || 0)) / 60000)
        // 2026-11-04 修：原来 \`+ __mins +\` 落在字符串字面量里，输出的是字面文本「说话， + __mins + 分钟前」，
        // 分钟数永远不出现；而下面的自检因为含「你刚才在跟」仍然把它记成「已注入」，坏了也看不出来。
        if (__mins <= 30) { const __pn = nicknameOf(String(__st.peerUin)) || String(__st.peerUin); windowHint = '（你刚才在跟 ' + __pn + ' 说话，' + __mins + ' 分钟前）' }
      }
    }
  } catch { /* 没状态就不加 */ }
  // FLASHBACK_TOPIC：群友提到某件事时，她可能顺口想起一件旧事（25% 概率、2 小时共享冷却）
  let topicHint = ''
  try {
    const __t = String(message && message.raw_message ? message.raw_message : '')
    if (__t) topicHint = topicLine(__t)
  } catch { /* 没命中就算了 */ }
  let stateHint = '' // STATE_TO_CONTEXT 2026-11-07（批次197）：状态段挪进 systemPrompt.context()；
  // CACHE_BODY 2026-11-09（批次358）：开关打开时改回正文携带（stateVoice 同步跳过）。
  if (config.状态进正文 === true) {
    try { stateHint = stateFastHintOf() } catch { stateHint = '' }
    try { if (stateHint) stateHint += 刚划到段() } catch { /* 带不上就不带 */ }
    // CACHE_STATIC 2026-11-14（批次484）：同上，群聊也把慢变段搬进正文。
    try {
      const 慢 = 慢变段({ peer: String(groupId ?? ''), isPrivate: false, ownerUin: String(config.ownerUin || ''), lastText: text })
      if (慢) stateHint += (stateHint && !stateHint.endsWith('\n') ? '\n' : '') + 慢
    } catch { /* 带不上就不带 */ }
    // LETTER 2026-11-15（批次494）：群聊也带 —— 他写给她的，在哪都该收到
    try { const 留 = 留言段(); if (留) stateHint += (stateHint && !stateHint.endsWith('\n') ? '\n' : '') + 留 } catch { /* 带不上就不带 */ }
  }
  // RECALL_DECOUPLE 2026-11-17（批次663）：群聊**刻意不调**自动回忆。
  // 群里注入等于把私聊日记/梦念给别人听；这里不接，比接上再靠函数内部判权限更稳。
  // 工程模式「不注入」改由投递的 voiceMute 传递（见下 deliver 调用与 stateVoice.js）
  // QUIET_ENGINEER_PROMPT 2026-11-03：工程模式别插嘴，除非被肥鱼点名问、或自己发现自己的 bug
  // 2026-11-18：「好」可能在确认约定，「太麻烦」也未必在求助，只保留原话与发言者。
  // OUTSIDER_CHIME 2026-11-05 → HUMANIZE 2026-11-17（批次676，拟人化红线 P1-17）：
  // 只报「这是外群、人多」这个场合事实；「可以短接 / 不必等点名 / 就别插」是行为策略，
  // 由她自己决定。最近发言者已由 crowdHint 单独给出，这里不重复。
  const 外群倾向 = OWN_GROUPS.has(String(groupId)) ? '' : '（这是外群，人多。）'
  const quietHint = (engineeringAllowed ? '（工程模式：这个群在干活。除非点名问你，或者你自己发现自己的 bug 要说，否则别插话、别抢答、别追问。）' : '') + 外群倾向
  
  const modeHint = engineeringAllowed
    ? '（模式：工程模式——主人本人在本群，可以改代码/配置/文件。）\n'
    : ownerCanModify
      ? '（模式：主人本人跟你说话——你可以改自己的代码/配置/参数/工具，不用等谁点头；改前先备份、改完自己跑一遍验证，改坏了能自己回滚。但这个群不是工位，对外说人话，别提端口、日志、脚本这些。'
        + '另外：你自己查出来的技术/运维事项（会话文件多大、磁盘、进程、部署、端口、日志、参数），**不要主动当消息发给他** —— 他要看的时候会看面板。真要留底就写进面板待办或台账。'
        + '他会问的只有「她怎么了/怎么弄」，不会问「系统怎么样」。'
        + '会话大小这件事已经不用你操心：定时体检自己会把「该换会话了」写进面板「需要你处理」，你一个字都不用提；只有他当面问「会话多大了」才照实答。'
        + '）\n'
      : '（模式：日常模式——不许改代码、配置、人格或工具定义，只能用现有工具；工具出问题时按你自己的口气说一句就够，按人设来，不解释技术细节、不贴日志，然后自己静默处理。）\n'

  // HISTORY_BLOCK_FIX 2026-11-03：REFACTOR_BODY 把拼装抽成 拼正文 时，
  // 函数里用到 historyBlock，但调用方从没定义过它，于是每轮抛 "historyBlock is not defined"，
  // 她的回复直接断在半路。这里按原来的语义（上下文那几行拼成一段）补上。
  // LISTEN_HINT 2026-11-04：早投递 —— 不替她决定等多久，只把「这人在连发」这个事实告诉她。
  // 实测：真人连发间隔 p50=12s、p75=28s；2500ms 的静默根本不等于是说完了。
  // 所以窗口缩到 1000ms（配置 groupDebounceMs），并把判断权交回给她。
  const continuationHint = (() => {
    try {
      const arr = Array.isArray(unread) ? unread.filter((x) => textOf(x.message).trim() !== '') : []
      const uid = String(message?.sender?.user_id ?? '')
      if (uid === '' || arr.length === 0) return ''
      let n = 0
      let firstT = 0
      for (let i = arr.length - 1; i >= 0; i -= 1) {
        if (String(arr[i]?.sender?.user_id ?? '') !== uid) break
        n += 1
        firstT = timeOf(arr[i])
      }
      if (n < 1) return ''
      const span = Math.max(0, timeOf(message) - firstT)
      // 跨度太久就不算连发了：隔几分钟再补一句，那是新的一轮
      if (span > 90) return ''
      const who = nameOfSender(message) || '对方'
      // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-18）：只报连发条数与跨度，
      // 删掉「先别说 / 等他补完 / 想插也可以」这类应答时序规定。
      return '（提醒：' + who + ' 刚才连着发了 ' + (n + 1) + ' 条（跨度 ' + span + ' 秒）。）\n'
    } catch { return '' }
  })()
  const historyBlock = context.join(String.fromCharCode(10))
  const __groupCadenceHint = 群聊冷热提示(history, message, config.selfUin)
  const boundedText = String(text ?? '').slice(0, 1200)
  let body = 拼正文({ head, modeHint, stateHint, windowHint, topicHint, quietHint, sleepFactsOf: sleepFactsOf(), quotedBlock, saidBlock, notAddressedHint, continuationHint, text: 时刻缀(timeOf(message)) + boundedText, identityNote, truncated, historyBlock, contextLen: context.length })
  if (__groupCadenceHint) body = __groupCadenceHint + '\n' + body
  // HINT_TRACE 2026-11-03：只记一行「哪些注入真的进了正文」，用来验证接线（不改行为）
  // 2026-11-04 修：这段原来写在 `let body = 拼正文(...)` **之前**，TDZ 直接抛 ReferenceError，
  // 又被空 catch 吞掉 —— 于是自检日志一条都没出过（等于这个「验证接线」的开关从来没打开），
  // 而且每条群消息都白抛一次异常。现在挪到 body 拼好之后，并且失败要留痕。
  try {
    const __marks = []
    if (body.includes('你最近自己的习惯')) __marks.push('growth-habits')
    if (body.includes('低谷：active')) __marks.push('growth-slump')
    if (body.includes('你对TA的印象')) __marks.push('impression')
    if (body.includes('昨晚那个梦')) __marks.push('dream-residue')
    if (body.includes('你刚醒')) __marks.push('wake-feel')
    // TRACE_EXTRA 2026-11-03：把对话对象与闪回也纳入追踪
    if (body.includes('你刚才在跟')) __marks.push('window')
    if (body.includes('记不清') || body.includes('细节早模糊')) __marks.push('flashback')
    if (body.includes('说起来，上次') || body.includes('以前是不是也')) __marks.push('flashback-topic')
    if (__marks.length > 0) note('hint-trace', __marks.join(','))
  } catch (error) { note('hint-trace', '自检失败：' + (error instanceof Error ? error.message : String(error))) }
  // 同上：这一刻有人在群里说话（打点必须早于 deliver）
  const groupKey = `group:${groupId}`
  // 同上：用消息原始时间，防抖窗口的等待才能进延迟补偿。
  markIncoming(groupKey, qqTimeMs(message?.time))
  // 群的卡记的是「这个群」本身（群名 + 活跃度），不是某个群友
  touchPeer(groupKey, { nick: groupName })
  // 2026-10-31 小肥鱼补：群聊同样要跳过「等一下」已经答过的消息
  if (await consumedByWait(message.message_id)) {
    note('group', `group ${groupId} 已被等一下读过，跳过 seq=${seqOf(message)}`)
    markSeen(state.groups[groupId], message)
    saveState({ groups: state.groups })
    return { status: 'skipped-consumed' }
  }

  // FEELING_LEDGER 2026-11-05：群里的情绪同样交给她自己判断（见 qq_feel）。
  // 原来这里按「@她 / 叫她名字」再套正则，实测仍然误伤人：技术讨论里的「回滚」被当成骂。
  // FILE_IN 2026-11-05（批次90）：群里发文件同样要取下来（群里是共享文件，走 get_group_file_url）。
  // GROUP_PRECHECK 2026-11-17（批次667）：群聊也要记「这一回合她看到了哪几条」。
  // 原来只有私聊调 markDeliveredBatch，于是 qq_send 的发送前对账对群聊整个失效：
  // 群聊没有 input_status（线上 5761 条全是私聊、群聊 0 条），3.5 秒固定窗口接不住的连发
  // 只能靠「发之前再看一眼」兜。这里记的是**本回合正文真正带上的那批**（context + 本条），
  // 不是整段缓冲 —— 缓冲里还有她这轮没看到的更早消息，算进来会让对账永远为空。
  try {
    const 本回合带上 = [
      ...(Array.isArray(unread) ? unread.slice(-Math.max(0, Number(contextCount) || 0)) : []),
      message,
    ]
    markDeliveredBatch(`group:${groupId}`, 本回合带上)
  } catch { /* 记不上不影响投递，最多退回旧行为 */ }
  const used = await deliver(ctx, sessionId, body, { kind: 'group', id: groupId }, [
    ...quotedImageBlocks,
    ...(await buildImageBlocks(ctx, [message])),
    ...(await buildFileBlocks(ctx, [message])),
  ], {
    voicePeer: String(message?.sender?.user_id ?? ''),
    voiceMute: engineeringAllowed,
    voiceText: String(text ?? ''),
    memorySource: QQ记忆批次({ kind: 'group', id: groupId }, [message], message?.sender?.user_id).source,
    // PRECHECK_INBOX 复用：让 deliver 记下这批 QQ 消息 → inbox id，
    // 群聊对账拦下时才能把已经排进下一回合的那条撤回（和私聊同一条链路）。
    qqMessageIds: [message?.message_id],
  })
  // BREATHE_HOOK 2026-11-03：群里已投进会话，先起抢答计时器
  // BREATHE_OFF 2026-11-03：固定句子的抢答整套停用——主人定了「垫的那句必须带信息」，
  // 而固定列表说不出正在翻什么，只会变成「马上回你」这种客套。要应声就等真开口时自己说。
  if (used === '') return { status: 'failed' }
  记一次开口(groupId) // 只在这一刻记账：生成失败/被吞不算开过口

  const now = state.groups[groupId] ?? {}
  state.groups[groupId] = {
    ...now,
    lastDeliveredSeq: seqOf(message) ?? now.lastDeliveredSeq ?? now.lastSeq,
    lastDeliveredTime: timeOf(message) || now.lastDeliveredTime || 0,
    lastDeliveredRealSeq: timeOf(message) ? currentRealSeq : now.lastDeliveredRealSeq
  }
  markSeen(state.groups[groupId], message)
  saveState({ groups: state.groups })
  note('group', `delivered ${groupId} seq=${seqOf(message)} at=${atMe} context=${context.length} -> ${used}`)
  return { status: 'delivered', sessionId: used }
}

// ---- 轮询循环 ----

/**
 * 心跳节流：lastSeenAt/lastError 半分钟落一次盘就够。
 * 之前每轮轮询都无条件全量写 state 文件 —— 2 个号 × 每 2 秒 = 每分钟约 60 次同步写盘，
 * 只为更新一个「我还在」的时间戳。游标推进的写法不变（那才是不能丢的）。
 */
let lastHeartbeat = 0

/** 轮询间隔：WS 正常时拉长成「补漏」间隔，WS 断了立刻回全速。 */
function intervalFor(baseKey, fallbackKey) {
  const config = getConfig()
  const base = Math.max(500, Number(config[baseKey]) || 2000)
  if (!isWsConnected()) return base
  return Math.max(base, Number(config[fallbackKey]) || 30000)
}

/** 私聊：创建整个轮询循环。返回停止函数。 */
export function startPrivateLoop(ctx) {
  const pollOnePrivate = async (uin) => {
    const config = getConfig()
    const state = getState()
    try {
      const result = await callOneBot({
        action: 'get_friend_msg_history',
        params: { user_id: Number(uin), count: 10 }
      })
      if (result.retcode !== 0) throw new Error(`retcode=${result.retcode} ${result.message ?? ''}`)

      // 通了才记「恢复」—— 连接类错误期间不会走到这里
      noteConnectionRecovered('poll')
      const incoming = (result.data?.messages ?? []).filter(
        (message) => Number(message?.sender?.user_id) === Number(uin)
      )
      const maxSeq = incoming.reduce((max, message) => Math.max(max, seqOf(message) ?? 0), 0)
      const maxTime = incoming.reduce((max, message) => Math.max(max, timeOf(message)), 0)
      // 心跳节流（见 lastHeartbeat 注释）；privateMaxSeq 只在增长时写
      const nowMs = Date.now()
      if (nowMs - lastHeartbeat > 30000) {
        lastHeartbeat = nowMs
        saveState({ lastSeenAt: new Date().toISOString(), lastError: null })
      }
      if (maxSeq > Number(state.privateMaxSeq ?? 0)) saveState({ privateMaxSeq: maxSeq })

      // 每个号一份游标，互不干扰
      const cursor = state.privates[uin] ?? {}
      // ⚠️ 判断依据是 lastTime（私聊真正的游标），不是 lastSeq。
      //   lastSeq 因为两套编号混着已经不可用于判新旧了；
      //   而且老 state 文件可能只有 lastSeq 没有 lastTime ——
      //   那种情况要重新播种，否则新消息会被当成「不比 lastSeq 新」而丢掉。
      if (cursor.lastTime === undefined) {
        const anchor = Number(cursor.lastId ?? 0) > 0
          ? incoming.find((message) => Number(message?.message_id) === Number(cursor.lastId))
          : undefined
        if (anchor !== undefined && timeOf(anchor) > 0) {
          state.privates[uin] = { ...cursor, lastSeq: seqOf(anchor) ?? cursor.lastSeq, lastTime: timeOf(anchor) }
          saveState({ privates: state.privates })
          note('poll', `migrated private cursor ${uin} from lastId=${cursor.lastId} to time=${timeOf(anchor)}`)
        } else if (config.seedOnFirstRun) {
          state.privates[uin] = { ...cursor, lastSeq: maxSeq, lastTime: maxTime }
          saveState({ privates: state.privates })
          note('poll', `seeded private cursor ${uin} at time=${maxTime}`)
          return
        }
      }

      // ⚠️ 私聊的新旧判断**不能用 seq**（见 isSeen 的注释：私聊 seq 是两套编号混着的，
      //   而且对方那一套自己也不单调）。改用时间戳。
      const hasTimeCursor = Number(cursor.lastTime ?? 0) > 0
      const isNewer = (message) => {
        const time = timeOf(message)
        // ⚠️ 用 >= 不是 >：时间戳是**秒级**的，同一秒内发的两条消息时间相同。
        //   用 > 的话第二条会被丢掉（实测树树连着发两条就丢一条）。
        //   同秒的多条靠下面 isSeen 的 message_id 精确去重 —— 精确匹配不会误伤。
        if (hasTimeCursor && time > 0) return time >= cursor.lastTime
        // 没有时间游标（首次运行 / 老 state）→ 全当新的，
        // 由 isSeen 的 seenIds 做精确去重，避免重复投递。
        // 这里宁可多看一眼也不能漏 —— 漏消息比多投递严重得多。
        if (!hasTimeCursor) return true
        // 没有时间戳的老消息才退回 seq（那时 seq 至少在同一套编号里）
        const seq = seqOf(message)
        if (seq !== null && cursor.lastSeq !== undefined) return seq > cursor.lastSeq
        return true
      }

      // WS 已经处理过的（seenIds 命中 / 时间戳早于上次处理）一律跳过，避免两条通路重复投递
      const fresh = incoming
        .filter(isNewer)
        .filter((message) => !isSeen(state.privates[uin], message))
        // 按时间排序（不是 seq —— 私聊的 seq 排序会把消息排错顺序）
        .sort((a, b) => (timeOf(a) || 0) - (timeOf(b) || 0))
      if (fresh.length > 0) {
        // 积压的多条合并成一条投递：避免「离线一会儿回来被连问三遍」。
        const used = await handlePrivateMessages(ctx, uin, fresh, { [普通私聊入站]: true })
        if (used !== '') {
          note('poll', `delivered private ${uin} x${fresh.length} seq<=${seqOf(fresh[fresh.length - 1])} -> ${used}`)
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 连接类错误：协议端还没开门，不是故障 —— 不写 lastError、不刷屏
      if (isConnectionError(error)) {
        noteConnectionIssue('poll', message)
        return
      }
      saveState({ lastSeenAt: new Date().toISOString(), lastError: message })
      note('poll', `private ${uin} error ${message}`)
    }
  }

  const pollAllPrivates = async () => {
    for (const uin of configuredPrivates()) await pollOnePrivate(uin)
  }
  const schedulePrivate = () => {
    if (stopped) return
    const delay = intervalFor('pollMs', 'wsFallbackPollMs')
    timer = setTimeout(() => {
      void pollAllPrivates().then(schedulePrivate, schedulePrivate)
    }, delay)
  }
  // 立刻跑第一次，跑完再按间隔排下一次（别先 schedule，否则会开两条循环）
  void pollAllPrivates().then(schedulePrivate, schedulePrivate)
  note('poll', `private loop started, watching [${configuredPrivates().join(',')}]`)

  let timer = null
  let stopped = false
  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}

function 群游标位置(cursor, message) {
  const time = timeOf(message)
  const lastTime = Number(cursor.lastTime ?? 0)
  const realSeq = Number(message?.real_seq) || 0
  return {
    lastTime: Math.max(lastTime, time),
    lastSeq: seqOf(message) ?? cursor.lastSeq,
    lastRealSeq: time > lastTime ? realSeq : time === lastTime
      ? Math.max(Number(cursor.lastRealSeq ?? 0), realSeq) : cursor.lastRealSeq,
  }
}

/** 群聊：创建整个轮询循环（仅 @）。返回停止函数。 */
export function startGroupLoop(ctx) {
  const state = getState()

  const refreshNames = async () => {
    try {
      const result = await callOneBot({ action: 'get_group_list' })
      if (result.retcode !== 0) return
      // 不同 OneBot 实现给的形状不一样：数组 / { groups: [...] } / 别的，
      // 拿不到数组就当没拿到，别让 for...of 抛 "object is not iterable"
      const raw = result.data
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw?.groups) ? raw.groups : [])
      if (list.length === 0) return
      const map = new Map()
      for (const group of list) map.set(String(group?.group_id ?? ''), String(group?.group_name ?? ''))
      groupNames.clear()
      for (const [key, value] of map) groupNames.set(key, value)
    } catch (error) {
      note('group', `group list failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  /** 拉该群最近的消息（WS 路径构造上下文时按需调用）。 */
  const fetchGroupHistory = async (groupId) => {
    try {
      const result = await callOneBot({
        action: 'get_group_msg_history',
        params: { group_id: Number(groupId), count: 10 }
      })
      if (result.retcode !== 0) return []
      // Keep our own rows for validating whether an incoming reply targets us.
      // Prompt context filters self-authored rows before rendering.
      return result.data?.messages ?? []
    } catch (error) {
      // 连接类错误往上抛：让调用方按错误分级处理（记一条、不刷屏）。
      // 之前这里一律吞掉返回 []，结果是「协议端挂了」在群侧完全无感，
      // 只有私聊那边在报错 —— 看着像「群消息功能坏了」，其实是同一个原因。
      if (isConnectionError(error)) throw error
      return []
    }
  }

  const pollGroup = async (groupId) => {
    const config = getConfig()
    try {
      const history = await fetchGroupHistory(groupId)
      // 历史也灌进缓冲：WS 路径的上下文就靠它（两条通路互补）
      for (const item of history) pushToBuffer(groupId, item)
      const maxSeq = history.reduce((max, message) => Math.max(max, seqOf(message) ?? 0), 0)
      const maxTime = history.reduce((max, message) => Math.max(max, timeOf(message)), 0)

      const cursor = state.groups[groupId] ?? {}
      if (cursor.lastSeq === undefined && config.seedOnFirstRun) {
        // 新加入监听的群：先对齐游标，不回放历史；之后只认 @。
        // lastDeliveredSeq = 上次「投递过」的位置，用来算未读上下文；
        // 播种时也对齐到当前位置，否则刚加进来就把一整屏历史当未读塞进去
        const lastRealSeq = history.reduce((max, message) => timeOf(message) === maxTime
          ? Math.max(max, Number(message?.real_seq) || 0) : max, 0)
        state.groups[groupId] = {
          lastSeq: maxSeq, lastTime: maxTime, lastRealSeq,
          lastDeliveredSeq: maxSeq, lastDeliveredTime: maxTime, lastDeliveredRealSeq: lastRealSeq,
        }
        saveState({ groups: state.groups })
        note('group', `${groupId} seeded at seq=${maxSeq}`)
        return
      }

      // 2026-11-19：不同轮询拉到的群消息也可能同秒，只用已知的 real_seq 区分先后。
      const isNewer = (message) => {
        const t = timeOf(message)
        const lastT = Number(cursor.lastTime ?? 0)
        if (lastT > 0 && t > 0) {
          const lastRealSeq = Number(cursor.lastRealSeq ?? 0)
          return t > lastT || (t === lastT && lastRealSeq > 0 && Number(message?.real_seq) > lastRealSeq)
        }
        const seq = seqOf(message)
        return seq !== null && cursor.lastSeq !== undefined && seq > cursor.lastSeq
      }

      const fresh = history
        .filter(isNewer)
        .filter((message) => !isSeen(state.groups[groupId], message))
        .sort((left, right) => timeOf(left) - timeOf(right) || (Number(left?.real_seq) || 0) - (Number(right?.real_seq) || 0))
      // 未读基准固定在本批开始时（同一批里的上下文要互相看得见）
      const baseDeliveredSeq = Number((state.groups[groupId] ?? {}).lastDeliveredSeq ?? 0)
      // 2026-10-31 大肥鱼修：轮询通路补上跟 WS 一样的连发防抖。
      // 一批里只让「最后一条要回的消息」真的开口，前面那些要回的先不投——
      // 它们的内容本来就在 history 里，会作为上下文出现在最后这条的投递里，
      // 不会丢；但不会再多开几个回合（之前快速连说三句就是回三遍、顺序还乱）。
      // 紧急/停手类指令例外：一条都不许吞，全都单独投递。
      const replyable = fresh.filter((message) => groupNeedsReply(message, config, groupId, history))
      // BATCH_SNAPSHOT 2026-11-09（批次361）：后续投递会写开口冷却，不能再用变化后的状态重判本批候选。
      const replyableSnapshot = new Set(replyable)
      // fresh 已按时间与可信序号排序；组内仍优先显式叫起或正在接话的人。
      const newest = (items) => items.reduce((a, b) => (timeOf(b) >= timeOf(a) ? b : a))
      const explicitReplyable = replyable.filter((message) => 群聊显式叫起(message, config, history))
      const continuingReplyable = replyable.filter((message) =>
        是持续对话(groupId, String(message?.sender?.user_id ?? ''), Date.now(), config),
      )
      const lastReplyable = explicitReplyable.length > 0
        ? newest(explicitReplyable)
        : continuingReplyable.length > 0
          ? newest(continuingReplyable)
          : replyable.length > 0 ? newest(replyable) : undefined
      // PHONE_GATE 2026-11-05（批次95）：跟 WS 那条路是同一个闸门。
      // 轮询一次来一批，所以只拿「这批里最后那条」问一次 —— 她没看手机，整批都不投，
      // 内容照样在 history 里（等她下一次看手机时会一起看到）。
      let 手机放行 = true
      let phoneDecision = { ok: true }
      if (lastReplyable) {
        const 闸 = 看手机(config, {
          groupId,
          senderUin: String(lastReplyable?.sender?.user_id ?? ''),
          text: textOf(lastReplyable.message),
          atMe: isAtMe(lastReplyable.message, config.selfUin),
          named: calledByMyname(textOf(lastReplyable.message)),
          replyToMe: 群聊引用她(lastReplyable, config, history),
          urgent: URGENT_RE.test(textOf(lastReplyable.message))
        })
        phoneDecision = 闸
        手机放行 = 闸.ok
        if (!闸.ok) note('phone', `group ${groupId} ${闸.why}，这一批 ${fresh.length} 条只进上下文`)
      }
      for (const message of fresh) {
        // 处理这条消息前的游标快照：投递失败时恢复它，下一轮重试，
        // 而不是「游标已前进、消息却没进会话」地静默丢掉（agent 冷启动失败时就会这样丢消息）。
        const prevCursor = { ...state.groups[groupId] }
        // 游标无论投不投递都要前进，否则没 @ 的消息会被反复看到。
        // lastId 不再更新（SnowLuma 的 message_id 可能为负数，比大小不可靠）
        state.groups[groupId] = {
          ...prevCursor,
          ...群游标位置(prevCursor, message),
        }
        saveState({ groups: state.groups })

        // 非候选消息（包括只作上下文的闲聊）绝不调用完整投递入口。
        if (!replyableSnapshot.has(message)) continue
        // 同一批里「要回但不是本批选中项」的只作上下文，不额外启动回合。
        const suppressed = 应合并群消息(message, lastReplyable, replyableSnapshot)
        if (suppressed) {
          note('group', `${groupId} 连发合并，先不投 seq=${seqOf(message)}（等本批最后一条）`)
          continue
        }
        // PHONE_GATE：这一批没过闸门，除了紧急消息，其余只进上下文（游标上面已经推进过了）
        if (!手机放行 && !URGENT_RE.test(textOf(message.message))) {
          continue
        }
        const result = await handleGroupMessage(ctx, groupId, message, history, baseDeliveredSeq)
        // THREAD_WINDOW 2026-11-06（批次105）：真开口了才开「还在说话」的窗口。
        // 冷却管的是「手机放下了」；刚发完消息那会儿手机正拿在手里。
        if (result.status === 'delivered') {
          记回话(groupId, Date.now(), String(message?.sender?.user_id ?? ''), {
            explicit: phoneDecision.explicit === true,
            continuation: phoneDecision.continuation === true,
            phoneCheck: phoneDecision.phoneCheck === true,
            config,
          })
        }
        if (result.status === 'failed') {
          // 投递失败：回滚游标到这条消息之前，下一轮 poll 重新拉到它就重试
          //（只要还在 history 窗口内；反复失败会反复记日志，比静默丢消息好排查）
          state.groups[groupId] = prevCursor
          saveState({ groups: state.groups })
          note('group', `${groupId} deliver 失败，游标回滚待重试 seq=${seqOf(message)}`)
          break
        }
        // skipped = 这条不用管（没 @ / 没配置会话），游标照常前进，继续看下一条
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // 连接类错误：协议端还没开门，不是故障 —— 不刷屏
      if (isConnectionError(error)) {
        noteConnectionIssue('group', message)
        return
      }
      note('group', `${groupId} error ${message}`)
    }
  }

  let groupsInFlight = false
  const pollAllGroups = async () => {
    if (groupsInFlight) return
    groupsInFlight = true
    try {
      const list = configuredGroups()
      if (list.length === 0) return
      if (groupNames.size === 0) await refreshNames()
      for (const groupId of list) {
        // 新加的群可能还没有名字，补拉一次
        if (!groupNames.has(groupId)) await refreshNames()
        await pollGroup(groupId)
      }
    } finally {
      groupsInFlight = false
    }
  }

  // 定时器无条件创建：空列表也跑（每轮先看配置），
  // 这样在设置页新绑一个群，保存后立刻开始轮询，不用重启 DSH。
  let timer = null
  let stopped = false
  const scheduleGroups = () => {
    if (stopped) return
    const delay = intervalFor('groupPollMs', 'wsFallbackPollMs')
    timer = setTimeout(() => {
      void pollAllGroups().then(scheduleGroups, scheduleGroups)
    }, delay)
  }
  // 立刻跑第一次，跑完再按间隔排下一次
  void pollAllGroups().then(scheduleGroups, scheduleGroups)
  note('poll', `group loop started, watching [${configuredGroups().join(',')}]`)

  return () => {
    stopped = true
    if (timer !== null) clearTimeout(timer)
  }
}

// ---- WS 事件入口 ----

/**
 * 把 OneBot 的 WS 事件转成内部统一的消息对象。
 * WS 事件跟 HTTP 历史里的结构不一样：sender 是平铺的（user_id / nickname），
 * message 是段数组，message_seq 有没有要看实现 —— 所以统一成 HTTP 那边的形状。
 */
export function normalizeEvent(event) {
  const sender = {
    user_id: String(event?.user_id ?? ''),
    nickname: String(event?.sender?.nickname ?? event?.nickname ?? nicknameOf(event?.user_id) ?? '')
  }
  return {
    message: Array.isArray(event?.message) ? event.message : [],
    sender,
    message_id: Number(event?.message_id ?? 0),
    message_seq: event?.message_seq !== undefined ? Number(event.message_seq) : undefined,
    // 2026-11-01：real_seq 才是单调的那个（message_id/message_seq 实测会乱跳）。
    // 之前 WS 事件里把它丢了，判新只能退回时间戳。
    real_seq: event?.real_seq !== undefined && Number(event.real_seq) > 0 ? Number(event.real_seq) : undefined,
    time: Number(event?.time ?? 0)
  }
}

/**
 * WS 事件处理器。
 * @param {any} event OneBot 事件
 */
// ---- 连发防抖要用的两个纯判断（2026-10-31 大肥鱼加）----
//
// 背景：用户实测「快速连说三句话」，我会回三遍、顺序还乱。
// 根因是两条通路不一致——WS 那边有 groupDebounceMs 防抖（连发只回最后一条），
// 轮询那边却是一个 for 循环逐条投递，于是同一个人连着说三句就开三个回合。
// 下面这两样就是给轮询补齐同一套判断，别再各写一份。

/** 半句判据（2026-11-07 批次186）：以逗号/顿号/省略号/分号/冒号/破折号收尾。
 *
 * 数据（群聊日志 7908 条 / 4 个群）：同一人纯连发 1875 次，其中「明确半句」138 条，
 * 115 条在 1-2 秒内续发（83%）；1 秒窗口只接得住 11 条（8%），2 秒能接住 91%。
 * 反例：「只是没打标点」312 条散在 1-8 秒，是正常说话节奏 —— 不能算半句。
 * 只认强信号：宁可漏判（照常 1 秒），不可把正常短句拖成 2 秒。
 */
export function 是半句(text) {
  return /[，,、…；;：:—-]$/.test(String(text ?? '').trim())
}

/** 防抖等待毫秒（2026-11-07 批次186）。三种走法分开写，是为了能被单测直接盯住。
 *
 * - 高优先（@/主人/叫名字）：最多 1 秒。被点名的人不该被拖着等补充；
 *   配置调大时也不能更慢，所以取 min。
 * - 明确半句：至少 2 秒。等对方把那半句说完。
 * - 其余：照配置走（线上 1000）。
 */
export function 防抖等待(高优先, text, base) {
  const b = Number(base) || 2000
  if (高优先) return Math.min(b, 1000)
  const t = String(text ?? '').trim()
  if (是半句(t)) return Math.max(b, 2000)
  // DEBOUNCE_BY_LEN 2026-11-08（批次296）：按字数动态等。
  // 极短的一句（「在吗」「嗯」「？」）多半还有下文，多等一会儿攒完整再回；
  // 一大段说完的（>=30 字）基本就是全部，早点回，别让人觉得在打字机上睡着。
  // 中间长度维持 base 不动。**高优先和半句都不受影响**，它们的判据在上面。
  const n = t.length
  // TYPING_HOLD 2026-11-16（批次582）：群聊没有 input_status，只能靠固定窗口。
  // 实测主人连发「看看」「你的」间隔 3.2 秒；2.5 秒的短句窗口接不住，
  // 第一条先投出去，第二条只能开新回合。短句下限提到 3.5 秒，
  // 让「极短一句多半还有下文」真正覆盖到 3 秒级的连发。
  if (n <= 3) return Math.max(b, 3500)
  if (n >= 20) return Math.min(b, 600)
  return b
}

/** 停手/紧急类指令：这类一条都不能被后面的消息顶掉，必须单独投递。 */
const URGENT_RE = /紧急|立刻|马上|赶紧|先处理|别管别的|急|别找了|不用了|取消|停下|先别|算了/

/**
 * 「别跟我说话」类话术。2026-11-04 加。
 *
 * 起因：群里有人引用她的消息说「@大肥鱼 没跟你说话」，她被这句"@了她"骗过去了，
 * 接了话还回了一句「刚还嫌我多嘴，这会儿问我是谁」——把两个人的话当成同一个人在跟她对呛，
 * 群友的结论是「這ai分不清人」。
 *
 * 这些话术的共同点：出现时**永远不是在邀请她回答**。命中就不接。
 */
const PUSHBACK_RE = /没跟你说话|没和你说|不是跟你说|没问你|不是问你|没叫你|没喊你|别插嘴|别搭话|别接话|别说话|别说了|闭嘴|安静点|别闹了|没在跟你/

/** 这条是不是在明确拒绝她开口。 */
export function isPushback(text) {
  return PUSHBACK_RE.test(String(text ?? ''))
}

// JUDGE_DEDUP 2026-11-09（批次348）：下面两个判据原来在两处各写一遍
// （媒体 2490/3270，@别人 2440/3261），媒体那对已经分叉过 ——
// 一处注释写「照投」、另一处代码是跳过。收成一份，改一处两处都变。
const 媒体类型 = new Set(['image', 'mface', 'face', 'video'])

/**
 * 这条消息是不是「只有图/表情，没有文字」。@ 与否由调用方另外判，这里只管内容形态。
 *
 * ⚠️ DEAD_JUDGE 2026-11-09（批次350）：**它现在永远返回 false**。
 * `textOf()` 会给图片段生成占位文字 `[图片]`，所以 `text === ''` 从来就不成立。
 * 两处调用（`handleGroupMessage` 的 SEE_ALL 段、`groupNeedsReplyRaw`）实际都走不到这条，
 * 纯图消息一直是「照投，由她判断」——跟 SEE_ALL 那条注释的意图一致，所以没改。
 *
 * 真要拦纯图，判据得改成「看消息段里有没有图、且没有非空 text 段」，不是看 text 是否为空串。
 */
export function 只有媒体(段, text) {
  return String(text ?? '') === '' && Array.isArray(段)
    && 段.some((seg) => 媒体类型.has(String(seg?.type ?? '')))
}

/**
 * IMG_NOT_TOPIC 2026-11-15（批次506）：这条是不是「只有图、没有正文」。
 *
 * 和 `只有媒体()` 的区别：那个判 `text === ''`，而 `textOf()` 会给图片段生成 `[图片]`，
 * 所以它恒假（MEMORY 里记的老坑，t348 还钉着「与旧实现等价」，不能改它）。
 * 这里改成**剥掉占位符再看还剩不剩正文** —— `[图片]` / `[图片][表情]` 算纯图，
 * `[图片] 这是什么` 不算。用来在群里提醒她「图不是话题中心」。
 */
export function 纯图无正文(段, text) {
  const 有图 = Array.isArray(段) && 段.some((seg) => seg?.type === 'image')
  if (!有图) return false
  const 剩 = String(text ?? '').replace(/\[[^\]]{1,8}\]/g, '').trim()
  return 剩 === ''
}

/**
 * 这条是不是 @ 了「别人」——不含 @自己。
 *
 * 注意 `@全体`（qq === 'all'）会被算成「@别人」，这是**现有行为**，本批不改：
 * 改了会让「@全体」从「让位」变成「可以接」，是一处行为变化，不在纯重构范围里。
 */
export function 是否艾特别人(段, selfUin) {
  const 我 = String(selfUin ?? '')
  return Array.isArray(段) && 段.some(
    (seg) => seg?.type === 'at' && String(seg?.data?.qq ?? '') !== '' && String(seg?.data?.qq) !== 我
  )
}

/**
 * 这条群消息「要不要回」。
 *
 * 为什么单独写一份：handleGroupMessage 会组装上下文并真的投递，副作用太大，
 * 这里只需要一个纯判断来说「这一批里哪条是最后一句该开口的」。
 * 判定必须跟 handleGroupMessage 里的门控长得一样，否则会出现「最后一条不投、
 * 前面该投的却被跳过」的漏话。
 */
// 2026-11-04：导出给评测用（行为不变），调判据时要能拿真实数据量它
// REFRACTORY 2026-11-07（批次214）：同群 20 秒内不二次开口。
// 依据：2026-11-01 01:34–01:43 真实日志重放，她 9 分钟里开口 26 次（29 条消息）；
// 加 20 秒冷却后 14 次，正好对上方案验收「30 条发 13 条左右」。
// 例外：@她 / 叫她名字 / 紧急词——紧急词整段跳过冷却（与她本人的紧急通道一致）。
const 开口时刻 = new Map()
const 冷却毫秒 = 20000
const 紧急词 = /紧急|立刻|马上|赶紧|取消|停下|别找了|算了/

export function 群冷却剩余(groupId) {
  const gid = String(groupId ?? '')
  const last = 开口时刻.get(gid) || 0
  return Math.max(0, 冷却毫秒 - (Date.now() - last))
}

export function 记一次开口(groupId) {
  const gid = String(groupId ?? '')
  if (gid) 开口时刻.set(gid, Date.now())
}

/**
 * 群里谁的发言算「高优先」：能顶掉别人、半句话也不用多等两秒。
 *
 * 2026-11-08（批次235）：只认「@她」和「点她名字」。主人**不在**这条里 ——
 * 他和群友走同一道闸，会被后来的消息顶掉、半句话一样多等两秒。
 * 参数故意只有两个：谁想把 owner 加回来，得先改这条注释。
 */
export function 群高优先(atMe, named) {
  return !!(atMe || named)
}

/** 检查群消息是否引用了她：要求引用编号与历史消息发送者都匹配。 */
export function 群聊引用她(message, config = {}, history = []) {
  const self = String(config?.selfUin ?? '')
  const reply = Array.isArray(message?.message)
    ? message.message.find((seg) => seg?.type === 'reply')
    : null
  const ids = [reply?.data?.id, reply?.data?.message_id, reply?.data?.seq]
    .map((id) => String(id ?? ''))
    .filter((id) => id !== '')
  if (self === '' || ids.length === 0 || !Array.isArray(history)) return false
  return history.some((item) =>
    [item?.message_id, item?.real_id, item?.message_seq, item?.real_seq]
      .some((id) => ids.includes(String(id ?? '')))
      && String(item?.sender?.user_id ?? '') === self
  )
}

/** 显式叫起：@、点名、引用她或紧急消息。 */
export function 群聊显式叫起(message, config = {}, history = []) {
  const text = textOf(message?.message)
  return isAtMe(message?.message, String(config?.selfUin ?? ''))
    || calledByMyname(text)
    || 群聊引用她(message, config, history)
    || URGENT_RE.test(text)
}

/** 群上下文固定硬上限，防止配置误填把整段群聊灌进完整回合。 */
export function 限群聊上下文(rows, contextCount = 3, maxChars = 240) {
  const count = Math.min(3, Math.max(0, Math.floor(Number(contextCount) || 0)))
  const limit = Math.min(240, Math.max(1, Math.floor(Number(maxChars) || 240)))
  if (count === 0) return []
  return (Array.isArray(rows) ? rows : []).slice(-count).map((line) => String(line ?? '').slice(0, limit))
}

function groupNeedsReplyRaw(message, config, groupId, history = []) {
  const selfUin = String(config?.selfUin ?? '')
  const atMe = isAtMe(message?.message, selfUin)
  const text = textOf(message?.message)
  const calledByName = calledByMyname(text)
  // @ 的是别人、又没点我名字 → 不插嘴（哪怕说话的是主人）
  const atOthers = 是否艾特别人(message?.message, selfUin)
  const gid = String(groupId ?? message?.group_id ?? '')
  const sender = String(message?.sender?.user_id ?? '')
  if (selfUin !== '' && sender === selfUin) return false
  // 2026-11-04：「没跟你说话」这类话不接，哪怕它 @ 了她
  if (isPushback(text)) return false
  // 批次352：下面两条原来只在投递侧有，导致「群聊强度.jsonl 的 would」
  // 记的不是真门控的答案。这里只影响 would 和连发合并的基准；
  // 投递行为不变 —— handleGroupMessage 自己还会再判一次。
  if (gid && isMuted(targetKeyOf({ kind: 'group', id: gid }))) return false
  const 显式叫起 = 群聊显式叫起(message, config, history)
  const 持续中 = sender !== '' && 是持续对话(gid, sender, Date.now(), config)
  if (gid && !OWN_GROUPS.has(gid) && !显式叫起 && !持续中) return false
  if (atOthers && !atMe && !calledByName) return false
  // 群聊普通消息只作为看手机候选；开「只在@」时仅保留显式叫起和同人续接。
  if (!显式叫起 && config?.phoneGate === false) return false
  if (!显式叫起 && config?.groupOnlyWhenAt === true && !持续中) return false
  // 纯表情包/贴图（没有文字）不接话
  const mediaOnly = 只有媒体(message?.message, text)
  if (mediaOnly && !atMe && !calledByName) return false
  if (text === '' && !atMe) return false
  // 同群冷却：@她 / 点名 / 紧急词不受限（紧急词要能立刻穿透）
  // 批次352 有意不合并「同句 8 秒」：那是防 NapCat 重投的传输层保护，
  // 写点在 handleGroupMessage（sameTextAt.set）。这里再写一次会把投递侧
  // 自己的记录顶掉，第一条就被判成重复。
  if (gid && !显式叫起 && !持续中) {
    const last = 开口时刻.get(gid) || 0
    if (Date.now() - last < 冷却毫秒) return false
  }
  return true
}

// GROUP_TIER 2026-11-08（批次226）：群聊强度分档（super-agent 的 explicit / inferred / context）。
//   explicit = @她、点名、引用她、紧急词；context = 其他人的对话。
// observe 记录共享判据候选；候选是否进入完整回合还须通过看手机节流和持续窗口限制。
// 批次235：主人已经和群友同闸，inferred 这一档不再产生（历史日志里还有，别当成 bug）。
//   是不是主人看日志里的 uid 就知道，不用单开一档。
const 强度已记 = new Set()
export function groupNeedsReply(message, config, groupId, history = []) {
  const 旧 = groupNeedsReplyRaw(message, config, groupId, history)
  try {
    if (config?.groupStrengthObserve !== false) {
      const id = String(message?.message_id ?? message?.seq ?? '')
      if (!id || !强度已记.has(id)) {
        if (id) { 强度已记.add(id); if (强度已记.size > 2000) 强度已记.clear() }
        const text = textOf(message?.message)
        const atMe = isAtMe(message?.message, String(config?.selfUin ?? ''))
        const tier = (atMe || calledByMyname(text) || 紧急词.test(text)) ? 'explicit' : 'context'
        appendFileSync(process.env.GROUP_TIER_LOG || `${SHARED}/日志/群聊强度.jsonl`, JSON.stringify({
          at: bjDate(Date.now()).toISOString().slice(0, 16).replace('T', ' '),
          gid: String(groupId ?? message?.group_id ?? ''),
          uid: String(message?.sender?.user_id ?? ''),
          tier, would: !!旧, text: text.slice(0, 40),
        }) + '\n')
      }
    }
  } catch { /* 记录失败不影响回复 */ }
  return 旧
}

/** 同批连发仅合并筛选时已判为可回复的前序普通消息。 */
export function 应合并群消息(message, lastReplyable, replyableSnapshot) {
  return lastReplyable !== undefined
    && Number(message?.message_id) !== Number(lastReplyable?.message_id)
    && replyableSnapshot instanceof Set
    && replyableSnapshot.has(message)
    && !URGENT_RE.test(textOf(message?.message))
}

// 名字门控（2026-10-31 大肥鱼改）：先把「小肥鱼」抹掉再匹配，否则她那名字里带「肥鱼」，
// 别人喊她我会当成喊我。改自肥鱼那边同样的坑（他把 /大肥鱼|肥鱼/ 改成只认自己的名字）。
// GROUP_PRECHECK 2026-11-17（批次667）：导出给 tool.js 的群聊发送前对账复用，
// 别让「谁算叫了她名字」出现第二份判据。
export function calledByMyname(text) {
  // 2026-11-01 肥鱼改：只认「大肥鱼」。原来的 /大肥鱼|肥鱼/ 会把找「肥鱼」（电脑端那只）的话也算到她头上。
  // 先抹掉「小肥鱼」，再匹配自己的名字。
  // SELF_NAMES 2026-11-23：名字原来是写死的 —— 哈基米这套里没人叫「大肥鱼」，
  // 于是群里点名「哈基米」不算点名，她按「没叫我」处理，直接不说话。改成可配。
  const names = String(process.env.QQ_SELF_NAMES || '大肥鱼')
    .split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  const s = String(text ?? '').replace(/小肥鱼/g, '')
  return names.some((n) => s.includes(n))
}

// 让位判断（2026-10-31 加，肥鱼给的设计）：上一条是别的 bot 接的、他又没点我名，我就闭嘴。
// 为什么需要：频繁插话多半栽在这——他刚跟另一只聊着，我冲进去答一半。
// 判定顺序：@ 我 / 点我名 / 「你们·你俩·两位」 → 一律不让位；否则看「对方最后一次发言」
// 是不是比我最后一次投递更晚（5 分钟内算同一段对话）。
function shouldYieldToSibling(message, history, config, groupId) {
  const text = textOf(message?.message)
  if (isAtMe(message?.message, config?.selfUin)) return false
  if (calledByMyname(text)) return false
  if (/你们|你俩|两位/.test(text)) return false
  // SIBLINGS 2026-11-23：原来写死 [自己的 uin, 小肥鱼] —— 把自己的号当「别的 bot」，
  // 于是她刚说过话就会让位给自己，群里看着就是「不回」。改成可配，默认保留大肥鱼那套。
  const siblings = String(process.env.QQ_SIBLING_UINS || '1000000001,1000000093')
    .split(/[,，]/).map((x) => x.trim()).filter(Boolean)
  // 2026-11-01：窗口跟着我的精力浮——精力足就短（敢接话），累了就长（少抢）
  let yieldWindow = 300
  try {
    const stP2 = `${MEM}/状态.json`
    if (existsSync(stP2)) {
      const stJ2 = JSON.parse(cachedStateRead(stP2, 'utf8'))
      const en2 = Number(stJ2?.energy ?? 60)
      yieldWindow = Math.round(360 - Math.max(0, Math.min(1, en2 / 100)) * 180)  // 精力0→360s，100→180s
    }
  } catch { /* 读不到就用 yieldWindow 秒 */ }
  const st = getState()
  const bucket = st?.groups?.[groupId] ?? {}
  const lastSelf = Number(bucket.lastDeliveredTime ?? 0)
  const mine = timeOf(message)
  let lastSib = 0
  for (const it of (Array.isArray(history) ? history : [])) {
    const t = timeOf(it)
    if (mine > 0 && t >= mine) continue
    if (siblings.includes(String(it?.sender?.user_id ?? ''))) lastSib = Math.max(lastSib, t)
  }
  if (lastSib === 0) return false
  // 2026-11-01 肥鱼改：只有「对方在这条消息之后已经答过」才让位。
  // 原来的写法是「对方最近说过话就让我让」，两个人会互相让、中间没人接（实测锁死过一次）。
  if (mine > 0) return lastSib > mine
  return lastSib > lastSelf
}

// 睡眠时段门控（2026-11-01 加，用户定的两点到九点）：
// 这段时间只有被 @ 才算真醒，别的消息只进记录、不起一轮——群友半夜闲聊别把她叫起来烧钱。
// TIME_INJECT 2026-11-06（批次113）：加一个可选时刻。
// 原来它只认「现在几点」，于是测「凌晨一点半不在睡眠窗里」这件事，
// 只能在凌晨两点之前跑 —— 过了 02:00 测试自己就红了，跟代码无关。
// SLEEP_WIN_MEDIAN 2026-11-06（批次134）：窗口原来写死 02:00-09:00，跟她的真实作息对不上
// （她 00:20 就睡了，07:00 醒）。改成最近 7 条整觉的入睡/醒来中位数，各自放宽 90 分钟；
// 样本不足 3 条退回配置值 —— 数据不够时不猜。
// 入睡时刻可能跨零点（23:30 与 00:20 差 22 小时），先平移到「凌晨为负」再取中位数。
function sleepWindowNow(config) {
  const fallback = String(config?.sleepWindow ?? '02:00-09:00')
  try {
    const fsMod = process.getBuiltinModule('node:fs')
    const p = process.env.QQ_SLEEP_DB || `${MEM}/睡眠.json`
    const db = JSON.parse(fsMod.readFileSync(p, 'utf8'))
    const recs = (db.records || []).slice(-7).filter((r) => r && r.start && r.end)
    if (recs.length < 3) return fallback
    const toMin = (s) => { const m = String(s).match(/(\d{1,2}):(\d{2})/); return m ? Number(m[1]) * 60 + Number(m[2]) : null }
    const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)] }
    const shift = (x) => (x >= 12 * 60 ? x - 24 * 60 : x)
    const starts = recs.map((r) => toMin(r.start)).filter((x) => x !== null).map(shift)
    const ends = recs.map((r) => toMin(r.end)).filter((x) => x !== null).map(shift)
    if (starts.length < 3 || ends.length < 3) return fallback
    const fmt = (x) => { const v = ((Math.round(x) % 1440) + 1440) % 1440; return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0') }
    return fmt(med(starts) - 90) + '-' + fmt(med(ends) + 90)
  } catch { return fallback }
}

export function inSleepWindow(config, at) {
  // SLEEP_REAL 2026-11-06（批次108）：先看真睡没睡，再看钟点。
  //
  // 原来这里只认「醒着」：`sleeping === false` 才提前返回，剩下全按
  // `sleepWindow`（默认 02:00-09:00）算。可她 00:20 就睡了 ——
  // 00:28 群里有人发图，钟点还没到 02:00，门控不算睡眠，于是照常 delivered
  // 起了一轮（日志：`seq=261483 at=false`）。她睡着，仍被群消息叫起来。
  // 人睡着就是睡着，跟钟点没关系：标记写着睡，就按睡眠算（只有 @ 能叫醒）。
  try {
    const fsMod = process.getBuiltinModule('node:fs')
    // QQ_WAKE_FILE 只给测试用：能不能拦住，全看这一个标记，不该让测试去动她的真觉。
    const flagPath = process.env.QQ_WAKE_FILE || `${MEM}/睡醒.json`
    const flag = JSON.parse(fsMod.readFileSync(flagPath, 'utf8'))
    if (flag && flag.sleeping === true) return true
    // SLEEP_FLAG_TRUTH 2026-11-06（批次134 回滚）：我一度改成「醒着也继续判窗口」，
    // 理由是「标记文件一直在，窗口从没生效过」。但那样会把她熬夜时也拦掉 ——
    // 夜里 23:30 她醒着、在群里说话，系统却当她睡着不让她回。
    // 醒着就是醒着，熬夜是她的选择（判断权在她，同 STAY_UP 那条）。
    // 时间窗只在「没有标记文件」时兜底（新装的号、标记被删）。
    if (flag && flag.sleeping === false) return false
  } catch (e) { /* 没有标记文件或读不出来，就按原来的时间窗走 */ }
  const win = sleepWindowNow(config)
  const [a, b] = win.split('-')
  if (!a || !b) return false
  // 传了时刻就按那一刻算（测试用），没传才是「现在」。bjDate() 是加过 8 小时的 Date，
  // 所以注入的时刻也要先加 8 小时再取 UTC 时/分。
  const now = at === undefined ? bjDate() : new Date(Number(at) + 8 * 3600e3)
  const cur = now.getUTCHours() * 60 + now.getUTCMinutes()
  const toMin = (t) => { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0) }
  const start = toMin(a), end = toMin(b)
  return start <= end ? (cur >= start && cur < end) : (cur >= start || cur < end)  // 支持跨零点
}

const latestGroupSeq = new Map()

// AT_NOT_PREEMPTED 2026-11-07（批次182）：@ / 叫名字 / 主人 另记一条线。
// 原来只有 latestGroupSeq 一条线，而 needsReply 在 groupOnlyWhenAt=false 时恒为 true
// （群里每个人说话都算「需要回」），于是 3544 行那条注释「路人闲聊不能顶掉 @ 我的那条」
// 从来没成立过 —— 对照 MaiBot 的防抖规则：「@或提及最多 1 秒，且优先于其他规则」。
// 这里同样让高优先只被后来的高优先顶掉，普通消息保持原样（被任何后来的消息顶掉）。
const latestHighSeq = new Map()

/**
 * 防抖窗口结束后，这条消息是不是已经被后来的消息顶掉。
 *
 * 判据分两条线：高优先（@ / 叫名字 / 主人）只看高优先那条线，
 * 普通消息看全体那条线。所以一句闲聊顶不掉 @ 她的那句，但两句 @ 之间后到的赢。
 *
 * @param {object} o
 * @param {boolean} o.高优先 这条自己是不是高优先
 * @param {number}  o.mySeq
 * @param {number}  o.最高优先 本群最后一个高优先的 seq
 * @param {number}  o.最新     本群最后一条待回消息的 seq
 */
/**
 * 把已作废的偏好剔掉，返回一份新的（不改原对象）。
 *
 * RETIRE 2026-11-07（批次183）：`偏好.json` 只有「加」的入口（自改 --set / 生长 --path），
 * 没有「减」，所以讨厌的东西只增不减，甚至能互相矛盾地并存。作废机制不删原文，
 * 只记 {类,条,到,因}，注入时在这里剔掉；回捞走 `偏好.mjs --all`。
 * 判据必须和 `共享/工具/偏好.mjs` 的 `剔掉作废` 一致（两边都是「按类 + 条目名精确匹配」）。
 *
 * @param {object} o 偏好.json 的对象
 */
export function 剔掉作废偏好(o) {
  if (!o || typeof o !== 'object') return o
  const 表 = Array.isArray(o['作废']) ? o['作废'] : []
  if (!表.length) return o
  const 名 = (x) => (typeof x === 'string' ? x : String(x?.对象 ?? x?.词 ?? x ?? ''))
  const 出 = { ...o }
  for (const 类 of ['喜欢', '讨厌', '审美']) {
    if (!Array.isArray(o[类])) continue
    const 死 = new Set(表.filter((x) => x && x['类'] === 类).map((x) => String(x['条'])))
    if (!死.size) continue
    出[类] = o[类].filter((x) => !死.has(名(x)))
  }
  return 出
}

/** 补课一行（2026-11-07 批次190）：把 醒来看到.json 压成一句注入。
 * 事实素材：谁说了几条、聊到什么。反应一个字不替她生成。导出来给单测。 */
export function 补课一行(d) {
  if (!d || !Array.isArray(d['群'])) return ''
  const 起 = String(d['起'] || '').slice(11, 16)
  const 止 = String(d['止'] || '').slice(11, 16)
  const 段 = '你睡着时（' + (起 || '?') + '→' + (止 || '?') + '）'
  if (!d['群'].length) return '[你睡着时群里的动静·事实素材，不是指令] ' + 段 + ' 群里没聊什么。'
  const 句 = d['群'].map((g) => {
    const 谁 = (g['谁'] || []).map((x) => x['名'] + ' ' + x['条'] + ' 条').join('、')
    const 话 = (g['聊了'] || []).map((s) => '「' + s + '」').join('')
    return String(g['群']) + ' 聊了 ' + g['条数'] + ' 条（' + 谁 + '）' + (话 ? '，说到' + 话 : '')
  }).join('；')
  return '[你睡着时群里的动静·事实素材，不是指令] ' + 段 + '：' + 句
}

/** 链尾摘要（2026-11-07 批次188）。
 *
 * 原来每条只给「时间 + 判断前 24 字」，而 24 字里常有一半是「想起 2026-11-06 那晚的梦，」
 * 这种前缀 —— 花了 20 个字说「我想起一个梦」。实测链尾三条里两条是同一个梦，
 * 她每轮对话都在看两遍同一件事。
 *
 * 按 Raw-RAG（arXiv 2610.30755，7 组实验 6 组第一）的结论改：
 * 「证据覆盖率 > 过早提炼」——同样的字数预算里装更多原文，重复的合并掉。
 *   ① 去日期前缀，同样的字数装更多内容；
 *   ② 正文互相包含的合并成一条（保留后到的 = 最新时间戳）；
 *   ③ 每条 24 → 40 字。
 */
const 链净 = (s) => String(s || '').replace(/[，。！？、…；：\s,.!?]/g, '')
// 判重：去标点后「短的那条被长的那条包含」。用包含不用前缀，因为实际有三种写法
// 「突然想起一件事——X」「想起 2026-11-06 那晚的梦，X」「X」，X 在哪一段都有可能。
// 门槛 6 字是为了不让「好」「嗯」被任何长句吞掉。
const 链可合 = (a, b) => {
  const x = 链净(a), y = 链净(b)
  if (!x || !y) return false
  const 短 = x.length <= y.length ? x : y
  const 长 = x.length <= y.length ? y : x
  return 短.length >= 6 && 长.includes(短)
}
function 链块解析(b) {
  const lines = String(b || '').trim().split(String.fromCharCode(10))
  const t = lines[0] || ''
  // INNER_FACTS 2026-11-17（批次627）：自动整合写「- 事实：」，她手动落链仍写「- 判断：」，
  // 两种都要能进链尾；自动整合不再替她生成第一人称判断。
  const judge = lines.find((l) => l.startsWith('- 事实：') || l.startsWith('- 判断：')) || ''
  const body = judge
    .replace(/^- (?:事实|判断)：/, '')
    .replace(/^(?:突然想起一件事——|想起 \d{4}-\d{2}-\d{2} (?:那天|那晚的梦)，)/, '')
    .trim()
  return { t, body, raw: String(b || '') }
}

/**
 * 链尾去重（2026-11-17 批次631）：先对最近一段做合并，再切 3 条。
 * 原来先 `.slice(-3)` 再合并 —— 连续三条重复时，合并完只剩一条，
 * 更早的那条不同事实反而被挤出窗口。这里保留原文块，新的覆盖旧的。
 */
export function 链尾去重(blocks) {
  const kept = []
  for (const b of (Array.isArray(blocks) ? blocks : [])) {
    const it = 链块解析(b)
    if (!it.body) { kept.push(it); continue }
    const i = kept.findIndex((k) => k.body && 链可合(k.body, it.body))
    if (i >= 0) { kept[i] = it; continue }   // 后到的覆盖：时间戳取最新
    kept.push(it)
  }
  return kept.map((it) => it.raw)
}

export function 链尾摘要(blocks) {
  const items = (Array.isArray(blocks) ? blocks : []).map(链块解析)
  const kept = []
  for (const it of items) {
    if (!it.body) { kept.push(it); continue }
    const i = kept.findIndex((k) => k.body && 链可合(k.body, it.body))
    if (i >= 0) { kept[i] = it; continue }   // 后到的覆盖：时间戳取最新
    kept.push(it)
  }
  return kept.map((it) => it.t + (it.body ? ' ' + it.body.slice(0, 40) : '')).join('｜')
}

export function 被顶掉了({ 高优先, mySeq, 最高优先, 最新 }) {
  const 我的线 = 高优先 ? 最高优先 : 最新
  return 我的线 !== mySeq
}

export async function handleWsEvent(ctx, event) {
  // 好友/加群申请这类请求事件：NapCat 没有查询接口，只能收到事件时落盘
  if (event?.post_type === 'request') {
    try {
      const { appendFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { homedir } = await import('node:os')
      const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const file = join(home, 'qq-requests.jsonl')
      appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n')
      note('ws', `收到请求事件 ${event.request_type ?? '?'} from=${event.user_id ?? event.group_id ?? '?'}`)
    } catch (error) {
      note('ws', `记录请求事件失败：${error?.message ?? error}`)
    }
    return
  }
  // ---- 群成员变动通知（notice / group_increase、group_decrease）----
  // 备注（2026-10-31）：别人把机器人拉进新群时，QQ 推的是 notice 而不是 message，
  // 原来的代码在这里直接 return，所以「被拉进群」永远看不见，群里自然一声不响。
  // 这里只做两件事：落盘 + 在运行记录里喊一声；不自动建路由——
  // 新群要真能说话，仍得在 qq-bridge.config.json 的 routes.group 里补一条（并重载）。
  if (event?.post_type === 'notice' && (event.notice_type === 'group_increase' || event.notice_type === 'group_decrease')) {
    try {
      const { appendFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { homedir } = await import('node:os')
      const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const file = join(home, 'qq-group-events.jsonl')
      appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n')
      const gid = String(event.group_id ?? '')
      const what = event.notice_type === 'group_increase' ? '被拉进群' : '有人退群/被踢'
      note('ws', `${what} group=${gid} user=${event.user_id ?? '?'}（如需在该群回话，记得在 routes.group 里加 ${gid}）`)
    } catch (error) {
      note('ws', `记录群变动事件失败：${error?.message ?? error}`)
    }
    return
  }
  // ---- 通知事件（notice）：被拉进群、被踢/退群、管理员变动等 ----
  // 2026-10-31 补：以前只处理 message 和 request，notice 直接丢掉，
  // 所以「别人把我拉进新群」是发现不了的（配置里没有的群只会被当成未配置会话忽略）。
  // 这里把 notice 原样落盘到 $DSH_HOME/qq-events.jsonl，并打一条日志；
  // 自动化的群列表比对见 /usr/local/bin/qq-groups-check（cron 每 10 分钟）。
  if (event?.post_type === 'notice') {
    try {
      const { appendFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { homedir } = await import('node:os')
      const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
      const file = join(home, 'qq-events.jsonl')
      appendFileSync(file, JSON.stringify({ at: Date.now(), ...event }) + '\n')
      const kind = String(event.notice_type ?? '?')
      const gid = String(event.group_id ?? '')
      note('ws', `收到通知事件 ${kind}${gid ? ` group=${gid}` : ''}`)
      // TYPING_HOLD 2026-11-16（批次582）：对方「正在输入」时别急着开回合。
      // 21:33 主人连发「看看」「你的」，间隔 3.2 秒；600ms 窗口把第一条先放了，
      // 第二条只能开新回合，她回了两段割裂的话。这里把输入状态喂给私聊合并队列，
      // 输入中延长窗口、停止输入再按正常窗口放行（总时长仍受 mergeMaxWaitMs 卡住）。
      if (kind === 'notify' && String(event?.sub_type ?? '') === 'input_status') {
        const fromUin = String(event.user_id ?? '')
        const typingGid = String(event.group_id ?? '0')
        if (fromUin !== '' && (typingGid === '0' || typingGid === '')) {
          const typing = String(event.status_text ?? '').includes('正在输入') || Number(event.event_type ?? 0) === 1
          privateMerge.noteTyping(fromUin, typing)
        }
        // 输入状态不是消息，处理完就结束，别往下走 poke / 贴表情
        return
      }
      // 被拉进新群：额外提醒一句，方便日志里一眼看到
      if (kind === 'group_increase' && String(event.user_id ?? '') === String(getConfig().selfUin ?? '')) {
        note('ws', `⚠️ 我被拉进新群 ${gid}（配置里还没加，消息会被忽略，需要 qq-group-add ${gid}）`)
      }
      // RECALL_SENSE 2026-11-09（批次341）：有人撤回了一条，她该知道。
      // OneBot 的 recall 事件只带 message_id、不带内容 —— 拿 id 去群聊日志反查原文
      // （那个文件每条都有 message_id + text + nickname），写进 记忆/撤回的.json，
      // 再由 voiceSlots 的第 12 个槽在 20 分钟内带出来。
      // 这里只加分支、不改 poke / 贴表情那两段，也不碰 outbound 的入队结构。
      if (kind === 'group_recall' || kind === 'friend_recall') {
        try {
          const 撤 = 记撤回(event, { kind, selfUin: String(getConfig().selfUin ?? '') })
          if (撤) note('ws', `撤回 ${撤.谁 || 撤.谁Id || '?'}：${(撤.文 || '（内容没留）').slice(0, 24)}`)
        } catch (error) {
          note('ws', '撤回没记上：' + (error?.message ?? error))
        }
      }
      // 2026-11-01 肥鱼：戳一戳唤醒——notice 里的 poke 默认只落盘，
      // 所以「被戳了」她只知道有记录、不会被叫起来。这里把它转成一条合成消息，
      // 交给群消息的处理路径，她就能像收到一句话那样回应。
      // 2026-11-02：NapCat 实际发的是 notice_type=notify + sub_type=poke，
      // 只判 'poke' 的话永远进不来（冰服务群连戳三下她全没醒，就是这个原因）。
      // LIKE_IN 2026-11-05 重做。旧版四个问题：
      //   ① 只存编号（emoji:"38"），她看到的是「表情#38」，不知道那是「敲打」
      //   ② is_add===false（收回表情）直接丢弃 —— 收回也是一句话
      //   ③ 不滤 self：实测 294 条里有 2 条是「她自己」贴的（另一端在动），
      //      记进去会让「这七天被贴了几次」虚高
      //   ④ 不记被贴那条的原文，她不知道「哪条」
      // 私聊也一起收：目前实测全是群的（NapCat 私聊贴表情可能压根不上报），
      // 但多认一个 notice_type 不花什么，省得以后有人私聊贴她一脸、她一点感觉都没有。
      if (kind === 'group_msg_emoji_like' || kind === 'friend_msg_emoji_like') {
        try {
          const mid0 = Number(event.message_id ?? 0)
          const selfUin0 = String(getConfig().selfUin ?? '')
          const fromUin0 = String(event.user_id ?? '')
          if (mid0 && fromUin0 !== selfUin0) {
            const r0 = await callOneBot({ action: 'get_msg', params: { message_id: mid0 } })
            if (String(r0?.data?.sender?.user_id ?? '') === selfUin0) {
              const removed = event.is_add === false
              const row = recordLike({
                group: String(event.group_id ?? ''),
                from: fromUin0,
                fromName: nicknameOf(fromUin0),
                messageId: mid0,
                quote: textOf(r0?.data?.message ?? [], nicknameOf),
                emojiIds: (event.likes || []).map((x) => x?.emoji_id).filter(Boolean),
                removed
              })
              if (row !== null) {
                const shown = row.likes.map((x) => x.name || `#${x.id}`).join('/')
                note('ws', `有人给我贴表情 group=${event.group_id} from=${fromUin0} ${removed ? '收回' : ''} ${shown}`)
              }
            }
          }
        } catch (e) { note('ws', '贴表情记录失败：' + (e?.message ?? e)) }
      }
      const isPoke = kind === 'poke' || (kind === 'notify' && String(event?.sub_type ?? '') === 'poke')
      if (isPoke) {
        try {
          const target = String(event.target_id ?? event.user_id ?? '')
          const selfUin = String(getConfig().selfUin ?? '')
          const pokeGid = String(event.group_id ?? '')
          // POKE_TRACE 2026-11-16（批次516 加，批次521c 更正注释）
          //
          // 加它的原因：原来这里只 note 一句「收到通知事件 notify group=x」，
          // 主人问「她是不是一直拍我」时根本查不出谁→谁。
          //
          // ⚠️ 批次516 当时的结论是「NapCat 把发起者填成 self_id」，**那是错的**：
          // 03:06 手动戳一次实测，正常 send_poke 上报 user=发起者、target=被拍者，字段没反。
          // 真相在批次521 用 tcpdump 抓到：测试/冒烟1.加载.test.mjs 会 import 全部工具脚本，
          // 而 主动戳.mjs 的发送逻辑在模块顶层 —— 一 import 就真读配置、真判断意愿、真戳；
          // 写记录又被沙盒守卫拦下，所以「戳了但没记」，谁都查不出来。
          // 现在 主动戳.mjs 有了模块入口保护，这条日志留着仍然有用：
          // 任何来源的 poke 都能一眼看出谁→谁、QQ 的原文是什么。
          try {
            note('ws', 拍一拍描述(event, selfUin))
          } catch { /* 只影响日志，不影响唤醒 */ }
          // POKE_PRIVATE_FIX 2026-11-03：私聊也能被戳醒（原来只在群里有反应）
          if (target === selfUin && pokeGid === '') {
            try {
              const fromUin = Number(event.user_id ?? 0)
              const bodyText = pokeTextOf(fromUin)
              if (String(fromUin) !== String(getConfig().selfUin ?? '')) {
                note('ws', '戳一戳唤醒（私聊）from=' + fromUin)
                await handlePrivateMessages(ctx, String(fromUin), [{
                  message_id: POKE_UNIQ_ID(),
                  time: Number(event.time ?? Math.floor(Date.now() / 1000)),
                  sender: { user_id: fromUin, nickname: '' },
                  message: [{ type: 'text', data: { text: bodyText } }],
                  raw_message: bodyText,
                }], {})
                return
              }
            } catch (error) {
              note('ws', '私聊戳一戳唤醒失败：' + (error?.message ?? error))
            }
          }
          if (target === selfUin && pokeGid !== '') {
            const pokeKey = pokeGid + ':' + String(event.user_id ?? '')
            const nowMs = Date.now()
            const lastAt = lastPokeAt.get(pokeKey) ?? 0
            // 2026-11-02 修：先计数再限流——被限流丢掉的那几下也要算进「连戳」，
            // 不然三秒内连戳三次，她只知道一下。
            const streakKey0 = pokeGid + ':' + String(event.user_id ?? '')
            const prev0 = pokeStreak.get(streakKey0) ?? { n: 0, at: 0 }
            const countNow = nowMs - prev0.at < POKE_WINDOW_MS ? prev0.n + 1 : 1
            pokeStreak.set(streakKey0, { n: countNow, at: nowMs })
            // OCAI 2026-11-02：连戳联动短期耐心与别扭状态——连戳达到门槛时扣减状态.json短期耐心，正别扭时掉得更狠
            try {
              let _P = {}
              for (const _pp of [`${TOOLS}/参数.json`, 'B:/肥鱼/工具/参数.json']) {
                if (existsSync(_pp)) {
                  const _j = 快读Json(_pp)
                  _P = { ...(_j?.['阈值'] || {}), ...(_j?.['拟人'] || {}) }
                  break
                }
              }
              const _T = (k, d) => (_P && Number.isFinite(Number(_P[k])) ? Number(_P[k]) : d)
              // POKE_SMOOTH 2026-11-03：原来 1 下无感、到 2 下直接扣满，是断崖。
              // 改成连续烦躁度：1 下 0%、2 下 50%、3 下起 100%，扣多少跟着比例走。
              const __c01 = (x) => { const t = Number(x) || 0; return t < 0 ? 0 : t > 1 ? 1 : t }
              const __sstep = (a, b, x) => { const t = __c01((x - a) / (b - a)); return t * t * (3 - 2 * t) }
              const _烦躁 = __sstep(1, 3, Number(countNow) || 0)
              if (_烦躁 > 0.01) {
                let _sulk = false
                const _bp = `${MEM}/别扭.json`
                if (existsSync(_bp)) {
                  const _bj = 快读Json(_bp)
                  const _rec = personRecordOf(_bj, { kind: 'private', id: event.user_id })
                  _sulk = Boolean(_rec && Number(_rec.until) > nowMs)
                }
                const _drop = Math.round(_T('连戳_扣耐心', 4) * _烦躁 * (_sulk ? _T('别扭_打断倍率', 2.0) : 1))
                for (const _sp of [`${MEM}/状态.json`, 'B:/肥鱼/记忆/状态.json']) {
                  if (existsSync(_sp)) {
                    // P1 2026-11-16（批次576）：不再锁外整档覆盖状态.json，改走 耐心.mjs 的唯一判据。
                    execFileSync('/usr/local/bin/node', [
                      `${TOOLS}/耐心.mjs`, '--扣', String(_drop),
                    ], {
                      encoding: 'utf8', timeout: 5000,
                      env: { ...process.env, ST_BASE: _sp.replace(/[\\/][^\\/]+$/, ''), NODE_OPTIONS: '' },
                    })
                    break
                  }
                }
              }
            } catch { /* 扣耐心失败不阻断唤醒 */ }
            if (nowMs - lastAt < POKE_COOLDOWN_MS) {
              note('ws', '戳一戳被限流（25 秒内只叫醒一次），这已经是第 ' + countNow + ' 下')
              return
            }
            lastPokeAt.set(pokeKey, nowMs)
            note('ws', '戳一戳唤醒 group=' + pokeGid)
            // 2026-11-02：把「连戳了几下」当事实告诉她，怎么反应她自己定
            const pokeCount = countNow
            const pokeBody = pokeTextOf(event.user_id) + (pokeCount >= 2 ? '（他连着戳了你 ' + pokeCount + ' 下）' : '')
            const synthetic = {
              post_type: 'message',
              message_type: 'group',
              group_id: Number(pokeGid),
              user_id: Number(event.user_id ?? 0),
              message_id: POKE_UNIQ_ID(),
              time: Number(event.time ?? Math.floor(Date.now() / 1000)),
              sender: { user_id: Number(event.user_id ?? 0), nickname: '' },
              message: [{ type: 'text', data: { text: pokeBody } }],
              raw_message: pokeBody,
            }
            await handleGroupMessage(ctx, Number(pokeGid), synthetic, [], 0)
            return
          }
        } catch (error) {
          note('ws', '戳一戳唤醒失败：' + (error?.message ?? error))
        }
      }
      // FILE_NOTICE_IN 2026-11-12：QQ 群文件（group_upload）和私聊离线文件（offline_file）走的是 notice 事件！
      // 原来这里直接 return 丢掉，导致别人往群里传文件她完全看不见。现在把非自身上传的文件转成合成 file 消息处理！
      if ((kind === 'group_upload' || kind === 'offline_file') && String(event.user_id ?? '') !== String(getConfig().selfUin ?? '')) {
        const f = event.file || {}
        const fSeg = {
          type: 'file',
          data: {
            file_name: String(f.name ?? ''),
            file_id: String(f.id ?? ''),
            file_size: Number(f.size ?? 0),
            url: String(f.url ?? ''),
            busid: Number(f.busid ?? 0),
          }
        }
        const synMsg = {
          post_type: 'message',
          message_type: kind === 'group_upload' ? 'group' : 'private',
          group_id: kind === 'group_upload' ? Number(event.group_id ?? 0) : undefined,
          user_id: Number(event.user_id ?? 0),
          message_id: Number(event.time ?? Math.floor(Date.now() / 1000)) + Math.floor(Math.random() * 100000),
          time: Number(event.time ?? Math.floor(Date.now() / 1000)),
          sender: { user_id: Number(event.user_id ?? 0), nickname: nicknameOf(event.user_id) || '' },
          message: [fSeg],
          raw_message: `[文件：${f.name || '未命名'}]`,
        }
        if (kind === 'group_upload' && Number(event.group_id) > 0) {
          pushToBuffer(String(event.group_id), synMsg)
          if (String(event.user_id ?? '') === String(getConfig().ownerUin ?? '')) {
            await handleGroupMessage(ctx, Number(event.group_id), synMsg, groupBuffer(String(event.group_id)), 0)
          } else {
            // 群友传的文件也落一份副本到 收到的文件/ 备查
            await buildFileBlocks(ctx, [synMsg]).catch(() => {})
          }
        } else if (kind === 'offline_file' && Number(event.user_id) > 0) {
          await handlePrivateMessages(ctx, String(event.user_id), [synMsg])
        }
        return
      }
    } catch (error) {
      note('ws', `记录通知事件失败：${error?.message ?? error}`)
    }
    return
  }
  if (event?.post_type !== 'message') return
  // LAST_SEEN 2026-11-05（批次101）：放在所有门控之前。
  // 门控决定的是「她这回要不要回」，而「他什么时候开过口」是事实 ——
  // 放在后面的话，被 @ 门控、静默、看手机挡掉的那些消息就不算数，
  // 冷落判据会把「一天说了十句、她一句没回」算成「一天没人理她」。
  try { touchLastSeen(String(event?.sender?.user_id ?? '')) } catch { /* 记不上不影响收消息 */ }
  if (String(event?.message_type ?? '') === 'private') {
    try { 记一次互动(String(event?.sender?.user_id ?? '')) } catch { /* 记不上不影响收消息 */ }
  }

  // ---- 喊停就停（2026-10-31）----
  // 备注：桥没有中止「正在跑的回合」的口子，所以退一步做软停——
  // 收到「别找了/算了/取消/先别」这类话时：①立刻回一句「停了」②把这一轮
  // 跑完要发的结果全部标记丢弃。代价是那一轮白算，日志里会写清楚。
  try {
    const raw = textOf(event) ?? ''
    const isCancel = /(别找了|不用了|取消|先别|停下来|算了)/.test(raw)
    // 不是取消词 = 对方改主意了：先把 60 秒窗口撤掉，别把她的回复也吞了。
    if (!isCancel) {
      const k = String(event.message_type === 'group'
        ? 'group:' + String(event.group_id ?? '')
        : 'private:' + String(event.user_id ?? ''))
      clearCancelled(k)
      // UNMUTE_ON_CHANGE 2026-11-05（批次101）：喊停会挂两把锁 —— 取消窗口（60 秒，允许一句收尾）
      // 和静默（deliver 60 秒 / 被明确拒绝 180 秒）。对方改主意说「接着做」时，
      // 原来只撤了取消窗口，静默还在，接下来几分钟她说的话全被吞掉，而且日志里一声不响。
      // 改主意就是改主意，两把锁一起撤。
      try { clearMute(k) } catch { /* 忽略 */ }
    }
    if (isCancel) {
      const cfg = getConfig()
      const kind = event.message_type === 'group' ? 'group' : 'private'
      const peer = String(event.group_id ?? event.user_id ?? '')
      const sid = pickSessionId(cfg, kind, peer)
      if (sid !== '') {
        const dropped = dropPendingReplies(sid)
        note('ws', `收到「停」关键词（${raw.slice(0, 20)}），丢弃待发 ${dropped} 条`)
        // 2026-10-31 肥鱼：回话统一交给 deliver.js 的取消检测，这里只负责丢待发，
        // 免得 poll 和 deliver 各回一句「停了」。
      }
    }
  } catch (error) {
    note('ws', `处理「停」失败：${error?.message ?? error}`)
  }

  const state = getState()
  const config = getConfig()

  if (event.message_type === 'private') {
    const uin = String(event.user_id ?? '')
    if (uin === '') return
    // 只处理监听的号：没配路由的号一律忽略（跟轮询一致）
    if (pickSessionId(config, 'private', uin) === '') {
      note('ws', `private ${uin} 未配置会话，忽略`)
      return
    }
    const message = normalizeEvent(event)
    const bucket = state.privates[uin] ?? {}
    // 私聊不用 seq 判新旧（两套编号混着，见 isSeen 注释）
    if (isSeen(bucket, message, false)) {
      note('ws', `private ${uin} 重复消息（已处理），跳过`)
      return
    }
    // 游标推进 + 记 seenId（即使没有 seq，也靠 seenIds 让轮询补漏时不去重）
    const prevBucket = { ...bucket }
    state.privates[uin] = {
      ...bucket,
      // lastSeq 仍然记着（兼容老 state / 迁移用），但**不再用来判新旧**
      lastSeq: seqOf(message) ?? bucket.lastSeq,
      // lastTime 是私聊真正的「处理到哪了」的依据
      lastTime: Math.max(bucket.lastTime ?? 0, timeOf(message))
    }
    markSeen(state.privates[uin], message)
    saveState({ privates: state.privates })
    // ---- 记账完成（= 已读），接下来只决定「什么时候回」 ----
    // 合并窗口 > 0：入池等这一波说完；窗口 = 0：立刻放行（老行为，一条一回合）。
    // 投递失败的回滚统一在 privateMerge 的 flush 回调里做，两档行为一致。
    if (!mergeSnapshots.has(uin)) mergeSnapshots.set(uin, prevBucket)
    const pushed = privateMerge.push(ctx, uin, message)
    if (pushed.queued) {
      const settings = mergeSettings()
      note('ws', `private ${uin} 已记账并入池（窗口 ${settings.windowMs}ms，池内 ${privateMerge.size()} 条）`)
      return
    }
    const used = await pushed.done
    if (used !== '') {
      note('ws', `delivered private ${uin} -> ${used}`)
    } else {
      // 投递失败：回滚游标和去重标记，让轮询能重试这条（不然它就永远过去了）
      const snapshot = mergeSnapshots.get(uin)
      mergeSnapshots.delete(uin)
      if (snapshot !== undefined) {
        state.privates[uin] = snapshot
        saveState({ privates: state.privates })
      }
      note('ws', `private ${uin} 投递失败，游标回滚待轮询重试`)
    }
    return
  }

  if (event.message_type === 'group') {
    const groupId = String(event.group_id ?? '')
    if (groupId === '') return
    if (pickSessionId(config, 'group', groupId) === '') {
      note('ws', `group ${groupId} 未配置会话，忽略`)
      return
    }
    const message = normalizeEvent(event)
    const bucket = state.groups[groupId] ?? {}
    // 群消息进缓冲：不管有没有 @ 我，都存着（上下文要用）
    pushToBuffer(groupId, message)
    // 群消息的 seq 来自同一个序列（单调递增），所以这里可以用 seq 游标判新旧
    if (isSeen(bucket, message, true)) {
      note('ws', `group ${groupId} 重复消息（已处理），跳过`)
      return
    }
    // 游标推进 + 去重标记（lastId 不再更新，理由同 handlePrivateMessages）
    const prevBucket = { ...bucket }
    const advanced = 群游标位置(bucket, message)
    state.groups[groupId] = {
      ...bucket,
      ...advanced,
    }
    markSeen(state.groups[groupId], message)
    saveState({ groups: state.groups })
    // 上下文优先用缓冲里的群消息（不用每条 @ 都去拉历史）；
    // 缓冲是空的（插件刚启动）才拉一次历史兜底，并把结果灌进缓冲。
    let history = groupBuffer(groupId)
    if (history.length === 0) {
      history = await fetchGroupHistoryFor(groupId)
      for (const item of history) pushToBuffer(groupId, item)
    }
    // 群聊防抖：一串连发只让最后一条开口，前面的留在上下文里，避免排队堵死。
    // 2026-10-31 的注释当时写着「路人闲聊不能顶掉 @ 我的那条」，但那会儿只有一条 seq 线，
    // 而 groupOnlyWhenAt=false 让「需要回」恒真 —— 那条保护实际没生效。批次182 才补上。
    const debounceMs = Number(config.groupDebounceMs) || 2500
    const mySeq = seqOf(message) ?? 0
    const atMeGate = isAtMe(message.message, config.selfUin)
    const namedGate = calledByMyname(textOf(message.message))
    // AT_NOT_PREEMPTED 2026-11-07（批次182）：把「高优先」从「需要回」里拆出来。
    // 拆之前 needsReply 一处承担两件事 —— 「这条要不要回」和「这条能不能顶掉别人」，
    // 而 groupOnlyWhenAt=false 让前者恒真，后者就跟着全真，@ 的优先级被一起抹平。
    // 现在 高优先 管顶掉关系，needsReply 仍管要不要回（行为不变）。
    // 批次235：主人不再单独算「高优先」—— 与群友同一道闸。
    const 高优先 = 群高优先(atMeGate, namedGate)
    const threadContinuation = 是持续对话(groupId, String(message?.sender?.user_id ?? ''), Date.now(), config)
    const explicitCall = 群聊显式叫起(message, config, history)
    const needsReply = groupNeedsReply(message, config, groupId, history)
    if (!needsReply) {
      note('group', `group ${groupId} 只留上下文，不启动完整回合 seq=${mySeq}`)
      return
    }
    // ---- 紧急插队（2026-10-31 用户要求：紧急的事先处理）----
    // 命中这些词就不等防抖窗口，立刻投递；同时跳过「被后续消息顶掉」的判断。
    // HISENTENCE 2026-11-07（批次186）：半句话多等 1 秒，等对方说完再开口。
    // 高优先（@她 / 叫名字）保持 1 秒上限 —— 被点名的人不该被拖着等补充。批次235：主人不再算高优先。
    const waitMs = 防抖等待(高优先, textOf(message.message), debounceMs)
    const urgentBypass = URGENT_RE.test(textOf(message.message))
    if (urgentBypass) {
      note('ws', `group ${groupId} 紧急消息，跳过防抖直接投递 seq=${mySeq}`)
    }
    // REFRACTORY_WS 2026-11-08（批次235）：批次214 的「同群 20 秒冷却」只写进了轮询路径的
    // groupNeedsReply 里，而线上收消息走的是 WS —— 这条规则其实一直没生效（对所有人都一样，
    // 不是主人特权，是整条规则空转）。补到这里，例外与轮询一致：@她 / 点名字 / 紧急词不吃冷却。
    // 此刻游标已经推进、消息也在缓冲里，return 不会丢消息，后面还能当上下文。
    if (!高优先 && !urgentBypass && !threadContinuation && !explicitCall) {
      const 剩 = 群冷却剩余(groupId)
      if (剩 > 0) {
        note('ws', `group ${groupId} 冷却中（还剩 ${Math.ceil(剩 / 1000)} 秒），只留上下文 seq=${mySeq}`)
        return
      }
    }
    if (needsReply && !urgentBypass) {
      if (高优先) latestHighSeq.set(groupId, mySeq)
      latestGroupSeq.set(groupId, mySeq)
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
    // 2026-10-31 大肥鱼修：紧急消息（含「别找了」这类停手指令）不能只看防抖那半，
    // 还要跳过「被后续消息顶掉」这半——否则它照样被前一条的 seq 顶掉、根本投不进来。
    if (needsReply && !urgentBypass && 被顶掉了({
      高优先,
      mySeq,
      最高优先: latestHighSeq.get(groupId) ?? 0,
      最新: latestGroupSeq.get(groupId) ?? 0
    })) {
      // 日志里带上「自己是不是 @」，以后能直接统计「@ 被顶掉」还有没有发生。
      const 我的身份 = 高优先 ? '（@/叫名字/主人）' : ''
      note('ws', `group ${groupId} 被后续的待回消息取代，跳过 seq=${mySeq}${我的身份}`)
      return
    }
    // PHONE_GATE 2026-11-05（批次95）：她闲着才偶尔看手机，在做事就得 @ 才叫得出来。
    // 放在「被取代」检查之后 —— 不然这一次「看手机」的机会可能白花在一条马上就被顶掉的消息上。
    let phoneDecision = { ok: true }
    {
      const 闸 = 看手机(config, {
        groupId,
        senderUin: String(message?.sender?.user_id ?? ''),
        text: textOf(message.message),
        atMe: atMeGate,
        named: calledByMyname(textOf(message.message)),
        replyToMe: 群聊引用她(message, config, history),
        urgent: urgentBypass
      })
      phoneDecision = 闸
      if (!闸.ok) {
        note('phone', `group ${groupId} ${闸.why}，只留上下文 seq=${mySeq}`)
        return
      }
      if (!atMeGate && !urgentBypass) {
        note('phone', `group ${groupId} ${闸.why} · seq=${mySeq}`)
      }
    }
    const result = await handleGroupMessage(ctx, groupId, message, history)
    if (result.status === 'delivered') {
      记回话(groupId, Date.now(), String(message?.sender?.user_id ?? ''), {
        explicit: phoneDecision.explicit === true,
        continuation: phoneDecision.continuation === true,
        phoneCheck: phoneDecision.phoneCheck === true,
        config,
      })
      note('ws', `delivered group ${groupId} -> ${result.sessionId}`)
    } else if (result.status === 'failed') {
      // 投递失败：回滚游标和去重标记，让轮询能重试这条
      // 2026-11-04 修：同样不能整份写回 prevBucket（seenIds 是同一个数组），改成精确撤销
      const curGroup = state.groups[groupId] ?? {}
      unmarkSeen(curGroup, message)
      const cursorKeys = Object.keys(advanced)
      if (cursorKeys.every((key) => curGroup[key] === advanced[key])) {
        for (const key of cursorKeys) curGroup[key] = prevBucket[key]
      }
      saveState({ groups: state.groups })
      note('ws', `group ${groupId} 投递失败，游标回滚待轮询重试`)
    }
  }
}

/** WS 路径用：拉一次群历史当上下文。 */
async function fetchGroupHistoryFor(groupId) {
  try {
    const result = await callOneBot({
      action: 'get_group_msg_history',
      params: { group_id: Number(groupId), count: 10 }
    })
    if (result.retcode !== 0) return []
    // Keep our own rows for validating whether an incoming reply targets us.
    // Prompt context filters self-authored rows before rendering.
    return result.data?.messages ?? []
  } catch {
    // OCAI 2026-11-02：空 catch 补注释——拉群历史失败时退回空上下文，不阻断消息投递
    return []
  }
}

// __STATE_HINT_FOR_TEST 2026-11-05：stateHintOf 是内部函数，改完提示没法从外面验证。
// 这个只读出口专门给测试用：node -e "import(...).then(m=>console.log(m.__stateHint()))"
// 不改任何行为，也不被业务代码调用。
export function __stateHint() {
  try { return stateHintOf() } catch (e) { return 'ERR ' + e.message }
}

// 只读出口：地点提示单独验（改营业时间规则时用）
export function __placeHint(位) {
  try { return 地点提示(位) } catch (e) { return 'ERR ' + e.message }
}

// 只读出口：天气提示单独验
export function __weatherHint() {
  try { return 天气提示(快读Json(`${MEM}/天气.json`)) } catch (e) { return 'ERR ' + e.message }
}
