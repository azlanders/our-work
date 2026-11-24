import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次449：qq_audio_understand 的描述在说一件做不到的事。
//
// 原文：「他发来语音、或你下载目录里有音频想弄清楚内容时用 —— 听不清/不确定语气就别猜，调它听一遍。」
// 证据是反的：
//   · onebot.js 只把 `record` 段渲染成 '[语音]'，**语音文件从来不落盘**；
//   · 这个工具只认 `AUDIO_INPUT_DIR` 里的裸文件名，路径带 / 直接拒。
// 于是收到语音时她手上根本没有文件名可填 —— 0 次调用不是她不想用，是这条路不存在。
// 而且描述先教她「别猜，调它听一遍」，实际调了只会报错，反而更容易让她编排语音内容。
//
// 这条锁：描述必须说真话（没文件就说没有），闸不能被顺手放松。

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

async function 拿定义() {
  const defs = []
  const tools = { register(d) { defs.push(d); return () => {} } }
  const ctx = { tools, get: (k) => (k === 'tools' ? tools : undefined), effect() {}, log() {}, getConfig: () => ({}) }
  const m = await import(LIB + '/tool.js')
  await m.registerAudioUnderstandTool(ctx)
  const d = defs.find((x) => x && x.name === 'qq_audio_understand')
  assert.ok(d, 'qq_audio_understand 没注册上')
  return d
}

test('A1 描述不许再承诺「他发来语音就能调」——语音根本不落盘', async () => {
  const d = await 拿定义()
  assert.doesNotMatch(d.description, /他发来语音/, '描述还在把「收到的语音」当成可分析的输入')
})

test('A2 必须写明 QQ 语音不会存到那个目录（说清为什么没有文件）', async () => {
  const d = await 拿定义()
  assert.match(d.description, /语音消息不会存/, '没告诉她语音不落盘 —— 她会以为是自己没找到')
})

test('A3 必须叫她别猜语音内容（不然只会编）', async () => {
  const d = await 拿定义()
  assert.match(d.description, /别猜/, '没有「别猜」这条 —— 只有 [语音] 两个字时她会自己编一套')
})

test('A4 参数边界写清楚：只认裸文件名，不接受路径', async () => {
  const d = await 拿定义()
  assert.match(d.description, /裸文件名/, '没写清只认裸文件名')
  assert.match(d.description, /不接受路径/, '没写清不接受路径')
})

test('A5 confirm 闸还在（不能顺着这次修改放松）', async () => {
  const d = await 拿定义()
  assert.deepEqual(d.parameters.required, ['file', 'confirm'], 'required 变了，先确认再改')
  await assert.rejects(() => d.execute({ file: 'x.mp3' }), /confirm/, '不给 confirm 居然放行了')
})

test('A6 带斜杠的路径当场被拒，且报错说清原因', async () => {
  const d = await 拿定义()
  await assert.rejects(() => d.execute({ file: 'sub/x.mp3', confirm: true }), /只允许指定下载目录中的单个文件名/)
  await assert.rejects(() => d.execute({ file: '../x.mp3', confirm: true }), /只允许指定下载目录中的单个文件名/)
})

test('A7 描述里点名的目录必须真存在（不然连合法文件都跑不了）', async () => {
  const d = await 拿定义()
  // 注意：字符集必须同时含 `/` 和中文。第一版漏中文 → `{{BOT_ROOT}}/下载音频` 只截到
  // `{{BOT_ROOT}}/`（存在）；第二版把 `/` 漏了 → 只截到 `/data`（更存在）。两次都假通过。
  const m = d.description.match(/(\/[A-Za-z0-9_\-.\/\u4e00-\u9fa5]+)/)
  assert.ok(m, '描述里没写目录')
  assert.ok(existsSync(m[1]), '描述里的目录不存在：' + m[1])
})
