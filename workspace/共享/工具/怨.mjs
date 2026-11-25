// 怨（仇恨）系统：仇会变深也会变浅，不按一个公式走（2026-11-01）
// 规则：
//   1 小怨（0~30）放一阵子自己就淡了——人记不住那么多小事（百分制）
//   2 中怨（30~60）慢慢淡，但要是又碰上同一件事，会跳一档
//   3 大怨（60+）几乎不会自己消，只有被认真处理（道歉、补偿、解释清楚）才会降
//   4 敏感、忧虑高的人，闲下来会反复想起，反而越想越怨（有概率小涨）
//   5 不熟的人：淡到「有点印象」就停住，不会降到讨厌——本来就不熟，谈不上恨
import { 改档 } from './_底层.mjs'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
// 2026-11-02 参数化：拟人阈值统一从 参数.json 的「拟人」段读，读不到用默认值
import { readFileSync as _rf } from 'node:fs'
let _PJ = {}
try { _PJ = JSON.parse(_rf('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)

import { join, dirname } from 'node:path'

// QQ_YUAN_MEM 沙盒：测试时不碰她真实的 怨.json
const base = process.env.QQ_YUAN_MEM || ('{{BOT_ROOT}}/记忆')
const path = join(base, '怨.json')
// 百分制：0-100，旧的 0-10 数据第一次跑时自动 ×10
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError

const db = load(path, { people: {} })
const now = Date.now()
// 2026-11-06 批次124：时间戳一律存北京时间。以前这里用 new Date(now).toISOString()，那是 UTC，比北京早 8 小时；而 Date.parse 读回来按本地时区解释，于是每次运行都多算 8 小时。
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

// 2026-11-06 批次124：裸字符串一律按北京时间解析。系统时区是 UTC，直接 Date.parse('2026-11-06 12:20')
// 会被当成 UTC，比北京时间早 8 小时；而本项目的落盘字符串都是北京墙上时间（跟 poll.js 一致）。
const 北京时刻 = (s) => {
  const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00')
  return Number.isFinite(t) ? t : 0
}

if (args.includes('--list')) {
  const rows = Object.entries(db.people || {})
  if (rows.length === 0) { console.log('心里没人让她怨'); process.exit(0) }
  for (const [u, r] of rows) console.log(`${u}：怨 ${r.level}/100，因为「${r.why}」，最近一次 ${r.at}`)
  process.exit(0)
}

if (args.includes('--tick')) {
  // 时间演化：每次跑都把怨往前推一点
  let changed = 0
  // LOCK 2026-11-17（批次607）：整档读改写改成 改档() 锁内重读。
  改档(path, (d) => {
    for (const [u, r] of Object.entries(d.people || {})) {
      // 缺 at / 格式坏 / 未来时间戳都当「刚记下」，不衰减也不污染 level
      const at = 北京时刻(r.at)
      const days = at ? Math.max(0, Math.floor((now - at) / 864e5)) : 0
      if (days < 1) continue
      let lv = Number(r.level || 0)
      const before = lv
      if (lv <= H('怨_淡得快上限', 30)) lv -= days * 5              // 小怨：淡得快（百分制）
      else if (lv <= H('怨_淡得慢上限', 60)) lv -= days * 2         // 中怨
      else lv -= days * 0.3                     // 大怨：几乎不动
      // 敏感的人会反复想起，有概率越想越深
      // YUAN_NO_RECUR 只给测试关掉随机复发，线上不设这个变量。
      if (!process.env.YUAN_NO_RECUR && Math.random() < H('怨_复发概率每天', 0.02) * days) lv += 5
      // 不熟的人最低停在 1（只是有点印象），不会降到讨厌
      const unknown = Number(r.familiar || 0) < 2
      lv = Math.max(unknown ? 10 : 0, Math.min(100, lv))
      r.level = Number(lv.toFixed(1))
      r.at = bj()
      if (r.level !== before) changed += 1
    }
  }, { people: {} })
  console.log(`怨气更新完，动了 ${changed} 个人的`)
  process.exit(0)
}

if (args.includes('--settle')) {
  // 被认真处理了：降得多，但不一定清零
  const u = val('--who', '')
  const cut = Number(val('--by', '3'))
  let 结果 = '对他没怨'
  改档(path, (d) => {
    const r = (d.people || {})[u]
    if (!r) return false
    r.level = Math.max(0, Number(r.level || 0) - cut * 10)
    r.at = bj()
    if (r.level <= 0) delete d.people[u]
    结果 = r.level <= 0 ? '消了' : `降到 ${r.level}/100`
  }, { people: {} })
  console.log(结果)
  process.exit(0)
}

const who = val('--who', '')
if (!who) { console.error('要 --who <QQ号>'); process.exit(1) }

// FROM_FEEL 2026-11-17（批次607）：负向 qq_feel 是「怨」唯一的实时来源。
// 别扭管当下（几十分钟~几小时），怨管长期（几天~几个月）；同一件事两边都记，
// 不是重复，是急性和慢性的两本账。只有她自己调 qq_feel 记了才算，系统不替她判定。
const FEEL_ADD = { 被骂: 2, 越界: 2, 被冷落: 1, 被打断: 0.5 }
const feelKind = val('--from-feel', '')
if (feelKind) {
  const add = FEEL_ADD[feelKind]
  if (!add) { console.log('这种感受不用记怨：' + feelKind); process.exit(0) }
  const why = val('--why', '')
  let 结果 = ''
  改档(path, (d) => {
    d.people = d.people || {}
    const cur = d.people[who] || { level: 0, why: '', at: '' }
    cur.level = Math.min(100, Number(cur.level || 0) + add * 10)
    cur.why = why || cur.why
    cur.at = bj()
    d.people[who] = cur
    结果 = `${who}：怨 ${cur.level}/100（${why || '没写原因'}）`
  }, { people: {} })
  console.log(结果)
  process.exit(0)
}

const add = Number(val('--level', '1'))
const why = val('--why', '')
let 结果 = ''
改档(path, (d) => {
  d.people = d.people || {}
  const cur = d.people[who] || { level: 0, why: '', at: '' }
  cur.level = Math.min(100, Number(cur.level || 0) + add * 10)
  cur.why = why || cur.why
  cur.at = bj()
  d.people[who] = cur
  结果 = `${who}：怨 ${cur.level}/100（${why || '没写原因'}）`
}, { people: {} })
console.log(结果)
