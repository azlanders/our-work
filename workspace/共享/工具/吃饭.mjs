// 吃饭.mjs —— 坐下来吃一顿是要花时间的（2026-11-06 批次144，主人要求）
//
// 为什么单独一份：
//   在这之前「吃」是瞬时的：花钱.mjs 扣钱那一秒饱腹就加上去了，
//   她 02:00 在火锅店点完单就走人，账上已经「吃过了」，还能接着逛。
//   主人要的是两件事：
//     ① 饭店的饭在店里吃完再走；
//     ② 吃饭要有时间 —— 毕竟得坐在那儿吃。
//   所以把「吃」拆成两段：买（扣钱、点单）→ 坐一会儿（这段时间人走不开）→ 吃完（饱腹才加）。
//
// 跟 洗澡.mjs 同一个模式：
//   · 状态写 记忆/吃饭.json（开始 / 到 / 吃啥 / 在哪 / 加多少）；
//   · 到点由 cron --tick 结算，进程挂了也能算（读的是写死的时间，不是内存）；
//   · 吃饭期间 自主行动 / 缺口 / qq_go 都不搬她，守卫在各处，不在这里替别人做决定。
//
// 饱腹**只在结算时**加。这是这一批的重点：买了不等于吃了。
//
// 用法：
//   node 吃饭.mjs --开始 --吃 火锅 [--在哪 餐厅] [--分钟 55] [--加 58] [--类别 吃]
//   node 吃饭.mjs --tick        # 到点了就结算（cron 每 5 分钟）
//   node 吃饭.mjs --完          # 提前吃完（按现在结算）
//   node 吃饭.mjs --看          # 在不在吃、还有多久
import { 吃喝动词 } from './在干嘛.mjs'
import { 改档 } from './_底层.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import * as 饥饿 from './饥饿.mjs'
import { 改 as 改自主, 起 as 起自主 } from './自主状态.mjs'
import * as 饱渴 from './饱渴.mjs'

// 批次609：工作区根目录允许 env 覆盖，测试才能不碰线上 记忆 / 花钱.mjs。
const DIR = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
// SANDBOX：跟别的脚本同一套变量名，测试才不会写脏她真实的肚子和状态
const 今天 = (ms = Date.now()) => bj(ms).slice(0, 10)
const MEM = process.env.HUNGER_MEM || process.env.GAP_MEM || process.env.QQ_ACT_MEM
  || process.env.QQ_AUTONOMY_MEM || path.join(DIR, '记忆')
const FILE = path.join(MEM, '吃饭.json')
const AU = path.join(MEM, '自主.json')
const AS = path.join(MEM, '资产.json')

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
// 项目约定：存北京墙上时间，不带秒的补秒，带秒的别再补
const 解析 = (s) => {
  const x = String(s || '').trim().slice(0, 19).replace(' ', 'T')
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(x)) return 0
  const t = Date.parse((x.length === 16 ? x + ':00' : x) + '+08:00')
  return Number.isFinite(t) ? t : 0
}
const args = process.argv.slice(2)
// cron 每 5 分钟跑一次 --tick，没在吃的时候不该每 5 分钟往日志里写一句「没在吃东西」。
const QUIET = args.includes('--quiet')
const val = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? String(args[i + 1] ?? d) : d }
const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n) || 0))

function 记一笔(what) {
  try {
    // 批次578（P0-2 残留）：改档 在资产锁内读改写，别拿启动时的旧副本整档覆盖。
    改档(AS, (a) => {
      a.记录 = Array.isArray(a.记录) ? a.记录 : []
      a.记录.push({ at: bj(), what })
      if (a.记录.length > 200) a.记录 = a.记录.slice(-200)
    }, { 记录: [] })
  } catch (e) {
    console.error('吃饭记账失败：' + String((e && e.message) || e).slice(0, 80))
  }
}

