// t444.test.mjs —— 收藏表情名册与「换着甩」（批次444）
//
// 起因（2026-11-14，主人连说三次）：
//   00:19「这个 inm 表情包还是在玩梗的时候用吧 正常聊天用有点搞」
//   04:51「别在正常聊天老是发这个恶臭 inm 梗表情包了」
//   11:34「怎么老是用这个表情包」 ← 顶盆委屈
//   11:37「不是给你挺多的表情包了吗」
// 她自己答得准：「收藏夹里那 19 张，大半连名字都没有，我认不出来；能叫上名的就那两三张，
// 所以老是同一个。」
//
// 查下来两条机制：
//   ① `fetch_custom_face_detail` 返回的每一条**没有 summary/desc**（协议端不支持改名），
//      而 listCustomFaces 写的是 `remote.length > 0 ? remote : localNamedList` ——
//      远端一有数据就不看本地表，她起的 18 个名字全被丢掉 → 槽里的候选永远是空的。
//   ② 系统里**没有任何地方记「她刚用过哪张」**，所以「换着甩」只能靠她自觉。
// QUIET_NOTE：本文件 import 插件 lib，register 时 note() 会往真插件日志写（它原来只在子进程里设过）。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const LIB = process.env.PLUGIN_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

const cf = await import(path.join(LIB, 'custom-faces.js'))
const vs = await import(path.join(LIB, 'voiceSlots.js'))

test('A1 远端没有 summary 时，用本地命名表补上', () => {
  const 远端 = [
    { emojiId: 'a_1', summary: '', desc: '' },
    { emojiId: 'b_2', summary: '', desc: '' }
  ]
  const 本地 = { a_1: { name: '火里盯人' }, b_2: { name: '你已急哭' } }
  const 合并 = cf.mergeFaceNames(远端, 本地)
  assert.equal(合并[0].summary, '火里盯人')
  assert.equal(合并[0].desc, '火里盯人')
  assert.equal(合并[1].summary, '你已急哭')
})

test('A2 远端自己有名字时不许被本地表盖掉', () => {
  const 合并 = cf.mergeFaceNames([{ emojiId: 'a_1', summary: '远端叫法', desc: '' }], { a_1: { name: '本地叫法' } })
  assert.equal(合并[0].summary, '远端叫法', '本地表把远端名字盖了')
})

test('A3 本地表里没有的就留空（别瞎编名字）', () => {
  const 合并 = cf.mergeFaceNames([{ emojiId: 'zzz', summary: '', desc: '' }], {})
  assert.equal(合并[0].summary, '')
})

test('A4 listCustomFaces 不许再「远端有数据就丢掉本地名」', () => {
  const s = readFileSync(path.join(LIB, 'custom-faces.js'), 'utf8')
  assert.doesNotMatch(s, /return remote\.length > 0 \? remote : localNamedList/, '退回旧写法了 —— 名册会重新变空')
  assert.match(s, /mergeFaceNames\(remote, readFaceNames\(\)\)/, '没在返回值上合并本地名字')
})

const 现在 = Date.parse('2026-11-14T11:00:00+08:00')
const 两小时前 = 现在 - 2 * 3600e3

test('B1 两小时内用过的不推（这才是「换着甩」的机制）', () => {
  const 名册 = ['顶盆委屈', '火里盯人', '你已急哭', '立牌吃炸鸡']
  const 用过 = { 顶盆委屈: 现在 - 60e3, 火里盯人: 现在 - 30 * 60e3 }
  for (let 片 = 0; 片 < 12; 片 += 1) {
    const 选 = vs.挑表情候选(名册, 用过, 片, 3, 现在)
    assert.equal(选.includes('顶盆委屈'), false, '刚用过的还在推：' + 选.join('、'))
    assert.equal(选.includes('火里盯人'), false, '半小时前用过的还在推：' + 选.join('、'))
  }
})

test('B2 冷却够久就能重新出现（不是永久拉黑）', () => {
  const 名册 = ['顶盆委屈', '火里盯人']
  const 用过 = { 顶盆委屈: 现在 - 3 * 3600e3 }
  const 合一 = new Set()
  for (let 片 = 0; 片 < 6; 片 += 1) for (const x of vs.挑表情候选(名册, 用过, 片, 2, 现在)) 合一.add(x)
  assert.ok(合一.has('顶盆委屈'), '三小时前用过的不该被永久排除')
})

