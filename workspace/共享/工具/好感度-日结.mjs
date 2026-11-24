#!/usr/bin/env node
// 好感度-日结.mjs v2 —— 每天收集「谁今天说了几句」，然后调 好感度.mjs 记账
//
// ── 为什么重写（批次299，2026-11-09）──────────────────────────────
//
// v1 自己算 dims、自己写 好感度.json，而 奖惩.mjs 也直接改 score —— 两个写方
// 互相覆盖；更要命的是它只认一个群、没群日志就 exit 1，而私聊计数在 20 行之后
// 才读，主人永远轮不到（分数从 11-04 冻在 60）。
//
// v2 只做采集：群日志（当天所有群）+ 互动.json（私聊）→ 每人调一次
// `好感度.mjs --event 日结`。算分、衰减、日志、幂等，全在引擎里，只有一个写入口。
//
// 用法：
//   node 好感度-日结.mjs                # 结今天
//   node 好感度-日结.mjs --day 2026-11-08
//   node 好感度-日结.mjs --dry
import { readFileSync, existsSync, readdirSync, writeFileSync, renameSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { 有效感受 } from './有效感受.mjs'

const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
const dry = args.includes('--dry')

const SELF = '3556352474'
const 引擎 = join(dirname(fileURLToPath(import.meta.url)), '好感度.mjs')
// REL_BRIDGE 2026-11-09（批次307）：日结是「每天必跑、覆盖所有人」的天然兜底点，
// 顺手把今天的互动落到关系双量上，免得关系.json 只有 qq_feel 一条腿。
const 关系引擎 = join(dirname(fileURLToPath(import.meta.url)), '关系.mjs')
// QQ_MEM 2026-11-09（批次342）：允许沙盒注入。硬编码的路径 = 这段逻辑永远只能上线上试。
const MEM = process.env.QQ_MEM || '{{BOT_ROOT}}/记忆'
// 统一用 FAV_FILE（引擎的约定）；AFF_FILE 保留兼容上一版测试脚本。
const affPath = process.env.FAV_FILE || process.env.AFF_FILE || join(MEM, '好感度.json')
// 沙盒里 FAV_FILE 换了目录，关系引擎也得跟着换，否则测试会写进真实档
const 关系基 = process.env.HJ_BASE || (affPath === join(MEM, '好感度.json') ? MEM : dirname(affPath))
const interactPath = process.env.INTERACT_FILE || join(MEM, '互动.json')

// TZ_FIX 2026-11-03：服务器是 UTC，统一按北京时间取「今天」
const now = new Date(Date.now() + 8 * 3600 * 1000)
const day = val('--day', now.toISOString().slice(0, 10))

// ── 1. 收集 ───────────────────────────────────────────────────────
const counts = new Map()
const add = (uin, name) => {
  if (!uin || String(uin) === SELF) return
  const k = String(uin)
  const cur = counts.get(k) || { n: 0, name: '' }
  cur.n += 1
  if (!cur.name && name) cur.name = name
  counts.set(k, cur)
}

const logDirs = ['B:/肥鱼/群聊日志', join(MEM, '..', '群聊日志')]
const logs = []
for (const d of logDirs) {
  if (!existsSync(d)) continue
  for (const f of readdirSync(d)) {
    if (!/\.(jsonl|log)$/.test(f)) continue
    if (!f.includes(day) && !f.includes(day.replace(/-/g, ''))) continue
    logs.push(join(d, f))
  }
}
if (!logs.length) console.error('今天没有群聊日志（只用私聊计数）：' + day)

for (const p of logs) {
  if (p.endsWith('.jsonl')) {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        const j = JSON.parse(line)
        add(j.sender?.user_id ?? j.user_id, j.sender?.card || j.sender?.nickname)
      } catch { /* 坏行跳过 */ }
    }
  } else {
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/\((\d{6,})\)[:：]/)
      if (m) add(m[1], '')
    }
  }
}

