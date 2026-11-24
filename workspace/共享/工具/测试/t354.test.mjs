import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, lstat, stat, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

const LIB = process.env.PLUGIN_LIB || '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'
let serial = 0
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href + `?t354=${++serial}`)

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix))
}

test('D5: 只把成功发送标签写入隔离流水', async () => {
  const tags = await load('send-tags.js')
  const dir = await tempDir('t354-tag-')
  const file = path.join(dir, '发送标签.jsonl')
  try {
    assert.equal(tags.recordSendTagAfterDelivery({ retcode: 0, data: { message_id: 101 } }, '陪伴', { file, now: () => Date.parse('2026-11-11T00:00:00Z') }), true)
    const row = JSON.parse((await (await import('node:fs/promises')).readFile(file, 'utf8')).trim())
    assert.deepEqual(Object.keys(row).sort(), ['at', 'tag'])
    assert.equal((await lstat(file)).mode & 0o777, 0o600, '标签流水仅所有者可读写')
    assert.equal(row.tag, '陪伴')
    assert.equal(row.at, '2026-11-11 08:00')
  } finally {
    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
  }
})

test('D5: 静默、无回执、无效标签和落盘失败都不伪记成功', async () => {
  const tags = await load('send-tags.js')
  const dir = await tempDir('t354-tag-')
  const file = path.join(dir, '发送标签.jsonl')
  try {
    assert.equal(tags.recordSendTagAfterDelivery({ muted: true }, '陪伴', { file }), false)
    assert.equal(tags.recordSendTagAfterDelivery({}, '陪伴', { file }), false)
    assert.equal(tags.recordSendTagAfterDelivery({ data: { message_id: 12 } }, '陪伴', { file }), false)
    assert.equal(tags.recordSendTagAfterDelivery({ retcode: 1, data: { message_id: 13 } }, '陪伴', { file }), false)
    assert.equal(tags.recordSendTagAfterDelivery({ retcode: 0, data: { message_id: 0 } }, '陪伴', { file }), false)
    assert.equal(tags.recordSendTagAfterDelivery({ retcode: 0, data: { message_id: 14 } }, '不认识', { file }), false)
    assert.equal(tags.recordSendTagAfterDelivery({ retcode: 0, data: { message_id: 15 } }, '陪伴', { file: path.join(dir, 'missing', 'x.jsonl') }), false)
    assert.equal(tags.recordSendTagAfterDelivery({ retcode: 0, data: { message_id: 16 } }, '陪伴', { file }), true)
    const rows = (await (await import('node:fs/promises')).readFile(file, 'utf8')).trim().split('\n')
    assert.equal(rows.length, 1)
    const target = path.join(dir, 'target.jsonl')
    await writeFile(target, 'keep\n')
    const link = path.join(dir, 'linked.jsonl')
    await symlink(target, link)
    assert.equal(tags.recordSendTagAfterDelivery({ retcode: 0, data: { message_id: 17 } }, '陪伴', { file: link }), false)
    assert.equal(await (await import('node:fs/promises')).readFile(target, 'utf8'), 'keep\n')
  } finally {
    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
  }
})

test('D5: qq_send 暴露限定的可选 feel_tag，不改其他工具 schema', async () => {
  const tool = await load('tool.js')
  const descriptors = []
  const ctx = { tools: { register: (item) => { descriptors.push(item); return () => {} } }, get: () => undefined, effect: () => {} }
  await tool.registerSendTool(ctx)
  const send = descriptors.find((item) => item.name === 'qq_send')
  assert.ok(send)
  assert.deepEqual(send.parameters.properties.feel_tag.enum, ['被夸', '被怼', '陪伴', '委屈', '想笑'])
  assert.equal(send.parameters.additionalProperties, false)
})

