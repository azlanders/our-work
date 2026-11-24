// 移动（唯一搬人入口）：出发 / 到了 / 瞬移。只测不改。
//
// 出发() 里会真的 execFileSync 调一次 物品.mjs --带伞（env 继承 process.env），
// 所以必须先把 QQ_AUTONOMY_MEM 指到沙箱 —— 那是物品.mjs 的唯一目录来源。
// 同时带指纹防线：真实 资产/自主/状态.json 变了就说明 env 没盖住。
import fs from 'node:fs'

const 沙 = '/tmp/sb883'
const 真 = '{{BOT_ROOT}}/记忆'
const 真档 = [真 + '/资产.json', 真 + '/自主.json', 真 + '/状态.json', 真 + '/物品.json']
const 指纹 = (p) => { try { const s = fs.statSync(p); return s.size + ':' + Math.round(s.mtimeMs) } catch { return '无' } }
const 前 = 真档.map(指纹).join('|')

fs.rmSync(沙, { recursive: true, force: true })
fs.mkdirSync(沙, { recursive: true })
fs.mkdirSync(沙 + '/日志', { recursive: true })
// 物品.mjs 要一份物品账，给它空的（不带伞那条路读不到东西就 exit 0）
fs.writeFileSync(沙 + '/物品.json', JSON.stringify({ items: [] }), 'utf8')

process.env.QQ_AUTONOMY_MEM = 沙
process.env.QQ_MEM = 沙
process.env.ITEM_MEM = 沙

const { 出发, 到了, 瞬移 } = await import('{{BOT_ROOT}}/共享/工具/移动.mjs')
const 读档 = (名) => { try { return JSON.parse(fs.readFileSync(沙 + '/' + 名, 'utf8')) } catch { return null } }
const 写档 = (名, v) => fs.writeFileSync(沙 + '/' + 名, JSON.stringify(v), 'utf8')
const 清 = () => { for (const f of ['资产.json', '自主.json', '状态.json']) { try { fs.unlinkSync(沙 + '/' + f) } catch { /* 没有 */ } } }

const T = Date.parse('2026-11-13T22:00:00+08:00')
const 米 = 60 * 1000
const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])
const 近 = (名, 实, 期, 差 = 2) => 场景.push([名, 实, 期, 差])

