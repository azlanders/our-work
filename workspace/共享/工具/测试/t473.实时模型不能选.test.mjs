// t473 「听」的模型不能是 realtime（流式接口），否则每次音画理解都空响应后静默降级
//
// 起因（批次473）：主人把模型换成 `qwen3.8-omni-flash-realtime`，问「有真实换到吗」。
// 存是存进去了（fish-omni.json 里就是它），但实测 ——
//   video 0.4s / audio 0.6s 全部 model-output-empty
//   qwen3.8-omni-flash 正常（video 2.0s、audio 14.2s）
// 因为 realtime 是 WebSocket 流式接口，这里发的是**一次性** /chat/completions。
// 面板原来只是把 realtime 排到最后（注释里写着「打过去会 4xx」），主人滚到底就点了。
// 现在：清单不列 + 保存拒绝 + 视频音频兜底。
//
// 跑法：node --test t473.实时模型不能选.test.mjs

process.env.QUIET_NOTE = '1'

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// USAGE_LOG_SANDBOX（t466 的 A2 会查这条）：本文件 import 视频音频.mjs，
// 它的 记用量() 会往 `FISH_USAGE_LOG || 真档` 追加。虽然这几次调用都在兜底处早退，
// 但规则是「碰这个模块就先指走」，别留将来改成真调用时静默写真档的口子。
process.env.FISH_USAGE_LOG = join(mkdtempSync(join(tmpdir(), 't473-usage-')), 'usage.jsonl')

const 这里 = dirname(fileURLToPath(import.meta.url))
const 工具 = join(这里, '..')
const 面板 = readFileSync(join(工具, '面板.mjs'), 'utf8')
const 音画 = readFileSync(join(工具, '视频音频.mjs'), 'utf8')

/** 造一份「听」用实时模型的配置，返回该临时配置路径。 */
function 造配置(模型) {
  const 沙 = mkdtempSync(join(tmpdir(), 't473-'))
  const p = join(沙, 'fish-omni.json')
  writeFileSync(p, JSON.stringify({ 听: { 名: 'omni', 模型, base: 'https://example.invalid/v1', upload: 'https://example.invalid/up' } }), 'utf8')
  return p
}

test('A1 面板的「听」候选清单必须把 realtime 过滤掉', () => {
  assert.match(面板, /全部\.filter\(像听\)\.filter\(\(x\) => !\/realtime\/i\.test\(x\)\)/,
    '清单里还会列出实时模型 —— 主人滚到底就会点到一个必然用不了的')
})

test('A2 面板保存时必须拒绝实时模型，并说清为什么', () => {
  assert.match(面板, /if \(\/realtime\/i\.test\(String\(新听\.模型 \|\| ''\)\)\)/, '保存没有拦实时模型')
  assert.match(面板, /realtime 走流式接口/, '拒绝时没解释原因')
})

test('A3 视频音频有兜底：实时模型直接返回可读原因，不发请求', async () => {
  const 配 = 造配置('qwen3.8-omni-flash-realtime')
  process.env.FISH_OMNI_CONFIG = 配
  try {
    const m = await import(join(工具, '视频音频.mjs') + '?t=' + Date.now())
    const t0 = Date.now()
    // 注意不能传 env：`接入(env)` 里 env !== process.env 就走**环境变量分支**，根本不读配置文件
    // （那是给测试注入用的设计）。这里要看的就是配置文件里的模型名。
    const r = await m.analyzeVideo('/nonexistent.mp4')
    const 毫秒 = Date.now() - t0
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /实时版/, '原因没说是实时模型：' + r.reason)
    assert.ok(毫秒 < 200, '它还是去发了请求（' + 毫秒 + 'ms）—— 兜底应该在发请求之前')
  } finally { rmSync(join(配, '..'), { recursive: true, force: true }) }
})

test('A4 音频那条路同样兜底', async () => {
  const 配 = 造配置('qwen-audio-3.1-realtime-plus')
  process.env.FISH_OMNI_CONFIG = 配
  try {
    const m = await import(join(工具, '视频音频.mjs') + '?a=' + Date.now())
    const r = await m.analyzeAudio('/nonexistent.mp3', { inputDir: '/' })
    assert.equal(r.ok, false)
    assert.match(String(r.reason), /实时版/, '原因没说是实时模型：' + r.reason)
  } finally { rmSync(join(配, '..'), { recursive: true, force: true }) }
})

test('A5 线上配置现在不是实时模型（否则她每次看视频都会静默降级）', () => {
  const j = JSON.parse(readFileSync('{{DSH_ROOT}}/fish-omni.json', 'utf8'))
  const 模型 = String(j?.['听']?.模型 || '')
  assert.ok(!/realtime/i.test(模型), '线上「听」的模型是 ' + 模型 + ' —— 它在这个接口上只会空响应')
})
