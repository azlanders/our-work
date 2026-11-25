import { readFile, appendFile, copyFile, mkdir } from 'node:fs/promises';
import { 有效感受 } from './有效感受.mjs';

const dir = process.env.DREAM_INTEGRATE_MEM || '{{BOT_ROOT}}/记忆';
const pad = n => String(n).padStart(2, '0');
// 系统时区是 UTC；梦与链都按北京时间归档，不能直接用本机 getFullYear/getHours。
const now = new Date(Date.now() + 8 * 3600e3);
const day = process.env.DREAM_INTEGRATE_DAY || now.toISOString().slice(0, 10);
const stamp = `${day} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}`;
const chain = `${dir}/链.md`;
const cut = (s, n) => [...s].slice(0, n).join('');
const clean = s => String(s || '')
  .replace(/https?:\/\/\S+|www\.\S+/gi, '')
  .replace(/@\S+/g, '')
  .replace(/\s+/g, ' ').trim();

async function optional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

try {
  const [heart, dream, impression, raw, oldChain, feels] = await Promise.all([
    optional(`${dir}/内心.md`),
    optional(`${dir}/梦-${day}.md`),
    optional(`${dir}/梦印象-${day}.md`),
    optional(`${dir}/别扭.json`),
    optional(chain),
    // FEELING_LEDGER 2026-11-05：她自己记的感受也算素材。
    // 睡前想的从来不是「今天谁夸我了」，是那些还没消化掉的。
    optional(`${dir}/感受.jsonl`)
  ]);

  let awkward = {};
  try { awkward = raw ? JSON.parse(raw) : {}; }
  catch { console.log('别扭.json 解析失败，按没有别扭处理'); }

  // level 大于零即视为尚未消解，取第一条作为今夜最占心的事
  const stuck = Object.values(awkward.people || {})
    .find(x => x && Number(x.level) > 0 && String(x.why || '').trim());
  const titles = [...heart.matchAll(/^##\s+\d{1,2}:\d{2}\s*·\s*(.+)$/gm)]
    .map(m => m[1].trim()).filter(Boolean);
  // DREAM_FACTS 2026-11-17（批次649）：`余味:` 只剩底色标签（暖/不安/烧热），
  // 拿它当「今夜最占心的事」等于写了个空。改读梦文件的事实行：场景 → 细节 → 转折 → 身体感。
  const 梦行 = dream.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  const 梦取 = (k) => (梦行.find((l) => l.startsWith(k + '：') || l.startsWith(k + ':')) || '').replace(/^[^：:]+[：:]\s*/, '').trim()
  const aftertaste = 梦取('场景') || 梦行.filter((l) => /^细节[：:]/.test(l))[0]?.replace(/^细节[：:]\s*/, '')
    // 旧梦文件（628 之前）只有 `余味:` 一句：那时它是成句，仍可当素材，别让链整条空掉。
    || 梦行.find((l) => /^余味[：:]/.test(l))?.replace(/^余味[：:]\s*/, '') || ''
  // 忘梦时正文没有余味行，可从梦印象的「感受：暖/乱…」补一条真实来源。
  const impressionFeel = impression.split(/\r?\n/).find((line) => /^- 感受：/.test(line))?.replace(/^- 感受：/, '') || '';
  const source = stuck?.why || titles.at(-1) || aftertaste || (impressionFeel && `梦里的感受：${impressionFeel}`) || titles[0] || '（今天没有明确素材）';
  // INNER_FACTS 2026-11-17（批次627）：链里只写事实素材，不替她生成「判断」句。
  // 她自己在回合里调用 链.mjs --落 写下的内容不受影响 —— 那是她显式选的。
  const fact = cut(clean(source) || '（今天没有明确素材）', 40);
  // 七天的账：同一种难受 >=2 次才值得夜里想。
  // 只摆数目、不替她定性 —— 「可能是我这阵子太紧」这句话得她自己说出来才算她的。
  const 难受 = ['被骂', '被打断', '被冷落', '越界', '搞砸']
  let feelPattern = '';
  try {
    const since = Date.now() - 7 * 24 * 3600e3;
    const cnt = new Map();
    for (const r of 有效感受(feels)) {
      const k = String(r?.kind ?? '');
      if (!难受.includes(k)) continue;
      const t = Date.parse(String(r.at ?? '').replace(' ', 'T') + ':00+08:00');
      if (!Number.isFinite(t) || t < since) continue;
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
    const top = [...cnt.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top && top[1] >= 2) feelPattern = `这七天：${top[0]} ${top[1]} 回`;
  } catch { /* 没有感受记录就算了 */ }

  const pending = stuck
    ? `还堵着：${cut(String(stuck.why).trim(), 20)}`
    : (feelPattern || '（没有）');
  // 月度账跟着链走：链是她的长期记忆，只写「最近三天的判断」太薄。
  // 每天落一条 30 天的数，翻回去的时候能看见"这个月我怎么了"。
  let 月账 = '';
  try {
    const since30 = Date.now() - 30 * 24 * 3600e3;
    const c30 = new Map();
    for (const r of 有效感受(feels)) {
      const k = String(r?.kind ?? '');
      if (!难受.includes(k)) continue;
      const t = Date.parse(String(r.at ?? '').replace(' ', 'T') + ':00+08:00');
      if (!Number.isFinite(t) || t < since30) continue;
      c30.set(k, (c30.get(k) || 0) + 1);
    }
    const top30 = [...c30.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    if (top30.length > 0) 月账 = top30.map(([k, n]) => k + ' ' + n).join('、');
  } catch { /* 没有就算了 */ }

  const block = `## ${stamp}\n- 事实：${fact}\n- 未决：${pending}` + (月账 === '' ? '' : `\n- 这一个月：${月账}`);

  // 只检查今天的段落，事实正文相同便视为已经落过
  const today = oldChain.split(/(?=^## )/m)
    .filter(s => s.startsWith(`## ${day} `)).join('\n');
  const duplicate = today.split(/\r?\n/).some(line =>
    line.startsWith('- 事实：') && line.slice(5) === fact);

  // 每天最多落一条整合
  const already = today.split(/\r?\n/).some((line) => line.trim().startsWith('- 事实：'));
  if (duplicate || already) console.log('今天已落');
  else if (process.argv.includes('--print')) process.stdout.write(block + '\n');
  else {
    const BAK_DIR = process.env.BACKUP_DIR || '/root/bak2'; await mkdir(BAK_DIR, { recursive: true });
    if (oldChain || (await optional(chain))) await copyFile(chain, `${BAK_DIR}/链.md.bak`);
    await appendFile(chain, `${oldChain ? '\n\n' : ''}${block}\n`, 'utf8');
    console.log('已落');
  }
} catch (e) {
  console.log(`跳过：${e.message}`);
  process.exitCode = 0;
}

// cron：03:50 UTC（北京 11:50），在做梦.mjs 之后；日期按北京时间计算
// 50 3 * * * /usr/bin/node /root/做梦整合.mjs >> /root/做梦整合.log 2>&1
