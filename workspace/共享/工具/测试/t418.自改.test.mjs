// t418 —— 她能改自己（批次414）
//
// 为什么要有：`自改.mjs` 2026-11-01 就写好了（127 行：FREE 白名单、性格漂移限频、
// 三条护栏、留痕），头部注释写着「她能改的，和一个人能改的一样多」——
// 然后**零调用方，12 天没动过**。`好感度-日结.mjs` 的注释甚至写着
// 「自改.mjs 白名单里有它，但自改.mjs 零调用方」，于是绕过它另写了一份。
// 这就是「只写了功能但没有系统接入」的同一个病。
//
// 这个文件锁四件事：
//   ① 自改本身能跑（写、去重、限频、护栏）
//   ② 口癖那条死路修好了（FREE 里写着 .md 但代码一律拼 .json，永远匹配不上）
//   ③ 写进去真的有人读（voiceSlots.slotQuirks 每轮注入）
//   ④ qq_self 注册在 index.js 里、VOICE_SLOTS 里真的有 slotQuirks
//
// 跑法：node --test t418.自改.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const CLI = join(TOOLS, '自改.mjs')
const 沙 = mkdtempSync(join(tmpdir(), 'self418-'))
const MEM = join(沙, '记忆')

function 准备() {
  rmSync(MEM, { recursive: true, force: true })
  mkdirSync(MEM, { recursive: true })
  writeFileSync(join(MEM, '偏好.json'), JSON.stringify({ 喜欢: ['听雨声'], 讨厌: [] }))
  writeFileSync(join(MEM, '想要.json'), JSON.stringify({ 当下想要: [{ what: '攒表情包', strength: 1 }] }))
  writeFileSync(join(MEM, '性格-16PF.json'), JSON.stringify({ Q3_自律性: 5, C_稳定性: 5 }))
  writeFileSync(join(MEM, '自改日志.json'), JSON.stringify({ items: [] }))
}
function 跑(args) {
  try {
    return { code: 0, out: String(execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8', timeout: 20000, cwd: TOOLS, env: { ...process.env, SELF_MEM: MEM },
    })).trim() }
  } catch (e) {
    return { code: e.status ?? -1, out: String(e.stdout ?? '') + String(e.stderr ?? '') }
  }
}
function 读(f) { try { return JSON.parse(readFileSync(join(MEM, f), 'utf8')) } catch { return null } }
function 日志() { const j = 读('自改日志.json'); return Array.isArray(j?.items) ? j.items : [] }

test('S1 --list 说清三类 + 口癖怎么写', () => {
  准备()
  const r = 跑(['--list'])
  assert.match(r.out, /随时能改/, '没列「随时能改」')
  assert.match(r.out, /慢慢能改/, '没列「慢慢能改」')
  assert.match(r.out, /碰不得/, '没列禁区')
  assert.match(r.out, /口癖/, '没说口癖怎么写')
})

