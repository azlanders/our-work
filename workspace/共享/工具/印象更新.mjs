import fs from 'node:fs';
import { join, isAbsolute } from 'node:path';
// MEM_BASE 2026-11-09（批次346）：原来读的都是相对路径，靠 crontab 里的 `cd 记忆` 才能跑。
// 迁进心跳表后工作目录是 工具/，第一分钟就 ENOENT。改成显式基于记忆目录。
const MEM = process.env.QQ_MEM || '{{BOT_ROOT}}/记忆';
const P = (name) => (isAbsolute(String(name)) ? String(name) : join(MEM, String(name)));
import { 写档 } from './_底层.mjs';
// TIER_ONE_TRUTH 2026-11-17（批次643）：档位原来在这里按
// 「熟悉×0.6 + 好感×0.4 + 轮数×0.3」另算一套阈值，和 内心.mjs、voiceSlots 的
// 三套阈值互相打架（同一个人被同时说成「熟稔 / 在意 / 跟他熟」）。
// 现在档位只在 关系档.mjs 判一次，这里只负责把数字喂进去。
import { 关系档 } from './判据/关系档.mjs';

const read = (name, fallback) => JSON.parse(fs.readFileSync(P(name), 'utf8') ?? fallback);
// ATOMIC_SAVE 2026-11-07（批次179）：原来这里裸 writeFileSync。这个脚本每天 04:10(UTC) 跑，
// 写的是 印象.json / 印象状态.json —— 她的长期印象。写到一半被 kill 就留半截 JSON，
// 而下一次 read() 是裸 JSON.parse，抛错 → 外层 catch 只 console.error 一句就 exit 0：
// 印象从此永远不再更新，且只有 日常.log 里一行字。
// 注意：这里**故意不给 read 加「读失败返回空对象」的容错** —— 那样 people 会变空，
// 紧接着 write('印象.json', {}) 就把印象整个清空。宁可这轮不更新，也不能清空。
const write = (name, value) => 写档(P(name), value);
const material = p => {
  const log = Array.isArray(p.log) ? p.log : [];
  const recent = log.slice(-10);
  // CLUE_FIELD 2026-11-17（批次645）：`kind` 有「日结/自评/被夸…」，原来把**任何**
  // 非「日常」都当特殊事件，于是最后一条总是「日结：今天说了 N 句」——
  // 那是最没信息量的一条。日结只保留在没有别的事件时才用。
  // NOISE_KIND 2026-11-17（批次645）：`迁移` 是账本条目（「v1→v2 框架重置（按原分反推」），
  // 不是发生过的事；原来它被当成「特殊事件」优先取，迁移后 13 条里 9 条变成这句。
  const 跳过 = new Set(['日常', '日结', '迁移']);
  const special = [...recent].reverse().find((x) => x && !跳过.has(String(x.kind || '')));
  return { recent, special: special || null };
};
const recentChatClue = (uid) => {
  try {
    const gdir = '{{BOT_ROOT}}/群聊日志';
    if (!fs.existsSync(gdir)) return '';
    const files = fs.readdirSync(gdir).filter(f => f.endsWith('.jsonl'))
      .sort((a, b) => a.slice(-16).localeCompare(b.slice(-16))).slice(-10);
    const msgs = [];
    for (const f of files) {
      for (const ln of fs.readFileSync(join(gdir, f), 'utf8').split('\n')) {
        if (!ln.includes(String(uid))) continue;
        try {
          const j = JSON.parse(ln);
          const u = String(j.sender?.user_id || j.user_id || '');
          if (u !== String(uid)) continue;
          const t = String(j.text || j.raw_message || '').replace(/\[[^\]]*\]|@\S+/g, '').trim();
          if (t.length >= 3 && t.length <= 24 && !/^[0-9a-zA-Z\s]+$/.test(t)) msgs.push(t);
        } catch (_err) { console.error('[印象更新]', _err?.message || _err) }
      }
    }
    // CLUE_QUALITY 2026-11-17（批次642）：原来取「最后一条 3~24 字的发言」，
    // 线上取到的是「这是接近的。。。」—— 残句、纯标点、复读都会被当成线索写进
    // 长期印象，下一轮又作为「你对TA的印象」注入。改成倒序找第一条像话的：
    // 去掉标点后至少 4 个字，且不是纯标点/纯语气词。
    const 像话 = [...msgs].reverse().find(可当线索);
    return 像话 ? '聊起「' + 像话.slice(0, 14) + '」' : '';
  } catch { return ''; }
};
/**
 * 这句话能不能当「聊起过什么」的线索。
 * 判据只看形状，不看内容：去掉标点后 ≥4 字，且不全是一个字的复读（「哈哈哈」「。。。」）。
 * 不判断话题好坏 —— 那是她的事，这里只挡残句和噪声。
 */