// ══════════ 出发 ══════════
{
  清()
  写档('资产.json', { 钱: 100, 位置: '家' })
  写档('自主.json', { state: '发呆', place: '家', since: T - 3600e3 })
  const r = 出发(沙, { 从: '家', 到: '便利店', 分钟: 10, 现在: T })
  加('A1 返回的到达时刻', r.arriveAt, T + 10 * 米)
  加('A1 返回的分钟', r.分钟, 10)
  const 资 = 读档('资产.json')
  加('A2 ★ 位置仍是出发地（不是目的地）', 资.位置, '家')
  加('A2 在途.to', 资.在途.to, '便利店')
  加('A2 在途.from', 资.在途.from, '家')
  加('A2 在途.startAt', 资.在途.startAt, T)
  加('A2 在途.arriveAt', 资.在途.arriveAt, T + 10 * 米)
  加('A2 在途.minutes', 资.在途.minutes, 10)
  加('A2 钱没被动', 资.钱, 100)
  const 自 = 读档('自主.json')
  加('A3 自主.state 变走动', 自.state, '走动')
  加('A3 自主.place 是出发地', 自.place, '家')
  加('A3 自主.since', 自.since, T)
  加('A3 自主.doneAt', 自.doneAt, T + 10 * 米)
  加('A3 ★ nextAt 推到到达之后（否则一分钟后被按回原地）', 自.nextAt, T + 10 * 米 + 30e3)
}
{
  // 不传 from → 用资产里的位置
  清()
  写档('资产.json', { 钱: 0, 位置: '便利店' })
  写档('自主.json', { state: '发呆', place: '便利店' })
  出发(沙, { 到: '家', 分钟: 5, 现在: T })
  加('A4 不传 from → 资产那边回退到当前位置', 读档('资产.json').在途.from, '便利店')
  // 批次385 已修：自主.place 改成 `从 || aut.place || '家'`，与 资产.位置 的口径对齐。
  //（原来只写 `从 || ''`，不传 从 时资产记当前位置、自主变空串 ——「她不知道自己在哪」。）
  加('A4 不传 from → 自主.place 也回退到当前位置（批次385 修）', 读档('自主.json').place, '便利店')
}
{
  // 资产里连位置都没有 → 默认家
  清()
  写档('资产.json', { 钱: 0 })
  写档('自主.json', { state: '发呆' })
  出发(沙, { 到: '街市', 分钟: 5, 现在: T })
  加('A5 没有位置 → 默认家', 读档('资产.json').在途.from, '家')
}
{
  // 分钟的各种脏值都要夹到 >=1
  for (const [名, 值, 期] of [['0', 0, 1], ['负数', -5, 1], ['小数', 2.6, 3], ['NaN', NaN, 1], ['字符串', '7', 7], ['不传', undefined, 1]]) {
    清()
    写档('资产.json', { 位置: '家' })
    写档('自主.json', { state: '发呆' })
    const r = 出发(沙, { 到: '便利店', 分钟: 值, 现在: T })
    加(`A6 分钟=${名} → ${期}`, r.分钟, 期)
  }
}
{
  // ★ 睡着的人不迈腿：state 保持「睡觉」，只补 place
  清()
  写档('资产.json', { 位置: '家' })
  写档('自主.json', { state: '睡觉', place: '家' })
  出发(沙, { 从: '家', 到: '便利店', 分钟: 10, 现在: T })
  const 自 = 读档('自主.json')
  加('A7 ★ 睡着被搬：state 不许改成走动（否则等于替她宣布醒着）', 自.state, '睡觉')
  加('A7 睡着被搬：只补 place', 自.place, '家')
  加('A7 睡着被搬：不写 nextAt', 自.nextAt, undefined)
  // 但资产那边照样有在途 —— 这是事实层
  加('A7 资产仍记了在途', 读档('资产.json').在途.to, '便利店')
}
{
  // 打瞌睡也算「睡」
  清()
  写档('资产.json', { 位置: '家' })
  写档('自主.json', { state: '打瞌睡', place: '家' })
  出发(沙, { 到: '便利店', 分钟: 5, 现在: T })
  加('A8 打瞌睡也按睡着处理', 读档('自主.json').state, '打瞌睡')
}
{
  // 重复出发 → 覆盖成新的一段
  清()
  写档('资产.json', { 位置: '家' })
  写档('自主.json', { state: '发呆' })
  出发(沙, { 从: '家', 到: '便利店', 分钟: 10, 现在: T })
  出发(沙, { 从: '便利店', 到: '街市', 分钟: 3, 现在: T + 5 * 米 })
  加('A9 二次出发覆盖在途.to', 读档('资产.json').在途.to, '街市')
  加('A9 二次出发覆盖 arriveAt', 读档('资产.json').在途.arriveAt, T + 8 * 米)
}

