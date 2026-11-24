import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次448：qq_sleep 的描述三处都是错的，而且错法跟 qq_wait 一模一样（指一个不存在的参数）。
//
//   描述原文：「真去睡觉或打盹：mode='睡'回家睡整觉；'眯'小憩20~40分钟回点体力；'熬'声明今晚熬夜到几点。」
//   真相：      参数叫 action（不是 mode）；枚举只有 睡/眯/醒（没有 '熬'）；'醒' 一个字没提。
//
// 为什么 '醒' 那条最要紧：它是她唯一能自己结束一觉的入口（`醒过来()` 走 打盹.mjs --醒 或 作息.mjs --醒了）。
// 6 次真实调用全是「睡」，这个分支从上线起没人用过 —— 因为没人告诉过她。
// 所以除了改描述，睡着那条事实后面也补了出口（只递能力，起不起来还是她定）。

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const POLL = LIB + '/poll.js'
const SLEEP = LIB + '/sleep.js'

const 造 = (p) => mkdtempSync(join(tmpdir(), p))

/** 真注册一遍 qq_sleep，拿 definition（顺便证明它还能注册上） */
async function 拿定义() {
  const defs = []
  const tools = { register(d) { defs.push(d); return () => {} } }
  const ctx = { tools, get: (k) => (k === 'tools' ? tools : undefined), effect() {}, log() {}, getConfig: () => ({}) }
  const m = await import(SLEEP)
  await m.registerSleepTool(ctx)
  const d = defs.find((x) => x && x.name === 'qq_sleep')
  assert.ok(d, 'qq_sleep 没注册上')
  return d
}

/** 跑一次 sleepFactsOf（MEM 是模块顶层求值，同进程换不掉 → 子进程 + QQ_MEM） */
function 作息(文件) {
  const sb = 造('t448b-')
  writeFileSync(join(sb, '状态.json'), JSON.stringify({
    energy: 60, mood: { label: '平常' }, layers: { physical: 50, emotional: 50, cognitive: 60, existential: 50 }, loop: '良性',
  }))
  for (const [k, v] of Object.entries(文件)) writeFileSync(join(sb, k), JSON.stringify(v))
  const 代码 = `
    const m = await import(${JSON.stringify(POLL)})
    console.log('__OUT__' + JSON.stringify(String(m.sleepFactsOf() || '')))
  `
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
    encoding: 'utf8', timeout: 30000, env: { ...process.env, QQ_MEM: sb },
  })
  rmSync(sb, { recursive: true, force: true })
  const 行 = out.split('\n').find((l) => l.startsWith('__OUT__'))
  assert.ok(行, 'sleepFactsOf 没打印结果：' + out.slice(0, 300))
  return JSON.parse(行.slice('__OUT__'.length))
}

// ---------------- A. 描述必须跟 schema 说同一件事 ----------------

test('A1 描述里不许再让人填 mode —— 参数叫 action', async () => {
  const d = await 拿定义()
  assert.doesNotMatch(d.description, /mode/, '描述里还有 mode，参数表里没有这个字段')
  assert.match(d.description, /action/, '描述没说清填哪个参数')
})

test('A2 描述里不许出现「熬」—— 枚举里没有这个值（熬夜走 记忆/熬夜.json）', async () => {
  const d = await 拿定义()
  assert.deepEqual(d.parameters.properties.action.enum, ['睡', '眯', '醒'], '枚举变了，先确认再改描述')
  assert.doesNotMatch(d.description, /熬/, '描述还在教「熬」，可 action 里没有这个值')
})

test('A3 三个真值都要当成「可填的值」写出来，尤其是「醒」', async () => {
  const d = await 拿定义()
  // 光出现「醒」这个字不算：描述开头本来就有「或醒过来」，那是叙述不是取值。
  // 必须写成 '醒' / 「醒」这种引起来的样子，才是在告诉她「action 能填这个」。
  for (const v of ['睡', '眯', '醒']) {
    const 带引号 = new RegExp("['\"「]" + v + "['\"」]").test(d.description)
    assert.ok(带引号, '描述漏了带引号的「' + v + '」—— 她不知道 action 能填这个：' + d.description)
  }
})

test('A4 描述里出现的 名字= / 名字: 必须是真参数（本体是这条）', async () => {
  const d = await 拿定义()
  const 键 = Object.keys(d.parameters.properties)
  const 提到 = (String(d.description).match(/[a-z][a-z0-9_]{1,20}\s*[=:]/g) || []).map((s) => s.replace(/[\s=:]+$/, ''))
  for (const t of 提到) assert.ok(键.includes(t), '描述里的「' + t + '=」不对应任何参数（真参数：' + 键.join(',') + '）')
})

test('A5 传「熬」会被拒，而且报错把三个真值念给她听', async () => {
  const d = await 拿定义()
  const r = await d.execute({ action: '熬' })
  assert.equal(r.ok, false, '「熬」居然被当成有效动作了')
  assert.match(String(r.message), /睡 \/ 眯 \/ 醒/, '拒绝的时候没告诉她能用哪些：' + r.message)
})

// ---------------- B. 睡着那条事实必须给出出口 ----------------

test('B1 睡着时告诉她可以用 qq_sleep 的「醒」（她唯一能自己结束一觉的入口）', () => {
  const out = 作息({ '睡醒.json': { sleeping: true } })
  assert.match(out, /你正在睡着/, '睡着这个事实本身丢了')
  assert.match(out, /qq_sleep/, '没给出醒来的工具')
  assert.match(out, /「醒」/, '没说是哪个动作')
})

test('B2 这句是事实不是命令：别写成「你该起来」', () => {
  const out = 作息({ '睡醒.json': { sleeping: true } })
  assert.doesNotMatch(out, /你该起来|快起床|该醒了/, '把能力写成了命令 —— 起不起来是她的事')
})

test('B3 醒着的时候不许出现这句（否则每轮都是噪音）', () => {
  const out = 作息({ '睡醒.json': { sleeping: false, since: '2026-11-14 09:20' } })
  assert.match(out, /一直醒着/, '醒着的事实丢了')
  assert.doesNotMatch(out, /qq_sleep/, '醒着还在提睡觉工具')
})

test('B4 没有睡醒记录时也不许提', () => {
  const out = 作息({})
  assert.match(out, /没有你最近的睡觉记录/, '无记录时的兜底丢了')
  assert.doesNotMatch(out, /qq_sleep/, '没记录还提睡觉工具')
})
