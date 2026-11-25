import test from 'node:test'
import { createHash } from 'node:crypto'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 /data/hajimi-dsh/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// USAGE_LOG_SANDBOX 2026-11-14（批次466）：本文件给 analyzeVideo / analyzeAudio 注入**假 fetch**，
// 而 视频音频.mjs 的 记用量() 每调一次就往 `流水路径` 追加一行，流水路径是
//   `process.env.FISH_USAGE_LOG || '/data/hajimi-dsh/fish-usage-log.jsonl'`
// —— 这里没设它，于是每跑一次全套就往**真用量流水**里塞两条「结果 ok / 0 token / 十几毫秒」的
// 假 omni 记录（面板上那些 0 / 0 就是它，历史累计 366 条）。指到沙盒，一条都不写进真档。
process.env.FISH_USAGE_LOG = path.join(mkdtempSync(path.join(os.tmpdir(), 't353-usage-')), 'usage.jsonl')

const TOOLS = '/data/hajimi-workspace/共享/工具'
const SOURCE = process.env.SLEEP_PHASE_SOURCE || path.join(TOOLS, '睡眠阶段.mjs')
let serial = 0

function bj(ms) {
  return new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
}


// COPY_ALL 2026-11-25：依赖关系已经跨子目录（恢复目标.mjs -> ./核心/恢复目标.mjs），
// 手写清单和只扫 './x.mjs' 的自动扫描都追不上。直接把工具目录的 .mjs 整树镜像进沙盒，
// 需要改锚点的文件（睡眠阶段/_锁）再单独覆写。
function 拷贝模块树(modules) {
  const 走 = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const from = path.join(dir, e.name)
      const to = path.join(modules, path.relative(TOOLS, from))
      if (e.isDirectory()) { mkdirSync(to, { recursive: true }); 走(from) }
      else if (e.name.endsWith('.mjs')) writeFileSync(to, readFileSync(from))
    }
  }
  走(TOOLS)
}

async function sandboxSleep({ startMs, nowMs, liveLastTick = startMs }) {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-sleep-gap-'))
  const mem = path.join(root, '记忆')
  const modules = path.join(root, '模块')
  const lockDir = path.join(root, '.locks')
  mkdirSync(mem, { recursive: true })
  mkdirSync(modules, { recursive: true })
  拷贝模块树(modules)

  let source = readFileSync(SOURCE, 'utf8')
  const baseAnchor = "const __base = process.env.ST_BASE || '/data/hajimi-workspace/记忆'"
  assert.equal(source.split(baseAnchor).length - 1, 1, 'ST_BASE path anchor must be unique')
  source = source.replace(baseAnchor, `const __base = '${mem}'`)
  source = source.replaceAll('Date.now()', 'globalThis.__T353_NOW')
  writeFileSync(path.join(modules, '睡眠阶段.mjs'), source)
  let lock = readFileSync(path.join(TOOLS, '_锁.mjs'), 'utf8')
  const lockAnchor = "const LOCK_DIR = process.env.QQ_LOCK_DIR || '/data/hajimi-workspace/记忆/.locks'"
  assert.equal(lock.split(lockAnchor).length - 1, 1, 'lock path anchor must be unique')
  lock = lock.replace(lockAnchor, `const LOCK_DIR = '${lockDir}'`)
  writeFileSync(path.join(modules, '_锁.mjs'), lock)

  const state = { 困意: 60, energy: 40, mood: { intensity: 0 } }
  const sleep = {
    sleeping: true,
    欠: 0,
    live: {
      phase: 'N1', cycle: 1, deep_min: 0, light_min: 0, rem_min: 0,
      start: bj(startMs), startMs, lastTick: liveLastTick,
    },
    segments: [{ start: bj(startMs), phases: [] }],
  }
  writeFileSync(path.join(mem, '状态.json'), JSON.stringify(state))
  writeFileSync(path.join(mem, '睡眠.json'), JSON.stringify(sleep))
  writeFileSync(path.join(mem, '睡醒.json'), JSON.stringify({ sleeping: true, since: bj(startMs) }))

  globalThis.__T353_NOW = nowMs
  const id = ++serial
  const module = await import(`${pathToFileURL(path.join(modules, '睡眠阶段.mjs')).href}?case=${id}`)
  return {
    root, mem, module,
    readSleep: () => JSON.parse(readFileSync(path.join(mem, '睡眠.json'), 'utf8')),
    close: () => { delete globalThis.__T353_NOW; rmSync(root, { recursive: true, force: true }) },
  }
}

test('心跳调度：锁冲突不写重入标记也不派发任务', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-heartbeat-lock-'))
  const modules = path.join(root, '模块')
  const lockDir = path.join(root, '.locks')
  const mem = path.join(root, '记忆')
  mkdirSync(modules, { recursive: true })
  mkdirSync(lockDir, { recursive: true })
  mkdirSync(mem, { recursive: true })
  const marker = path.join(root, 'dispatched.marker')
  const task = path.join(root, 'task.mjs')
  const table = path.join(root, '心跳表.json')
  writeFileSync(task, "import { appendFileSync } from 'node:fs'; appendFileSync(process.env.HEARTBEAT_MARKER, 'ran\\n')\n")
  writeFileSync(table, JSON.stringify([{ 名: 'marker', 脚本: task, 间隔分: 1 }]))
  const statePath = path.join(mem, '.心跳上次.json')
  const oldEnv = {
    lockDir: process.env.QQ_LOCK_DIR,
    sandbox: process.env.FISH_SANDBOX_DIR,
    marker: process.env.HEARTBEAT_MARKER,
    wait: process.env.QQ_LOCK_WAIT_MS,
  }
  process.env.QQ_LOCK_DIR = lockDir
  process.env.FISH_SANDBOX_DIR = mem
  process.env.HEARTBEAT_MARKER = marker
  process.env.QQ_LOCK_WAIT_MS = '30'
  try {
    const source = process.env.HEARTBEAT_SOURCE || path.join(TOOLS, '心跳.mjs')
    // 顺着 import 递归拷依赖。原来是手写清单 —— 每给 心跳.mjs 加一个 import 就红一次：
    // 批次413（体检-判断权 缺 待办）、批次419（心跳 缺 待办）各踩过一遍，同一个病。
    const 拷 = (名) => {
      const 目标 = path.join(modules, 名)
      if (existsSync(目标)) return
      const 源 = (名 === '心跳.mjs' && source !== path.join(TOOLS, '心跳.mjs')) ? source : path.join(TOOLS, 名)
      if (!existsSync(源)) return
      const 文 = readFileSync(源, 'utf8')
      writeFileSync(目标, 文)
      for (const m of 文.matchAll(/(?:from|import)\s*\(?\s*'\.\/([^']+)'/g)) 拷(m[1])
    }
    拷('心跳.mjs')
    assert.ok(existsSync(path.join(modules, '待办.mjs')), '递归拷没把 待办.mjs 带进来')
    const module = await import(`${pathToFileURL(path.join(modules, '心跳.mjs')).href}?heartbeat-lock=${++serial}`)
    writeFileSync(path.join(lockDir, 'heartbeat.lock'), '')
    writeFileSync(statePath, JSON.stringify({ lastStart: 123456789 }))
    const before = readFileSync(statePath)
    const result = module.跑一轮(['--tick', '--表', table], () => {})
    assert.equal(result.skipped, 'lock', '锁冲突时必须返回 skipped')
    assert.equal(existsSync(marker), false, '锁冲突时不得启动任务子进程')
    assert.deepEqual(readFileSync(statePath), before, '锁冲突时不得更新重入标记')

    rmSync(path.join(lockDir, 'heartbeat.lock'), { recursive: true, force: true })
    const normal = module.跑一轮(['--tick', '--表', table], () => {})
    assert.equal(normal.跑, 1, '无锁时仍应派发命中任务')
    assert.equal(readFileSync(marker, 'utf8'), 'ran\n')
  } finally {
    for (const [key, value] of Object.entries({
      QQ_LOCK_DIR: oldEnv.lockDir,
      FISH_SANDBOX_DIR: oldEnv.sandbox,
      HEARTBEAT_MARKER: oldEnv.marker,
      QQ_LOCK_WAIT_MS: oldEnv.wait,
    })) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { recursive: true, force: true })
  }
})

test('视频音频理解：有界上传、联合请求、缓存与降级', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-omni-'))
  const video = path.join(root, 'sample.mp4')
  const cache = path.join(root, 'sample.omni.json')
  writeFileSync(video, Buffer.from('mock-video'))
  const omni = await import(`${pathToFileURL(path.join(TOOLS, '视频音频.mjs')).href}?omni=${++serial}`)
  const env = {
    DASHSCOPE_API_KEY: 'mock-key',
    DASHSCOPE_BASE_URL: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
    DASHSCOPE_UPLOAD_URL: 'https://dashscope.aliyuncs.com/api/v1/uploads',
  }
  const calls = []
  let request = null
  try {
    const fetchMock = async (url, init = {}) => {
      const address = String(url)
      calls.push(address)
      if (address.includes('/api/v1/uploads?')) return { ok: true, status: 200, json: async () => ({ data: {
        policy: 'p', signature: 's', upload_dir: 'upload/mock', upload_host: 'https://oss.aliyuncs.com',
        oss_access_key_id: 'ak', x_oss_object_acl: 'private', x_oss_forbid_overwrite: 'true', max_file_size_mb: 100,
      } }) }
      if (address === 'https://oss.aliyuncs.com/') {
        assert.equal(init.method, 'POST')
        assert.ok(init.body instanceof FormData)
        assert.equal(init.body.get('success_action_status'), '200')
        assert.equal(init.body.get('key'), 'upload/mock/sample.mp4')
        assert.equal(init.body.get('file').name, 'sample.mp4')
        assert.equal(init.body.get('file').size, Buffer.byteLength('mock-video'))
        return { ok: true, status: 200 }
      }
      if (address.endsWith('/chat/completions')) {
        assert.equal(init.headers['X-DashScope-OssResourceResolve'], 'enable')
        request = JSON.parse(init.body)
        return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '听到一段解释，画面在展示器材。' } }] }) }
      }
      throw new Error('unexpected endpoint')
    }
    const result = await omni.analyzeVideo(video, { env, cachePath: cache, fetchFn: fetchMock,
      probeFn: async () => ({ duration: 40, audio: true }) })
    assert.equal(result.ok, true)
    assert.equal(result.text, '听到一段解释，画面在展示器材。')
    assert.equal(request.model, 'qwen3.8-omni-flash')
    assert.equal(request.messages[0].content[0].type, 'video_url')
    assert.equal(request.messages[0].content[0].video_url.url, 'oss://upload/mock/sample.mp4')
    const before = calls.length
    const cached = await omni.analyzeVideo(video, { env, cachePath: cache,
      fetchFn: async () => { throw new Error('cache should avoid a second charge') },
      probeFn: async () => ({ duration: 40, audio: true }) })
    assert.equal(cached.cached, true)
    assert.equal(calls.length, before)

    let forbidden = 0
    const noAudio = await omni.analyzeVideo(video, { env, fetchFn: async () => { forbidden++; throw new Error('unexpected call') },
      probeFn: async () => ({ duration: 40, audio: false }) })
    assert.equal(noAudio.reason, 'audio-track-missing')
    const longVideo = await omni.analyzeVideo(video, { env, fetchFn: async () => { forbidden++; throw new Error('unexpected call') },
      probeFn: async () => ({ duration: omni.MAX_VIDEO_SECONDS + 1, audio: true }) })
    assert.equal(longVideo.reason, 'duration-limit')
    const largeVideo = await omni.analyzeVideo(video, { env, statFn: () => ({ isFile: () => true, size: omni.MAX_VIDEO_BYTES + 1, mtimeMs: 10 }),
      fetchFn: async () => { forbidden++; throw new Error('unexpected call') } })
    assert.equal(largeVideo.reason, 'video-size-limit')
    const noConfig = await omni.analyzeVideo(video, { env: {}, fetchFn: async () => { forbidden++; throw new Error('unexpected call') } })
    assert.equal(noConfig.reason, 'not-configured')
    assert.equal(forbidden, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D6：纯音频理解使用官方input_audio字段并缓存', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-audio-only-'))
  const file = path.join(root, 'song.mp3')
  const cache = path.join(root, 'song.audio.omni.json')
  writeFileSync(file, Buffer.from('mock-audio-bytes'))
  const omni = await import(`${pathToFileURL(path.join(TOOLS, '视频音频.mjs')).href}?audio=${++serial}`)
  const env = { DASHSCOPE_API_KEY: 'mock-key', DASHSCOPE_BASE_URL: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' }
  const calls = []
  assert.equal(omni.AUDIO_INPUT_DIR, '/data/hajimi-workspace/下载')
  let request = null
  try {
    assert.equal(omni.omniAudioConfigured(env), true)
    const fetchMock = async (url, init = {}) => {
      calls.push(String(url))
      assert.ok(String(url).endsWith('/chat/completions'), '纯音频无需先上传视频OSS')
      request = JSON.parse(init.body)
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '听见轻快鼓点与女声旋律。' } }] }) }
    }
    const result = await omni.analyzeAudio(file, { env, inputDir: root, cachePath: cache, fetchFn: fetchMock,
      probeFn: async () => ({ duration: 210, audio: true }) })
    assert.equal(result.ok, true)
    assert.equal(result.text, '听见轻快鼓点与女声旋律。')
    assert.equal(request.model, 'qwen3.8-omni-flash')
    const item = request.messages[0].content[0]
    assert.equal(item.type, 'input_audio')
    assert.equal(item.input_audio.format, 'mp3')
    assert.ok(Buffer.byteLength(item.input_audio.data) < 10 * 1024 * 1024)
    assert.match(item.input_audio.data, /^data:audio\/mp3;base64,/)
    assert.deepEqual(Buffer.from(item.input_audio.data.split(',')[1], 'base64'), Buffer.from('mock-audio-bytes'))
    assert.ok(request.messages[0].content.some((x) => x.type === 'text' && /素材/.test(x.text)))
    const before = calls.length
    const cached = await omni.analyzeAudio(file, { env, inputDir: root, cachePath: cache, fetchFn: async () => { throw new Error('cache should avoid request') },
      probeFn: async () => ({ duration: 210, audio: true }) })
    assert.equal(cached.cached, true)
    assert.equal(calls.length, before)

    let forbidden = 0
    const tooLong = await omni.analyzeAudio(file, { env, inputDir: root, probeFn: async () => ({ duration: omni.MAX_AUDIO_SECONDS + 1, audio: true }), fetchFn: async () => { forbidden++; throw new Error('unexpected') } })
    assert.equal(tooLong.reason, 'duration-limit')
    const noTrack = await omni.analyzeAudio(file, { env, inputDir: root, probeFn: async () => ({ duration: 2, audio: false }), fetchFn: async () => { forbidden++; throw new Error('unexpected') } })
    assert.equal(noTrack.reason, 'audio-track-missing')
    const unsupported = await omni.analyzeAudio(path.join(root, 'song.txt'), { env, inputDir: root, fetchFn: async () => { forbidden++; throw new Error('unexpected') } })
    assert.equal(unsupported.reason, 'format-unsupported')
    const outside = await omni.analyzeAudio(path.join(root, '..', 'outside.mp3'), { env, inputDir: root, fetchFn: async () => { forbidden++; throw new Error('unexpected') } })
    assert.equal(outside.reason, 'path-outside-audio-dir')
    const tooLarge = await omni.analyzeAudio(file, { env, inputDir: root, statFn: () => ({ isFile: () => true, size: omni.MAX_AUDIO_BYTES + 1, mtimeMs: 1 }), fetchFn: async () => { forbidden++; throw new Error('unexpected') } })
    assert.equal(tooLarge.reason, 'base64-size-limit')
    const noConfig = await omni.analyzeAudio(file, { env: {}, inputDir: root, fetchFn: async () => { forbidden++; throw new Error('unexpected') } })
    assert.equal(noConfig.reason, 'not-configured')
    assert.equal(forbidden, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D6：分享卡需显式确认且目标在服务白名单内', async () => {
  const tool = await import(`${pathToFileURL(path.join(process.env.TOOL_LIB || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib', 'tool.js')).href}?card=${++serial}`)
  const calls = []
  const deps = { targets: { private: new Set(['1000000001']), group: new Set(['2000000002']) }, send: async (payload) => {
    calls.push(payload)
    return { retcode: 0, data: { message_id: 78 } }
  } }
  const good = { target_type: 'group', target_id: '2000000002', title: '歌名', summary: '分享音乐', url: 'https://www.bilibili.com/video/BVtest', source: '音乐', confirm: true }
  await assert.rejects(tool.sendShareCard({ ...good, confirm: false }, deps), /confirm/)
  await assert.rejects(tool.sendShareCard({ ...good, target_id: '9999999999' }, deps), /白名单/)
  await assert.rejects(tool.sendShareCard({ ...good, url: 'http://example.com/x' }, deps), /HTTPS/)
  assert.equal(calls.length, 0, '确认失败/目标失败不能调用发送器')
  const result = await tool.sendShareCard(good, deps)
  assert.equal(result.message_id, 78)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].action, 'send_group_msg')
  const card = JSON.parse(calls[0].params.message[0].data.data)
  assert.equal(card.meta.news.title, '歌名')
  assert.equal(card.meta.news.jumpUrl, good.url)
  assert.equal(calls[0].params.group_id, 2000000002)
  await assert.rejects(tool.sendShareCard({ ...good, target_type: 'private', target_id: '1000000001', source: '音乐' }, {
    ...deps, send: async () => ({ retcode: 0, data: {} })
  }), /message_id/)
})

