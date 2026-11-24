// 自主状态（自主.json 唯一写入口）。被 12 处引用，是全项目引用最多的库模块。
// 错了的后果：她的 state/place/since 三个字段互相打架，面板和对话说的不是一回事。
import fs from 'node:fs'

const 沙 = '/tmp/sb387'
const 清 = () => { fs.rmSync(沙, { recursive: true, force: true }); fs.mkdirSync(沙, { recursive: true }) }
const 读 = (名) => { try { return JSON.parse(fs.readFileSync(沙 + '/' + 名, 'utf8')) } catch { return null } }
const 写 = (名, v) => fs.writeFileSync(沙 + '/' + 名, JSON.stringify(v), 'utf8')

const { 改, 真位, 起, 文件名 } = await import('{{BOT_ROOT}}/共享/工具/自主状态.mjs')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])
const 近 = (名, 实, 期, 差 = 3000) => 场景.push([名, 实, 期, 差])

const T = Date.parse('2026-11-13T22:30:00+08:00')

// ══════════ 文件名 / 改 ══════════
加('文件名常量', 文件名, '自主.json')
{
  清()
  写('自主.json', { state: '发呆', place: '家', custom: '要保留' })
  const r = 改(沙, (a) => { a.state = '摸鱼'; return 'ok' })
  加('改 返回回调的返回值', r, 'ok')
  加('改 改了目标字段', 读('自主.json').state, '摸鱼')
  加('改 不碰没提到的字段', 读('自主.json').custom, '要保留')
}
{
  清()
  加('改 回调返回 false → 不写盘', 改(沙, () => false), null)
  加('改 回调 false 时文件仍不存在', fs.existsSync(沙 + '/自主.json'), false)
}
{
  清()
  const r = 改(沙, (a) => { a.x = 1 }, { state: '兜底态' })
  加('文件不存在 → 用兜底并改', 读('自主.json').state, '兜底态')
  加('兜底 + 改动都在', 读('自主.json').x, 1)
}

// ══════════ 真位 ══════════
{
  清()
  加('资产不存在 → 家', 真位(沙), '家')
  写('资产.json', { 位置: '便利店' })
  加('资产有位置 → 用它', 真位(沙), '便利店')
  写('资产.json', { 位置: '' })
  加('资产位置是空串 → 家', 真位(沙), '家')
  写('资产.json', {})
  加('资产没有位置字段 → 家', 真位(沙), '家')
  写('资产.json', { 位置: 0 })
  加('资产位置是数字 0 → 家（falsy）', 真位(沙), '家')
}

