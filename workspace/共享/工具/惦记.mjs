import fs from 'node:fs'
import path from 'node:path'

const 生理惦记 = new Set(['该喝口水了', '有点空了，找点吃的'])

export function 写惦记(dir, what, at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), who = '') {
  const p = path.join(dir, '惦记.jsonl')
  fs.appendFileSync(p, JSON.stringify({ what: String(what), at: String(at), ...(who ? { who: String(who) } : {}) }) + '\n')
}

export function 销账生理惦记(dir, what, at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')) {
  const target = String(what ?? '')
  if (!生理惦记.has(target)) return false
  const p = path.join(dir, '惦记.jsonl')
  let rows = []
  try { rows = fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) } catch { return false }
  const latest = rows.filter((x) => x && String(x.what ?? '') === target).at(-1)
  if (!latest || latest.done === true) return false
  fs.appendFileSync(p, JSON.stringify({ what: target, at: String(at), done: true }) + '\n')
  return true
}

export function 可顺嘴问(x, peer) {
  if (!x || typeof x !== 'object' || x.done === true || !x.who) return false
  if (生理惦记.has(String(x.what ?? ''))) return false
  return String(x.who) === String(peer ?? '')
}

export function 可记内心(x) {
  return Boolean(x && typeof x === 'object' && x.done !== true && x.who && !生理惦记.has(String(x.what ?? '')))
}
