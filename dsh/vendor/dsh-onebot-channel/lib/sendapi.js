/**
 * sendapi.js —— AI 主动发消息的本地接口（给会话里的 AI 用，不需要 QQ 那边先开口）。
 *
 *   POST http://127.0.0.1:<sendApiPort>/send
 *   body: { "text": "要说的话", "user_id": "1000000004" }   // 不传 user_id 就发给默认私聊对象
 *   body: { "text": "群里说的话", "group_id": "2000000001" } // 传 group_id 发群
 *   GET  http://127.0.0.1:<sendApiPort>/health             // 看活着没
 *
 * 只绑 127.0.0.1，外面够不着；纯文本，走 sendToQQ（会按配置分条）。
 */
import { createServer } from 'node:http'
import { getConfig } from './config.js'
import { note } from './env.js'
import { sendToQQ, 未发送原因 } from './outbound.js'
import { normalizeQqId } from './target.js'
import { resolveFaceSegment } from './face-resolve.js'
import { findCustomFace } from './custom-faces.js'
import { 读死信, 标记补发, 死信文件 } from './deadletter.js'

export function startSendApi(stopFns) {
  const port = Number(getConfig().sendApiPort) || 39273
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(obj))
  }
  let server
  try {
    server = createServer((req, res) => {
      void (async () => {
        const url = (req.url ?? '').split('?')[0]
        try {
          if (req.method === 'GET' && (url === '/' || url === '/health')) {
            const config = getConfig()
            return json(res, 200, { ok: true, enabled: config.enabled, selfUin: String(config.selfUin ?? '') })
          }
          if (req.method === 'POST' && url === '/send') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const text = String(body.text ?? '').trim()
            const emojiName = String(body.emoji ?? '').trim()
            const customEmojiName = String(body.custom_emoji ?? '').trim()
            if (text === '' && emojiName === '' && customEmojiName === '') {
              return json(res, 400, { ok: false, error: 'text 不能为空' })
            }
            const groupId = String(body.group_id ?? body.groupId ?? '').trim()
            // 批次 602B：显式传了 user_id 就必须是合法正整数；
            // 只有完全没传（字段不存在 / null）才允许用默认私聊对象。
            const 显式给了UserId = Object.prototype.hasOwnProperty.call(body, 'user_id')
              || Object.prototype.hasOwnProperty.call(body, 'userId')
            const rawUserId = body.user_id ?? body.userId
            const userId = String(rawUserId ?? '').trim()
            const groupCheck = groupId !== '' ? normalizeQqId(groupId) : null
            if (groupCheck !== null && !groupCheck.ok) {
              return json(res, 400, { ok: false, error: `group_id 非法（${groupCheck.error}）` })
            }
            // 群优先：带了 group_id 时 user_id 不参与投递，不因它为空/非法而误拒群消息。
            const userCheck = groupId === '' && 显式给了UserId && rawUserId !== undefined && rawUserId !== null
              ? normalizeQqId(rawUserId)
              : null
            if (userCheck !== null && !userCheck.ok) {
              return json(res, 400, { ok: false, error: `user_id 非法（${userCheck.error}）` })
            }
            // 群优先，跟 qq_send 一致
            const target = groupId !== ''
              ? { kind: 'group', id: groupCheck.id }
              : (userCheck !== null ? { kind: 'private', id: userCheck.id } : { kind: 'private' })
            // 表情解析走 face-resolve（官方目录优先 + 有效性校验）。
            // 不能用 emoticons.faceSegmentOf —— 那张内置表有 109 个幽灵 id，
            // 拿幽灵 id 发会让协议端报错并把整条消息搞没。
            const faceSegment = emojiName !== '' ? await resolveFaceSegment(emojiName) : null
            let customEmojiId = ''
            if (customEmojiName !== '') {
              const found = await findCustomFace(customEmojiName)
              if (found === null) {
                return json(res, 400, { ok: false, error: `收藏夹里没找到含「${customEmojiName}」的表情` })
              }
              customEmojiId = found.emojiId
            }
            const result = await sendToQQ(target, text, { faceSegment, customEmojiId })
            const reason = 未发送原因(result)
            if (reason) return json(res, 409, { ok: false, error: reason })
            note('sendapi', `sent ${groupId !== '' ? `group ${groupId}` : `private ${userId || 'default'}`} len=${text.length}${faceSegment !== null ? ' +face' : ''}${customEmojiId !== '' ? ' +custom' : ''}`)
            return json(res, 200, { ok: true, message_id: Number(result?.data?.message_id ?? 0) })
          }
          // 批次611（审计 P1-7）：发失败的死信不再「重启就没」。
          // GET  /dead-letters?limit=50     看还没补发的
          // POST /dead-letters/replay {id}  补发一条（会再走一遍白名单/审计/分条）
          if (req.method === 'GET' && url === '/dead-letters') {
            const u = new URL(req.url ?? '/', 'http://127.0.0.1')
            const limit = Number(u.searchParams.get('limit') ?? 50)
            return json(res, 200, { ok: true, file: 死信文件(), items: 读死信(limit) })
          }
          if (req.method === 'POST' && url === '/dead-letters/replay') {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
            const id = String(body.id ?? '').trim()
            if (id === '') return json(res, 400, { ok: false, error: 'id 不能为空' })
            const item = 读死信(200).find((x) => String(x.id ?? '') === id)
            if (!item) return json(res, 404, { ok: false, error: '没有这条未补发的死信' })
            const target = item.target
            if (!target || (target.kind !== 'private' && target.kind !== 'group') || String(target.id ?? '') === '') {
              return json(res, 400, { ok: false, error: '这条死信没有可用的目标，不能自动补发' })
            }
            const result = await sendToQQ(target, String(item.text ?? ''))
            const reason = 未发送原因(result)
            if (reason) return json(res, 409, { ok: false, error: reason + '；已保留待补发消息' })
            const 标记 = 标记补发(id)
            note('sendapi', `replay dead-letter ${id} -> ${target.kind}:${target.id}${标记 ? '' : '（补发标记写失败）'}`)
            return json(res, 200, {
              ok: true,
              replayed: id,
              message_id: Number(result?.data?.message_id ?? 0),
              标记,
            })
          }
          return json(res, 404, { ok: false, error: `unknown route: ${url}` })
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          note('sendapi', `error ${message}`)
          return json(res, 500, { ok: false, error: message })
        }
      })()
    })
    server.on('error', (error) => {
      // 多实例抢端口是最常见的失败原因，不该连累收发主链路
      note('sendapi', `listen failed ${error instanceof Error ? error.message : error}`)
    })
    server.listen(port, '127.0.0.1', () => {
      note('sendapi', `AI 自动发消息接口已启动 http://127.0.0.1:${port}/send`)
    })
    if (Array.isArray(stopFns)) {
      stopFns.push(() => {
        try { server.close() } catch {}
      })
    }
  } catch (error) {
    note('sendapi', `start failed ${error instanceof Error ? error.message : error}`)
  }
}
