import fs from 'node:fs';
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
// DRY_GUARD 2026-11-04：本脚本没有 --dry 语义，传了就直接退出，避免「以为在演练、其实真写」
if (process.argv.includes('--dry')) { console.log('（碎片.mjs 不支持 --dry，已跳过；真跑请去掉该参数）'); process.exit(0) }

const DIR = '{{BOT_ROOT}}/记忆', OUT = path.join(DIR, '碎片.jsonl');
const BAK = '/root/bak2/碎片.jsonl.bak', argv = process.argv.slice(2);
const preview = argv.includes('--print'), di = argv.indexOf('--days');
let days = di >= 0 ? Number(argv[di + 1]) : 7;
if (!Number.isFinite(days) || days < 1) days = 7;
const pad = n => String(n).padStart(2, '0');
// BJ_DATE_FIX 2026-11-03：服务器 UTC，日期一律按北京时间取，否则「最近 N 天」会漏掉当天
const day = d => { const b = new Date(d.getTime() + 8 * 3600 * 1000); return `${b.getUTCFullYear()}-${pad(b.getUTCMonth() + 1)}-${pad(b.getUTCDate())}`; };
const cut = (s, n) => [...s].slice(0, n).join('');
const clean = s => cut(s.replace(/https?:\/\/\S+|@\S+/g, '').replace(/（[^）]*含配送费[^）]*）/g, '')
  .replace(/\s+/g, ' ').replace(/^(心情|感觉|状态)[:：，,\s]*/, '')
  .replace(/^[\s:：·，,。；;]+|[\s:：·，,]+$/g, '').trim(), 40);
const tagRules = [
  ['夜里', /夜|晚|凌晨|半夜/], ['白天', /白天|上午|中午|下午|早上|清晨/],
  ['钱', /钱|工资|买|花了|元|块/], ['打工', /打工|上班|工作|下班/],
  ['走路', /走路|散步|走回/], ['逛街', /逛街|商场|街上/],
  ['聊天', /聊天|聊了|说话/], ['吵架', /吵架|吵了|争执/],
  ['别扭', /别扭|尴尬|赌气/], ['梦', /梦|梦见/],
  ['改东西', /改|代码|脚本|修复|写东西/], ['吃东西', /吃|饭|喝|零食/],
  ['等', /等|排队/], ['冷', /冷|冻|凉/], ['暖', /暖|热|太阳/]
];
function make(at, kind, raw, fileDay) {
  const scene = clean(raw);
  if (!scene || /^(心情|感觉|状态)/.test(scene)) return null;
  const age = Math.floor((new Date(day(new Date()) + 'T00:00:00') - new Date(fileDay + 'T00:00:00')) / 864e5);
  let weight = age < 1 ? 0.9 : age < 3 ? 0.7 : 0.5;
  // FRAG_WEIGHT 2026-11-05：带情绪的事更容易被想起 —— 这是记忆规律，不是替她判感受。
  // 原来词表是 /难受|开心|气|怕|想/，太松：「想买点东西」的「想」、「今天天气」的「气」
  // 全都命中，等于给一半碎片都加了权重，那这个加权就没意义了。
  // 收紧成完整词；宁可少加，也别让它变成「什么都被记得更牢」。
  if (/难受|开心|害怕|生气|委屈|高兴|难过|心疼/.test(raw)) weight += 0.1;
  return { at, kind, scene, tags: tagRules.filter(([, r]) => r.test(raw)).map(([t]) => t).slice(0, 2), weight: Math.min(1, weight) };
}
function extract(text, kind, date) {
  const out = [];
  if (kind === '梦') {
    const m = text.match(/^余味[:：]\s*(.+)$/m);
    if (m) out.push(make(`${date} 00:00`, kind, m[1], date));
  } else if (kind === '手账') {
    for (const m of text.matchAll(/^-\s+(\d{1,2}:\d{2})\s*·\s*(.+)$/gm)) {
      out.push(make(`${date} ${pad(m[1].split(':')[0])}:${m[1].split(':')[1]}`, kind, cut(m[2], 30), date));
      if (out.length === 2) break;
    }
  } else {
    const hs = [...text.matchAll(/^##\s+(\d{1,2}:\d{2})\s*·\s*(.+)$/gm)];
    for (let i = 0; i < hs.length && out.length < 2; i++) {
      const body = text.slice(hs[i].index + hs[i][0].length, hs[i + 1]?.index ?? text.length);
      const first = body.trim().split(/[。！？!?\n]/).find(s => s.trim()) || '';
      const hm = hs[i][1].split(':');
      out.push(make(`${date} ${pad(hm[0])}:${hm[1]}`, kind, `${hs[i][2]}：${cut(first.trim(), 30)}`, date));
    }
  }
  return out.filter(Boolean);
}
try {
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').split('\n').filter(Boolean)
    .flatMap(s => { try { return [JSON.parse(s)]; } catch { return []; } }) : [];
  const oldKeys = new Set(old.map(x => cut(x.scene || '', 12))), fresh = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() + 8 * 3600 * 1000 - i * 864e5);
    const date = day(d);
    for (const kind of ['心里话', '手账', '梦']) {
      const file = path.join(DIR, `${kind}-${date}.md`);
      if (fs.existsSync(file)) fresh.push(...extract(fs.readFileSync(file, 'utf8'), kind, date));
    }
  }
  const added = fresh.filter(x => !oldKeys.has((x.scene || ''))).length;
  if (preview) {
    console.log(`新增 ${added} 条`);
    fresh.filter(x => !oldKeys.has((x.scene || ''))).slice(0, 3).forEach(x => console.log(JSON.stringify(x)));
  } else {
    const merged = new Map();
    for (const x of [...old, ...fresh]) {
      const k = (x.scene || ''), prev = merged.get(k);
      if (!prev || x.weight > prev.weight) merged.set(k, x);
    }
    const all = [...merged.values()].sort((a, b) => b.weight - a.weight).slice(0, 80)
      .sort((a, b) => a.at.localeCompare(b.at));
    fs.mkdirSync(path.dirname(BAK), { recursive: true });
    if (fs.existsSync(OUT)) fs.copyFileSync(OUT, BAK);
    fs.writeFileSync(OUT, all.map(x => JSON.stringify(x)).join('\n') + (all.length ? '\n' : ''));
    console.log(`写入 ${all.length} 条，新增 ${added} 条`);
  }
} catch (e) {
  console.log(`处理失败：${e.message}`);
  process.exit(0);
}
// cron（每天 4:30）：30 4 * * * cd {{BOT_ROOT}}/记忆 && /usr/bin/node 碎片.mjs >> 碎片.log 2>&1
// 预览不写盘：node 碎片.mjs --print --days 7
}
