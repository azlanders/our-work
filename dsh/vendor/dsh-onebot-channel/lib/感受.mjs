// 感受.mjs —— 她自己记的「这句话让我有什么感觉」。
//
// 为什么不由系统替她判断：拿 6624 条真实群聊语料试过，「回滚」「滚动」「滚木」「越滚越费」
// 全被 /滚/ 命中，「我就先闭嘴攒着」被当成骂人 —— 47 条「被骂」里绝大多数是技术讨论。
// 机器判不准人话的分寸，她自己能。所以判断权交给她的 qq_feel，这个模块只负责两件事：
//   (a) 把她的判断变成激素事件（她认定被骂，皮质醇才升）；
//   (b) 让她以后还看得见自己怎么想的 —— 这是「成长」的物理载体。
//
// 设计上刻意不做「自动推断」：没有正则、没有情绪评分。她说不记就是不记。
//
// FEELING_LEDGER 2026-11-05 二改：只「记下来 + 身体变一下」是不够的，两头都断着 ——
//   头：她对那个人的态度不跟着变，被骂一场像没发生过，下次还当没事人；
//   尾：她没法推翻自己，判错了就永远错着，那不叫成长，叫固执。
//   所以现在多两个动作：
//     · 被骂 / 越界 且指明了是谁 —— 记进人情账（扣分 + 欠一句道歉）；
//     · 想岔了 —— 把那笔账销掉（分还回去、欠账减一）。
//   这不违反「判断权在她」，恰恰相反：能判、也能改判，这本账才真是她的。
//   被打断故意不记账：「这儿没你的事」和「你是垃圾」不是一回事。
//   要是连被人嫌烦一下都要人家赔罪，那不是人，是刺猬。
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { bjDate } from './env.js'
// PERSONA_COEFF 2026-11-09（批次340）：16PF 的敏感性 + 忧虑性 → 0.8~1.3。
// 它是 7 个性格系数里唯一没接上的：其余六个（急切/社交/好奇/语气/激素/节奏）都在用，
// 只有它被算出来没人调 —— 等于「她的敏感白测了」。
import { sensitiveCoeff } from './性格系数.mjs'

// FEEL_FILE 可在测试里改到临时文件，避免把自检记录写进她真实的心情账本
const FILE = process.env.FEEL_FILE || `${QQ_WS}/记忆/感受.jsonl`
const TOOL = `${QQ_WS}/共享/工具/激素.mjs`
const FAV = `${QQ_WS}/共享/工具/好感度.mjs`
// REL_BRIDGE 2026-11-09（批次307）：关系双量的即时入口。
// 原来 关系.mjs 唯一的调用方是已停用的 认事.mjs（批次63），于是 关系.json 从 11-04 起
// 再没更新过，而 voiceSlots 的 slotRelationBond/slotPlayfulness/slotClash 和 激素.mjs 的
// 关系调制一直在读它 —— 典型的「接口做了、接入点没有」。
const REL = `${QQ_WS}/共享/工具/关系.mjs`
const NODE = process.env.DSH_NODE || '/usr/local/bin/node'
const MAX_BYTES = 512 * 1024 // 超过就只留后半，避免无限涨

/** 允许的感觉。必须是 激素.mjs 的 EVENTS_TABLE 里有的，否则喂不进去。 */
export const FEELINGS = ['被骂', '被打断', '被夸', '被冷落', '被想起', '被注意到', '陪伴', '修复', '搞砸', '越界', '想岔了']

/** 要落到人情账上的感觉（扣分 + 欠道歉）。被打断不在里面，理由见文件头。 */
const 要记账 = new Set(['被骂', '越界'])

// ACCOUNT_THROTTLE 2026-11-05：连着三句难听话，不该欠三次道歉。
// 同一个人、同一种感觉，一分钟内只往账上记一次（流水照记，因为她确实每次都难受了）。
// 不加这个的话，她一激动记两笔，那个人的分就掉两次——账会失真。
const 最近记账 = new Map()
const 记账节流 = 60e3