// ══════════ 起 ══════════
{
  清()
  写('资产.json', { 位置: '便利店' })
  起(沙, { state: '吃饭', since: T })
  const a = 读('自主.json')
  加('起：state 写入', a.state, '吃饭')
  加('起：since 用传入的', a.since, T)
  加('起：place 没传 → 用真位补', a.place, '便利店')
}
{
  清()
  写('资产.json', { 位置: '便利店' })
  写('自主.json', { state: '发呆', place: '家' })
  起(沙, { state: '摸鱼' })
  加('起：原档有 place → 不覆盖', 读('自主.json').place, '家')
  近('起：since 没传 → 按现在算', 读('自主.json').since, Date.now())
}
{
  清()
  写('自主.json', { state: '发呆', place: '家', note: '旧备注', nextAt: 123456, doneAt: 999 })
  起(沙, { note: '新备注' })
  const a = 读('自主.json')
  加('起：只改 note', a.note, '新备注')
  加('起：没传 state 就不动 state', a.state, '发呆')
  加('★ 起：没传 nextAt 就不动 nextAt（吃饭靠它拦人）', a.nextAt, 123456)
  加('起：没传 doneAt 就不动 doneAt', a.doneAt, 999)
}
{
  清()
  写('自主.json', { state: '发呆', nextAt: 123456 })
  起(沙, { nextAt: 0 })
  加('起：nextAt 显式传 0 → 写 0', 读('自主.json').nextAt, 0)
}
{
  清()
  起(沙, {})
  const a = 读('自主.json')
  加('起 传空对象：仍更新 since', typeof a.since, 'number')
  加('起 传空对象：不写 state', a.state, undefined)
}
{
  清()
  写('自主.json', { state: '发呆', log: [] })
  起(沙, { state: '吃饭', 记: true, note: '在餐厅' })
  const log = 读('自主.json').log
  加('记:true → 追加一条', log.length, 1)
  加('记的 state 是改后的', log[0].state, '吃饭')
  加('记的 note', log[0].note, '在餐厅')
  加('记的 at 是北京时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(log[0].at), true)
}
{
  清()
  写('自主.json', { state: '发呆', log: [{ at: 'x', state: 'a' }] })
  起(沙, { state: '摸鱼' })
  加('默认不记 log', 读('自主.json').log.length, 1)
}
{
  清()
  写('自主.json', { state: '发呆', log: Array.from({ length: 35 }, (_, i) => ({ at: 'x', state: 's' + i })) })
  起(沙, { state: '摸鱼', 记: true })
  const log = 读('自主.json').log
  加('log 最多留 30 条', log.length, 30)
  加('留的是最新的（最后一条是刚写的）', log[29].state, '摸鱼')
}
{
  清()
  写('自主.json', { state: '发呆', log: 'not-an-array' })
  起(沙, { state: '摸鱼', 记: true })
  加('log 是脏数据 → 重建数组', Array.isArray(读('自主.json').log), true)
  加('脏 log 重建后只有新的这条', 读('自主.json').log.length, 1)
}
{
  清()
  写('自主.json', { state: '发呆' })
  起(沙, { state: '吃饭', 记: true, nextMinutes: 15 })
  加('nextMinutes 只进 log，不进顶层', 读('自主.json').nextAt, undefined)
  加('log 里带 nextMinutes', 读('自主.json').log[0].nextMinutes, 15)
}
{
  // since 传 0 / 空串 / 负数 → 一律按现在算
  清()
  写('自主.json', { state: '发呆' })
  起(沙, { state: 'X', since: 0 })
  近('since 传 0 → 按现在', 读('自主.json').since, Date.now())

  // Number(-5) 是 truthy，所以负数会原样写进去 —— 只有 0/''/null 才回落到 now。
  // 脏数据隐患：谁传了负的时间戳，面板算「已经多久」会算出一个巨大的数。
  清()
  写('自主.json', { state: '发呆' })
  起(沙, { state: 'X', since: -5 })
  加('since 传负数 → 原样写入（falsy 只包括 0/空串/null）', 读('自主.json').since, -5)
}
{
  // ★ 状态推进.mjs 的「睡着」分支要传睡眠开始时刻，别丢
  清()
  起(沙, { state: '睡', since: T - 3600e3 })
  加('★ since 传早于现在的时刻 → 原样保留（睡着分支靠它）', 读('自主.json').since, T - 3600e3)
}

// ══════════ 连锁：起 之后 真位 会不会被带歪 ══════════
{
  清()
  写('资产.json', { 位置: '家' })
  起(沙, { state: '走动', place: '家' })
  写('资产.json', { 位置: '便利店' })   // 到达
  加('自主.place 不跟着资产变（资产是事实，自主是她以为）', 读('自主.json').place, '家')
  加('真位 跟着资产变', 真位(沙), '便利店')
}

let 过 = 0
const 败 = []
for (const [名, 实, 期, 差] of 场景) {
  const 同 = typeof 差 === 'number' && typeof 实 === 'number' ? Math.abs(实 - 期) <= 差
    : JSON.stringify(实) === JSON.stringify(期)
  if (同) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
fs.rmSync(沙, { recursive: true, force: true })
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
