/**
 * atomic.js —— 小文件的原子写与坏档保留（批次612）。
 *
 * proactive.js 原来直接 writeFileSync 整份状态：
 *   ① 写到一半进程被杀，文件就是半截 JSON；
 *   ② 下次 loadTable 解析失败 → table = {}，再 persist 一次就把坏文件覆盖成空表，
 *      所有目标的「上次互动 / 退避 / 日配额」全丢。
 * 这里只做两件小事：临时文件 + rename（原子替换）、坏档改名留证。
 */
import fs from 'node:fs'
import path from 'node:path'

export function 原子写JSON(file, value) {
  const 临时 = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(临时, JSON.stringify(value, null, 2), 'utf8')
    fs.renameSync(临时, file)
    return true
  } catch (e) {
    try { fs.unlinkSync(临时) } catch { /* 没造出来，或已经 rename 走了 */ }
    throw e
  }
}

/** 把读不动的档改名留证（不删）；返回新路径，失败返回空串。 */
export function 备份坏档(file, 标签 = 'corrupt') {
  const 新 = file + '.' + 标签 + '-' + Date.now()
  try {
    fs.renameSync(file, 新)
    return 新
  } catch {
    return ''
  }
}
