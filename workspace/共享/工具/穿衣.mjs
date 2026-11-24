// 穿衣.mjs —— 按部位算身上这套衣服能挡多少冷（2026-11-07，照主人说的「参考僵尸毁灭工程」）
//
// 每件衣服三样：保暖（度）、防风（0~1）、湿了还剩几成。
// 五个部位（头、上身、手、腿、脚）各算一份，露着的部位记 0。
// 湿身会按「湿了」那栏打折；风大按防风值兜回来，兜不住的照扣。
//
// 用法：
//   node 穿衣.mjs --看             # 现在穿着什么、每个部位多少
//   node 穿衣.mjs --加 毛衣开衫     # 穿上
//   node 穿衣.mjs --脱 毛衣开衫     # 脱掉
import { 写档, 改档 } from './_底层.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const MEM = process.env.CLOTH_MEM || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
// 衣物表 2026-11-07：衣服从物品总表分出来了，单独一张 衣物表.json（带标签：短袖/长袖/外套/裙子短中长…）
const 表P = path.join(MEM, '衣物表.json')
const 旧总表P = path.join(MEM, '物品总表.json')
const 穿P = path.join(MEM, '穿着.json')
const 资产P = path.join(MEM, '资产.json')
// WARM_GAP 2026-11-14（批次403）：这份是「明天需要多少保暖、现在这身差多少」，不是穿着账。
const 差P = path.join(MEM, '穿衣差额.json')

// 九部位 2026-11-07（主人：「现在是15个部位了」——虚影上左右各一份，名字还是九个）：
// 一件衣服用「覆盖」记它能盖哪几格；老表里只写了 上身/腿 的，按老规矩摊开。
// 脖子 2026-11-07（主人：「再给身体加个部位 脖子」）：插在头后面，正好十格。
export const 九部位 = ["头", "脖子", "上臂", "下臂", "手", "上身", "下身", "大腿", "小腿", "脚"]
const 老映射 = { 上身: ["上身", "上臂", "下臂"], 腿: ["下身", "大腿", "小腿"], 头: ["头"], 手: ["手"], 脚: ["脚"] }
// 覆盖两种写法：["上身","上臂"] 或 {"上身":1,"上臂":0.8}（后者带折扣，短袖盖不到小臂就这么写）
export const 覆盖们 = (部) => {
  if (Array.isArray(部)) return 部.filter((x) => 九部位.includes(x))
  if (部 && typeof 部 === "object") return Object.keys(部).filter((x) => 九部位.includes(x))
  const k = String(部 || "")
  if (老映射[k]) return 老映射[k]
  return 九部位.includes(k) ? [k] : []
}
// 这件衣服在某一格能算几成；对象写法里小的那档就叫盖不到
const 几成 = (it, 部) => {
  const g = it.覆盖
  if (g && !Array.isArray(g) && typeof g === "object") return Number(g[部] ?? 0)
  return 1
}

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const save = (p, o) => 写档(p, o)
const 外观表 = () => load(process.env.CLOTH_ASSET_TABLE || path.join(path.dirname(fileURLToPath(import.meta.url)), '服装表.json'), {})
function 同步资产着装(d) {
  const 表 = 外观表()
  const 槽部位 = { 上: '上身', 下: '下身', 鞋: '脚' }
  改档(资产P, (a) => {
    a.着装 = a.着装 && typeof a.着装 === 'object' ? a.着装 : { 上: '', 下: '', 鞋: '', 饰: [] }
    for (const [槽, 部位] of Object.entries(槽部位)) {
      const 件 = (d.部位[部位] || []).filter((名) => 表[名]?.类别 === 槽)
      a.着装[槽] = 件.at(-1) || ''
    }
    const 饰 = []
    for (const 件 of Object.values(d.部位)) for (const 名 of 件 || []) {
      if (表[名]?.类别 === '饰' && !饰.includes(名)) 饰.push(名)
    }
    a.着装.饰 = 饰
    return a
  })
}

// 穿着：{ 部位: { 头: [...], 上臂: [...], ... } }，九个部位各一串。
// 老数据是五个部位（头/上身/手/腿/脚），第一次跑时按老规矩摊开；
// 资产.着装 那种更老的一串名字也一并搬过来。
const 空穿着 = () => ({ 部位: Object.fromEntries(九部位.map((部) => [部, []])) })

