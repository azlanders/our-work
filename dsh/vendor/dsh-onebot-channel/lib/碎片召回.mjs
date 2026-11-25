import { atomicWriteFileSync } from './atomic-fs.js'
// 碎片召回.mjs —— 没人搭话的时候，她自己想起一件旧事。
//
// 只在「空场」用：抽一条 weight≥0.6 的碎片，套一句模糊的转述，4 小时冷却。
// 和 碎片话题.mjs 不是重复文件：那个是「当前对话里提到了旧事里的词」才翻出来，
// 判定方式（滑窗找词）、阈值（0.75）、冷却（2 小时）都不一样。合并会毁掉两边语义。
//
// 2026-11-05 清理：这个文件原来还有一套异步实现（recall / candidates / sentence /
// recallLine / __test），跟下面的 recallLineSync 是同一件事的两份代码，而且冷却检查不一样 ——
// 异步版只查 碎片冷却.json，同步版两个冷却文件都查（SHARED_COOLDOWN 那条注释说的「共用冷却」）。
// 全项目没有任何地方调用异步那套（poll.js 只用 recallLineSync），所以整段删掉，
// 只留实际生效的这一份，行为不变。读文件的缓存也抽到 碎片公共.mjs 了。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { 读碎片文件 } from './碎片公共.mjs';

const FRAGMENTS = `${QQ_WS}/记忆/碎片.jsonl`;
const COOLDOWN = `${QQ_WS}/记忆/碎片冷却.json`;
const FOUR_HOURS = 4 * 60 * 60 * 1000;

// 同步版：给 poll.js 的 voiceHint 用（那边是同步拼提示）
export function recallLineSync(state = {}) {
  try {
    const mood = Number(state.mood ?? 0);
    const sleepy = Number(state.sleepy ?? 0);
    if (!(mood <= -0.4 || sleepy >= 70)) return '';
    // SHARED_COOLDOWN 2026-11-03：情绪闪回与话题闪回共用冷却，任一触发过都要等
    let __lastAt = 0;
    for (const f of [COOLDOWN, `${QQ_WS}/记忆/话题冷却.json`]) {
      try { if (existsSync(f)) { const __c = JSON.parse(readFileSync(f, 'utf8')); __lastAt = Math.max(__lastAt, Number(__c.lastAt || 0)); } } catch { /* 忽略单文件 */ }
    }
    if (Date.now() - __lastAt < FOUR_HOURS) return '';
    if (!existsSync(FRAGMENTS)) return '';
    const pool = [];
    for (const line of 读碎片文件(FRAGMENTS, (p) => readFileSync(p, 'utf8')).split('\n')) {
      if (!line.trim()) continue;
      try {
        const o = JSON.parse(line);
        if (Number(o.weight || 0) >= 0.6 && String(o.scene || '').trim() !== '') pool.push(String(o.scene).trim());
      } catch { /* 跳过坏行 */ }
    }
    if (pool.length === 0) return '';
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const scene = pick.length > 40 ? pick.slice(0, 40) + '…' : pick;
    // REDLINE 2026-11-17（批次622）：只递素材，不替她生成第一人称回忆句。
    const line = '[旧事素材·模糊] ' + scene + '（什么时候的记不清了；提不提、怎么提由你定）';
    try { atomicWriteFileSync(COOLDOWN, JSON.stringify({ lastAt: Date.now() })); } catch { /* 冷却写不进也不影响返回 */ }
    return line;
  } catch { return ''; }
}