// SELF_REVIEW 2026-11-09（批次300）：她记的每一种感觉都要落到关系上，不只被骂/越界。
// 这是「夜间自评」的数据源：不是外部模型打分，是她自己说「这句话让我有什么感觉」。
// 被骂/越界走 --scold（人情账更重），想岔了走 --unscold，这里不重复记。
const 自评表 = {
  被夸: 1.0, 被想起: 0.8, 被注意到: 0.6, 陪伴: 0.8, 修复: 0.8,
  被冷落: -0.8, 搞砸: -0.5, 被打断: -0.2,
}
const 最近自评 = new Map()

// 读一次性格文件够用五分钟 —— 它一天最多被改一回，不必每条感受都去读盘。
let _敏感 = null
let _敏感At = 0
function 敏感() {
  try {
    if (_敏感 !== null && Date.now() - _敏感At < 5 * 60e3) return _敏感
    const v = Number(sensitiveCoeff())
    _敏感 = Number.isFinite(v) && v > 0 ? v : 1
    _敏感At = Date.now()
    return _敏感
  } catch { return 1 }   // 读不到就当普通敏感度，绝不让情绪链因为一个系数挂掉
}

// 感觉 → 关系事件（关系.mjs 的 RULES 只认这七个）。
// 没列进来的（被打断 / 搞砸）不进关系：那两种是她自己的状态，不是「这个人在她心里远近」的证据。
export const 关系事件 = {
  被夸: '被夸',
  被想起: '陪伴',
  被注意到: '陪伴',
  陪伴: '陪伴',
  被冷落: '被冷落',
  被骂: '争吵',
  越界: '越界',
  修复: '修复',
  想岔了: '修复',
}
const 最近关系 = new Map()

function stamp(at) {
  const b = bjDate(at)
  const p = (n) => String(n).padStart(2, '0')
  return `${b.getUTCFullYear()}-${p(b.getUTCMonth() + 1)}-${p(b.getUTCDate())} ${p(b.getUTCHours())}:${p(b.getUTCMinutes())}`
}

function trimIfHuge() {
  try {
    if (!existsSync(FILE)) return
    if (statSync(FILE).size <= MAX_BYTES) return
    const lines = readFileSync(FILE, 'utf8').split('\n').filter((l) => l.trim() !== '')
    writeFileSync(FILE, lines.slice(-Math.floor(lines.length / 2)).join('\n') + '\n', 'utf8')
  } catch { /* 裁剪失败就让它先长着 */ }
}

/**
 * 记一次感觉。
 * @param {{kind:string, why?:string, who?:string}} input
 * @returns {{ok:boolean, kind?:string, at?:string, why?:string}}
 */
