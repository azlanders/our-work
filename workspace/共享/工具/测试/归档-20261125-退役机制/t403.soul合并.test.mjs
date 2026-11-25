// t403 —— SOUL 合并（批次393）
//
// 主人原话：「然后soul合并 但是要做多方面测试」
//
// 背景：她的人设有两条来源 —— `cordis.patch.yml` 的 `personaPrefix`（system 最前面）
// 和 `SOUL.md`（批次391 才被插件接进 system）。两份重复讲表情规矩、接梗、qq_pass，
// 各自又都有对方没有的规则。这一批把 SOUL.md 定成唯一真源，personaPrefix 只留身份锚。
//
// 这个文件锁五件事：
//   A 结构：YAML 还能解析、插件一个不多一个不少、personaPrefix 缩到 500 字以内
//   B 不丢规则：**只在 personaPrefix 里有、SOUL.md 一个字没有的那 8 条**（最容易合并丢的）
//     和 SOUL 原有的 7 条，一条都不许少
//   C 不重复：两处不再有 >=15 字的相同整句
//   D 降级：SOUL.md 读不到时，personaPrefix 仍要有身份 + 技术词禁令（不能只剩「见 SOUL」）
//   E 链路：注入代码在、text 是函数、有「注入 N 字」日志（可观测性）、注释写明了要重启
//
// 跑法：node --test t403.soul合并.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, statSync } from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 /data/hajimi-dsh/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const YML = '/data/hajimi-dsh/profiles/web/cordis.patch.yml'
const SOUL = '/data/hajimi-workspace/SOUL.md'
const PLUG = '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/index.js'
const PANEL = '/data/hajimi-workspace/共享/工具/面板.mjs'

const 读 = (p) => readFileSync(p, 'utf8')

/** 只取 personaPrefix 折叠块，按 YAML >- 的规则折叠（单换行 -> 空格）。 */
function 读前缀() {
  const lines = 读(YML).split('\n')
  const i = lines.findIndex((l) => l.startsWith('    personaPrefix:'))
  assert.ok(i > 0, 'cordis.patch.yml 里找不到 personaPrefix')
  assert.match(lines[i], />-$/, 'personaPrefix 必须是 >- 折叠块（改 |- 会把换行带进 prompt）')
  const 块 = []
  for (const l of lines.slice(i + 1)) {
    if (!l.startsWith('      ')) break
    块.push(l.trim())
  }
  assert.ok(块.length > 0, '折叠块是空的')
  return 块.join(' ')
}

const 前缀 = 读前缀()
const 灵魂 = 读(SOUL)

// ── A 结构 ────────────────────────────────────────────────────────
test('A1 personaPrefix 缩到 500 字以内（细节搬去 SOUL.md 了）', () => {
  assert.ok(前缀.length <= 500, `personaPrefix 现在 ${前缀.length} 字，又涨回去了 —— 细节应该放 SOUL.md`)
  assert.ok(前缀.length >= 120, `personaPrefix 只有 ${前缀.length} 字，太短了，兜底不住`)
})

