import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 批次452（下）：测试把**生产插件日志**当成了自己的输出口。
//
// 证据：`{{DSH_ROOT}}/qq-bridge-load.log` 13956 行里 6153 行是「xxx registered」（44%）；
// 今天 3766 行里 2848 行是它（76%）。因为 49 个测试文件 import 插件 lib，而 register 时
// `note()` 直接写真档 —— 全套跑一遍能塞几千行，真信号（比如 `[照片到货] 已投递`）直接被冲没。
//
// `QUIET_NOTE` 这个开关早就实现了（env.js），但只有 2 个文件设过。
// 这一条锁三件事：① 凡 import 插件的测试都闭嘴；② 那个开关本身不许被删；
// ③ 开关真的管用（同样 register 一次，静音时一个字节都不写）。

const LIB = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
const 测试目录 = '{{BOT_ROOT}}/共享/工具/测试'

test('A1 凡 import 插件 lib 的测试，都必须先关掉 note', () => {
  const 违规 = []
  for (const f of readdirSync(测试目录)) {
    if (!f.endsWith('.mjs')) continue
    if (f === 't453.测试别写生产日志.test.mjs') continue   // 它自己只在子进程 env 里设，不需要顶层那行
    const s = readFileSync(join(测试目录, f), 'utf8')
    if (!s.includes('dsh-onebot-channel')) continue
    // 必须抓到真正的赋值 —— 第一版只查 includes('QUIET_NOTE')，
    // 而插进去的注释里也有这个词，把赋值删掉照样绿（反测当场抓到）。
    if (!/process\.env\.QUIET_NOTE\s*=\s*'1'/.test(s)) 违规.push(f)
  }
  assert.deepEqual(违规, [], '这些测试会把 registered 写进生产日志：' + 违规.join('、'))
})

test('A2 env.js 里的 QUIET_NOTE 开关不许被删', () => {
  const s = readFileSync(join(LIB, 'env.js'), 'utf8')
  assert.match(s, /process\.env\.QUIET_NOTE === '1'/, 'note() 的静音开关没了')
})

test('A3 开关真的管用：同样 register 一次，静音时一个字节都不写', () => {
  const 跑 = (quiet) => {
    const sb = mkdtempSync(join(tmpdir(), 't453-'))
    const 代码 = `
      const defs = []
      const tools = { register(d) { defs.push(d); return () => {} } }
      const ctx = { tools, get: (k) => (k === 'tools' ? tools : undefined), effect() {}, log() {}, getConfig: () => ({}) }
      await (await import(${JSON.stringify(LIB + '/sleep.js')})).registerSleepTool(ctx)
      console.log('注册了 ' + defs.length)
    `
    const env = { ...process.env, DSH_DATA: sb }
    if (quiet) env.QUIET_NOTE = '1'
    else delete env.QUIET_NOTE
    execFileSync(process.execPath, ['--input-type=module', '-e', 代码], { encoding: 'utf8', env, timeout: 30000 })
    const 日志 = join(sb, 'qq-bridge-load.log')
    const n = existsSync(日志) ? readFileSync(日志, 'utf8').split('\n').filter(Boolean).length : 0
    rmSync(sb, { recursive: true, force: true })
    return n
  }
  const 静音 = 跑(true)
  const 不静音 = 跑(false)
  assert.equal(静音, 0, '设了 QUIET_NOTE 还是写了 ' + 静音 + ' 行')
  assert.ok(不静音 > 0, '不设 QUIET_NOTE 也没写 —— 那 A1 就白锁了（开关可能是假的）')
})
