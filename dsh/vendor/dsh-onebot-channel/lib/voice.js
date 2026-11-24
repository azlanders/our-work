// voice.js —— 逐次确认后，限域把本地音频发成 QQ 语音（支持 1~60 秒自然时长与显式秒数裁剪）。
import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { open as openFile, chmod, mkdtemp, lstat, realpath, stat, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { callOneBot } from './onebot.js'
import { allowedTargets } from './allowlist.js'
import { note, serviceOf } from './env.js'

const execFileAsync = promisify(execFile)
const AUDIO_EXTENSIONS = new Set(['.aac', '.flac', '.m4a', '.mp3', '.ogg', '.opus', '.wav'])
const MAX_BYTES = 25 * 1024 * 1024
const MAX_DURATION_SECONDS = 1800
const MAX_VOICE_SEND_SECONDS = 60

async function run(command, args, timeout = 30000) {
  return execFileAsync(command, args, { timeout, maxBuffer: 1024 * 1024 })
}

function normalizeId(value) {
  const raw = String(value ?? '').trim()
  if (!/^\d{5,12}$/.test(raw)) return ''
  const number = Number(raw)
  return Number.isSafeInteger(number) && number > 0 ? String(number) : ''
}

export async function sendVoice(args, options = {}) {
  if (args?.confirm !== true) throw new Error('需要 confirm=true 明确确认发送这段语音')
  const kind = String(args?.target_type ?? '')
  const targetId = normalizeId(args?.target_id)
  if (!['private', 'group'].includes(kind) || targetId === '') throw new Error('必须指定有效的好友或群目标')
  const targetSet = (options.targets ?? allowedTargets())?.[kind]
  if (!(targetSet instanceof Set) || !targetSet.has(targetId)) throw new Error('语音发送目标不在当前服务白名单内')

  const file = String(args?.file ?? '').trim()
  if (!file || file !== path.basename(file) || file === '.' || file === '..' || file.includes('\\')) {
    throw new Error('只允许指定下载目录内的单个文件名')
  }
  const extension = path.extname(file).toLowerCase()
  if (!AUDIO_EXTENSIONS.has(extension)) throw new Error('只支持常见音频格式')
  const inputDir = path.resolve(options.inputDir ?? (process.cwd() + '/下载'))
  const inputRoot = await realpath(inputDir)
  const source = path.join(inputDir, file)
  const sourceStat = await lstat(source)
  if (sourceStat.isSymbolicLink()) throw new Error('不接受符号链接音频')
  if (!sourceStat.isFile()) throw new Error('音频路径必须是普通文件')
  if (await realpath(path.dirname(source)) !== inputRoot) throw new Error('音频必须位于下载目录根目录')
  if (sourceStat.size <= 0) throw new Error('音频是空文件')
  if (sourceStat.size > MAX_BYTES) throw new Error('音频文件不能超过25 MiB')

  const autoLen = Boolean(options.autoDuration) && args?.seconds === undefined
  const minAllowed = autoLen ? 0.5 : 1
  const requestedSeconds = autoLen ? null : Number(args?.seconds ?? 15)
  if (!autoLen && (!Number.isInteger(requestedSeconds) || requestedSeconds < 1 || requestedSeconds > MAX_VOICE_SEND_SECONDS)) {
    throw new Error(`语音时长只允许1至${MAX_VOICE_SEND_SECONDS}秒`)
  }

  const execute = options.run ?? run
  const tempRoot = path.resolve(options.workDir ?? os.tmpdir())
  const work = await mkdtemp(path.join(tempRoot, 'qq-voice-'))
  const setMode = options.chmod ?? chmod
  const removeTree = options.remove ?? rm
  const wav = path.join(work, 'voice.wav')
  const silk = path.join(work, 'voice.silk')
  const decodedWav = path.join(work, 'voice-decoded.wav')
  const privateSource = path.join(work, 'source' + extension)
  try {
    await setMode(work, 0o700)
    const sourceFd = await openFile(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const opened = await sourceFd.stat()
      if (!opened.isFile() || opened.dev !== sourceStat.dev || opened.ino !== sourceStat.ino || opened.size !== sourceStat.size) {
        throw new Error('音频文件在校验期间发生变化')
      }
      if (opened.size > MAX_BYTES) throw new Error('音频文件不能超过25 MiB')
      const dest = await openFile(privateSource, 'wx', 0o600)
      try {
        const buffer = Buffer.allocUnsafe(64 * 1024)
        let position = 0
        while (position < opened.size) {
          const length = Math.min(buffer.length, opened.size - position)
          if (position + length > MAX_BYTES) throw new Error('音频文件不能超过25 MiB')
          const { bytesRead } = await sourceFd.read(buffer, 0, length, position)
          if (bytesRead <= 0) throw new Error('音频在建立私有副本时发生截断')
          await dest.write(buffer, 0, bytesRead)
          position += bytesRead
        }
        await dest.sync()
        const copied = await dest.stat()
        const afterCopy = await sourceFd.stat()
        if (afterCopy.dev !== opened.dev || afterCopy.ino !== opened.ino || afterCopy.size !== opened.size || afterCopy.mtimeMs !== opened.mtimeMs || afterCopy.ctimeMs !== opened.ctimeMs) {
          throw new Error('音频文件在复制期间发生变化')
        }
        if (copied.size !== opened.size || copied.size > MAX_BYTES) throw new Error('音频私有副本大小校验失败')
      } finally {
        await dest.close()
      }
    } finally {
      await sourceFd.close()
    }
    const probe = await execute('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', privateSource
    ], 15000)
    const duration = Number(String(probe?.stdout ?? '').trim())
    if (!Number.isFinite(duration) || duration < minAllowed || duration > MAX_DURATION_SECONDS) {
      throw new Error('音频时长必须有效且不超过30分钟')
    }
    if (!autoLen && args?.seconds !== undefined && duration + 0.05 < requestedSeconds) {
      throw new Error('源音频不足请求的语音时长')
    }
    const targetSec = autoLen
      ? Math.min(MAX_VOICE_SEND_SECONDS, Math.max(0.5, duration))
      : (args?.seconds !== undefined ? requestedSeconds : Math.min(requestedSeconds, duration))

    const ffArgs = [
      '-y', '-v', 'error', '-i', privateSource, '-map', '0:a:0',
      '-t', String(autoLen ? Math.ceil(targetSec + 0.5) : targetSec),
      '-ac', '1', '-ar', '24000', '-sample_fmt', 's16', wav
    ]
    await execute('ffmpeg', ffArgs, 30000)
    const wavStat = await stat(wav)
    if (!wavStat.isFile() || wavStat.size <= 0) throw new Error('语音转码未生成有效音频')
    await setMode(wav, 0o600)
    const encodedProbe = await execute('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', wav
    ], 15000)
    const encodedDuration = Number(String(encodedProbe?.stdout ?? '').trim())
    const minEnc = autoLen ? 0.4 : Math.max(targetSec >= 3 ? 3 : 1, targetSec - 0.25)
    const maxEnc = autoLen ? MAX_VOICE_SEND_SECONDS + 1 : targetSec + 0.05
    if (!Number.isFinite(encodedDuration) || encodedDuration < minEnc || encodedDuration > maxEnc) {
      throw new Error('转码后的语音时长不在请求范围内')
    }
    await execute('python3', ['/root/tools/mk_silk.py', wav, silk], 30000)
    const silkStat = await stat(silk)
    if (!silkStat.isFile() || silkStat.size <= 0) throw new Error('QQ语音编码未生成有效文件')
    await setMode(silk, 0o600)
    await execute('python3', [
      '-c', 'import pilk, sys; pilk.silk_to_wav(sys.argv[1], sys.argv[2], 24000)', silk, decodedWav
    ], 30000)
    const decodedStat = await stat(decodedWav)
    if (!decodedStat.isFile() || decodedStat.size <= 0) throw new Error('QQ语音解码自检未生成有效音频')
    await setMode(decodedWav, 0o600)
    const decodedProbe = await execute('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', decodedWav
    ], 15000)
    const decodedDuration = Number(String(decodedProbe?.stdout ?? '').trim())
    if (!Number.isFinite(decodedDuration) || decodedDuration < minEnc || decodedDuration > maxEnc) {
      throw new Error('最终QQ语音时长不在请求范围内')
    }

    const payload = kind === 'group'
      ? { action: 'send_group_msg', params: { group_id: Number(targetId), message: [{ type: 'record', data: { file: silk } }] } }
      : { action: 'send_private_msg', params: { user_id: Number(targetId), message: [{ type: 'record', data: { file: silk } }] } }
    const send = options.send ?? callOneBot
    const result = await send(payload)
    const messageId = Number(result?.data?.message_id ?? 0)
    if (Number(result?.retcode) !== 0 || !Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error('语音发送失败或缺少有效 message_id 回执')
    }
    return { message_id: messageId }
  } finally {
    try {
      await removeTree(work, { recursive: true, force: true })
    } catch (error) {
      // NOTE_INJECT 2026-11-14（批次443）：这里原来直接调模块级的 note，**根本没读 options.note** ——
      // t354 的 D7 明明传了 `note: () => {}` 想静音这条，实际一个字节都没拦住。
      // 于是它抛的「simulated cleanup failure」被写进**真** load.log，三天积了 86 条，
      // 和真故障长得一模一样（跟「关系卡装不下」那次一个病：注入点写了就要真的用）。
      try {
        const 记 = options.note ?? note
        记('tool', `语音临时目录清理失败：${error instanceof Error ? error.message : error}`)
      } catch {}
    }
  }
}

