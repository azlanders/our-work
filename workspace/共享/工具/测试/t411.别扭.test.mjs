// t411 —— 别扭：谁在写它、道歉/破冰到底降多少（批次406）
//
// 病根两条，都是「只写了功能，没有系统接入」：
//   1) 别扭.mjs 只有手动 CLI 能写。线上一次都没被调过，别扭.json 一直是
//      {"people":{}}；而 deliver / outbound / split / poll / 面板 一共 12 处在读它，
//      全都在等一份永远不会出现的档（面板那条 >=60 才画的「别扭着脸」也从没画出来）。
//      → 现在 qq_feel 记了负向感受就落账（--from-feel）。判断权还是她的。
//   2) --sorry / --comfort 写的是 `level - 1`。level 早在 2026-11-01 就改成百分制
//      （1~100），-1 是三档制（1~3）留下的：记 60 分要道 60 次歉才消，
//      而面板 >=60 才画别扭脸 —— 等于道了歉脸色一点不变。
//      → 改成「至少降 10 点，或降到原来的 67%」（把「降一档」的原意折过来）。
//
// 这个文件锁：
//   M1 --from-feel 的强度表（被骂 60 / 越界 55 / 被冷落 45 / 被打断 25）
//   M2 不在表里的感受不记别扭（被夸 / 陪伴 / 搞砸 都不该让她生气）
//   M3 已经在别扭就不降级：二次受伤不该比第一次轻
//   M4 --sorry / --comfort 按比例降（三档制的 -1 必须彻底没了）
//   M5 --clear 整条撤掉；--level 老写法和旧三档写法都还认
//   M6 单独跑一次不改真实 记忆/别扭.json（SULK_MEM 沙盒）
//   M7 线上真的接上了：tool.js 的 qq_feel 里调得到 别扭.mjs
//
// 跑法：node --test t411.别扭.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const CLI = join(TOOLS, '别扭.mjs')
const 读 = (p) => readFileSync(p, 'utf8')
const 沙 = mkdtempSync(join(tmpdir(), 'sulk411-'))
const 档 = join(沙, '别扭.json')
const 谁 = '{{OWNER_UIN}}'

function 跑(args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, SULK_MEM: 沙 },
    timeout: 15000,
  }).trim()
}
function 读账() {
  try { return JSON.parse(读(档)) } catch { return { people: {} } }
}
function 清账() { try { rmSync(档) } catch { /* 还没有 */ } }

test('M1 --from-feel 的强度表', () => {
  const 表 = { 被骂: 60, 越界: 55, 被冷落: 45, 被打断: 25 }
  for (const [kind, lv] of Object.entries(表)) {
    清账()
    const out = 跑(['--from-feel', kind, '--who', 谁, '--why', '原话'])
    const r = 读账().people[谁]
    assert.equal(r?.level, lv, `${kind} 应该记 ${lv}，实际 ${JSON.stringify(r)}`)
    assert.ok(Number(r.until) > Date.now(), `${kind} 的 until 必须在将来`)
    assert.equal(r.why, '原话', `${kind} 的原话没留住`)
    assert.ok(out.includes('闹别扭'), `${kind} 的输出看不懂：${out}`)
  }
})

test('M2 不在表里的感受不记别扭', () => {
  for (const kind of ['被夸', '陪伴', '搞砸', '被想起', '被注意到', '修复']) {
    清账()
    const out = 跑(['--from-feel', kind, '--who', 谁])
    assert.equal(读账().people[谁], undefined, `${kind} 不该记成别扭`)
    assert.ok(out.includes('不用记别扭'), `${kind} 应该明说不用记，实际：${out}`)
  }
})

test('M3 已经在别扭就不降级', () => {
  清账()
  跑(['--level', '70', '--who', 谁, '--why', '第一下'])
  const until0 = Number(读账().people[谁].until)
  跑(['--from-feel', '被打断', '--who', 谁])   // 25 分 < 70
  assert.equal(读账().people[谁].level, 70, '二次受伤不该把气降下来')
  跑(['--from-feel', '被骂', '--who', 谁])     // 60 分 < 70
  assert.equal(读账().people[谁].level, 70, '被骂也不该低于已有的 70')
  跑(['--clear', '--who', 谁])
  清账()
  跑(['--level', '20', '--who', 谁])
  跑(['--from-feel', '被骂', '--who', 谁])     // 60 分 > 20
  assert.equal(读账().people[谁].level, 60, '原来只有 20，被骂之后该涨到 60')
})

