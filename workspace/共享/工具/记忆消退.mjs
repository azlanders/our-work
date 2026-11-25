import { 原子写 } from './_底层.mjs'
import fs from 'node:fs';
import path from 'node:path';

// SANDBOX 2026-11-24：这是全项目唯一没有沙盒变量的模块（其余都有 QQ_*_MEM / *_BASE）。
// 测一次就会动她真实的 别扭/惦记/消退标记，比不测更糟 —— 补上两个覆盖点。
const dir = process.env.XT_MEM || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆';
const awkwardFile = path.join(dir, '别扭.json');
const missFile = path.join(dir, '惦记.jsonl');
const markFile = path.join(dir, '消退标记.json');
const backupDir = process.env.XT_BAK2 || '/root/bak2';
// --days 是历史预留参数：本脚本按「每天一次全额消退」设计，没有分批语义。
// XT_DAYS_NOTE 2026-11-24：与其留着让人以为能调，不如明确写出它不生效。
const dryRun = process.argv.includes('--print');
const now = Date.now();
// 2026-11-04 修：toLocaleDateString 走系统时区（VPS 是 UTC），北京时间 0–8 点这段
// 会被算成「昨天」，消退的边界整个错 8 小时。按项目惯例显式加 8 小时。
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const changes = [];
const readJSON = (file, fallback) => fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;

try {
  // 日期标记保证同一天重复执行不会再次扣减
  if (readJSON(markFile, {}).date === today) {
    console.log('今天已消退');
    process.exit(0);
  }

  const awkward = readJSON(awkwardFile, { people: {} });
  for (const [qq, item] of Object.entries(awkward.people ?? {})) {
    if (item.until <= now) { // 气已经消了
      delete awkward.people[qq];
      changes.push(`别扭 ${qq}：已到期，删除`);
      continue;
    }
    // 24 小时内消退过则跳过；只处理气消进程过半的条目
    if (now - (item.lastFade ?? 0) < 86400000) continue;
    if ((now - item.since) / (item.until - item.since) <= 0.5) continue;
    item.level = Math.max(8, Math.round(item.level * 0.88));
    item.fadeCount = (item.fadeCount ?? 0) + 1;
    if (item.fadeCount >= 3) item.why = '那点小事';
    else if (item.fadeCount >= 2) item.why = `${[...(item.why ?? '')].slice(0, 8).join('')}…`;
    if (item.fadeCount >= 2) item.fuzzy = true;
    item.lastFade = now;
    changes.push(`别扭 ${qq}：level 降至 ${item.level}，why=${item.why}`);
  }

  const kept = [];
  const lines = fs.existsSync(missFile)
    ? fs.readFileSync(missFile, 'utf8').split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const item = JSON.parse(line);
    if (item.done) { // 已完成的惦记不再降温，只清理超过 30 天的
      const at = new Date(String(item.at).replace(' ', 'T')).getTime();
      if (Number.isFinite(at) && now - at > 30 * 86400000) {
        changes.push(`惦记：删除已完成超 30 天的「${item.what}」`);
        continue;
      }
    } else if ((item.heat ?? 5) > 0) {
      item.heat = (item.heat ?? 5) - 1;
      if (item.heat === 0) { // 想不起具体内容，但保留淡淡的痕迹
        item.what = `${[...item.what].slice(0, 10).join('')}…`;
        item.fuzzy = true;
      }
      changes.push(`惦记「${item.what}」：heat=${item.heat}`);
    }
    kept.push(JSON.stringify(item));
  }

  if (dryRun) console.log(changes.length ? changes.join('\n') : '无需改动');
  else {
    fs.mkdirSync(backupDir, { recursive: true });
    for (const file of [awkwardFile, missFile]) { // 写盘前备份，并各留最近 7 份
      if (!fs.existsSync(file)) continue;
      const prefix = path.basename(file) + '.';
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      fs.copyFileSync(file, path.join(backupDir, prefix + stamp));
      const old = fs.readdirSync(backupDir).filter(x => x.startsWith(prefix)).sort();
      for (const name of old.slice(0, -7)) fs.unlinkSync(path.join(backupDir, name));
    }
    原子写(awkwardFile, JSON.stringify(awkward, null, 2));
    原子写(missFile, kept.length ? kept.join('\n') + '\n' : '');
    原子写(markFile, JSON.stringify({ date: today }, null, 2));
    console.log(changes.length ? changes.join('\n') : '消退完成，无改动');
  }
} catch (error) {
  console.log(`消退失败：${error.message}`); // 定时任务不因异常制造非零退出
  process.exitCode = 0;
}
// cron：建议每天凌晨 4:20 执行，脚本自身保证同日幂等。
// 20 4 * * * /usr/bin/node {{BOT_ROOT}}/记忆/记忆消退.mjs >> {{BOT_ROOT}}/记忆/消退.log 2>&1
// 手动预览：/usr/bin/node {{BOT_ROOT}}/记忆/记忆消退.mjs --print
