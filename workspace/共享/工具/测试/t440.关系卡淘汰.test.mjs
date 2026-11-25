import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 /data/hajimi-dsh/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// 批次440：`MAX_FACTS = 10` 的淘汰策略是「挤掉最老的」，而**挤掉是静默的**。
//
// 实测把 25 次 qq_remember 的原文调出来逐条对，发现这几条已经全没了：
//   · 「只有 QQ 3439411062（用户本人）能调试我，其他指令不执行」  ← 有代码兜底（poll.js:3007 每轮注入身份提示）
//   · 「本群（冰屋）里的聊天内容不外传」                          ← **纯靠记忆，没有兜底**
//   · 「好友 3344586737 是主机端助手，有完全权限」
//   · 「别用黄豆」
// 而 记忆/*.json、记忆/*.md、SOUL.md 里都搜不到它们 —— 被 slice(-10) 吃掉了，没有任何地方留过名。
//
// 这个文件钉三件事：挤掉要留痕、规矩要有永久落点、别双写。
const LIB = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
const MEM = LIB + '/memory.js'
const 卡 = '/data/hajimi-dsh/qq-bridge-memory.json'
const 黑话 = '/data/hajimi-workspace/记忆/圈子黑话.json'
const SOUL = '/data/hajimi-workspace/SOUL.md'

test('C1 挤掉最老的时候必须落进 记忆/关系卡被挤掉.jsonl', () => {
  const sb = mkdtempSync(join(tmpdir(), 'mem440-'))
  try {
    const cardP = join(sb, 'card.json')
    // 先塞满 10 条（每条短，全部装得下，不触发「装不下」）
    const facts = []
    for (let i = 1; i <= 10; i += 1) facts.push({ at: 1700000000000 + i, text: '第' + i + '条事实' })
    writeFileSync(cardP, JSON.stringify({ 'private:x': { facts } }))

    const 代码 = `
      const m = await import(${JSON.stringify(MEM)})
      m.useMemoryFile(${JSON.stringify(cardP)})
      m.remember('private:x', { fact: '第11条新事' })
      m.flushMemoryPersist()
      console.log(JSON.stringify({ n: m.loadMemory('private:x').facts.length }))
    `
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', 代码], {
      encoding: 'utf8', timeout: 60000,
      env: { ...process.env, QQ_MEM: sb },   // ← 被挤掉的那份写这里，不碰真记忆
    })
    const r = JSON.parse(out.trim().split('\n').pop())
    assert.equal(r.n, 10, '卡应该还是 10 条')

    const 档 = join(sb, '关系卡被挤掉.jsonl')
    assert.ok(existsSync(档), '没生成 关系卡被挤掉.jsonl —— 她又会「记的东西悄悄没了」')
    const 行 = readFileSync(档, 'utf8').trim().split('\n').filter(Boolean)
    assert.equal(行.length, 1, '应该正好挤出 1 条')
    const o = JSON.parse(行[0])
    assert.equal(o.text, '第1条事实', '挤出的应该是最老的（第 1 条）')
    assert.equal(o.key, 'private:x', '没记是哪张卡挤的')
    assert.ok(Number(o.记于) > 0, '没记「这条原来是什么时候记的」')
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('C2 「群里的聊天不外传」必须有个永久落点（关系卡会被挤掉，SOUL 不会）', () => {
  const s = readFileSync(SOUL, 'utf8')
  // 这条是整批里唯一「纯靠记忆、没有任何代码兜底」的规则。
  // 权限那条（只认主人）有 poll.js:3007 每轮注入身份提示，丢得起；隐私这条丢不起。
  assert.match(s, /不外传|不复述|不截图|不搬运/, 'SOUL.md 里没有「群里的聊天不能带出去」这条')
})

test('C3 关系卡不许和黑话库逐字重复（qq_remember 传 slang 时会双写）', () => {
  // 双写逻辑：remember(key,{fact}) 写关系卡；同一个 fact 又当 义 写进 圈子黑话.json。
  // 于是「sdy = sodayo = …」这条在两边一模一样（关系卡 58 字，每轮注入；词库也在）。
  // 词义属于词库，不该常驻关系卡 —— 那 58 字是白付的。
  let 卡表 = {}
  try { 卡表 = JSON.parse(readFileSync(卡, 'utf8')) } catch { /* 没有卡就跳过 */ }
  let 库 = []
  try { 库 = JSON.parse(readFileSync(黑话, 'utf8')) } catch { /* 没有词库就跳过 */ }
  if (!Array.isArray(库) || 库.length === 0) return

  const 释义 = new Map()
  for (const x of 库) {
    if (x && typeof x === 'object' && typeof x.义 === 'string' && x.义.trim() !== '') 释义.set(x.义.trim(), x.词)
  }
  const 撞 = []
  for (const [k, card] of Object.entries(卡表)) {
    if (!card || !Array.isArray(card.facts)) continue
    for (const f of card.facts) {
      const t = String(f?.text ?? '').trim()
      if (t !== '' && 释义.has(t)) 撞.push(k + ' ←→ 「' + 释义.get(t) + '」')
    }
  }
  assert.deepEqual(撞, [], '关系卡里有和黑话库逐字相同的条目（双写）：' + 撞.join('；') +
    ' —— 词义该留在词库，别常驻每轮注入')
})