test('D7: 未确认、未授权目标或超出时长的语音不会进入发送流水', async () => {
  const voice = await load('voice.js')
  const dir = await tempDir('t354-voice-')
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'clip.wav'), Buffer.alloc(128, 1))
  const targets = { private: new Set(), group: new Set(['12345']) }
  let commandCalls = 0
  let sendCalls = 0
  const opts = { inputDir, workDir, targets, run: async () => { commandCalls += 1; return { stdout: '4.1' } }, send: async () => { sendCalls += 1; return { retcode: 0, data: { message_id: 1 } } } }
  try {
    await assert.rejects(voice.sendVoice({ file: 'clip.wav', target_type: 'group', target_id: '12345', confirm: false }, opts), /confirm=true/)
    await assert.rejects(voice.sendVoice({ file: 'clip.wav', target_type: 'group', target_id: '99999', confirm: true }, opts), /白名单/)
    assert.equal(commandCalls, 0)
    assert.equal(sendCalls, 0)
    const tooLong = { ...opts, run: async (cmd, args) => { commandCalls += 1; return cmd === 'ffprobe' ? { stdout: '1801' } : { stdout: '' } } }
    await assert.rejects(voice.sendVoice({ file: 'clip.wav', target_type: 'group', target_id: '12345', confirm: true, seconds: 4 }, tooLong), /时长/)
    assert.equal(sendCalls, 0)
  } finally {
    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
  }
})

test('D7: 临时目录 chmod 失败后仍清理目录', async () => {
  const voice = await load('voice.js')
  const dir = await tempDir('t354-voice-chmod-')
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'clip.wav'), Buffer.alloc(128, 6))
  await assert.rejects(voice.sendVoice({ file: 'clip.wav', target_type: 'group', target_id: '12345', confirm: true }, {
    inputDir, workDir,
    targets: { private: new Set(), group: new Set(['12345']) },
    chmod: async () => { throw new Error('simulated chmod failure') },
    remove: async (path, options) => (await import('node:fs/promises')).rm(path, options),
    run: async () => { throw new Error('must not run after chmod') },
    send: async () => { throw new Error('must not send') }
  }), /simulated chmod failure/)
  assert.equal((await readdir(workDir)).length, 0)
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})

test('D7: 只处理下载目录内 basename，拒绝路径、链接、空文件和不支持格式', async () => {
  const voice = await load('voice.js')
  const dir = await tempDir('t354-voice-')
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'empty.wav'), Buffer.alloc(0))
  await writeFile(path.join(inputDir, 'notes.txt'), 'not audio')
  await symlink(path.join(inputDir, 'empty.wav'), path.join(inputDir, 'link.wav'))
  const common = { target_type: 'group', target_id: '12345', confirm: true }
  const opts = { inputDir, workDir, targets: { group: new Set(['12345']), private: new Set() }, run: async () => { throw new Error('不应启动转码') }, send: async () => { throw new Error('不应发送') } }
  try {
    await assert.rejects(voice.sendVoice({ ...common, file: '../clip.wav' }, opts), /文件名/)
    await assert.rejects(voice.sendVoice({ ...common, file: 'notes.txt' }, opts), /格式/)
    await assert.rejects(voice.sendVoice({ ...common, file: 'empty.wav' }, opts), /空文件/)
    await assert.rejects(voice.sendVoice({ ...common, file: 'link.wav' }, opts), /符号链接/)
    const large = path.join(inputDir, 'large.wav')
    await writeFile(large, Buffer.alloc(25 * 1024 * 1024 + 1, 1))
    await assert.rejects(voice.sendVoice({ ...common, file: 'large.wav' }, opts), /超过25 MiB/)
  } finally {
    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
  }
})

