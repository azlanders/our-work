/**
 * 批次 643：关系档位只有一个判据。
 *
 * 起因（线上实测，2026-11-17 11:20）：对同一个主人，三段注入同时进上下文：
 *   印象.json  「档位：熟稔」        （score = 熟悉×0.6 + 好感×0.4 + 轮数×0.3）
 *   内心.md    「亲近 在意」        （好感>65 但没到 75）
 *   voiceSlots 「[关系] 跟他熟」    （bond 0.82）
 * 三套阈值各判一套，她读到的是自相矛盾的自我认知。
 *
 * 现在的口径：bond 有值就以它为准（关系.json 的 bond 涨得慢、掉得快，量的是关系走到哪一步）；
 * bond 缺失/为 0 才退回「好感 + 熟悉」（好感度 v2 的合成分会随当天兴致波动）。
 * 三处调用同一个函数，阈值只在这里。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// T8/T9 会 import 插件 lib 的 voiceSlots.js，它一加载就 note() 写生产日志。
// t453 A1 会扫这个（实测红过）。和 t649 一样，测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const 本目录 = path.dirname(fileURLToPath(import.meta.url))
const 工具目录 = path.join(本目录, '..')

const { 关系档 } = await import(pathToFileURL(path.join(工具目录, '关系档.mjs')).href)

test('T1 bond 是主信号：同一组好感/熟悉，bond 不同就不同档', () => {
  assert.equal(关系档({ 好感: 69, 熟悉: 60, bond: 0.82 }).档, '熟')
  assert.equal(关系档({ 好感: 69, 熟悉: 60, bond: 0.5 }).档, '在意')
  assert.equal(关系档({ 好感: 69, 熟悉: 60, bond: 0.2 }).档, '一般')
  assert.equal(关系档({ 好感: 69, 熟悉: 60, bond: 0.1 }).档, '还不熟')
})

test('T2 bond 边界：0.70/0.40/0.15 都含在上一档', () => {
  assert.equal(关系档({ bond: 0.7 }).档, '熟')
  assert.equal(关系档({ bond: 0.699 }).档, '在意')
  assert.equal(关系档({ bond: 0.4 }).档, '在意')
  assert.equal(关系档({ bond: 0.399 }).档, '一般')
  assert.equal(关系档({ bond: 0.15 }).档, '一般')
  assert.equal(关系档({ bond: 0.149 }).档, '还不熟')
})

test('T3 bond 缺失或为 0 才退回好感+熟悉（不让心情差的一天把关系判生）', () => {
  assert.equal(关系档({ 好感: 69, 熟悉: 60 }).档, '在意')
  assert.equal(关系档({ 好感: 69, 熟悉: 60, bond: 0 }).档, '在意')
  assert.equal(关系档({ 好感: 80, 熟悉: 70 }).档, '熟')
  assert.equal(关系档({ 好感: 40, 熟悉: 10 }).档, '还不熟')
})

test('T4 什么数据都没有时不崩，给中性档', () => {
  const r = 关系档({})
  assert.equal(r.档, '一般')
  assert.equal(r.有据, false, '没数据要说没数据，让调用方沉默')
  assert.equal(typeof r.依据, 'string')
})

test('T4b 有数据时 有据=true（沉默只用于「不知道」）', () => {
  assert.equal(关系档({ bond: 0.5 }).有据, true)
  assert.equal(关系档({ 好感: 69, 熟悉: 60 }).有据, true)
})

test('T5 依据里带的是真实数字（排障要看得到为什么）', () => {
  assert.match(关系档({ bond: 0.82 }).依据, /bond 0\.82/)
  assert.match(关系档({ 好感: 69, 熟悉: 60 }).依据, /好感 69/)
})

test('T6 档位倾向表已删，只报档位与依据（拟人化红线 P1-7）', () => {
  const 源 = readFileSync(path.join(工具目录, '关系档.mjs'), 'utf8')
  assert.ok(!/export const 档位倾向/.test(源), '档位倾向表还在')
  const voice = readFileSync(
    path.join(process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib', 'voiceSlots.js'),
    'utf8',
  )
  assert.ok(!/档位倾向/.test(voice), 'voiceSlots 还在用档位倾向')
  assert.match(voice, /return '\[关系\] ' \+ 判\.档 \+ '（' \+ 判\.依据 \+ '）'/)
})

test('T7 三处调用方都改成问 关系档（不再是各自一套阈值）', () => {
  const 内心 = path.join(工具目录, '内心.mjs')
  const 印象 = path.join(工具目录, '印象更新.mjs')
  assert.ok(existsSync(内心) && existsSync(印象))
  const 内 = readFileSync(内心, 'utf8')
  const 印 = readFileSync(印象, 'utf8')
  assert.match(内, /关系档\(\{/, '内心.mjs 没走统一判据')
  assert.match(印, /关系档\(\{/, '印象更新.mjs 没走统一判据')
  assert.ok(!/好感 > 75 && 熟悉 > 65/.test(内), '内心.mjs 还留着自己那套阈值')
  assert.ok(!/score < 40 \? '刚认识'/.test(印), '印象更新.mjs 还留着自己那套阈值')
})

// REL_FALLBACK 2026-11-17（批次657，审计 P1-4）：
// voiceSlots 在 关系.json 没有这个人时直接 return ''，把「没有 bond 才退回好感/熟悉」
// 这条兜底挡死了 —— 只有好感度记录的人永远拿不到 [关系] 槽。
test('T8 voiceSlots：没有 关系.json 条目时仍走好感/熟悉兜底', async () => {
  const LIB = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const vs = await import(pathToFileURL(path.join(LIB, 'voiceSlots.js')).href + '?t643=1')
  const sb = mkdtempSync(path.join(tmpdir(), 't643-'))
  try {
    mkdirSync(sb, { recursive: true })
    // 只有好感度、没有 关系.json
    writeFileSync(path.join(sb, '好感度.json'), JSON.stringify({
      people: { '3439411062': { score: 80, 熟悉度: 70, turns: 30 } },
    }))
    const s = vs.slotRelationBond({ peer: '3439411062', isPrivate: true, memDir: sb, now: Date.now() })
    assert.match(s, /^\[关系\] 熟/, '没有 关系.json 条目就沉默 —— 好感/熟悉兜底被绕过了：' + JSON.stringify(s))
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

test('T9 voiceSlots：真没数据时仍然沉默，不给陌生人贴档', async () => {
  const LIB = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const vs = await import(pathToFileURL(path.join(LIB, 'voiceSlots.js')).href + '?t643=2')
  const sb = mkdtempSync(path.join(tmpdir(), 't643b-'))
  try {
    const s = vs.slotRelationBond({ peer: '999999', isPrivate: true, memDir: sb, now: Date.now() })
    assert.equal(s, '', '什么数据都没有还出声：' + JSON.stringify(s))
  } finally { rmSync(sb, { recursive: true, force: true }) }
})

// TIER_ONE_TRUTH 2026-11-17（批次659，审计 P1-3）：
// poll.js 里还有两处按 score/fam 自己判档 —— 和 voiceSlots 的 [关系] 槽可以给出两个说法。
// 现在两处都改问 关系档.mjs。这条锁死「不许再自己写阈值」。
test('T10 poll.js 的两处关系档也走 关系档.mjs，不再自写阈值', () => {
  const LIB = process.env.QQ_LIB_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const s = readFileSync(path.join(LIB, 'poll.js'), 'utf8')
  assert.match(s, /await import\(`\$\{QQ_WS\}\/共享\/工具\/关系档\.mjs`\)/, 'poll.js 没引入统一判据')
  const 调用 = (s.match(/关系档\(\{/g) || []).length
  assert.ok(调用 >= 2, 'poll.js 里至少两处该改问 关系档（实际 ' + 调用 + ' 处）')
  assert.ok(!/score >= 70 && fam >= 60/.test(s), '第一处还留着自己那套阈值')
  assert.ok(!/heat >= 0\.78 \? '自己人'/.test(s), '第二处还留着自己那套阈值')
})
