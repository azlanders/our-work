// 同步表.mjs —— 以总表为准，把 售卖点 铺到 商店表 和 地图
//
// 为什么：同一件事原来手写三处
//   ① 总表/衣物表 每条写「售卖点」
//   ② 商店-生活.json 每条又写一遍「售卖点」
//   ③ 地图.json 每个地点再写一遍「服务: [商品名…]」
// 实测已经分歧：地图说便利店卖伞，商店表说伞只在街市/超市卖。
//
// 现在 ① 是唯一真相，②③ 由这里反算。加东西只改总表，然后跑一次这个。
//
// 用法：
//   node 同步表.mjs         # 预演，只列差异
//   node 同步表.mjs --写    # 真写（原子替换）
import fs from 'node:fs'
import path from 'node:path'
import { 写档 } from './_底层.mjs'

// SANDBOX 2026-11-14（批次415）：它是唯一一个「有 --写、却一个沙盒变量都没有」的
// 写操作脚本 —— `--写` 会原子替换 物品总表 / 衣物表 / 商店-生活 / 地图 四张表，
// 而单测只能对着真档跑。变量名跟 物品/穿衣 一致（同一个记忆目录）。
const MEM = process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
// CART_SANDBOX 2026-11-14（批次428）：原来 TOOLS 是硬编码 —— MEM 认 QQ_AUTONOMY_MEM，
// 但 商店-生活.json / 地图.json 这两张要写的表永远指着真目录，于是这个脚本**没法进落盘测试**
// （一测就写真档），也就从来没验过 `--写`。名字跟 表.mjs 一致。
const TOOLS = process.env.QQ_TOOLS || '{{BOT_ROOT}}/共享/工具'
const 读 = (p, d = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
// FIXED_TMP 2026-11-07（批次179）：原来临时名写死 `p + '.tmp'` —— 两个进程同时写会往
// 同一个临时文件里灌，先 rename 的那个把另一个的半截搬成正式档（地图.json / 商店-生活.json）。
// 写档 的临时名带 pid + 随机，永不撞。
const 写 = (p, o) => 写档(p, o)

const 总P = path.join(MEM, '物品总表.json')
const 店P = path.join(TOOLS, '商店-生活.json')
const 地图P = path.join(TOOLS, '地图.json')

const 总 = 读(总P)
const 店 = 读(店P)
const 地图 = 读(地图P)

// 平表 —— 两张都要算。只算总表会把 40 件衣服从地图上「删」掉（衣服的售卖点在 衣物表.json）
const 平 = {}
const 递归 = (o) => {
  for (const [k, v] of Object.entries(o || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    if (v.类别) 平[k] = v
    else 递归(v)
  }
}
递归(总.分组)
for (const [k, v] of Object.entries(读(path.join(MEM, '衣物表.json')).件 || {})) {
  if (v && typeof v === 'object') 平[k] = v
}

// 地名 → 该地所有条目（按类别固定顺序，方便看）
const 序 = { 吃: 0, 零食: 1, 喝: 2, 穿: 3, 饰: 4, 用: 5, 服务: 6 }
const 反算 = {}
for (const [名, v] of Object.entries(平)) {
  for (const 地 of v.售卖点 || []) (反算[地] = 反算[地] || []).push({ 名, 类: v.类别 })
}
for (const 地 of Object.keys(反算)) 反算[地].sort((a, b) => (序[a.类] ?? 9) - (序[b.类] ?? 9) || a.名.localeCompare(b.名, 'zh'))

const 改 = { 商店售卖点: [], 地图服务: [], 空地: [] }

// ── ① 商店表：同名条目的 售卖点 对齐总表 ──
for (const [名, v] of Object.entries(店.商品 || {})) {
  const t = 平[名]
  if (!t) continue
  const 新 = [...new Set(t.售卖点 || [])].sort()
  const 旧 = [...new Set(v.售卖点 || [])].sort()
  if (JSON.stringify(新) !== JSON.stringify(旧)) {
    改.商店售卖点.push(`${名}: [${旧.join(',')}] → [${新.join(',')}]`)
    v.售卖点 = 新
  }
}

// ── ② 地图：服务 = 反算 ──
for (const [地, p] of Object.entries(地图.地点 || {})) {
  const 新 = (反算[地] || []).map((x) => x.名)
  const 旧 = Array.isArray(p.服务) ? p.服务 : null
  if (旧 === null) {
    改.空地.push(`${地}: 服务 ${JSON.stringify(p.服务)} → ${新.length} 项`)
    p.服务 = 新
  } else if (JSON.stringify(旧.slice().sort()) !== JSON.stringify(新.slice().sort())) {
    const 多 = 新.filter((x) => !旧.includes(x))
    const 少 = 旧.filter((x) => !新.includes(x))
    改.地图服务.push(`${地}: ${多.length ? '加 ' + 多.join(',') : ''}${多.length && 少.length ? ' / ' : ''}${少.length ? '删 ' + 少.join(',') : ''}`)
    p.服务 = 新
  }
  if (!Array.isArray(p.招工)) {
    改.空地.push(`${地}: 招工 ${JSON.stringify(p.招工)} → []`)
    p.招工 = []
  }
}

console.log('=== 商店表 售卖点 对齐', 改.商店售卖点.length, '条')
for (const x of 改.商店售卖点) console.log('  ' + x)
console.log('\n=== 地图 服务 反算', 改.地图服务.length, '个地点')
for (const x of 改.地图服务) console.log('  ' + x)
console.log('\n=== 空字段补成数组', 改.空地.length, '处')
for (const x of 改.空地) console.log('  ' + x)

const 总改 = 改.商店售卖点.length + 改.地图服务.length + 改.空地.length
if (process.argv.includes('--写')) {
  if (改.商店售卖点.length) 写(店P, 店)
  if (改.地图服务.length || 改.空地.length) 写(地图P, 地图)
  console.log(`\n已写（${总改} 处）`)
} else {
  console.log(`\n（预演，共 ${总改} 处差异。加 --写 才真写）`)
}
