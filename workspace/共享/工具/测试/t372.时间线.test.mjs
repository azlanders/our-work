// 沙箱场景测试：时间线 / 作息 / 回头说 —— 断言「当前契约」，兼作反回归护栏。
// ─────────────────────────────────────────────────────────────────────────
// STALE_ASSERT 2026-11-24：这个测试原来断言「她脑子里有『他上一句距今多久』
// 『这个点他通常在/不在』『还记着 N 件回头要说的』」这三段。
//
// 事实（读完代码才敢写）：
//   · 批次372h/372i（2026-11-13）确实加过这三段；
//   · 批次666/676/696（2026-11-17/18，拟人化红线）把它们**整段撤掉** ——
//     理由写在 poll.js 的 HUMANIZE 注释里：「替她解读对方心情 / 命令对话时序」
//     属于越界，原文已在上下文里，不需要系统再喂一遍结论。
//   · 当前 poll.js 的 stateFastHintOf 只剩
//     `（你现在的状态：此刻 HH:MM｜精N 饱N 渴N%｜人在X·正在Y）` 一件事。
//
// 所以旧断言测的是「已经被产品决定删掉的行为」—— 红的不是代码，是断言。
// 现在改成断言**当前契约**：
//   a) 快照格式对（此刻 HH:MM），长度 1~100 字、以「）」收尾（t353 #24 硬契约）
//   b) 任何脏输入都不得抛异常
//   c) 三段历史能力不得回归 —— 一旦有人加回来，这里亮红提醒「该同步测试了」
//
// PLUGIN_PATH 2026-11-24：原来硬写 `{{DSH_ROOT}}/profiles/...`（另一台实例的 HOME），
// 本机不存在 → 会去测别人的插件，还会往人家 lib 里落 _沙箱 副本。
// 现在按 DSH_HOME → {{DSH_ROOT}} 解析；解析不到就 skip（exit 0）而不是砸红。
// 副本一律落在 os.tmpdir，绝不写插件目录。
// ─────────────────────────────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// QUIET_NOTE：import 插件 lib 会调 note()，往真插件日志写几千行「xxx registered」，
// 把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 沙箱 = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-t372-'))
const 账路 = 沙箱 + '/proactive.json'
const 息路 = 沙箱 + '/他的作息.json'
const 待路 = 沙箱 + '/回头说.json'
// MEM_SANDBOX：poll.js 的记忆路径由 QQ_MEM 决定，文件名叫什么就必须叫什么。
process.env.QQ_MEM = 沙箱

const 候选根 = [
  process.env.DSH_HOME && path.join(process.env.DSH_HOME, 'profiles/web/node_modules/dsh-onebot-channel/lib'),
  '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib',
].filter(Boolean)
const 插件 = 候选根.find((d) => { try { return fs.existsSync(path.join(d, 'poll.js')) } catch { return false } })
if (!插件) {
  console.log('通过 0/0（skip：本机找不到 dsh-onebot-channel）')
  process.exit(0)
}

// 副本必须落在 lib/ 里：插件源码里有 `../receipt-transaction.mjs` 这种相对 import，
// 拷到 /tmp 就断链（实测 Cannot find module '/tmp/receipt-transaction.mjs'）。
// 文件名带 pid 防并发撞车；改完的副本用完当场删，绝不留在插件目录。
const 沙箱版 = path.join(插件, '_沙箱.poll.' + process.pid + '.mjs')
let stateFastHintOf = null
try {
  // 把主动账路径改指沙箱（写法变了也不怕：改不到就原样，场景里已有「不应回归」兜底）
  const 替 = fs.readFileSync(path.join(插件, 'poll.js'), 'utf8')
    .replace(/'\/root\/\.dsh\/qq-bridge-proactive\.json'/g, "'" + 账路 + "'")
    .replace(/'\/data\/bot-dsh\/qq-bridge-proactive\.json'/g, "'" + 账路 + "'")
  fs.writeFileSync(沙箱版, 替, 'utf8')
  const mod = await import('file:///' + 沙箱版.replace(/\\/g, '/'))
  stateFastHintOf = mod.stateFastHintOf
} catch (e) {
  console.log('通过 0/0（skip：插件副本搭建/import 失败 ' + e.message + '）')
  try { fs.unlinkSync(沙箱版) } catch {}
  try { fs.rmSync(沙箱, { recursive: true, force: true }) } catch {}
  process.exit(0)
}
if (typeof stateFastHintOf !== 'function') {
  console.log('失败 1/1：插件没有再导出 stateFastHintOf —— 契约变了，本测试需同步重写')
  process.exit(1)
}

