import fs from 'node:fs/promises';
import path from 'node:path';

// ENTRY_GUARD 2026-11-14（批次459）：被 import 时不要跑主流程。
// 冒烟测试「逐个 import」会把每个 .mjs 当 CLI 真跑一遍（457 实测一次写 16 个真档），
// 而这些脚本顶层就是整条流程。只有 `node <本文件>` 才执行下面的主流程；被 import 时是空模块。
// 用 __path/__fileURLToPath 这两个别名，避免和各文件已有的 path/join 撞名。
import __path from 'node:path'
import { fileURLToPath as __fileURLToPath } from 'node:url'
const 是入口 = (() => {
  try { return !!process.argv[1] && __path.resolve(process.argv[1]) === __fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {

const 根 = '{{BOT_ROOT}}/记忆';
const 参数 = process.argv.slice(2);
const 取值 = (名) => {
  const i = 参数.indexOf(名);
  return i >= 0 ? 参数[i + 1] : undefined;
};
// 用北京时间计算“今天”，避免服务器时区影响。
const 今天 = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());
const day = 取值('--day') || 今天;
const out = 取值('--out') || path.join(根, `手账-${day}.md`);
const 只打印 = 参数.includes('--print');
// BACKFILL 2026-11-17（批次632）：补写历史日时，资产/状态/内心都是“现在”的，
// 写进去等于把今天的位置、钱、精力和心气串到过去。历史日只写当时有留痕的事实，
// 当前状态一律不读、不写。
const 是今天 = day === 今天;

try {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--day 必须是 YYYY-MM-DD');
  const 读Json = async (p, d) => { try { return JSON.parse(await fs.readFile(p, 'utf8')) } catch { return d } }
  // STATE_OPT 2026-11-17（批次634）：状态.json 缺了/坏了不该让整份手账生成失败（还静默退出 0）。
  const 资产档 = await 读Json(path.join(根, '资产.json'), {});
  const 状态档 = await 读Json(path.join(根, '状态.json'), {});
  const 资产 = 资产档 !== null && typeof 资产档 === 'object' && !Array.isArray(资产档) ? 资产档 : {};
  const 状态 = 状态档 !== null && typeof 状态档 === 'object' && !Array.isArray(状态档) ? 状态档 : {};
  const 条目 = (Array.isArray(资产.记录) ? 资产.记录 : [])
    .filter((r) => typeof r?.at === 'string' && r.at.startsWith(day))
    .sort((a, b) => a.at.localeCompare(b.at));
  const 行 = [`# ${day} 手账`, ''];
  if (条目.length) {
    for (const r of 条目) 行.push(`- ${r.at.slice(11, 16)} · ${r.what}`);
  } else {
    行.push(是今天 ? '今天没什么可记的。' : '这天没什么可记的。');
  }
  const 包 = Array.isArray(资产.包) ? 资产.包 : [];
  // SLEEP_LINE 2026-11-03：那天睡得怎么样也记一笔
  try {
    const sp = path.join(根, '睡眠.json')
    const sj = JSON.parse(await fs.readFile(sp, 'utf8'))
    const ls = sj && sj.last_sleep ? sj.last_sleep : null
    if (ls && String(ls.end || '').startsWith(day)) {
      行.push('', '这一觉：' + String(ls.start || '?') + ' → ' + String(ls.end || '?') + '，深睡 ' + Math.round(ls.deep_min || 0) + ' 分、REM ' + Math.round(ls.rem_min || 0) + ' 分、质量 ' + (Number(ls.quality || 0)).toFixed(2))
    }
  } catch { /* 没有就算了 */ }
  // MUSIC_LINE 2026-11-12：如果今天跟主人一起听过歌，留一笔进手账，以后翻旧账或写日记都记得住
  try {
    const 歌 = JSON.parse(await fs.readFile(path.join(根, '一起听.json'), 'utf8'))
    if (歌 && 歌.ok && !歌.disabled && 歌.playTime) {
      const 歌日 = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Number(歌.playTime)))
      if (歌日 === day && 歌.name) {
        const 单 = Array.isArray(歌.recent3) && 歌.recent3.length ? 歌.recent3.slice(0, 2).join('、') : `${歌.name}${歌.artist ? ' - ' + 歌.artist : ''}`
        行.push('', `一起听过的歌：${单}`)
      }
    }
  } catch { /* 没有就算了 */ }
  // SICK_LINE 2026-11-08（批次224）：病过要留痕。不写的话，过一周她自己都不记得病过。
  try {
    const 病 = JSON.parse(await fs.readFile(path.join(根, '疾病.json'), 'utf8'))
    for (const h of (病.史 || []).filter((x) => String(x.好At || '').startsWith(day))) {
      行.push('', `这几天病了一场（${h.名}），今天好了。`)
    }
    if (是今天) for (const x of (病.当前 || [])) {
      行.push('', `还病着（${x.名} ${Math.round(Number(x.重 || 0) * 100)}%），${(x.症状 || []).slice(0, 2).join('、')}。`)
    }
  } catch { /* 没有就算了 */ }
  // MOOD_LINE 2026-11-03：把当时的心气也记下来，别写成工单流水
  if (是今天) try {
    const innerP = path.join(根, '内心.md')
    const inner = await fs.readFile(innerP, 'utf8').catch(() => '')
    if (inner.trim() !== '') 行.push('', '那天的心气：' + inner.trim().replace(/\s+/g, ' ').slice(0, 120))
  } catch { /* 没有就算了 */ }
  if (是今天) {
    行.push('', `今天：位置 ${资产.位置 ?? '?'} · 钱 ${资产.钱 ?? '?'} · 包里有 ${包.length} 件 · 精力 ${状态.energy ?? '?'}`, '');
  } else {
    // 旧文件可能本来就是“那天写的”，已经带真实的 今天：/那天的心气： 行；补写时保住它们。
    const 旧文 = await fs.readFile(out, 'utf8').catch(() => '');
    const 旧今天 = (旧文.match(/^今天：.*$/m) || [])[0] || '';
    const 旧心气 = (旧文.match(/^那天的心气：.*$/m) || [])[0] || '';
    if (旧今天 || 旧心气) {
      if (旧今天) 行.push('', 旧今天);
      if (旧心气) 行.push('', 旧心气);
    } else {
      行.push('', '（历史补记：当时的位置、钱、包和精力没有留档）', '');
    }
  }
  const 正文 = 行.join('\n');
  if (只打印) {
    process.stdout.write(正文);
  } else {
    await fs.mkdir(path.dirname(out), { recursive: true });
    // ATOMIC 2026-11-05（批次84）：每 30 分钟重写一次之后，她随时可能在读这个文件。
    // 先写 .tmp 再 rename —— rename 是原子的，读的人要么看到旧的整份，要么看到新的整份，
    // 不会看到写了一半的正文。幂等：重复运行结果一致。
    const 临时 = out + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    await fs.writeFile(临时, 正文, 'utf8');
    await fs.rename(临时, out);
  }
} catch (e) {
  console.error(`手账生成失败：${e?.message || e}`); // cron 任务仍以成功状态退出。
}
// cron：crontab -e，加入下一行（路径可按实际 Node 位置调整）
// SCHEDULE 2026-11-05（批次84）：从「一天一次」改成每 30 分钟。
// 错开 活动.mjs --tick 的 0/30 分，这样每次刷新都能拿到刚 tick 完的最新状态。
// 5,35 * * * * /usr/local/bin/node {{BOT_ROOT}}/共享/工具/手账.mjs >> {{BOT_ROOT}}/记忆/手账-cron.log 2>&1
}
