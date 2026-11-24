// 关系槽 slotRelationBond（voiceSlots.js）。只测不改。
//
// 这个槽的坑有据可查：批次307 迁移后 12 个人 safety 全是 0.55，原判据要求 safety>=0.6，
// 于是它对谁都不出声 —— 连 bond 0.75 的主人也一句话没有。批次307b 改成 bond 主导、
// safety 只做否决（<=0.28 才叫戒备）。下面逐档钉住这个新契约。
import fs from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 沙 = '/tmp/sb884'
const 关路 = 沙 + '/关系.json'
const 清 = () => {
  fs.rmSync(沙, { recursive: true, force: true })
  fs.mkdirSync(沙, { recursive: true })
}
const 写关系 = (people) => fs.writeFileSync(关路, JSON.stringify({ people }), 'utf8')

const { slotRelationBond } = await import('{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/voiceSlots.js')

const 场景 = []
const 加 = (名, 实, 期) => 场景.push([名, 实, 期])

const ctx = (peer = '{{OWNER_UIN}}') => ({ peer, memDir: 沙, now: Date.parse('2026-11-13T22:00:00+08:00'), statSync: fs.statSync })
/** people === undefined 表示「不写文件，用当前沙箱里的」。 */
const 跑 = (people, peer = '{{OWNER_UIN}}') => {
  if (people !== undefined) 写关系(people)
  return slotRelationBond(ctx(peer))
}

// ── 兜底 ──
清()
加('没有 ctx', slotRelationBond(null), '')
加('ctx 没有 peer', slotRelationBond({ memDir: 沙 }), '')
// 这里没有防御：join(undefined, '关系.json') 直接抛 TypeError。
// 线上 extraHintOf 每次都传 memDir，所以不是问题，但契约上要知道这一点。
加('ctx 没有 memDir → 抛 TypeError（调用方必须传）', (() => {
  try { return slotRelationBond({ peer: '1' }) } catch (e) { return e instanceof TypeError ? 'TypeError' : '别的错' }
})(), 'TypeError')
清()
加('关系.json 不存在', 跑(undefined), '')
加('人不在 people 里', 跑({ 999: { bond: 0.9, safety: 0.9 } }), '')
清()
fs.writeFileSync(关路, '{坏掉', 'utf8')
加('关系.json 是坏 JSON', 跑(undefined), '')

// ── safety 否决线 0.28 ──
加('safety 0.10 → 戒备', 跑({ x: { safety: 0.1, bond: 0.9 } }, 'x').startsWith('[安全感] 对TA还有点戒备'), true)
加('safety 0.28 整（边界，含）→ 戒备', 跑({ x: { safety: 0.28, bond: 0.9 } }, 'x').startsWith('[安全感]'), true)
加('safety 0.29 → 不戒备', 跑({ x: { safety: 0.29, bond: 0.9 } }, 'x').startsWith('[安全感]'), false)
// 文案对齐 2026-11-17（批次643）：线上这句早就不带「话别交底」了（行为指令已按拟人化红线删掉），
// 但这条断言没跟着改 —— 说明它长期没在跑。现在钉住真实文案，只留事实（谁、多少）。
加('戒备时带出 safety 数字', 跑({ x: { safety: 0.12, bond: 0.9 } }, 'x'), '[安全感] 对TA还有点戒备（safety 0.12）')
加('safety 0（缺失当 0）也走戒备', 跑({ x: { bond: 0.9 } }, 'x').startsWith('[安全感]'), true)

// ── bond 三档（批次643：档位词改由 关系档.mjs 统一判，bond 仍是主信号）──
加('bond 0.90 → 熟', 跑({ x: { safety: 0.55, bond: 0.9 } }, 'x').startsWith('[关系] 熟'), true)
加('bond 0.70 整（含）→ 熟', 跑({ x: { safety: 0.55, bond: 0.7 } }, 'x').startsWith('[关系] 熟'), true)
加('bond 0.69 → 在意', 跑({ x: { safety: 0.55, bond: 0.69 } }, 'x').startsWith('[关系] 在意'), true)
加('bond 0.40 整（含）→ 在意', 跑({ x: { safety: 0.55, bond: 0.4 } }, 'x').startsWith('[关系] 在意'), true)
加('bond 0.39 → 一般', 跑({ x: { safety: 0.55, bond: 0.39 } }, 'x').startsWith('[关系] 一般'), true)
加('bond 0.15 整（含）→ 一般', 跑({ x: { safety: 0.55, bond: 0.15 } }, 'x').startsWith('[关系] 一般'), true)
加('bond 0.14 → 一个字都不出', 跑({ x: { safety: 0.55, bond: 0.14 } }, 'x'), '')
加('bond 0 → 不出声', 跑({ x: { safety: 0.55, bond: 0 } }, 'x'), '')

