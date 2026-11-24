// t536 —— 三个从没被碰过的判据（批次534）
//
//   · 在干嘛.mjs   她「在干什么」分五档、算体力倍率。三处来问，判错了她一边说在歇、一边掉血。
//   · 话对账.mjs   拍照配文跟她当时在哪儿/什么天对不上就清掉。判错了等于系统替她闭嘴。
//   · 清图片副本.mjs  按名字里的内容哈希去重，**真的会移动文件**。判错了她的图就没了。
import { test } from 'node:test'
import assert from 'node:assert'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, utimesSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const { 档, 倍率, 是歇着, 说法 } = await import('{{BOT_ROOT}}/共享/工具/在干嘛.mjs')
const { 话对不上 } = await import('{{BOT_ROOT}}/共享/工具/话对账.mjs')
const { 分组 } = await import('{{BOT_ROOT}}/共享/工具/清图片副本.mjs')

// ══════════ 在干嘛 ══════════
test('Z1 五档：打瞌睡必须先判成「盹」，不能因为含「睡」字被吞掉', () => {
  assert.equal(档('打瞌睡'), '盹')
  assert.equal(档('打盹'), '盹')
  assert.equal(档('睡觉'), '睡')
  assert.equal(档('在睡'), '睡')
  // 顺序反了会变成「睡」——两者倍率都是 0.4，但困意系数不一样（0.75 vs 0.4），不能混
})

test('Z2 五档：坐着 / 轻 / 中 / 重', () => {
  for (const s of ['发呆', '摸鱼', '翻旧账', '学点东西', '待命', '看B站', '逛贴吧']) {
    assert.equal(档(s), '歇', s + ' 应该算坐着')
  }
  assert.equal(档('吃点东西'), '轻')
  assert.equal(档('喝点水'), '轻')
  assert.equal(档('逛街'), '中')
  assert.equal(档('打工'), '中')
  assert.equal(档('在路上'), '中')
  assert.equal(档('搬货'), '重')
  assert.equal(档('跑'), '重')
})

test('Z3 空值给「轻」不是「歇」—— 读不到 自主.json 时不能白送体力', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(档(v), '轻', JSON.stringify(v))
})

test('Z4 倍率：每一档都对得上，而且只有中/重才大于 1', () => {
  assert.equal(倍率('睡觉'), 0.4)
  assert.equal(倍率('打瞌睡'), 0.4)
  assert.equal(倍率('发呆'), 1.0)
  assert.equal(倍率('吃点东西'), 1.0)
  assert.equal(倍率('逛街'), 1.6)
  assert.equal(倍率('打工'), 1.25)
  assert.equal(倍率('在路上'), 1.4)
  assert.equal(倍率('搬货'), 1.9)
  assert.equal(倍率('跑'), 2.0)
})

test('Z5 一致性：倍率 1.0 的那几个，档只能是 歇/轻 —— 不许「按干活扣血」还自称坐着', () => {
  const 样本 = ['发呆', '摸鱼', '学点东西', '看B站', '吃点东西', '喝水', '待命', '', '看进去书']
  for (const s of 样本) {
    if (倍率(s) === 1.0) assert.ok(['歇', '轻'].includes(档(s)), s + ' 档=' + 档(s))
  }
})

test('Z6 是歇着：歇/睡/盹 都回血，轻/中/重 都不回', () => {
  assert.equal(是歇着('发呆'), true)
  assert.equal(是歇着('睡觉'), true)
  assert.equal(是歇着('打瞌睡'), true)
  assert.equal(是歇着('吃点东西'), false)
  assert.equal(是歇着('逛街'), false)
  assert.equal(是歇着('跑'), false)
})

test('Z7 对外说法：内部名叫不出口的要换掉', () => {
  assert.equal(说法('翻旧账'), '想以前的事')
  assert.equal(说法('学点东西'), '翻自己的小抄')
  assert.equal(说法('看B站'), '看视频')
  assert.equal(说法('逛街'), '逛街', '没有映射的原样返回')
})

// ══════════ 话对账 ══════════
const 事实 = { 地名表: ['便利店', '图书馆', '游乐园', '家'], 当前地名: '便利店', 时段: '下午', 天象: '晴', 室内: false }

test('H1 说别处的地名 → 拦', () => {
  assert.match(话对不上('我在图书馆看书呢', 事实), /你现在在便利店，不在图书馆/)
})

test('H2 带将来口气的放过 —— 她可以想着等会儿去哪', () => {
  for (const s of ['等会儿去图书馆', '打算明天去游乐园', '准备回家', '想去图书馆']) {
    assert.equal(话对不上(s, 事实), '', s + ' 不该被拦')
  }
})

test('H3 单字地名不参与（否则「回家」「家里」全被误判）', () => {
  assert.equal(话对不上('家里挺安静的', { ...事实, 当前地名: '便利店' }), '')
})

test('H4 当前地名自己不算「别处」', () => {
  assert.equal(话对不上('便利店里没什么人', 事实), '')
})

test('H5 深夜/凌晨不许有太阳', () => {
  for (const 时 of ['深夜', '半夜', '凌晨']) {
    assert.match(话对不上('太阳晒得暖洋洋的', { ...事实, 时段: 时 }), /没有太阳/)
  }
  // 白天不拦
  assert.equal(话对不上('太阳晒得暖洋洋的', 事实), '')
})

