import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// 批次454：`一起听` 关了三天还在下载 —— 答案不是服务跑旧代码（那是 452 的另一件事），
// 而是**两个冒烟测试**：它们把每个 .mjs 当 CLI 真跑一遍，`一起听歌.mjs` 的顶层就是
// `await 同步一次()`。而它们把 `FISH_OMNI_CONFIG` 指到一个**不存在**的沙盒文件，
// `isMusicSyncEnabled()` 读不到就 fail-open（当成开着）—— 于是每跑一次全套：
//   · 真去网易云同步一次（每次两轮，两个冒烟各一次）
//   · 下载 4MB 音频到真档 `下载/`，送去云端 omni 分析（要花钱）
//   · 写真档 `记忆/一起听.json`
// 它们自己的「真档指纹」名单里**没有 一起听.json**，所以写脏了也看不见。
//
// 这条锁四件事：① 沙盒配置必须被写出来（不能靠「读不到」）；② 下载目录能被指走；
// ③ 指纹名单里有 一起听.json；④ 真跑一次冒烟，真档一个字节都不许动。

const T = '{{BOT_ROOT}}/共享/工具/测试'
const G = '{{BOT_ROOT}}/共享/工具'
const 真一起听 = '{{BOT_ROOT}}/记忆/一起听.json'
const 真下载 = '{{BOT_ROOT}}/下载'

test('A1 下载目录必须能被 QQ_MUSIC_DL 指走（写死就等于测试能往真档倒 4MB）', () => {
  const s = readFileSync(join(G, '一起听歌.mjs'), 'utf8')
  assert.match(s, /process\.env\.QQ_MUSIC_DL/, 'DL_DIR 还是写死的')
})

test('A2 两个冒烟都要把「一起听 关着」的沙盒配置写出来', () => {
  for (const f of ['冒烟1.加载.test.mjs', '冒烟1b.加载.test.mjs']) {
    const s = readFileSync(join(T, f), 'utf8')
    assert.match(s, /FISH_OMNI_CONFIG/, f + ' 没设配置路径')
    assert.match(s, /writeFileSync\([^)]*fish-omni\.json/, f + ' 没把沙盒配置写出来 —— 读不到就会 fail-open')
    assert.match(s, /一起听:\s*\{\s*开启:\s*false\s*\}/, f + ' 沙盒配置里没关掉一起听')
  }
})

test('A3 冒烟1 的真档指纹名单里必须有 一起听.json（不然写脏了自己也看不见）', () => {
  const s = readFileSync(join(T, '冒烟1.加载.test.mjs'), 'utf8')
  const m = s.match(/const 真档 = \[([\s\S]*?)\]/)
  assert.ok(m, '找不到 真档 指纹名单')
  assert.ok(m[1].includes('一起听.json'), '指纹名单里没有 一起听.json：' + m[1].slice(0, 200))
})

test('A4 真跑一次：无参数跑 一起听歌，真档 一起听.json 和 下载目录都不许动', () => {
  const 前M = existsSync(真一起听) ? readFileSync(真一起听) : null
  const 前D = existsSync(真下载) ? readdirSync(真下载).sort() : []
  const sb = mkdtempSync(join(tmpdir(), 't454-'))
  try {
    // 沙盒里明确关掉（和冒烟的做法一样），脚本应该在第一道闸就返回
    writeFileSync(join(sb, 'fish-omni.json'), JSON.stringify({ 一起听: { 开启: false } }))
    execFileSync(process.execPath, [join(G, '一起听歌.mjs')], {
      encoding: 'utf8', timeout: 30000, cwd: G,
      env: {
        ...process.env,
        FISH_OMNI_CONFIG: join(sb, 'fish-omni.json'),
        QQ_MUSIC_MEM: sb,
        QQ_MUSIC_DL: join(sb, '下载'),
      },
    })
  } finally {
    rmSync(sb, { recursive: true, force: true })
  }
  const 后M = existsSync(真一起听) ? readFileSync(真一起听) : null
  assert.deepEqual(后M, 前M, '真档 记忆/一起听.json 内容被改了')
  assert.deepEqual(existsSync(真下载) ? readdirSync(真下载).sort() : [], 前D, '真档 下载/ 里多了/少了文件')
})