test('B3 全都刚用过时按「最久没用过」给，不能一个都不给', () => {
  const 名册 = ['A', 'B', 'C']
  const 用过 = { A: 现在 - 60e3, B: 现在 - 120e3, C: 现在 - 180e3 }
  const 选 = vs.挑表情候选(名册, 用过, 0, 1, 现在)
  assert.equal(选.length, 1)
  assert.equal(选[0], 'C', '应该给最久没用过的那张')
})

test('B4 同一个 10 分钟桶里逐字节相同（不许有分钟级随机）', () => {
  const 名册 = ['A', 'B', 'C', 'D', 'E']
  const a = vs.挑表情候选(名册, {}, 123, 3, 现在).join('|')
  const b = vs.挑表情候选(名册, {}, 123, 3, 现在 + 8 * 60e3).join('|')
  assert.equal(a, b, '同一桶内变了 —— 会击穿 prefix cache')
  assert.notEqual(a, vs.挑表情候选(名册, {}, 124, 3, 现在).join('|'), '下一桶应该换一批')
})

test('B5 名册为空时返回空（槽里就别提表情包了）', () => {
  assert.deepEqual(vs.挑表情候选([], {}, 0, 3, 现在), [])
  assert.deepEqual(vs.挑表情候选(null, {}, 0, 3, 现在), [])
})

