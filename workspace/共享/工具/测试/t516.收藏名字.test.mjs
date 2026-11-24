// 批次515c-e：收藏表情的「名字」不能被兜底名盖掉
//
// 依据（2026-11-16 01:13–01:22 私聊 + 日志）：
//   01:13:23  收藏 98A1DBF5，名字「顶盆站桩不吭声」
//   01:17:19  再收一遍同一张，**没给名字** → 兜底成 md5 文件名，把真名盖掉
//   01:21:49  第三次收藏，名字「紫鸟翘脚站桩」才救回来
//   同期：17:16:22 投的「[接着做]」跑到 17:23 还没结束（7 分钟），
//         两条队列条目到 TTL 被丢弃（17:22:22 / 17:23:02，各等 360 秒）
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

process.env.QUIET_NOTE = '1'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const { 定名字 } = await import(LIB + '/collect.js')

const MD5名 = '98A1DBF534945797EBF5BB27B67E58C7'

test('N1 这次明确给的名字最优先（那是改名，得认）', () => {
  assert.equal(定名字('紫鸟翘脚站桩', MD5名, '顶盆站桩不吭声'), '紫鸟翘脚站桩')
})

test('N2 没给名字、但有旧名字：保留旧名字，不许 md5 兜底盖掉', () => {
  assert.equal(定名字('', MD5名, '顶盆站桩不吭声'), '顶盆站桩不吭声')
  assert.equal(定名字(undefined, MD5名, '顶盆站桩不吭声'), '顶盆站桩不吭声')
  assert.equal(定名字(null, MD5名, '顶盆站桩不吭声'), '顶盆站桩不吭声')
})

test('N3 第一次收藏（没有旧名字）：用兜底名，聊胜于无', () => {
  assert.equal(定名字('', MD5名, ''), MD5名)
  assert.equal(定名字(undefined, MD5名, undefined), MD5名)
})

test('N4 空白串一律当「没给」，不能写进表里变成空名字', () => {
  assert.equal(定名字('   ', MD5名, '顶盆站桩不吭声'), '顶盆站桩不吭声')
  assert.equal(定名字('\n\t', MD5名, ''), MD5名)
})

test('N5 旧名字本身是空白：不算有名字', () => {
  assert.equal(定名字('', MD5名, '   '), MD5名)
})

test('N6 全空也不能返回 undefined（否则 saveFaceName 直接不写）', () => {
  assert.equal(定名字('', '', ''), '')
  assert.equal(typeof 定名字(undefined, undefined, undefined), 'string')
})

test('N7 必须真的接在收藏主链路上，不是只导出个函数没人用', () => {
  const 源码 = readFileSync(LIB + '/collect.js', 'utf8')
  const i = 源码.indexOf('const desc = 定名字(')
  assert.ok(i > 0, 'collectFace 没调用 定名字')
  const 前 = 源码.slice(Math.max(0, i - 700), i)
  assert.ok(前.includes('readFaceNames()'), '没先读旧名字就定名字 —— 旧名永远是空')
  const 后 = 源码.slice(i, i + 600)
  assert.ok(后.includes('saveFaceName('), '定了名字却没写进表')
})

test('N8 工具返回必须告诉她「名字改不了」，否则她还会反复重收', () => {
  const 源码 = readFileSync(LIB + '/tool.js', 'utf8')
  assert.ok(源码.includes('改不了名'), '返回里没这句')
  assert.ok(源码.includes('先删再收'), '没告诉她换名的唯一办法')
})

test('N9 返回字段没多出来（output.schema 是 additionalProperties:false，多一个就整次失败）', () => {
  const 源码 = readFileSync(LIB + '/tool.js', 'utf8')
  const i = 源码.indexOf('emoji_id: result.emojiId')
  assert.ok(i > 0, '找不到返回体')
  // 窗口要够大：这段中间夹着 8 行中文注释（NAME_LOCKED / schema 警告），400 字符根本到不了 files/faces
  const 体 = 源码.slice(Math.max(0, i - 40), i + 1200)   // 往前带一点才含 ok:
  // 允许的只有 schema 里那几个
  for (const 字段 of ['ok:', 'emoji_id:', 'origin:', 'message:', 'files:', 'faces:']) {
    assert.ok(体.includes(字段), '缺字段 ' + 字段)
  }
  assert.ok(!体.includes('desc:'), '多加了 desc 字段，schema 会判 ToolOutputError')
})
