// 睡眠阶段·刚醒 / 结算欠 / endSleep。只测不改。
//
// endSleep 是两条醒来路（被叫醒 / 自然醒）唯一的共同关卡，补课和欠觉账都在这儿结。
// 它有个坑写在注释里：SNAP_FIX 2026-11-12 —— 从没取过 stateSnap，引用未定义变量被
// 最外层 catch 吞成 fail()，11-10 起每次睡醒结算都静默失败。所以这里要验「真的写进去了」。
//
// 沙箱变量是 ST_BASE（不是 QQ_AUTONOMY_MEM），补课脚本认 QQ_CATCHUP_MEM。
// 测试只造 <60 分钟的觉 —— 那样不会触发 补课.mjs 的 execFileSync（它要 20 秒且读真实群聊日志）。
import fs from 'node:fs'

const 沙 = '/tmp/sb392'
const 真 = '{{BOT_ROOT}}/记忆'
const 清 = () => { fs.rmSync(沙, { recursive: true, force: true }); fs.mkdirSync(沙, { recursive: true }) }
const 写 = (名, v) => fs.writeFileSync(沙 + '/' + 名, JSON.stringify(v), 'utf8')
const 读 = (名) => { try { return JSON.parse(fs.readFileSync(沙 + '/' + 名, 'utf8')) } catch { return null } }

清()
process.env.ST_BASE = 沙
process.env.QQ_LOCK_DIR = 沙 + '/.locks'

const 真指纹 = (p) => { try { const s = fs.statSync(p); return s.size + ':' + Math.round(s.mtimeMs) } catch { return '无' } }
const 真档 = ['睡眠.json', '状态.json', '睡醒.json', '梦余味.json'].map((f) => 真 + '/' + f)
const 前 = 真档.map(真指纹).join('|')

const { 刚醒, endSleep } = await import('{{BOT_ROOT}}/共享/工具/睡眠阶段.mjs')
const { 结算欠 } = await import('{{BOT_ROOT}}/共享/工具/恢复目标.mjs')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])
const T = Date.parse('2026-11-13T22:00:00+08:00')
const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

// ══════════ 刚醒（纯函数）══════════
{
  const f = (改) => ({ sleeping: false, since: 北京(T - 10 * 60000), ...改 })
  加('null flag → false', 刚醒(null, T), false)
  加('undefined flag → false', 刚醒(undefined, T), false)
  加('sleeping:true → false（睡着不算刚醒）', 刚醒(f({ sleeping: true }), T), false)
  加('没有 since → false', 刚醒({ sleeping: false }, T), false)
  加('since 是空串 → false', 刚醒({ sleeping: false, since: '' }, T), false)
  加('刚醒 10 分钟 → true', 刚醒(f({}), T), true)
  加('刚醒 29 分钟 → true', 刚醒(f({ since: 北京(T - 29 * 60000) }), T), true)
  加('正好 30 分钟 → false（< 才成立）', 刚醒(f({ since: 北京(T - 30 * 60000) }), T), false)
  加('31 分钟前 → false', 刚醒(f({ since: 北京(T - 31 * 60000) }), T), false)
  加('since 在未来 → false', 刚醒(f({ since: 北京(T + 5 * 60000) }), T), false)
  加('since 是坏字符串 → false', 刚醒(f({ since: '坏的' }), T), false)
  加('minutes=60 时 30 分钟前 → true', 刚醒(f({ since: 北京(T - 30 * 60000) }), T, 60), true)
  加('minutes=60 时 61 分钟前 → false', 刚醒(f({ since: 北京(T - 61 * 60000) }), T, 60), false)
  加('sleeping 是字符串 "false" → 仍算醒着（只判 ===true）', 刚醒(f({ sleeping: 'false' }), T), true)
}

