import { 原子写 } from './_底层.mjs'
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

const DIR = '{{BOT_ROOT}}/记忆';
const OUT = path.join(DIR, '生长记录.json');
const BAK = `${process.env.BACKUP_DIR || '/root/bak2'}/生长记录.json.bak`;
const PRINT = process.argv.includes('--print'); // --week 为兼容参数，直接忽略
const readJson = (name, fallback) => {
  try { return JSON.parse(fs.readFileSync(path.join(DIR, name), 'utf8')); }
  catch { return fallback; }
};
const readText = name => {
  try { return fs.readFileSync(path.join(DIR, name), 'utf8'); } catch { return ''; }
};
const day = s => {
  const m = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
};
// TZ_FIX_GROWTH 2026-11-03：日期按北京时间，别用服务器 UTC
const iso = (d) => { const b = new Date((d instanceof Date ? d.getTime() : d) + 8 * 3600 * 1000); return b.toISOString().slice(0, 10) }
const now = new Date(), start = day(iso(now));
start.setDate(start.getDate() - ((start.getDay() + 6) % 7)); // 周一为一周起点
const end = new Date(start); end.setDate(end.getDate() + 7);
const lastStart = new Date(start); lastStart.setDate(lastStart.getDate() - 7);
const inWeek = (d, a = start, b = end) => d && d >= a && d < b;
const compare = (cur, old, faster = true) => {
  if (cur == null || old == null || Math.abs(cur - old) < 1e-9) return '持平';
  const up = cur > old;
  return (faster ? !up : up) ? '变快' : '变慢';
};

