import { readFileSync, writeFileSync, mkdirSync, utimesSync } from 'node:fs';
import { dirname } from 'node:path';
import { 今日锚, 挑怕的 } from './心气.mjs';
import { 可记内心 } from './惦记.mjs';
// TIER_ONE_TRUTH 2026-11-17（批次643）：亲近档位原来在这里按「好感>75&&熟悉>65 / 好感>65」
// 自己判，印象更新按另一套阈值判出「熟稔」，voiceSlots 又按 bond 判「跟他熟」——
// 同一个人三段注入三种说法。现在统一问 关系档.mjs。
import { 关系档 } from './关系档.mjs';
// DRY_GUARD 2026-11-04：本脚本没有 --dry 语义，传了就直接退出，避免「以为在演练、其实真写」
if (process.argv.includes('--dry')) { console.log('（内心.mjs 不支持 --dry，已跳过；真跑请去掉该参数）'); process.exit(0) }

// 读不到就当作没有状态，数值统一收进 0～100。
// INNER_MEM 2026-11-05（批次101）：让测试能指到沙盒目录，不然每测一次就改写她真实的内心.md。
const dir = process.env.QQ_INNER_MEM || '{{BOT_ROOT}}/记忆';
// INNER_TESTABLE 2026-11-17（批次627）：测试要能指到沙盒配置，不然只能读线上 ownerUin。
const CONFIG = process.env.QQ_BRIDGE_CONFIG || '{{DSH_ROOT}}/qq-bridge.config.json';
const read = (name, fallback = {}) => {
  try { return JSON.parse(readFileSync(`${dir}/${name}.json`, 'utf8')); } catch { return fallback; }
};
const n = (v, d = 50) => Number.isFinite(+v) ? Math.max(0, Math.min(100, +v)) : d;
const 状态 = read('状态'), 好感度 = read('好感度');
// INNER_SCHEMA_FIX 2026-11-05（批次101）：这五样以前全读在根对象上，而真实结构是
//   好感度 { people: { <uin>: { score, dims:{熟悉度} } } }
//   怨 / 别扭 { people: { <uin>: { level } } }
//   想要 { 当下想要: [{ what, strength }] }
// 于是 好感/熟悉/怨/别扭/想要 全是 undefined，内心的三个分支（困/怨/别扭/愿望）
// 永远进不去，每天念的都是同一段「没有非做不可的事」——这不是她，是模板。
const 主人 = (() => {
  try {
    const c = JSON.parse(readFileSync(CONFIG, 'utf8'))
    const id = String(c.ownerUin || c.peerUin || '')
    if (id !== '') return id
  } catch { /* 读不到配置就按最常聊的人算 */ }
  const ps = Object.entries(好感度.people || {})
  ps.sort((a, b) => Number(b[1]?.turns || b[1]?.events || 0) - Number(a[1]?.turns || a[1]?.events || 0))
  return ps.length ? String(ps[0][0]) : ''
})()
const 我 = (好感度.people && 好感度.people[主人]) || {}
const 怨 = n(((read('怨').people || {})[主人] || {}).level, 0);
const 别扭 = n(((read('别扭').people || {})[主人] || {}).level, 0), 想要 = read('想要')['当下想要'];
const 精力 = n(状态.energy), 困意 = n(状态.困意, 0);
// 熟悉度由 好感度.mjs 的 save() 统一算好写回（FAM_STAMP 批次101），这里只读，不再自己算一份。
const 好感 = n(我.score, 50), 熟悉 = n(我['熟悉度'], 20);
const 心情 = typeof 状态.mood?.label === 'string' ? 状态.mood.label : '平常';
const 愿望 = Array.isArray(想要) ? 想要.map((x) => (typeof x === 'string' ? x : String(x?.what || ''))).filter((x) => x.trim()) : [];
// INNER_FACTS 2026-11-17（批次627）：内心文件只存事实，不再拼第一人称独白。
// 模型可以自己决定怎么感受、说不说；这里只把数值、关系、愿望和素材摆出来。
const 气力 = 精力 < 30 ? '低' : 精力 < 60 ? '中' : '足';
// TIER_ONE_TRUTH 2026-11-17（批次643）：bond 有值就以它为准（见 关系档.mjs 的说明），
// 这样内心和 印象.json、voiceSlots 三处对同一个人给出同一个档位。
const 亲近 = 关系档({ 好感, 熟悉, bond: ((read('关系').people || {})[主人] || {}).bond }).档;
const 事实 = [];
事实.push(
  `精力 ${Math.round(精力)}/100；困意 ${Math.round(困意)}/100；心情 ${心情}；体力感 ${气力}`,
);
事实.push(
  `对主人：好感 ${Math.round(好感)}/100；熟悉 ${Math.round(熟悉)}/100；` +
  `怨 ${Math.round(怨)}/100；别扭 ${Math.round(别扭)}/100；亲近 ${亲近}`,
);
if (愿望.length) 事实.push('愿望：' + 愿望.slice(0, 2).join('；'));
let 正文 = 事实.join('；');
// FEAR 2026-11-14（批次402）：把「怕的」接进来 —— 只在深夜、且至少 7 天没提过的时候提一句。
// 为什么插在这里而不是拼到末尾：poll.js 注入「你此刻的内心」时按句号截到 220 字，
// 越靠后越容易被截掉。放在补充段之前，它才真的到得了她眼前。
try {
  const 怕P = dir + '/怕的提过.json'
  let 上次怕 = ''
  try { 上次怕 = String(JSON.parse(readFileSync(怕P, 'utf8'))['上次'] || '') } catch { /* 从没提过 */ }
  const bjF = new Date(Date.now() + 8 * 3600 * 1000)
  const 怕话 = 挑怕的(read('想要')['怕的'], bjF, 上次怕)
  if (怕话) {
    正文 = 正文 + '；' + 怕话
    try {
      writeFileSync(怕P, JSON.stringify({ 上次: bjF.toISOString().slice(0, 10), at: bjF.toISOString().slice(11, 16) }, null, 1) + String.fromCharCode(10))
    } catch { /* 写不进去最多多提一次，不影响这段话 */ }
  }
} catch { /* 没有怕的就算了 */ }
// INNER_CONCRETE 2026-11-03：把惦记的事和最近一句心里话揉进去，别写成通用废话
try {
  let 补充 = "";
  try {
    const pr = readFileSync(dir + "/惦记.jsonl", "utf8");
    // PEND_CLEAN 2026-11-09（批次336）：两件事
    //   ① 老惦记里是「该喝口水了，现在 30%」这种带数值的话 —— 心里话是感受，不是仪表盘。
    //      批次272 已经改掉了写入方，但老记录还在，这里兜底剥掉。
    //   ② 同一句话会被反复追加（链.mjs 原来不去重），取最后两条就成了「A，还有 A」。
    const 剥数 = (s) => String(s == null ? "" : s)
      .replace(/[，,]\s*现在\s*\d+(?:\.\d+)?\s*%/g, "")
      .replace(/\s*现在\s*\d+(?:\.\d+)?\s*%/g, "")
      .trim();
    const pend = pr.split(String.fromCharCode(10)).filter((x) => x.trim() !== "").map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter((x) => 可记内心(x));
    const 见过 = new Set();
    const 未尽 = [];
    for (const x of pend) {
      const 话 = 剥数(x.what);
      if (话 === "" || 见过.has(话)) continue;
      见过.add(话);
      未尽.push(话);
    }
    const 要 = 未尽.slice(-2);
    if (要.length) 补充 += "；惦记：" + 要.join("；");
  } catch { /* 没有惦记 */ }
  try {
    const bj2 = new Date(Date.now() + 8 * 3600 * 1000);
    const d2 = bj2.getUTCFullYear() + "-" + String(bj2.getUTCMonth() + 1).padStart(2, "0") + "-" + String(bj2.getUTCDate()).padStart(2, "0");
    const xlh = readFileSync(dir + "/心里话-" + d2 + ".md", "utf8");
    const last = xlh.split(String.fromCharCode(10)).filter((x) => x.trim().startsWith("##")).slice(-1)[0];
    if (last) 补充 += "；最近写下：" + last.replace(/^##\s*/, "").trim();
  } catch { /* 没有心里话 */ }
  // ANCHOR_TODAY 2026-11-07（批次190）：精力/心情两天同档时模板分支产出逐字全同的心气。
  // 补一个每天必然不同的锚 —— 当天资产记录最后两件事。只拼事实。
  // ①必须在梦余味之前：只留心气() 靠「行尾是梦句」截掉梦，锚句放梦后面会截不掉。
  // ②必须放在「心里话 try」外面：心里话文件常常没有，readFileSync 一抛整个块短路，
  //   插在同一个 try 里就永远跑不到（实测当天没心里话时锚句一个字没拼上）。
  try {
    const bj3 = new Date(Date.now() + 8 * 3600 * 1000)
    const d3 = bj3.getUTCFullYear() + "-" + String(bj3.getUTCMonth() + 1).padStart(2, "0") + "-" + String(bj3.getUTCDate()).padStart(2, "0")
    const 锚 = 今日锚(read('资产')['记录'], d3)
    if (锚) 补充 += '；' + 锚
  } catch { /* 资产读不到就算了 */ }
  正文 = 正文 + 补充;
} catch { /* 拼不上就用原样 */ }
// DREAM_RESIDUE 2026-11-03：把昨晚的梦余味揉进早上的内心，别每天都说一样的话
try {
  const bjd = new Date(Date.now() + 8 * 3600 * 1000);
  const ds = bjd.getUTCFullYear() + '-' + String(bjd.getUTCMonth() + 1).padStart(2, '0') + '-' + String(bjd.getUTCDate()).padStart(2, '0');
  const dp = dir + '/梦-' + ds + '.md';
  const dm = readFileSync(dp, 'utf8');
  // DREAM_FACTS 2026-11-17（批次649）：`余味:` 只剩底色标签（暖/不安/烧热），
  // 当「梦素材」递过去等于什么都没说。改读梦文件的事实行：情绪 + 睡眠 + 场景。
  const 行 = dm.split('\n').map((l) => l.trim()).filter(Boolean)
  const 取 = (k) => (行.find((l) => l.startsWith(k + '：') || l.startsWith(k + ':')) || '').replace(/^[^：:]+[：:]\s*/, '').trim()
  const 梦段 = [取('情绪') && ('情绪 ' + 取('情绪')), 取('睡眠'), 取('场景'), 取('身体感')].filter(Boolean)
  if (梦段.length) 正文 = 正文 + '；梦素材：' + 梦段.join('；').slice(0, 60);
  else {
    // 旧梦文件（628 之前）或只有余味行的：退回余味那句，别让梦整段消失。
    const mm = dm.match(/余味[:：]\s*(.+)/);
    if (mm && mm[1] && mm[1].trim() !== '') 正文 = 正文 + '；梦素材：' + mm[1].trim().replace(/[。！？!?]+$/, '').slice(0, 30);
  }
} catch { /* 今晚没做梦就算了 */ }
if (process.argv.includes('--print')) console.log(正文);
else {
  // IDEMPOTENT_WRITE 2026-11-03：内容没变就不落盘（不改可见行为）
  const __path = dir + '/内心.md'
  const __next = 正文 + String.fromCharCode(10)
  let __prev = ''
  try { __prev = readFileSync(__path, 'utf8') } catch { __prev = '' }
  if (__prev !== __next) { mkdirSync(dirname(__path), { recursive: true }); writeFileSync(__path, __next) }
  // HEARTBEAT_TOUCH 2026-11-05（批次101）：内容没变就不重写是对的，但 mtime 也跟着不动，
  // 自我巡检把它当成「6.3 小时没更新」报出来 —— 假告警会把真告警盖掉。
  // 每次都摸一下 mtime：它表示「脚本还活着、这半小时算过一遍」，内容变没变看文件本身。
  else { try { const __t = new Date(); utimesSync(__path, __t, __t) } catch { /* 下次写的时候自然会有 */ } }
}

// cron：0 * * * * /usr/bin/node /path/内心.mjs（每小时覆盖；改成每日可换 0 0 * * *）
// 接提示：生成回复前读取 {{BOT_ROOT}}/记忆/内心.md，将正文作为少女人设的内心状态注入。