test('A2 SOUL.md 在、非空、不是一坨（有分节）', () => {
  assert.ok(existsSync(SOUL), 'SOUL.md 没了')
  assert.ok(statSync(SOUL).size > 800, 'SOUL.md 太小了，可能是被截断/清空')
  assert.ok(灵魂.length < 6000, `SOUL.md ${灵魂.length} 字符，每轮都进 system，太长了`)
  const 节 = (灵魂.match(/^## /gm) || []).length
  assert.ok(节 >= 4, `只有 ${节} 个 ## 小节，结构像是被删过`)
})

test('A3 YAML 里插件 id 一个不多一个不少', () => {
  const 想 = ['permission', 'approval', 'tool-web', 'tool-bash', 'system-prompt',
    'hippocampus', 'bili-humanism', 'dsh-video-storyboard']
  const 有 = [...读(YML).matchAll(/^- id: (\S+)$/gm)].map((m) => m[1])
  assert.deepEqual(有, 想, '插件顺序/id 变了 —— 这会让 host 起不来或行为变')
})

// ── B 不丢规则 ────────────────────────────────────────────────────
// 这 8 条**曾经只在 personaPrefix 里**，SOUL.md 一个字没有 —— 合并时最容易蒸发
const 只在前缀里的8条 = {
  '技术词禁令': '端口',
  '技术词替换说法': '我这边',
  '禁糙话「切」': '「切」',
  '表情:调皮': '表情:调皮',
  '疑惑发问号': '疑惑时直接发 `?`',
  '不写「这条我不接」': '这条我不接',
  '先应一声再干活': '等我看看',
  'qq_item 拿/还': 'qq_item',
}
// 这 7 条本来只在 SOUL.md 里，合并后必须在
const 只在灵魂里的7条 = {
  '对生人客气': '生人',
  '别老说我认': '我认',
  'qq_react': 'qq_react',
  '决定划走就结束回合': '结束回合',
  '手账路径': '手账-',
  '内心/惦记': '惦记.jsonl',
  // 批次394 已把梗知识并进圈子黑话.json；SOUL 的现行规则是“指向黑话本”，
  // 不该再要求旧词库条数。t404 同时锁住了“SOUL 不再提 梗知识.md”。
  '黑话本': '圈子黑话.json',
}

test('B1 原来只在 personaPrefix 里的 8 条，合并后一条不许少', () => {
  const 缺 = Object.entries(只在前缀里的8条).filter(([, s]) => !灵魂.includes(s) && !前缀.includes(s))
  assert.deepEqual(缺.map(([k]) => k), [], '这些规则在合并中丢了：' + 缺.map(([k]) => k).join('、'))
})

test('B2 SOUL.md 原有的 7 条也必须还在', () => {
  const 缺 = Object.entries(只在灵魂里的7条).filter(([, s]) => !灵魂.includes(s))
  assert.deepEqual(缺.map(([k]) => k), [], '这些规则丢了：' + 缺.map(([k]) => k).join('、'))
})

// ── C 不重复 ──────────────────────────────────────────────────────
test('C1 两处不再有 >=15 字的相同整句', () => {
  const 句们 = (t) => t.replace(/[#*\-\n]/g, ' ').split(/[。！？；]/)
    .map((s) => s.trim()).filter((s) => s.length >= 15)
  const 交集 = 句们(前缀).filter((s) => 句们(灵魂).includes(s))
  assert.deepEqual(交集, [], '这两句在两处各说了一遍：' + 交集.map((s) => s.slice(0, 30)).join(' / '))
})

// ── D 降级：SOUL.md 读不到时她还剩什么 ────────────────────────────
test('D1 SOUL 读不到也不能只剩「见 SOUL」这句空话', () => {
  for (const [名, 串] of Object.entries({
    身份: '哈基米', 叫法: '主人', 主人QQ: '3439411062', 不毒舌: '毒舌', 技术词: '端口',
  })) {
    assert.ok(前缀.includes(串), `降级时丢了「${名}」—— personaPrefix 是唯一的兜底`)
  }
})

// ── E 注入链路 ────────────────────────────────────────────────────
const 插件 = 读(PLUG)

test('E1 qq-soul 和 qq-state 两个 context 都在', () => {
  assert.ok(插件.includes("name: 'qq-soul'"), 'qq-soul 的 context 没了 —— SOUL.md 又变成死文件')
  assert.ok(插件.includes("name: 'qq-state'"), 'qq-state 的 context 没了')
})

test('E2 text 必须是函数（每回合问一次），不能传字符串', () => {
  const i = 插件.indexOf("name: 'qq-soul'")
  const 行 = 插件.slice(i, i + 200)
  assert.match(行, /text:\s*挂灵魂/, 'qq-soul 的 text 不是那个带日志的函数')
  assert.ok(插件.includes('const 挂灵魂 = () =>'), '挂灵魂 函数没了')
})

test('E3 必须打「qq-soul 注入 N 字」—— 光有「已挂上」等于没验', () => {
  assert.ok(/qq-soul 注入 \$\{v\.length\} 字/.test(插件),
    '注入长度日志没打 —— 批次391 就是「挂载成功但内容没进 system」没人发现')
})

test('E4 SOUL 那段注释必须写明「改完要重启」（实测结论，别再改回「每回合刷新」）', () => {
  const i = 插件.indexOf('SOUL_RELOAD')
  assert.ok(i > 0, 'SOUL_RELOAD 那段实测记录没了')
  // 只看 SOUL 这一段 —— qq-state 的文案是历史遗留，那句「每回合刷新」在另一条台账里
  const 段 = 插件.slice(i, i + 1600)
  assert.ok(段.includes('systemctl restart dsh-bot'), '必须写明改完要重启 dsh-bot')
  // 不能断言「这词不出现」—— 注释里要引用它才能说清「别信那句」。要的是正面表述。
  assert.ok(段.includes('不是每回合刷新') || 段.includes('别信批次391'), '必须点明「不是每回合刷新」')
})

test('E5 面板「人格与设定」里 SOUL.md 仍然可编辑', () => {
  const 面板 = 读(PANEL)
  assert.ok(面板.includes("SOUL:"), '面板文档白名单里没有 SOUL')
  assert.match(面板, /SOUL\.md/, '面板里找不到 SOUL.md 的路径')
})
