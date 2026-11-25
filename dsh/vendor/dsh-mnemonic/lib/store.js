// 记忆存储：一条一行 JSONL，原子落盘、碰撞保护、容量压实。
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hash32, hashId, parseEventTimestamp, sanitizeMemoryText } from './text.js'

const DAY = 86400000

function uniqList(arr, max) {
  return [...new Set((arr || []).map((x) => String(x).trim()).filter(Boolean))].slice(0, max)
}

export class Store {
  constructor(file, { maxRecords = 5000 } = {}) {
    this.file = file
    this.maxRecords = Number(maxRecords) || 5000
    this.records = []
    this.byId = new Map()
    this.byText = new Map()
    this.dirty = false
    this.touched = false
    this.generation = 0
  }

  load() {
    if (!existsSync(this.file)) {
      this.records = []
      this.byId.clear()
      this.byText.clear()
      return this
    }
    const lines = readFileSync(this.file, 'utf8').split('\n')
    const records = []
    const idxById = new Map()
    this.byId.clear()
    this.byText.clear()
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed)
        if (!rec?.id || !rec?.text) continue
        if (idxById.has(rec.id)) {
          records[idxById.get(rec.id)] = rec
        } else {
          idxById.set(rec.id, records.length)
          records.push(rec)
        }
        this.byId.set(rec.id, rec)
        this.byText.set(rec.text, rec)
      } catch {
        // 坏行跳过：一行坏不能带走整库。
      }
    }
    this.records = records
    this.dirty = false
    this.generation += 1
    return this
  }

  /**
   * 同一段正文只存一次（按正文精确匹配 + 防哈希碰撞）；
   * 返回 { rec, isNew, metaChanged } 便于调用方区分增量建索引还是重建索引。
   */
  add({ text, keywords = [], tags = [], importance = 0.5, eventAt = null, source = null, scope = '' }) {
    const clean = sanitizeMemoryText(text)
    if (!clean) return null
    const nextImp = Math.min(1, Math.max(0.05, Number(importance) || 0.5))
    const parsedEventAt = parseEventTimestamp(eventAt)

    // 先按正文精确查找（兼容旧版 hash32 ID 与新版 hashId ID），彻底杜绝哈希碰撞误合并
    const existing = this.byText.get(clean)
    if (existing) {
      let metaChanged = false
      existing.uses = (existing.uses || 1) + 1
      existing.lastUsed = Date.now()
      if (keywords?.length) {
        const mergedKw = uniqList([...(existing.keywords || []), ...keywords], 16)
        if (JSON.stringify(mergedKw) !== JSON.stringify(existing.keywords || [])) {
          existing.keywords = mergedKw
          metaChanged = true
        }
      }
      if (tags?.length) {
        const mergedTags = uniqList([...(existing.tags || []), ...tags], 8)
        if (JSON.stringify(mergedTags) !== JSON.stringify(existing.tags || [])) {
          existing.tags = mergedTags
          metaChanged = true
        }
      }
      if (nextImp > (existing.importance || 0)) {
        existing.importance = nextImp
        metaChanged = true
      }
      if (parsedEventAt && !existing.eventAt) {
        existing.eventAt = parsedEventAt
        metaChanged = true
      }
      if (source?.kind === 'tool' && existing.source?.kind !== 'tool') {
        existing.source = source
        metaChanged = true
      }
      this.touched = true
      if (metaChanged) {
        this.dirty = true
        this.generation += 1
        this.appendLine(existing)
      }
      return existing
    }

    // 生成无碰撞 ID（若极罕见碰撞则追加后缀）
    let id = hashId(clean)
    if (this.byId.has(id)) {
      let n = 1
      while (this.byId.has(`${id}_${n}`)) n += 1
      id = `${id}_${n}`
    }

    const nowTs = Date.now()
    const rec = {
      id,
      text: clean,
      keywords: uniqList(keywords, 16),
      tags: uniqList(tags, 8),
      importance: nextImp,
      createdAt: nowTs,
      eventAt: parsedEventAt,
      uses: 1,
      lastUsed: nowTs,
      source: source || null,
      scope: scope || null,
    }
    this.records.push(rec)
    this.byId.set(id, rec)
    this.byText.set(clean, rec)
    this.appendLine(rec)

    if (this.maxRecords > 0 && this.records.length > this.maxRecords) {
      this.compact({ maxRecords: this.maxRecords })
    }
    return rec
  }

  /**
   * 容量压实：超出 maxRecords 时优先淘汰低价值陈旧 auto 归档，保留人工/tool 记忆与高重要度条目。
   */
  compact({ maxRecords = this.maxRecords, now = Date.now() } = {}) {
    if (!maxRecords || this.records.length <= maxRecords) return 0
    const scoreOf = (r) => {
      const isTool = r.source?.kind === 'tool' ? 5.0 : 0
      const imp = (Number(r.importance) || 0.5) * 2.0
      const useBoost = Math.log1p(r.uses || 1) * 0.25
      const ageDays = Math.max(0, now - (r.lastUsed || r.eventAt || r.createdAt || now)) / DAY
      return isTool + imp + useBoost - ageDays * 0.005
    }
    const ranked = this.records
      .map((r, idx) => ({ r, idx, s: scoreOf(r) }))
      .sort((a, b) => b.s - a.s)
    const keepIds = new Set(ranked.slice(0, maxRecords).map((x) => x.r.id))
    const before = this.records.length
    this.records = this.records.filter((r) => keepIds.has(r.id))
    this.byId.clear()
    this.byText.clear()
    for (const r of this.records) {
      this.byId.set(r.id, r)
      this.byText.set(r.text, r)
    }
    const evicted = before - this.records.length
    if (evicted > 0) {
      this.dirty = true
      this.generation += 1
      this.touched = false
      this.persist()
    }
    return evicted
  }


  /**
   * 周期性归并陈旧低价值 auto 记忆：把超过 maxAgeDays 天、同日内 >= minGroup 条的低分 auto 归档
   * 合并成一条按日摘要，绝不触碰 tool 记忆或高重要度（>=0.6）记忆。
   */
  consolidateOldAuto({ maxAgeDays = 30, minGroup = 3, maxDigestChars = 360, now = Date.now() } = {}) {
    const cutoff = now - maxAgeDays * DAY
    const buckets = new Map()
    for (const r of this.records) {
      if (r.source?.kind !== 'auto') continue
      if ((Number(r.importance) || 0.5) >= 0.6) continue
      const ts = r.eventAt || r.createdAt || now
      if (ts > cutoff) continue
      const dayKey = new Date(ts + 8 * 3600000).toISOString().slice(0, 10)
      if (!buckets.has(dayKey)) buckets.set(dayKey, [])
      buckets.get(dayKey).push(r)
    }
    let mergedCount = 0
    for (const [dayKey, items] of buckets.entries()) {
      if (items.length < minGroup) continue
      const snippets = items.map((r) => r.text.replace(/\s+/g, ' ').slice(0, 70))
      let digest = `[${dayKey} 对话摘要] ` + snippets.join('；')
      if (digest.length > maxDigestChars) digest = digest.slice(0, maxDigestChars - 1) + '…'
      const kw = uniqList(items.flatMap((r) => r.keywords || []), 16)
      const tags = uniqList([...items.flatMap((r) => r.tags || []), '日摘要'], 8)
      const oldestTs = Math.min(...items.map((r) => r.eventAt || r.createdAt || now))
      for (const r of items) {
        this.byId.delete(r.id)
        if (this.byText.get(r.text)?.id === r.id) this.byText.delete(r.text)
      }
      const rmSet = new Set(items.map((r) => r.id))
      this.records = this.records.filter((r) => !rmSet.has(r.id))
      this.add({
        text: digest,
        keywords: kw,
        tags,
        importance: 0.4,
        eventAt: oldestTs,
        source: { kind: 'auto-digest', merged: items.length },
      })
      mergedCount += items.length
    }
    if (mergedCount > 0) {
      this.dirty = true
      this.generation += 1
      this.touched = false
      this.persist()
    }
    return mergedCount
  }

  remove(id) {
    const rec = this.byId.get(id)
    if (!rec) return false
    this.byId.delete(id)
    if (this.byText.get(rec.text)?.id === id) this.byText.delete(rec.text)
    this.records = this.records.filter((r) => r.id !== id)
    this.touched = true
    this.dirty = true
    this.generation += 1
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

  flush() {
    if (!this.touched) return
    this.touched = false
    this.persist()
  }

  persist() {
    mkdirSync(dirname(this.file), { recursive: true })
    const body = this.records.map((r) => JSON.stringify(r)).join('\n')
    const tmp = this.file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    try {
      writeFileSync(tmp, body ? body + '\n' : '')
      renameSync(tmp, this.file)
    } catch (err) {
      try { if (existsSync(tmp)) unlinkSync(tmp) } catch (_err) { console.error('[mnemonic]', _err?.message || _err) }
      throw err
    }
    this.dirty = false
  }
}

export function defaultStorePath(home) {
  return join(home, 'mnemonic', 'memories.jsonl')
}