// ── 批次307b 修的那条：真实分布 ──
加('★ safety 0.55 + bond 0.75（主人的真实值）→ 必须出声', 跑({ x: { safety: 0.55, bond: 0.75 } }, 'x').startsWith('[关系] 熟'), true)
加('★ safety 0.55 + bond 0（普通人的默认）→ 不出声', 跑({ x: { safety: 0.55, bond: 0 } }, 'x'), '')
加('★ safety 0.55 + bond 0.5 → 在意', 跑({ x: { safety: 0.55, bond: 0.5 } }, 'x').startsWith('[关系] 在意'), true)

// ── 字段缺失 / 脏数据 ──
加('bond 缺失 → 当 0，不出声', 跑({ x: { safety: 0.9 } }, 'x'), '')
加('bond 是字符串 "0.8" → 照算', 跑({ x: { safety: 0.9, bond: '0.8' } }, 'x').startsWith('[关系] 熟'), true)
加('bond 是 NaN → 当 0', 跑({ x: { safety: 0.9, bond: NaN } }, 'x'), '')
加('bond 是 null → 当 0', 跑({ x: { safety: 0.9, bond: null } }, 'x'), '')
加('人 是字符串（脏）→ 不崩', typeof 跑({ x: 'abc' }, 'x'), 'string')
加('人 是数组（脏）→ 不崩', typeof 跑({ x: [1, 2] }, 'x'), 'string')
清()
fs.writeFileSync(关路, JSON.stringify({ people: [1, 2] }), 'utf8')
加('people 是数组（脏）→ 不崩', typeof 跑(undefined, 'x'), 'string')
fs.writeFileSync(关路, JSON.stringify({ people: null }), 'utf8')
加('people 是 null → 不崩', typeof 跑(undefined, 'x'), 'string')
fs.writeFileSync(关路, JSON.stringify({}), 'utf8')
加('没有 people 键 → 不崩', typeof 跑(undefined, 'x'), 'string')

// ── peer 数字 / 字符串 ──
加('peer 传字符串', 跑({ {{OWNER_UIN}}: { safety: 0.9, bond: 0.8 } }, '{{OWNER_UIN}}').startsWith('[关系]'), true)
加('peer 传数字（String 化后对上）', 跑({ {{OWNER_UIN}}: { safety: 0.9, bond: 0.8 } }, {{OWNER_UIN}}).startsWith('[关系]'), true)

// ── 真实关系.json 冒烟：12 个人全跑一遍，看有几个出声 ──
{
  const 真 = JSON.parse(fs.readFileSync('{{BOT_ROOT}}/记忆/关系.json', 'utf8'))
  const 人 = (真 && 真.people) || {}
  const 出 = Object.entries(人).map(([k]) => {
    const c = { peer: k, memDir: '{{BOT_ROOT}}/记忆', now: Date.now(), statSync: fs.statSync }
    return [k, slotRelationBond(c)]
  }).filter(([, s]) => s !== '')
  加('真实有人出声（批次307b 之前是 0）', 出.length > 0, true)
  console.log('真实分布：' + Object.keys(人).length + ' 人，出声 ' + 出.length + ' 人')
  for (const [k, s] of 出.slice(0, 6)) console.log('  ' + k + '  ' + s.slice(0, 44))
}

fs.rmSync(沙, { recursive: true, force: true })
let 过 = 0
const 败 = []
for (const [名, 实, 期] of 场景) {
  if (JSON.stringify(实) === JSON.stringify(期)) 过 += 1
  else 败.push(`${名}  期望 ${JSON.stringify(期)} 实际 ${JSON.stringify(实)}`)
}
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log('  ★ ' + b)