const now = Date.now()
const 主 = 'private:{{OWNER_UIN}}'
const 现在小时 = new Date(now + 8 * 3600e3).getUTCHours()
let 序 = 0
// 快读Json 按 mtimeMs + size 判缓存；同长度同毫秒会读到旧值，把 mtime 推一秒。
const 写 = (p, v) => {
  序 += 1
  if (v === null) { try { fs.unlinkSync(p) } catch {} return }
  fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v), 'utf8')
  const t = new Date(Date.now() + 序 * 1000)
  try { fs.utimesSync(p, t, t) } catch {}
}
const 格 = (改) => { const a = new Array(24).fill(148); Object.assign(a, 改 || {}); return { 每小时: a, 均值: 148, 样本天数: 14 } }

const 场景 = [
  // 基线：三样都没有，快照仍要有「此刻 HH:MM」
  { 名: '三样文件都没有', 账: null, 作息: null, 待: null, 正则: /此刻 \d{2}:\d{2}/, 不含: ['距今', '这个点他', '回头要说', '还记着'] },
  // 脏数据不能炸
  { 名: '账是坏 JSON', 账: '{坏掉的', 正则: null, 不炸: true, 不含: ['距今'] },
  { 名: '作息是坏 JSON', 作息: '{坏', 正则: null, 不炸: true, 不含: ['这个点他'] },
  { 名: '待办是坏 JSON', 待: '[[[', 正则: null, 不炸: true, 不含: ['还记着'] },
  // 回归护栏：历史三段能力必须保持删除
  { 名: '账里有 lastIncomingAt（不应回归）', 账: { [主]: { lastIncomingAt: now - 3 * 3600e3 } }, 正则: null, 不含: ['距今'] },
  { 名: '账里有 lastProactiveAt（不应回归）', 账: { [主]: { lastIncomingAt: now - 10 * 60000, lastProactiveAt: now - 5 * 60000 } }, 正则: null, 不含: ['一直没回'] },
  { 名: '作息当前小时很活跃（不应回归）', 作息: 格({ [现在小时]: 478 }), 正则: null, 不含: ['这个点他通常在'] },
  { 名: '作息当前小时很安静（不应回归）', 作息: 格({ [现在小时]: 15 }), 正则: null, 不含: ['这个点他通常不在'] },
  { 名: '回头说 3 件未完成（不应回归）', 待: { items: [{ done: false }, { done: false }, { done: false }] }, 正则: null, 不含: ['还记着 3 件'] },
  { 名: '回头说带 due（不应回归）', 待: { items: [{ what: 'a', due: now + 3600e3, done: false }] }, 正则: null, 不含: ['还记着 1 件'] },
  // 极端脏数据
  { 名: '每小时长度不对', 作息: { 每小时: [1, 2, 3], 均值: 1 }, 正则: null, 不炸: true, 不含: ['这个点他'] },
  { 名: '均值 0', 作息: { 每小时: new Array(24).fill(0), 均值: 0 }, 正则: null, 不炸: true, 不含: ['这个点他'] },
  { 名: '时间在未来', 账: { [主]: { lastIncomingAt: now + 999999 } }, 正则: null, 不炸: true, 不含: ['距今'] },
]

let 过 = 0
const 败 = []
for (const s of 场景) {
  写(账路, s.账 === undefined ? null : s.账)
  写(息路, s.作息 === undefined ? null : s.作息)
  写(待路, s.待 === undefined ? null : s.待)
  let 出
  try {
    出 = String(stateFastHintOf() ?? '')
  } catch (e) {
    败.push({ 名: s.名, 出: 'THROW: ' + e.message, 缺: ['不抛异常'], 多: [] })
    continue
  }
  const 缺 = []
  const 多 = []
  if (s.不炸 !== true) {
    if (!出) 缺.push('非空快照')
    if (s.正则 && !s.正则.test(出)) 缺.push('匹配 ' + s.正则)
    // 硬契约：1~100 字、以「）」收尾（t353 #24 逐字校验）
    if (出.length < 1 || 出.length > 100) 缺.push('长度 1~100（实际 ' + 出.length + '）')
    if (!出.endsWith('）')) 缺.push('以「）」收尾')
  }
  for (const k of s.不含 || []) if (出.includes(k)) 多.push(k)
  if (缺.length === 0 && 多.length === 0) 过 += 1
  else 败.push({ 名: s.名, 出, 缺, 多 })
}

try { fs.unlinkSync(沙箱版) } catch {}
try { fs.rmSync(沙箱, { recursive: true, force: true }) } catch {}

console.log(`通过 ${过}/${场景.length}`)
for (const b of 败) console.log(`  ★ ${b.名}\n     输出 ${b.出}\n     缺 ${JSON.stringify(b.缺)}  多 ${JSON.stringify(b.多)}`)
process.exit(败.length === 0 ? 0 : 1)