export function recordFeeling(input) {
  const kind = String(input?.kind ?? '').trim()
  if (!FEELINGS.includes(kind)) {
    return { ok: false, why: '不认识这种感觉：' + (kind === '' ? '（空）' : kind) + '；可用：' + FEELINGS.join('、') }
  }
  const at = stamp(Date.now())
  if (kind === '想岔了' && !correctableFeeling(input.corrects, input.who, input.chatKey)) {
    return { ok: false, why: '想岔了需要当前聊天、同一对象且尚未纠正的原笔 id；未记账。' }
  }
  if (input.recalledFrom && (kind === '想岔了' || !correctableFeeling(input.recalledFrom, input.who, input.chatKey))) {
    return { ok: false, why: '回想来源必须是本聊天同一对象仍有效的记录，并用于一次新感受；未记账。' }
  }
  // DSH_EMOTION_DRY=1：只验证链路通不通，不写账本、不喂激素（给实测用）
  if (process.env.DSH_EMOTION_DRY === '1') return { ok: true, kind, at, dry: true }
  const row = {
    id: randomUUID(),
    at,
    kind,
    why: String(input?.why ?? '').slice(0, 80),
    who: String(input?.who ?? '').slice(0, 24),
  }
  if (input.chatKey) {
    row.chatKey = input.chatKey
    if (input.lifeHit) row.lifeHit = true
    if (input.recalledFrom) row.recalledFrom = input.recalledFrom
    if (input.lifeSource) row.lifeSource = input.lifeSource
    if (kind === '想岔了') {
      const corrects = String(input.corrects ?? '').trim()
      row.corrects = corrects
    }
  }
  appendFileSync(FILE, JSON.stringify(row) + '\n')
  账本缓存.key = ''
  trimIfHuge()
  // 旧人情账按人而不是按事件记；不能用群里的一次改判去撤掉同一个人私聊里的账。
  if (row.corrects) return { ok: true, kind, at, id: row.id, corrects: row.corrects }
  // 喂激素：她认定自己被骂，皮质醇才升。--who 走关系调制（只影响增量，不改设定点）
  try {
    const argv = [TOOL, '--event', kind, '--id', 'feel-' + row.id]
    if (row.who !== '') argv.push('--who', row.who)
    execFile(NODE, argv, { timeout: 8000 }, () => { /* 失败不重试 */ })
  } catch { /* 激素那边挂了不影响她说话 */ }
  // 落到人情账：她的判断得有后果，不然「被骂」只是心跳快了一下。
  // 只有知道是谁才记 —— 不知道是谁的委屈，只能自己消化，没法算到谁头上。
  if (row.who !== '') {
    try {
      const 要动账 = 要记账.has(kind) || kind === '想岔了'
      const key = row.who + '|' + kind
      const last = 最近记账.get(key) || 0
      if (要动账 && Date.now() - last >= 记账节流) {
        最近记账.set(key, Date.now())
        if (要记账.has(kind)) {
          execFile(NODE, [FAV, '--scold', '--who', row.who, '--why', row.why], { timeout: 8000 }, () => { /* 同上 */ })
        } else {
          execFile(NODE, [FAV, '--unscold', '--who', row.who, '--why', row.why], { timeout: 8000 }, () => { /* 同上 */ })
        }
      }
    } catch { /* 人情账挂了也不影响她说话 */ }
  }
  // 自评：把她的感觉摊到四个状态上（亲近/安全/兴致由引擎换算）
  if (row.who !== '' && 自评表[kind] !== undefined) {
    try {
      const key = '评|' + row.who + '|' + kind
      const last = 最近自评.get(key) || 0
      if (Date.now() - last >= 记账节流) {
        最近自评.set(key, Date.now())
        // 强度乘上她自己的敏感度：同样一句难听话，敏感的人掉得更多 —— 这才是 16PF 测出来的东西
        const 强度 = Number((自评表[kind] * 敏感()).toFixed(1))
        execFile(NODE, [FAV, '--who', row.who, '--event', '自评',
          '--v', String(强度), '--why', kind + (row.why ? '：' + row.why : '')],
        { timeout: 8000 }, () => { /* 失败不重试 */ })
      }
    } catch { /* 自评挂了不影响她说话 */ }
  }
  // 关系双量：她的判断也要动「跟这个人多近、多放心」（批次307）。
  // 走独立节流（同人同感觉 60 秒一次），跟自评互不影响；失败一律吞掉，不挡回话。
  const 关系kind = 关系事件[kind]
  if (row.who !== '' && 关系kind !== undefined) {
    try {
      const key = 'rel|' + row.who + '|' + kind
      const last = 最近关系.get(key) || 0
      if (Date.now() - last >= 记账节流) {
        最近关系.set(key, Date.now())
        execFile(NODE, [REL, '--who', row.who, '--事件', 关系kind, '--why', kind + (row.why ? '：' + row.why : '')],
          { timeout: 8000 }, () => { /* 关系那边挂了不影响她说话 */ })
      }
    } catch { /* 同上 */ }
  }
  return { ok: true, kind, at, id: row.id, ...(row.corrects ? { corrects: row.corrects } : {}) }
}