test('S2 --set 偏好.喜欢 加一条，留痕', () => {
  准备()
  const r = 跑(['--set', '偏好.喜欢', '--value', '凌晨四点的安静', '--why', '自己发现的'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /加了|改了|新写了/, '没说改成了：' + r.out)
  const 偏 = 读('偏好.json')
  assert.ok(偏.喜欢.includes('凌晨四点的安静'), '没写进 偏好.json：' + JSON.stringify(偏.喜欢))
  assert.ok(偏.喜欢.includes('听雨声'), '把原有的冲掉了：' + JSON.stringify(偏.喜欢))
  const lg = 日志()
  assert.equal(lg.length, 1, '没留痕：' + JSON.stringify(lg))
  assert.match(JSON.stringify(lg[0]), /凌晨四点的安静/, '日志里没记这次改了什么')
})

test('S3 改完回话里带「第几次」—— 她当轮就知道自己改过', () => {
  准备()
  跑(['--set', '偏好.喜欢', '--value', 'A 一条'])
  const r = 跑(['--set', '偏好.喜欢', '--value', 'B 一条'])
  assert.match(r.out, /第\s*2\s*次/, '第二次改完没说「第 2 次」：' + r.out)
})

test('S4 口癖：写进 md（不是 json），重复的不重复加', () => {
  准备()
  const r1 = 跑(['--set', '口癖.随便', '--value', '句子别太长，一口气说完'])
  assert.equal(r1.code, 0, r1.out)
  const 档 = join(MEM, '口癖清单.md')
  assert.ok(existsSync(档), '没建 口癖清单.md')
  const md = readFileSync(档, 'utf8')
  assert.match(md, /句子别太长/, 'md 里没有这句话：' + md)
  // 关键：不能落到 .json 上（原来 file 一律拼 .json，这条路根本走不到）
  assert.ok(!existsSync(join(MEM, '口癖清单.json')), '写成了 json —— 说明还是走了老的拼路径')

  const r2 = 跑(['--set', '口癖.别的名', '--value', '句子别太长，一口气说完'])
  assert.match(r2.out, /已经在清单里/, '同一条加了两遍：' + r2.out)
  const md2 = readFileSync(档, 'utf8')
  assert.equal(md2.split('句子别太长').length - 1, 1, 'md 里出现了两次')
})

test('S5 口癖超长要截断（不然会撑爆每轮注入）', () => {
  准备()
  跑(['--set', '口癖.x', '--value', '啊'.repeat(200)])
  const md = readFileSync(join(MEM, '口癖清单.md'), 'utf8')
  const 行 = md.split('\n').find((l) => l.includes('啊')) || ''
  assert.ok(行.length <= 62, '没截断，长度 ' + 行.length)
})

test('S6 写完真的有人读：slotQuirks 读出同一句', async () => {
  准备()
  跑(['--set', '口癖.x', '--value', '该损人的时候别端着'])
  const { slotQuirks } = await import(join(LIB, 'voiceSlots.js'))
  const hint = slotQuirks({ memDir: MEM })
  assert.match(hint, /该损人的时候别端着/, 'she 写的口癖没被注入：' + hint)
  assert.match(hint, /说话习惯|你自己/, '注入里没说这是她自己写的：' + hint)
  assert.ok(!/口癖清单\.md/.test(hint), '把文件名念出来了，她会复述出去：' + hint)
})

test('S7 slotQuirks 只取最近 4 条、空文件返回空', async () => {
  const { slotQuirks } = await import(join(LIB, 'voiceSlots.js'))
  准备()
  for (const s of ['第一句习惯', '第二句习惯', '第三句习惯', '第四句习惯', '第五句习惯', '第六句习惯']) {
    跑(['--set', '口癖.x', '--value', s])
  }
  const hint = slotQuirks({ memDir: MEM })
  assert.ok(hint.includes('第六句习惯'), '最新的没读到：' + hint)
  assert.ok(!hint.includes('第一句习惯'), '太老的没被挤掉（注入会越来越长）：' + hint)

  writeFileSync(join(MEM, '口癖清单.md'), '# 空\n')
  assert.equal(slotQuirks({ memDir: MEM }), '', '空清单还注入东西')
  assert.equal(slotQuirks({ memDir: join(沙, '不存在') }), '', '没文件还注入东西')
})

test('S8 护栏：核心性格不给 why 就拒绝，灰名单碰不得', () => {
  准备()
  const r = 跑(['--drift', 'C_稳定性', '--value', '1'])
  assert.match(r.out, /为什么|理由|不写就是任性/, '核心因子没要理由就放行了：' + r.out)
  assert.equal(读('性格-16PF.json').C_稳定性, 5, '没写理由却改了性格')

  const r2 = 跑(['--set', 'qq-bridge.config.key', '--value', 'x'])
  assert.match(r2.out, /不在|不碰/, '凭据文件被改了：' + r2.out)

  const r3 = 跑(['--set', '偏好.喜欢.深层', '--value', 'x'])
  assert.match(r3.out, /不是对象|不许整体覆盖|没改成/, '乱指路径没被拦：' + r3.out)
})

test('S9 限频：同一个性格因子 30 天内只能动一次', () => {
  准备()
  const a = 跑(['--drift', 'Q3_自律性', '--value', '1'])
  assert.match(a.out, /漂了/, '第一次没漂成：' + a.out)
  const b = 跑(['--drift', 'Q3_自律性', '--value', '1'])
  assert.match(b.out, /得等|已经动过/, '同一个月动了两次：' + b.out)
})

test('S10 结构：qq_self 真的注册了、VOICE_SLOTS 里真的有 slotQuirks', () => {
  const tool = readFileSync(join(LIB, 'tool.js'), 'utf8')
  const idx = readFileSync(join(LIB, 'index.js'), 'utf8')
  const slot = readFileSync(join(LIB, 'voiceSlots.js'), 'utf8')

  assert.match(tool, /name: 'qq_self'/, 'tool.js 里没有 qq_self')
  assert.match(tool, /export async function registerSelfTool/, '没有 registerSelfTool')
  // 批次407 的教训：注释掉 `void registerSelfTool(ctx)` 也算命中，要锚行首
  assert.match(idx, /^\s*void registerSelfTool\(ctx\)/m, 'index.js 没调用 registerSelfTool')
  assert.ok(!/\/\/\s*void registerSelfTool/.test(idx), 'index.js 里那行被注释掉了')

  // 只定义函数不算接上 —— 必须在 VOICE_SLOTS 数组里
  const 数组 = slot.slice(slot.indexOf('export const VOICE_SLOTS'), slot.indexOf('export function extraSlotsHint'))
  assert.match(数组, /^\s*slotQuirks,\s*$/m, 'slotQuirks 定义了但没进 VOICE_SLOTS 数组 —— 等于没接')

  // 描述里不能写「只在用户明确要求时」那种把使用掐死的句子（批次410 的教训）
  const 描述 = tool.slice(tool.indexOf("name: 'qq_self'"), tool.indexOf("parameters:", tool.indexOf("name: 'qq_self'")))
  assert.ok(!/仅在用户明确|只在用户明确要求时/.test(描述), '描述里又有把使用掐死的限制：' + 描述.slice(0, 200))
})

test('S11 沙盒：单测不碰真实的 偏好/自改日志', () => {
  const 真偏 = '{{BOT_ROOT}}/记忆/偏好.json'
  const 真日 = '{{BOT_ROOT}}/记忆/自改日志.json'
  const m1 = existsSync(真偏) ? readFileSync(真偏, 'utf8') : ''
  const m2 = existsSync(真日) ? readFileSync(真日, 'utf8') : ''
  准备()
  跑(['--set', '偏好.喜欢', '--value', '沙盒专用一条'])
  const n1 = existsSync(真偏) ? readFileSync(真偏, 'utf8') : ''
  const n2 = existsSync(真日) ? readFileSync(真日, 'utf8') : ''
  assert.equal(n1, m1, '真实 偏好.json 被测试改了')
  assert.equal(n2, m2, '真实 自改日志.json 被测试改了')
})
