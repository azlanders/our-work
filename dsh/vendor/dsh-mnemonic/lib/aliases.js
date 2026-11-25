// 实体/人物别名归一化：解决「同一人/同一事换个称呼就召回不到」的盲区。
// 支持从 aliases.json 加载（可选）或直接通过 config.aliases 传入 { "主名": ["别名1", "别名2"] }。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export function normalizeAliasGroups(raw = {}) {
  const groups = []
  if (!raw || typeof raw !== 'object') return groups
  for (const [canon, alts] of Object.entries(raw)) {
    const members = [...new Set([canon, ...(Array.isArray(alts) ? alts : [])].map((x) => String(x || '').trim()).filter((x) => x.length >= 2))]
    if (members.length >= 2) groups.push(members)
  }
  return groups
}

export function loadAliasGroups(storePath, inlineAliases = null) {
  const merged = {}
  if (storePath) {
    const file = join(dirname(storePath), 'aliases.json')
    if (existsSync(file)) {
      try {
        const parsed = JSON.parse(readFileSync(file, 'utf8'))
        if (parsed && typeof parsed === 'object') Object.assign(merged, parsed)
      } catch (_err) {
        console.error('[mnemonic:aliases]', _err?.message || _err)
      }
    }
  }
  if (inlineAliases && typeof inlineAliases === 'object') {
    Object.assign(merged, inlineAliases)
  }
  return normalizeAliasGroups(merged)
}

/** 若查询命中某实体组内的任一称呼，返回该组其余别名（空格分隔），供检索加权扩展。 */
export function expandAliases(query, groups = []) {
  if (!groups?.length) return ''
  const lower = String(query || '').toLowerCase()
  if (!lower) return ''
  const extra = new Set()
  for (const members of groups) {
    const matched = members.some((m) => lower.includes(m.toLowerCase()))
    if (!matched) continue
    for (const m of members) {
      if (!lower.includes(m.toLowerCase())) extra.add(m)
    }
  }
  return extra.size ? [...extra].join(' ') : ''
}