// PERF 2026-11-05：voiceHintOf 每轮都要问她最近怎么想的，一次要 3 条、一次要 300 条，
// 原来两回都从磁盘全量读 + 逐行 JSON.parse。账本到 512KB（约三千条）时，这是白烧 CPU。
// 按 mtime+size 缓存——她记一笔文件就变了，缓存自己失效，不用手动清。
const 账本缓存 = { key: '', rows: [] }

function 读账本() {
  try {
    if (!existsSync(FILE)) return []
    const st = statSync(FILE)
    const key = FILE + '|' + st.mtimeMs + '|' + st.size
    if (key === 账本缓存.key) return 账本缓存.rows
    const rows = readFileSync(FILE, 'utf8').split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => { try { return JSON.parse(l) } catch { return null } })
      .filter((r) => r && typeof r === 'object')
    账本缓存.key = key
    账本缓存.rows = rows
    return rows
  } catch { return [] }
}

/** 最近 n 条感觉（可按 who 过滤）。读不到就是空数组，绝不抛错。 */
function 当前记录(chatKey) {
  const rows = 读账本().filter((entry) => entry.chatKey === chatKey && entry.id)
  const corrected = new Set(rows.map((entry) => entry.corrects).filter(Boolean))
  return rows.filter((entry) => !corrected.has(entry.id))
}

/** 只允许纠正当前聊天、同一对象、尚未被纠正且带新格式 ID 的原笔。 */
export function correctableFeeling(id, who, chatKey) {
  const target = String(id ?? '').trim()
  const person = String(who ?? '').trim()
  const scope = String(chatKey ?? '').trim()
  if (!target || !person || !/^(private|group)-[1-9]\d{0,11}$/.test(scope)) return null
  return 当前记录(scope).find((row) => row.id === target && row.who === person && row.kind !== '想岔了') || null
}

export function scopedFeelContext(chatKey, now = Date.now(), query = '') {
  if (!chatKey) return { text: '', ids: [] }
  const rows = 当前记录(chatKey)
  const recent = rows.filter((entry) => {
    const time = Date.parse(entry.at.replace(' ', 'T') + ':00+08:00')
    return time <= now && now - time <= 2 * 3600e3
  }).slice(-2)
  const fragments = new Set(Array.from(query.slice(0, 400).matchAll(/(?=([\p{L}\p{N}]{3}))/gu), (match) => match[1]))
  let originals
  const old = query && rows.findLast((entry) => {
    const time = Date.parse(entry.at.replace(' ', 'T') + ':00+08:00')
    if (!(now - time > 2 * 3600e3) || !entry.why) return false
    for (const part of fragments) if (entry.why.includes(part)) return true
    if (entry.kind === '想岔了' && entry.corrects && entry.who && fragments.size) {
      originals ??= new Map(读账本().filter((row) => row.chatKey === chatKey && row.id && row.kind !== '想岔了').map((row) => [row.id, row]))
      const original = originals.get(entry.corrects)
      if (original?.who === entry.who && typeof original.why === 'string') {
        for (const part of fragments) if (original.why.includes(part)) return true
      }
    }
    return false
  })
  if (old) recent.splice(0, Math.max(0, recent.length - 1), old)
  if (!recent.length) return { text: '', ids: [] }
  const lines = recent.map(entry => {
    const origin = !entry.recalledFrom ? '' : rows.some(row => row.id === entry.recalledFrom && row.who === entry.who)
      ? '（当时受一段旧感受触动）' : '（当时引用的旧感受已失效）'
    const reference = entry.kind === '想岔了' ? '' : ` [id ${entry.id}]`
    const life = entry.lifeSource ? `（当时受${entry.lifeSource.day}的${entry.lifeSource.source}片段触动）` : ''
    return `${entry.at} ${entry.kind}${entry.why ? '：' + JSON.stringify(entry.why.slice(0, 48)) : ''}${origin}${life}${reference}`
  })
  return { text: '[本聊天的旧感受；是你当时记的，不是对方的原话，也不是现在的结论]\n' + lines.join('\n'), ids: recent.filter(entry => entry.kind !== '想岔了').map(entry => entry.id) }
}

