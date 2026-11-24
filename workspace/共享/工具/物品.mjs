#!/usr/bin/env node
// 物品.mjs —— 她的东西在哪儿、从哪来、什么时候要还（2026-11-05 批次75）
//
// 为什么单独一个文件：
//   资产.json 里 `包` 只是一串名字（["水杯"]），`家` 是房间里的 3D 摆件（床/书桌/台灯），
//   根本回答不了「伞在不在我手上」这个问题。要联动天气，先得有位置。
//
// 用法：
//   node 物品.mjs --看                    # 手上 / 家里 / 借的要还
//   node 物品.mjs --拿 雨伞                # 从家塞进包（人得在家）
//   node 物品.mjs --放 雨伞                # 从包放回家（人得在家）
//   node 物品.mjs --买 雨伞                # 花钱买，买完自动进包
//   node 物品.mjs --借 雨伞                # 在便利店/超市借，押金 10 块，20 小时内还
//   node 物品.mjs --还 雨伞                # 回到借的地方还，押金退回
//   node 物品.mjs --用 雨伞                # 撑开：得带在身上，而且外面在下雨
//   node 物品.mjs --到期                  # 只看有没有该还的（cron/提示用）
//   node 物品.mjs --吃 薯片               # 拿一份吃（要坐下来吃一会儿，这段人走不开）
//   node 物品.mjs --收                    # 人在家：把包里吃的喝的都放进家
//   node 物品.mjs --入 薯片 --在 包 --类 零食 --饱腹 7 --价 11   # 供 花钱.mjs 用：买了入库，不是吃掉
//
// 设计取舍：
//   · 一件东西可以有多条（自己买的伞 + 借的伞各一条），所以用数组不用 map。
//   · 「在」只有三种值：`包`（跟着她走）、`家`（放着）、某个地名（还没取）。
//   · 借的东西不能「放回家」——它不属于她，放回家就等于没还。
import { 写档 } from './_底层.mjs'
import { 加锁 } from './_锁.mjs'
// WATER 2026-11-08（批次223）：接水判据只在 水点.mjs 一份，自主行动问的是同一个。
import { 能接水 } from './水点.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
// 表口径 2026-11-07（批次156）：合并只留一份，在 表.mjs
import { 所有 } from './表.mjs'

const MEM = process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const TOOLS = '{{BOT_ROOT}}/共享/工具'
const P = path.join(MEM, '物品.json')
const ASSET = path.join(MEM, '资产.json')
const WT = path.join(MEM, '天气.json')

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const save = (p, o) => 写档(p, o)
const bj = (t = Date.now()) => new Date(t + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const args = process.argv.slice(2)
const val = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? String(args[i + 1] ?? d) : d }

// 借一把伞能借多久。不是当天必须还——她得找时间回去。
const 借期小时 = Number(process.env.ITEM_LOAN_HOURS || 20)
const 押金 = Number(process.env.ITEM_DEPOSIT || 10)
// 哪些地方能借到伞
const 借伞点 = ['便利店', '超市']
const 会下雨的伞 = ['雨伞', '折伞']

// P0 2026-11-16：物品命令整段持锁，避免两个 --入/--吃 同时读改写丢件。
// 锁顺序固定为 资产 → 物品；花钱.mjs 已经持有资产锁时，用 env 告诉子进程别再抢。
const __外部已持资产锁 = process.env.QQ_ASSET_LOCK_HELD === '1'
const __放资产锁 = __外部已持资产锁 ? () => {} : 加锁('资产.json', { strict: true, waitMs: 5000 })
process.on('exit', __放资产锁)
const __放物品锁 = 加锁('物品.json', { strict: true, waitMs: 5000 })
process.on('exit', __放物品锁)