export async function registerVoiceSendTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    if (!tools || typeof tools.register !== 'function') return note('tool', 'no tools service')
    const disposeTool = tools.register({
      name: 'qq_voice_send',
      description: '把本地音频发成 QQ 语音（最长 60 秒）。只在用户明确要求把指定音频发给指定好友/群时用；必须给下载目录内文件名、白名单目标和 confirm=true。',
      parameters: { type: 'object', additionalProperties: false, properties: {
        file: { type: 'string', description: '下载目录内的音频文件名，不接受路径。' },
        target_type: { type: 'string', enum: ['private', 'group'], description: '好友私聊或群聊。' },
        target_id: { type: 'string', description: '白名单内的好友QQ号或群号。' },
        seconds: { type: 'integer', description: '可选；截 1~60 秒，默认原时长。' },
        confirm: { type: 'boolean', description: '必填 true；用户须明确要求。' }
      }, required: ['file', 'target_type', 'target_id', 'confirm'] },
      output: { schema: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'number' } }, required: ['message_id'] },
        render: (_args, value) => [{ type: 'text', text: `语音已发送，message_id=${Number(value?.message_id ?? 0)}` }] },
      execute: (args) => sendVoice(args, { autoDuration: args?.seconds === undefined })
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_voice_send tool')
    note('tool', 'qq_voice_send registered')
  } catch (error) {
    note('tool', `qq_voice_send register failed: ${error instanceof Error ? error.message : error}`)
  }
}