export function scopedFeelHint(chatKey, now, query) {
  return scopedFeelContext(chatKey, now, query).text
}

const deliveredFeelings = new WeakMap()

export function rememberFeelDelivery(session, messageId, ids, life = []) {
  if (!ids.length && !life.length) return
  let messages = deliveredFeelings.get(session)
  if (!messages) deliveredFeelings.set(session, messages = new Map())
  messages.set(messageId, { ids, life })
  if (messages.size > 512) messages.delete(messages.keys().next().value)
}

export function wasFeelDelivered(session, messageId, id) {
  return Boolean(messageId && deliveredFeelings.get(session)?.get(messageId)?.ids.includes(id))
}

export function deliveredLifeSource(session, messageId, label) {
  const ref = deliveredFeelings.get(session)?.get(messageId)?.life.find(entry => entry.label === label)
  if (!ref?.仍有效?.()) return null
  return { source: ref.source, day: ref.day, revision: ref.revision }
}

export function recentFeelings(n = 3, who = '', chatKey) {
  try {
    const rows = chatKey ? 当前记录(chatKey) : 读账本()
    const picked = who === '' ? rows : rows.filter((r) => String(r.who ?? '') === String(who))
    return picked.slice(-Math.max(1, Number(n) || 3))
  } catch { return [] }
}

/**
 * 说话时给她看的那一段。返回 '' 表示没什么可说的。
 *
 * 三件事：最近三条（带人名、带原话）、以及七天的账。
 * 单次是情绪，重复才叫脾气 —— 但只报数目，怎么看是她的事。
 * nameOf 由调用方给：名字缓存住在 poll.js，这边不该反过来依赖它。
 */
// NAME_LEAK 2026-11-14（批次417）：查不到昵称时，原来的兜底是 `号.slice(0, 6)` ——
// 实测她收到的注入里写着「其中「被想起」有 4 次是343941」。
// 那是主人的 QQ 号前六位：她不知道这是谁（等于没信息），在群里说出来还是泄漏。
// `nicknameOf` 查不到是常态 —— 它只从 get_friend_list / 配置群成员里取，
// 而主人不在她扫的那些群里；而且是懒加载 + 10 分钟节流，每个 10 分钟分桶的
// 第一次调用必定拿到空串（注入本身也按 10 分钟分桶缓存，于是裸号会被缓存一整个桶）。
// 所以兜底必须自己是个「人话」，不能是号码片段。
const 名或者 = (nameOf, u, 兜底) => {
  const n = String((() => { try { return nameOf(u) || '' } catch { return '' } })()).trim()
  return n !== '' ? n : 兜底
}