test('H6 天气不是雨雪，却写在下', () => {
  assert.match(话对不上('外面下雨了', 事实), /没有下雨/)
  assert.match(话对不上('飘着雪呢', 事实), /没有下雪/)
  // 「雨伞」「雨靴」不碰
  assert.equal(话对不上('带上了雨伞', 事实), '')
  // 天象本来就是雨，放过
  assert.equal(话对不上('外面下雨了', { ...事实, 天象: '小雨' }), '')
})

test('H7 室内不许出现站台/车站/天桥', () => {
  const 室内 = { ...事实, 室内: true }
  assert.match(话对不上('在站台上等车', 室内), /室内/)
  // 「街上」「路边」从窗户看得见，不判
  assert.equal(话对不上('街上没什么人', 室内), '')
})

test('H8 空话返回空串（没话说就别判）', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(话对不上(v, 事实), '')
})

test('H9 宁可漏判不误判：说对的话一句都不许被清', () => {
  const 对 = ['便利店里冷气开得很足', '今天下午有点热', '在这儿坐一会儿', '外面天挺好的']
  for (const s of 对) assert.equal(话对不上(s, 事实), '', s + ' 被误拦了')
})

// ══════════ 清图片副本 ══════════
test('G1 分组只认「_ + 32 位十六进制 + .」', () => {
  const h = '0123456789abcdef0123456789abcdef'
  const H = h.toUpperCase()
  const m = 分组([
    'img_' + h + '.gif',          // 认
    'old_' + H + '.png',          // 认，大写归一到同一组
    'bad_' + h.slice(0, 31) + '.gif',   // 31 位，不认
    'bad_' + h + '0.gif',         // 33 位，不认
    h + '.gif',                   // 没有下划线，不认
    'plain.gif',                  // 没哈希，不认
  ])
  assert.equal(m.size, 1, '只该有 1 组')
  assert.deepEqual(m.get(H).sort(), ['img_' + h + '.gif', 'old_' + H + '.png'])
})

test('G2 沙盒真跑：同哈希留 mtime 最新的一份，其余移到归档，不删', () => {
  const 盒 = mkdtempSync(join(tmpdir(), 't536-'))
  const 图 = join(盒, '收到的图片'), 归 = join(盒, '归档')
  mkdirSync(图, { recursive: true })
  const h = 'abcdef0123456789abcdef0123456789'
  const 名 = ['a', 'b', 'c'].map((x) => x + '_' + h + '.gif')
  名.forEach((f, i) => {
    writeFileSync(join(图, f), 'x'.repeat(10))
    // 第 0 份最旧、第 2 份最新
    const t = new Date(Date.now() - (3 - i) * 10000)
    utimesSync(join(图, f), t, t)
  })
  writeFileSync(join(图, 'solo.gif'), 'y'.repeat(5))   // 无哈希，不许被碰

  const out = execFileSync(process.execPath, [join(工具, '清图片副本.mjs')], {
    encoding: 'utf8', env: { ...process.env, QQ_IMGDIR: 图, QQ_IMG_ARCHIVE: 归 }, timeout: 20000,
  })
  assert.match(out, /重复 2 份/)
  assert.deepEqual(readdirSync(图).sort(), ['c_' + h + '.gif', 'solo.gif'], '留最新那份 + 不动的 solo')
  assert.deepEqual(readdirSync(归).sort(), ['a_' + h + '.gif', 'b_' + h + '.gif'], '两旧份进归档（是移不是删）')
  assert.equal(statSync(join(归, 'a_' + h + '.gif')).size, 10, '内容原样，别写成空文件')
  rmSync(盒, { recursive: true, force: true })
})

test('G3 --dry 一份都不许动', () => {
  const 盒 = mkdtempSync(join(tmpdir(), 't536d-'))
  const 图 = join(盒, 'img'), 归 = join(盒, 'arc')
  mkdirSync(图, { recursive: true })
  const h = '11112222333344445555666677778888'
  writeFileSync(join(图, 'a_' + h + '.gif'), 'x')
  writeFileSync(join(图, 'b_' + h + '.gif'), 'y')
  const out = execFileSync(process.execPath, [join(工具, '清图片副本.mjs'), '--dry'], {
    encoding: 'utf8', env: { ...process.env, QQ_IMGDIR: 图, QQ_IMG_ARCHIVE: 归 }, timeout: 20000,
  })
  assert.match(out, /\[dry\]/)
  assert.equal(readdirSync(图).length, 2, 'dry 不该移走任何文件')
  assert.equal(require_exists(归), false, 'dry 不该建归档目录')
  rmSync(盒, { recursive: true, force: true })
})

function require_exists(p) {
  try { statSync(p); return true } catch { return false }
}

test('G4 import 它不许跑主流程（否则测试一 import 就搬真图）', () => {
  // 上面已经 import 过了；这里只确认那个「是主」判据用的是 pathToFileURL 而不是 endsWith
  const src = readFileSync(join(工具, '清图片副本.mjs'), 'utf8')
  assert.match(src, /pathToFileURL\(process\.argv\[1\]\)\.href/)
  assert.equal(/endsWith\('清图片副本\.mjs'\)/.test(src.replace(/\/\/.*$/gm, '')), false,
    '中文路径在 import.meta.url 里是 URL 编码的，endsWith 永远 false —— 主流程会一次都不跑')
})
