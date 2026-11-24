// 批次519：图片图鉴 —— 同一张图她得认得出来
//
// 主人 2026-11-16 04:18：「她的记忆系统不能记忆之前看到过的表情包吗？
//                        感觉发过的表情包她每次都像是第一次看见一样」
//
// 实测：「收到的图片」41 个文件里只有 27 张不同的图，13 组重复，多存 14 份。
// 最多的一张（顶盆那只 98A1DBF5）被存了 3 次：11-15 18:52 / 11-16 01:11 / 11-16 04:01。
// 她三次都当新图看，而那张图她在 01:21 亲自起过名字叫「紫鸟翘脚站桩」。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// t453 A1：文件里出现插件路径就要静音
process.env.QUIET_NOTE = '1'
// 沙盒：绝不碰她真实的 看图记录.json
const 沙盒 = mkdtempSync(join(tmpdir(), 'imgmem-'))
process.env.QQ_IMG_MEM = 沙盒

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 图的指纹, 见过这张图, 记看图, 读图鉴 } = await import(LIB + '/images.js')

const MD5 = '98A1DBF534945797EBF5BB27B67E58C7'

test('M1 指纹优先取 QQ 文件名里的 MD5（它本身就是 md5）', () => {
  assert.equal(图的指纹({ file: MD5 + '.jpg' }, Buffer.from('x')), MD5)
  assert.equal(图的指纹({ file: MD5.toLowerCase() + '.gif' }, Buffer.from('x')), MD5, '小写没转大写')
})

test('M2 文件名里没有 md5 时退回内容哈希（别返回空）', () => {
  const f = 图的指纹({ file: 'abc.png' }, Buffer.from('hello'))
  assert.match(f, /^[0-9A-F]{32}$/, '没退回内容哈希：' + f)
  // 同样内容必须同样指纹 —— 否则去重直接失效
  assert.equal(f, 图的指纹({ file: '' }, Buffer.from('hello')))
})

test('M3 没见过就返回 null（不能返回空对象，那会被当成「见过」）', () => {
  assert.equal(见过这张图(MD5), null)
  assert.equal(见过这张图(''), null)
  assert.equal(见过这张图(null), null)
})

test('M4 第一次记：次数=1；第二次记：次数=2 且首次不变', () => {
  const a = 记看图(MD5, { uin: '{{OWNER_UIN}}' })
  assert.equal(a.次数, 1)
  const 首次 = a.首次
  assert.ok(首次 && 首次.length >= 10, '首次时间是空的')
  const b = 记看图(MD5, { uin: '{{OWNER_UIN}}' })
  assert.equal(b.次数, 2)
  assert.equal(b.首次, 首次, '首次被覆盖了 —— 那就不叫「最早一次」')
})

test('M5 名字只写一次，后来的空名字不许把它冲掉', () => {
  记看图(MD5, { 名字: '紫鸟翘脚站桩' })
  const 有 = 见过这张图(MD5)
  assert.equal(有.名字, '紫鸟翘脚站桩')
  const 后 = 记看图(MD5, { 名字: '' })
  assert.equal(后.名字, '紫鸟翘脚站桩', '空名字把真名字冲掉了')
})

test('M6 落盘在沙盒里，没碰真实记忆目录', () => {
  assert.ok(existsSync(join(沙盒, '看图记录.json')), '没写到沙盒')
  assert.ok(!读图鉴()['nope'], '读出来不该有的东西')
})

test('M7 saveImageCopy 必须先去重再落盘（源码顺序）', () => {
  const s = readFileSync(LIB + '/images.js', 'utf8')
  const i = s.indexOf('function saveImageCopy(')
  assert.ok(i > 0)
  const 体 = s.slice(i, i + 5000)   // saveImageCopy 里注释多，2000 字符到不了 writeFileSync
  const 查 = 体.indexOf('见过这张图(指纹)')
  const 写 = 体.indexOf('writeFileSync(path, data)')
  assert.ok(查 > 0, 'saveImageCopy 里没查图鉴')
  assert.ok(写 > 查, '先落盘后查重 —— 等于没去重')
})

test('M8 认识的图要在图片前面插一句身份（不是只记日志）', () => {
  const s = readFileSync(LIB + '/images.js', 'utf8')
  const i = s.indexOf('buildImageBlocks')
  assert.ok(i > 0)
  const 体 = s.slice(i, i + 4000)
  assert.ok(体.includes("text: '（你见过这张图'"), '没有身份提示')
  const 提 = 体.indexOf("text: '（你见过这张图'")
  const 图 = 体.indexOf("blocks.push({ type: 'image'")
  assert.ok(提 > 0 && 图 > 提, '提示没插在图片前面')
})

test('M9 提示里必须带名字和次数，否则她还是不知道是哪张', () => {
  const s = readFileSync(LIB + '/images.js', 'utf8')
  assert.ok(s.includes('你自己给它起过名字'), '没带名字')
  assert.ok(s.includes('第 ${次} 次看到'), '没带次数')
  assert.ok(s.includes('别当成新图'), '没明确说「不是新的」')
})

test('M10 真档回填过：顶盆那张有名字', () => {
  const p = '{{BOT_ROOT}}/记忆/看图记录.json'
  if (!existsSync(p)) return   // 沙盒/别的机器上没回填就跳过
  const j = JSON.parse(readFileSync(p, 'utf8'))
  const 有名字 = Object.values(j).filter((v) => String(v?.名字 ?? '') !== '')
  assert.ok(有名字.length >= 20, '回填的名字太少：' + 有名字.length)
  assert.ok(Object.keys(j).length >= 27, '图鉴条数少于不同图的张数：' + Object.keys(j).length)
})

test.after(() => { try { rmSync(沙盒, { recursive: true, force: true }) } catch {} })
