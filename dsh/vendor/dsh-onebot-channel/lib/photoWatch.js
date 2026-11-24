/**
 * photoWatch.js —— 照片出好了，回头叫她自己发出去。
 *
 * 2026-11-13（主人原话：「你都说了等它出来了就发我，就不要结束任务等我对话再开一轮再发给我了」）
 *
 * 病根：她说「等它出来我发你」，这回合就结束了。可照片要两三分钟才出，
 * 出来之后没有任何东西叫她 —— 只能等主人下次开口，那一轮才顺手把图发出去。
 * 于是「说了就发」变成了「等他想起来再说」。
 *
 * 这里补的就是那一格：快门一按下去就记一笔待发；每 15 秒看一眼成品目录，
 * 出来了就往她的会话里投一条情境（跟 followup / proactive 同一条路）。
 * 发不发、配什么话，仍然由她定 —— 不是替她自动发。
 *
 * 三个边界：
 *   · 只在 qq_photo 这条路上记（自主拍照不记），不然她自己拍着玩的照片也会被推出去；
 *   · 已经发过的（工具账里有 qq_send 带这张 png）就不再叫，免得她发两遍；
 *   · 二十分钟还没出来就当它没了，悄悄划掉，不拿旧图凑。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, statSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join, dirname } from 'node:path'
import { note, bjHour, bjMinutesOfDay } from './env.js'
import { deliver, pickSessionId } from './deliver.js'
import { getConfig } from './config.js'

const 记忆目录 = () => process.env.QQ_PHOTO_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`
const 相册目录 = () => process.env.QQ_PHOTO_BASE || `${QQ_WS}/共享/自拍`
const 账本 = () => process.env.TOOL_LOG || `${QQ_WS}/记忆/工具调用.jsonl`

// 15 秒看一眼：出图是两三分钟的事，慢了会让她在「刚出好」和「叫醒她」之间空太久。
const 间隔 = 15 * 1000
// 二十分钟还没出图，多半是那边卡死了，别一直惦记着。
const 等最久 = 20 * 60 * 1000
const 最多记 = 10

const 读档 = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
// ATOMIC：先写临时文件再改名，跟 photo.js 一个规矩
const 存档 = (p, o) => {
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tmp, JSON.stringify(o, null, 2))
    renameSync(tmp, p)
    return true
  } catch (e) { note('photo', '待发照片写盘失败：' + (e instanceof Error ? e.message : e)); return false }
}

const 待发档 = (mem) => join(mem, '待发照片.json')

/** 待发列表。脏条目直接滤掉，别让一条坏数据把整条提醒链卡死。 */
export function 待发列表(mem = 记忆目录()) {
  const j = 读档(待发档(mem), { items: [] })
  return (Array.isArray(j.items) ? j.items : [])
    .filter((x) => x && /^[0-9a-z]{6,32}$/.test(String(x.id ?? '')) && String(x?.target?.id ?? '') !== '')
}

function 写待发(mem, items) { return 存档(待发档(mem), { items: items.slice(-最多记) }) }

/**
 * 快门按下去时记一笔：这张还没出来，出来要叫她。
 * @param {{id:string, target:{kind:string,id:string}, at?:number, 话?:string, 主体?:string, 机位?:string}} 条
 */
export function 记下待发(条, mem = 记忆目录()) {
  const id = String(条?.id ?? '').trim()
  if (!/^[0-9a-z]{6,32}$/.test(id)) return false
  const target = 条?.target
  if (!target || String(target.id ?? '') === '') return false
  const items = 待发列表(mem).filter((x) => String(x.id) !== id)
  items.push({
    id,
    target: { kind: String(target.kind ?? 'private'), id: String(target.id) },
    at: Number(条?.at) || Date.now(),
    话: String(条?.话 ?? '').trim().slice(0, 60),
    主体: String(条?.主体 ?? '').trim(),
    机位: String(条?.机位 ?? '').trim(),
  })
  return 写待发(mem, items)
}

// 死导出清理 2026-11-14（批次409）：这里原来有个 export function 划掉待发(id)，
// 全仓 grep 一次都没被调用 —— 内部真正在用的是下面 看一遍() 里的 写待发(mem, 留)（批量删）。
// 单个删的能力留着只会让「死导出」这条判据一直亮着，真出问题时反而不看了。

const 两位 = (n) => String(n).padStart(2, '0')
const 钟点 = (at) => 两位(bjHour(at)) + ':' + 两位(bjMinutesOfDay(at) % 60)

/**
 * 这张图她已经发出去了吗？
 * 判据：工具账里快门之后有一条成功的 qq_send，参数里带这张 png。
 * 宁可漏判（多叫一次）也不误判成「发过了」（那图就永远发不出去）。
 */