// INTERACT 2026-11-08（批次246）：私聊条数。没有群日志也必须读。
try {
  if (existsSync(interactPath)) {
    const db = JSON.parse(readFileSync(interactPath, 'utf8')) || {}
    for (const [uin, 天表] of Object.entries(db)) {
      const n = Number((天表 || {})[day])
      if (Number.isFinite(n) && n > 0) for (let i = 0; i < n; i += 1) add(uin, '')
    }
  }
} catch { /* 没有私聊计数就只算群聊 */ }

// ── 2. 每人调一次引擎 ─────────────────────────────────────────────
let db = { people: {} }
try { db = JSON.parse(readFileSync(affPath, 'utf8')) || { people: {} } } catch { /* 空库 */ }
const people = (db && db.people) || {}

const report = []
for (const [uin, { n, name }] of counts) {
  const 是主人 = uin === '{{OWNER_UIN}}'
  const old = people[uin] || {}
  if (old['结算日'] === day) { report.push(`${uin}${name ? '(' + name + ')' : ''} 今天已经结过（${day}），跳过`); continue }

  const 旧轮 = Number(old.turns || 0)
  const 新轮 = 旧轮 + n
  // 熟悉度沿用 v1 的公式（它跟分数是两件事，动它就是改判档，不在这批范围里）
  const rounds = Math.round(n / 3)
  const totalRounds = 新轮 || rounds
  const ev = (Array.isArray(old.log) ? old.log : []).filter((x) => /分享|道歉|和好|冒犯|被骂/.test(String(x && x.kind))).length
  const nick = String(old.nick ?? '').length > 0 ? 10 : 0
  const fam = Math.min(100, Math.min(40, totalRounds * 2) + 15 + Math.min(20, ev * 5) + nick + 5)
  const delta = Math.min(3, 1 + Math.floor(Math.max(1, Math.round(n / 3)) / 5))

  const argv = [
    引擎, '--who', uin, '--event', '日结', '--n', String(n),
    '--fam', String(fam), '--turns', String(新轮), '--settle', day,
    '--why', `今天说了 ${n} 句${name ? '（' + name + '）' : ''}`,
  ]
  if (是主人) argv.push('--only-display')
  if (dry) argv.push('--dry')
  try {
    // 子进程必须拿到同一个 FAV_FILE，否则引擎会读默认路径（上次就是这么差点写错档）
    const out = execFileSync(process.execPath, argv, { encoding: 'utf8', timeout: 15000, env: { ...process.env, FAV_FILE: affPath } }).trim()
    report.push(out || `${uin} 已结`)
    // 关系双量：今天说过话就算一次「陪伴」。bond 每天上限 +0.01 由 关系.mjs 自己管，
    // 所以这里每天调一次不会把谁刷成熟人。--dry 时不写。
    if (!dry) {
      try {
        execFileSync(process.execPath, [关系引擎, '--who', uin, '--事件', '陪伴', '--why', `今天说了 ${n} 句`],
          { encoding: 'utf8', timeout: 8000, env: { ...process.env, HJ_BASE: 关系基 } })
      } catch (e) { report.push(`${uin} 关系没更新：${String((e && e.message) || e).slice(0, 60)}`) }
    }
  } catch (e) {
    report.push(`${uin} 结账失败：${String((e && e.message) || e).slice(0, 80)}`)
  }
}

// ── 3. 欲望结算（批次342）────────────────────────────────────────
//
// 「想要.json」原来没有任何写入端：自改.mjs 白名单里有它，但自改.mjs 零调用方，
// 她碰不到 —— 于是 11-01 写下的两条欲望一直冻着，梦和复盘又都读错字段。
//
// 这里只做一件事：给**已经写着「判据」的条目**调 strength。
//   · 不新增条目、不删条目 —— 「想要什么」是她自己的判断
//   · 判据是稳定值（有人找 / 被夸），不看 what 的字面（名字她会改）
//   · 满足到 0 就移进「满足的」并记日期，不丢
//   · 没有判据的条目一律不动（宁可不动，也不替她判断）
try {
  if (!dry) 结算欲望(day, report)
} catch (e) {
  report.push('欲望没结算：' + String((e && e.message) || e).slice(0, 60))
}

