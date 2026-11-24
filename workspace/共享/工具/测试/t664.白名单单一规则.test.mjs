// 批次664（审计 P1-9）：白名单规则只有一份
//   608 的 发送口.mjs 复制了 normUin / 允许目标 / 校验目标，
//   和插件 allowlist.js 各算一套。插件以后改规则，cron/心跳那条路会静默分叉。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const 这里 = path.dirname(fileURLToPath(import.meta.url))
const 工具 = path.join(这里, '..')
const lib = process.env.QQ_LIB_DIR || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 有规则 = existsSync(path.join(lib, 'allowlist-rules.js'))
const 跳过 = '找不到 allowlist-rules.js'

const 规则 = 有规则 ? await import(pathToFileURL(path.join(lib, 'allowlist-rules.js')).href) : null
const 发送口 = await import(pathToFileURL(path.join(工具, '发送口.mjs')).href)

const 配置 = (extra = {}) => ({
  peerUin: {{OWNER_UIN}},
  ownerUin: {{OWNER_UIN}},
  groupUins: [2000000001, 1051483012],
  routes: { private: { 123456: 's1' }, group: { 999888: 's2' } },
  ...extra,
})

test('W1 共享规则模块与发送口判定一致（允许）', { skip: 有规则 ? false : 跳过 }, () => {
  const cfg = 配置()
  for (const [kind, id] of [['private', '{{OWNER_UIN}}'], ['private', '123456'], ['group', '2000000001'], ['group', '999888']]) {
    assert.equal(规则.checkTarget(cfg, kind, id).ok, true, `${kind} ${id}`)
    assert.equal(发送口.校验目标(cfg, kind, id).ok, true, `${kind} ${id}`)
  }
})

test('W2 共享规则模块与发送口判定一致（拒绝）', { skip: 有规则 ? false : 跳过 }, () => {
  const cfg = 配置()
  for (const [kind, id] of [['private', '999999999'], ['group', '111222333']]) {
    const a = 规则.checkTarget(cfg, kind, id)
    const b = 发送口.校验目标(cfg, kind, id)
    assert.equal(a.ok, false)
    assert.equal(b.ok, false)
    assert.match(b.err, /白名单拦截/)
  }
})

test('W3 空名单 / 逃生阀边界两边一致', { skip: 有规则 ? false : 跳过 }, () => {
  const 空 = { peerUin: 0, ownerUin: 0, groupUins: [], routes: {} }
  assert.equal(规则.checkTarget(空, 'private', '555').ok, true)
  assert.equal(发送口.校验目标(空, 'private', '555').ok, true)
  const 放行 = 配置({ allowSendToAny: true })
  assert.equal(规则.checkTarget(放行, 'private', '555').ok, true)
  assert.equal(发送口.校验目标(放行, 'private', '555').ok, true)
})

test('W4 发送类 action 映射只在共享模块里有一份', { skip: 有规则 ? false : 跳过 }, () => {
  assert.deepEqual(规则.sendTargetOf('send_poke', { user_id: {{OWNER_UIN}} }), { kind: 'private', id: '{{OWNER_UIN}}' })
  assert.deepEqual(规则.sendTargetOf('group_poke', { group_id: 2000000001 }), { kind: 'group', id: '2000000001' })
  assert.equal(规则.sendTargetOf('get_login_info', {}), null)
  // 插件侧 re-export 的就是同一份实现
  assert.equal(typeof 发送口.normUin, 'function')
})

test('W5 发送口报告自己用了哪套规则（可定位分叉）', () => {
  assert.ok(['lib', 'builtin'].includes(发送口.规则来源是()))
})
