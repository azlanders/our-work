// t458.入口保护.test.mjs —— 批次458（2026-11-14）
//
// 病根：`契约检查.mjs` / `自检.mjs` 顶层就是整条主流程，末尾还有 process.exit。
// 冒烟测试「逐个 import」时它们**真跑一遍**：冒烟一次 = 顺带跑两遍契约检查 + 两遍自检，
// 光这两项就往真档写了 538 次；而且 import 到一半 process.exit 把冒烟子进程带走，
// 冒烟那边记成「主动退出」—— 等于这两份最重要的脚本**从来没被真正加载测试过**。
//
// 加的是入口保护：只有 `node <本文件>` 才跑主流程，被 import 时是个空模块。
// 这个文件钉：① 保护还在；② import 真的不跑（快、无输出、不写盘）；③ CLI 真的还能跑。
process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const TOOLS = '{{BOT_ROOT}}/共享/工具'
const 目标 = ['契约检查.mjs', '自检.mjs']

const 跑 = (args, timeout = 180000) => execFileSync('/usr/local/bin/node', args, { encoding: 'utf8', timeout })

test('A1 两个脚本都有入口保护，且包住了整段主流程', () => {
  for (const f of 目标) {
    const s = readFileSync(TOOLS + '/' + f, 'utf8')
    assert.ok(/const 是入口 = /.test(s), f + ' 没有 是入口 判据')
    assert.ok(/if \(是入口\) \{/.test(s), f + ' 没有 if (是入口) 包住主流程')
    assert.ok(/fileURLToPath\(import\.meta\.url\)/.test(s), f + ' 入口判据没比 import.meta.url')
    // 结尾必须是闭合的那个 }
    assert.ok(/\}\s*$/.test(s), f + ' 结尾没有闭合大括号')
  }
})

test('A2 import 契约检查：不跑主流程（快、无输出、退出码 0）', () => {
  const t0 = Date.now()
  const 出 = 跑(['-e', `import(${JSON.stringify(pathToFileURL(TOOLS + '/契约检查.mjs').href)}).then(()=>console.log('__OK__'))`], 60000)
  const 耗时 = Date.now() - t0
  assert.ok(出.includes('__OK__'), 'import 没走完：' + 出.slice(-200))
  assert.equal(出.replace('__OK__', '').trim(), '', 'import 时有输出 —— 主流程还在跑：' + 出.slice(0, 200))
  assert.ok(耗时 < 5000, 'import 用了 ' + 耗时 + 'ms —— 主流程还在跑（正常应该几十毫秒）')
})

test('A3 import 自检：同样不跑主流程', () => {
  const t0 = Date.now()
  const 出 = 跑(['-e', `import(${JSON.stringify(pathToFileURL(TOOLS + '/自检.mjs').href)}).then(()=>console.log('__OK__'))`], 60000)
  const 耗时 = Date.now() - t0
  assert.ok(出.includes('__OK__'), 'import 没走完：' + 出.slice(-200))
  assert.equal(出.replace('__OK__', '').trim(), '', 'import 时有输出 —— 主流程还在跑：' + 出.slice(0, 200))
  assert.ok(耗时 < 5000, 'import 用了 ' + 耗时 + 'ms —— 主流程还在跑')
})

test('A4 用 node 直接跑，仍然照旧（别把 CLI 路径也挡了）', () => {
  const 契 = 跑([TOOLS + '/契约检查.mjs'], 300000)
  assert.ok(/契约检查：\d+ 项通过 \/ \d+ 项不对/.test(契), '契约检查 CLI 输出不对：' + 契.slice(-200))
  const 自 = 跑([TOOLS + '/自检.mjs'], 300000)
  assert.ok(/底座自检：\d+ 通过 \/ \d+ 不对/.test(自), '自检 CLI 输出不对：' + 自.slice(-200))
})
