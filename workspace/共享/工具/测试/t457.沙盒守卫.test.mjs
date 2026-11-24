// t457.沙盒守卫.test.mjs —— 批次456/457（2026-11-14）
//
// 病根：冒烟1b 把每个 .mjs 当 CLI 真跑一遍，靠一份**写死的 env 名单**把模块指到沙盒。
// 名单漏一个模块，它就写线上真档。实测跑一次写 16 个（疾病/体温/卫生/念头/提醒水位/
// 活动台账/缺口台账/激素/状态/自主/他的作息…），而它自己的「真档指纹」只盯 16 个固定文件名，
// 写脏了照样打印「真实文件未被触碰」。
//
// 这道闸不猜 env：在子进程里把 fs 的写入口全包一层，落在 {{BOT_ROOT}} 的写一律改道到沙盒。
// 这个文件钉：① 两个冒烟都接上了；② 真能改道；③ 只删 .tmp- 临时文件（绝不删真数据）；
// ④ 没设沙盒时是空操作（守卫绝不能在生产进程里生效）。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const T = '{{BOT_ROOT}}/共享/工具/测试'
const 守卫 = path.join(T, '沙盒守卫.mjs')
const 真 = '{{BOT_ROOT}}/记忆'
const 源 = fs.readFileSync(守卫, 'utf8')

const 跑子进程 = (码, 沙, 日志, 额外 = {}) => execFileSync(process.execPath, ['-e', 码], {
  encoding: 'utf8', timeout: 20000,
  env: {
    ...process.env,
    NODE_OPTIONS: '--import ' + pathToFileURL(守卫).href,
    SMOKE_GUARD_SANDBOX: 沙, SMOKE_GUARD_LOG: 日志, SMOKE_GUARD_TAG: 't457',
    ...额外,
  },
})

test('A1 两个冒烟都接上了守卫', () => {
  for (const f of ['冒烟1.加载.test.mjs', '冒烟1b.加载.test.mjs']) {
    const s = fs.readFileSync(path.join(T, f), 'utf8')
    assert.ok(s.includes('沙盒守卫.mjs'), f + ' 没引用沙盒守卫')
    // 钉「真赋值」而不是「名字出现过」：第一版只查 /SMOKE_GUARD_SANDBOX/，
    // 把它改成空串（等于关掉）照样绿 —— 反测当场抓到。
    // 不能用 \b 收尾：JS 的 \b 只认 ASCII 词字符，「沙\b」永远不成立（这条断言第一次就是这么假红的）。
    assert.ok(/SMOKE_GUARD_SANDBOX\s*=\s*沙[ \t]*$/m.test(s), f + ' 的 SMOKE_GUARD_SANDBOX 没真指向沙盒目录')
    assert.ok(/SMOKE_GUARD_LOG\s*=\s*沙\s*\+/.test(s), f + ' 的 SMOKE_GUARD_LOG 没落到沙盒里')
  }
  const b = fs.readFileSync(path.join(T, '冒烟1b.加载.test.mjs'), 'utf8')
  assert.ok(/--import/.test(b), '冒烟1b 没给子进程挂 --import —— 守卫根本进不去子进程')
})

test('A2 子进程里 writeFileSync 写真档路径会被改道到沙盒', () => {
  const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard457-'))
  const 目标 = path.join(真, '__守卫测试__.json')
  try {
    fs.rmSync(目标, { force: true })
    跑子进程(`import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(目标)}, '{"a":1}'))`,
      沙, path.join(沙, '改道.log'))
    assert.equal(fs.existsSync(目标), false, '真档被写出来了：' + 目标)
    const 改后 = path.join(沙, '改道', '记忆', '__守卫测试__.json')
    assert.ok(fs.existsSync(改后), '沙盒里没有改道后的文件：' + 改后)
    const 日志 = fs.readFileSync(path.join(沙, '改道.log'), 'utf8')
    assert.ok(日志.includes('__守卫测试__.json'), '改道日志里没记这次')
  } finally { fs.rmSync(目标, { force: true }); fs.rmSync(沙, { recursive: true, force: true }) }
})

test('A3 appendFileSync / promises.writeFile 也挡得住', () => {
  const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard457-'))
  const 目标 = path.join(真, '__守卫测试2__.log')
  try {
    fs.rmSync(目标, { force: true })
    跑子进程(`import('node:fs').then(async fs => { fs.appendFileSync(${JSON.stringify(目标)}, 'x'); await fs.promises.writeFile(${JSON.stringify(目标)}, 'y') })`,
      沙, path.join(沙, '改道.log'))
    assert.equal(fs.existsSync(目标), false, 'appendFileSync/promises 漏了，真档被写：' + 目标)
  } finally { fs.rmSync(目标, { force: true }); fs.rmSync(沙, { recursive: true, force: true }) }
})

test('A4 只在临时文件上 unlink，绝不删真数据', () => {
  // 跨设备 rename 的兜底里有一句 unlinkSync，必须被 .tmp- 条件包住。
  // 这个断言就是防止以后有人为了「跑通」把条件删掉 —— 那会删掉她的真档。
  assert.ok(/\.tmp-/.test(源), '守卫里没有 .tmp- 判据 —— 跨设备兜底可能删真数据')
  // 只查真正的调用；`包('unlinkSync', 0)` 是「把这个 API 也包一层」的登记行，不是删除动作。
  const 行 = 源.split('\n')
    .filter((l) => /unlinkSync\s*\(/.test(l))
    .filter((l) => !/^\s*\/\//.test(l))
    .filter((l) => !/包\('unlinkSync'/.test(l))
    .filter((l) => !/包P\('unlink'/.test(l))
  for (const l of 行) {
    assert.ok(/\.tmp-/.test(l), '有一句 unlinkSync 没被 .tmp- 条件包住：' + l.trim())
  }
})

test('A5 没设 SMOKE_GUARD_SANDBOX 时是空操作（守卫不能在生产进程里生效）', () => {
  assert.ok(/if \(沙\) \{/.test(源), '守卫少了 `if (沙)` 总闸 —— 没配对也会挂上，等于把线上写入改道')
  const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'guard457-'))
  const 临时 = path.join(沙, '正常写入.txt')
  try {
    // 不设沙盒：写沙盒路径当然成功；关键是同一条命令不能因为守卫而报错
    execFileSync(process.execPath, ['-e', `import('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(临时)}, 'ok'))`], {
      encoding: 'utf8', timeout: 20000,
      env: { ...process.env, NODE_OPTIONS: '--import ' + pathToFileURL(守卫).href, SMOKE_GUARD_SANDBOX: '' },
    })
    assert.equal(fs.readFileSync(临时, 'utf8'), 'ok')
  } finally { fs.rmSync(沙, { recursive: true, force: true }) }
})
