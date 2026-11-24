#!/usr/bin/env node
// 地点.mjs —— 「这儿能干什么 / 现在能去哪」的统一入口（2026-11-05）
//
// 为什么要单独一个文件：
//   在它之前，「地点」这个概念散在四个地方各写各的：
//     缺口.mjs 只知道「这儿卖不卖伞」，走路.mjs 只关心坐标和分钟数，
//     拍照想法.mjs 只有一个地点名字，poll.js 把地点名拼成一句话就给她看。
//   谁都不知道「图书馆周一闭馆」「下雨天公园没人」「这个点除了便利店全关门」。
//   结果就是：她在 02:00 说要去图书馆看书，下雨天说在公园坐着。
//
// 现在所有「一个地方能干什么」的问题都问这个文件：
//   · 开着吗（营业时间 / 周几休）
//   · 这儿能不能洗澡 / 躲雨 / 吃东西
//   · 今天这个天气，这地方待着舒不舒服
//   · 现在哪些地方去得成，按舒不舒服排
//
// 用法：
//   node 地点.mjs                 我在这儿能干什么
//   node 地点.mjs --查 图书馆      某个地方的全部信息
//   node 地点.mjs --能去哪        现在开门、又能待的地方，按舒服排
//   node 地点.mjs --能干 洗澡      现在哪些开着的地方能洗澡
//   node 地点.mjs --json          机器读（含能去哪前几个）
//
// 也可以 import：
//   import { 营业中, 适合度, 能去哪 } from './地点.mjs'
//
// 沙盒：QQ_MEM 指到别处；地图永远读本文件旁边的 地图.json。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const MEM = process.env.QQ_MEM || '{{BOT_ROOT}}/记忆'
const MAP = path.join(HERE, '地图.json')

const 参数 = process.argv.slice(2)
const has = (x) => 参数.includes(x)
const 值 = (k) => {
  const i = 参数.indexOf(k)
  return i >= 0 ? 参数[i + 1] : ''
}

// 文件读得频繁（缺口每分钟、面板每次刷新），但改动很少。按 mtime 缓存。
const 缓存 = new Map()
function 读(f, 默认) {
  try {
    const m = fs.statSync(f).mtimeMs
    const c = 缓存.get(f)
    if (c && c.m === m) return c.v
    const v = JSON.parse(fs.readFileSync(f, 'utf8'))
    缓存.set(f, { m, v })
    return v
  } catch {
    return 默认
  }
}

// 读图 2026-11-07（批次163）：地图只有一份（本文件旁边的 地图.json），解析也只该有一处。
// 体温原来自己读「记忆/地图.json」—— 那个文件根本不存在，于是它退回一张手写的
// 「打工点 / 街市 / 公园露天」名单，游乐园和海边被当成有暖气的室内（冬天也是 26 度）。
// 面板另外还有三处自己 JSON.parse，其中一处靠 base.replace(/记忆$/, …) 拼路径。
export const 读图 = () => 读(MAP, { 地点: {} })

// mem 可以传，测试时指向沙盒目录。
// （不靠环境变量：import 是提前解析的，调用方在 import 之后设 QQ_MEM 已经晚了 ——
//  之前吃过这个亏，沙盒只对主脚本生效，子进程照样写真数据。）
export function 读档(mem = MEM) {
  const 图 = 读(MAP, { 地点: {} })
  const 天 = 读(path.join(mem, '天气.json'), {})
  const 资 = 读(path.join(mem, '资产.json'), {})
  // NOW 只为测试：「假装现在是 02:30」。
  // 营业时间这种东西没法靠等来测 —— 一天只有一次 02:00。
  // 支持 HH:MM 和「周几@HH:MM」两种写法。
  const 假 = process.env.NOW || ''
  let now = new Date(Date.now() + 8 * 3600e3)
  let 假星期 = null
  if (假) {
    const m = 假.match(/^(?:([0-6])@)?(\d{1,2}):(\d{2})$/)
    if (m) {
      if (m[1] !== undefined) 假星期 = Number(m[1])
      const d = new Date(now)
      d.setUTCHours(Number(m[2]), Number(m[3]), 0, 0)
      now = d
    }
  }
  return {
    图, 天, 资,
    时: now.getUTCHours(),
    分: now.getUTCMinutes(),
    星期: 假星期 !== null ? 假星期 : now.getUTCDay(),
    此刻: `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`,
    位置: String(资.位置 || '家'),
  }
}