// ══════════ 结算欠（纯函数）══════════
加('旧欠 0 + 睡 8 小时 → 0', 结算欠(0, 8), 0)
加('旧欠 10 + 睡 8 小时 → 8.5（先衰减 15%）', 结算欠(10, 8), 8.5)
加('旧欠 10 + 睡 6 小时 → 10.5（8.5 + 欠 2）', 结算欠(10, 6), 10.5)
加('旧欠 10 + 睡 9 小时 → 7.5（8.5 - 还 1）', 结算欠(10, 9), 7.5)
加('旧欠 0 + 睡 0 小时 → 8（整觉欠 8）', 结算欠(0, 0), 8)
加('旧欠 0 + 睡 16 小时 → 0（还 8，不出现负数）', 结算欠(0, 16), 0)
加('封顶 24', 结算欠(100, 0), 24)
加('旧欠是负数 → 当 0', 结算欠(-5, 8), 0)
加('旧欠是 NaN → 当 0', 结算欠(NaN, 8), 0)
加('小时是 NaN → 当 0（相当于没睡）', 结算欠(0, NaN), 8)
加('旧欠是字符串 "10" → 照算', 结算欠('10', 8), 8.5)
加('旧欠 10 连睡三晚 8 小时 → 逐晚衰减', [结算欠(10, 8), 0, 0].length, 3)
// NAP_NOT_DEBT 2026-11-17（批次674）：线上一次 4.9 分钟微睡记了 +7.92，
// 欠觉从 8.9 抬到 16.8。打盹不该记整夜的账。
加('打盹 4.9 分钟 → 旧欠不变（线上那笔 16.8 的根因）', 结算欠(10, 4.9 / 60), 10)
加('打盹 30 分钟 → 不加欠、也不衰减', 结算欠(0, 0.5), 0)
加('睡 59 分钟 → 仍按打盹处理（门槛 4 小时）', 结算欠(10, 59 / 60), 10)
加('2 小时午睡（11-17 13:48→15:52）→ 仍按打盹，不记 +5.9', 结算欠(10, 2), 10)
加('睡满 4 小时 → 才开始按整夜算（欠 4）', 结算欠(0, 4), 4)
加('显式传「不是整觉」→ 不记账', 结算欠(10, 8, false), 10)
{
  let x = 10
  for (let i = 0; i < 3; i++) x = 结算欠(x, 8)
  加('10 的欠，连睡三晚 8 小时 → 6.14 左右', Math.round(x * 100) / 100, 6.14)
}

