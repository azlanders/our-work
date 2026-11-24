import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { 睡着 } from './睡态.mjs';
import * as 待办 from './待办.mjs'; // TODO_SELFCHECK 2026-11-14（批次434）

const ROOT = '{{BOT_ROOT}}', MEM = `${ROOT}/记忆`, TOOLS = `${ROOT}/共享/工具`, PRINT = process.argv.includes('--print');
const pad = n => String(n).padStart(2, '0');
const bj = new Date(Date.now() + 8 * 3600 * 1000);
const today = `${bj.getUTCFullYear()}-${pad(bj.getUTCMonth() + 1)}-${pad(bj.getUTCDate())}`;
const bjHour = bj.getUTCHours();
const isSleeping = (() => { try { return 睡着(MEM) === true; } catch { return false; } })();
const result = { 告警: [], 注意: [], 通过: [] }, tips = new Set();
const fmtAge = ms => ms < 36e5 ? `${Math.floor(ms / 6e4)} 分钟` : ms < 864e5 ? `${(ms / 36e5).toFixed(1)} 小时` : `${Math.floor(ms / 864e5)} 天`;
const add = (level, item, text, tip) => {
  result[level].push(`[${item}] ${text}`);
  if (tip && level !== '通过') tips.add(tip);
};
const run = (name, fn) => { try { fn(); } catch (e) { console.log(`跳过：${name}（${e.message}）`); } };
const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const fresh = (file, minutes) => {
  const p = `${MEM}/${file}`;
  if (!fs.existsSync(p)) return add('告警', '数据新鲜度', `${file} 不存在`, '优先补跑记忆写入或心跳任务，恢复核心数据更新。');
  const age = Date.now() - fs.statSync(p).mtimeMs;
  add(age > minutes * 6e4 ? '告警' : '通过', '数据新鲜度', `${file} 距更新 ${fmtAge(age)}（阈值 ${minutes} 分钟）`,
    '优先补跑记忆写入或心跳任务，恢复核心数据更新。');
};

// 1. 核心记忆文件的更新时间（内心.mjs 在睡着时跳过属正常设计，睡时放宽阈值至 14 小时）。
run('数据新鲜度', () => {
  fresh('内心.md', isSleeping ? 840 : 90);
  fresh('状态.json', 120);
  fresh('印象.json', 10080);
  fresh('生长记录.json', 10080);
  for (const file of [`手账-${today}.md`, `梦-${today}.md`]) {
    const exists = fs.existsSync(`${MEM}/${file}`);
    if (exists) add('通过', '数据新鲜度', `${file} 已存在`);
    else if (file.startsWith('梦-')) {
      // 只有醒来时才记梦；还在睡或凌晨未睡醒前没生成都正常
      add(bjHour >= 12 && !isSleeping ? '注意' : '通过', '数据新鲜度', `${file} ${isSleeping ? '她还在睡，醒来后生成' : '今日暂无新梦'}`);
    } else if (bjHour >= 4) {
      add('告警', '数据新鲜度', `${file} 尚未生成`, '检查手账生成任务，缺失时手动补跑。');
    } else {
      add('通过', '数据新鲜度', `${file} 未到 04:00 检查时点`);
    }
  }
});

