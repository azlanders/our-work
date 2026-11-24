// sayVoice.js —— 文本 → 真人感少女语音合成 → 完整发成 QQ 语音（1~60 秒自然说完，不硬截断）。
import { execFile } from 'node:child_process'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import path from 'node:path'
import { sendVoice } from './voice.js'
import { note } from './env.js'

const TOOLS = `${QQ_WS}/共享/工具`
const DOWNLOAD = `${QQ_WS}/下载`
const MAX_CHARS = 260

function 合成(text) {
  return new Promise((resolve) => {
    execFile('/bin/bash', ['-c', 'set -a; [ -f /etc/dshbot.env ] && . /etc/dshbot.env; set +a; exec "$@"', 'tts', process.execPath, path.join(TOOLS, '语音合成.mjs'), text, '--out', DOWNLOAD],
      { timeout: 90000, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        const 行 = String(stdout || '').trim().split('\n').filter(Boolean).pop() || ''
        try { resolve(JSON.parse(行)) }
        catch { resolve({ ok: false, reason: err ? String(err.message).slice(0, 120) : '合成脚本没回结果' }) }
      })
  })
}

export async function sayVoice(args, options = {}) {
  if (args?.confirm !== true) throw new Error('需要 confirm=true 明确确认这次要开口说话')
  const text = String(args?.text ?? '').trim()
  if (!text) throw new Error('要说点什么')
  if (text.length > MAX_CHARS) throw new Error(`一次最多 ${MAX_CHARS} 个字`)
  const r = await 合成(text)
  if (!r.ok) throw new Error('没合成出来：' + String(r.reason || '未知原因').slice(0, 140))
  note('voice', `TTS 合成好了：${r.file}（${r.bytes} 字节，${r.模型 || ''} · ${r.音色 || ''}）`)
  return sendVoice({
    file: r.file,
    target_type: args.target_type,
    target_id: args.target_id,
    ...(args.seconds !== undefined ? { seconds: args.seconds } : {}),
    confirm: true,
  }, { ...options, autoDuration: args.seconds === undefined })
}

export async function registerSayVoiceTool(ctx) {
  try {
    const disposeTool = ctx.tools.register({
      name: 'qq_say_voice',
      description: '用自己的真声音发一条 QQ 语音（1~60 秒，不截断）。说早安晚安、撒娇、哄人或对方点名要语音时用。台词写口语自然句，可带「唔……」等语气词，别带括号动作或 emoji；confirm=true。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: '亲口说的话，1~260 字，口语，不要 emoji。' },
          target_type: { type: 'string', enum: ['private', 'group'], description: '好友私聊或群聊。' },
          target_id: { type: 'string', description: '当前对话的好友QQ号/群号。' },
          seconds: { type: 'integer', description: '可选；默认按自然时长。' },
          confirm: { type: 'boolean', description: '必填 true。' },
        },
        required: ['text', 'target_type', 'target_id', 'confirm'],
      },
      output: {
        schema: { type: 'object', additionalProperties: false, properties: { message_id: { type: 'number' } }, required: ['message_id'] },
        render: (_args, value) => [{ type: 'text', text: `语音已发出，message_id=${Number(value?.message_id ?? 0)}` }],
      },
      execute: (args) => sayVoice(args),
    })
    if (typeof disposeTool === 'function') ctx.effect(() => disposeTool, 'dsh-onebot-channel: qq_say_voice tool')
    note('tool', 'qq_say_voice registered')
  } catch (error) {
    note('tool', `qq_say_voice register failed: ${error instanceof Error ? error.message : error}`)
  }
}