function 可当线索(s) {
  const t = String(s ?? '').replace(/[\s，。！？；：、,.!?;:~～…—\-"'“”‘’()（）\[\]【】]/g, '');
  if (t.length < 4) return false;
  if (new Set(t).size <= 2) return false;
  // 系统噪声不当线索：迁移日志、日结计数、版本号这类是账本，不是「聊起过什么」。
  // 实测迁移后 13 条里 9 条变成「v→v 框架重置（按原分反推」——比旧模板更没信息量。
  if (/框架重置|按原分反推|v\d+→v\d+|迁移|日结|今天说了/.test(String(s))) return false;
  return true;
}
/**
 * 从一条 log 里取「聊起过什么」。
 *
 * CLUE_FIELD 2026-11-17（批次645）：好感度.json 的 log 条目用的是 `why`
 * （「被夸：他说『…』」「陪伴：他说『…』」），不是 `text/内容/clue`。
 * 原来三个字段一个都不存在 → raw 恒为空 → 每次都掉进 recentChatClue，
 * 于是印象素材永远是从群聊日志里抓的一句残话（实测「这是接近的。。。」）。
 * 现在先认 why，再认其它；都没有才去翻群聊。
 */
const clue = ({ recent, special }, uid) => {
  // 特殊事件优先；没有就按时间倒序找第一条**能当线索**的（跳过迁移/日结这类账本）。
  const chosen = special || [...recent].reverse().find((x) => (x?.why || x?.text || x?.内容 || x?.clue) && 可当线索(x?.why || x?.clue || x?.text || x?.内容));
  const raw = String(chosen?.why || chosen?.clue || chosen?.text || chosen?.内容 || '');
  // CLUE_QUALITY 2026-11-17（批次642）：原来取「第一个 ≥2 字的片段」，
  // 「这是接近的。。。」里第一个片段就是残句。现在挑**最长**的一个像话片段。
  const 片段 = raw.replace(/https?:\/\/\S+|[\d０-９]/g, '').split(/[，。！？；,.!?;\n]/)
    .map((s) => s.trim())
    .filter(可当线索)
    .sort((a, b) => b.length - a.length);
  const c = 片段[0]?.slice(0, 14) || '';
  return c || recentChatClue(uid);
};

try {
  const file = process.argv[2] || '印象素材.json';
  const source = read(file);
  // UNWRAP2 2026-11-03：外部文件可能是 {note,people,network}，先取出 people 再展开
  const __src = (source && (source.people || source.users)) ? (source.people || source.users) : source
  const people = Array.isArray(__src) ? __src : Object.entries(__src).map(([qq, p]) => ({ qq, ...p }));
  const old = fs.existsSync(P('印象.json')) ? read('印象.json') : {};
  const state = fs.existsSync(P('印象状态.json')) ? read('印象状态.json') : {};
  // TIER_ONE_TRUTH 2026-11-17（批次643）：bond 是档位的主信号（见 关系档.mjs），
  // 只喂好感/熟悉会让印象说「在意」、内心说「熟」—— 同一份数据两种结论。
  const 关系档源 = fs.existsSync(P('关系.json')) ? read('关系.json') : {};
  const 关系人们 = (关系档源 && 关系档源.people) || {};
  const result = {}, next = {};
  for (const p of people) {
    const id = String(p.qq ?? p.QQ ?? p.id ?? p.账号 ?? p.QQ号 ?? '');
    if (!id) continue;
    // FAVOR_KEY_FIX 2026-11-03：好感度文件的字段叫 score，不是 favor（原来一直按 0 算，把她当成刚认识）
    const turns = Number(p.turns ?? p.轮数 ?? 0), favor = Number(p.favor ?? p.好感分 ?? p.score ?? 0);
    const familiarity = Number(p.familiarity ?? p.熟悉度 ?? 0), before = state[id] || {};
    const m = material(p), latest = m.recent.at(-1);
    const due = !old[id] || turns - (before.turns ?? 0) > 15 ||
      Date.now() - (before.time ?? 0) > 7 * 864e5 || Math.abs(favor - (before.favor ?? favor)) > 5 ||
      (latest && latest.kind !== '日常') ||
      !String(old[id] || '').startsWith('素材：');
    if (process.argv.includes('--force') || due) {
      const hint = clue(m, id);
      const level = 关系档({ 好感: favor, 熟悉: familiarity, bond: (关系人们[id] || {}).bond }).档;
      result[id] = '素材：' + (hint || '暂无') + '；档位：' + level +
        '；熟悉 ' + Math.round(familiarity) + '；好感 ' + Math.round(favor) + '；聊过 ' + turns + ' 轮';
    } else result[id] = old[id];
    next[id] = { turns, favor, time: due || process.argv.includes('--force') ? Date.now() : before.time || Date.now() };
  }
  if (process.argv.includes('--print')) console.log(JSON.stringify(result, null, 2));
  else { write('印象.json', result); write('印象状态.json', next); }
} catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(0); }