// 2. 心跳表 + crontab 与最近日志交叉检查。
run('定时任务健康', () => {
  const cron = String(execFileSync('sh', ['-c', 'crontab -l 2>/dev/null || true'], { encoding: 'utf8' }));
  const cronJobs = cron.split('\n').filter(s => !s.trim().startsWith('#')).flatMap(s => s.match(/[^\s"']+\.mjs/g) || []);
  let hbJobs = [];
  try {
    const hb = readJSON(`${TOOLS}/心跳表.json`);
    hbJobs = (hb.任务 || []).map(t => t.脚本).filter(Boolean);
  } catch {}
  const jobs = [...new Set([...cronJobs.map(x => path.basename(x)), ...hbJobs.map(x => path.basename(x))])];
  const rlog = fs.existsSync(`${MEM}/日志/日常.log`) ? `${MEM}/日志/日常.log` : `${MEM}/日常.log`;
  const lines = fs.existsSync(rlog) ? fs.readFileSync(rlog, 'utf8').split('\n').slice(-300) : [];
  const errors = {};
  for (const line of lines) if (/错误|Error|ENOENT|SyntaxError|ReferenceError|TypeError/.test(line)) {
    const script = line.match(/[^\s"']+\.mjs/g)?.at(-1); if (!script) continue;
    const key = path.basename(script), time = line.match(/\d{4}[-/]\d\d[-/]\d\d[ T]\d\d:\d\d(?::\d\d)?/)?.[0] || '时间未知';
    (errors[key] ||= { count: 0, time }).count++; errors[key].time = time;
  }
  add('通过', '定时任务健康', `心跳与 cron 共纳管 ${jobs.length} 个脚本（心跳表 ${hbJobs.length} 条）`);
  for (const [name, e] of Object.entries(errors))
    add('注意', '定时任务健康', `${name} 最近 300 行异常 ${e.count} 次，最后 ${e.time}`, '排查最近抛错的定时脚本。');
  if (!Object.keys(errors).length) add('通过', '定时任务健康', '最近 300 行日常日志未发现脚本异常');
});

// 3. 工具目录的静态健康扫描（排除本文件自身字面量，仅告警 0 字节文件或裸 CommonJS require）。
run('代码静态健康', () => {
  const files = fs.readdirSync(TOOLS).filter(x => x.endsWith('.mjs') && x !== '自我巡检.mjs');
  const zero = [], cjs = [];
  for (const file of files) {
    const p = `${TOOLS}/${file}`;
    const st = fs.statSync(p);
    if (st.size === 0) { zero.push(file); continue; }
    const txt = fs.readFileSync(p, 'utf8');
    const stripped = txt.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(['"`])(?:\\.|(?!\1)[\s\S])*?\1/g, '');
    if (/(?:^|[^.\w])require\s*\(/.test(stripped) && !txt.includes('createRequire')) cjs.push(file);
  }
  if (zero.length) add('告警', '代码静态健康', `发现 0 字节空脚本：${zero.join('、')}`, '立即从备份恢复空脚本。');
  if (cjs.length) add('注意', '代码静态健康', `ESM 脚本含裸 require()：${cjs.join('、')}`, '改用 import 或 createRequire。');
  if (!zero.length && !cjs.length) add('通过', '代码静态健康', `扫描 ${files.length} 个 .mjs 工具，无空文件或裸 require`);
});

// 4. 未决惦记（按追加日志聚合最终状态：同名后追加 done:true 即视为已销账！）与链末尾。
run('她的未决事项', () => {
  const rows = fs.existsSync(`${MEM}/惦记.jsonl`)
    ? fs.readFileSync(`${MEM}/惦记.jsonl`, 'utf8').split(/\r?\n/).filter(Boolean).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean)
    : [];
  const byWhat = new Map();
  for (const r of rows) {
    const k = String(r.what || '').trim();
    if (k) byWhat.set(k, r);
  }
  const open = [...byWhat.values()].filter(x => x.done !== true);
  const times = open.map(x => Date.parse(String(x.at || x.createdAt || '').replace(' ', 'T') + '+08:00')).filter(Number.isFinite);
  const oldest = times.length ? `，最老已 ${fmtAge(Date.now() - Math.min(...times))}` : '';
  add(open.length > 5 ? '注意' : '通过', '她的未决事项', open.length ? `当前未决惦记 ${open.length} 条${oldest}` : '当前无悬置未决惦记', '处理长期悬置的惦记。');
  const tail = fs.existsSync(`${MEM}/链.md`) ? fs.readFileSync(`${MEM}/链.md`, 'utf8').split('\n').filter(x => x.trim()).slice(-5) : [];
  const pending = tail.map(x => x.match(/未决[：:]\s*(.+)/)?.[1]?.trim()).filter(x => x && !/^(无|暂无|空|-|（没有）)$/.test(x));
  add(pending.length > 3 ? '注意' : '通过', '她的未决事项', pending.length ? `链尾未决：${pending.join('；')}` : '链尾 5 条无积压未决项');
});

// 5. 互动与关系健康。
run('关系健康', () => {
  const favorRaw = readJSON(`${MEM}/好感度.json`);
  const favor = (favorRaw && favorRaw.people) ? favorRaw.people : (favorRaw || {});
  const __lastMs = (v) => {
    const raw = v?.last;
    if (Number(raw) > 1e11) return Number(raw);
    const t = Date.parse(String(raw || '').replace(' ', 'T') + '+08:00');
    return Number.isFinite(t) ? t : 0;
  };
  const stale = Object.entries(favor).filter(([, v]) => {
    const t = __lastMs(v);
    return t > 0 && Date.now() - t > 30 * 864e5;
  });
  add(stale.length ? '注意' : '通过', '关系健康', stale.length ? `超过 30 天未互动：${stale.map(([k]) => k).join('、')}` : '熟人圈均在 30 天内有互动',
    '挑一位最久未互动的熟人，合适时顺嘴问候。');
  const impressions = readJSON(`${MEM}/印象.json`), empty = Object.entries(impressions).filter(([k, v]) =>
    !k.startsWith('_') && (v == null || v === '' || (Array.isArray(v) && !v.length) || (typeof v === 'object' && !Object.keys(v).length)));
  add(empty.length ? '注意' : '通过', '关系健康', `空印象记录 ${empty.length} 人${empty.length ? `：${empty.map(([k]) => k).join('、')}` : ''}`);
});

// 6. 递归统计群聊日志，只读取元数据。
run('日志体量', () => {
  let bytes = 0, count = 0;
  const walk = dir => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name); if (e.isDirectory()) walk(p); else { bytes += fs.statSync(p).size; count++; }
  } };
  walk(`${ROOT}/群聊日志`);
  add(bytes > 2 * 1024 ** 3 ? '告警' : '通过', '日志体量', `${count} 个文件，共 ${(bytes / 1024 ** 3).toFixed(2)} GiB（告警线 2 GiB）`,
    '归档或压缩旧群聊日志，保留近期热数据。');
});

const advice = [...tips].slice(0, 5);
const section = name => `## ${name}（${result[name].length}）\n${result[name].length ? result[name].map(x => `- ${x}`).join('\n') : '- 无'}`;
const report = `# 巡检 ${today}\n${section('告警')}\n${section('注意')}\n${section('通过')}\n## 下一步建议（最多 5 条，按性价比排序）\n${advice.length ? advice.map((x, i) => `${i + 1}. ${x}`).join('\n') : '1. 各项核心指标健康，保持现有节奏。'}\n`;
if (PRINT) console.log(report.trimEnd());
else {
  fs.writeFileSync(`${MEM}/巡检-${today}.md`, report);
  // TODO_SELFCHECK 2026-11-14（批次434）：这个脚本每周一 13:10 跑一次 —— 读 日常.log 扫错误、
  // 查数据新鲜度、算日志体量，然后写一份 巡检-<日期>.md。**而那份报告从来没人读**：
  // 全仓 grep「巡检」只有写入方自己，加 目录卫生 按文件名归档，没有一处解析内容。
  // 体检-闭环 早就挂了待办（批次409），这个没有，于是「每周巡检发现问题」只发生过一次就没了下文。
  // 只挂 告警 + 注意；通过的不挂 —— 否则每周都有一条「一切正常」，那是噪音。
  try {
    const 该管 = [...result.告警, ...result.注意];
    待办.同步({
      id: '自我巡检',
      事项: `巡检发现 ${该管.length} 条：${该管.slice(0, 3).join('；')}${该管.length > 3 ? ' 等' : ''}`,
      来源: '自我巡检',
      该在: 该管.length > 0
    });
  } catch (e) {
    // 待办写不进去不能拖垮巡检本身，但必须留痕 —— 批次409 的教训：空 catch 会让
    // 「待办.同步 is not a function」静默三天，体检照跑、待办不写、谁都不知道。
    process.stderr.write('[待办未写入] ' + String((e && e.message) || e).slice(0, 100) + '\n');
  }
  console.log(`巡检完成：告警 ${result.告警.length}，注意 ${result.注意.length}，通过 ${result.通过.length}`);
  console.log(`报告：${MEM}/巡检-${today}.md`);
  [...result.告警, ...result.注意].slice(0, 12).forEach(x => console.log(`- ${x}`));
  console.log('下一步：'); (advice.length ? advice : ['保持现有节奏。']).forEach((x, i) => console.log(`${i + 1}. ${x}`));
}