// 吃饭也是「占用型」状态：跟洗澡一样把 自主.json 对齐，
// 不然面板和对话侧还挂在她坐下来之前那件事上（「摸鱼」挂一小时）。
// DRINK_WORD 2026-11-08（批次272）：喝东西不能记成「吃了水」。
// 主人原话「饮品不要用吃来表达」。类别从 --开始 的 --类别 传下来（'喝' / '吃'）。
function 记自主(结束, 吃啥, 在哪, 分钟, 类别 = '') {
  try {
    // 批次169：锁外读改写 → 起自主（锁内 + 原子写）。
    // 原来文件不在就 return —— 保留，别在数据目录被清空时凭空造一份状态。
    if (!fs.existsSync(AU)) return
    起自主(MEM, {
      state: '吃饭',
      form: '线下',
      place: String(在哪 || ''),
      doneAt: Number(结束) || 0,
      last: { at: bj(), what: '吃饭', note: `在${在哪}${String(类别) === '喝' ? '喝了' : '吃了'}${吃啥}（${分钟} 分钟）`, feel: '', feelKind: '' },
    })
  } catch { /* 写不进去不影响吃饭本身 */ }
}

function 结算(说明 = '') {
  const 饭 = load(FILE, null)
  if (!饭) return ''
  const 加 = Math.max(0, Number(饭.加) || 0)
  let 后 = 0
  try {
    // 价传 0：钱在买的那一刻已经扣过、也记过账了，这里再记一次就是双份
    // 2026-11-07 分分钟：tick 已经按分钟喂过几成，结算只补剩下那一截，别再整份加一遍
    const 剩 = Math.max(0, 1 - Number(饭.已给 || 0))
    let r = null
    if ( Number(饭.已给 || 0) > 0 && 饭.吃啥) {
      if (剩 > 1e-6) { try { r = 饱渴.吃部分(饭.吃啥, 剩) } catch { r = null } }
      else { r = { 后: 饱渴.读().卡百分比 } }
      // 同步更新 饥饿.json 的今日顿数与最后进食时刻（不二次加卡路里）！
      try { 饥饿.记一顿({ 名: 饭.吃啥, 类别: 饭.类别 || '吃', 价: 0 }) } catch (_err) { console.error('[吃饭]', _err?.message || _err) }
    } else {
      r = 饥饿.吃({ 名: 饭.吃啥, 加, 临时加: Math.max(0, Number(饭.临时) || 0), 价: 0, 类别: 饭.类别 || '吃' })
    }
    后 = Math.round((Number(r?.后 || 饱渴.读().卡百分比 || 0) + Number(r?.临时 || 0)) * 10) / 10
  } catch { /* 饥饿账坏了也要把状态清掉，不然她永远在吃饭 */ }
  // 困意/情绪/激素等真吃到嘴里才生效（批次144 把「买」和「吃」拆开了）。
  // 规则只在 花钱.mjs 的 上效果() 里有一份，这里只是回去调它，不另抄一遍。
  try {
    execFileSync(process.execPath, [path.join(DIR, '共享/工具', '花钱.mjs'), '--生效', 饭.吃啥, '--事件ID', 饭.激素事件ID || ('meal:' + 饭.开始 + ':' + 饭.吃啥)],
      { encoding: 'utf8', timeout: 10000 })
  } catch { /* 效果没记上不影响吃完这件事 */ }
  const 喝 = String(饭.类别 || '') === '喝'
  记一笔(`在${饭.在哪 || '家'}${喝 ? '喝了' : '吃了'}${饭.吃啥}`)
  try { fs.unlinkSync(FILE) } catch { /* 已经没了 */ }
  // 吃完了，该挑下一件事了。跟 走路 --到 的写法一致：只放行 nextAt，不替她定做什么。
  try {
    // 批次169：原来不管 state 是什么都整份 save —— 她刚洗完澡、刚打完卡，
    // 就被这份「吃完了」的旧副本整份盖回去。现在锁内只放行 nextAt。
    改自主(MEM, (aut) => {
      if (String(aut.state || '') !== '吃饭') return false
      aut.nextAt = Date.now()
    })
  } catch { /* 同步失败不影响吃完 */ }
  return `${喝 ? '喝完了' : '吃完了'}${饭.吃啥 ? '（' + 饭.吃啥 + '）' : ''}，饱腹 ${后}/100${说明 ? ' · ' + 说明 : ''}`
}