const 分钟 = (s) => {
  const [h, m] = String(s || '0:0').split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}
const 时刻 = (n) => `${String(Math.floor(n / 60) % 24).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`

// 营业段：跨夜的写成 [22:00, 02:00]，所以要分两种情况判
function 在段内(t, 起, 止) {
  const a = 分钟(起)
  const b = 分钟(止)
  if (a === b) return true          // 00:00-00:00 当全天
  if (a === 0 && b >= 1440) return true
  if (a < b) return t >= a && t < b
  return t >= a || t < b
}

// 营业状态。返回 { ok, 因, 段 }
export function 营业中(name, 档) {
  const p = (档.图.地点 || {})[name]
  if (!p) return { ok: false, 因: '地图上没有这个地方', 段: [] }
  const 段 = Array.isArray(p.营业) && p.营业.length ? p.营业 : [['00:00', '24:00']]
  const 全天 = 段.some(([a, b]) => 分钟(a) === 0 && 分钟(b) >= 1440)
  if ((p.休 || []).includes(档.星期)) {
    const 名 = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][档.星期]
    return { ok: false, 因: 名 + '休息', 段, 全天 }
  }
  const t = 档.时 * 60 + 档.分
  const 开 = 段.some(([a, b]) => 在段内(t, a, b))
  if (开) return { ok: true, 因: '', 段, 全天 }

  // 关门了：告诉她几点开（今天还没开的话；已经过了就是明天）
  let 最早 = Infinity
  for (const [a] of 段) {
    const m = 分钟(a)
    if (m > t && m < 最早) 最早 = m
  }
  const 因 = 最早 === Infinity
    ? '今天已经关了（' + 段.map(([a, b]) => a + '-' + b).join('、') + '）'
    : '还没开，' + 时刻(最早) + ' 才开'
  return { ok: false, 因, 段, 全天 }
}

// 能睡吗 2026-11-06（批次112）：主人要「有些地方有关闭时间，有些地方干脆不让睡、
// 或者是没地方睡」。地图上每个地点现在带 歇：{能, 档, 上限分钟, 话}。
// 睡觉这件事不能只看困不困，得先问这儿让不让睡 —— 不然她会趴在超市过道里睡一宿。
export function 能睡吗(name, 档) {
  const p = (档 && 档.图 && 档.图.地点 ? 档.图.地点 : {})[name]
  if (!p) return { 能: false, 为什么: '地图上没有这个地方', 档: '', 上限分钟: 0, 话: '' }
  const 歇 = p.歇 || {}
  const 话 = String(歇.话 || '')
  if (歇.能 !== true) {
    return { 能: false, 为什么: 话 || '这儿没地方睡', 档: '', 上限分钟: 0, 话 }
  }
  // 关了门的地方睡不了：店门口的台阶不算「有地方睡」。
  const 营 = 营业中(name, 档)
  if (!营.ok) {
    return { 能: false, 为什么: '已经关门了，' + 营.因, 档: String(歇.档 || '打盹'), 上限分钟: Number(歇.上限分钟) || 0, 话 }
  }
  return { 能: true, 为什么: '', 档: String(歇.档 || '打盹'), 上限分钟: Number(歇.上限分钟) || 0, 话 }
}

// 眼下能睡的所有地方。家排第一 —— 她真困了，回家永远比趴在长椅上强。
// 「打盹」类带 上限分钟，调用方拿它判「睡过头会被赶」。
export function 能睡的地方(档) {
  const 图 = (档 && 档.图 && 档.图.地点) || {}
  const 出 = []
  for (const 名 of Object.keys(图)) {
    const r = 能睡吗(名, 档)
    if (!r.能) continue
    出.push({
      名,
      档: r.档,
      上限分钟: r.上限分钟,
      话: r.话,
      // 排序用：家 0，能躺 1，打盹 2，其余 3。同等条件里「上限分钟 0 = 不限」排前面。
      权: 名 === '家' ? 0 : r.档 === '整夜' ? 0 : r.档 === '躺' ? 1 : r.档 === '睡着' ? 2 : 3,
    })
  }
  出.sort((a, b) => a.权 - b.权 || (a.上限分钟 || 9999) - (b.上限分钟 || 9999))
  return 出
}

