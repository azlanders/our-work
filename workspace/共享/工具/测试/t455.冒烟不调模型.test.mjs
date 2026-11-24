import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

// 批次455：两个冒烟测试是「把每个 .mjs 当 CLI 真跑一遍」，而这三个脚本**一跑就调真模型**：
//   写日记.mjs / 自主学习.mjs / 拍照想法.mjs  —— 都是 `dsh --profile headless` 起一个完整回合。
// 于是每跑一次全套：3 次真模型调用（花钱）、`--data-bot-workspace-共享-工具--` 工作区多出会话目录
// （实测 143 条）、思考流多几行。冒烟只是想验「能不能加载」，不该有这个副作用。
//
// 做法：三个脚本在调模型之前加一道 `SMOKE_NO_MODEL=1` 的闸，两个冒烟设上它。
// 这条锁：① 三道闸都在；② 两个冒烟都设了；③ 真跑一次，闸确实拦住了（不新增会话/思考流）。

const G = '{{BOT_ROOT}}/共享/工具'
const T = G + '/测试'
const 会话工作区 = '{{DSH_ROOT}}/sessions/--' + '{{BOT_ROOT}}'.slice(1).replace(/\//g, '-') + '-~5171~4EAB-~5DE5~5177--'

test('A1 三个会调模型的脚本，调之前都有 SMOKE_NO_MODEL 闸', () => {
  for (const f of ['写日记.mjs', '自主学习.mjs', '拍照想法.mjs']) {
    const s = readFileSync(join(G, f), 'utf8')
    assert.match(s, /process\.env\.SMOKE_NO_MODEL === '1'/, f + ' 没有冒烟闸')
    // 闸必须在 spawnSync 之前 —— 否则等于没闸
    const 闸 = s.indexOf("process.env.SMOKE_NO_MODEL === '1'")
    const 调 = s.indexOf('spawnSync(')
    assert.ok(闸 >= 0 && 调 > 闸, f + ' 的闸在 spawnSync 之后（等于没闸）')
  }
})

test('A2 两个冒烟都设了 SMOKE_NO_MODEL', () => {
  for (const f of ['冒烟1.加载.test.mjs', '冒烟1b.加载.test.mjs']) {
    const s = readFileSync(join(T, f), 'utf8')
    assert.match(s, /SMOKE_NO_MODEL\s*=\s*'1'/, f + ' 没设 SMOKE_NO_MODEL')
  }
})

test('A3 真跑一次 拍照想法：闸拦住，不新增会话、不写思考流', () => {
  const 前会话 = readdirSync(会话工作区).length
  const 前思考 = readFileSync('{{BOT_ROOT}}/记忆/思考流.jsonl', 'utf8').split('\n').filter(Boolean).length
  const out = execFileSync(process.execPath, [join(G, '拍照想法.mjs')], {
    encoding: 'utf8', timeout: 30000, cwd: G,
    env: { ...process.env, SMOKE_NO_MODEL: '1' },
  })
  assert.match(String(out), /不调模型/, '闸没生效，stdout：' + String(out).slice(0, 200))
  assert.equal(readdirSync(会话工作区).length, 前会话, '还是新建了会话目录')
  const 后思考 = readFileSync('{{BOT_ROOT}}/记忆/思考流.jsonl', 'utf8').split('\n').filter(Boolean).length
  assert.equal(后思考, 前思考, '还是往思考流写了东西')
})