function 读() {
  const a = load(ASSET, {})
  const 包 = (Array.isArray(a.包) ? a.包 : []).filter((x) => typeof x === 'string')
  let d = load(P, null)
  if (!d || !Array.isArray(d.items)) {
    // 第一次跑：把资产里 `包` 的东西搬过来，别让她手上的水杯凭空消失
    d = { items: 包.map((n) => ({ n, 在: '包', 来: '买' })), 建: bj() }
    save(P, d)
    return d
  }
  // 花钱.mjs 买东西只写 资产.包（它的 BUY_ROUTE），物品表里还没有——这里补上，
  // 不然刚买的伞在物品系统里查不到，等于白买。
  let 补了 = false
  for (const n of 包) {
    if (!d.items.some((x) => x.n === n)) { d.items.push({ n, 在: '包', 来: '买', 于: bj() }); 补了 = true }
  }
  if (补了) save(P, d)
  return d
}
function 存(d) {
  save(P, d)
  // 顺手把「在包里」的同步回 资产.包 —— 面板上「包里 X 件」读的是那个字段，
  // 不同步的话，伞借到了却在面板上看不见。
  try {
    const a = load(ASSET, {})
    const 手上 = d.items.filter((x) => x.在 === '包').map((x) => x.n)
    a.包 = [...new Set(手上)]
    save(ASSET, a)
  } catch { /* 同步失败不影响物品本身 */ }
}

// 份数 2026-11-06（批次144）：以前一件东西就是一个条目，买两包薯片只能塞两条同名记录，
// 看的时候分不清「两包薯片」和「同一包记了两次」。现在同名同处合成一条，用 数 记份数。
const 份数 = (x) => Math.max(1, Number(x && x.数) || 1)
// 包容量 2026-11-06（主人原话「别出现一个人身上能带50个牛奶的抽象代码」）：
// 包里按份数算总账，超过就装不下——想多拿得先回家放一批或者吃掉一份。
const 包容量 = Number(process.env.ITEM_BAG_CAP || 8)
const 包占用 = (d) => d.items.filter((x) => x.在 === '包').reduce((s, x) => s + 份数(x), 0)
const 装不下 = (d, 加 = 1) => 包占用(d) + 加 > 包容量
const 满了 = (d) => `包塞不下了（现在 ${包占用(d)}/${包容量} 份），先回家放一批或者吃掉一份`
// 吃的喝的（含零食）能进家存着；伞、杯子这类仍是「东西」，不参与「吃掉」。
const 是吃喝 = (x) => ['吃', '喝', '零食'].includes(String((x && x.类) || ''))
// 总表 2026-11-07（批次156）：吃喝穿用的口径只在 表.mjs 合并一次。
// 物品.mjs 只负责「在哪儿、几份、要不要还」，不再自己定规则、也不再自己拼表。
const 总表 = 所有()
const 在手 = (d, 名) => d.items.filter((x) => x.n === 名 && x.在 === '包')
const 某物 = (d, 名) => d.items.filter((x) => x.n === 名)
const 借的 = (d, 名) => d.items.filter((x) => x.n === 名 && x.来 === '借')
const 位置 = () => String(load(ASSET, {}).位置 || '家')
const 天气 = () => load(WT, {})
const 下雨 = () => /雨/.test(String(天气().天气 || ''))

function 到期列表(d) {
  const now = bj()
  return d.items.filter((x) => x.来 === '借' && x.该还 && String(x.该还) < now)
}

function 说(名, 条) {
  if (条.来 === '借') return `${名}（借自${条.自}，${String(条.该还 || '').slice(5)} 前要还）`
  return 名
}

// ── 接水用的三个判据（批次151）──────────────────────────
// 放在 --看 之前：--看 要报「杯子里有没有水」，const 有 TDZ，定义在后面会直接 ReferenceError。
//   ① 得有水杯，而且带在身上 —— 放家里了就不算；
//   ② 杯子里只能有一份：接了没喝就再接，等于凭空多一杯；
//   ③ 地点得接得到水。判据只有一处，别散到调用方：室内，或者有「坐/吃/喝/买/逛」这类能停下来的地方。
//      按现在的 地图.json（19 个地点）只有「打工点」接不到 —— 露天工地，没饮水。
const handsHasCup = (d) => (d.items || []).some((x) => x && x.n === '水杯' && x.在 === '包')
// 容器 2026-11-07：不再单造「一杯水」那一条，杯子自己记「装了多少、装的是什么」
const 杯里的水 = (d) => { const c = (d.items || []).find((x) => x && x.n === '水杯'); if (!c || !c.容器) return null; const 量 = Array.isArray(c.容器.成分) ? c.容器.成分.reduce((n, x) => n + (Number(x.量) || 0), 0) : Number(c.容器.装) || 0; return 量 > 0 ? c : null }
// 2026-11-08（批次223）：判据搬到 水点.mjs —— 自主行动也要问「这儿能不能接水」，
// 抄第二份必然分叉（这个项目已经栽过三次）。这里只留一个注释，别再写回来。