// SEASON_FIT 2026-11-05（批次82）：这一季这地方值不值得去。
// 加的不是「温度舒不舒服」——那个体感已经算过了（体感 >=32 扣 0.3、<=1 扣 0.4）。
// 加的是季节本身改变的东西：春天公园有花、秋天街市有好吃的、冬天海边根本没人去。
// 只给室外加。室内有空调那条，同一件事别扣两遍。
const 季节偏好 = {
  公园:   { 春: 0.14, 夏: -0.08, 秋: 0.14, 冬: -0.16 },
  海边:   { 春: 0.06, 夏: 0.16, 秋: 0.04, 冬: -0.26 },
  游乐园: { 春: 0.06, 夏: 0.10, 秋: 0.04, 冬: -0.20 },
  街市:   { 春: 0.04, 夏: -0.05, 秋: 0.09, 冬: -0.10 },
  打工点: { 春: 0, 夏: -0.06, 秋: 0, 冬: -0.12 },
}

// SEASON_DAYLIGHT 2026-11-05（批次82）：白天不再写死 6~20 点。
// 昼长本身就是季节：夏天 19:30 天还亮，冬天 17 点就黑透了。
// 写死的话，十一月的 18:30 会被当成白天、「天好 +0.25」把公园顶到第一 —— 那会儿天早黑了。
// 抽成函数是因为 CLI 打印「天好」也得用同一套，两处各写一份必然对不上。
export function 在白天(档) {
  const t = Number((档 || {}).时 ?? 12)
  const 钟 = (s, 兜底) => {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/)
    return m ? Number(m[1]) + Number(m[2]) / 60 : 兜底
  }
  const 天 = (档 || {}).天 || {}
  return t >= 钟(天.日出, 6) && t < 钟(天.日落, 20)
}

// 今天这个天气，这地方待着舒不舒服。不是「好不好玩」，是「愿不愿意待」。
// 影响因素：本来的舒适度 + 室内外 + 空调 + 晴雨 + 季节 + 路远
export function 适合度(name, 档) {
  const p = (档.图.地点 || {})[name]
  if (!p) return -9
  const 天 = 档.天 || {}
  const 体感 = Number(天.体感温度 ?? 天.温度 ?? 18)
  const 在下 = !!(天.现在 && 天.现在.下)
  const 天气 = String(天.天气 || '')
  const 风 = Number((天.风 && 天.风.级) || 0)

  let 分 = Number(p.待 ?? 0.3)
  const 时 = Number(档.时 ?? 12)

  // 白天见 在白天()。这里是唯一一处判定，CLI 的「天好」标签也用同一个。
  const 白天 = 在白天(档)

  // 时段：同样一个地方，凌晨和下午不是一回事。
  // 不加这段，凌晨 2:30 的海边会排第一 —— 天气是晴的，可她不会那个点跑去看海。
  if (!p.室内) {
    if (时 < 5 || 时 >= 23) 分 -= 0.6
    else if (时 < 7 || 时 >= 21) 分 -= 0.25
  }

  if (!p.室内) {
    if (在下 && !p.有棚) 分 -= 0.65
    else if (在下) 分 -= 0.38           // 有棚能挡一点，但露天的地方下雨还是难待
    if (天气 === '雾' || 天气 === '霾') 分 -= 0.3
    if (风 >= 5) 分 -= 0.18
    if (体感 >= 32) 分 -= 0.3
    if (体感 <= 1) 分 -= 0.4
    // 好天气在室外是真加分：晴天的公园和阴天的公园不是同一个地方。
    // 但只在白天算 —— 深夜的「晴」对她没有任何意义，加分会把凌晨的海边顶到第一。
    if (白天 && 天气 === '晴' && !在下 && 体感 >= 10 && 体感 <= 28) 分 += 0.25
    if (白天 && 天气 === '少云' && !在下) 分 += 0.12
  } else if (p.空调) {
    if (体感 >= 30) 分 += 0.25
    if (体感 <= 3) 分 += 0.25
  }

  // 季节：只对室外的几处。表里没写的地方按 0 算，不是每处都该有时令感。
  // 正分只在白天算 —— 「秋天的公园好看」是看得见才成立的，天黑了过去只有路灯。
  // 负分不分昼夜：冬天海边冷就是冷，几点都一样。
  if (!p.室内) {
    const 季 = String((档.天 || {}).季节 || '')
    let 偏 = (季节偏好[name] || {})[季]
    if (typeof 偏 === 'number') {
      if (偏 > 0 && !白天) 偏 = 0
      分 += 偏
    }
  }

  // 路远：来回是成本。t 是从家出发的单程分钟数，按 200 分钟扣满 1 分
  分 -= Number(p.t || 0) / 200
  return Math.round(分 * 100) / 100
}