// ══════════ 到了 ══════════
{
  清()
  写档('资产.json', { 钱: 0, 位置: '家' })
  加('B1 没在路上', JSON.stringify(到了(沙, T)), JSON.stringify({ ok: false, why: '没在路上' }))
}
{
  清()
  写档('资产.json', { 钱: 0, 位置: '家' })
  写档('自主.json', { state: '发呆' })
  出发(沙, { 从: '家', 到: '便利店', 分钟: 10, 现在: T })
  const r = 到了(沙, T + 4 * 米)
  加('B2 还没到：ok=false', r.ok, false)
  加('B2 还没到：why=还差', r.why, '还差')
  加('B2 还没到：剩 6 分钟', r.剩, 6)
  加('B2 还没到：位置不动', 读档('资产.json').位置, '家')
}
{
  清()
  写档('资产.json', { 钱: 0, 位置: '家' })
  写档('自主.json', { state: '发呆' })
  出发(沙, { 从: '家', 到: '便利店', 分钟: 10, 现在: T })
  const r = 到了(沙, T + 10 * 米)
  加('B3 ★ 刚好到点就走（判据是 arriveAt > now，等于算到了）', r.ok, true)
  加('B3 到的地方', r.到, '便利店')
  加('B3 从哪来', r.从, '家')
  加('B3 分钟数', r.分钟, 10)
  const 资 = 读档('资产.json')
  加('B3 位置变了', 资.位置, '便利店')
  加('B3 在途 清掉', 资.在途, undefined)
  加('B3 到此At', 资.到此At, T + 10 * 米)
  加('B3 记录 +1', 资.记录.length, 1)
  加('B3 记录内容', 资.记录[0].what, '从家走到便利店')
  加('B3 幂等：再调一次是没在路上', 到了(沙, T + 11 * 米).why, '没在路上')
}
{
  // 到了之后 自主.state 若是「走动」，时间戳对齐到到达时刻
  清()
  写档('资产.json', { 钱: 0, 位置: '家' })
  写档('自主.json', { state: '发呆' })
  出发(沙, { 从: '家', 到: '便利店', 分钟: 10, 现在: T })
  到了(沙, T + 10 * 米)
  const 自 = 读档('自主.json')
  加('B4 到达后 place 更新', 自.place, '便利店')
  加('B4 到达后 state 仍是走动（由后续流程改）', 自.state, '走动')
  加('B4 since 对齐到到达时刻', 自.since, T + 10 * 米)
}
{
  // 自主.json 不存在 → 同步到达 直接 return，不崩
  清()
  写档('资产.json', { 钱: 0, 位置: '家', 在途: { from: '家', to: '便利店', arriveAt: T, minutes: 1 } })
  const r = 到了(沙, T)
  加('B5 没有自主.json 也能到', r.ok, true)
}
{
  // 在途 是坏数据：arriveAt 是字符串
  清()
  写档('资产.json', { 钱: 0, 位置: '家', 在途: { from: '家', to: '便利店', arriveAt: String(T), minutes: 1 } })
  const r = 到了(沙, T)
  加('B6 arriveAt 是字符串数字 → 也能判到点', r.ok, true)
}
{
  // 在途 缺 arriveAt → Number(undefined) = NaN，`NaN > 现在` false → 会当成到了
  清()
  写档('资产.json', { 钱: 0, 位置: '家', 在途: { from: '家', to: '便利店' } })
  const r = 到了(沙, T)
  加('B7 ★ 在途缺 arriveAt 时会被当成「已到」（脏数据隐患）', r.ok, true)
}

// ══════════ 瞬移 ══════════
{
  清()
  写档('资产.json', { 钱: 0, 位置: '家' })
  写档('自主.json', { state: '发呆', place: '家' })
  const r = 瞬移(沙, '便利店', T)
  加('C1 瞬移 ok', r && r.ok !== false ? true : false, true)
  加('C1 位置直接变', 读档('资产.json').位置, '便利店')
  加('C1 自主.place 同步', 读档('自主.json').place, '便利店')
}
{
  清()
  写档('资产.json', { 钱: 0, 位置: '便利店' })
  写档('自主.json', { state: '发呆' })
  加('C2 本来就在这儿 → 返回 null', 瞬移(沙, '便利店', T), null)
  加('C2 不留假账', (读档('资产.json').记录 || []).length, 0)
}
{
  // 有在途时瞬移 → 清掉在途，不许留一段永远到不了的行程
  清()
  写档('资产.json', { 钱: 0, 位置: '家' })
  写档('自主.json', { state: '发呆' })
  出发(沙, { 从: '家', 到: '街市', 分钟: 20, 现在: T })
  瞬移(沙, '便利店', T + 米)
  const 资 = 读档('资产.json')
  加('C3 瞬移清在途', 资.在途, undefined)
  加('C3 瞬移后位置', 资.位置, '便利店')
}

// ══════════ 判分 ══════════
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
const 后 = 真档.map(指纹).join('|')
console.log(前 === 后 ? '\n真实文件未被触碰（指纹一致）' : '\n★★★ 真实文件被动了，本轮作废：\n  前 ' + 前 + '\n  后 ' + 后)