// ── --看 ──────────────────────────────────────────────
if (args.includes('--看') || args.length === 0) {
  const d = 读()
  const 手上 = d.items.filter((x) => x.在 === '包')
  const 家里 = d.items.filter((x) => x.在 === '家')
  const 别处 = d.items.filter((x) => x.在 !== '包' && x.在 !== '家')
  // FOOD_SEP 2026-11-06（批次144）：吃的和用的混在一行里，「包里有伞、有薯片×2、有水杯」
  // 既看不出能吃什么，也看不出家里还存着几包。分开列，份数写清楚。
  const 带名 = (x) => 说(x.n, x) + (份数(x) > 1 ? '×' + 份数(x) : '')
  // 容器 2026-11-07（主人要的写法）：水杯这种要报「0/500ml 装的是什么」
  // 容器 2026-11-07（主人要的写法）：杯里可以是混的，比如「水450ml奶50ml/500ml」
  const 装了多少 = (x) => (x.容器 && Array.isArray(x.容器.成分) ? x.容器.成分.reduce((n, c) => n + (Number(c.量) || 0), 0) : Number(x.容器 && x.容器.装) || 0)
  const 带容器 = (x) => {
    if (!x.容器) return null
    const 里 = Array.isArray(x.容器.成分) ? x.容器.成分.filter((c) => Number(c.量) > 0).map((c) => c.物 + c.量 + "ml").join("") : ""
    const 总 = 装了多少(x)
    return `${x.n}（${里 ? 里 + "/" : "0/"}${x.容器.容量}ml）${''}`
  }
  const 手上吃 = 手上.filter(是吃喝)
  const 手上用 = 手上.filter((x) => !是吃喝(x))
  const 家里吃 = 家里.filter(是吃喝)
  const 家里用 = 家里.filter((x) => !是吃喝(x))
  console.log(`人在${位置()}${下雨() ? '，外面在下雨' : ''}`)
  console.log('手上：' + (手上用.length ? 手上用.map((x) => 带容器(x) || 说(x.n, x)).join('、') : '空着'))
  if (手上吃.length) console.log('包里吃的喝的：' + 手上吃.map(带名).join('、'))
  // 水杯状态（批次151）：有杯子才提，没杯子不必占一行。
  if (handsHasCup(d)) {
    const __杯 = 杯里的水(d)
    const __量 = __杯 ? (Array.isArray(__杯.容器.成分) ? __杯.容器.成分.reduce((n, c) => n + (Number(c.量) || 0), 0) : Number(__杯.容器.装) || 0) : 0
    console.log('水杯：' + (__杯 ? '里面有 ' + __量 + '/' + (__杯.容器.容量 || 1000) + 'ml（可以加满）' : '空的（渴了可以接）'))
  }
  // DUST_MARK 2026-11-07（批次194）：在家放超过 7 天没用过的东西标「落灰」。
  // 老条目没有「于」就不硬判（别信「有时才存在」的字段）；只标注，不改变任何功能。
  const 落灰 = (x) => {
    if (x.来 === '借' || !x.于) return ''
    const t = Date.parse(String(x.于).replace(' ', 'T') + '+08:00')
    if (!Number.isFinite(t)) return ''
    return (Date.now() - t) >= 7 * 86400e3 ? '（落灰了）' : ''
  }
  console.log('家里：' + (家里用.length ? 家里用.map((x) => x.n + 落灰(x)).join('、') : '没有摆着的东西'))
  if (家里吃.length) console.log('家里存着：' + 家里吃.map(带名).join('、') + '（饿了在家可以吃）')
  if (别处.length) console.log('还放在外面：' + 别处.map((x) => x.n + '（' + x.在 + '）').join('、'))
  const 超 = 到期列表(d)
  if (超.length) console.log('⚠ 该还了：' + 超.map((x) => x.n + '（' + x.自 + '，' + String(x.该还).slice(5) + ' 到期）').join('、'))
  process.exit(0)
}

// ── --到期 ────────────────────────────────────────────
if (args.includes('--到期')) {
  const 超 = 到期列表(读())
  if (!超.length) { console.log('没有该还的'); process.exit(0) }
  for (const x of 超) console.log(`${x.n} 该还了：${x.自}，${String(x.该还).slice(0, 16)} 到期，押金 ${x.押金 || 0} 块`)
  process.exit(0)
}