test('D7: 3至5秒语音经限时转码、回执成功后清理临时文件', async () => {
  const voice = await load('voice.js')
  const dir = await tempDir('t354-voice-')
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'clip.wav'), Buffer.alloc(128, 2), { mode: 0o644 })
  const calls = []
  let originalMode
  let payload
  const result = await voice.sendVoice(
    { file: 'clip.wav', target_type: 'group', target_id: '12345', confirm: true, seconds: 4 },
    {
      inputDir,
      workDir,
      targets: { private: new Set(), group: new Set(['12345']) },
      run: async (command, args) => {
        calls.push({ command, args })
        if (command === 'ffprobe') {
          const probeCount = calls.filter((call) => call.command === 'ffprobe').length
          if (probeCount === 1) {
            const sourceArg = args.at(-1)
            assert.notEqual(sourceArg, path.join(inputDir, 'clip.wav'), '子进程不得直接打开下载源路径')
            assert.equal(path.dirname(sourceArg).startsWith(workDir + path.sep), true, '子进程只读私有临时副本')
            assert.equal((await stat(sourceArg)).mode & 0o777, 0o600, '私有源副本权限为0600')
            assert.equal((await stat(path.join(inputDir, 'clip.wav'))).mode & 0o777, 0o644, '不得修改下载源权限')
          }
          return { stdout: probeCount === 1 ? '4.2\n' : '3.95\n' }
        }
        await writeFile(args[args.length - 1], command === 'ffmpeg' || String(args[0] ?? '') === '-c' ? 'wav-output' : 'silk-output')
        return { stdout: '' }
      },
      send: async (value) => {
        payload = value
        const silkPath = value.params.message[0].data.file
        const original = path.join(inputDir, 'clip.wav')
        assert.equal((await stat(original)).mode & 0o777, 0o644, '下载原文件权限不可被工具改动')
        assert.equal((await (await import('node:fs/promises')).readFile(original)).length, 128, '原文件内容保持不变')
        assert.equal((await lstat(path.dirname(silkPath))).mode & 0o777, 0o700)
        assert.equal((await stat(silkPath)).mode & 0o777, 0o600)
        assert.equal((await stat(path.join(path.dirname(silkPath), 'voice.wav'))).mode & 0o777, 0o600)
        assert.equal((await stat(path.join(path.dirname(silkPath), 'voice-decoded.wav'))).mode & 0o777, 0o600)
        return { retcode: 0, data: { message_id: 77 } }
      }
    }
  )
  assert.equal(result.message_id, 77)
  assert.equal(calls.length, 6)
  assert.deepEqual(calls.map((call) => call.command), ['ffprobe', 'ffmpeg', 'ffprobe', 'python3', 'python3', 'ffprobe'])
  assert.equal(calls[1].args.includes('4'), true)
  assert.equal(payload.action, 'send_group_msg')
  assert.equal(payload.params.group_id, 12345)
  assert.equal(payload.params.message[0].type, 'record')
  assert.equal((await readdir(workDir)).length, 0)
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})

test('D7: 发送成功但清理失败仍保留成功回执', async () => {
  const voice = await load('voice.js')
  const dir = await tempDir('t354-voice-cleanup-')
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'clip.wav'), Buffer.alloc(128, 7))
  let sends = 0
  const result = await voice.sendVoice({ file: 'clip.wav', target_type: 'group', target_id: '12345', confirm: true, seconds: 3 }, {
    inputDir, workDir,
    targets: { private: new Set(), group: new Set(['12345']) },
    run: async (command, args) => {
      if (command === 'ffprobe') return { stdout: '3.0' }
      await writeFile(args.at(-1), 'encoded')
      return { stdout: '' }
    },
    send: async () => { sends += 1; return { retcode: 0, data: { message_id: 88 } } },
    remove: async (targetPath, options) => {
      assert.equal(path.dirname(targetPath), workDir)
      assert.match(path.basename(targetPath), /^qq-voice-/)
      assert.equal(options.recursive, true)
      assert.equal(options.force, true)
      throw new Error('simulated cleanup failure')
    },
    note: () => {}
  })
  assert.equal(result.message_id, 88)
  assert.equal(sends, 1)
  assert.equal((await readdir(workDir)).length, 1)
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})