export function 读穿着() {
  let d = load(穿P, null)
  if (!d || !d.部位) {
    const a = load(资产P, {})
    const 装 = a.着装 || {}
    const 身上 = [装.上, 装.下, 装.鞋, ...(Array.isArray(装.饰) ? 装.饰 : [])].filter((x) => typeof x === "string" && x)
    d = 空穿着()
    const 表 = 平表()
    for (const n of 身上) {
      const it = 表[n] && 表[n].穿
      if (!it) continue
      for (const 部 of 覆盖们(it.覆盖 || it.部位)) d.部位[部].push(n)
    }
    save(穿P, d)
    return d
  }
  // 一律按「这件能盖哪几格」重新摆一遍：穿着记录里只留名字，格子由表说了算
  const 表 = 平表()
  const 身上 = new Set()
  for (const 件 of Object.values(d.部位)) for (const n of 件 || []) 身上.add(n)
  const 新d = 空穿着()
  for (const n of 身上) {
    const it = 表[n] && 表[n].穿
    const 盖 = it ? 覆盖们(it.覆盖 || it.部位) : []
    if (!盖.length) continue
    for (const 部 of 盖) 新d.部位[部].push(n)
  }
  // 2026-11-07 护栏：表一时读不到（换表、搬文件）时，重摆会把一身衣服全清空。
  // 少了名字就不许写盘 —— 宁可留着旧的，也别让她忽然光着。
  let 少 = 0
  for (const n of 身上) if (!(表[n] && 表[n].穿)) 少++
  if (少 > 0) return d
  const 变了 = 九部位.some((部) => JSON.stringify(d.部位[部] || []) !== JSON.stringify(新d.部位[部])) ||
    Object.keys(d.部位).some((部) => !九部位.includes(部))
  if (变了) { save(穿P, 新d); return 新d }
  return d
}

function 平表() {
  const 新 = load(表P, {})
  if (新 && 新.件) return 新.件
  // 兜底：还没搬的时候读旧总表
  const 旧 = load(旧总表P, {})
  const 平 = {}
  if (旧 && 旧.条) Object.assign(平, 旧.条)
  const 分 = (旧 && 旧.分组 && 旧.分组.穿) || null
  if (分) for (const 组 of Object.values(分)) for (const [n, v] of Object.entries(组 || {})) 平[n] = v
  for (const [n, v] of Object.entries(平)) if (v && v.穿 && !v.穿.覆盖) v.穿.覆盖 = 覆盖们(v.穿.部位)
  return 平
}

// 湿的程度 0~1，风 0~1（外面风大时由天气给），都从外面传进来，自己不去读天气
// 身体面积权重：喂体温用。总和必须是 1（契约检查.mjs 会验）。
// 加了脖子就得分面积：从「头」和「上身」各匀 0.01 给脖子。
export const 权重 = { 头: 0.12, 脖子: 0.02, 上臂: 0.12, 下臂: 0.08, 手: 0.04, 上身: 0.24, 下身: 0.18, 大腿: 0.08, 小腿: 0.07, 脚: 0.05 }

