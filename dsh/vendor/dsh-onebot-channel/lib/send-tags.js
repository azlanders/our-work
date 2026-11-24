// send-tags.js —— 只记录 qq_send 明确传入且成功投递的消息标签，不驱动情绪或关系。
import { closeSync, constants, fstatSync, fchmodSync, openSync, writeFileSync } from 'node:fs'

export const SEND_TAGS = Object.freeze(['被夸', '被怼', '陪伴', '委屈', '想笑'])
const FILE = (process.env.QQ_MEM || (process.cwd() + '/记忆')) + '/发送标签.jsonl'

export function recordSendTagAfterDelivery(result, tag, { file = FILE, now = Date.now } = {}) {
  const value = String(tag ?? '').trim()
  const messageId = result?.data?.message_id
  if (result?.retcode !== 0 || !SEND_TAGS.includes(value) || !Number.isSafeInteger(messageId) || messageId <= 0) return false
  try {
    const at = new Date(Number(now()) + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600)
    try {
      const info = fstatSync(fd)
      if (!info.isFile()) return false
      fchmodSync(fd, 0o600)
      writeFileSync(fd, JSON.stringify({ at, tag: value }) + '\n', 'utf8')
    } finally {
      closeSync(fd)
    }
    return true
  } catch {
    return false
  }
}