// ── --入 ──────────────────────────────────────────────
// 供 花钱.mjs 用：买了东西、还没吃，收进包里（或直接放家里）。
// 不做「买了就吃」—— 那是 批次144 之前的行为，主人要的是能存着。
const 入 = val('入')
if (入) {
  const d = 读()
  const 在 = val('在', '包')
  const 类 = val('类', '零食')
  if (在 === '包' && 装不下(d, 1)) { console.log(满了(d)); process.exit(0) }
  const 有 = d.items.find((x) => x.n === 入 && x.在 === 在 && String(x.类 || '') === 类)
  if (有) 有.数 = 份数(有) + 1
  else d.items.push({
    n: 入, 在, 来: '买', 数: 1, 类,
    饱腹: Number(val('饱腹', 0)) || 0,
    临时: Number(val('临时', 0)) || 0,
    价: Number(val('价', 0)) || 0,
    于: bj(),
  })
  存(d)
  console.log(`收进${在 === '包' ? '包里' : 在}：${入}${有 ? '（现在 ' + 份数(有) + ' 份）' : ''}`)
  process.exit(0)
}

// ── --吃 ──────────────────────────────────────────────
// EAT_SLOW 2026-11-06（批次144）：吃要有过程。
// 这里只做三件事：找一份、扣库存、把「坐下来吃」交给 吃饭.mjs。
// 饱腹由 吃饭.mjs 到点结算时才加 —— 买了不等于吃了，坐下也不等于吃了。
const 吃 = val('吃')
if (吃) {
  const d = 读()
  const 位 = 位置()
  // 手上先找；人在家才拿得到家里的
  const 条 = d.items.find((x) => x.n === 吃 && x.在 === '包')
    || (位 === '家' ? d.items.find((x) => x.n === 吃 && x.在 === '家') : null)
  if (!条) {
    const 家里有 = d.items.some((x) => x.n === 吃 && x.在 === '家')
    console.log(家里有 ? `「${吃}」在家里，你人在${位}，吃不上` : `手上没有「${吃}」`)
    process.exit(0)
  }
  // 药 2026-11-08（批次224）：药不是吃的 —— 不进饱渴，只写一条药效（30~45 分钟后起效）。
  if (String(条.类 || '') === '药') {
    try {
      const m = await import('./疾病.mjs')
      const r = m.吃药(吃, Date.now())
      if (Number(条.数) > 1) 条.数 = Number(条.数) - 1
      else d.items = d.items.filter((x) => x !== 条)
      存(d)
      console.log(`吃了${吃}：${r.分钟} 分钟后起效${r.退烧 ? '（退烧）' : ''}`)
    } catch (e) { console.log('药没吃上：' + String(e.message).slice(0, 40)) }
    process.exit(0)
  }
  // 水杯 2026-11-07（主人要的 1000 毫升）：杯子是装水的容器，不是吃的东西。
  // 喝它就是把这一升灌下去，杯子还在包里，不进库存。
  if (吃 === "水杯") {
    const 杯 = d.items.find((x) => x.n === "水杯")
    const 剩 = 杯 && 杯.容器 ? (Array.isArray(杯.容器.成分) ? 杯.容器.成分.reduce((n, c) => n + (Number(c.量) || 0), 0) : Number(杯.容器.装) || 0) : 0
    if (!剩) { console.log("杯子是空的，先接点水"); process.exit(0) }
    try {
      const m = await import("./饱渴.mjs")
      const r = m.喝(剩)
      if (杯.容器) 杯.容器.成分 = []
      存(d)
      console.log("把杯里的 " + 剩 + " 毫升喝了：渴条 " + r.前 + "% → " + r.后 + "%")
    } catch (e) { console.log("喝不上：" + String(e.message).slice(0, 40)) }
    process.exit(0)
  }
  const 店 = load(path.join(TOOLS, '商店-生活.json'), { 商品: {} }).商品 || {}
  const it = 店[吃] || {}
  const 类 = String(it.类别 || 条.类 || '零食')
  const 加 = Number(it.饱腹 ?? 条.饱腹 ?? 0)
  // 喝的没有热量，只有把胃填住的临时量（主人 2026-11-06：水吸收得快）
  const 临时 = Number(it.临时饱腹 ?? 条.临时 ?? (类 === '喝' ? 12 : 0))
  // 喝的东西站着就能喝完；吃的东西得坐下来
  const 分钟 = Number(it.分钟 ?? (类 === '喝' ? 3 : 8))
  let out = ''
  try {
    out = execFileSync(process.execPath, [
      path.join(TOOLS, '吃饭.mjs'), '--开始',
      '--吃', 吃, '--在哪', 位, '--分钟', String(分钟),
      '--加', String(加), '--临时', String(临时), '--类别', 类,
    ], { encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' } }).trim()
  } catch (e) {
    console.log('没吃成：' + String(e.message).slice(0, 60))
    process.exit(0)
  }
  // RETIRE_THIRST 2026-11-14（批次434）：这里原来落一笔 记忆/喝水.json，「渴」用它算上次喝水。
  // 但 2026-11-07 主人说「身体和心情的那个渴可以退休了」，状态推进.mjs 已经 `delete b['渴']`，
  // 全仓再没有一行读它 —— **写入方留下来了、读取方没了**（批次434 审计发现的）。
  // 摘掉写入；文件本身也删了（真有一天「渴」复活，它会自己重建）。
  // 吃饭.mjs 已经在吃了、或者人还在打盹，都会拒绝 —— 这时候别扣她的库存。
  // 批次678：19:47 打盹时外卖到了，这里只认「还在吃」，食物被扣掉却一口没吃。
  if (/还在吃|还在打盹/.test(out)) { console.log(out); process.exit(0) }
  const 剩 = 份数(条) - 1
  if (剩 <= 0) d.items = d.items.filter((x) => x !== 条)
  else 条.数 = 剩
  存(d)
  // out 已经是「坐下来吃糖，大概 3 分钟（23:33 吃完）」—— 再套一层括号会变成
  // 「（23:33 吃完）（糖这份吃完了）」。改成逗号接一句。
  // VERB 2026-11-16（批次548）：`吃` 是**物品名**（`--吃 咖啡` 的参数），不是动作 ——
  // 所以这行原来对什么都写「吃完了」，咖啡就成了「咖啡这份吃完了」。
  // 物品对象有 `类`（`--入` 会写，表里咖啡是「喝」），按它选动词。
  const 动词 = String((条 && 条.类) || '') === '喝' ? '喝' : '吃'
  console.log(out + (剩 > 0 ? `，${吃}还剩 ${剩} 份` : `，${吃}这份${动词}完了`))
  process.exit(0)
}

// ── --收 ──────────────────────────────────────────────
// 背回家的一堆零食，一次放进家，不用一件一件 --放。
const 收 = args.includes('--收')
if (收) {
  const d = 读()
  const 位 = 位置()
  if (位 !== '家') { console.log(`人不在家（在${位}），先把东西背回去`); process.exit(0) }
  const 要收 = d.items.filter((x) => x.在 === '包' && 是吃喝(x))
  if (!要收.length) { console.log('包里没有能放进家的吃的'); process.exit(0) }
  for (const x of 要收) x.在 = '家'
  存(d)
  console.log('放进家了：' + 要收.map((x) => x.n + (份数(x) > 1 ? '×' + 份数(x) : '')).join('、'))
  process.exit(0)
}

// ── --拿 ──────────────────────────────────────────────
const 拿 = val('拿')
if (拿) {
  const d = 读()
  const 位 = 位置()
  if (位 !== '家') { console.log(`人不在家（在${位}），拿不到家里的东西`); process.exit(0) }
  const 条 = d.items.find((x) => x.n === 拿 && x.在 === '家')
  if (!条) { console.log(`家里没有「${拿}」`); process.exit(0) }
  if (装不下(d, 份数(条))) { console.log(满了(d)); process.exit(0) }
  条.在 = '包'
  存(d)
  console.log(`把${拿}塞进包里了`)
  process.exit(0)
}

// ── --装（批次225）────────────────────────────────────
// 把包里一瓶喝的倒进 1L 杯。主人要的「0ml（水或其他液体）/1000ml」就靠这条走：
// 杯子能装水，也能装牛奶/咖啡，成分混着记，喝的时候一起喝。
if (args.includes('--装')) {
  const 名 = val('装')
  const d = 读()
  const 瓶 = (d.items || []).find((x) => x.n === 名 && x.在 === '包')
  const 杯 = (d.items || []).find((x) => x.n === '水杯')
  if (!瓶) { console.log('包里没有「' + 名 + '」'); process.exit(0) }
  if (!杯 || 杯.在 !== '包') { console.log('水杯不在手上'); process.exit(0) }
  const 容 = Number(杯.容器 && 杯.容器.容量) || 1000
  const 成分 = Array.isArray(杯.容器 && 杯.容器.成分) ? 杯.容器.成分 : []
  const 现 = 成分.reduce((n, c) => n + (Number(c.量) || 0), 0)
  if (现 >= 容 - 1) { console.log('杯子满了，先喝掉一些'); process.exit(0) }
  const 店 = load(path.join(TOOLS, '商店-生活.json'), { 商品: {} }).商品 || {}
  const 毫升 = Number((店[名] || {}).毫升 ?? 瓶.毫升 ?? 500)
  const 倒 = Math.min(容 - 现, 毫升)
  const 同 = 成分.find((c) => c.物 === 名)
  if (同) 同.量 = Math.round((Number(同.量) + 倒) * 10) / 10
  else 成分.push({ 物: 名, 量: 倒 })
  杯.容器 = { 容量: 容, 成分 }
  if (Number(瓶.数) > 1) 瓶.数 = Number(瓶.数) - 1
  else d.items = d.items.filter((x) => x !== 瓶)
  存(d)
  console.log('把' + 名 + '倒进杯子 ' + 倒 + 'ml，杯里 ' + Math.round(现 + 倒) + '/' + 容 + 'ml')
  process.exit(0)
}

// ── --喝杯（批次223）──────────────────────────────────
// 从杯里喝掉 n 毫升（默认 300）。原来只有 `--吃 水杯`＝一口闷完一整升，
// 自主行动只能绕过杯子直接调 `饱渴 --喝`，杯子等于白设。这个是「喝一部分」的唯一入口。
if (args.includes('--喝杯')) {
  const d = 读()
  const 杯 = (d.items || []).find((x) => x.n === '水杯')
  if (!杯 || 杯.在 !== '包') { console.log('水杯不在手上'); process.exit(0) }
  const 成分 = Array.isArray(杯.容器 && 杯.容器.成分) ? 杯.容器.成分 : []
  const 有 = 成分.reduce((n, c) => n + (Number(c.量) || 0), 0)
  if (有 <= 0) { console.log('杯子是空的，先接点水'); process.exit(0) }
  const 想 = Math.max(1, Number(val('喝杯')) || 300)
  const 量 = Math.min(想, 有)
  let 剩 = 量
  for (const c of 成分) {
    if (剩 <= 0) break
    const 扣 = Math.min(Number(c.量) || 0, 剩)
    c.量 = Math.round((Number(c.量) - 扣) * 10) / 10
    剩 -= 扣
  }
  杯.容器 = { 容量: Number(杯.容器.容量) || 1000, 成分: 成分.filter((c) => Number(c.量) > 0.01) }
  存(d)
  try {
    const m = await import('./饱渴.mjs')
    const r = m.喝(量)
    console.log('从杯里喝了 ' + Math.round(量) + ' 毫升：渴条 ' + r.前 + '% → ' + r.后 + '%，杯里还剩 ' + Math.round(有 - 量) + '/' + (杯.容器.容量) + 'ml')
  } catch (e) { console.log('喝不上：' + String(e.message).slice(0, 40)) }
  process.exit(0)
}

// ── --接水（批次151）──────────────────────────────────
if (args.includes('--接水')) {
  const d = 读()
  const 位 = 位置()
  if (!handsHasCup(d)) { console.log('包里没有水杯，接不了 —— 有杯子才接得成'); process.exit(0) }
  if (!能接水(位)) { console.log(位 + '这儿没有能接水的地方'); process.exit(0) }
  const 杯 = d.items.find((x) => x.n === '水杯' && x.在 === '包')
  const 容 = Number(杯.容器 && 杯.容器.容量) || 1000
  const 已有 = Array.isArray(杯.容器 && 杯.容器.成分) ? 杯.容器.成分 : []
  const 现量 = 已有.reduce((n, c) => n + (Number(c.量) || 0), 0)
  // 2026-11-08（批次223）：原来是「有一滴水就不让接」，可杯子 1 升、一次只喝 300，
  // 剩下 700 就永远接不满 —— 改成加满（接水点本来就是补水的地方）。
  if (现量 >= 容 - 1) { console.log('杯子已经满了（' + 容 + 'ml）'); process.exit(0) }
  const 加水 = Math.max(0, 容 - 现量)
  const 水那份 = 已有.find((c) => c.物 === '水')
  if (水那份) 水那份.量 += 加水
  else 已有.push({ 物: '水', 量: 加水 })
  杯.容器 = { 容量: 容, 成分: 已有 }
  存(d)
  console.log('在' + 位 + '接了水，杯子 ' + (现量 + 加水) + '/' + 容 + 'ml')
  process.exit(0)
}

// ── --放 ──────────────────────────────────────────────
const 放 = val('放')
if (放) {
  const d = 读()
  const 位 = 位置()
  if (位 !== '家') { console.log(`人不在家（在${位}），放不回去`); process.exit(0) }
  const 条 = d.items.find((x) => x.n === 放 && x.在 === '包')
  if (!条) { console.log(`手上没有「${放}」`); process.exit(0) }
  if (条.来 === '借') { console.log(`这把${放}是跟${条.自}借的，不能放回家——要还回店里`); process.exit(0) }
  条.在 = '家'
  存(d)
  console.log(`把${放}放回家了`)
  process.exit(0)
}

// ── --买 ──────────────────────────────────────────────
const 买 = val('买')
if (买) {
  const a = load(ASSET, {})
  const before = Number(a.钱 || 0)
  let out = ''
  try {
    out = execFileSync(process.execPath, [path.join(TOOLS, '花钱.mjs'), '--买', 买], { encoding: 'utf8', timeout: 30000 }).trim()
  } catch (e) { console.log('没买成：' + String(e.message).slice(0, 60)); process.exit(0) }
  const after = Number(load(ASSET, {}).钱 || 0)
  if (after >= before) { console.log(out || '没买成'); process.exit(0) }
  const d = 读()
  if (装不下(d, 1)) { console.log(满了(d)); process.exit(0) }
  // 同一件东西已经有自己买的了，就别再塞第二条（买第二把伞没意义）
  if (!d.items.some((x) => x.n === 买 && x.来 !== '借')) d.items.push({ n: 买, 在: '包', 来: '买', 于: bj() })
  存(d)
  console.log(`${out || '买了' + 买}（已经放进包里）`)
  process.exit(0)
}

// ── --借 ──────────────────────────────────────────────
const 借 = val('借')
if (借) {
  const d = 读()
  const 位 = 位置()
  if (!借伞点.includes(位)) { console.log(`这里（${位}）借不到伞。便利店和超市才借`); process.exit(0) }
  if (装不下(d, 1)) { console.log(满了(d)); process.exit(0) }
  if (在手(d, 借).length) { console.log(`手上已经有一把${借}了`); process.exit(0) }
  if (d.items.some((x) => x.n === 借 && x.来 === '借')) { console.log(`你之前借的那把${借}还没还呢`); process.exit(0) }
  const a = load(ASSET, {})
  if (Number(a.钱 || 0) < 押金) { console.log(`押金 ${押金} 块，手上只有 ${a.钱} 块，借不了`); process.exit(0) }
  a.钱 = Number(a.钱 || 0) - 押金
  a.记录 = Array.isArray(a.记录) ? a.记录 : []
  a.记录.push({ at: bj(), what: `借${借}押金 ${押金} 块（${位}）` })
  save(ASSET, a)
  const 到 = Date.now() + 借期小时 * 3600e3
  d.items.push({ n: 借, 在: '包', 来: '借', 自: 位, 借于: bj(), 该还: bj(到), 押金 })
  存(d)
  console.log(`跟${位}借了把${借}，押了 ${押金} 块，${bj(到)} 之前还回去（押金会退）`)
  process.exit(0)
}

// ── --还 ──────────────────────────────────────────────
const 还 = val('还')
if (还) {
  const d = 读()
  const 位 = 位置()
  const 条 = 借的(d, 还).find((x) => !x.已还)
  if (!条) { console.log(`没有借过「${还}」`); process.exit(0) }
  if (条.在 !== '包') { console.log(`那把${还}不在身上（在${条.在}），先带上再还`); process.exit(0) }
  if (位 !== 条.自) { console.log(`这把${还}是跟${条.自}借的，得回${条.自}还（现在在${位}）`); process.exit(0) }
  const a = load(ASSET, {})
  const 退 = Number(条.押金 || 押金)
  // LATE_FEE 2026-11-07（批次194）：超期滞纳金——每超 24 小时扣 2 块，从押金里扣，
  // 扣完为止。原来「过点了但还是退给你了」，借伞永远不心疼（押金 10 块能白嫖五天）。
  // 24 小时内宽限：当天忘还情有可原，第二天起才算账。
  const 该还刻 = Date.parse(String(条.该还 || '').replace(' ', 'T') + '+08:00')
  const 超时小时 = Number.isFinite(该还刻) ? Math.max(0, (Date.now() - 该还刻) / 3600e3) : 0
  const 超了几天 = Math.floor(超时小时 / 24)
  const 扣 = Math.min(退, 超了几天 * 2)
  const 实退 = 退 - 扣
  a.钱 = Number(a.钱 || 0) + 实退
  a.记录 = Array.isArray(a.记录) ? a.记录 : []
  a.记录.push({ at: bj(), what: `还${还}，退回押金 ${实退} 块${扣 ? `（超 ${超了几天} 天，扣 ${扣} 块）` : ''}` })
  save(ASSET, a)
  d.items = d.items.filter((x) => x !== 条)
  存(d)
  console.log(`把${还}还回${条.自}了，押金 ${实退} 块退回${扣 ? `（超时 ${超了几天} 天，扣了 ${扣} 块）` : ''}`)
  process.exit(0)
}

// ── --用 ──────────────────────────────────────────────
const 用 = val('用')
if (用) {
  const d = 读()
  if (!在手(d, 用).length) {
    const 家里有 = d.items.some((x) => x.n === 用 && x.在 === '家')
    console.log(家里有 ? `「${用}」在家里，你人在${位置()}，用不上` : `你手上没有「${用}」`)
    process.exit(0)
  }
  if (会下雨的伞.includes(用) && !下雨()) {
    console.log(`外面没下雨（${天气().天气 || '不知道什么天'}），撑开伞有点怪`)
    process.exit(0)
  }
  if (会下雨的伞.includes(用)) {
    const w = 天气()
    console.log(`撑开${用}了。${w.话 || '雨不大'}，${w.温度 ? w.温度 + '°，' : ''}能挡一阵`)
  } else {
    console.log(`用了${用}`)
  }
  process.exit(0)
}

// ── --带伞（给 移动.mjs 的 出发 用：出门时判一次）─────────────
const 带伞去 = val('去')
if (args.includes('--带伞') && 带伞去) {
  // UMBRELLA_AUTO 2026-11-07（批次194）：出门前看天气带伞。移动.mjs 的 出发()
  // 是唯一搬人入口，它在出发时无脑调一次这里；下没下雨、伞在哪、去哪，
  // 判据全在本文件（下雨()/位置()/会下雨的伞），别处分叉。
  // 「带了伞」是系统事实（物品账+资产记录留痕），说不说、撑不撑仍归她。
  if (!下雨()) process.exit(0)
  if (String(带伞去) === '家') process.exit(0)   // 回家不用带
  const d = 读()
  if (d.items.some((x) => x.在 === '包' && 会下雨的伞.includes(x.n))) process.exit(0)  // 已经带着
  const 家里的伞 = d.items.find((x) => x.在 === '家' && 会下雨的伞.includes(x.n) && x.来 !== '借')
  if (!家里的伞 || 位置() !== '家') process.exit(0)   // 家里没伞 / 人不在家
  家里的伞.在 = '包'
  存(d)
  const a = load(ASSET, {})
  a.记录 = Array.isArray(a.记录) ? a.记录 : []
  a.记录.push({ at: bj(), what: `出门在下雨，把${家里的伞.n}带上了` })
  save(ASSET, a)
  console.log(`外面下雨，把${家里的伞.n}塞包里带上了`)
  process.exit(0)
}

console.log('用法：--看 / --拿 X / --放 X / --买 X / --借 X / --还 X / --用 X / --到期 / --带伞 --去 X')
