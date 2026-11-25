// atomic-fs.js —— dsh-onebot-channel 统一原子写盘工具（pid + random + renameSync）。
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export function atomicWriteFileSync(filePath, data, encoding = 'utf8') {
  const tmp = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    mkdirSync(dirname(filePath), { recursive: true })
    if (typeof data === 'string') writeFileSync(tmp, data, encoding)
    else writeFileSync(tmp, data)
    renameSync(tmp, filePath)
  } catch (err) {
    try { unlinkSync(tmp) } catch (_e) { console.error('[onebot:atomic-fs]', _e?.message || _e) }
    throw err
  }
}
