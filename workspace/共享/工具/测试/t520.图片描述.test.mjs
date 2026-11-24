// 批次520：qq_image_note —— 让她把「这张图里是什么」记下来
//
// 主人 2026-11-16 04:30：「图片呢 图片她记得住吗」
// 04:32 选方案 B：给她一个工具直接写图鉴，不用记命令。
//
// 为什么必须有内容描述：图鉴原来只有 md5 + 名字。同一张顶盆图她起过两个名字
// （01:13「顶盆站桩不吭声」→ 01:21「紫鸟翘脚站桩」），因为每次都重新识别、
// 没有上次的结论可对 —— 这就是「每次都像第一次看见」的最后一层。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// t453 A1：文件里出现插件路径就要静音
process.env.QUIET_NOTE = '1'
const 沙盒 = mkdtempSync(join(tmpdir(), 'imgnote-'))
process.env.QQ_IMG_MEM = 沙盒

const LIB = process.env.QQ_LIB_DIR || (process.env.DSH_HOME ? (process.env.DSH_HOME + '/profiles/web/node_modules/dsh-onebot-channel/lib') : '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib')
const { 记图片描述, 见过这张图, 记看图, 路径的指纹 } = await import(LIB + '/images.js')

const MD5 = '98A1DBF534945797EBF5BB27B67E58C7'

test('N1 空描述直接拒绝（别在图鉴里留一条空记录）', () => {
  const r = 记图片描述(MD5, '   ')
  assert.equal(r.ok, false)
  assert.ok(String(r.why).includes('空'))
})

test('N2 太长的描述拒绝（图鉴要塞进每轮提示，不能无限长）', () => {
  const r = 记图片描述(MD5, '字'.repeat(400))
  assert.equal(r.ok, false)
  assert.ok(String(r.why).includes('长'))
})

test('N3 手上没有刚收到的图时，必须明说要 md5，不能瞎写一条', () => {
  const r = 记图片描述('', '蓝发小人顶着不锈钢盆')
  assert.equal(r.ok, false)
  assert.ok(String(r.why).includes('md5'), '没告诉她要给 md5：' + r.why)
})

test('N4 给了完整 md5 就能记，而且能读回来', () => {
  记看图(MD5, { uin: '{{OWNER_UIN}}' })
  const r = 记图片描述(MD5, '蓝发小人顶着不锈钢盆，盆沿压到耳朵下面')
  assert.equal(r.ok, true, JSON.stringify(r))
  const 存 = 见过这张图(MD5)
  assert.equal(存.描述, '蓝发小人顶着不锈钢盆，盆沿压到耳朵下面')
  assert.ok(String(存.描述于 ?? '').length >= 10, '没记时间')
})

test('N5 只给前 8 位也要认（她不该被要求背完整哈希）', () => {
  const r = 记图片描述(MD5.slice(0, 8), '换了个说法再记一次')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(r.md5, MD5, '没认回完整 md5')
})

test('N6 前缀对上多张时必须拒绝并说清，不能瞎挑一张', () => {
  // 造两张前缀相同的图
  记看图('ABCDEF00111111111111111111111111', {})
  记看图('ABCDEF00222222222222222222222222', {})
  const r = 记图片描述('ABCDEF00', '随便')
  assert.equal(r.ok, false, '多义前缀被瞎认了')
  assert.ok(String(r.why).includes('多张'))
})

test('N7 从落盘路径取指纹（qq_image_note 不传 md5 时靠它）', () => {
  assert.equal(路径的指纹('{{BOT_ROOT}}/收到的图片/20261116-040121_{{OWNER_UIN}}_' + MD5 + '.jpg'), MD5)
  assert.equal(路径的指纹('/x/20261115-180000_123_abc.gif'), '', '非 md5 文件名不该乱返回')
})

test('N8 工具真的注册进宿主了（不是只写了个函数没人调）', () => {
  const idx = readFileSync(LIB + '/index.js', 'utf8')
  assert.ok(idx.includes('registerImageNoteTool'), 'index.js 没 import')
  assert.ok(/void\s+registerImageNoteTool\(ctx\)/.test(idx), 'index.js 没调用')
  const tj = readFileSync(LIB + '/tool.js', 'utf8')
  assert.ok(tj.includes("name: 'qq_image_note'"), 'tool.js 里没这个名字')
  assert.ok(tj.includes('export async function registerImageNoteTool'), '没导出注册函数')
})

test('N9 白名单里有它（不在白名单，工具不下发，她根本看不见）', () => {
  const c = JSON.parse(readFileSync((process.env.DSH_HOME ? (process.env.DSH_HOME + '/qq-bridge.config.json') : '{{DSH_ROOT}}/qq-bridge.config.json'), 'utf8'))
  const w = c['工具白名单'] || []
  assert.ok(w.includes('qq_image_note'), '白名单里没有 qq_image_note')
  assert.ok(w.includes('qq_collect_face'), '顺手确认白名单本身没被写坏')
})

test('N10 返回字段必须和 output.schema 一致（多一个就 ToolOutputError）', () => {
  const tj = readFileSync(LIB + '/tool.js', 'utf8')
  const i = tj.indexOf("name: 'qq_image_note'")
  assert.ok(i > 0)
  const 段 = tj.slice(i, i + 2200)
  // schema 声明的四个字段
  for (const f of ['ok:', 'md5:', 'desc:', 'note:']) {
    assert.ok(段.includes(f), '返回体缺字段 ' + f)
  }
  // 不许出现 schema 里没声明的字段
  for (const 坏 of ['why:', 'time:', 'at:']) {
    assert.ok(!段.includes(坏), '返回体多出 schema 没声明的字段 ' + 坏)
  }
})

test('N11 收图提示要带出她写过的描述（否则记了也用不上）', () => {
  const s = readFileSync(LIB + '/images.js', 'utf8')
  assert.ok(s.includes('你当时看出的内容'), '提示里没带描述')
  assert.ok(s.includes('你还没记过它里面是什么'), '没提示她「还没记」')
  assert.ok(s.includes('qq_image_note'), '新图提示里没告诉她用哪个工具记')
})

test.after(() => { try { rmSync(沙盒, { recursive: true, force: true }) } catch {} })
