#!/usr/bin/env node
// 偏好.mjs —— 偏好可以作废，不用删（2026-11-07 批次183）
//
// 为什么要这个：
//   `偏好.json` 的 喜欢/讨厌/审美 只有一个入口是「加」（自改.mjs --set、生长.mjs --path），
//   没有任何「减」。于是讨厌的东西只会越攒越多，甚至互相矛盾 ——
//   「讨厌谐音梗」和后来「自己也爱讲」能同时挂在 讨厌 列表里，而她每次都被注入这两条。
//
// 做法（抄 dsh-soul 的「作废而不是堆积」）：
//   **不删原文**，只在 `作废` 里记一条「这条从哪天起不算了、为什么」。
//   注入时（插件 readPfOnce）把作废的剔掉；回捞时（--all）仍看得到，带说明。
//   删了就再也想不起来自己什么时候变过 —— 那也是一种失忆。
//
// 用法：
//   node 偏好.mjs                                    # 现在算数的（注入用的就是这批）
//   node 偏好.mjs --all                              # 连作废的一起看
//   node 偏好.mjs --retire 讨厌 "谐音梗" --因 "自己也爱讲了"
//   node 偏好.mjs --revive 讨厌 "谐音梗"             # 反悔了，撤回作废
//   node 偏好.mjs --check                            # 查一遍账对不对
import { readFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { 写档 } from './_底层.mjs'
import { 加锁 } from './_锁.mjs'

const BASE = process.env.QQ_PREF_MEM || '{{BOT_ROOT}}/记忆'
const P = join(BASE, '偏好.json')
const 类们 = ['喜欢', '讨厌', '审美']

const 北京今天 = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
const 读 = () => {
  try {
    const v = JSON.parse(readFileSync(P, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}
const 条目名 = (x) => (typeof x === 'string' ? x : String(x?.对象 ?? x?.词 ?? x ?? ''))

/** 作废表：一律是数组，缺了当空 */
const 作废表 = (o) => (Array.isArray(o['作废']) ? o['作废'] : [])

/** 把作废的从三个列表里剔掉，返回一份新的（不改原对象） */
export function 剔掉作废(o) {
  const 表 = 作废表(o)
  if (!表.length) return o
  const 出 = { ...o }
  for (const 类 of 类们) {
    if (!Array.isArray(o[类])) continue
    const 死 = new Set(表.filter((x) => x && x['类'] === 类).map((x) => String(x['条'])))
    if (!死.size) continue
    出[类] = o[类].filter((x) => !死.has(条目名(x)))
  }
  return 出
}

const args = process.argv.slice(2)
const 有 = (n) => args.includes(n)
const 值 = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d }
// 只有 --因 是「带值的选项」；--retire / --revive / --all / --check 都是开关，
// 它们后面跟的是位置参（分类、条目名）—— 原来按「前面是 -- 就跳过」会把「讨厌」吞掉，
// 于是 --retire 永远报用法错误（自己踩的，写下来）。
const 带值选项 = new Set(['--因'])
const 位置参 = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && 带值选项.has(args[i - 1])))

function 打印(o, 含作废) {
  const 表 = 作废表(o)
  let 空 = true
  for (const 类 of 类们) {
    const 列 = Array.isArray(o[类]) ? o[类] : []
    if (!列.length) continue
    空 = false
    console.log(类 + '：')
    for (const x of 列) {
      const n = 条目名(x)
      const 死 = 表.find((y) => y && y['类'] === 类 && String(y['条']) === n)
      if (死 && !含作废) continue
      if (typeof x === 'string') {
        console.log('  ' + (死 ? '✗ ' : '· ') + n + (死 ? '   （' + (死['到'] || '') + ' 起不算了' + (死['因'] ? '：' + 死['因'] : '') + '）' : ''))
      } else {
        console.log('  ' + (死 ? '✗ ' : '· ') + n + ' —— ' + JSON.stringify(x) + (死 ? '   （作废）' : ''))
      }
    }
  }
  // 只作废、原文已经不在列表里的（说明被人手动删过）
  const 尾巴 = 表.filter((y) => y && !((o[y['类']] || []).some((x) => 条目名(x) === String(y['条']))))
  if (含作废 && 尾巴.length) {
    console.log('只剩作废记录（原文已不在列表里）：')
    for (const y of 尾巴) console.log('  ✗ ' + y['类'] + ' / ' + y['条'] + '   ' + (y['到'] || ''))
  }
  if (空) console.log('（空的）')
}

function 检查(o) {
  const 表 = 作废表(o)
  let 问题 = 0
  const 说 = (t) => { console.log('  ' + t); 问题++ }

  for (const y of 表) {
    if (!类们.includes(y['类'])) 说('作废记录的分类不认识：' + JSON.stringify(y))
    else if (!(o[y['类']] || []).some((x) => 条目名(x) === String(y['条']))) {
      说('作废了一条列表里已经没有的：' + y['类'] + ' / ' + y['条'] + '（可以 --revive 清掉这条记录）')
    }
    if (!y['到']) 说('作废记录缺日期：' + JSON.stringify(y))
  }
  for (const 类 of 类们) {
    const 列 = (o[类] || []).map(条目名)
    const 重 = 列.filter((x, i) => 列.indexOf(x) !== i)
    if (重.length) 说(类 + ' 有重复：' + [...new Set(重)].join('、'))
  }
  const 键 = 表.map((y) => y['类'] + '/' + y['条'])
  const 重2 = 键.filter((x, i) => 键.indexOf(x) !== i)
  if (重2.length) 说('作废表里有重复：' + [...new Set(重2)].join('、'))

  console.log(问题 ? '  共 ' + 问题 + ' 处要看看' : '  账是对的')
  return 问题
}

// MAIN_GUARD 2026-11-07（批次183）：被 import 时不能跑主流程。
// 起因很实在 —— 写自检要 import 这个模块的 `剔掉作废` 去和插件侧那份比对，
// 结果一 import 就把当前偏好全打印了一遍（模块顶层直接执行了）。
const 是主 = !!(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)

// 读一改一写必须在同一把锁里 —— 作废表是「读全表再写回」，锁外读会丢更新
if (是主 && (有('--retire') || 有('--revive'))) {
  const 类 = 位置参[0]
  const 条 = 位置参[1]
  if (!类们.includes(类) || !条) {
    console.log('用法：node 偏好.mjs --retire 喜欢|讨厌 条目名 [--因 "为什么"]')
    console.log('      node 偏好.mjs --revive 喜欢|讨厌 条目名')
    process.exit(2)
  }
  const 放 = 加锁(basename(P), { strict: true })
  try {
    const o = 读()
    const 列 = Array.isArray(o[类]) ? o[类] : []
    if (有('--retire')) {
      if (!列.some((x) => 条目名(x) === 条)) {
        console.log('「' + 条 + '」不在 ' + 类 + ' 里，不作废。先 node 偏好.mjs 看看现在有什么。')
        process.exit(1)
      }
      if (作废表(o).some((y) => y['类'] === 类 && String(y['条']) === 条)) {
        console.log('「' + 条 + '」早就作废过了。')
        process.exit(0)
      }
      o['作废'] = [...作废表(o), { 类, 条, 到: 北京今天(), 因: String(值('--因', '') || '') }]
      写档(P, o)
      console.log('作废了：' + 类 + ' / ' + 条 + (值('--因', '') ? '（' + 值('--因', '') + '）' : ''))
      console.log('原文还在，只是以后不再注入；--all 看得到，--revive 能撤回。')
    } else {
      const 前 = 作废表(o).length
      o['作废'] = 作废表(o).filter((y) => !(y['类'] === 类 && String(y['条']) === 条))
      if (o['作废'].length === 前) { console.log('作废表里没有这条。'); process.exit(0) }
      // 空数组不留在文件里 —— 复原本该是「一字不差」，留个 "作废": [] 会让 md5 变、也让人以为有账
      if (!o['作废'].length) delete o['作废']
      写档(P, o)
      console.log('恢复了：' + 类 + ' / ' + 条)
    }
  } finally { try { 放() } catch { /* 已放 */ } }
  process.exit(0)
}

if (是主 && 有('--check')) {
  console.log('偏好账目：')
  process.exit(检查(读()) ? 1 : 0)
}

if (是主) {
  打印(读(), 有('--all'))
  const 表 = 作废表(读())
  if (表.length && !有('--all')) console.log('\n（另有 ' + 表.length + ' 条已作废，--all 可看）')
}