// ══════════ endSleep ══════════
{
  清()
  加('睡眠.json 不存在 → fail', endSleep('wake').ok, false)
  加('fail 时 phase 是 null', endSleep('wake').phase, null)
}
{
  清()
  写('睡眠.json', { sleeping: false })
  加('没有 live → fail（靠 live 关段，不靠 sleeping）', endSleep('wake').ok, false)
}
{
  // 30 分钟的觉，正常结算
  清()
  // endSleep 内部取 Date.now()，所以段的起点必须基于「现在」，不能用固定的 T
  const 现在 = Date.now(), 起 = 现在 - 30 * 60000
  写('睡眠.json', {
    sleeping: true, sleepSince: 起,
    live: { phase: 'N2', cycle: 1, start: 北京(起), startMs: 起, deep_min: 10, light_min: 15, rem_min: 5 },
    segments: [{ start: 北京(起), phases: [] }],
    records: [], 欠: 0,
  })
  写('状态.json', { mood: { intensity: 0 }, layers: { emotional: 50 } })
  const r = endSleep('wake')
  加('正常结算 ok', r.ok, true)
  加('返回 phase', r.phase, 'N2')
  加('返回 deep_min', r.deep_min, 10)
  加('返回 rem_min', r.rem_min, 5)
  const d = 读('睡眠.json')
  加('live 被清空', d.live, null)
  加('sleeping 变 false', d.sleeping, false)
  加('last_sleep 落了盘', typeof d.last_sleep, 'object')
  加('last_sleep 带 reasoning 字段', d.last_sleep.reason, 'wake')
  加('last_sleep 时长对', d.last_sleep.start, 北京(起))
  加('records 追加一条', d.records.length, 1)
  加('★ 段被关上了（不是残段）', d.segments[0].end !== undefined, true)
  加('★ 段带 hours', d.segments[0].hours, 0.5)
  加('欠觉账被结算（睡 0.5 小时 → 欠 7.5）', d.欠, 7.5)
  const st = 读('状态.json')
  加('★ 状态.json 真被写了（SNAP_FIX 那条）', typeof st.mood, 'object')
}
{
  // N3 醒来 → inertia + 情绪下坠
  清()
  const 现在 = Date.now(), 起 = 现在 - 45 * 60000
  写('睡眠.json', {
    sleeping: true, live: { phase: 'N3', cycle: 2, start: 北京(起), startMs: 起, deep_min: 30, light_min: 10, rem_min: 0 },
    segments: [], records: [], 欠: 0,
  })
  写('状态.json', { mood: { intensity: 0.5 }, layers: { emotional: 50 } })
  endSleep('wake')
  const d = 读('睡眠.json')
  加('N3 醒来带 inertia', typeof d.last_sleep.inertia, 'object')
  加('inertia 有 until 和 penalty', typeof d.last_sleep.inertia.penalty, 'number')
  加('inertia.penalty 是 0.35', d.last_sleep.inertia.penalty, 0.35)
  const st = 读('状态.json')
  加('N3 醒来情绪 -0.3', Math.round(st.mood.intensity * 100) / 100, 0.2)
}
{
  // 梦余味：日期对得上就动情绪，且标记已用
  清()
  const 现在 = Date.now(), 起 = 现在 - 30 * 60000
  写('睡眠.json', {
    sleeping: true, live: { phase: 'N2', cycle: 1, start: 北京(起), startMs: 起, deep_min: 5, light_min: 20, rem_min: 5 },
    segments: [], records: [], 欠: 0,
  })
  写('状态.json', { layers: { emotional: 50 } })
  const 今天 = 北京(Date.now()).slice(0, 10)
  写('梦余味.json', { date: 今天, 余味: '有点像那时候', 好: true })
  endSleep('wake')
  const st = 读('状态.json')
  加('梦余味「好」→ 情绪 +2', st.layers.emotional, 52)
  加('梦余味标记已用', 读('梦余味.json')['情绪已用'], true)
}
{
  // 梦余味日期不对 → 不用
  清()
  const 现在 = Date.now(), 起 = 现在 - 30 * 60000
  写('睡眠.json', {
    sleeping: true, live: { phase: 'N2', cycle: 1, start: 北京(起), startMs: 起, deep_min: 5, light_min: 20, rem_min: 5 },
    segments: [], records: [], 欠: 0,
  })
  写('状态.json', { layers: { emotional: 50 } })
  写('梦余味.json', { date: '2026-01-01', 余味: '旧的', 好: true })
  endSleep('wake')
  加('日期不对 → 情绪不动', 读('状态.json').layers.emotional, 50)
  加('日期不对 → 不标记已用', 读('梦余味.json')['情绪已用'], undefined)
}
{
  // records / segments 都会裁到 30 条
  清()
  const 现在 = Date.now(), 起 = 现在 - 30 * 60000
  写('睡眠.json', {
    sleeping: true, live: { phase: 'N2', cycle: 1, start: 北京(起), startMs: 起, deep_min: 5, light_min: 20, rem_min: 5 },
    records: Array.from({ length: 35 }, () => ({ start: 'x' })),
    segments: Array.from({ length: 35 }, () => ({ start: 'x', end: 'y' })),
    欠: 0,
  })
  写('状态.json', {})
  endSleep('wake')
  const d = 读('睡眠.json')
  加('records 裁到 30', d.records.length, 30)
  加('segments 裁到 30', d.segments.length, 30)
  加('裁掉的是最早的（最后一条是刚 wrote 的）', d.records[29].reason, 'wake')
}

// ── 真文件防线 ──
fs.rmSync(沙, { recursive: true, force: true })
let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (JSON.stringify(实) === JSON.stringify(期)) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
const 后 = 真档.map(真指纹).join('|')
if (前 !== 后) console.log('\n⚠ 真实睡眠文件有变化（可能只是心跳在写，不一定是污染）：\n  前 ' + 前 + '\n  后 ' + 后)
