// 睡态判据的场景测试。睡着(目录) 收目录参数，直接给沙箱路径就能测。
import fs from 'node:fs'
const 工具 = '{{BOT_ROOT}}/共享/工具/睡态.mjs'
const { 睡着, 打盹中, 睡眠段 } = await import(工具)

const 沙 = '/tmp/sb873'
const 清 = () => { fs.rmSync(沙, { recursive: true, force: true }); fs.mkdirSync(沙, { recursive: true }) }
const 写 = (名, v) => {
  const p = 沙 + '/' + 名
  if (v === null) { try { fs.unlinkSync(p) } catch {} return }
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v), 'utf8')
}
const 现在 = Date.now()

const 场景 = [
  // ── 睡着 ──
  { 名: '两个文件都没有', 写: {}, 得: { 睡着: false } },
  { 名: '标记说 true', 写: { '睡醒.json': { sleeping: true, since: '2026-11-13 02:00' } }, 得: { 睡着: true } },
  { 名: '标记 false + 段还开着（防「叫不醒」）', 写: { '睡醒.json': { sleeping: false }, '睡眠.json': { live: { start: '2026-11-13 02:00' } } }, 得: { 睡着: false } },
  { 名: '标记 false + 没段', 写: { '睡醒.json': { sleeping: false } }, 得: { 睡着: false } },
  { 名: '没标记 + 段开着', 写: { '睡眠.json': { live: { start: '2026-11-13 02:00' } } }, 得: { 睡着: true } },
  { 名: '没标记 + live 是 null', 写: { '睡眠.json': { live: null } }, 得: { 睡着: false } },
  { 名: '没标记 + live 是空对象', 写: { '睡眠.json': { live: {} } }, 得: { 睡着: true } },
  { 名: '标记是坏 JSON', 写: { '睡醒.json': '{坏', '睡眠.json': { live: { start: 'x' } } }, 得: { 睡着: true } },
  { 名: '标记是数组（不是对象）', 写: { '睡醒.json': [1, 2], '睡眠.json': { live: { start: 'x' } } }, 得: { 睡着: true } },
  { 名: '标记 sleeping 是字符串 "true"', 写: { '睡醒.json': { sleeping: 'true' } }, 得: { 睡着: false } },
  { 名: '标记 sleeping 是 1', 写: { '睡醒.json': { sleeping: 1 } }, 得: { 睡着: false } },
  { 名: '睡眠.json 是坏 JSON', 写: { '睡眠.json': '{坏' }, 得: { 睡着: false } },
  { 名: '睡眠.json 的 live 是字符串', 写: { '睡眠.json': { live: 'yes' } }, 得: { 睡着: false } },
  // ── 打盹 ──
  { 名: '打盹到毫秒在未来', 写: { '打盹.json': { 到毫秒: 现在 + 60000 } }, 得: { 打盹中: true } },
  { 名: '打盹到毫秒在过去', 写: { '打盹.json': { 到毫秒: 现在 - 60000 } }, 得: { 打盹中: false } },
  { 名: '打盹到毫秒正好现在', 写: { '打盹.json': { 到毫秒: 现在 } }, 得: { 打盹中: false } },
  { 名: '打盹只有字符串「到」', 写: { '打盹.json': { 到: '2026-11-13 23:59' } }, 得: { 打盹中: true } },
  { 名: '打盹「到」是过去的字符串', 写: { '打盹.json': { 到: '2020-01-01 00:00' } }, 得: { 打盹中: false } },
  { 名: '打盹文件不存在', 写: {}, 得: { 打盹中: false } },
  { 名: '打盹是坏 JSON', 写: { '打盹.json': '{坏' }, 得: { 打盹中: false } },
  { 名: '打盹是数组', 写: { '打盹.json': [1] }, 得: { 打盹中: false } },
  // ── 睡眠段 ──
  { 名: '段：live 是对象', 写: { '睡眠.json': { live: { start: 'a' } } }, 得: { 睡眠段: true } },
  { 名: '段：live 是 null', 写: { '睡眠.json': { live: null } }, 得: { 睡眠段: false } },
  { 名: '段：没有 live 键', 写: { '睡眠.json': {} }, 得: { 睡眠段: false } },
]

let 过 = 0
const 败 = []
for (const s of 场景) {
  清()
  for (const [k, v] of Object.entries(s.写)) 写(k, v)
  const 实 = {}
  if ('睡着' in s.得) 实.睡着 = 睡着(沙)
  if ('打盹中' in s.得) 实.打盹中 = 打盹中(沙, 现在)
  if ('睡眠段' in s.得) 实.睡眠段 = 睡眠段(沙) !== null
  const 差 = Object.keys(s.得).filter((k) => 实[k] !== s.得[k])
  if (差.length === 0) 过 += 1
  else 败.push({ 名: s.名, 期望: s.得, 实际: 实, 差 })
}
fs.rmSync(沙, { recursive: true, force: true })
console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log(`  ★ ${b.名} 期望 ${JSON.stringify(b.期望)} 实际 ${JSON.stringify(b.实际)}`)
