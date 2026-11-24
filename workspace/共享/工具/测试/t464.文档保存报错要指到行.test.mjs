// t464.文档保存报错要指到行.test.mjs —— 批次464（2026-11-14）
//
// 主人截图里那个报错「JSON 格式不对，没保存：Expected ',' or ']' after array element at position 378
// (line 6 column 2)」—— 只说行列，编辑框早滚到别处了，根本看不到是哪一行。
// 现在报错会带上**那一行的原文** + 一句「文件没动，点「重新读」可还原」。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import crypto from 'node:crypto'

const 工具 = '{{BOT_ROOT}}/共享/工具'
const 源 = fs.readFileSync(工具 + '/面板.mjs', 'utf8')

const 令牌 = () => {
  const KEY = JSON.parse(fs.readFileSync(工具 + '/面板密钥.json', 'utf8'))
  const b = Buffer.from(JSON.stringify({ qq: '{{OWNER_UIN}}', role: 'owner', exp: Date.now() + 600000 })).toString('base64url')
  const mac = crypto.createHmac('sha256', KEY.secret).update(b).digest('base64url')
  return 'fish_session=' + encodeURIComponent(b + '.' + mac)
}

test('A1 源码里带「指到行」和「文件没动」两句', () => {
  assert.ok(源.includes('点「重新读」可还原'), '报错里没有「点重新读可还原」')
  assert.ok(/位置\s*=\s*' ｜ 第 ' \+ 行号/.test(源), '没有算出错位置的代码')
})

test('A2 真 POST 一段坏 JSON：报错里必须有行号和那一行原文', async (t) => {
  const cookie = 令牌()
  const 坏 = '{\n "表达": {\n  "许可": [\n   "一",\n   "二"\n   "三"\n  ]\n }\n}'
  let r
  try {
    r = await fetch('http://127.0.0.1:8788/api/doc', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ f: '人味', 内容: 坏 }),
    })
  } catch (e) { t.skip('面板没起，判不了'); return }
  const j = await r.json()
  assert.equal(j.ok, false, '坏 JSON 居然存进去了')
  assert.match(j.msg, /第 6 行/, '报错里没说是第几行：' + j.msg)
  assert.match(j.msg, /"三"/, '报错里没带出错那一行的原文：' + j.msg)
})

test('A3 原样提交不改文件（幂等）', async (t) => {
  const cookie = 令牌()
  const 原 = fs.readFileSync('{{BOT_ROOT}}/记忆/人味.json', 'utf8')
  let r
  try {
    r = await fetch('http://127.0.0.1:8788/api/doc', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ f: '人味', 内容: 原 }),
    })
  } catch (e) { t.skip('面板没起，判不了'); return }
  const j = await r.json()
  assert.equal(j.ok, true)
  assert.equal(j.未变, true, '原样提交居然被当成改动')
  assert.equal(fs.readFileSync('{{BOT_ROOT}}/记忆/人味.json', 'utf8'), 原)
})