// 现在去得成、又待得住的地方。默认不含家（家不算「出去」）。
export function 能去哪(档, opt = {}) {
  const out = []
  for (const name of Object.keys(档.图.地点 || {})) {
    if (name === '家' && !opt.含家) continue
    const 营 = 营业中(name, 档)
    if (!营.ok) continue
    const p = 档.图.地点[name]
    if (opt.能力 && !(p.能 || []).includes(opt.能力)) continue
    if (opt.室内 && !p.室内) continue
    // 默认滤掉「不想待」的地方（医院 -0.6、打工点 -0.4）。
    // 这不是「去不了」，是「不是没事会想去的地方」；要办事走 --能干。
    const 下限 = opt.最低分 !== undefined ? opt.最低分 : 0
    if (适合度(name, 档) < 下限) continue
    out.push({ name, 分: 适合度(name, 档), 走: Number(p.t || 0), 室内: !!p.室内 })
  }
  out.sort((a, b) => b.分 - a.分 || a.走 - b.走)
  return opt.上限 ? out.slice(0, opt.上限) : out
}

// 给对话用的短句：一个地点现在什么状态
export function 一句话(name, 档) {
  const p = (档.图.地点 || {})[name]
  if (!p) return ''
  const 营 = 营业中(name, 档)
  const 天气 = 档.天 || {}
  const 片 = []
  if (!营.ok) 片.push(营.因)
  else if (营.全天) 片.push('这个点开着（24 小时）')
  else 片.push('这个点开着')
  if (p.室内) 片.push(天气.现在 && 天气.现在.下 ? '里头淋不着' : '在里头')
  else if (天气.现在 && 天气.现在.下) 片.push(p.有棚 ? '有棚，能挡一阵' : '在外头，正淋着')
  const 能 = (p.能 || []).filter((x) => !['坐', '躲雨', '凉', '暖', '充电'].includes(x))
  if (能.length) 片.push('能做' + 能.slice(0, 6).join('、'))
  // SEASON_WORD 2026-11-05（批次82）：室外的地方，季节是看得见的东西。
   // 只说「树」这一条 —— 花和吃的不一定在这地方，树到处都有。
  if (!p.室内) {
    const 树 = String(((档.天 || {}).物候 || {}).树 || '')
    if (树) 片.push(树)
  }
  return name + '：' + 片.join('，')
}

