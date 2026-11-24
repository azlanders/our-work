// 批次524：图片「我见过这张」提示的**行为**测试（不是查源码）
//
// 由来：线上日志里 `这张是第一次见` 出现过 2 次，但 `你见过这张图` 一直是 0 次。
// 不能靠「大概是没人重复发」搪塞 —— 造一张图鉴里已有的图，直接喂 buildImageBlocks，
// 看它到底生不生成那句提示、内容对不对、顺序在图片前面还是后面。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.QUIET_NOTE = '1'

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iAAAAABJRU5ErkJggg==',
  'base64',
)

const 沙盒 = mkdtempSync(join(tmpdir(), 'qq-img-hint-'))
process.chdir(沙盒)                     // 让「收到的图片」那类相对路径落在沙盒里，别弄脏工作区
process.env.QQ_IMG_MEM = join(沙盒, '记忆')
mkdirSync(process.env.QQ_IMG_MEM, { recursive: true })

const 已有 = 'AABBCCDDEEFF00112233445566778899'
const 新的 = '112233445566778899AABBCCDDEEFF00'
// 注意：buildImageBlocks 走一遍就会 saveImageCopy → 记看图，把这张记进图鉴。
// 所以「要测第一次见」的用例必须各用一个从没出现过的 md5，不能复用 新的。
const 又一张新的 = '99887766554433221100FFEEDDCCBBAA'

writeFileSync(
  join(process.env.QQ_IMG_MEM, '看图记录.json'),
  JSON.stringify({
    [已有]: {
      首次: '2026-11-15 18:52', 最近: '2026-11-16 01:11', 次数: 4,
      名字: '紫鸟翘脚站桩', 描述: '蓝发小人顶着不锈钢盆，盆沿压到耳朵下面',
    },
  }, null, 1),
)

const { buildImageBlocks } = await import(LIB + '/images.js')

// 本地图床：必须真下得到，否则 buildImageBlocks 会在 fetch 那步抛错
const 服务 = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'image/png' })
  res.end(PNG)
})
await new Promise((r) => 服务.listen(0, '127.0.0.1', r))
const 端口 = 服务.address().port
const 图 = (md5) => [{
  sender: { user_id: '{{OWNER_UIN}}' },
  message: [{ type: 'image', data: { url: `http://127.0.0.1:${端口}/${md5}.png`, file: `${md5}.png` } }],
}]

test.after(() => {
  服务.close()
  try { rmSync(沙盒, { recursive: true, force: true }) } catch { /* 忽略 */ }
})

test('H1 见过的图必须生成「你见过这张图」，并带名字、描述、第几次、最早时间', async () => {
  const blocks = await buildImageBlocks({}, 图(已有))
  const 文本 = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(文本.includes('你见过这张图'), '没生成「你见过这张图」，实际块：' + JSON.stringify(blocks.map((b) => b.type)))
  assert.ok(文本.includes('紫鸟翘脚站桩'), '没带名字：' + 文本)
  assert.ok(文本.includes('蓝发小人顶着不锈钢盆'), '没带描述：' + 文本)
  assert.ok(文本.includes('第 5 次'), '次数不对（图鉴记 4 次，这次是第 5）：' + 文本)
  assert.ok(文本.includes('2026-11-15 18:52'), '没带最早时间：' + 文本)
  assert.ok(文本.includes('别当成新图'), '没有收尾那句：' + 文本)
})

test('H2 提示必须排在图片前面（顺序反了她会先看图再读说明）', async () => {
  const blocks = await buildImageBlocks({}, 图(已有))
  const 文本位 = blocks.findIndex((b) => b.type === 'text' && String(b.text).includes('你见过这张图'))
  const 图位 = blocks.findIndex((b) => b.type === 'image')
  assert.ok(文本位 >= 0, '没有提示块')
  if (图位 >= 0) assert.ok(文本位 < 图位, '提示排在图片后面了：text@' + 文本位 + ' image@' + 图位)
})

test('H3 没见过的图生成「第一次见」，而且不许误报「你见过」', async () => {
  const blocks = await buildImageBlocks({}, 图(新的))
  const 文本 = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(文本.includes('这张是第一次见'), '新图没提示：' + 文本)
  assert.ok(!文本.includes('你见过这张图'), '新图被当成见过的了：' + 文本)
})

test('H4 没记过描述的老图，要说「你还没记过它里面是什么」', async () => {
  const 无描述 = 'FFEEDDCCBBAA00998877665544332211'
  const 档 = JSON.parse(readFileSync(join(process.env.QQ_IMG_MEM, '看图记录.json'), 'utf8'))
  档[无描述] = { 首次: '2026-11-14 10:00', 最近: '2026-11-14 10:00', 次数: 1 }
  writeFileSync(join(process.env.QQ_IMG_MEM, '看图记录.json'), JSON.stringify(档, null, 1))

  const blocks = await buildImageBlocks({}, 图(无描述))
  const 文本 = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(文本.includes('你还没记过它里面是什么'), '没提示去记描述：' + 文本)
  assert.ok(!文本.includes('你自己给它起过名字'), '没名字却写了名字那半句：' + 文本)
})

test('H5 同一条消息两张图（一张见过一张没有），两句提示都要出', async () => {
  const blocks = await buildImageBlocks({}, [{
    sender: { user_id: '{{OWNER_UIN}}' },
    message: [
      { type: 'image', data: { url: `http://127.0.0.1:${端口}/${已有}.png`, file: `${已有}.png` } },
      { type: 'image', data: { url: `http://127.0.0.1:${端口}/${又一张新的}.png`, file: `${又一张新的}.png` } },
    ],
  }])
  const 文本 = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(文本.includes('你见过这张图'), '见过的没提示：' + 文本)
  assert.ok(文本.includes('这张是第一次见'), '新的没提示：' + 文本)
})

test('H6 图鉴文件坏掉时不许抛（图片该收还是要收）', async () => {
  writeFileSync(join(process.env.QQ_IMG_MEM, '看图记录.json'), '{ 这不是 json')
  const blocks = await buildImageBlocks({}, 图(已有))
  assert.ok(Array.isArray(blocks), '返回不是数组')
  // 读不出来就当没见过，走「第一次见」分支
  const 文本 = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  assert.ok(文本.includes('这张是第一次见'), '图鉴坏了没有兜底成新图：' + 文本)
})
