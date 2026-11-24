// t459.入口保护全量.test.mjs —— 批次459（2026-11-14）
//
// 458 只给 `契约检查`/`自检` 加了入口保护（名单的头两名）。这一批把 457 那份名单里
// 剩下的 17 个也加了：激素/会话体检/全套验收/别扭/天气/手账/目录卫生/耐心/自动学习/
// 自拍/写日记/刷群/工具用量/生活体检/生长复盘/碎片/算作息。
//
// 这些脚本顶层就是整条流程，被冒烟「逐个 import」时真跑一遍（一次写 16 个真档）。
// 加了 `if (是入口) { … }` 之后：`node <文件>` 照旧跑，被 import 时是空模块。
//
// 这个文件钉三件事：① 19 个文件都还在保护里；② 批量 import 真的不跑（快 + 零输出）；
// ③ 「入口判据」本身对绝对路径和相对路径都成立（别哪天改成 argv[2]，CLI 就悄悄不跑了）。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 受保护 = ['契约检查.mjs', '自检.mjs', '激素.mjs', '会话体检.mjs', '全套验收.mjs', '别扭.mjs',
  '天气.mjs', '手账.mjs', '目录卫生.mjs', '耐心.mjs', '自动学习.mjs', '自拍.mjs', '写日记.mjs',
  '刷群.mjs', '工具用量.mjs', '生活体检.mjs', '生长复盘.mjs', '碎片.mjs', '算作息.mjs']

test('A1 19 个脚本都有入口保护', () => {
  const 缺 = []
  for (const f of 受保护) {
    const s = fs.readFileSync(path.join(TOOLS, f), 'utf8')
    // 判据必须逐字是这一句 —— 只查 argv[1] 出现过的话，把它改成 argv[2] 也照样绿（CLI 就悄悄不跑了）
    // 458 的两个文件用的是不带 __ 的 path/fileURLToPath（它们本来就 import 了 path）；
    // 459 的 17 个用 __path/__fileURLToPath 别名，避免和各文件已有绑定撞名。两种都算对。
    // 三种写法都算对：path.resolve / __path.resolve / 直接 resolve（自检 是从 node:path 具名导入的）
    const 判据对 = /(?:(?:__)?path\.)?resolve\(process\.argv\[1\]\) === (?:__)?fileURLToPath\(import\.meta\.url\)/.test(s)
    if (!/if \(是入口\) \{/.test(s) || !判据对 || !/\}\s*$/.test(s)) 缺.push(f)
  }
  assert.deepEqual(缺, [], '这些脚本没有入口保护（import 时会跑主流程）：' + 缺.join(', '))
})

test('A2 一次 import 全部 19 个：快、零输出', () => {
  const 码 = `const urls = ${JSON.stringify(受保护.map((f) => pathToFileURL(path.join(TOOLS, f)).href))};
    (async () => { for (const u of urls) await import(u); console.log('__OK__') })()
      .catch(e => { console.log('__ERR__' + e.message) })`
  const t0 = Date.now()
  const 出 = execFileSync('/usr/local/bin/node', ['-e', 码], { encoding: 'utf8', timeout: 60000 })
  const 耗时 = Date.now() - t0
  assert.ok(出.includes('__OK__'), 'import 没走完：' + 出.slice(-300))
  assert.equal(出.replace('__OK__', '').trim(), '', 'import 时有输出 —— 有脚本还在跑主流程：' + 出.slice(0, 300))
  assert.ok(耗时 < 8000, '19 个 import 用了 ' + 耗时 + 'ms —— 有脚本在跑主流程')
})

test('A3 会话体检 的导出没被包进 if 里（孤儿统计 还能被 import 到）', () => {
  const 出 = execFileSync('/usr/local/bin/node', ['-e',
    `import(${JSON.stringify(pathToFileURL(TOOLS + '/会话体检.mjs').href)}).then(m => console.log(typeof m.孤儿统计))`],
    { encoding: 'utf8', timeout: 30000 })
  assert.equal(出.trim(), 'function', '孤儿统计 不是函数了 —— 导出被包进 if 块里了')
})

test('A4 入口判据本身：绝对路径和相对路径都算「是入口」', () => {
  const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'entry459-'))
  try {
    // 和 19 个文件里逐字相同的那段判据
    const 探针 = path.join(沙, 'probe.mjs')
    fs.writeFileSync(探针, `import __path from 'node:path'
import { fileURLToPath as __fileURLToPath } from 'node:url'
const 是入口 = (() => {
  try { return !!process.argv[1] && __path.resolve(process.argv[1]) === __fileURLToPath(import.meta.url) } catch { return false }
})()
if (是入口) { console.log('MAIN') }
`)
    // 绝对路径
    const 绝 = execFileSync('/usr/local/bin/node', [探针], { encoding: 'utf8', timeout: 20000 })
    assert.equal(绝.trim(), 'MAIN', '绝对路径下没进主流程')
    // 相对路径（cwd = 沙盒）
    const 相 = execFileSync('/usr/local/bin/node', ['probe.mjs'], { encoding: 'utf8', timeout: 20000, cwd: 沙 })
    assert.equal(相.trim(), 'MAIN', '相对路径下没进主流程 —— 用 node 文件名 跑就不工作了')
    // import 时不进
    const 导 = execFileSync('/usr/local/bin/node', ['-e',
      `import(${JSON.stringify(pathToFileURL(探针).href)}).then(()=>console.log('__OK__'))`],
      { encoding: 'utf8', timeout: 20000 })
    assert.equal(导.trim(), '__OK__', 'import 时进主流程了')
  } finally { fs.rmSync(沙, { recursive: true, force: true }) }
})