// ── --看 ────────────────────────────────────────────────
if (args.includes('--看') || args.length === 0) {
  const 饭 = load(FILE, null)
  if (!饭) { console.log('这会儿没在吃东西'); process.exit(0) }
  const 剩 = Math.max(0, Math.ceil((解析(饭.到) - Date.now()) / 60e3))
  const 喝中 = String(饭.类别 || '') === '喝'
  console.log(`正在${饭.在哪 || '家'}${喝中 ? '喝' : '吃'}${饭.吃啥}，还有 ${剩} 分钟（${饭.到} ${喝中 ? '喝完' : '吃完'}）`)
  console.log('这段时间她走不开 —— 得在这儿待着')
  process.exit(0)
}

// ── --tick ──────────────────────────────────────────────
if (args.includes('--tick')) {
  const 饭 = load(FILE, null)
  if (!饭) { if (!QUIET) console.log('没在吃东西'); process.exit(0) }
  // 分分钟：开到这会儿该给几成，只补「还没给的那一截」——吃饱不是最后一口才发生的
  try {
    let 结果 = null
    // 批次609：锁内重读「这一顿」，别拿启动时的旧副本整档写回。
    // 到点后直接不写：结算会删档，这里再写会把「吃完」复活成「还在吃」。
    改档(FILE, (饭2) => {
      if (!饭2 || typeof 饭2 !== 'object') return false
      const 到T = 解析(饭2.到)
      if (!到T || Date.now() >= 到T) return false
      const 起 = 解析(饭2.开始) || Date.now()
      const 总 = Math.max(1, Number(饭2.分钟) || 1)
      const 已过 = Math.max(0, (Math.min(Date.now(), 到T) - 起) / 60e3)
      const 应给 = Math.min(1, 已过 / 总)
      const 已给 = Number(饭2.已给 || 0)
      if (!(应给 > 已给 + 1e-6)) return false
      const r = 饱渴.吃部分(饭2.吃啥, 应给 - 已给)
      饭2.已给 = 应给
      结果 = { 已过, r }
    }, null)
    // CACHE_REFRESH 2026-11-17（批次677）：分分钟结算也改饱腹，缓存要跟着走；
    // 放在 吃饭.json 的锁外，避免嵌套锁。
    if (结果) {
      try { 饥饿.刷新饱腹() } catch { /* 缓存刷不上不影响吃饭 */ }
    }
    if (结果 && !QUIET) console.log(`吃了 ${Math.round(结果.已过)} 分钟：卡路里 +${结果.r ? 结果.r.kcal : 0}，饱腹感 ${结果.r ? 结果.r.后 : '?'}%`)
  } catch (e) { /* 分钟级结算坏掉也不影响吃完那一步 */ }
  const 到 = 解析(饭.到)
  if (到 && Date.now() < 到) {
    if (!QUIET) console.log(`还在${吃喝动词(饭.吃啥)}${饭.吃啥}，剩 ${Math.ceil((到 - Date.now()) / 60e3)} 分钟`)
    process.exit(0)
  }
  console.log(结算('到点了'))
  process.exit(0)
}

// ── --完 ────────────────────────────────────────────────
if (args.includes('--完')) {
  console.log(结算('提前吃完') || '这会儿没在吃')
  process.exit(0)
}