test('C1 recordFaceUse 记「名字→时间」，并把表压回 40 条', () => {
  const sb = mkdtempSync(path.join(os.tmpdir(), 't444-emoji-'))
  try {
    const 名表 = { id_44: { name: '最后一张', at: 1000 }, id_0: { name: '名字0', at: 1001 } }
    writeFileSync(path.join(sb, 'qq-bridge-emoji-names.json'), JSON.stringify(名表))
    // 先塞 45 条「用过」，验它会不会自己压回 40
    const 旧用过 = {}
    for (let i = 0; i < 45; i += 1) 旧用过['旧名字' + i] = 1000 + i
    writeFileSync(path.join(sb, '表情用过.json'), JSON.stringify(旧用过))
    const 代码 = `
      const cf = await import(${JSON.stringify(path.join(LIB, 'custom-faces.js'))})
      cf.recordFaceUse('id_44')
      console.log(JSON.stringify(cf.读表情用过()))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
      encoding: 'utf8', timeout: 30000,
      env: { ...process.env, DSH_HOME: sb, QQ_MEM: sb, QUIET_NOTE: '1' }
    }).trim()
    const 用过 = JSON.parse(out.split('\n').pop())
    assert.ok(用过['最后一张'] > 0, '没记上名字：' + JSON.stringify(用过).slice(0, 120))
    assert.ok(Object.keys(用过).length <= 40, '没压回 40 条：' + Object.keys(用过).length)
    assert.ok(用过['旧名字44'] === 1000 + 44 || 用过['旧名字44'] === undefined, '最老的应该被挤掉')
  } finally {
    rmSync(sb, { recursive: true, force: true })
  }
})

test('D1 发送成功那条路必须记「用过」（否则冷却永远不生效）', () => {
  // 两条发送路：本地原图（sub_type=1）和协议端 send_custom_face。少记一条，
  // 那条路上的表情就不会进冷却 —— 表现还是「老用同一张」，而单测全绿。
  const s = readFileSync(path.join(LIB, 'custom-faces.js'), 'utf8')
  const 次 = (s.match(/recordFaceUse\(id\)/g) || []).length
  assert.equal(次, 2, 'sendCustomFace 的两条发送路都要记，实际记了 ' + 次 + ' 处')
})

test('E1 场合提示只列名册里真有的名字', () => {
  // 「没话接→就是啊」如果就是啊已不在收藏夹，指过去她只会发失败（这正是老问题的机制）
  const 名册 = ['顶盆委屈', '你已急哭', '立牌吃炸鸡']
  const 标签 = { 顶盆委屈: '委屈', 躺倒委屈大眼: '委屈', 你已急哭: '被气到', 就是啊: '没话接', 立牌吃炸鸡: '好吃' }
  const 句 = vs.场合提示(名册, 标签)
  assert.match(句, /委屈→顶盆委屈/, 句)
  assert.match(句, /被气到→你已急哭/, 句)
  assert.match(句, /好吃→立牌吃炸鸡/, 句)
  assert.doesNotMatch(句, /就是啊/, '不在名册里的名字不许出现：' + 句)
  assert.doesNotMatch(句, /躺倒委屈大眼/, '不在名册里的名字不许出现：' + 句)
})

test('E2 没有场合标签时一个字都不加', () => {
  assert.equal(vs.场合提示(['A', 'B'], {}), '')
  assert.equal(vs.场合提示(['A'], { A: '' }), '')
  assert.equal(vs.场合提示([], { A: '委屈' }), '')
})

test('E3 mergeFaceNames 把场合标签一起带出来', () => {
  const 合并 = cf.mergeFaceNames([{ emojiId: 'a_1', summary: '', desc: '' }], { a_1: { name: '顶盆委屈', tag: '委屈' } })
  assert.equal(合并[0].summary, '顶盆委屈')
  assert.equal(合并[0].tag, '委屈')
  const 无 = cf.mergeFaceNames([{ emojiId: 'b_2', summary: '', desc: '' }], { b_2: { name: '某张' } })
  assert.equal(无[0].tag, undefined, '没标签就别塞空字符串')
})

test('E4 名册 = 远端 ∪ 本地（收藏夹里没有但本地有原图的也要在）', () => {
  // 顶盆委屈在 QQ 收藏夹里已经没有了，但本地还有原图、还能发 —— 而它正是她最常甩的那张
  const s = readFileSync(path.join(LIB, 'custom-faces.js'), 'utf8')
  assert.match(s, /合并\.concat\(补\)/, '名册没做并集 —— 只在收藏夹里取会漏掉顶盆委屈')
  assert.match(s, /localNamedList\(limit\)\.filter/, '并集没有去重')
})

test('F1 qq_collect_face 的 faces 输出必须带 path/tag（多一个字段就 ToolOutputError）', () => {
  // 宿主的 output.schema 是 additionalProperties:false —— schema 里没有的字段，
  // 工具一返回就判 ToolOutputError，整次调用失败。所以这两个字段必须两边一起加。
  const s = readFileSync(path.join(LIB, 'tool.js'), 'utf8')
  const i = s.indexOf("name: 'qq_collect_face'")
  assert.ok(i > 0, '找不到 qq_collect_face')
  // ⚠️ 必须只切 faces 那一块：同一个 schema 里 files 也有 path，切宽了会抓到 files.path
  //   —— 反测（把 faces.path 改名成 pth）就是绿的，典型的「断言抓到别处的值」。
  const 起 = s.indexOf('faces: {', i)
  assert.ok(起 > i, '找不到 faces 的 schema 块')
  const 块 = s.slice(起, 起 + 700)
  assert.match(块, /path: \{ type: 'string' \}/, 'faces 的 schema 里没有 path —— 没名字的那几张就没法看')
  assert.match(块, /tag: \{ type: 'string' \}/, 'faces 的 schema 里没有 tag')
  assert.match(块, /emoji_id: \{ type: 'string' \}/, 'faces 的 emoji_id 被删了？')
})

test('F2 list 真的把 path / tag 填进去（不是只改了 schema）', () => {
  const s = readFileSync(path.join(LIB, 'tool.js'), 'utf8')
  assert.match(s, /path: f\.emoPath \|\| '',/, 'list 映射没给 path')
  assert.match(s, /tag: f\.tag \|\| ''/, 'list 映射没给 tag')
})

test('F3 表情的本地路径优先用「真能打开」的那个', () => {
  // NapCat 的 emoPath 指向它自己的 personal_emoji/Ori/<md5>.jpg，实测这些文件并不存在
  // （返回里 isExist:false）。原来它排在前面，于是本地明明有原图的条目也被判成没图。
  const s = readFileSync(path.join(LIB, 'custom-faces.js'), 'utf8')
  const i = s.indexOf('emoPath:')
  assert.ok(i > 0)
  const 行 = s.slice(i, i + 260)
  assert.match(行, /^emoPath: resolveLocalFacePath\(/, 'emoPath 又不是本地优先了：' + 行.slice(0, 60))
  assert.match(行, /\|\| String\(item\?\.emoPath/, '没有退回 NapCat 的 emoPath')
})

test('F4 列表里没名字的那几张要给出可看的路径', () => {
  const s = readFileSync(path.join(LIB, 'tool.js'), 'utf8')
  assert.match(s, /（没名字）/, '没名字的条目没有单独渲染')
  assert.match(s, /可看：/, '没给出可看的路径 —— 她永远认不出那是哪张')
})