console.log(report.join('\n') || '今天没人说话')

/** 今天满足了几件事。判据只有两种，都来自已经存在的数据。 */
function 今日证据(day) {
  const 证 = {}
  // ① 有人跟她说话（counts 已经在上面排除她自己了）
  try { 证.有人找 = counts.size > 0 } catch { 证.有人找 = false }
  // ② 她被夸过（感受.jsonl 里 at 以今天开头、kind=被夸）
  try {
    const p = join(MEM, '感受.jsonl')
    let 夸 = false
    if (existsSync(p)) {
      for (const row of 有效感受(readFileSync(p, 'utf8'))) {
        if (row.kind === '被夸' && String(row.at || '').startsWith(day)) { 夸 = true; break }
      }
    }
    证.被夸 = 夸
  } catch { 证.被夸 = false }
  return 证
}

function 结算欲望(day, report) {
  const p = join(MEM, '想要.json')
  // WISH_SEED 2026-11-24：原来 `if (!existsSync(p)) return` —— 文件不在就静默退出，
  // 而全仓**没有任何创建端**。结果：建实例起 `想要.json` 一直是空的，
  // 纪念日条()/readWjOnce()/话题.mjs/voiceSlots.js 全部读不到东西，
  // 四条能力（纪念日 / 当下想要 / 怕的 / 独处的时候在想）静默失效 —— 不报错，所以没人发现。
  // 现在缺就按骨架补一份：只建空壳，不替她编内容（「想要什么」是她自己的判断）。
  if (!existsSync(p)) {
    const 骨骸 = {
      说明: '她想要的东西。没有欲望就没有主动性——这份文件是主动开口的燃料。',
      当下想要: [],
      纪念日: [],
      怕的: [],
      满足的: [],
      独处的时候在想: [],
      _接入情况: {
        '活段（有代码读）': ['当下想要', '满足的', '怕的', '纪念日', '独处的时候在想'],
        '删掉的段': '想约的/对未来的想象/第一次/承诺 —— 2026-11-14（批次422）删：全仓 0 处读',
        本文件由谁创建: '好感度-日结.mjs 的 结算欲望()（WISH_SEED 2026-11-24）。原本没有任何创建端。',
      },
    }
    try {
      const 临时 = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
      writeFileSync(临时, JSON.stringify(骨骸, null, 2) + '\n', 'utf8')
      renameSync(临时, p)
      report.push('想要.json 不存在，已按骨架补建（内容留空，等她自己填）')
    } catch (e) {
      report.push('想要.json 补建失败：' + String((e && e.message) || e).slice(0, 50))
      return
    }
  }
  const j = JSON.parse(readFileSync(p, 'utf8')) || {}
  const list = Array.isArray(j['当下想要']) ? j['当下想要'] : []
  if (!list.length) return
  const 证 = 今日证据(day)
  const 留 = []
  const 满足 = Array.isArray(j['满足的']) ? j['满足的'] : []
  let 动了 = 0

  for (const x of list) {
    const 判据 = String(x?.判据 ?? '')
    const 强 = Number(x?.strength)
    if (判据 === '' || !Number.isFinite(强)) { 留.push(x); continue } // 没判据 = 不动
    if (证[判据] === true && 强 > 0) {
      const 新 = 强 - 1
      动了 += 1
      if (新 <= 0) {
        满足.push({ what: x.what, since: x.since || '', 满足于: day, 判据 })
        report.push('欲望满足：' + String(x.what || '').slice(0, 20))
        continue
      }
      x.strength = 新
    }
    留.push(x)
  }
  if (!动了) return
  j['当下想要'] = 留
  j['满足的'] = 满足.slice(-40)
  const tmp = p + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  writeFileSync(tmp, JSON.stringify(j, null, 2) + '\n', 'utf8')
  renameSync(tmp, p)
}
