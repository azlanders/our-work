// 记忆存储：一条一行 JSONL，写入原子落盘，索引在内存里懒构建。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hash32 } from './text.js'

function uniqList(arr, max) {
  return [...new Set((arr || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, max)
}

export class Store {
  constructor(file) {
    this.file = file
    this.records = []
    this.byId = new Map()
    this.dirty = false
    this.touched = false
  }

  load() {
    if (!existsSync(this.file)) { this.records = []; this.byId.clear(); return this }
    const lines = readFileSync(this.file, 'utf8').split('\n')
    const records = []
    this.byId.clear()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed)
        if (!rec?.id || !rec?.text) continue
        records.push(rec)
        this.byId.set(rec.id, rec)
      } catch {
        // 坏行跳过：一行坏不能带走整库。
      }
    }
    this.records = records
    this.dirty = false
    return this
  }

  /** 同一段正文只存一次；重复写入更新使用计数，并合并新补充的关键词/标签/重要度。 */
  add({ text, keywords = [], tags = [], importance = 0.5, eventAt = null, source = null }) {
    const clean = String(text || '').trim()
    if (!clean) return null
    const id = 'm' + hash32(clean).slice(0, 10)
    const nextImp = Math.min(1, Math.max(0.05, Number(importance) || 0.5))
    const existing = this.byId.get(id)
    if (existing) {
      existing.uses = (existing.uses || 1) + 1
      existing.lastUsed = Date.now()
      if (keywords?.length) existing.keywords = uniqList([...(existing.keywords || []), ...keywords], 16)
      if (tags?.length) existing.tags = uniqList([...(existing.tags || []), ...tags], 8)
      if (nextImp > (existing.importance || 0)) existing.importance = nextImp
      if (source?.kind === 'tool') existing.source = source
      this.touched = true
      this.dirty = true
      return existing
    }
    const rec = {
      id,
      text: clean,
      keywords: uniqList(keywords, 16),
      tags: uniqList(tags, 8),
      importance: nextImp,
      createdAt: Date.now(),
      eventAt: eventAt ? Number(eventAt) : null,
      uses: 1,
      lastUsed: Date.now(),
      source: source || null,
    }
    this.records.push(rec)
    this.byId.set(id, rec)
    // 追加一行就落盘：O(1)，不像整体重写那样每写一条就把整库抄一遍。
    this.appendLine(rec)
    return rec
  }

  remove(id) {
    if (!this.byId.has(id)) return false
    this.byId.delete(id)
    this.records = this.records.filter((r) => r.id !== id)
    this.touched = true
    this.dirty = true
    return true
  }

  touch(id, count = 1) {
    const rec = this.byId.get(id)
    if (!rec) return
    rec.uses = (rec.uses || 0) + count
    rec.lastUsed = Date.now()
    this.touched = true
  }

  appendLine(rec) {
    mkdirSync(dirname(this.file), { recursive: true })
    appendFileSync(this.file, JSON.stringify(rec) + '\n')
  }

  /** 使用计数这类原地修改攒着写：rewrite 是 O(n)，不能每轮都做。 */
  flush() {
    if (!this.touched) return
    this.touched = false
    this.persist()
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true })
    const body = this.records.map((r) => JSON.stringify(r)).join('\n')
    const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    writeFileSync(tmp, body ? body + '\n' : '')
    renameSync(tmp, this.file)
    this.dirty = false
  }
}

export function defaultStorePath(home) {
  return join(home, 'mnemonic', 'memories.jsonl')
}