test('D7: OneBot 失败或缺回执时不报告成功并清理临时文件', async () => {
  const voice = await load('voice.js')
  const dir = await tempDir('t354-voice-')
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'clip.wav'), Buffer.alloc(128, 3))
  const opts = {
    inputDir, workDir,
    targets: { private: new Set(), group: new Set(['12345']) },
    run: async (command, args) => {
      if (command === 'ffprobe') return { stdout: '3.0' }
      await writeFile(args[args.length - 1], 'encoded')
      return { stdout: '' }
    },
    send: async () => ({ retcode: 0, data: { message_id: 0 } })
  }
  try {
    await assert.rejects(voice.sendVoice({ file: 'clip.wav', target_type: 'group', target_id: '12345', confirm: true, seconds: 3 }, opts), /有效 message_id/)
    assert.equal((await readdir(workDir)).length, 0)
  } finally {
    await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
  }
})

test('D7: 源音频不足或转码后时长不符时拒绝发送并清理', async () => {
  const voice = await load('voice.js')
  const dir = await tempDir('t354-voice-duration-')
  const inputDir = path.join(dir, 'download')
  const workDir = path.join(dir, 'work')
  await mkdir(inputDir)
  await mkdir(workDir)
  await writeFile(path.join(inputDir, 'short.wav'), Buffer.alloc(128, 5))
  const base = {
    file: 'short.wav', target_type: 'group', target_id: '12345', confirm: true, seconds: 5
  }
  const common = { inputDir, workDir, targets: { private: new Set(), group: new Set(['12345']) } }
  let sends = 0
  const shortSource = {
    ...common,
    run: async (command, args) => command === 'ffprobe'
      ? { stdout: '4.8' }
      : (await writeFile(args.at(-1), 'wav'), { stdout: '' }),
    send: async () => { sends += 1; return { retcode: 0, data: { message_id: 1 } } }
  }
  await assert.rejects(voice.sendVoice(base, shortSource), /源音频不足/)
  assert.equal(sends, 0)
  assert.equal((await readdir(workDir)).length, 0)

  const badCases = [
    { seconds: 5, source: '6.0', wav: '4.6', decoded: '4.6', error: /转码后的语音时长/ },
    { seconds: 5, source: '6.0', wav: '5.2', decoded: '5.2', error: /转码后的语音时长/ },
    { seconds: 3, source: '3.4', wav: '3.0', decoded: '2.9', error: /最终QQ语音时长/ },
    { seconds: 4, source: '4.4', wav: '3.95', decoded: '5.1', error: /最终QQ语音时长/ },
  ]
  for (const item of badCases) {
    let probes = 0
    const mismatched = {
      ...common,
      run: async (command, args) => {
        if (command === 'ffprobe') {
          probes += 1
          return { stdout: probes === 1 ? item.source : probes === 2 ? item.wav : item.decoded }
        }
        await writeFile(args.at(-1), 'wav')
        return { stdout: '' }
      },
      send: async () => { sends += 1; return { retcode: 0, data: { message_id: 1 } } }
    }
    await assert.rejects(voice.sendVoice({ ...base, seconds: item.seconds }, mismatched), item.error)
    assert.equal(sends, 0)
    assert.equal((await readdir(workDir)).length, 0)
  }
  await (await import('node:fs/promises')).rm(dir, { recursive: true, force: true })
})

test('D7: 语音工具注册时声明逐次确认和目标信息', async () => {
  const voice = await load('voice.js')
  const descriptors = []
  const ctx = { tools: { register: (item) => { descriptors.push(item); return () => {} } }, get: () => undefined, effect: () => {} }
  await voice.registerVoiceSendTool(ctx)
  const item = descriptors.find((descriptor) => descriptor.name === 'qq_voice_send')
  assert.ok(item)
  assert.equal(item.parameters.properties.confirm.type, 'boolean')
  assert.ok(item.parameters.required.includes('confirm'))
  assert.ok(item.parameters.required.includes('file'))
  assert.match(item.description, /明确要求/)
  const fs = await import('node:fs/promises')
  const index = await fs.readFile(path.join(LIB, 'index.js'), 'utf8')
  assert.match(index, /registerVoiceSendTool\(ctx\)/)
  const bridge = JSON.parse(await fs.readFile(process.env.BRIDGE_CONFIG || '{{DSH_ROOT}}/qq-bridge.config.json', 'utf8'))
  assert.ok(bridge['工具白名单'].includes('qq_voice_send'))
})