// 快照 2026-11-07（批次163）：一次把「每格暖多少、整体加权、九区」全算出来。
// 面板原来连着调 算() 和 九区()，同一个表、同一身衣服读两遍；九区 只是把 暖 抄一遍。
export function 快照({ 湿 = 0, 风 = 0 } = {}) {
  const 表 = 平表()
  const 穿着 = 读穿着()
  const 部位结果 = {}
  for (const 部 of 九部位) {
    const 件 = 穿着.部位[部] || []
    // WIND 2026-11-07（批次162）：防风不再是「取最厚那层」，是各层漏风的乘积。
    // 原来 Math.max 让吊带背心的 0.4 顶掉外面棉衣的 0.8 —— 内层白给整份挡风。
    // 现在每层按「在这格盖了几成」打折，透风量相乘：1 - Π(1 - 防风×几成)。
    let 透风 = 1
    const 各层 = []
    for (const n of 件) {
      const it = 表[n] && 表[n].穿
      if (!it) continue
      const 湿损 = 1 - (1 - Number(it.湿了 ?? 0.5)) * 湿
      const 盖 = 几成(it, 部)
      各层.push(Number(it.保暖 || 0) * 湿损 * 盖)
      透风 *= 1 - Math.min(1, Math.max(0, Number(it.防风 || 0))) * 盖
    }
    const 防风 = 1 - 透风
    // 同一格穿两层不是简单相加（毛衣叠棉衣没有两倍暖）：从厚到薄按 1 / 0.5 / 0.25 递减
    const 递减 = [1, 0.5, 0.25, 0.12]
    let 暖 = 0
    各层.sort((a, b) => b - a)
    各层.forEach((v, i) => { if (v > 0) 暖 += v * (递减[i] ?? 0.06) })
    const 风损 = 1 - 风 * (1 - 防风)
    部位结果[部] = {
      件,
      暖: 件.length ? Math.round(暖 * 风损 * 10) / 10 : -1,
      防风: Math.round(防风 * 10) / 10,
      露着: 件.length === 0,
    }
  }
  // 2026-11-07 主人点出来「保暖应该是分部位保暖的」：不再出一个合计数，
  // 只按身体面积加权（喂体温用），再单列最薄的和露着的。
  let 加权 = 0
  for (const 部 of 九部位) 加权 += 部位结果[部].暖 * 权重[部]
  const 排序 = Object.entries(部位结果).sort((a, b) => a[1].暖 - b[1].暖)
  const 区 = {}
  for (const 部 of 九部位) 区[部] = 部位结果[部].暖
  return {
    部位: 部位结果,
    加权: Math.round(加权 * 10) / 10,
    最薄: 排序[0] ? 排序[0][0] : "—",
    露着: 排序.filter(([, v]) => v.露着).map(([k]) => k),
    区,
  }
}

// 算 / 九区 都是快照的视图：一个要「每格暖多少」，一个要「九区」。
// 以前是两次独立计算，现在同一次结果切两刀 —— 想改算法只改 快照 一处。
export const 算 = (opt = {}) => {
  const s = 快照(opt)
  return { 部位: s.部位, 加权: s.加权, 最薄: s.最薄, 露着: s.露着 }
}
export const 九区 = (opt = {}) => {
  const s = 快照(opt)
  return { 区: s.区, 加权: s.加权, 最薄: s.最薄, 露着: s.露着 }
}

export function 穿(名) {
  const 表 = 平表()
  const 条 = 表[名]
  const it = 条 && 条.穿
  if (!it) return `表里没有「${名}」或它不是衣服`
  const 盖 = it.覆盖 && it.覆盖.length ? it.覆盖 : 覆盖们(it.部位)
  if (!盖.length) return `「${名}」没写能盖哪几格`
  const d = 读穿着()
  for (const 部 of 盖) if (d.部位[部] && !d.部位[部].includes(名)) d.部位[部].push(名)
  save(穿P, d)
  同步资产着装(d)
  return `穿上${名}（${盖.join("、")}）`
}

export function 脱(名) {
  const d = 读穿着()
  let 找到 = false
  for (const 部 of Object.keys(d.部位)) {
    const i = d.部位[部].indexOf(名)
    if (i >= 0) { d.部位[部].splice(i, 1); 找到 = true }
  }
  if (!找到) return `身上没有「${名}」`
  save(穿P, d)
  同步资产着装(d)
  return `脱下${名}`
}

// 该穿什么 2026-11-07（主人原话「看天气预报 天气冷了热了在家自己会决定换不换衣服」）：
// 拿明天的低温和有没有雨，从衣柜里挑一套能凑够保暖的衣服；够不着就报差多少。
/**
 * 记差额 —— 把「明天该穿多少 / 这身够不够 / 差多少」落一份盘。
 *
 * WARM_GAP 2026-11-14（批次403）：`该穿()` 从上线起就在算 `差`，它上面那行注释
 * 写的也是「够不着就报差多少」—— 但全库没有任何地方读这个字段，等于每天算出
 * 「你还差 1.7 的保暖」然后扔掉。她只觉得冷（体感槽会说冷），不知道自己缺的是衣服，
 * 更不知道衣柜里没有更厚的（实测：衣柜 4 件全是夏天的，钱 261 够买一件 45 的毛衣开衫）。
 *
 * 写到 `记忆/穿衣差额.json`，由 voiceSlots 的冷热槽读（那边只读）。
 * 不并进 `穿着.json`：那份是「身上穿了什么」，这份是「明天需要什么」，是两件事。
 */
