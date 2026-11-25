/**
 * memory.js — "这个文件我看过，看到哪了"
 *
 * 只存能证明"看过"的机械指标（路径、时间窗、格数、刀数、时刻），不存模型输出。
 */

import { appendFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { cacheDir } from './cache.js';

const FILE = 'seen.jsonl';
const MAX_LINES = 400;
const PRUNE_CHECK_BYTES = MAX_LINES * 140;
const TZ_OFFSET_MS = 8 * 3600 * 1000;

const norm = (p) => String(p ?? '').replace(/\\/g, '/').toLowerCase();

export function memoryPath(env = process.env) {
  return join(cacheDir(env), FILE);
}

export async function remember(info, look, { env = process.env, at = Date.now() } = {}) {
  if (!info?.path) return;
  const rec = {
    path: norm(info.path),
    duration: +(info.duration ?? 0).toFixed(2),
    from: +Number(look.from ?? 0).toFixed(2),
    to: +Number(look.to ?? info.duration ?? 0).toFixed(2),
    cells: look.cells ?? 0,
    cuts: look.cuts ?? 0,
    at,
  };
  const file = memoryPath(env);
  try {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(rec)}\n`, 'utf8');
    // 先按文件体积粗判，避免每次 remember 都全量读盘做 prune
    const st = await stat(file);
    if (st.size > PRUNE_CHECK_BYTES) await prune(env);
  } catch (err) {
    console.error('[storyboard:memory]', err?.message || err);
  }
}

/** 读到这个文件的所有历史记录（按时间倒序）。 */
export async function recall(info, { env = process.env } = {}) {
  if (!info?.path) return { entries: [], lastAt: null, windows: 0 };
  try {
    const raw = await readFile(memoryPath(env), 'utf8');
    const key = norm(info.path);
    const entries = raw.split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { /* 跳过损坏单行 */ return null; } })
      .filter((r) => r && r.path === key)
      .sort((a, b) => b.at - a.at);
    return {
      entries,
      lastAt: entries[0]?.at ?? null,
      windows: new Set(entries.map((e) => `${e.from}-${e.to}`)).size,
    };
  } catch (err) {
    if (err?.code !== 'ENOENT') console.error('[storyboard:memory]', err?.message || err);
    return { entries: [], lastAt: null, windows: 0 };
  }
}

/** 只保留最近 MAX_LINES 条，走 pid+random 临时文件原子替换。 */
async function prune(env) {
  const file = memoryPath(env);
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const raw = await readFile(file, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length <= MAX_LINES) return;
    await writeFile(tmp, `${lines.slice(-MAX_LINES).join('\n')}\n`, 'utf8');
    await rename(tmp, file);
  } catch (err) {
    try { await unlink(tmp); } catch { /* 临时文件可能尚未创建 */ }
    console.error('[storyboard:memory:prune]', err?.message || err);
  }
}

/**
 * 给清单用的一句话；统一使用 UTC+8 北京时间格式。
 */
export async function describeMemory(info, { env = process.env } = {}) {
  const m = await recall(info, { env });
  if (!m.windows) return null;
  const d = new Date(Number(m.lastAt) + TZ_OFFSET_MS);
  const pad = (n) => String(n).padStart(2, '0');
  const when = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  const ranges = [...new Set(m.entries.map((e) => `${e.from}-${e.to}s`))].slice(0, 4).join(', ');
  return `${m.windows} window(s) analysed before (${ranges}), last on ${when}. ` +
    'If you already described this file, cite that instead of describing it again.';
}
