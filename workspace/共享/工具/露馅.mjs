#!/usr/bin/env node
// 露馅.mjs —— 允许她说善意的谎，但给这个谎配一个「破绽」（2026-11-01）
//
// 用法：
//   node 露馅.mjs --lie "我没事" --truth "其实有点烦" --tell 短
//   node 露馅.mjs --show          # 看现在挂着哪个谎、破绽是什么
//   node 露馅.mjs --clear         # 谎被看穿或自己说了实话
//
// 为什么这么写：
//   · 全诚实不像人，滴水不漏也不像人。人会说「我没事」，然后露出来。
//   · 破绽不是让她自曝，是给对方的线索：话变短、冒出「大概/应该」、重复用词、
//     或者隔一会儿自己补一句。她自己不点破，对方能不能看出来是对方的事。
//   · 只允许「善意」的谎：涉及钱、承诺、别人的隐私一律不许，写死在这。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// LIE_MEM 给测试指沙盒：一个谎挂 12 小时，测一次就多一条真账。
const base = process.env.LIE_MEM || (process.platform === 'win32' ? 'B:/肥鱼/记忆' : '{{BOT_ROOT}}/记忆')
const path = join(base, '谎言.json')
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const load = () => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return { current: null, history: [] } } }
// 12 小时自动淡出。再久就不是「刚才那句没说实话」而是「设定」了，
// 而槽每轮都注入一句「你还瞒着」，久了会变成她的一种腔调。
const 过期毫秒 = 12 * 3600e3
const 过期了 = (c) => {
  const m = String((c && c.at) || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/)
  if (!m) return true
  const at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 8, +m[5], +(m[6] || 0))
  return !Number.isFinite(at) || Date.now() - at > 过期毫秒
}
const save = (o) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(o, null, 2), 'utf8') }

const db = load()

if (args.includes('--show')) {
  if (!db.current) { console.log('现在没有挂着谎'); process.exit(0) }
  if (过期了(db.current)) {
    console.log(`「${db.current.lie}」那个谎已经过去 12 小时了，不再影响你说话（要说破就 --clear）`)
    process.exit(0)
  }
  console.log(`谎：「${db.current.lie}」 真相：「${db.current.truth}」 破绽：${db.current.tellDesc || db.current.tell}`)
  process.exit(0)
}

if (args.includes('--clear')) {
  if (db.current) db.history.push({ ...db.current, ended: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') })
  db.current = null
  save(db)
  console.log('谎撤了')
  process.exit(0)
}

const lie = val('--lie', '')
const truth = val('--truth', '')
const tell = val('--tell', '短')

if (!lie) { console.error('要 --lie 一句谎话（--truth 说真相，--tell 选破绽：短/含糊/重复/补一句）'); process.exit(1) }
if (!truth) { console.error('要 --truth 说真相 —— 没有真相就没有「瞒着」这回事'); process.exit(1) }

// 硬限制：只许善意的谎
// 只挡「不能拿来做善意的谎」的东西：钱、承诺、别人的隐私。
// 原来写的是 (钱|转账|借|承诺|答应|密码|身份证|别人|她|他) —— 「他」和「她」太宽，
// 「我怕他担心」「她问起来我就说」这种最典型的善意谎言会被直接拒掉，等于这工具不能用。
// 「借」也改窄：单独的「借」会误伤「借口」。
const FORBID = /(钱|转账|借(?!口)|红包|付款|承诺|答应过|密码|身份证|别人的?(事|秘密|隐私))/
if (FORBID.test(lie) || FORBID.test(truth)) {
  console.log('这种不说（涉及钱、承诺或别人的事），换个由头或者直说')
  process.exit(0)
}

const TELLS = {
  短: '话明显变短，答完就不接',
  含糊: '冒出「大概」「应该」「可能」这类词',
  重复: '反复用同一个词，像在解释',
  补一句: '过一会儿自己补一句没头没尾的话',
}
const tellDesc = TELLS[tell] || TELLS['短']

db.current = { lie, truth, tell, tellDesc, at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') }
save(db)
console.log(`挂上了：对外说「${lie}」，真相是「${truth}」，破绽表现——${tellDesc}`)
