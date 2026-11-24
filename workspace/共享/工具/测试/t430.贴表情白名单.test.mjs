import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 主人 2026-11-04 建库那天就留了 `_白名单`/`_白名单编号`/`_避雷`，规矩写着
// 「只贴主人给的白名单，其余不碰」。四十天里**没有任何一行代码执行过它** ——
// 她能贴「微笑」「抠鼻」这些主人点名别乱贴的（库里有 187 个，白名单 21 个）。
// 批次425 加第三道闸。这里锁五件事：白名单内能贴、外面拦住、名字=编号那条边界、
// 库坏了不拦、拦下来不许留账。
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 贴 = join(LIB, '贴表情.mjs')

// 成功路径一共两次 send：set_msg_emoji_like（真贴）+ get_msg（问「贴在谁的哪句话上」）。
// 断言「贴了几次」要按 action 数，不能数 calls.length —— 那是 2。
const 真贴 = (calls) => calls.filter((x) => x && x.action === 'set_msg_emoji_like')

const 库 = (白名单) => ({
  名字到编号: { 微笑: '14', 赞: '76', 敲打: '38', 抠鼻: '98', 476: '476' },
  编号到名字: { 14: '微笑', 76: '赞', 38: '敲打', 98: '抠鼻' },
  _白名单: '流泪 476 赞 敲打',
  _白名单编号: 白名单 === undefined ? { 流泪: '5', 476: '476', 赞: '76', 敲打: '38' } : 白名单,
})

function 造(白名单) {
  const sb = mkdtempSync(join(tmpdir(), 'react425-'))
  if (白名单 !== null) writeFileSync(join(sb, '表情编号库.json'), JSON.stringify(库(白名单)))
  writeFileSync(join(sb, '表情回应.jsonl'), '')
  return sb
}

/** 每个用例一个独立进程：BASE / MAX_PER_HOUR 都是模块顶层求值，同进程里换沙盒换不掉。 */
function 试(sb, emoji, mid = 9001) {
  const 代码 = `
    const { reactTo } = await import(${JSON.stringify(贴)})
    const calls = []
    const r = await reactTo({
      messageId: ${mid}, emoji: ${JSON.stringify(emoji)},
      send: async (x) => { calls.push(x); return { retcode: 0 } },
    })
    console.log(JSON.stringify({ r, calls }))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, LIKE_BASE: sb },
  })
  return JSON.parse(out.trim().split('\n').pop())
}

test('R1 白名单里的能贴，编号也对', () => {
  const sb = 造()
  try {
    const { r, calls } = 试(sb, '赞')
    assert.equal(r.ok, true, JSON.stringify(r))
    const 贴的 = 真贴(calls)
    assert.equal(贴的.length, 1)
    assert.equal(贴的[0].params.emoji_id, '76')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R2 白名单外的一律不贴，而且一个字节都不发出去', () => {
  const sb = 造()
  try {
    for (const 名 of ['微笑', '抠鼻']) {
      const { r, calls } = 试(sb, 名)
      assert.equal(r.ok, false, 名 + ' 贴出去了')
      assert.equal(calls.length, 0, 名 + ' 还是发了协议请求')
      assert.match(r.message, /贴不了/, r.message)
    }
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R3 名字和编号一样的那条（476）不能漏判', () => {
  // lib() 有意把「名字===编号」的条目排除在 idToName 外，拿名字反查会漏 —— 所以判据用编号
  const sb = 造()
  try {
    const { r, calls } = 试(sb, '476')
    assert.equal(r.ok, true, JSON.stringify(r))
    const 贴的 = 真贴(calls)
    assert.equal(贴的.length, 1)
    assert.equal(贴的[0].params.emoji_id, '476')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R4 数字 id 也要过白名单（不能靠「纯数字直接放行」绕过去）', () => {
  const sb = 造()
  try {
    const r1 = 试(sb, '76')
    assert.equal(r1.r.ok, true)
    const r2 = 试(sb, '14')
    assert.equal(r2.r.ok, false, '14 是「微笑」，不该贴出去')
    assert.equal(r2.calls.length, 0)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R5 库读不到的时候不许拦（文件坏了不该让她一句话都贴不了）', () => {
  const sb = 造(null)
  try {
    const { r, calls } = 试(sb, '赞')
    assert.equal(r.ok, true, '没有白名单就照旧贴：' + JSON.stringify(r))
    assert.equal(真贴(calls).length, 1)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R6 拒的时候要告诉她能贴哪些，不能只说「不行」', () => {
  const sb = 造()
  try {
    const { r } = 试(sb, '微笑')
    for (const 名 of ['流泪', '476', '赞', '敲打']) assert.ok(r.message.includes(名), '文案里缺 ' + 名 + '：' + r.message)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R7 拦下来的不记账（账本是「贴过什么」的账，不是「试过什么」）', () => {
  const sb = 造()
  try {
    试(sb, '微笑')
    const 账 = readFileSync(join(sb, '表情回应.jsonl'), 'utf8').trim()
    assert.equal(账, '', '被拦的那次写进账本了：' + 账)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R8 以前那两道闸还在（同一条消息只贴一次）', () => {
  const sb = 造()
  try {
    assert.equal(试(sb, '赞').r.ok, true)
    const 二 = 试(sb, '敲打')
    assert.equal(二.r.ok, false, '同一条消息贴了第二个')
    assert.match(二.r.message, /贴过/, 二.r.message)
    assert.equal(二.calls.length, 0)
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('R9 每小时上限必须现读，不能是模块顶层常量', () => {
  // 面板上写着「立即生效」、卡片写着「改完她下一次贴表情就按新值判」。
  // 原来 `const MAX_PER_HOUR = 每小时上限()` 是 import 时算一次 —— 改完不重启不生效，
  // 批次426 在浏览器里真点了一遍才发现（API 层完全看不出来：接口返回都是 ok）。
  const s = readFileSync(贴, 'utf8')
  assert.doesNotMatch(s, /^const MAX_PER_HOUR/m, '上限又被写回模块顶层常量了')
  assert.match(s, /const 上限 = 每小时上限\(\)/, 'reactTo 里没现读上限')
  assert.match(s, /limit: 每小时上限\(\)/, 'reactStats 的 limit 没现读')
})