// ── --开始 ──────────────────────────────────────────────
if (args.includes('--开始')) {
  const 现有 = load(FILE, null)
  if (现有 && 解析(现有.到) > Date.now()) {
    console.log(`还在${吃喝动词(现有.吃啥)}${现有.吃啥}（还有 ${Math.ceil((解析(现有.到) - Date.now()) / 60e3)} 分钟），${吃喝动词(现有.吃啥)}完再说`)
    process.exit(0)
  }
  // SLEEP_WINS 2026-11-17（批次678）：人已经躺下打盹时不能同时开饭。
  // 19:47 实测：打盹刚写进 自主.json（state=打瞌睡、doneAt=20:32），同一分钟外卖到了，
  // 走 物品.mjs → 这里 --开始，把 state 改成「吃饭」、doneAt 改成 20:12，
  // note 还留着「眯 45 分钟，20:32 醒」—— 三条互相矛盾。她把这顿 25 分钟的饭
  // 和 45 分钟的盹都说成已经发生，跟主人讲「八点半才醒、点了顿饱饭」。
  // 判据只有一份：自主.json 的 state=打瞌睡 且 doneAt 还没到。醒了再吃，食物留在库存里。
  {
    const 自 = load(AU, null)
    const 盹到 = Number((自 && 自.doneAt) || 0)
    if (自 && String(自.state || '') === '打瞌睡' && 盹到 > Date.now()) {
      const 点 = bj(盹到).slice(11)
      console.log(`还在打盹（${点} 醒），醒了再吃`)
      process.exit(0)
    }
  }
  const 吃啥 = val('吃') || val('名') || '点东西'
  // 一日三餐 2026-11-07（主人原话「别整天一天吃十多顿饭」）：正餐一天最多 4 顿，
  // 上一顿不到 90 分钟也不许再来一顿正餐；水、零食不受限。
  // 批次610 对齐：注释原来写「3 顿 / 120 分钟」，代码一直是 4 顿 / 90 分钟。
  // 先按线上实际口径改注释，要不要收紧到 3 顿 / 120 分钟等主人拍板。
  {
    const 类别0 = String(val('类别', '吃'))
    // 记账在 饥饿.json（饥饿.吃 写的），不是 吃饭.json（那个只存当前这一顿）
    const 记账 = load(path.join(MEM, '饥饿.json'), {})
    const 今 = 记账.今天 && 记账.今天.日期 === 今天(Date.now()) ? 记账.今天 : { 顿: 0 }
    const 上一顿 = 解析(记账.最后吃At || '') || 0
    if (类别0 === '吃' && Number(今.顿 || 0) >= 4) {
      console.log(`今天正餐吃够了（第 ${今.顿} 顿），别再塞了`)
      process.exit(0)
    }
    if (类别0 === '吃' && 上一顿 && Date.now() - 上一顿 < 90 * 60e3) {
      console.log(`一个半小时内才吃过，这会儿先别吃正餐`)
      process.exit(0)
    }
  }
  const 在哪 = val('在哪') || String(load(AS, {}).位置 || '家')
  const 类别 = val('类别', '吃')
  const 加 = Math.max(0, Number(val('加', 0)) || 0)
  // 临时饱腹：水和汤只把胃填一会儿，结算时单独记一笔，掉得比饭快
  const 临时 = Math.max(0, Number(val('临时', 0)) || 0)
  // 分钟由调用方从 商店-生活.json 的 分钟 字段传进来；没传就按「随便吃点」20 分钟
  const 分钟 = Math.round(clamp(val('分钟', 20), 1, 120))
  const 结束 = Date.now() + 分钟 * 60e3
  const 激素事件ID = val('激素事件ID') || ('meal:' + Date.now() + ':' + process.pid + ':' + Math.random().toString(36).slice(2, 8))
  const 新饭 = {
    开始: bj(), 到: bj(结束), 吃啥, 在哪, 加, 临时, 类别, 分钟, 已给: 0, 激素事件ID,
  }
  // 批次609：锁内再确认一次「没人在吃」，两个进程同时 --开始 时只有一个占得上。
  let 占上 = false
  改档(FILE, (现有2) => {
    if (现有2 && 解析(现有2.到) > Date.now()) return false
    Object.assign(现有2, 新饭)
    占上 = true
  }, {})
  if (!占上) {
    const 现 = load(FILE, null) || {}
    console.log(`还在${吃喝动词(现.吃啥 || '吃')}${现.吃啥 || '东西'}（还有 ${Math.max(0, Math.ceil((解析(现.到) - Date.now()) / 60e3))} 分钟），${吃喝动词(现.吃啥 || '吃')}完再说`)
    process.exit(0)
  }
  记自主(结束, 吃啥, 在哪, 分钟, 类别)
  // 只报几点几分：调用方（物品.mjs / 缺口.mjs）会把这句话拼进自己的日志，
  // 带完整日期会变成「（2026-11-06 23:33 吃完）」这种读不下去的长括号。
  // 喝的不用坐：水站着两口就完，也没有「吃完」这一说。
  const 是喝 = String(类别) === '喝'
  console.log(是喝
    ? `喝${吃啥}，大概 ${分钟} 分钟（${bj(结束).slice(11)} 喝完）`
    : `坐下来${吃喝动词(吃啥)}${吃啥}，大概 ${分钟} 分钟（${bj(结束).slice(11)} ${吃喝动词(吃啥)}完）`)
  process.exit(0)
}

console.log('用法：--开始 --吃 火锅 [--在哪 餐厅] [--分钟 55] [--加 58] / --tick / --完 / --看')