export function 记差额(now = Date.now()) {
  try {
    const 建议 = 该穿(now)
    const 出 = {
      明天最低: 建议.明天最低,
      有雨: !!建议.有雨,
      要: 建议.要,
      够了: 建议.够了,
      差: 建议.差,
      at: now,
    }
    save(差P, 出)
    return 出
  } catch { return null }
}

export function 自动按天气换衣(now = Date.now()) {
  // WARM_GAP：不管在不在家都先记一份差额 —— 她关心的是「明天穿什么」，
  // 这跟此刻站哪儿无关；漏记的话体感槽读到的是隔夜的旧数（那边按 36 小时判过期）。
  记差额(now)
  const 资产 = load(资产P, {})
  if (String(资产.位置 || '') !== '家') return ''
  const 建议 = 该穿(now)
  if (!建议.挑.length) return ''
  const 身上 = new Set(Object.values(读穿着().部位 || {}).flat())
  const 新衣 = 建议.挑.filter((名) => !身上.has(名))
  if (!新衣.length) return ''
  const 已穿 = []
  for (const 名 of 新衣) {
    const r = 穿(名)
    if (String(r).startsWith('穿上')) 已穿.push(名)
  }
  if (!已穿.length) return ''
  return 已穿.join('、')
}

export function 该穿(now = Date.now()) {
  const w = load(path.join(MEM, '天气.json'), {})
  const 外 = Number(w.温度 ?? 18)
  const 明日 = (Array.isArray(w.预报) && w.预报[0]) || w.明天 || null
  const 明天 = Number((明日 && (明日.最低 ?? 明日.低)) ?? (w.最低 ?? (w.明天 && (w.明天.低 ?? w.明天.最低)) ?? 外 - 3))
  const 有雨 = !!(明日 && /雨/.test(String(明日.天气 || ''))) || !!(w.明天 && /雨/.test(String(w.明天.天气 || ''))) || !!(w.现在 && w.现在.下)
  // WIND 2026-11-07（批次162）：明天刮风就得多穿一点 —— 4 级往上每级加 0.2 度。
  const 来风 = Number((明日 && 明日.风) || (w.风 && w.风.级) || 0)
  const 风补 = Math.max(0, 来风 - 3) * 0.2
  // 体感要多少保暖：以 23 度为舒服点，差一度补一点
  const 要 = Math.max(0, Math.round(((23 - 明天) * 0.35 + 风补) * 10) / 10)
  const 柜 = (load(path.join(MEM, '资产.json'), {}).衣柜 || []).filter((x) => typeof x === 'string')
  const 表 = 平表()
  const 有 = 柜.map((n) => ({ n, 暖: Number((表[n] && 表[n].穿 && 表[n].穿.保暖) || 0), 部: (表[n] && 表[n].穿 && 表[n].穿.部位) || '' }))
    .sort((a, b) => b.暖 - a.暖)
  let 合计 = 0
  const 挑 = []
  for (const x of 有) { if (合计 >= 要) break; 挑.push(x.n); 合计 += x.暖 }
  return { 明天最低: 明天, 有雨, 要, 挑, 够了: Math.round(合计 * 10) / 10, 差: Math.max(0, Math.round((要 - 合计) * 10) / 10) }
}

const 是主 = process.argv[1] && process.argv[1].endsWith('穿衣.mjs')
if (是主) {
  const args = process.argv.slice(2)
  const val = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }
  if (args.includes('--加')) console.log(穿(val('加')))
  else if (args.includes('--脱')) console.log(脱(val('脱')))
  else {
    const r = 算({ 湿: Number(val('湿') || 0), 风: Number(val('风') || 0) })
    for (const [部, v] of Object.entries(r.部位)) {
      console.log(`${部}：${v.件.join('、') || '露着'}｜暖 ${v.暖}｜防风 ${v.防风}`)
    }
    console.log(`加权 ${r.加权}｜最薄 ${r.最薄}${r.露着.length ? '（露着：' + r.露着.join('、') + '）' : ''}`)
  }
}