test('M4 --sorry / --comfort 按比例降，不再是一点', () => {
  const 情形 = [
    [60, 40], [100, 67], [15, 5], [10, 0],
  ]
  for (const [before, after] of 情形) {
    清账()
    跑(['--level', String(before), '--who', 谁, '--why', 'x'])
    const until0 = Number(读账().people[谁].until)
    跑(['--sorry', '--who', 谁])
    const r = 读账().people[谁]
    if (after === 0) assert.equal(r, undefined, `${before} 道歉后应该整条消掉`)
    else {
      assert.equal(r.level, after, `${before} 道歉后应该是 ${after}`)
      assert.ok(Number(r.until) < until0, '道歉后时长该缩短')
    }
  }
  清账()
  跑(['--level', '60', '--who', 谁])
  跑(['--comfort', '--who', 谁])
  assert.equal(读账().people[谁].level, 40, '破冰后应该降到 40')

  const 源 = 读(CLI)
  // 三档制留下的 -1 必须一处不剩（两处都改过了）。注释里提到「-1」不算。
  const 代码 = 源.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n')
  assert.ok(!/Number\(rec\.level\) - 1\)/.test(代码), '还有 `Number(rec.level) - 1` —— 三档制的老写法没清干净')
})

test('M5 --clear 撤干净；--level 老写法与旧三档写法都认', () => {
  清账()
  跑(['--level', '60', '--who', 谁, '--why', 'x'])
  assert.equal(读账().people[谁].level, 60)
  跑(['--clear', '--who', 谁])
  assert.deepEqual(读账().people, {}, '--clear 之后 people 应该空')

  跑(['--level', '2', '--who', 谁])
  assert.equal(读账().people[谁].level, 66, '旧三档写法 2 应该折成 66')
})

test('M6 单测不碰真实的 记忆/别扭.json', () => {
  // 这条是防线：SULK_MEM 没生效的话，上面每个用例都会改写她真实的气账。
  const 真 = '{{BOT_ROOT}}/记忆/别扭.json'
  const 前 = (() => { try { return 读(真) } catch { return null } })()
  清账()
  跑(['--from-feel', '被骂', '--who', '99999'])
  const 后 = (() => { try { return 读(真) } catch { return null } })()
  assert.equal(后, 前, '真实 别扭.json 被测试改写了 —— SULK_MEM 没生效')
})

test('M7 线上真的接上了：qq_feel 里调得到 别扭.mjs', () => {
  const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib/tool.js'
  const 源 = 读(插件)
  // 路径不钉死：二号机（{{BOT_DISPLAY}}）的工作区是 {{BOT_ROOT}}，同一个文件名而已。
  assert.ok(/SULK = ['\"`][^'\"`]*别扭\.mjs['\"`]/.test(源), 'tool.js 里没有别扭脚本的常量')
  assert.ok(/\[SULK, '--from-feel', k, '--who', autoWho/.test(源), 'qq_feel 没把负向感受转给 别扭.mjs')
  assert.ok(/\{ 被骂: 1, 越界: 1, 被冷落: 1, 被打断: 1 \}/.test(源), '负向 kind 白名单不见了')
  assert.ok(/\[SULK, '--comfort', '--who', autoWho\]/.test(源), '「修复」没接到 --comfort')
  assert.ok(/\[SULK, '--clear', '--who', autoWho\]/.test(源), '「想岔了」没接到 --clear')
  // 强度表不能在 tool.js 里也有一份 —— 两套就会走岔
  assert.ok(!/被骂: 60/.test(源), 'tool.js 里又写了一份强度表，应该只在 别扭.mjs 一处')

  // 新能力必须进提示（照纪律）：她得预先知道记完会发生什么，否则下次
  // 莫名其妙「说得更短」「脸色垮下来」她只会以为自己坏了。
  assert.ok(/(会真的开始闹别扭|记录会影响身体与关系)/.test(源), 'qq_feel 的描述里没告诉她记录会影响状态与关系')
  assert.ok(/(记「修复」，气降一档|修复=事情过去了)/.test(源), 'qq_feel 的描述里没说修复')
  assert.ok(/(记「想岔了」，整条撤掉|kind=想岔了)/.test(源), 'qq_feel 的描述里没说想岔了怎么撤销')
})