try {
  const old = readJson('生长记录.json', {});
  const files = fs.readdirSync(DIR);
  const journals = { current: [], previous: [] };
  for (const file of files) {
    const m = file.match(/^手账-(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    const d = day(m[1]), which = inWeek(d) ? 'current' : inWeek(d, lastStart, start) ? 'previous' : null;
    if (!which) continue;
    for (const line of readText(file).split(/\r?\n/)) {
      const hit = line.match(/^\s*-\s+\d{1,2}:\d{2}\s*·\s*(.+)$/);
      if (hit) journals[which].push(hit[1]);
    }
  }

  // 只统计本周开始、且已有结束时间的别扭记录。
  const people = readJson('别扭.json', { people: {} }).people || {};
  const hours = Object.values(people).flatMap(x => {
    const a = new Date(x?.since), b = new Date(x?.until);
    return x?.until && inWeek(day(x.since)) && Number.isFinite(+a) && Number.isFinite(+b) && b >= a
      ? [(+b - +a) / 3600000] : [];
  });
  const ice = hours.length ? Math.round(hours.reduce((a, b) => a + b, 0) / hours.length * 10) / 10 : null;

  const impressions = Object.values(readJson('印象.json', {})).filter(x => typeof x === 'string' && x.trim());
  const concrete = /["“”「」『』]|说过|跑去|熬夜|改东西|哄/;
  const granularity = impressions.length
    ? Math.max(20, Math.round(impressions.filter(x => concrete.test(x)).length / impressions.length * 100)) : 0;

  const chain = readText('链.md');
  const headings = [...chain.matchAll(/^##\s+(\d{4}-\d{2}-\d{2})(?:\s+[^\n]*)?$/gm)];
  let total = 0, unresolved = 0;
  headings.forEach((h, i) => {
    if (!inWeek(day(h[1]))) return;
    total++;
    const block = chain.slice(h.index + h[0].length, headings[i + 1]?.index ?? chain.length);
    const u = block.match(/^\s*-\s*未决：\s*(.*)$/m);
    if (u && u[1].trim() && !/^[（(]?\s*(无|没有|暂无|none)\s*[）)]?$/i.test(u[1].trim())) unresolved++;
  });
  const pendingRate = total ? Math.round(unresolved / total * 1000) / 1000 : 0;

  // HABIT_AUTO 2026-11-03：习惯从本周手账里自动抽动作，不再写死六个词
  const 动作标签 = {
    走到: '爱到处走', 走路: '爱到处走', 打工: '常去打零工', 逛街: '爱逛街',
    学习: '爱翻小抄', 翻小抄: '爱翻小抄', 熬夜: '常熬夜', 哄: '会哄人',
    发呆: '爱发呆', 戳人: '爱戳人',
  };
  const 常见动作 = Object.keys(动作标签).sort((a, b) => b.length - a.length);
  const 提取动作 = (line) => {
    const rawLine = String(line ?? '');
    const parts = rawLine.split('·');
    let text = (parts.length > 1 ? parts.slice(1).join('·') : rawLine)
      .replace(/(?:\([^)]*\)|（[^）]*）|【[^】]*】|\[[^\]]*\])/g, '')
      .replace(/[0-9０-９]/g, '').trim().replace(/^[^\p{Script=Han}]+/u, '');
    if (!text) return '';
    const known = 常见动作.find((v) => text.startsWith(v));
    if (known) return known;
    let action = '';
    for (const char of text) {
      if ('了在到'.includes(char) || !/\p{Script=Han}/u.test(char)) break;
      action += char;
      if (action.length === 4) break;
    }
    if (action.length < 2 || action.startsWith('吃') ||
      /^(哈|呵|嗯|啊|呀|哦|欸|唉|哎|啦|吧|呢|嘛|喽|咯)/.test(action)) return '';
    return action;
  };
  const oldHabits = Array.isArray(old.habits) ? old.habits : [];
  const month = iso(start).slice(0, 7);
  const 动作次数 = new Map();
  for (const line of journals.current) {
    const action = 提取动作(line);
    if (!action) continue;
    if (!动作次数.has(action)) 动作次数.set(action, { count: 0, order: 动作次数.size });
    动作次数.get(action).count += 1;
  }
  const habits = [...动作次数.entries()]
    .filter(([, info]) => info.count >= 3)
    .sort((a, b) => b[1].count - a[1].count || a[1].order - b[1].order)
    .slice(0, 3)
    .map(([action, info]) => {
      const trait = 动作标签[action] || '常' + action;
      const previous = oldHabits.find((h) => h.trait === trait);
      return { trait, strength: Math.min(0.9, info.count / 10), since: previous?.since || month };
    });

  const oldWeek = old.week || {}, oldTrend = old['16pf_delta'] || {};
  const rose = granularity > (oldWeek['认人颗粒度'] ?? granularity);
  const delta = rose ? 0.1 : 0; // 唯一映射：认人更具体，E 微涨、I 等量微降。
  // WANT_FIELD 2026-11-09（批次342）：同 做梦.mjs —— 字段是「当下想要」，不是 items
  const _wantDb = readJson('想要.json', {}) || {};
  const wantCount = ((_wantDb['当下想要'] || _wantDb.items || []).length);
  const oldWant = Number.isFinite(old.want_count) ? old.want_count : wantCount;
  const slumpActive = journals.previous.length > 0 &&
    journals.current.length < journals.previous.length * 0.6 && wantCount <= oldWant;
  const result = {
    updated_at: iso(now),
    week: { '破冰小时': ice, '认人颗粒度': granularity, '未决率': pendingRate, '手账条数': journals.current.length },
    trend: {
      '破冰': compare(ice, oldWeek['破冰小时']),
      '认人': compare(granularity, oldWeek['认人颗粒度'], false),
      '好奇心': compare(pendingRate, oldWeek['未决率'], false)
    },
    // GROWTH_ACCUMULATE 2026-11-05：两处问题一起修。
    // 1) 原来每次复盘都覆盖 16pf_delta，这周没「认人更具体」就清零，性格从来没生长过。改成累积，±2 封顶。
    // 2) 字段名写错：16PF 里是 L_怀疑性，这里写成 I_怀疑性，
    //    性格系数.mjs 的 叠增量() 按 key 找维度，永远找不到，叠加也无效。改成 L_怀疑性。
    '16pf_delta': {
      E_恃强性: Math.min(2, Math.max(-2, Number(oldTrend.E_恃强性 || 0) + delta)),
      L_怀疑性: Math.min(2, Math.max(-2, Number(oldTrend.L_怀疑性 ?? oldTrend.I_怀疑性 ?? 0) - delta)),
    },
    habits,
    slump: { active: slumpActive, reason: slumpActive ? '最近没什么想做的' : '' },
    want_count: wantCount // 供下周判断是否有新增，保证重复运行幂等。
  };
  const text = JSON.stringify(result, null, 2) + '\n';
  if (PRINT) console.log(text);
  else {
    if (fs.existsSync(OUT)) {
      fs.mkdirSync(path.dirname(BAK), { recursive: true });
      fs.copyFileSync(OUT, BAK);
    }
    原子写(OUT, text);
  }
} catch (e) {
  console.log(`复盘失败：${e.message}`); // 素材异常也正常退出。
}
}