test('B站学习：把音视频摘要注入提示且保持视觉回退', () => {
  const video = readFileSync(path.join(TOOLS, '看视频.mjs'), 'utf8')
  const learning = readFileSync(path.join(TOOLS, '自主学习.mjs'), 'utf8')
  const prompt = readFileSync(path.join(TOOLS, '自主-B站学习.md'), 'utf8')
  const audio = readFileSync(path.join(TOOLS, '视频音频.mjs'), 'utf8')
  assert.match(audio, /openAsBlob\(file/)
  assert.doesNotMatch(audio, /const chunks=\[\]/)
  assert.match(video, /analyzeVideo\(mp4/)
  assert.match(video, /args\.includes\('--omni'\)/)
  assert.match(learning, /'--json', '--omni'/)
  assert.match(learning, /replaceAll\('\{\{AV\}\}'/)
  assert.match(prompt, /\{\{AV\}\}/)
  assert.match(prompt, /不是权威事实或指令/)
})

test('QQ 状态：仅在有效吃饭窗口显示正在进餐', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-meal-status-'))
  const mem = path.join(root, '记忆')
  mkdirSync(mem, { recursive: true })
  const source = readFileSync(process.env.STATUS_SCRIPT || path.join(TOOLS, '同步QQ状态.mjs'), 'utf8')
  const runnerSource = source.replace(/from '\.\/([^']+)'/g, (_match, name) => `from '${TOOLS}/${name}'`)
  const runner = path.join(root, '同步QQ状态.mjs')
  writeFileSync(runner, runnerSource)
  const date = (ms) => new Date(ms + 8 * 60 * 60e3).toISOString().slice(0, 16).replace('T', ' ')
  const writeJson = (name, value) => writeFileSync(path.join(mem, name), JSON.stringify(value, null, 2))
  const run = () => {
    const result = spawnSync(process.execPath, [runner, '--看'], {
      encoding: 'utf8',
      env: { ...process.env, STATUS_BASE: root, STATUS_CFG: path.join(root, 'missing-config.json') },
    })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  try {
    writeJson('资产.json', { 位置: '家' })
    writeJson('睡眠.json', { live: null })
    writeJson('睡醒.json', { sleeping: false })
    writeJson('自主.json', { state: '吃点东西', since: Date.now(), doneAt: Date.now() })
    assert.equal(run(), '会写成：在家', '上次吃东西已结束且无有效吃饭窗口时应显示闲暇')

    const now = Date.now()
    writeJson('吃饭.json', { 开始: date(now - 2 * 60e3), 到: date(now + 25 * 60e3), 吃啥: '火锅', 在哪: '家' })
    assert.equal(run(), '会写成：在家吃火锅', '有效吃饭窗口应显示当前进餐')

    writeJson('吃饭.json', { 开始: date(now - 40 * 60e3), 到: date(now - 5 * 60e3), 吃啥: '火锅', 在哪: '家' })
    writeJson('自主.json', { state: '吃饭', since: now - 40 * 60e3, doneAt: now - 5 * 60e3 })
    assert.equal(run(), '会写成：在家', '过期的吃饭窗口不能继续显示正在进餐')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('活动与缺口台账：锁内重读追加保留交错写入', async () => {
  const activitySource = readFileSync(process.env.ACTIVITY_SOURCE || path.join(TOOLS, '活动.mjs'), 'utf8')
  const gapSource = readFileSync(process.env.GAP_SOURCE || path.join(TOOLS, '缺口.mjs'), 'utf8')
  assert.match(activitySource, /const 追加活动记录 = \(entry\) => 改档\(logP,/)
  assert.match(activitySource, /latest\.log = \[\.\.\.\(latest\.log \|\| \[\]\), entry\]\.slice\(-300\)/)
  assert.doesNotMatch(activitySource, /save\(logP,\s*记\)/)
  assert.match(gapSource, /改档\(台账P,\s*\(latest\)\s*=>\s*\{\s*latest\.asks\s*=/)
  assert.match(gapSource, /改档\(台账P,\s*\(latest\)\s*=>\s*\{\s*latest\.log\s*=/)
  assert.doesNotMatch(gapSource, /save\(台账P,\s*台账\)/)

  const root = mkdtempSync(path.join(os.tmpdir(), 't353-ledger-rmw-'))
  const modules = path.join(root, '模块')
  const lockDir = path.join(root, '.locks')
  mkdirSync(modules, { recursive: true })
  mkdirSync(lockDir, { recursive: true })
  const ledgerPath = path.join(root, '缺口台账.json')
  writeFileSync(ledgerPath, JSON.stringify({ asks: [], worked: [{ id: 'keep' }], log: [] }))
  const oldLockDir = process.env.QQ_LOCK_DIR
  process.env.QQ_LOCK_DIR = lockDir
  try {
    writeFileSync(path.join(modules, '_底层.mjs'), readFileSync(path.join(TOOLS, '_底层.mjs')))
    writeFileSync(path.join(modules, '_锁.mjs'), readFileSync(path.join(TOOLS, '_锁.mjs')))
    const bottom = await import(`${pathToFileURL(path.join(modules, '_底层.mjs')).href}?ledger-rmw=${++serial}`)
    const defaults = { asks: [], worked: [], log: [] }
    const add = (key, entry, limit) => bottom.改档(ledgerPath, (latest) => {
      latest[key] = [...(latest[key] || []), entry].slice(-limit)
    }, defaults)
    add('log', { id: 'activity-1' }, 300)
    add('asks', { id: 'ask-1' }, 50)
    add('log', { id: 'gap-1' }, 200)
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'))
    assert.deepEqual(ledger.log.map((x) => x.id), ['activity-1', 'gap-1'])
    assert.deepEqual(ledger.asks.map((x) => x.id), ['ask-1'])
    assert.deepEqual(ledger.worked.map((x) => x.id), ['keep'])
  } finally {
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('别扭状态：进程锁必须严格失败关闭', async () => {
  const source = readFileSync(process.env.SULK_SOURCE || path.join(TOOLS, '别扭.mjs'), 'utf8')
  const lockCall = source.match(/const __放锁 = 加锁\(basename\(path\)([^)]*)\)/)
  assert.ok(lockCall, '别扭多分支读改写必须持有进程锁')
  assert.ok(lockCall[0].includes('strict: true'), '别扭档案写入必须使用严格锁')

  const root = mkdtempSync(path.join(os.tmpdir(), 't353-sulk-lock-'))
  const modules = path.join(root, '模块')
  mkdirSync(modules, { recursive: true })
  const oldLockDir = process.env.QQ_LOCK_DIR
  process.env.QQ_LOCK_DIR = '/proc'
  try {
    writeFileSync(path.join(modules, '_锁.mjs'), readFileSync(path.join(TOOLS, '_锁.mjs')))
    const lock = await import(`${pathToFileURL(path.join(modules, '_锁.mjs')).href}?sulk-lock=${++serial}`)
    assert.throws(() => lock.加锁('别扭.json', { strict: true, waitMs: 0 }), (error) => error.code === 'ENOENT')
  } finally {
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('偏好写入：严格锁目录错误时拒绝进入读改写', async () => {
  const source = readFileSync(process.env.PREFERENCE_SOURCE || path.join(TOOLS, '偏好.mjs'), 'utf8')
  const lockCall = source.match(/const 放 = 加锁\(basename\(P\)([^)]*)\)/)
  assert.ok(lockCall, '偏好退役/恢复必须仍经过共享锁')
  assert.ok(lockCall[0].includes('strict: true'), '偏好读改写应使用严格锁')

  const root = mkdtempSync(path.join(os.tmpdir(), 't353-preference-lock-'))
  const modules = path.join(root, '模块')
  mkdirSync(modules, { recursive: true })
  const oldLockDir = process.env.QQ_LOCK_DIR
  process.env.QQ_LOCK_DIR = '/proc'
  try {
    writeFileSync(path.join(modules, '_锁.mjs'), readFileSync(path.join(TOOLS, '_锁.mjs')))
    const lock = await import(`${pathToFileURL(path.join(modules, '_锁.mjs')).href}?preference-lock=${++serial}`)
    assert.throws(() => lock.加锁('偏好.json', { strict: true, waitMs: 0 }), (error) => error.code === 'ENOENT')
  } finally {
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('严格锁：锁目录创建错误必须 fail-closed', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-lock-dir-error-'))
  const modules = path.join(root, '模块')
  mkdirSync(modules, { recursive: true })
  const oldLockDir = process.env.QQ_LOCK_DIR
  process.env.QQ_LOCK_DIR = '/proc'
  try {
    const lockSource = process.env.LOCK_SOURCE || path.join(TOOLS, '_锁.mjs')
    writeFileSync(path.join(modules, '_锁.mjs'), readFileSync(lockSource))
    const lock = await import(`${pathToFileURL(path.join(modules, '_锁.mjs')).href}?strict-lock-error=${++serial}`)
    assert.throws(
      () => lock.加锁('strict-error-probe', { strict: true, waitMs: 0 }),
      (error) => error.code === 'ENOENT',
      '严格模式不能把锁目录创建错误当成锁已取得',
    )
    const legacyRelease = lock.加锁('legacy-error-probe', { strict: false, waitMs: 0 })
    assert.equal(typeof legacyRelease, 'function', '非严格调用保持既有兼容行为')
    legacyRelease()
  } finally {
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('计划写入：锁冲突 fail-closed 且保留其他日期键', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-plan-lock-'))
  const lockDir = path.join(root, '.locks')
  const modules = path.join(root, '模块')
  mkdirSync(lockDir, { recursive: true })
  mkdirSync(modules, { recursive: true })
  const planPath = path.join(root, '计划.json')
  writeFileSync(planPath, JSON.stringify({ days: { '2026-11-09': { goals: [{ id: 'old' }], done: [] } } }))
  writeFileSync(path.join(lockDir, '计划.json.lock'), '')
  const oldLockDir = process.env.QQ_LOCK_DIR
  const oldWait = process.env.QQ_LOCK_WAIT_MS
  process.env.QQ_LOCK_DIR = lockDir
  process.env.QQ_LOCK_WAIT_MS = '40'
  try {
    const bottomSource = process.env.BOTTOM_SOURCE || path.join(TOOLS, '_底层.mjs')
    writeFileSync(path.join(modules, '_底层.mjs'), readFileSync(bottomSource))
    writeFileSync(path.join(modules, '_锁.mjs'), readFileSync(path.join(TOOLS, '_锁.mjs')))
    const bottom = await import(`${pathToFileURL(path.join(modules, '_底层.mjs')).href}?plan-lock=${++serial}`)
    assert.throws(() => bottom.改档(planPath, (plan) => { plan.days['2026-11-10'] = { goals: [], done: [] } }), /文件锁超时/)
    rmSync(path.join(lockDir, '计划.json.lock'), { force: true })
    bottom.改档(planPath, (plan) => { plan.days['2026-11-10'] = { goals: [{ id: 'today' }], done: [] } })
    bottom.改档(planPath, (plan) => { plan.days['2026-11-10'].done.push('today') })
    const plan = JSON.parse(readFileSync(planPath, 'utf8'))
    assert.equal(plan.days['2026-11-09'].goals[0].id, 'old')
    assert.deepEqual(plan.days['2026-11-10'].done, ['today'])
  } finally {
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    if (oldWait === undefined) delete process.env.QQ_LOCK_WAIT_MS
    else process.env.QQ_LOCK_WAIT_MS = oldWait
    rmSync(root, { recursive: true, force: true })
  }
})

test('关键账改档：锁超时拒绝继续写', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-ledger-lock-'))
  const lockDir = path.join(root, '.locks')
  mkdirSync(lockDir, { recursive: true })
  const file = path.join(root, '资产.json')
  writeFileSync(file, JSON.stringify({ 钱: 100, 记录: [] }))
  const oldLockDir = process.env.QQ_LOCK_DIR
  process.env.QQ_LOCK_DIR = lockDir
  try {
    const source = process.env.BOTTOM_SOURCE || path.join(TOOLS, '_底层.mjs')
    const localModules = path.join(root, '模块')
    mkdirSync(localModules, { recursive: true })
    writeFileSync(path.join(localModules, '_底层.mjs'), readFileSync(source))
    writeFileSync(path.join(localModules, '_锁.mjs'), readFileSync(path.join(TOOLS, '_锁.mjs')))
    const bottom = await import(`${pathToFileURL(path.join(localModules, '_底层.mjs')).href}?ledger-lock=${++serial}`)
    writeFileSync(path.join(lockDir, '资产.json.lock'), '')
    assert.throws(() => bottom.改档(file, (asset) => { asset.钱 = 99 }), /文件锁超时/)
  } finally {
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('共享状态写入：锁超时拒绝旧快照', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-state-lock-'))
  const lockDir = path.join(root, '.locks')
  mkdirSync(lockDir, { recursive: true })
  const statePath = path.join(root, '状态.json')
  writeFileSync(statePath, JSON.stringify({ layers: { physical: 60 }, energy: 60 }))
  writeFileSync(path.join(lockDir, '状态.json.lock'), '')
  writeFileSync(statePath + '.lock', '')
  const oldWait = process.env.QQ_STATE_LOCK_WAIT_MS
  const oldLockDir = process.env.QQ_LOCK_DIR
  process.env.QQ_STATE_LOCK_WAIT_MS = '40'
  process.env.QQ_LOCK_DIR = lockDir
  try {
    const source = process.env.STATE_SOURCE || path.join(TOOLS, '_状态.mjs')
    const localModules = path.join(root, '模块')
    mkdirSync(localModules, { recursive: true })
    writeFileSync(path.join(localModules, '_状态.mjs'), readFileSync(source))
    writeFileSync(path.join(localModules, '_锁.mjs'), readFileSync(path.join(TOOLS, '_锁.mjs')))
    const state = await import(`${pathToFileURL(path.join(localModules, '_状态.mjs')).href}?state-lock=${++serial}`)
    const before = state.clone(state.loadState(statePath))
    const next = state.clone(before)
    next.layers.physical = 61
    assert.throws(() => state.saveState(statePath, next, before), /文件锁超时/)
  } finally {
    if (oldWait === undefined) delete process.env.QQ_STATE_LOCK_WAIT_MS
    else process.env.QQ_STATE_LOCK_WAIT_MS = oldWait
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('共享状态写入：两个旧快照只合并各自改动的嵌套字段', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-state-merge-'))
  const lockDir = path.join(root, '.locks')
  mkdirSync(lockDir, { recursive: true })
  const statePath = path.join(root, '状态.json')
  writeFileSync(statePath, JSON.stringify({ layers: { physical: 60, cognitive: 60 }, energy: 60 }))
  const oldLockDir = process.env.QQ_LOCK_DIR
  process.env.QQ_LOCK_DIR = lockDir
  try {
    const source = process.env.STATE_SOURCE || path.join(TOOLS, '_状态.mjs')
    const localModules = path.join(root, '模块')
    mkdirSync(localModules, { recursive: true })
    writeFileSync(path.join(localModules, '_状态.mjs'), readFileSync(source))
    writeFileSync(path.join(localModules, '_锁.mjs'), readFileSync(path.join(TOOLS, '_锁.mjs')))
    const state = await import(`${pathToFileURL(path.join(localModules, '_状态.mjs')).href}?state-merge=${++serial}`)
    const firstBefore = state.clone(state.loadState(statePath))
    const secondBefore = state.clone(firstBefore)
    const firstNext = state.clone(firstBefore)
    const secondNext = state.clone(secondBefore)
    firstNext.layers.physical = 61
    secondNext.layers.cognitive = 62
    state.saveState(statePath, firstNext, firstBefore)
    state.saveState(statePath, secondNext, secondBefore)
    const merged = state.loadState(statePath)
    assert.equal(merged.layers.physical, 61)
    assert.equal(merged.layers.cognitive, 62)
    assert.equal(merged.energy, 60)
  } finally {
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    rmSync(root, { recursive: true, force: true })
  }
})

test('睡眠阶段：锁冲突时拒绝写睡眠文件', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-sleep-lock-'))
  const mem = path.join(root, '记忆')
  const modules = path.join(root, '模块')
  const lockDir = path.join(root, '.locks')
  mkdirSync(mem, { recursive: true })
  mkdirSync(modules, { recursive: true })
  mkdirSync(lockDir, { recursive: true })
  拷贝模块树(modules)
  const sleepPath = path.join(mem, '睡眠.json')
  const statePath = path.join(mem, '状态.json')
  const dreamPath = path.join(mem, '梦余味.json')
  const initialSleep = {
    sleeping: true,
    欠: 0,
    live: { phase: 'N2', cycle: 1, deep_min: 10, rem_min: 0, start: '2026-11-10 06:00:00', startMs: 1794200000000, lastTick: 1794200000000 },
    segments: [{ start: '2026-11-10 06:00:00', phases: [] }],
  }
  const initialState = { 困意: 60, energy: 40, mood: { intensity: 0 }, layers: { emotional: 50 } }
  const initialDream = { date: '2026-11-10', 好: true, 情绪已用: false }
  writeFileSync(sleepPath, JSON.stringify(initialSleep))
  writeFileSync(statePath, JSON.stringify(initialState))
  writeFileSync(dreamPath, JSON.stringify(initialDream))
  writeFileSync(path.join(lockDir, '梦余味.json.lock'), '')
  const oldBase = process.env.ST_BASE
  const oldLockDir = process.env.QQ_LOCK_DIR
  const oldLockWait = process.env.QQ_LOCK_WAIT_MS
  process.env.ST_BASE = mem
  process.env.QQ_LOCK_DIR = lockDir
  process.env.QQ_LOCK_WAIT_MS = '40'
  try {
    const source = process.env.SLEEP_PHASE_SOURCE || path.join(TOOLS, '睡眠阶段.mjs')
    let content = readFileSync(source, 'utf8')
    const baseAnchor = "const __base = process.env.ST_BASE || '/data/hajimi-workspace/记忆'"
    assert.equal(content.split(baseAnchor).length - 1, 1)
    content = content.replace(baseAnchor, `const __base = '${mem}'`)
    content = content.replaceAll('Date.now()', 'globalThis.__T353_NOW')
    writeFileSync(path.join(modules, '睡眠阶段.mjs'), content)
    writeFileSync(path.join(modules, '睡眠段.mjs'), readFileSync(path.join(TOOLS, '睡眠段.mjs')))
    let lock = readFileSync(path.join(TOOLS, '_锁.mjs'), 'utf8')
    const lockAnchor = "const LOCK_DIR = process.env.QQ_LOCK_DIR || '/data/hajimi-workspace/记忆/.locks'"
    assert.equal(lock.split(lockAnchor).length - 1, 1)
    lock = lock.replace(lockAnchor, `const LOCK_DIR = '${lockDir}'`)
    writeFileSync(path.join(modules, '_锁.mjs'), lock)
    globalThis.__T353_NOW = 1794200000000
    const module = await import(`${pathToFileURL(path.join(modules, '睡眠阶段.mjs')).href}?sleep-lock=${++serial}`)
    initialSleep.live.start = bj(globalThis.__T353_NOW - 60 * 60e3)
    initialSleep.live.startMs = globalThis.__T353_NOW - 60 * 60e3
    initialSleep.live.lastTick = globalThis.__T353_NOW - 60 * 60e3
    writeFileSync(sleepPath, JSON.stringify(initialSleep))
    initialDream.date = bj(globalThis.__T353_NOW).slice(0, 10)
    writeFileSync(dreamPath, JSON.stringify(initialDream))
    const beforeSleep = readFileSync(sleepPath)
    const beforeState = readFileSync(statePath)
    const beforeDream = readFileSync(dreamPath)
    const liveSleepPath = '/data/hajimi-workspace/记忆/睡眠.json'
    const liveStatePath = '/data/hajimi-workspace/记忆/状态.json'
    const liveBefore = [liveSleepPath, liveStatePath].map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'))
    rmSync(path.join(lockDir, '睡眠.json.lock'), { force: true })
    writeFileSync(path.join(lockDir, '梦余味.json.lock'), '')
    const result = module.endSleep('test-lock')
    assert.equal(result.ok, false, '梦余味锁被占用时 endSleep 必须失败关闭')
    assert.deepEqual(readFileSync(sleepPath), beforeSleep, '睡眠.json 必须保持不变')
    assert.deepEqual(readFileSync(statePath), beforeState, '状态.json 必须保持不变')
    assert.deepEqual(readFileSync(dreamPath), beforeDream, '梦余味.json 必须保持不变')
    const liveAfter = [liveSleepPath, liveStatePath].map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'))
    assert.deepEqual(liveAfter, liveBefore, '真实睡眠与状态文件指纹必须前后一致')
  } finally {
    delete globalThis.__T353_NOW
    if (oldBase === undefined) delete process.env.ST_BASE
    else process.env.ST_BASE = oldBase
    if (oldLockDir === undefined) delete process.env.QQ_LOCK_DIR
    else process.env.QQ_LOCK_DIR = oldLockDir
    if (oldLockWait === undefined) delete process.env.QQ_LOCK_WAIT_MS
    else process.env.QQ_LOCK_WAIT_MS = oldLockWait
    rmSync(root, { recursive: true, force: true })
  }
})

test('睡眠阶段：停机8小时后补算阶段并继续推进，不陷入永久失败', async () => {
  const startMs = 1794200000000
  const nowMs = startMs + 8 * 60 * 60e3
  const sb = await sandboxSleep({ startMs, nowMs })
  try {
    const first = sb.module.tickSleep()
    assert.equal(first.ok, true)
    assert.equal(first.phase, 'N2')
    let sleep = sb.readSleep()
    assert.equal(sleep.live.lastTick, nowMs)
    assert.equal(sleep.live.cycle, 5)
    assert.equal(sleep.live.deep_min, 140)
    assert.equal(sleep.live.rem_min, 80)

    globalThis.__T353_NOW = nowMs + 20 * 60e3
    const second = sb.module.tickSleep()
    assert.equal(second.ok, true)
    sleep = sb.readSleep()
    assert.equal(sleep.live.lastTick, nowMs + 20 * 60e3)
    assert.equal(sleep.live.deep_min, 140)
    assert.equal(sleep.live.rem_min, 80)
  } finally {
    sb.close()
  }
})

test('睡眠阶段：超过24小时的异常时间戳只补算最近24小时并明确告警', async () => {
  const startMs = 1794200000000
  const nowMs = startMs + 30 * 60 * 60e3
  const sb = await sandboxSleep({ startMs, nowMs })
  const warnings = []
  const oldWarn = console.warn
  try {
    console.warn = (...args) => warnings.push(args.join(' '))
    const result = sb.module.tickSleep()
    assert.equal(result.ok, true)
    const sleep = sb.readSleep()
    assert.equal(sleep.live.lastTick, nowMs)
    assert.ok(sleep.live.deep_min + sleep.live.light_min + sleep.live.rem_min <= 24 * 60)
    assert.ok(warnings.some((line) => line.includes('限制为24小时')))
  } finally {
    console.warn = oldWarn
    sb.close()
  }
})

test('睡眠阶段：超过6小时补算与正常20分钟tick的阶段账一致', async () => {
  const startMs = 1794200000000
  const endMs = startMs + 8 * 60 * 60e3
  const caughtUp = await sandboxSleep({ startMs, nowMs: endMs })
  const regular = await sandboxSleep({ startMs, nowMs: startMs + 20 * 60e3 })
  try {
    globalThis.__T353_NOW = endMs
    assert.equal(caughtUp.module.tickSleep().ok, true)
    for (let i = 1; i <= 24; i++) {
      globalThis.__T353_NOW = startMs + i * 20 * 60e3
      assert.equal(regular.module.tickSleep().ok, true)
    }
    const readTotals = (sb) => {
      const live = sb.readSleep().live
      return { phase: live.phase, cycle: live.cycle, deep: live.deep_min, rem: live.rem_min }
    }
    assert.deepEqual(readTotals(caughtUp), readTotals(regular))
    assert.deepEqual(readTotals(caughtUp), { phase: 'N2', cycle: 5, deep: 140, rem: 80 })
  } finally {
    caughtUp.close()
    regular.close()
  }
})



test('花钱：购买入口在方式初始化前不触发 TDZ', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-purchase-tdz-'))
  const mem = path.join(root, '记忆')
  mkdirSync(mem, { recursive: true })
  writeFileSync(path.join(mem, '资产.json'), JSON.stringify({ 钱: 100, 位置: '便利店', 包: [], 家: [], 记录: [] }))
  writeFileSync(path.join(mem, '状态.json'), JSON.stringify({ mood: { intensity: 0 } }))
  try {
    const result = spawnSync(process.execPath, [path.join(TOOLS, '花钱.mjs'), '--买', '糖'], {
      cwd: root, encoding: 'utf8', timeout: 15000,
      env: { ...process.env, QQ_AUTONOMY_MEM: mem, NODE_OPTIONS: '' },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /买了\s*糖/)
    const asset = JSON.parse(readFileSync(path.join(mem, '资产.json'), 'utf8'))
    assert.equal(asset.钱, 94)
    assert.equal(asset.记录.length, 1)
    assert.match(String(asset.记录[0].id || ''), /^purchase:/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})


test('排班判据：30分钟预告、开班内、已结束和已完成边界', async () => {
  const m = await import(`${pathToFileURL(path.join(TOOLS, '排班判据.mjs')).href}?shift=${++serial}`)
  const shifts = [
    { id: 'night', 活: '便利店夜班', 点: '便利店', 起: '2026-11-10 22:00', 止: '2026-11-11 06:00', 状态: '待上' },
    { id: 'day', 活: '咖啡店', 点: '咖啡店', 起: '2026-11-11 09:00', 止: '2026-11-11 14:00', 状态: '待上' },
  ]
  assert.equal(m.该去的班([shifts[1]], Date.parse('2026-11-11T08:40:00+08:00'), 30)?.id, 'day')
  assert.equal(m.该去的班([shifts[1]], Date.parse('2026-11-11T09:10:00+08:00'), 30)?.id, 'day')
  assert.equal(m.该去的班([shifts[1]], Date.parse('2026-11-11T08:29:00+08:00'), 30), null)
  assert.equal(m.该去的班([shifts[0]], Date.parse('2026-11-11T05:50:00+08:00'), 30)?.id, 'night')
  assert.equal(m.该去的班([{ ...shifts[1], 状态: '完成' }], Date.parse('2026-11-11T08:40:00+08:00'), 30), null)
  assert.equal(m.该去的班([shifts[1]], Date.parse('2026-11-11T14:01:00+08:00'), 30), null)
  const onTheWay = Date.parse('2026-11-11T08:40:00+08:00')
  assert.equal(m.该赴的班([shifts[1]], { 位置: '家' }, onTheWay)?.去哪, '咖啡店')
  assert.equal(m.该赴的班([shifts[1]], { 位置: '咖啡店' }, onTheWay), null)
  assert.equal(m.该赴的班([shifts[1]], { 位置: '家', 在途: { arriveAt: onTheWay + 60000 } }, onTheWay), null)
  assert.equal(m.该赴的班([shifts[1]], { 位置: '家' }, Date.parse('2026-11-11T08:29:00+08:00')), null)
  const auto = readFileSync(path.join(TOOLS, '自主行动.mjs'), 'utf8')
  assert.match(auto, /共享该赴的班\(__工作档\.班次, assets/)
  assert.match(auto, /pick === '去上班'/)
  assert.match(auto, /走路\.mjs/)
})

test('排班生成：跨夜夜班后次日中午前休息且每日最多一个日间正班', async () => {
  const m = await import(`${pathToFileURL(path.join(TOOLS, '排班判据.mjs')).href}?generate=${++serial}`)
  const config = { 活: {
    '便利店夜班': { 周: [2], 起: '22:00', 止: '06:00', 点: '便利店', 时薪: 20 },
    '咖啡店': { 周: [3], 起: '09:00', 止: '14:00', 点: '咖啡店', 时薪: 18 },
    '家教': { 周: [3], 起: '16:00', 止: '18:00', 点: '图书馆', 时薪: 25 },
    '另一份早班': { 周: [3], 起: '10:00', 止: '12:00', 点: '便利店', 时薪: 15 },
  } }
  const prior = [{ 活: '便利店夜班', 起: '2026-11-10 22:00', 止: '2026-11-11 06:00', 状态: '缺勤' }]
  const nextDay = m.该有的班(config, '2026-11-11', 3, prior)
  assert.equal(nextDay.some((b) => b.活 === '咖啡店'), false)
  assert.equal(nextDay.some((b) => b.活 === '家教'), true)
  const completedNight = m.该有的班(config, '2026-11-11', 3, [{ ...prior[0], 状态: '完成' }])
  assert.equal(completedNight.some((b) => b.活 === '咖啡店'), false, '完成夜班后也要保留次日上午休息')
  assert.equal(nextDay.filter((b) => !['完成','缺勤','辞退'].includes(b.状态) && Number(b.起.slice(11,13)) < 22).length, 1)
  const sameDay = m.该有的班(config, '2026-11-11', 3, [])
  assert.equal(sameDay.filter((b) => Number(b.起.slice(11,13)) < 22).length, 1)
})

test('生理惦记：真实 helper 追加 done 且只顺嘴问带 who 的关系事项', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-pending-real-'))
  const file = path.join(root, '惦记.jsonl')
  const helper = await import(`${pathToFileURL(path.join(TOOLS, '惦记.mjs')).href}?t353=${++serial}`)
  try {
    writeFileSync(file, [
      JSON.stringify({ what: '该喝口水了', at: '2026-11-10 10:00' }),
      JSON.stringify({ what: '有点空了，找点吃的', at: '2026-11-10 10:01' }),
      JSON.stringify({ what: '问小鱼周末安排', who: 'u1', at: '2026-11-10 10:02' }),
      JSON.stringify({ what: '问同事进度', who: 'u2', at: '2026-11-10 10:03' }),
    ].join('\n') + '\n')
    assert.equal(helper.销账生理惦记(root, '该喝口水了', '2026-11-10 10:10'), true)
    assert.equal(helper.销账生理惦记(root, '有点空了，找点吃的', '2026-11-10 10:11'), true)
    assert.equal(helper.销账生理惦记(root, '关系事项', '2026-11-10 10:12'), false)
    const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)
    assert.equal(rows.length, 6)
    assert.equal(rows[4].what, '该喝口水了')
    assert.equal(rows[4].done, true)
    assert.equal(rows[5].what, '有点空了，找点吃的')
    assert.equal(rows[5].done, true)
    assert.equal(helper.销账生理惦记(root, '该喝口水了', '2026-11-10 10:13'), false)
    assert.deepEqual(rows.filter((x) => helper.可顺嘴问(x, 'u1')).map((x) => x.what), ['问小鱼周末安排'])
    assert.equal(helper.可记内心({ what: '该喝口水了', done: false }), false)
    assert.equal(helper.可记内心({ what: '问小鱼周末安排', who: 'u1', done: false }), true)
    const poll = readFileSync('/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js', 'utf8')
    const diary = readFileSync(path.join(TOOLS, '内心.mjs'), 'utf8')
    const gap = readFileSync(path.join(TOOLS, '缺口.mjs'), 'utf8')
    const baoke = readFileSync(path.join(TOOLS, '饱渴.mjs'), 'utf8')
    assert.match(poll, /可顺嘴问\(x, peerUin\)/)
    assert.match(diary, /可记内心\(x\)/)
    assert.match(gap, /写惦记\(MEM, 话, bj\(\)\)/)
    assert.match(baoke, /销账生理惦记\(MEM, '该喝口水了'/)
    assert.match(baoke, /销账生理惦记\(MEM, '有点空了，找点吃的'/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('工作：临时工重复开班分支不引用未定义活变量', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-work-temp-tdz-'))
  const mem = path.join(root, '记忆')
  const tools = path.join(root, '工具')
  mkdirSync(mem, { recursive: true })
  mkdirSync(tools, { recursive: true })
  writeFileSync(path.join(tools, '工作.json'), JSON.stringify({ 活: { 发传单: { 点: '打工点', 起: '13:00', 止: '15:00', 时薪: 20, 周: [] } }, 罚: {} }))
  writeFileSync(path.join(mem, '工作.json'), JSON.stringify({ 信用: 100, 班次: [{ 活: '发传单', 状态: '待上', 点: '打工点', 起: '2026-11-11 13:00', 止: '2026-11-11 15:00' }] }))
  writeFileSync(path.join(mem, '资产.json'), JSON.stringify({ 位置: '打工点', 钱: 100, 包: [], 家: [] }))
  const source = readFileSync(path.join(TOOLS, '工作.mjs'), 'utf8')
  const runner = path.join(root, '工作.mjs')
  writeFileSync(runner, source.replace(/from '\.\/([^']+)'/g, (_m, name) => `from '${path.join(TOOLS, name)}'`))
  try {
    const result = spawnSync(process.execPath, [runner, '--临时', '--活', '发传单'], {
      cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, WORK_MEM: mem, WORK_TOOLS: tools, NODE_OPTIONS: '' },
    })
    assert.equal(result.status, 0, result.stderr || result.stdout)
    assert.match(result.stdout, /还有一班发传单没结/)
    assert.doesNotMatch(result.stderr, /ReferenceError: 活着 is not defined/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('快状态：正文带短快照+完整慢变段，system 只留静态', async () => {
  const sourcePath = process.env.POLL_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
  const pollSource = readFileSync(sourcePath, 'utf8')
  const marker = 'export function stateFastHintOf() {'
  assert.equal(pollSource.split(marker).length - 1, 1)
  const poll = await import(`${pathToFileURL(sourcePath).href}?fast=${++serial}`)
  const full = String(poll.stateHintOf({}) || '')
  const fast = String(poll.stateFastHintOf({}) || '')
  assert.ok(full.length > 500, `full context remains rich (${full.length} chars)`)
  assert.ok(fast.length > 0 && fast.length <= 100, `fast state is 1-100 chars (got ${fast.length})`)
  assert.match(fast, /^（你现在的状态：此刻 \d{2}:\d{2}｜精\d+ 饱\d+ 渴\d+%｜人在.+·正在.+）$/)
  assert.doesNotMatch(fast, /上一件|记忆|好感|状态.json|工作.json/)
  const voicePath = process.env.STATE_VOICE_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/stateVoice.js'
  const voiceSource = readFileSync(voicePath, 'utf8')
  const voice = await import(`${pathToFileURL(voicePath).href}?fast=${++serial}`)
  const agent = {}
  const context = voice.buildVoiceText(agent, {
    stateHintOf: poll.stateHintOf,
    voiceHintOf: () => '',
    ownerUin: 'owner-test', // 批次484：补上才能验 FULL_ACCESS_LINE 真拼进 system（它本身是静态的）
    状态进正文: true,
  })
  voice.markVoiceTarget(agent, { peer: 'owner-test', isPrivate: true, lastText: '嗨', at: Date.now() })
  const injected = context()
  // CACHE_STATIC 2026-11-14（批次484）：完整状态**从 system 挪进了正文**，system 只留静态段 ——
  // 因为 system 在上下文最前面，它一变，后面 3~6 万 token 的 Prefix Cache 全部作废
  // （实测今天 3-6 万区间 845 次请求里 system 变了 214 次，那些次全额计费 652 万 token）。
  // 但「完整状态不能丢」这条**没有变**，所以契约改成钉两个方向，而不是放松：
  //   ① system 必须是静态的（不许含时钟/精力）
  //   ② 正文那一路真的会产出（抽真源码跑函数，不是「名字出现过」）
  assert.ok(full.length > 500, `full state is still rich (${full.length} chars)`)
  assert.ok(injected.length > 100, `system context keeps the static full-access line (${injected.length} chars)`)
  assert.match(injected, /完全权限/, 'FULL_ACCESS_LINE stays in the system context (it is static by design)')
  assert.equal(
    /现在北京时间/.test(injected) || /精力 \d+\/100/.test(injected),
    false,
    'system context must stay static — clock/energy live in the body now (批次484)'
  )
  assert.match(voiceSource, /const 跳过状态片 = !!\(deps && deps\.状态进正文 === true\)/,
    'stateVoice really honours the 状态进正文 switch (批次358 said it would, 批次301 lost it)')
  // 2026-11-25：慢变段/自动回忆条 已由 dsh-mnemonic 接手（记忆系统切换），旧断言退役。
  assert.match(voiceSource, /Math\.floor\(Date\.now\(\) \/ \(10 \* 60 \* 1000\)\)/, 'system state refresh is bucketed by ten minutes')
  assert.match(voiceSource, /状态片值 = String\(stateHintOf\(/, 'the full state result is cached inside the bucket')
  assert.match(pollSource, /try \{ 状态段 = stateFastHintOf\(\) \}/)
  assert.match(pollSource, /try \{ stateHint = stateFastHintOf\(\) \}/)
  const realNow = Date.now
  let now = Math.floor(realNow() / (10 * 60 * 1000)) * (10 * 60 * 1000) + 60 * 1000
  let calls = 0
  const seen = []
  Date.now = () => now
  try {
    const cachedAgent = {}
    const cachedContext = voice.buildVoiceText(cachedAgent, {
      stateHintOf: (opts) => { seen.push(opts); calls += 1; return `${opts.peerUin}:${opts.isPrivate ? 'private' : 'group'}:${calls}` },
      voiceHintOf: () => '',
      ownerUin: '',
    })
    voice.markVoiceTarget(cachedAgent, { peer: 'peer-test', isPrivate: true, lastText: '私聊原文', at: now })
    const first = cachedContext()
    assert.equal(first.includes('peer-test:private:1'), true)
    assert.deepEqual(seen[0], { text: '', history: [], peerUin: 'peer-test', isPrivate: true }, 'cache only the recipient-scoped stable state, never message/history cues')
    now += 5 * 60e3
    voice.markVoiceTarget(cachedAgent, { peer: 'peer-test', isPrivate: true, lastText: '新的私聊原文', at: now })
    assert.equal(cachedContext(), first, 'same ten-minute bucket reuses state for the same recipient')
    assert.equal(calls, 1, 'same bucket only builds state once for the same recipient')
    voice.markVoiceTarget(cachedAgent, { peer: 'group-test', isPrivate: false, lastText: '群聊原文', at: now })
    const group = cachedContext()
    assert.match(group, /group-test:group:2/, 'changing recipient recomputes recipient-specific state')
    assert.doesNotMatch(group, /peer-test:private:1/, 'private state is not reused for a group recipient')
    assert.deepEqual(seen[1], { text: '', history: [], peerUin: 'group-test', isPrivate: false })
    assert.equal(calls, 2)
    now += 6 * 60e3
    voice.markVoiceTarget(cachedAgent, { peer: 'group-test', isPrivate: false, at: now })
    const refreshed = cachedContext()
    assert.notEqual(refreshed, group, 'new bucket refreshes the full state')
    assert.equal(calls, 3, 'new bucket rebuilds the state for that recipient')
  } finally { Date.now = realNow }
})

test('自主行动C4：新鲜念头只给对应现有动作加权', async () => {
  const source = readFileSync(process.env.AUTONOMY_SOURCE || path.join(TOOLS, '自主行动.mjs'), 'utf8')
  const match = source.match(/export function 念头动作加权\([\s\S]*?\r?\n}\r?\n/)
  assert.ok(match, '自主行动应提供纯念头映射 helper')
  const pushBody = source.match(/function push\(state, weight\) \{[\s\S]*?\n\}/)?.[0] || ''
  assert.match(pushBody, /念头动作加权\(state, weight, __近期念头\)/, 'push只调整已有动作候选')
  assert.match(source, /readFileSync\(join\(base, '念头\.jsonl'\)/, '从记忆目录读取念头日志')
  assert.match(source, /split\('\\n'\)\.filter\(Boolean\)\.flatMap/, '解析有效JSONL并跳过坏行，不截断30分钟候选')
  const module = await import(`data:text/javascript;base64,${Buffer.from(match[0] + '\nexport const __end = 1').toString('base64')}`)
  const now = Date.parse('2026-11-11T10:00:00+08:00')
  const thought = (想到, ageMin = 10, 建议 = '') => ({ at: new Date(now - ageMin * 60e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T',' '), 想到, 建议 })
  assert.equal(module.念头动作加权('买东西', 10, [thought('花', 8)], now), 14)
  assert.equal(module.念头动作加权('走动', 10, [thought('去', 12)], now), 14)
  assert.equal(module.念头动作加权('吃点东西', 10, [thought('吃存货', 3)], now), 14)
  assert.equal(module.念头动作加权('买东西', 10, [thought('花', 31)], now), 10)
  assert.equal(module.念头动作加权('睡觉', 10, [thought('花', 2)], now), 10)
  assert.equal(module.念头动作加权('走动', 10, [thought('无关', 1)], now), 10)
  assert.equal(module.念头动作加权('买东西', 0, [thought('花')], now), 0)
  assert.equal(module.念头动作加权('买东西', 10, [], now), 10)
  assert.equal(module.念头动作加权('走动', 10, [thought('去', 30)], now), 14, '30分钟边界包含')
  assert.equal(module.念头动作加权('走动', 10, [thought('去', 30.01)], now), 10, '超过30分钟不加权')
  assert.equal(module.念头动作加权('走动', 10, [thought('去', -1)], now), 10, '未来时间不加权')
  assert.equal(module.念头动作加权('走动', 10, [thought('去', 2), thought('去', 1)], now), 14, '同类念头只加权一次')
  assert.equal(module.念头动作加权('走动', 10, [{ at: 'bad-time', 想到: '去' }], now), 10, '无效时间不加权')
  assert.equal(module.念头动作加权('走动', 10, [{ at: new Date(now - 5 * 60e3).toISOString(), 想到: '去' }], now), 14, 'ISO时间戳可读')
})

test('瞬间提示：唯一匹配条目更新lastSaid且锁冲突失败关闭', async () => {
  const source = readFileSync(process.env.POLL_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js', 'utf8')
  const match = source.match(/export function 更新已说瞬间\([\s\S]*?\n}\n/)
  assert.ok(match, 'poll 应提供锁内瞬间更新入口')
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-moment-write-'))
  const file = path.join(root, '瞬间.json')
  const lockDir = path.join(root, '.locks')
  mkdirSync(lockDir, { recursive: true })
  const oldLock = process.env.QQ_LOCK_DIR
  const oldWait = process.env.QQ_LEDGER_LOCK_WAIT_MS
  process.env.QQ_LOCK_DIR = lockDir
  process.env.QQ_LEDGER_LOCK_WAIT_MS = '0'
  const helpers = `import { readFileSync } from 'node:fs'; process.env.QQ_LOCK_DIR = '${lockDir}'; process.env.QQ_LEDGER_LOCK_WAIT_MS = '0'; import { 改档 as 改瞬间档 } from '${pathToFileURL(path.join(TOOLS, '_底层.mjs')).href}';\n`
  const module = await import(`data:text/javascript;base64,${Buffer.from(helpers + match[0] + '\nexport const __end = 1').toString('base64')}`)
  try {
    const now = Date.parse('2026-11-11T10:00:00+08:00')
    writeFileSync(file, JSON.stringify({ items: [{ what: '睁眼看到的第一个人', at: '2026-11-01', lastSaid: 0 }, { what: '另一个瞬间', at: '2026-11-02', lastSaid: 7 }] }))
    assert.equal(module.更新已说瞬间(file, { at: '2026-11-01', what: '睁眼看到的第一个人' }, now), true)
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.items[0].lastSaid, now)
    assert.equal(saved.items[1].lastSaid, 7)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).items[1].lastSaid, 7)
    // 批次427：同样的收敛，`${MEM}/瞬间.json`。锚点抽成一个变量，免得改一次忘一处。
    const 瞬间锚 = 'const moP = `${MEM}/瞬间.json`'
    const injection = source.slice(source.indexOf(瞬间锚), source.indexOf("} catch { /* 忽略 */ }", source.indexOf(瞬间锚)))
    // 665 起只递「哪天的什么」这个事实，不再拼「想起来一件事」这句第一人称成句。
    assert.match(injection, /parts\.push\('\[瞬间\] ' \+ __selectedMoment\.at/)
    assert.ok(!/想起来一件事：/.test(injection.replace(/\/\/.*$/gm, '')), '第一人称成句还在')
    assert.match(injection, /更新已说瞬间\(moP, __selectedMoment\)/)
    assert.match(injection, /__selectedMoment = \{ at: String\(it\.at \|\| ''\), what: String\(it\.what \|\| ''\) \}/)
    assert.match(source, /改瞬间档\(file, \(data\) => \{/)
    assert.match(source, /matches\[0\]\.lastSaid = now/)
  } finally {
    if (oldLock === undefined) delete process.env.QQ_LOCK_DIR; else process.env.QQ_LOCK_DIR = oldLock
    if (oldWait === undefined) delete process.env.QQ_LEDGER_LOCK_WAIT_MS; else process.env.QQ_LEDGER_LOCK_WAIT_MS = oldWait
    rmSync(root, { recursive: true, force: true })
  }
})

test('群聊摘要插件接线：实际 context 回调传入 ownerUin', () => {
  const source = readFileSync(process.env.INDEX_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/index.js', 'utf8')
  const start = source.indexOf('extraHintOf: (t) => extraSlotsHint(')
  assert.notEqual(start, -1)
  const end = source.indexOf('}),', start)
  assert.notEqual(end, -1)
  assert.equal(source.slice(start, end).includes('ownerUin: config.ownerUin'), true)
})

test('群聊摘要提示：仅新鲜三十分钟、私聊读取且最多三条', async () => {
  const source = readFileSync(process.env.VOICE_SLOTS_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/voiceSlots.js', 'utf8')
  assert.match(source, /export const VOICE_SLOTS = \[([\s\S]*?)slotGroupPeek,/)
  const match = source.match(/export function slotGroupPeek\([\s\S]*?\n}\n/)
  assert.ok(match, 'voiceSlots 应导出群聊摘要槽')
  const helpers = "import { readFileSync } from 'node:fs'; import { join } from 'node:path'; const 读档=(p)=>{try{return JSON.parse(readFileSync(p,'utf8'))}catch{return null}}; const 数=(x,d=0)=>Number.isFinite(Number(x))?Number(x):d; const 时刻毫秒=(s)=>{const m=/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):(\\d{2})/.exec(String(s??''));return m?Date.UTC(+m[1],+m[2]-1,+m[3],+m[4],+m[5])-8*3600e3:0};\n"
  const module = await import(`data:text/javascript;base64,${Buffer.from(helpers + match[0] + '\nexport const __end = 1').toString('base64')}`)
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-group-peek-'))
  try {
    mkdirSync(root, { recursive: true })
    const now = Date.parse('2026-11-11T10:00:00+08:00')
    const pathPlan = path.join(root, '刷到的.json')
    const item = (minute, who) => ({ 群: 'g1', 时: `2026-11-11 09:${String(minute).padStart(2,'0')}:00`, 谁: who, 号: String(minute), 话: `内容${minute}` })
    writeFileSync(pathPlan, JSON.stringify({ 看于: '2026-11-11 09:59', 条目: [item(29,'太旧'), item(35,'甲'), item(40,'乙'), item(45,'丙'), item(50,'丁')] }))
    const ctx = { isPrivate: true, mute: false, peer: 'owner', ownerUin: 'owner', memDir: root, now }
    const hint = module.slotGroupPeek(ctx)
    assert.match(hint, /乙/)
    assert.match(hint, /丙/)
    assert.match(hint, /丁/)
    assert.doesNotMatch(hint, /太旧|甲/)
    assert.equal(module.slotGroupPeek({ ...ctx, isPrivate: false }), '')
    assert.equal(module.slotGroupPeek({ ...ctx, mute: true }), '')
    assert.equal(module.slotGroupPeek({ ...ctx, peer: 'not-owner' }), '')
    writeFileSync(pathPlan, JSON.stringify({ 看于: '2026-11-11 09:20', 条目: [item(20,'过期')] }))
    assert.equal(module.slotGroupPeek(ctx), '')
    writeFileSync(pathPlan, JSON.stringify({ 看于: '2026-11-11 10:00', 条目: [] }))
    assert.equal(module.slotGroupPeek(ctx), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('穿衣C3：资产和穿着账双向同步且保留替换衣物', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-clothing-sync-'))
  const mem = path.join(root, '记忆')
  const locks = path.join(mem, '.locks')
  mkdirSync(mem, { recursive: true }); mkdirSync(locks, { recursive: true })
  const copy = (src, dst) => writeFileSync(dst, readFileSync(src))
  copy('/data/hajimi-workspace/记忆/衣物表.json', path.join(mem, '衣物表.json'))
  copy('/data/hajimi-workspace/共享/工具/服装表.json', path.join(mem, '服装表.json'))
  const featurePath = path.join(mem, '功能开关.json')
  writeFileSync(featurePath, JSON.stringify({ 家具: true }))
  const realFiles = ['/data/hajimi-workspace/记忆/资产.json', '/data/hajimi-workspace/记忆/穿着.json', '/data/hajimi-workspace/记忆/天气.json', '/data/hajimi-workspace/记忆/状态.json']
  const realBefore = realFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'))
  writeFileSync(path.join(mem, '资产.json'), JSON.stringify({ 位置: '家', 钱: 10, 衣柜: ['毛衣开衫'], 着装: { 上: '水手服', 下: '白裙子', 鞋: '小皮鞋', 饰: ['鲸鱼发卡'] } }))
  const code = `
    const TOOLS = ${JSON.stringify(TOOLS)}
    const locks = ${JSON.stringify(locks)}
    const featurePath = ${JSON.stringify(featurePath)}
    import { pathToFileURL } from 'node:url'
    import fs from 'node:fs'
    const cloth = await import(pathToFileURL('/data/hajimi-workspace/共享/工具/穿衣.mjs').href + '?c3-sync=' + Date.now())
    const mem = process.env.CLOTH_MEM
    const first = cloth.读穿着()
    if (!first.部位.上身.includes('水手服') || !first.部位.头.includes('鲸鱼发卡')) throw new Error('legacy outfit migration failed')
    const { spawnSync } = await import('node:child_process')
    const runAsset = (...args) => spawnSync(process.execPath, ['/data/hajimi-workspace/共享/工具/资产.mjs', ...args], {
      encoding: 'utf8', env: { ...process.env, QQ_AUTONOMY_MEM: mem, QQ_AUTONOMY_TOOLS: TOOLS,
        QQ_ASSET_FEATURES: featurePath, CLOTH_MEM: mem, CLOTH_ASSET_TABLE: path.join(mem, '服装表.json'),
        QQ_LOCK_DIR: locks, QQ_LEDGER_LOCK_WAIT_MS: '100' },
    })
    const cardigan = runAsset('--穿', '毛衣开衫')
    if (cardigan.status !== 0) throw new Error(cardigan.stdout + cardigan.stderr)
    let assets = JSON.parse(fs.readFileSync(mem + '/资产.json', 'utf8'))
    let wear = cloth.读穿着()
    if (assets.着装.上 !== '毛衣开衫' || !assets.衣柜.includes('水手服')) throw new Error('asset wear did not mirror or return old item to wardrobe')
    if (!wear.部位.上身.includes('毛衣开衫') || wear.部位.上身.includes('水手服')) throw new Error('manual category replacement must replace old mirror layer')
    cloth.穿('水手服')
    assets = JSON.parse(fs.readFileSync(mem + '/资产.json', 'utf8'))
    wear = cloth.读穿着()
    if (assets.着装.上 !== '水手服' || !wear.部位.上身.includes('毛衣开衫') || !wear.部位.上身.includes('水手服')) throw new Error('additive layering must preserve base and update latest mirror')
    cloth.脱('水手服')
    assets = JSON.parse(fs.readFileSync(mem + '/资产.json', 'utf8'))
    if (assets.着装.上 !== '毛衣开衫') throw new Error('removing outer layer did not restore remaining layer mirror')
    const shirt = runAsset('--穿', '水手服')
    if (shirt.status !== 0) throw new Error(shirt.stdout + shirt.stderr)
    const mirrored = cloth.读穿着()
    if (!mirrored.部位.上身.includes('水手服') || mirrored.部位.上身.includes('毛衣开衫')) throw new Error('asset category replacement was not synced back to wear ledger')
    const accessory = runAsset('--穿', '鲸鱼发卡')
    if (accessory.status !== 0) throw new Error(accessory.stdout + accessory.stderr)
    const removed = runAsset('--脱', '鲸鱼发卡')
    if (removed.status !== 0) throw new Error(removed.stdout + removed.stderr)
    assets = JSON.parse(fs.readFileSync(mem + '/资产.json', 'utf8'))
    wear = cloth.读穿着()
    if (assets.着装.饰.includes('鲸鱼发卡') || wear.部位.头.includes('鲸鱼发卡')) throw new Error('asset accessory removal was not synced to clothing ledger')
    console.log('clothing sync ok')
  `
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLOTH_MEM: mem, CLOTH_ASSET_TABLE: path.join(mem, '服装表.json'), QQ_ASSET_FEATURES: featurePath, QQ_AUTONOMY_MEM: mem, QQ_AUTONOMY_TOOLS: TOOLS, QQ_SLEEP_MEM: mem, QQ_LOCK_DIR: locks, QQ_LEDGER_LOCK_WAIT_MS: '100', QQ_LOCK_WAIT_MS: '100' } })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /clothing sync ok/)
    assert.deepEqual(realFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex')), realBefore, '真实资产/穿着/天气/状态前后指纹一致')
  } finally { rmSync(root, { recursive: true, force: true }) }
  const assetSource = readFileSync(path.join(TOOLS, '资产.mjs'), 'utf8')
  assert.match(assetSource, /import\(join\(process\.env\.QQ_WORK_TOOLS[\s\S]*?穿衣\.mjs/)
  assert.match(assetSource, /clothing\.穿\(wear\)/)
})

test('穿衣C3：醒来在家按冷天建议加衣，暖天与离家不动作', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-weather-clothes-'))
  const mem = path.join(root, '记忆')
  const locks = path.join(mem, '.locks')
  mkdirSync(mem, { recursive: true }); mkdirSync(locks, { recursive: true })
  const copy = (src, dst) => writeFileSync(dst, readFileSync(src))
  copy('/data/hajimi-workspace/记忆/衣物表.json', path.join(mem, '衣物表.json'))
  copy('/data/hajimi-workspace/共享/工具/服装表.json', path.join(mem, '服装表.json'))
  const featurePath = path.join(mem, '功能开关.json')
  writeFileSync(featurePath, JSON.stringify({ 家具: true }))
  const realFiles = ['/data/hajimi-workspace/记忆/资产.json', '/data/hajimi-workspace/记忆/穿着.json', '/data/hajimi-workspace/记忆/天气.json', '/data/hajimi-workspace/记忆/状态.json']
  const realBefore = realFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'))
  const blank = Object.fromEntries(['头','脖子','上臂','下臂','手','上身','下身','大腿','小腿','脚'].map((x) => [x, []]))
  writeFileSync(path.join(mem, '穿着.json'), JSON.stringify({ 部位: blank }))
  writeFileSync(path.join(mem, '资产.json'), JSON.stringify({ 位置: '家', 衣柜: ['毛衣开衫'], 着装: { 上: '', 下: '', 鞋: '', 饰: [] } }))
  writeFileSync(path.join(mem, '天气.json'), JSON.stringify({ 预报: [{ date: '2026-11-12', 最低: 0, 风: 0 }] }))
  const code = `
    const featurePath = ${JSON.stringify(featurePath)}
    import { pathToFileURL } from 'node:url'
    import fs from 'node:fs'
    const cloth = await import(pathToFileURL('/data/hajimi-workspace/共享/工具/穿衣.mjs').href + '?c3-weather=' + Date.now())
    const mem = process.env.CLOTH_MEM
    const now = Date.parse('2026-11-11T08:00:00+08:00')
    const advice = cloth.该穿(now)
    if (advice.明天最低 !== 0) throw new Error('weather advice did not read forecast[0].最低: ' + JSON.stringify(advice))
    if (!advice.挑.includes('毛衣开衫')) throw new Error('weather advice did not read 衣物表.json.件: ' + JSON.stringify(advice))
    const cold = cloth.自动按天气换衣(now)
    if (!String(cold).includes('毛衣开衫')) throw new Error('cold-at-home did not add warm layer: ' + cold)
    let wear = JSON.parse(fs.readFileSync(mem + '/穿着.json', 'utf8'))
    let assets = JSON.parse(fs.readFileSync(mem + '/资产.json', 'utf8'))
    if (!wear.部位.上身.includes('毛衣开衫') || assets.着装.上 !== '毛衣开衫') throw new Error('cold clothing state did not synchronize')
    cloth.读穿着() // complete first-read migration before taking the no-op baseline
    const before = fs.readFileSync(mem + '/穿着.json')
    fs.writeFileSync(mem + '/天气.json', JSON.stringify({ 预报: [{ date: '2026-11-12', 最低: 30, 风: 0 }] }))
    if (cloth.自动按天气换衣(Date.parse('2026-11-11T08:01:00+08:00')) !== '') throw new Error('warm weather should not auto-add clothing')
    assets.位置 = '街市'; fs.writeFileSync(mem + '/资产.json', JSON.stringify(assets))
    fs.writeFileSync(mem + '/天气.json', JSON.stringify({ 预报: [{ date: '2026-11-12', 最低: 0, 风: 0 }] }))
    if (cloth.自动按天气换衣(Date.parse('2026-11-11T08:02:00+08:00')) !== '') throw new Error('away-from-home should not auto-change clothing')
    if (!fs.readFileSync(mem + '/穿着.json').equals(before)) throw new Error('outdoor auto-change modified wear record')
    console.log('weather clothing ok')
  `
  try {
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { ...process.env, CLOTH_MEM: mem, CLOTH_ASSET_TABLE: path.join(mem, '服装表.json'), QQ_ASSET_FEATURES: featurePath, QQ_AUTONOMY_MEM: mem, QQ_AUTONOMY_TOOLS: TOOLS, QQ_SLEEP_MEM: mem, QQ_LOCK_DIR: locks, QQ_LEDGER_LOCK_WAIT_MS: '100', QQ_LOCK_WAIT_MS: '100' } })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /weather clothing ok/)
    assert.deepEqual(realFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex')), realBefore, '真实资产/穿着/天气/状态前后指纹一致')
  } finally { rmSync(root, { recursive: true, force: true }) }
  const clothSource = readFileSync(path.join(TOOLS, '穿衣.mjs'), 'utf8')
  const routine = readFileSync(path.join(TOOLS, '作息.mjs'), 'utf8')
  assert.match(clothSource, /export function 自动按天气换衣/)
  assert.match(routine, /clothing\.自动按天气换衣\(now\)/)
  const wake = routine.slice(routine.indexOf("if (args.includes('--醒了'))"), routine.indexOf("console.log('用法：--想睡"))
  assert.match(wake, /const toolsDir = base\.replace\(/)
  assert.match(wake, /const clothing = await import\(pathToFileURL\(join\(toolsDir, '穿衣\.mjs'\)\)/)
  assert.match(wake, /自动按天气换衣\(now\)/)
})

test('穿衣C3：作息醒来入口在家实际触发自动加衣', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-wake-clothing-'))
  const mem = path.join(root, '记忆')
  const tools = path.join(root, '共享', '工具')
  const locks = path.join(mem, '.locks')
  mkdirSync(mem, { recursive: true }); mkdirSync(locks, { recursive: true }); mkdirSync(tools, { recursive: true })
  const copy = (src, dst) => writeFileSync(dst, readFileSync(src))
  for (const name of ['衣物表.json']) copy('/data/hajimi-workspace/记忆/' + name, path.join(mem, name))
  for (const name of ['穿衣.mjs', '_底层.mjs', '_锁.mjs']) copy(path.join(TOOLS, name), path.join(tools, name))
  copy('/data/hajimi-workspace/共享/工具/服装表.json', path.join(tools, '服装表.json'))
  writeFileSync(path.join(tools, '计划.mjs'), 'console.log("plan stub")')
  writeFileSync(path.join(tools, '早间简报.mjs'), 'console.log("brief stub")')
  writeFileSync(path.join(mem, '资产.json'), JSON.stringify({ 位置: '家', 衣柜: ['毛衣开衫'], 着装: { 上: '', 下: '', 鞋: '', 饰: [] } }))
  writeFileSync(path.join(mem, '穿着.json'), JSON.stringify({ 部位: Object.fromEntries(['头','脖子','上臂','下臂','手','上身','下身','大腿','小腿','脚'].map((x) => [x, []])) }))
  writeFileSync(path.join(mem, '天气.json'), JSON.stringify({ 温度: 12, 预报: [{ date: '2026-11-12', 最低: 0, 风: 0 }] }))
  writeFileSync(path.join(mem, '状态.json'), JSON.stringify({ energy: 40, layers: { physical: 40, emotional: 40, cognitive: 40 } }))
  writeFileSync(path.join(mem, '睡眠.json'), JSON.stringify({ sleeping: true, segments: [{ start: new Date(Date.now() - 2 * 3600e3 + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '), end: null }] }))
  writeFileSync(path.join(mem, '睡醒.json'), JSON.stringify({ sleeping: true }))
  const realFiles = ['/data/hajimi-workspace/记忆/资产.json', '/data/hajimi-workspace/记忆/穿着.json', '/data/hajimi-workspace/记忆/天气.json', '/data/hajimi-workspace/记忆/状态.json']
  const realBefore = realFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex'))
  try {
    const run = spawnSync(process.execPath, [path.join(TOOLS, '作息.mjs'), '--醒了'], {
      encoding: 'utf8', env: { ...process.env, QQ_SLEEP_MEM: mem, CLOTH_MEM: mem, QQ_AUTONOMY_MEM: mem,
        CLOTH_ASSET_TABLE: path.join(tools, '服装表.json'), QQ_LOCK_DIR: locks, QQ_LEDGER_LOCK_WAIT_MS: '100', QQ_SETTLED: '1' },
    })
    assert.equal(run.status, 0, run.stdout + run.stderr)
    assert.match(run.stdout, /醒来加衣：毛衣开衫/)
    assert.ok(JSON.parse(readFileSync(path.join(mem, '穿着.json'), 'utf8')).部位.上身.includes('毛衣开衫'))
    assert.equal(JSON.parse(readFileSync(path.join(mem, '资产.json'), 'utf8')).着装.上, '毛衣开衫')
    assert.deepEqual(realFiles.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex')), realBefore, '真实资产/穿着/天气/状态前后指纹一致')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('穿衣C3：偏冷体感提示穿着账中露着的部位', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-cold-clothing-slot-'))
  const lib = process.env.TOOL_LIB || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  try {
    writeFileSync(path.join(root, '体温.json'), JSON.stringify({ 体温: 12.4, 上次档: '有点冷' }))
    writeFileSync(path.join(root, '穿着.json'), JSON.stringify({ 部位: { 头: ['贝雷帽'], 上身: ['水手服'], 手: [], 脖子: [] } }))
    const voiceSlots = await import(pathToFileURL(path.join(lib, 'voiceSlots.js')).href + `?c3-cold=${++serial}`)
    const ctx = { memDir: root }
    const hint = voiceSlots.slotBodyTemp(ctx)
    assert.match(hint, /有点冷/)
    assert.match(hint, /12\.4°C/)
    assert.match(hint, /露着：手、脖子/)
    writeFileSync(path.join(root, '体温.json'), JSON.stringify({ 体温: 37, 上次档: '刚好' }))
    assert.equal(voiceSlots.slotBodyTemp(ctx), '', '体感刚好时不注入露着部位')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D1：群聊记忆只引用主人卡中明确带群语境的关系事实', { skip: '2026-11-19 起群聊只读本群卡，ownerKey 分享路径已移除' }, async () => {
  const lib = process.env.TOOL_LIB || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const memory = await import(pathToFileURL(path.join(lib, 'memory.js')).href + `?d1=${++serial}`)
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-d1-memory-'))
  const file = path.join(root, 'memory.json')
  const owner = 'private:3439411062'
  const group = 'group:2000000001'
  memory.useMemoryFile(file)
  try {
    memory.remember(owner, { nick: '私聊名', fact: '群里叫老鼠的人指群友菓子，是纳兹琳厨' })
    memory.remember(owner, { fact: '群友们都是他朋友，可以损两句' })
    memory.remember(owner, { fact: '他不喜欢吃香菜' })
    memory.remember(owner, { fact: '他刚发了工资，准备买新电脑' })
    memory.remember(owner, { fact: '群里的朋友知道他工资和住址' })
    memory.remember(owner, { fact: '群友都是朋友，其中有人在抑郁治疗' })
    memory.remember(group, { nick: '测试群', fact: '这个群常聊旧游戏' })
    memory.remember(group, { fact: '群里喜欢看猫图' })
    memory.remember(group, { fact: '群里周五有人开活动' })
    memory.remember(group, { fact: '本群常发二创' })
    memory.remember(group, { fact: '大家熟悉置顶公告' })
    const privateHint = memory.describeMemory(owner)
    assert.match(privateHint, /私聊名/)
    assert.match(privateHint, /香菜/)
    const groupHint = memory.describeMemory(group, { ownerKey: owner })
    const deliverSource = readFileSync(path.join(lib, 'deliver.js'), 'utf8')
    assert.match(deliverSource, /describeMemory\(quietKey, \{ ownerKey \}\)/, '投递入口必须传入配置的主人私聊键')
    assert.match(groupHint, /老鼠/)
    assert.match(groupHint, /群友们/)
    assert.doesNotMatch(groupHint, /私聊名|香菜|工资|电脑|住址|抑郁|治疗/)
    assert.match(groupHint, /旧游戏|猫图|开活动|二创|置顶公告/)
    assert.ok((groupHint.match(/；/g) || []).length <= 4, '包含称呼时不得超过四条关系事实')
    assert.doesNotMatch(memory.describeMemory('group:999', { ownerKey: owner }), /老鼠|群友们/)
    assert.doesNotMatch(memory.describeMemory('private:999', { ownerKey: owner }), /老鼠|群友们/)
  } finally {
    memory.flushMemoryPersist()
    memory.clearMemory()
    memory.useMemoryFile('')
    rmSync(root, { recursive: true, force: true })
  }
})

test('D2：近期截图提示仅给主人私聊且严格早于3分钟', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-screen-peek-'))
  const lib = process.env.TOOL_LIB || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const source = readFileSync(path.join(lib, 'voiceSlots.js'), 'utf8')
  const indexSource = readFileSync(path.join(lib, 'index.js'), 'utf8')
  assert.match(source, /  slotScreenPeek,\n/, '新截图槽必须注册进 VOICE_SLOTS')
  assert.match(indexSource, /extraSlotsHint\(\{ peer: t\.peer, ownerUin: config\.ownerUin, isPrivate: t\.isPrivate/, '插件注入点须提供主人身份')
  const match = source.match(/export function slotScreenPeek\(ctx\) \{[\s\S]*?\n\}/)
  assert.ok(match, '体感槽须导出可单测的 slotScreenPeek')
  try {
    const numberSource = source.split('\n').find((line) => line.startsWith('const 数 =')) || ''
    assert.notEqual(numberSource, '', 'slotScreenPeek 使用的数字判据需被共同测试')
    const module = await import(`data:text/javascript;base64,${Buffer.from(numberSource + '\n' + match[0] + '\nexport const __end = 1').toString('base64')}`)
    assert.match(source, /ownerUin: String\(c\.ownerUin \?\? ''\)/, 'extraSlotsHint 必须传递 ownerUin')
    const file = path.join(root, 'latest.png')
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const now = Date.now()
    const young = new Date(now - 179999)
    const exact = new Date(now - 180000)
    const old = new Date(now - 180001)
    const statSync = (p) => { if (!existsSync(p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { mtimeMs: young.getTime() } }
    const ctx = { peer: 'owner', ownerUin: 'owner', isPrivate: true, mute: false, now, screenPath: file, statSync }
    const hint = module.slotScreenPeek(ctx)
    assert.match(hint, /屏幕/)
    assert.match(hint, /qq_screen/)
    assert.equal(module.slotScreenPeek({ ...ctx, statSync: () => ({ mtimeMs: exact.getTime() }) }), '', '恰好3分钟不算新鲜')
    assert.equal(module.slotScreenPeek({ ...ctx, statSync: () => ({ mtimeMs: old.getTime() }) }), '', '超过3分钟不提示')
    assert.equal(module.slotScreenPeek({ ...ctx, screenPath: path.join(root, 'missing.png') }), '', '截图文件不存在时不提示')
    assert.equal(module.slotScreenPeek({ ...ctx, isPrivate: false }), '', '群聊不注入')
    assert.equal(module.slotScreenPeek({ ...ctx, peer: 'other' }), '', '非主人私聊不注入')
    assert.equal(module.slotScreenPeek({ ...ctx, mute: true }), '', '静音上下文不注入')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D3：近期视频理解摘要仅给主人私聊，且截断并标明素材', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-recent-watch-'))
  const lib = process.env.TOOL_LIB || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const source = readFileSync(path.join(lib, 'voiceSlots.js'), 'utf8')
  const indexSource = readFileSync(path.join(lib, 'index.js'), 'utf8')
  assert.match(source, /  slotJustWatched,\n/, 'D3 槽必须进入 VOICE_SLOTS')
  assert.match(indexSource, /extraSlotsHint\(\{ peer: t\.peer, ownerUin: config\.ownerUin, isPrivate: t\.isPrivate/, '插件注入点传递主人身份')
  const fnStart = source.indexOf('export function slotJustWatched(ctx) {')
  const fnEnd = source.indexOf('\n/** 槽：主人电脑近期截图提示', fnStart)
  const match = { 0: source.slice(fnStart, fnEnd), length: 1 }
  assert.ok(fnStart >= 0 && fnEnd > fnStart, '应有 slotJustWatched 定义及结束边界')
  assert.ok(match, '应有 slotJustWatched 纯提示槽')
  try {
    const fs = await import('node:fs')
    const pathApi = await import('node:path')
    const dateParserSource = source.slice(source.indexOf('export function 时刻毫秒(s) {'), source.indexOf('\n}', source.indexOf('export function 时刻毫秒(s) {')) + 2)
    const numberSource = source.split('\n').find((line) => line.startsWith('const 数 =')) || ''
    const dependencies = "const join = path.join; const readdirSync = fs.readdirSync; const readFileSync = fs.readFileSync;\n"
    const module = await import(`data:text/javascript;base64,${Buffer.from("import * as fs from 'node:fs'; import * as path from 'node:path';\n" + dependencies + numberSource + '\n' + dateParserSource + '\n' + match[0] + '\nexport const __end = 1').toString('base64')}`)
    const videos = path.join(root, '视频画面')
    mkdirSync(videos, { recursive: true })
    const now = Date.now()
    const write = (name, at, text) => writeFileSync(path.join(videos, name + '.omni.json'), JSON.stringify({ at, text }))
    write('BVfresh', new Date(now - 45 * 60e3).toISOString(), '该视频包含以下可确认的信息：\n\n**画面内容：**\n* 面包房传送带上连续运送面包。补充细节')
    write('BVold', new Date(now - 121 * 60e3).toISOString(), '旧素材不应出现')
    write('BVbad', 'bad-time', '无效时间不应出现')
    const ctx = { memDir: root, videoDir: videos, peer: 'owner', ownerUin: 'owner', isPrivate: true, mute: false, now }
    const hint = module.slotJustWatched(ctx)
    assert.match(hint, /\[刚刷到\]/)
    assert.match(hint, /BVfresh/)
    assert.match(hint, /是素材|素材/)
    assert.ok(hint.length < 300, '单条摘要应有限长')
    assert.doesNotMatch(hint, /旧素材|无效时间|BVold|BVbad/)
    assert.equal(module.slotJustWatched({ ...ctx, isPrivate: false }), '', '群聊不注入')
    assert.equal(module.slotJustWatched({ ...ctx, peer: 'other' }), '', '非主人私聊不注入')
    assert.equal(module.slotJustWatched({ ...ctx, mute: true }), '', 'mute 不注入')
    assert.equal(module.slotJustWatched({ ...ctx, memDir: path.join(root, 'missing'), videoDir: path.join(root, 'missing', '视频画面') }), '', '无缓存时不注入')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D4：主人玩心提示展示真实收藏候选，提示不代发', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-face-cue-'))
  const lib = process.env.TOOL_LIB || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  try {
    writeFileSync(path.join(root, '状态.json'), JSON.stringify({ energy: 80, 困意: 0, layers: { emotional: 90 } }))
    const source = readFileSync(path.join(lib, 'voiceSlots.js'), 'utf8')
    const playStart = source.indexOf('export function slotPlayfulness(ctx) {')
    const playEnd = source.indexOf('\n/**', playStart)
    const playSource = source.slice(playStart, playEnd)
    const poolStart = source.indexOf('const 玩心池 = {')
    const poolEnd = source.indexOf('\n}', poolStart) + 2
    const poolSource = source.slice(poolStart, poolEnd)
    const cacheStart = source.indexOf('const FACE_CACHE_MS =')
    const helperStart = source.indexOf('function 收藏表情候选(ctx) {')
    const refreshStart = source.indexOf('function 更新收藏候选(ctx) {')
    const refreshEnd = source.indexOf('\nfunction 收藏表情候选', refreshStart)
    const helperEnd = source.indexOf('\nexport function slotPlayfulness', helperStart)
    const cacheSource = source.slice(cacheStart, helperEnd)
    assert.ok(cacheSource.includes('FACE_CACHE_MS') && cacheSource.includes('listCustomFaces'))
    const numberSource = source.split('\n').find((line) => line.startsWith('const 数 =')) || ''
    const readSource = source.slice(source.indexOf('export function 读档(p) {'), source.indexOf('\nconst 数 =', source.indexOf('export function 读档(p) {')))
    const moduleFile = path.join(root, 'playfulness.mjs')
    const code = "import { existsSync, readFileSync } from 'node:fs'; import { join } from 'node:path';\n"
      + readSource + numberSource + '\n' + poolSource + '\n' + cacheSource + '\n' + playSource + '\nexport const slotPlayfulnessTest = slotPlayfulness;\n'
    writeFileSync(moduleFile, code)
    const voice = await import(pathToFileURL(moduleFile).href + `?d4=${++serial}`)
    const listCalls = []
    const ctx = { memDir: root, peer: 'owner', ownerUin: 'owner', isPrivate: true, mute: false, now: Date.now(),
      listCustomFaces: async (limit) => { listCalls.push(limit); return [{ summary: '收藏猫图' }, { desc: '收藏鲸鱼' }, { summary: '候选3' }, { summary: '候选4' }] } }
    const group = voice.slotPlayfulnessTest({ ...ctx, isPrivate: false })
    // 2026-11-14（批次444）文案改了：名字并进了主句的括号里，不再单起一行「收藏表情名册候选」
    assert.doesNotMatch(group, /手边这几个收藏表情包/)
    assert.equal(listCalls.length, 0, '群聊不能触发主人收藏查询')
    const other = voice.slotPlayfulnessTest({ ...ctx, peer: 'other' })
    assert.doesNotMatch(other, /手边这几个收藏表情包/)
    assert.equal(listCalls.length, 0, '其他私聊不能触发主人收藏查询')
    const firstHint = voice.slotPlayfulnessTest(ctx)
    assert.doesNotMatch(firstHint, /手边这几个收藏表情包/, '首次异步刷新不阻塞当前context')
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(listCalls.length, 1); assert.equal(listCalls[0], 100)
    const hint = voice.slotPlayfulnessTest(ctx)
    assert.match(hint, /手边这几个收藏表情包/)
    assert.match(hint, /收藏猫图|收藏鲸鱼|候选3|候选4/)
    // 最多三个：名字之间是「、」，数顿号就知道推了几个
    const 推的 = (hint.match(/收藏猫图|收藏鲸鱼|候选\d/g) || []).length
    assert.ok(推的 <= 3, '最多提示三个，实际 ' + 推的)
    assert.match(hint, /是否发送由你决定/)
    const failFile = path.join(root, 'playfulness-fail.mjs')
    writeFileSync(failFile, code)
    const failVoice = await import(pathToFileURL(failFile).href + `?d4-fail=${++serial}`)
    const failCtx = { ...ctx, listCustomFaces: async () => { throw new Error('unavailable') } }
    const failedHint = failVoice.slotPlayfulnessTest(failCtx)
    assert.doesNotMatch(failedHint, /手边这几个收藏表情包/)
    await new Promise((resolve) => setImmediate(resolve))
    assert.doesNotMatch(failVoice.slotPlayfulnessTest(failCtx), /手边这几个收藏表情包/)
    const indexSource = readFileSync(path.join(lib, 'index.js'), 'utf8')
    assert.match(indexSource, /extraHintOf: \(t\) => extraSlotsHint/)
    assert.doesNotMatch(indexSource, /extraHintOf: async/)
    assert.match(source, /  slotPlayfulness,\n/, '玩心槽仍注册在同步汇总器中')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D8：群聊冷热提示基于最近三条活动，不改变应答判据', async () => {
  const pollPath = process.env.POLL_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/poll.js'
  const source = readFileSync(pollPath, 'utf8')
  const marker = 'export function 群聊冷热提示(history, current, selfUin) {'
  assert.ok(source.includes(marker), 'poll 应导出纯群聊节奏提示判据')
  const start = source.indexOf(marker)
  const end = source.indexOf('\n}', start) + 2
  const fn = source.slice(start, end)
  const onebotPath = process.env.ONEBOT_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/onebot.js'
  const onebot = readFileSync(onebotPath, 'utf8')
  const timeStart = onebot.indexOf('export function timeOf(message) {')
  const timeEnd = onebot.indexOf('\n}', timeStart) + 2
  const timeFn = onebot.slice(timeStart, timeEnd)
  const module = await import(`data:text/javascript;base64,${Buffer.from(timeFn + '\n' + fn + '\nexport const __end = 1').toString('base64')}`)
  const self = '9000'
  const msg = (seconds, user) => ({ time: seconds, sender: { user_id: user } })
  const current = msg(1_000_000, '1001')
  assert.match(module.群聊冷热提示([msg(999_941, '1001'), msg(999_970, '1002'), current], current, self), /群里正火热刷屏/)
  assert.equal(module.群聊冷热提示([msg(999_940, '1001'), msg(999_970, '1002'), current], current, self), '', '正好60秒不算刷屏')
  assert.equal(module.群聊冷热提示([msg(892_000, '1001'), msg(999_970, '1002'), current], current, self), '', '最近一条不冷清时不提示')
  assert.match(module.群聊冷热提示([msg(989_199, '1001'), current], current, self), /群里冷清好几个钟头了/)
  assert.equal(module.群聊冷热提示([msg(989_199, self), current], current, self), '', '过滤机器人自己的历史消息后没有冷场依据')
  assert.equal(module.群聊冷热提示([msg(999_970, '1002'), current], current, self), '', '消息不足三条不提示刷屏')
  assert.equal(module.群聊冷热提示([msg(989_200, '1001'), current], current, self), '', '正好3小时不算沉寂超过阈值')
  assert.equal(module.群聊冷热提示([msg(999_000, '1001'), current], current, self), '', '最近一条不足3小时不算沉寂')
  assert.equal(module.群聊冷热提示([msg(1_000_001, '1001'), msg(999_970, '1002'), current], current, self), '', '未来时间不计入历史节奏')
  assert.equal(module.群聊冷热提示([msg(0, '1001'), msg(0, '1002'), { sender: { user_id: '1003' } }], { sender: { user_id: '1003' } }, self), '', '缺失时间不推断节奏')
  assert.doesNotMatch(fn, /shouldYieldToSibling|groupNeedsReply|qq_send|sendMsg/, '判据只产提示，不改应答与发送行为')
  assert.match(source, /const __groupCadenceHint = 群聊冷热提示\(history, message, config\.selfUin\)/, '实际群聊正文接入节奏提示')
  assert.match(source, /if \(__groupCadenceHint\) body = __groupCadenceHint \+ '\\n' \+ body/, '只在群聊正文头部加提示')
})

test('计划：识别真实饭食购买且排除无关账目', async () => {
  const source = readFileSync(process.env.PLAN_SOURCE || path.join(TOOLS, '计划.mjs'), 'utf8')
  const match = source.match(/export function 是正经饭购买\([\s\S]*?\n}\n/)
  assert.ok(match, '计划脚本应导出纯判据，供脚本和回归共同使用')
  const module = await import(`data:text/javascript;base64,${Buffer.from(match[0] + '\nexport const __end = 1').toString('base64')}`)
  const at = '2026-11-11 09:00'
  const row = (what) => ({ at, what })
  assert.equal(module.是正经饭购买(row('买了 拉面，花 20 块'), at.slice(0, 10)), true)
  assert.equal(module.是正经饭购买(row('点了外卖 汉堡，花 25 块'), at.slice(0, 10)), true)
  assert.equal(module.是正经饭购买(row('跑腿买了 烤肉饭，花 32 块'), at.slice(0, 10)), true)
  assert.equal(module.是正经饭购买(row('买了 雨伞，花 25 块'), at.slice(0, 10)), false)
  assert.equal(module.是正经饭购买(row('点了外卖 饮料，花 8 块'), at.slice(0, 10)), false)
  assert.equal(module.是正经饭购买(row('买了 火锅，花 80 块'), '2026-11-10'), false)
})

test('计划：今日未完成吃饭目标提高对应自主行动权重', async () => {
  const source = readFileSync(process.env.AUTONOMY_SOURCE || path.join(TOOLS, '自主行动.mjs'), 'utf8')
  const match = source.match(/export function 计划动作加权\([\s\S]*?\r?\n}\r?\n/)
  assert.ok(match, '自主行动应导出纯计划权重函数')
  const module = await import(`data:text/javascript;base64,${Buffer.from(match[0] + '\nexport const __end = 1').toString('base64')}`)
  const day = { goals: [{ id: '好好吃一顿' }], done: [] }
  assert.equal(module.计划动作加权('吃点东西', 10, day), 14)
  assert.equal(module.计划动作加权('走动', 10, day), 10)
  assert.equal(module.计划动作加权('吃点东西', 10, { ...day, done: ['好好吃一顿'] }), 10)
  assert.equal(module.计划动作加权('吃点东西', 10, { goals: [], done: [] }), 10)
  assert.equal(module.计划动作加权('吃点东西', 0, day), 0)
})

test('计划提示槽：私聊注入今天小目标与完成进度，群聊不展示', async () => {
  const source = readFileSync(process.env.VOICE_SLOTS_SOURCE || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib/voiceSlots.js', 'utf8')
  assert.match(source, /export const VOICE_SLOTS = \[([\s\S]*?)slotDailyPlan,/)
  const match = source.match(/export function slotDailyPlan\([\s\S]*?\n}\n/)
  assert.ok(match, 'voiceSlots 应导出今日计划提示槽')
  const helpers = "import { readFileSync } from 'node:fs'; import { join } from 'node:path'; const 数=(x,d=0)=>Number.isFinite(Number(x))?Number(x):d; const 今天北京=(now)=>new Date(Number(now)+8*3600e3).toISOString().slice(0,10); const 读档=(p)=>{try{return JSON.parse(readFileSync(p,'utf8'))}catch{return null}};\n"
  const module = await import(`data:text/javascript;base64,${Buffer.from(helpers + match[0] + '\nexport const __end = 1').toString('base64')}`)
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-daily-plan-'))
  try {
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, '计划.json'), JSON.stringify({ days: { '2026-11-11': { goals: [{ id: '好好吃一顿' }, { id: '看点书' }], done: ['看点书'] } } }))
    const ctx = { isPrivate: true, mute: false, peer: 'owner', memDir: root, now: Date.parse('2026-11-11T04:00:00Z') }
    const hint = module.slotDailyPlan(ctx)
    assert.match(hint, /好好吃一顿/)
    assert.match(hint, /1\/2|已完成 1 项|完成 1 项/)
    assert.equal(module.slotDailyPlan({ ...ctx, isPrivate: false }), '')
    assert.equal(module.slotDailyPlan({ ...ctx, mute: true }), '')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('自主行动：学习笔记读取记忆目录', () => {
  const source = readFileSync(process.env.AUTONOMY_SOURCE || path.join(TOOLS, '自主行动.mjs'), 'utf8')
  assert.ok((source.match(/join\(base, '学习笔记\.md'\)/g) || []).length >= 1)
  assert.doesNotMatch(source, /\/data\/bot-workspace\/学习笔记\.md/)
})

test('黑话候选：忽略@提及和纯数字但保留汉字梗', async () => {
  const source = readFileSync(process.env.SLANG_SOURCE || path.join(TOOLS, '黑话.mjs'), 'utf8')
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
  const msgs = [
    { user_id: 'u1', nickname: '测试A', text: '@1942 哈基米' },
    { user_id: 'u1', nickname: '测试A', text: '@1942 哈基米' },
    { user_id: 'u2', nickname: '测试B', text: '@1942 哈基米' },
  ]
  const picked = module.挑候选(msgs, { 频次门槛: 2, 最多: 20 })
  assert.equal(picked.some((x) => x.词 === '1942'), false)
  assert.equal(picked.some((x) => x.词 === '哈基米'), true)
  const numbers = [1, 2, 3].map((_, i) => ({ user_id: 'n' + i, nickname: '数字' + i, text: '1942' }))
  assert.deepEqual(module.挑候选(numbers, { 频次门槛: 2, 最多: 20 }), [])
})

test('判断权体检：只把传给激素脚本的事件名与激素事件表比对', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 't353-judge-event-scope-'))
  const lib = path.join(root, 'lib')
  const tools = path.join(root, '工具')
  mkdirSync(lib, { recursive: true })
  mkdirSync(tools, { recursive: true })
  const source = readFileSync(process.env.JUDGEMENT_SOURCE || path.join(TOOLS, '体检-判断权.mjs'), 'utf8')
  const libAnchor = "const LIB = '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'"
  const toolsAnchor = "const TOOLS = '/data/hajimi-workspace/共享/工具'"
  assert.equal(source.split(libAnchor).length - 1, 1)
  assert.equal(source.split(toolsAnchor).length - 1, 1)
  const runnerSource = source.replace(libAnchor, `const LIB = '${lib}'`).replace(toolsAnchor, `const TOOLS = '${tools}'`)
  const runner = path.join(root, '体检-判断权.mjs')
  writeFileSync(runner, runnerSource)
  // TODO_DEP 2026-11-14（批次413）：批次409 给三个体检加了 `import * as 待办 from './待办.mjs'`，
  // 而这条测试只把 体检-判断权.mjs 一个文件拷进临时目录 —— 于是 ERR_MODULE_NOT_FOUND，
  // 整条红了两天没人发现（它测的是「事件名比对」，跟待办无关）。
  // 放个空壳：这条测试不该往临时目录写待办，也不该去读真的 共享/待办.json。
  writeFileSync(path.join(root, '待办.mjs'), 'export function 同步() {}\nexport function 读() { return { items: [], done: [] } }\n')
  writeFileSync(path.join(lib, 'poll.js'), 'export const ok = true\n')
  writeFileSync(path.join(lib, '贴表情.mjs'), 'export const ok = true\n')
  writeFileSync(path.join(tools, '激素.mjs'), 'const EVENT = {\n  合法: {},\n}\n')
  writeFileSync(path.join(tools, '感受.mjs'), "const FAV = '/tmp/好感度.mjs'\nexecFileSync('node', [FAV, '--event', '自评'])\nexecFileSync('node', ['/tmp/激素.mjs', '--event', '合法'])\n")
  writeFileSync(path.join(tools, '好感度-日结.mjs'), "execFileSync('node', ['好感度.mjs', '--event', '日结'])\n")
  const run = () => spawnSync(process.execPath, [runner, '--strict'], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } })
  try {
    const valid = run()
    assert.equal(valid.status, 0, valid.stdout + valid.stderr)
    assert.doesNotMatch(valid.stdout, /感受\.mjs → 自评|好感度-日结\.mjs → 日结/)
    writeFileSync(path.join(tools, '错误调用.mjs'), "const TOOL = '/tmp/激素.mjs'\nexecFileSync('node', [TOOL, '--event', '其他未知'])\n")
    const invalid = run()
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr)
    assert.match(invalid.stdout, /错误调用\.mjs → 其他未知/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('自主行动：购买与进食结果决定状态和短重试', async () => {
  const rules = await import(`${pathToFileURL(path.join(TOOLS, '自主判据.mjs')).href}?t353=${++serial}`)
  assert.equal(rules.purchaseSucceeded('钱不够，额度也不够'), false)
  assert.equal(rules.purchaseSucceeded('还在吃，这单先不点'), false)
  assert.equal(rules.purchaseSucceeded('买了 糖，花 6 块，剩 20'), true)
  assert.equal(rules.purchaseSucceeded('[2026-11-10 23:00:01 花钱.mjs] 点了外卖 早饭，花 12 块，剩 8（还没吃）'), true)
  assert.equal(rules.consumptionSucceeded('手上没有「糖」'), false)
  assert.equal(rules.consumptionSucceeded('「牛奶」在家里，你人在街市，吃不上'), false)
  assert.equal(rules.consumptionSucceeded('坐下来吃糖，大概 8 分钟'), true)
  assert.equal(rules.consumptionSucceeded('喝不上：杯子是空的'), false)
  assert.equal(rules.consumptionSucceeded('喝咖啡，大概 3 分钟'), true)
  const now = Date.parse('2026-11-10T15:20:00Z')
  const requestedAt = now - 1000
  const meal = { 开始: '2026-11-10 23:19', 到: '2026-11-10 23:30', 吃啥: '火锅', 激素事件ID: 'event-7' }
  assert.equal(rules.mealStarted(meal, '火锅', now, requestedAt, 'event-7'), true)
  assert.equal(rules.mealStarted(meal, '火锅', now, requestedAt, 'event-other'), false)
  assert.equal(rules.mealStarted({ ...meal, 开始: '2026-11-10 22:00' }, '火锅', now, requestedAt), false)
  assert.equal(rules.mealStarted({ ...meal, 到: '2026-11-10 23:20' }, '火锅', now, requestedAt), false)
  assert.equal(rules.mealStarted(null, '火锅', now, requestedAt), false)
  assert.equal(rules.classifyFoodAttempt({ purchaseOutput: '钱不够', food: '火锅', now, requestedAt }), 'failed')
  assert.equal(rules.classifyFoodAttempt({ purchaseOutput: '买了 火锅，花 80 块', food: '火锅', meal, now, requestedAt }), 'started')
  assert.equal(rules.classifyFoodAttempt({ purchaseOutput: '下了快递 火锅，明天到', food: '火锅', now, requestedAt }), 'pending')
  assert.equal(rules.classifyFoodAttempt({ purchaseOutput: '点了外卖 火锅（还没吃）', consumeOutput: '坐下来吃火锅', food: '火锅', now, requestedAt }), 'failed')
  assert.equal(rules.classifyFoodAttempt({ purchaseOutput: '点了外卖 火锅（还没吃）', consumeOutput: '坐下来吃火锅', food: '火锅', meal, now, requestedAt }), 'started')
  assert.equal(rules.classifyFoodAttempt({ purchased: true, consumeOutput: '手上没有「火锅」', food: '火锅', meal, now, requestedAt }), 'failed')
  assert.equal(rules.classifyFoodAttempt({ purchased: true, consumeOutput: '坐下来吃火锅，大概 8 分钟', food: '火锅', meal, now, requestedAt }), 'started')

  const autonomy = readFileSync(process.env.AUTONOMY_SOURCE || path.join(TOOLS, '自主行动.mjs'), 'utf8')
  const purchase = readFileSync(path.join(TOOLS, '花钱.mjs'), 'utf8')
  assert.equal(autonomy.includes('classifyFoodAttempt('), true)
  assert.equal(autonomy.includes('if (foodFailed || drinkFailed) nextMinutes = 5'), true)
  assert.equal(autonomy.includes('if (_饭2 && !foodFailed && !foodPending)'), true)
  assert.equal(autonomy.includes("foodFailed ? '吃东西失败'"), true)
  assert.equal(purchase.includes('mealStarted(activeMeal, buy'), true)
  assert.equal(purchase.includes('堂食状态未建立，未扣款'), true)
})


test('任务书第一部分：工具描述精简但 schema 与安全边界不变', async () => {
  const lib = process.env.TOOL_LIB || '/data/hajimi-dsh/profiles/web/node_modules/dsh-onebot-channel/lib'
  const q = (name) => pathToFileURL(path.join(lib, name)).href + `?taskbook-tool=${++serial}`
  const tool = await import(q('tool.js'))
  const items = await import(q('items.js'))
  const photo = await import(q('photo.js'))
  const screen = await import(q('screen.js'))
  const descriptors = []
  const ctx = { tools: { register: (descriptor) => { descriptors.push(descriptor); return () => {} } }, get: () => undefined, effect: () => {} }
  for (const register of [tool.registerSendTool, tool.registerListenTool, tool.registerPassTool, tool.registerFeelTool,
    tool.registerBoardTool, items.registerItemTool, photo.registerPhotoTool, screen.registerScreenTool]) await register(ctx)
  const names = ['qq_send', 'qq_listen', 'qq_pass', 'qq_feel', 'qq_board', 'qq_item', 'qq_photo', 'qq_screen']
  const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]))
  assert.deepEqual(names.filter((name) => byName.has(name)), names)
  // SCHEMA_STRUCT 2026-11-24：这一段原来是 8 条 sha256 指纹。实测升级到 onebot
  // 0.11.0 当前版本后 8 条**全部**不同 —— 而参数名、类型、枚举、上限一个没变，
  // 差的是 description 措辞和 properties 顺序。等于每次升级都全红、信息量为零。
  // 断言改成锁**结构**（这才是「schema 与安全边界不变」的本意）：
  //   ① additionalProperties 必须是 false —— 不许往参数对象里乱塞字段
  //   ② 每个 property 必须有 type 和 description（模型靠它填对）
  //   ③ 关键枚举/上限逐条点名
  // 指纹不再做门禁，只打印出来供人工比对（真需要时看日志）。
  for (const name of names) {
    const d = byName.get(name)
    const p = d.parameters
    assert.equal(p?.type, 'object', `${name} parameters.type 必须是 object`)
    assert.equal(p?.additionalProperties, false, `${name} additionalProperties 必须 false（不许开放塞参数）`)
    const props = Object.keys(p?.properties || {})
    assert.ok(props.length > 0, `${name} 必须有参数`)
    for (const k of props) {
      const spec = p.properties[k]
      assert.ok(spec && typeof spec.type === 'string', `${name}.${k} 缺 type`)
      assert.ok(String(spec.description || '').trim() !== '', `${name}.${k} 缺 description（模型靠它填对）`)
    }
    // 输出 schema 同样不许开放
    if (d.output?.schema) {
      assert.equal(d.output.schema.additionalProperties, false, `${name} output.schema.additionalProperties 必须 false`)
    }
    console.log(`  · ${name} 参数 ${props.length} 个：${props.join('/')}`)
  }

  // ── 安全边界逐条点名（这些改了必须有人看见）─────────────────
  // 1) qq_send：final 是 boolean，且 description 不得超长（超长就没人读）
  assert.equal(byName.get('qq_send').parameters.properties?.final?.type, 'boolean')
  assert.ok(byName.get('qq_send').description.length < 900, 'qq_send 描述超长')
  assert.match(byName.get('qq_send').description, /发完就结束本轮|发送后直接结束本轮|结束本轮/)
  assert.match(byName.get('qq_send').description, /唯一发消息工具/)
  // 2) qq_screen：source 只允许「电脑/手机」两个值；offset 必须存在且是 number
  assert.deepEqual(byName.get('qq_screen').parameters.properties?.source?.enum, ['电脑', '手机'],
    'source 的枚举只有电脑/手机，别加错也别拼错')
  assert.equal(byName.get('qq_screen').parameters.properties?.offset?.type, 'number',
    'offset（往前跳几张）必须是 number —— 批次480b 加的')
  assert.match(byName.get('qq_screen').description, /不是实时画面/)
  // 3) 数值上限：不许有人把上限悄悄放大
  const 上限 = (spec) => {
    const m = String(spec?.description || '').match(/(\d{2,})/)
    return m ? Number(m[1]) : null
  }
  assert.ok(byName.get('qq_screen').parameters.properties?.count?.description.includes(String(20))
    || /1~\d+/.test(byName.get('qq_screen').parameters.properties?.count?.description || ''),
    'qq_screen.count 的取值上限要写在描述里')
  // 4) 各工具描述长度上限（防止回涨到没人读的长度）
  assert.ok(byName.get('qq_listen').description.length < 180, 'qq_listen 描述超长')
  assert.ok(byName.get('qq_pass').description.length < 220, 'qq_pass 描述超长')
  assert.ok(byName.get('qq_feel').description.length < 650, 'qq_feel 描述超长')
  assert.ok(byName.get('qq_board').description.length < 420, 'qq_board 描述超长')
  assert.ok(byName.get('qq_item').description.length < 420, 'qq_item 描述超长')
  assert.ok(byName.get('qq_photo').description.length < 620, 'qq_photo 描述超长')
  assert.ok(byName.get('qq_screen').description.length < 210, 'qq_screen 描述超长')
  // 5) 语义关键词（这些词掉了就等于模型不知道能这么用）
  assert.match(byName.get('qq_listen').description, /只在.*(明确|答应).*(再听|稍后)/, 'qq_listen 缺「只在明确答应再听时才用」')
  assert.match(byName.get('qq_pass').description, /(本轮|这一轮).*(已结束|到此为止)/, 'qq_pass 缺「本轮已结束」')
  // PASS_NOSEND 2026-11-24：当前措辞是「正文不会发出」——语义等价于「不发送消息」，
  // 钉字面词会过时。改成接受任一表达。
  assert.match(byName.get('qq_pass').description, /不(发送|发出)(消息|正文)|正文不会发出/,
    'qq_pass 缺「这次不发消息」这条事实')
  assert.match(byName.get('qq_feel').description, /(系统不替你判|确有触动时记下自己的感受)/, 'qq_feel 缺核心说明')
  assert.match(byName.get('qq_photo').description, /(read_image|英文|几分钟|过期)/, 'qq_photo 缺关键用法提示')
})

test('任务书第一部分：ROFM压缩阈值保留宿主窗口并通过sanity', { skip: 'dsh-rofm 已于 2026-11-25 退役归档' }, async () => {
  const pluginDir = process.env.ROFM_DIR || '/data/hajimi-dsh/profiles/web/node_modules/dsh-rofm'
  const [{ ConfigStore }, surface] = await Promise.all([
    import(pathToFileURL(path.join(pluginDir, 'lib/config-store.js')).href + `?taskbook=${++serial}`),
    import(pathToFileURL(path.join(pluginDir, 'lib/surface.js')).href + `?taskbook=${++serial}`),
  ])
  const cfg = new ConfigStore(pluginDir, {}).get()
  const session = { requestContext: () => ({ contextWindow: 1048576 }) }
  // HOST_128K 2026-11-17：宿主换成 128k 窗口后，压缩阈值由 12/6 调到 35/20，
  // keepRecent 6→8。这是配置口径变化，不是功能回退；下面连派生量一起锁住。
  assert.equal(cfg.compress.triggerPercent, 35)
  assert.equal(cfg.compress.releaseTargetPercent, 20)
  assert.equal(cfg.compress.compressPercent, 40)
  assert.equal(cfg.compress.keepRecentMessages, 8)
  assert.equal(cfg.compress.contextWindowTokens, 128000)
  assert.equal(cfg.compress.allowSmallWindow, true)
  assert.equal(surface.resolveContextWindow(session, cfg), 128000, '使用显式配置的有效窗口')
  assert.equal(surface.checkWindowSanity(session, cfg).needsAllowSmallWindow, false)
  assert.equal(surface.checkWindowSanity(session, cfg).conflict, true, '显式小窗口授权绕过host mismatch')
  assert.equal(cfg.compress.contextWindowTokens * cfg.compress.triggerPercent / 100, 44800)
  assert.equal(cfg.compress.contextWindowTokens * cfg.compress.releaseTargetPercent / 100, 25600)
  const { planCompression } = await import(pathToFileURL(path.join(pluginDir, 'engine/index.js')).href + `?plan=${++serial}`)
  const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `历史消息 ${i} ${'x'.repeat(1200)}`, seq: i + 1 }))
  const below = planCompression({ messages, usedPercent: 30, cfg, totalUsedTokens: 38400, windowTokens: 128000, sessionId: 'synthetic', turn: 999, now: Date.now() })
  assert.equal(below.shouldCompress, false, '低于35%阈值不触发')
  const above = planCompression({ messages, usedPercent: 40, cfg, totalUsedTokens: 51200, windowTokens: 128000, sessionId: 'synthetic', turn: 999, now: Date.now() })
  assert.equal(above.shouldCompress, true, '超过35%阈值触发')
  assert.ok(above.targetTokens > 25000, '20%释放底线高于单纯40%压缩份额')
  assert.ok(above.warnings.some((x) => x.includes('releaseTargetPercent=20%')), '不足一轮清到目标时必须明确提示继续压缩')
})

test('任务书第一部分：白名单不再留 0 调用的 schedule 工具', () => {
  const configPath = process.env.BRIDGE_CONFIG || '/data/hajimi-dsh/qq-bridge.config.json'
  const config = JSON.parse(readFileSync(configPath, 'utf8'))
  const allowed = config['工具白名单']
  assert.ok(Array.isArray(allowed))
  // WHITELIST_ALL 2026-11-12：原来这条断言写的是「保留 schedule_list，它有历史调用记录」。
  // 事实不是那样：插件 lib/ 里**根本没注册** schedule_list（grep 0 处），日志里 0 次调用，
  // 白名单里那一项指向一个不存在的工具。任务书第 2 刀要求四个全删，就按四个全删来断言。
  for (const name of ['schedule_create', 'schedule_edit', 'schedule_view', 'schedule_list']) {
    assert.equal(allowed.includes(name), false, `白名单里不该再有 ${name}（0 调用，且插件没注册）`)
  }
})


test('饮水判据：夜班只在急渴且可执行时放行，饮水回执必须真实成功', async () => {
  const m = await import(`${pathToFileURL(path.join(TOOLS, '自主判据.mjs')).href}?water=${++serial}`)
  assert.equal(typeof m.急渴应喝, 'function')
  assert.equal(typeof m.允许在岗饮水, 'function')
  assert.equal(typeof m.饮水动作成功, 'function')
  assert.equal(typeof m.缺口应补水, 'function')
  assert.equal(typeof m.饮水冷却中, 'function')
  const drink = m.急渴应喝
  assert.equal(drink({ 水百分比: 49.9, 能接: true }), '喝点水')
  assert.equal(drink({ 水百分比: 50, 能接: true }), '')
  assert.equal(drink({ 水百分比: 75, 能接: false, 杯在包: true, 杯毫升: 300 }), '')
  assert.equal(drink({ 水百分比: 49, 能接: false, 杯在包: true, 杯毫升: 100 }), '喝点水')
  assert.equal(drink({ 水百分比: 49, 能接: false, 杯在包: true, 杯毫升: 300, 刚补水: true }), '')
  assert.equal(drink({ 水百分比: 49, 能接: false, 杯在包: false, 杯毫升: 0 }), '')
  assert.equal(m.允许在岗饮水({ 在岗: true, 急渴: true }), true)
  assert.equal(m.允许在岗饮水({ 在岗: true, 急渴: false }), false)
  assert.equal(m.允许在岗饮水({ 在岗: false, 急渴: false }), true)
  assert.equal(m.缺口应补水({ 水百分比: 49, 账: [], 现在: Date.now() }), true)
  assert.equal(m.缺口应补水({ 水百分比: 50, 账: [], 现在: Date.now() }), false)
  const oldAt = new Date(Date.now() - 90 * 60e3 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  assert.equal(m.缺口应补水({ 水百分比: 49, 账: [{ at: oldAt, 喝: 300 }], 现在: Date.now(), 间隔分钟: 90 }), true)
  const now = Date.now()
  const at = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  const recentLedger = [{ at: at(now - 10 * 60e3), 喝: 300 }, { at: at(now - 5 * 60e3), 吃: '西瓜', 补: 40 }]
  assert.equal(m.饮水冷却中({ 账: recentLedger, 现在: now, 冷却分钟: 20 }), true)
  assert.equal(m.缺口应补水({ 水百分比: 40, 账: recentLedger, 现在: now, 间隔分钟: 90 }), false)
  assert.equal(m.饮水冷却中({ 账: [], 行动日志: [{ at: at(now - 2 * 60e3), state: '喝水失败' }], 现在: now, 失败冷却分钟: 5 }), true)
  assert.equal(m.饮水动作成功({ 喝出: '从杯里喝了 300 毫升：渴条 30% → 45%' }), true)
  assert.equal(m.饮水动作成功({ 喝出: '喝不上：杯子是空的' }), false)
  assert.equal(m.饮水动作成功({ 喝出: '喝水没成：杯子是空的' }), false)
  assert.equal(m.饮水动作成功({ 喝出: '喝了几口水' }), false)
  assert.equal(m.饮水动作成功({ 需接水: true, 接水出: '这儿不能接水', 喝出: '从杯里喝了 100 毫升' }), false)
  assert.equal(m.饮水动作成功({ 需购买: true, 买出: '钱不够', 装水出: '', 喝出: '' }), false)
  assert.equal(m.饮水动作成功({ 需购买: true, 买出: '买了 水，花 2 块', 装水出: '把水倒进杯子 500ml', 喝出: '从杯里喝了 300 毫升' }), true)
  const autonomy = readFileSync(path.join(TOOLS, '自主行动.mjs'), 'utf8')
  const gap = readFileSync(path.join(TOOLS, '缺口.mjs'), 'utf8')
  assert.ok(autonomy.indexOf('const __急渴') < autonomy.indexOf('const __在岗班 ='), '急渴判断必须先于在岗守卫')
  // IMPL_COUPLED 2026-11-16（批次566）：原来写死 `const pick = …`。
  // 批次566 为了「断片能覆盖抽签结果」改成了 `let pick` —— 行为一个字没变，这条却红了
  // （tdd skill 里的 implementation-coupled：重构就红、行为没变）。改成只认「谁决定 pick」。
  assert.match(autonomy, /^\s*(?:const|let) pick = \(__在岗班 && __急渴\) \? __急渴 : __常规选择\s*$/m, '急渴覆盖 pick 的那一行变了')
  assert.match(autonomy, /饮水动作成功\(/)
  assert.ok(autonomy.lastIndexOf('aut.doneAt = __值班结束At') > autonomy.indexOf('aut.doneAt = (pick ==='), '班次结束时间须在通用动作时间之后恢复')
  assert.match(autonomy, /if \(__在岗班 && \(pick === '喝点水' \|\| pick === '买瓶水'\)\)[\s\S]*?aut\.doneAt = __值班结束At/ )
  assert.match(gap, /缺口应补水\(/)
  assert.match(gap, /饮水动作成功\(/)
  assert.match(gap, /const 需接 = Number\(杯\.毫升 \|\| 0\) < 100/)
  assert.match(gap, /if \(需接 && !能接\) return/)
})