export function feelHint(nameOf = () => '', who = '') {
  try {
    const target = String(who ?? '')
    if (target === '') return ''
    const rs = recentFeelings(3, target)
    if (rs.length === 0) return ''
    const nm = (u) => {
      const s = String(u ?? '')
      if (s === '') return ''
      // 查不到就写「一个人」，别把号念给她
      return '(' + 名或者(nameOf, s, '一个人') + ')'
    }
    const txt = rs.map((r) => {
      const when = String(r.at ?? '').slice(5)
      const why = String(r.why ?? '') === '' ? '' : '「' + String(r.why).slice(0, 24) + '」'
      return when + ' ' + String(r.kind ?? '') + nm(r.who) + why
    }).join('；')
    let out = '[记得] 你自己记过的感觉：' + txt
    // LONG_MEMORY 2026-11-05：只有最近 3 条，等于她的「成长」只有 3 条深度——
    // 一周前的事全掉了。这里加一层 30 天的账：不是把旧记录全塞进提示（那会冲掉当下），
    // 而是把「这个月你被骂了几次、主要是谁」摆出来。她看见数字，自己会想起具体的事。
    // 7 天那段还留着：近的归近的，远的归远的。
    const since30 = Date.now() - 30 * 24 * 3600e3
    const kc30 = new Map()
    const pc30 = new Map()
    const since = Date.now() - 7 * 24 * 3600e3
    const kc = new Map()
    const pc = new Map()
    for (const r of recentFeelings(2000, target)) {
      const t = Date.parse(String(r.at ?? '').replace(' ', 'T') + ':00+08:00')
      if (!Number.isFinite(t) || t < since30) continue
      const k = String(r.kind ?? '')
      if (k === '') continue
      const u = String(r.who ?? '')
      if (t >= since) {
        kc.set(k, (kc.get(k) || 0) + 1)
        if (u !== '') {
          const key = u + '|' + k
          pc.set(key, (pc.get(key) || 0) + 1)
        }
      }
      // 30 天那份单独记：远的也要有个总数，但只在够多的时候才说（见下）
      kc30.set(k, (kc30.get(k) || 0) + 1)
      if (u !== '') {
        const key = u + '|' + k
        pc30.set(key, (pc30.get(key) || 0) + 1)
      }
    }
    const hot = [...kc.entries()].filter((x) => x[1] >= 2).sort((a, b) => b[1] - a[1]).slice(0, 2)
    const whoHot = [...pc.entries()].filter((x) => x[1] >= 2).sort((a, b) => b[1] - a[1])[0]
    if (hot.length > 0) {
      let line = '这七天你自己记的：' + hot.map((x) => x[0] + ' ' + x[1] + ' 次').join('、')
      if (whoHot) {
        const seg = whoHot[0].split('|')
        const n2 = 名或者(nameOf, seg[0], '同一个人')
        line += '；其中「' + seg[1] + '」有 ' + whoHot[1] + ' 次是' + n2
      }
      out += '；[' + line + ']'
    }
    // 这个月：只在比 7 天明显更久时补一句（>=4 次），免得天天同一句话。
    // MONTH_STRICTLY_MORE 2026-11-14（批次436）：上面注释写的是「只在比 7 天明显更久时补一句」，
    // 但判据只写了 >=4 —— 4 条全在这七天内时，两句说的是同一件事：
    //   [这七天你自己记的：被想起 4 次；其中「被想起」有 4 次是主人]
    //   [这个月：被想起 4 次，其中主人 占了 4 次]
    // 同一段注入把同一个数报了两遍。加「必须比七天更多」，这句话才有它自己的意思。
    const hot30 = [...kc30.entries()].filter((x) => x[1] >= 4 && x[1] > (kc.get(x[0]) || 0)).sort((a, b) => b[1] - a[1]).slice(0, 2)
    if (hot30.length > 0) {
      const who30 = [...pc30.entries()].filter((x) => x[1] >= 3 && x[1] > (pc.get(x[0]) || 0)).sort((a, b) => b[1] - a[1])[0]
      let line30 = '这个月：' + hot30.map((x) => x[0] + ' ' + x[1] + ' 次').join('、')
      if (who30) {
        const seg = who30[0].split('|')
        line30 += '，其中' + 名或者(nameOf, seg[0], '同一个人') + ' 占了 ' + who30[1] + ' 次'
      }
      out += '；[' + line30 + ']'
    }
    return out
  } catch { return '' }
}

/** 这类感觉最近记过几次（给她「你是不是又这样」的连续性）。 */
export function countFeeling(kind, days = 7, chatKey) {
  try {
    const since = Date.now() - days * 24 * 3600e3
    const rows = recentFeelings(100000, '', chatKey)
    let n = 0
    for (const r of rows) {
      if (String(r.kind ?? '') !== String(kind)) continue
      const t = Date.parse(String(r.at ?? '').replace(' ', 'T') + ':00+08:00')
      if (Number.isFinite(t) && t >= since) n += 1
    }
    return n
  } catch { return 0 }
}