function 已发过(条, opt = {}) {
  const 图 = String(条.id) + '.png'
  const 起 = Number(条.at) || 0
  let 全 = ''
  try { 全 = readFileSync(opt.log || 账本(), 'utf8') } catch { return false }
  const 行 = 全.split('\n')
  for (let i = 行.length - 1; i >= 0; i -= 1) {
    const s = 行[i]
    if (s === '' || s.indexOf(图) < 0) continue
    let j = null
    try { j = JSON.parse(s) } catch { continue }
    if (String(j?.tool ?? '') !== 'qq_send' || j?.ok !== true) continue
    const t = Date.parse(String(j.at ?? '').replace(' ', 'T') + '+08:00')
    if (!Number.isFinite(t) || t < 起) continue
    return true
  }
  return false
}

/** 投一条情境给她。跟 followup 同一条路：不是替她发，是叫她回来自己看一眼。 */
async function 投情境(ctx, 条, 形态, opt = {}) {
  if (opt.dryRun === true) {
    note('[照片到货] 演练：' + 条.id + '（' + 形态 + '）→ ' + 条.target.kind + ':' + 条.target.id)
    return true
  }
  const target = { kind: String(条.target.kind ?? 'private'), id: String(条.target.id) }
  let sessionId = ''
  try { sessionId = pickSessionId(getConfig(), target.kind, target.id) } catch { sessionId = '' }
  if (sessionId === '') {
    note('[照片到货] 这个目标没配会话，跳过 key=' + target.kind + ':' + target.id)
    return false
  }
  const 路 = join(opt.base || 相册目录(), '成品', 条.id + '.png')
  const 话 = String(条.话 ?? '').trim()
  const text = 形态 === '成'
    ? '（照片：你 ' + 钟点(Number(条.at) || Date.now()) + ' 按的那张快门出好了 —— 成品在 ' + 路
      + (话 !== '' ? '，你当时配的话是「' + 话 + '」' : '')
      + '。你当时说了等它出来就发给他，现在正是时候：要发就用 qq_send 的 images 填这个路径，'
      + '配的话你自己写；不想发就 qq_pass，没人催你。）'
    : '（照片：你 ' + 钟点(Number(条.at) || Date.now()) + ' 按的那张快门没出来（出图那边失败了）。'
      + '手边最新那张是旧的，别当刚拍的发给他。）'
  try {
    const used = await deliver(ctx, sessionId, text, target, undefined, { proactive: true, sourceKind: 'nudge' })
    if (!used) { note('[照片到货] 投递没成功 id=' + 条.id); return false }
    note('[照片到货] 已叫她 id=' + 条.id + '（' + 形态 + '）→ ' + used)
    return true
  } catch (e) {
    note('[照片到货] 投递抛错：' + String((e && e.message) || e))
    return false
  }
}

/**
 * 看一遍待发清单。返回 {看过, 动了, 剩} —— 有数才看得出这条链到底动没动。
 */
export async function 看一遍(ctx, opt = {}) {
  const mem = opt.mem || 记忆目录()
  const base = opt.base || 相册目录()
  const now = Number(opt.now) || Date.now()
  const 投 = typeof opt.投 === 'function' ? opt.投 : 投情境
  const items = 待发列表(mem)
  if (items.length === 0) return { 看过: 0, 动了: 0, 剩: 0 }

  const 留 = []
  let 动 = 0
  for (const 条 of items) {
    const png = join(base, '成品', 条.id + '.png')
    const 败 = join(base, '失败', 条.id + '.json')
    if (existsSync(png)) {
      if (已发过(条, opt)) { 动 += 1; continue }
      if (await 投(ctx, 条, '成', { ...opt, base })) { 动 += 1; continue }
      留.push(条)
      continue
    }
    if (existsSync(败)) {
      if (await 投(ctx, 条, '败', { ...opt, base })) { 动 += 1; continue }
      留.push(条)
      continue
    }
    const age = now - Number(条.at || 0)
    if (age > 等最久) {
      note('[照片到货] ' + 条.id + ' 等了 ' + Math.round(age / 60000) + ' 分钟还没出图，先不惦记了')
      动 += 1
      continue
    }
    留.push(条)
  }
  if (动 > 0) 写待发(mem, 留)
  return { 看过: items.length, 动了: 动, 剩: 留.length }
}

/** 起一个常驻的钟。返回停止函数，跟别的循环一样挂在 ctx.effect 里。 */
export function startPhotoWatch(ctx, opt = {}) {
  const 一遍 = () => {
    void 看一遍(ctx, opt).catch((e) => note('[照片到货] 看一遍抛错：' + String((e && e.message) || e)))
  }
  const timer = setInterval(一遍, Number(opt.intervalMs) || 间隔)
  if (typeof timer.unref === 'function') timer.unref()
  const first = setTimeout(一遍, 8000)
  if (typeof first.unref === 'function') first.unref()
  note('[照片到货] 已启动，每 ' + Math.round((Number(opt.intervalMs) || 间隔) / 1000) + ' 秒看一眼')
  return () => { clearInterval(timer); clearTimeout(first) }
}
