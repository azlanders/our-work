// t467 看视频的默认引擎必须跟面板一致（面板 omni → 全走 omni，命令行不许绕过）
//
// 起因（批次467）：`wantRich = args.includes('--omni') || getVideoMode() === 'storyboard'`
// —— 判据写反了。面板选「Omni 优先」（默认）时它判 false，掉进「只下载 + 拼 16 格图」的轻分支，
// 一次 omni 都不调；面板选 storyboard 时它反而判 true。
// 后果：她批量看 49 个视频（`node 看视频.mjs BVxxx`）全走轻分支，手上只有 mp4 + srt + 一张拼图，
// 只能读台词，画面几乎没看；而轻分支的输出里连「引擎」这一栏都没有，她根本不知道没调 omni。
// 批次468 再加一条：主人定「面板选 omni 就全用 omni」，所以 --图 在 omni 模式下必须被拒。
//
// 跑法：node --test t467.看视频默认走omni.test.mjs
// 行为用例会真去 B 站下一支 1.4MB 的短视频，输出全落在 mkdtemp 沙盒（FISH_VIDEO_OUT）。

process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const 看视频 = join(工具, '看视频.mjs')
const BV = 'BV1vfveByEJS'   // 91 秒、1.4MB，跑起来几秒

const 读 = (p) => readFileSync(p, 'utf8')

// MEDIA_CACHE：下载目录用**固定**的临时目录，不要每次 mkdtemp ——
// downloadBiliVideo 有「文件在就跳过」的逻辑（`!existsSync(mp4)`），固定目录能让第二次之后
// 完全不下载。第一版每次新目录 = 每跑一次全套都去 B 站下两遍 1.4MB，既慢又容易撞风控。
const 媒体 = process.env.FISH_TEST_MEDIA || join(tmpdir(), 't467-media')

/** 在沙盒里跑一次 CLI，返回解析后的 JSON（--json 输出）。被拒的用例 exit 1，但 JSON 已在 stdout。 */
function 跑(args, 额外env = {}) {
  const 沙 = 媒体
  try {
    let out
    try {
      out = execFileSync(process.execPath, [看视频, BV, '--json', ...args], {
        cwd: 工具,
        encoding: 'utf8',
        timeout: 240000,
        env: { ...process.env, FISH_VIDEO_OUT: 沙, ...额外env },
      })
    } catch (e) {
      out = String(e.stdout || '')
      if (!out.includes('{')) throw e
    }
    return JSON.parse(out.slice(out.indexOf('{')))
  } finally { /* 媒体目录留着复用，不删 */ }
}

test('A1 源码里 wantRich 不再依赖「面板选 storyboard」这个反条件', () => {
  // 必须先剥注释：这个文件里那段历史判据就写在注释里（说明为什么改），
  // 第一版直接扫全文，抓住自己的注释当场假红。
  const s = 读(看视频).split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')
  assert.ok(!/wantRich\s*=\s*args\.includes\('--omni'\)\s*\|\|\s*getVideoMode\(\)\s*===\s*'storyboard'/.test(s),
    'wantRich 又被写回「面板选 omni 反而不走统一管线」—— 面板怎么选都不对')
  assert.ok(/const 要快 = args\.includes\('--图'\)/.test(s), '没有 --图 这个快路径开关')
  assert.ok(/const wantRich = !要快/.test(s), '默认没有走统一管线')
})

test('A2 轻分支的输出必须自报引擎（不能让"只拼图"看起来像看过画面）', () => {
  const s = 读(看视频)
  const 段 = s.slice(s.indexOf('const dl = await downloadBiliVideo(bvid)'))
  assert.ok(/引擎:\s*音视频 \?/.test(段), '轻分支输出里没有「引擎」这一栏 —— 她读着台词以为看过画面')
  assert.ok(/没调 omni/.test(段), '轻分支没说明「这次没调 omni」')
})

test('A3 用法行要提到 --图', () => {
  assert.ok(/\[--图\]/.test(读(看视频)), '用法里没有 --图')
})

test('A4 端到端：不传 --图 时必须走统一管线（拿到音视频结论，而不是只有一张拼图）', () => {
  const j = 跑([])
  assert.equal(j.ok, true, '跑挂了：' + JSON.stringify(j).slice(0, 300))
  assert.ok(['omni', 'storyboard'].includes(j.引擎),
    '默认没走统一管线，引擎是「' + j.引擎 + '」—— 面板写着 Omni 优先，CLI 却不调')
  assert.ok(j.音视频 && typeof j.音视频 === 'object', '没有音视频结论（只有图）')
})

test('A5 端到端：面板是 Omni 优先时，--图 必须被拒（命令行不许绕过面板）', () => {
  const j = 跑(['--图'])
  assert.equal(j.ok, false, '--图 在 omni 模式下还能跑，等于绕过了面板：' + JSON.stringify(j).slice(0, 200))
  assert.match(String(j.说 || ''), /Omni 优先/, '拒绝时没说清原因：' + j.说)
})

test('A6 端到端：面板改成 storyboard 后，--图 才能用（且自报没调 omni）', () => {
  // 注意 getVideoMode() 里**配置优先于环境变量**（FISH_VIDEO_MODE 只是没有配置时的兜底）——
  // 这正是「面板是唯一开关」的实现。所以这里要造一份沙盒配置，而不是设环境变量。
  const 配 = join(mkdtempSync(join(tmpdir(), 't467-cfg-')), 'fish-omni.json')
  writeFileSync(配, JSON.stringify({ 看视频: { 模式: 'storyboard' }, 听: {} }), 'utf8')
  const j = 跑(['--图'], { FISH_OMNI_CONFIG: 配 })
  assert.equal(j.ok, true, '面板是 storyboard 时 --图 反而被拒了：' + JSON.stringify(j).slice(0, 200))
  assert.match(String(j.引擎), /拼图/, '--图 没走轻分支：' + j.引擎)
  assert.match(String(j.引擎), /没调 omni/, '轻分支没说明没调 omni')
  assert.ok(!j.音视频, '--图 不该有音视频结论')
})
