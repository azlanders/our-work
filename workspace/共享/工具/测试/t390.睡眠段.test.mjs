// 睡眠段·段开始 / 段多长了 / 找开着的段。纯函数，不用沙箱。
// 这三条决定「这一觉睡了多久」—— 判错就把三天前那次崩掉的觉算进今晚。
const { 段开始, 段多长了, 找开着的段 } = await import('{{BOT_ROOT}}/共享/工具/睡眠段.mjs')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])
const 近 = (名, 实, 期, 差 = 1500) => 场景.push([名, 实, 期, 差])

const T = Date.parse('2026-11-13T22:00:00+08:00')
/** 北京格式的「T 减 h 小时」 */
const 北京减 = (h) => {
  const d = new Date(T - h * 3600e3 + 8 * 3600e3)
  return d.toISOString().slice(0, 16).replace('T', ' ')
}

// ══════════ 段开始 ══════════
{
  加('不带秒的北京时间', 段开始('2026-11-13 22:00'), T)
  加('带秒的北京时间', 段开始('2026-11-13 22:00:00'), T)
  加('带秒且非零', 段开始('2026-11-13 22:00:30'), T + 30_000)
  加('凌晨时段（跨日不跨月）', 段开始('2026-11-13 00:30'), Date.parse('2026-11-13T00:30:00+08:00'))
  加('坏字符串 → NaN', Number.isNaN(段开始('不是时间')), true)
  加('空串 → NaN', Number.isNaN(段开始('')), true)
  加('null → NaN', Number.isNaN(段开始(null)), true)
  加('undefined → NaN', Number.isNaN(段开始(undefined)), true)
  加('纯数字 0 → NaN（不当地址解析）', Number.isNaN(段开始(0)), true)
  加('数字时间戳字符串 → NaN', Number.isNaN(段开始('1763000000000')), true)
}

// ══════════ 段多长了 ══════════
{
  加('刚睡 0 小时', 段多长了(北京减(0), T), 0)
  近('睡了 1 小时', 段多长了(北京减(1), T), 1)
  近('睡了 8.5 小时', 段多长了(北京减(8.5), T), 8.5)
  加('start 坏了 → NaN', Number.isNaN(段多长了('坏的', T)), true)
  近('start 在未来 → 负数', 段多长了(北京减(-2), T), -2)
}

// ══════════ 找开着的段 ══════════
{
  加('不是数组 → 段 null', 找开着的段(null, T).段, null)
  加('空数组 → 段 null', 找开着的段([], T).段, null)
  加('全都有 end → 段 null', 找开着的段([{ start: 北京减(8), end: 北京减(1) }], T).段, null)
}
{
  // 一条正常开着的段
  const s = { start: 北京减(2), phases: [] }
  const r = 找开着的段([s], T)
  加('正常开着的段能被找到', r.段 === s, true)
  加('找到时不收尸体', r.收掉的.length, 0)
  加('找到时不动它的 end', r.段.end, undefined)
}
{
  // 多条形如「一次觉两条段」（历史病根）：最后一条有效就用最后一条
  const 旧 = { start: 北京减(8), phases: ['a'] }
  const 新 = { start: 北京减(2), phases: [] }
  const r = 找开着的段([旧, 新], T)
  加('两条开着的 → 取最后一条（最新）', r.段 === 新, true)
  加('两条开着的 → 不收旧的（读者那边有补丁）', r.收掉的.length, 0)
}
{
  // ★ 超过 12 小时的尸体要被收掉，然后往前找。
  //   注意判据是「从最后一条往前退」—— 只有挡在最后一条前面的尸体才会被收；
  //   最后一条本身就有效的话直接返回，前面躺着的尸体不管（读者那边的补丁兜着）。
  const 活 = { start: 北京减(1) }
  const 尸 = { start: 北京减(30) }
  const r = 找开着的段([活, 尸], T)
  加('★ 超 12 小时的尸体被收掉', r.收掉的.length, 1)
  加('★ 收掉的是那条尸体', r.收掉的[0] === 尸, true)
  加('★ 尸体被封成零长度', 尸.end, 尸.start)
  加('★ 尸体的 hours 记 0', 尸.hours, 0)
  加('★ 尸体带残缺说明', typeof 尸.残缺, 'string')
  加('★ 收掉尸体后仍能返回活的段', r.段 === 活, true)
}
{
  // 全部是尸体 → 段 null，全收
  const a = { start: 北京减(40) }
  const b = { start: 北京减(20) }
  const r = 找开着的段([a, b], T)
  加('全是尸体 → 段 null', r.段, null)
  加('全是尸体 → 全收（2 条）', r.收掉的.length, 2)
  加('全收之后两条都封了 end', !!(a.end && b.end), true)
}
{
  // 边界：正好 12 小时 → 还算「这一次」
  const s = { start: 北京减(12) }
  加('正好 12 小时 → 仍算开着的', 找开着的段([s], T).段 === s, true)
}
{
  // 12 小时零 1 分 → 收掉
  const s = { start: 北京减(12.02) }
  const r = 找开着的段([s], T)
  加('12 小时零 1 分 → 收掉', r.段, null)
  加('12 小时零 1 分 → 收掉 1 条', r.收掉的.length, 1)
}
{
  // start 在未来 → 负数时长 → 收掉（不许拿未来的段记今晚）
  const s = { start: 北京减(-3) }
  加('start 在未来 → 收掉', 找开着的段([s], T).段, null)
}
{
  // start 坏的 → NaN → 收掉
  const s = { start: '坏的' }
  加('start 是坏的 → 收掉', 找开着的段([s], T).段, null)
}
{
  // 自定义 最多小时
  const s = { start: 北京减(3) }
  加('最多小时=2 时，3 小时的段被收', 找开着的段([s], T, 2).段, null)
  加('最多小时=2 时，收掉 1 条', 找开着的段([{ start: 北京减(3) }], T, 2).收掉的.length, 1)
  加('最多小时=12 时，3 小时的段保留', 找开着的段([{ start: 北京减(3) }], T, 12).段 !== null, true)
}
{
  // 数组里有 null / 字符串
  const 活 = { start: 北京减(1) }
  加('数组里有 null 不崩', 找开着的段([null, 活], T).段 === 活, true)
  // 批次385 已修：filter 加了 typeof object，字符串段直接跳过。
  //（原来 'abc' 也算「没有 end」，收尸体时给它赋 s.end → ESM 严格模式抛 TypeError，
  //  睡眠.json 里混进一个字符串整个睡眠判定就崩。）
  加('数组里混进字符串段 → 跳过不崩、返回 null（批次385 修）', 找开着的段(['abc'], T).段, null)
  加('字符串段 + 一条活的 → 认那条活的', 找开着的段(['abc', 活], T).段 === 活, true)
}
{
  // 已封的段（有 end）不参与
  const 封 = { start: 北京减(13), end: 北京减(5) }
  const 活 = { start: 北京减(1) }
  加('已封的段不参与挑选', 找开着的段([封, 活], T).段 === 活, true)
  加('已封的段不收尸体', 找开着的段([封, 活], T).收掉的.length, 0)
}

let 过 = 0
const 败 = []
for (const [名, 实, 期, 差] of 场景) {
  const 同 = typeof 差 === 'number' && typeof 实 === 'number' ? Math.abs(实 - 期) <= 差
    : JSON.stringify(实) === JSON.stringify(期)
  if (同) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
