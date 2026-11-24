// t608.发送口.test.mjs —— 独立脚本统一出站（批次608）
//
// 覆盖：目标白名单 / 逃生阀 / 空白名单放行 / 本机路径抹除 / 凭据拦截 /
//       {action,params} 请求体 / requireMsgId / 三个脚本不再直连协议端。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 这里 = path.dirname(fileURLToPath(import.meta.url))
const 工具 = path.join(这里, '..')
const S = await import(pathToFileURL(path.join(工具, '发送口.mjs')).href)

const 配置 = (extra = {}) => ({
  onebotHttp: 'http://127.0.0.1:3001/',
  token: 'tk',
  peerUin: {{OWNER_UIN}},
  ownerUin: {{OWNER_UIN}},
  groupUins: [2000000001, 1051483012],
  routes: { private: { 123456: 's1' }, group: { 999888: 's2' } },
  ...extra,
})

test('S1 私聊白名单：peerUin / routes 允许，陌生人拒绝且 fatal', () => {
  const cfg = 配置()
  assert.equal(S.校验目标(cfg, 'private', '{{OWNER_UIN}}').ok, true)
  assert.equal(S.校验目标(cfg, 'private', '123456').ok, true)
  const r = S.校验目标(cfg, 'private', '999999999')
  assert.equal(r.ok, false)
  assert.equal(r.fatal, true)
  assert.match(r.err, /白名单拦截/)
})

test('S2 群白名单：groupUins / routes.group 允许，陌生群拒绝', () => {
  const cfg = 配置()
  assert.equal(S.校验目标(cfg, 'group', '2000000001').ok, true)
  assert.equal(S.校验目标(cfg, 'group', '999888').ok, true)
  const r = S.校验目标(cfg, 'group', '111222333')
  assert.equal(r.ok, false)
  assert.equal(r.fatal, true)
})

test('S3 逃生阀 allowSendToAny=true 放行；白名单全空也放行（不锁死新机器）', () => {
  assert.equal(S.校验目标(配置({ allowSendToAny: true }), 'private', '555').ok, true)
  const 空 = { peerUin: 0, ownerUin: 0, groupUins: [], routes: {} }
  const r = S.校验目标(空, 'private', '555')
  assert.equal(r.ok, true)
  assert.match(r.warn, /白名单为空/)
})

test('S4 本机路径抹成占位符，凭据特征拦截', () => {
  assert.equal(
    S.抹路径('我看了 {{DSH_ROOT}}/qq-bridge.config.json 和 C:\\Users\\x\\a.txt'),
    '我看了 （地址略） 和 （地址略）'
  )
  assert.equal(S.查敏感('token=abcdef1234').kind, 'credential')
  assert.equal(S.查敏感('今天天气不错'), null)
  const 拦截 = S.审消息([{ type: 'text', data: { text: '密码：hunter2xyz' } }])
  assert.equal(拦截.ok, false)
  assert.equal(拦截.fatal, true)
  assert.match(拦截.err, /审计拦截/)
})

test('S5 代理风格请求体是 {action, params}，并带回 message_id', async () => {
  const 原fetch = globalThis.fetch
  let 收到 = null
  globalThis.fetch = async (url, opts) => {
    收到 = { url, body: JSON.parse(opts.body) }
    return new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 777 } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const r = await S.发私聊(配置(), '{{OWNER_UIN}}', '早', { requireMsgId: true })
    assert.equal(r.ok, true)
    assert.equal(r.msgId, 777)
    assert.equal(收到.url, 'http://127.0.0.1:3001/')
    assert.equal(收到.body.action, 'send_private_msg')
    assert.equal(收到.body.params.user_id, {{OWNER_UIN}})
    assert.equal(收到.body.params.message[0].data.text, '早')
  } finally {
    globalThis.fetch = 原fetch
  }
})

test('S6 直连 3000 配置自动切成 /action + 扁平参数', async () => {
  const 原fetch = globalThis.fetch
  let 收到 = null
  globalThis.fetch = async (url, opts) => {
    收到 = { url, body: JSON.parse(opts.body) }
    return new Response(JSON.stringify({ retcode: 0, data: { message_id: 1 } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  }
  try {
    const cfg = 配置({ onebotHttp: 'http://127.0.0.1:3011/' })
    const r = await S.发群(cfg, '2000000001', '哈')
    assert.equal(r.ok, true)
    assert.equal(收到.url, 'http://127.0.0.1:3011/send_group_msg')
    assert.equal(收到.body.group_id, 2000000001)
    assert.equal(收到.body.action, undefined)
  } finally {
    globalThis.fetch = 原fetch
  }
})

test('S7 retcode 0 但没有 message_id：requireMsgId 时不算成功，且不是 fatal', async () => {
  const 原fetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ retcode: 0, data: {} }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  })
  try {
    const r = await S.发私聊(配置(), '{{OWNER_UIN}}', '早', { requireMsgId: true })
    assert.equal(r.ok, false)
    assert.equal(r.fatal, false)
    assert.match(r.err, /message_id/)
  } finally {
    globalThis.fetch = 原fetch
  }
})

test('S8 网络失败返回可重试（fatal=false）；白名单/审计失败不重试', async () => {
  const 原fetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED') }
  try {
    const r = await S.发私聊(配置(), '{{OWNER_UIN}}', '早')
    assert.equal(r.ok, false)
    assert.equal(r.fatal, false)
    assert.match(r.err, /ECONNREFUSED/)
  } finally {
    globalThis.fetch = 原fetch
  }
  assert.equal((await S.发私聊(配置(), '999999999', '早')).fatal, true)
  assert.equal((await S.发私聊(配置(), '{{OWNER_UIN}}', 'token=abcdef1234')).fatal, true)
})

test('S9 三个脚本不再直连协议端（源码回归）', () => {
  for (const 名 of ['投递留言.mjs', '发表情.mjs', '发卡片.mjs']) {
    const src = fs.readFileSync(path.join(工具, 名), 'utf8')
    assert.doesNotMatch(src, /fetch\([^)]*send_(private|group)_msg/, `${名} 不应直连协议端`)
    assert.match(src, /发送口\.mjs/, `${名} 应走统一发送口`)
  }
  const 投递 = fs.readFileSync(path.join(工具, '投递留言.mjs'), 'utf8')
  assert.match(投递, /else if \(r\.fatal\)/, '拒发要标终态，不能重试 20 次')
  assert.match(投递, /标跳过\(\{ x: t\.x, act: '拒发'/, '拒发写进 skip')
})