// ---------------- CLI ----------------
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const 档 = 读档()
  const 天 = 档.天
  const 天话 = [天.天气, 天.温度 !== undefined ? 天.温度 + '°' : '', 天.话].filter(Boolean).join(' · ')

  if (has('--json')) {
    console.log(JSON.stringify({
      此刻: 档.此刻, 星期: 档.星期, 位置: 档.位置,
      天气: 天.天气, 温度: 天.温度, 体感温度: 天.体感温度,
      现在: 天.现在 || {},
      地点: Object.fromEntries(Object.keys(档.图.地点).map((k) => [k, {
        室内: !!档.图.地点[k].室内,
        营业: 档.图.地点[k].营业,
        休: 档.图.地点[k].休 || [],
        能: 档.图.地点[k].能 || [],
        适: 适合度(k, 档),
        开: 营业中(k, 档).ok,
        因: 营业中(k, 档).因,
        走: 档.图.地点[k].t,
        拍照: 档.图.地点[k].拍照 || [],
      }])),
      能去哪: 能去哪(档, { 上限: 6 }),
    }, null, 2))
    process.exit(0)
  }

  if (has('--查')) {
    const 名 = 值('--查')
    const p = 档.图.地点[名]
    if (!p) {
      console.log('地图上没有「' + 名 + '」。有的：' + Object.keys(档.图.地点).join('、'))
      process.exit(0)
    }
    const 营 = 营业中(名, 档)
    console.log(`${名} · ${p.室内 ? '室内' : '室外'} · ${营.全天 ? '24 小时' : (p.营业 || []).map(([a, b]) => a + '-' + b).join('、')}${(p.休 || []).length ? ' · ' + p.休.map((d) => ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d]).join('、') + '休' : ''}`)
    console.log('  ' + p.desc)
    console.log('  现在：' + (营.ok ? '开着' : '关着（' + 营.因 + '）'))
    console.log('  今天合适度：' + 适合度(名, 档) + '（天气：' + 天话 + '）')
    console.log('  能做：' + (p.能 || []).join('、'))
    console.log('  拍得到：' + (p.拍照 || []).join('、'))
    console.log('  从家走：' + (p.t || 0) + ' 分钟')
    process.exit(0)
  }

  if (has('--能干')) {
    const 本事 = 值('--能干')
    const 有 = Object.keys(档.图.地点).filter((k) => (档.图.地点[k].能 || []).includes(本事))
    const 开 = 能去哪(档, { 能力: 本事 })
    console.log(`能「${本事}」的地方：` + (有.length ? 有.join('、') : '（一个都没有）'))
    if (有.length) {
      const 关 = 有.filter((k) => !开.some((x) => x.name === k))
      console.log('现在去得成：' + (开.length ? 开.map((x) => x.name + '(' + x.分 + ')').join('、') : '一个都不开'))
      if (关.length) console.log('现在去不成：' + 关.map((k) => k + '（' + 营业中(k, 档).因 + '）').join('、'))
    }
    process.exit(0)
  }

  if (has('--能去哪')) {
    const 排 = 能去哪(档, { 上限: 9 })
    console.log('此刻 ' + 档.此刻 + '（周' + '日一二三四五六'[档.星期] + '）· ' + 天话)
    console.log('现在去得成的地方（按待着舒不舒服排）：')
    if (!排.length) console.log('  一个都不开。只能在家，或者去便利店/海边/医院这种 24 小时的')
    for (const x of 排) {
      const p = 档.图.地点[x.name]
      const 理由 = []
      if (p.室内 && 天.现在 && 天.现在.下) 理由.push('淋不着')
      if (!p.室内 && 天.现在 && 天.现在.下) 理由.push('在下雨')
      if (p.室内 && p.空调 && Number(天.体感温度 || 20) >= 30) 理由.push('有空调')
      if (!p.室内 && 天.天气 === '晴' && 在白天(档)) 理由.push('天好')
      console.log(`  ${x.name.padEnd(4, '　')} ${String(x.分).padStart(5)}  走 ${String(x.走).padStart(2)} 分  ${理由.join('·')}`)
    }
    const 关 = Object.keys(档.图.地点).filter((k) => !营业中(k, 档).ok)
    if (关.length) console.log('关着的：' + 关.map((k) => k + '（' + 营业中(k, 档).因 + '）').join('、'))
    process.exit(0)
  }

  // 默认：我现在这个地方
  const 这 = 档.位置
  const p = 档.图.地点[这]
  console.log('人在' + 这 + (p && p.desc ? '（' + p.desc + '）' : ''))
  if (p) {
    const 营 = 营业中(这, 档)
    console.log('  ' + (营.ok ? (营.全天 ? '24 小时开着' : '开着（' + (p.营业 || []).map(([a, b]) => a + '-' + b).join('、') + '）') : '关着 —— ' + 营.因))
    console.log('  能做：' + (p.能 || []).join('、'))
    console.log('  拍得到：' + (p.拍照 || []).join('、'))
  }
  console.log('  天气：' + 天话)
  const 排 = 能去哪(档, { 上限: 5 })
  if (排.length) console.log('  现在能去：' + 排.map((x) => x.name + '(' + x.分 + ')').join('、'))
}
