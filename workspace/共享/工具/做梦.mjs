import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// DRY_REAL 2026-11-24：原来 --dry 直接退出（「不支持」）。现在真有 --dry 了：
// 走完 material() 取素材、走完 compose() 组文本，只打印，**不写 梦-*.md、不写 梦余味.json**。
// 但不能在模块顶层判断 —— material/compose 都在下面，所以这里只置标志，出口在写盘处。
const DRY = process.argv.includes('--dry')

// DREAM_MEM 给测试指沙盒：做梦会写梦文件和梦余味，测一次就多一个假梦。
const MEM = process.env.DREAM_MEM || '{{BOT_ROOT}}/记忆';
// 地图/表这类「代码旁边的数据」跟 MEM 不是一个目录：沙盒测做梦时
// DREAM_MEM 指向 /tmp，但地图还是真的那份。
const TOOLS = process.env.DREAM_TOOLS || '{{BOT_ROOT}}/共享/工具';
// 群聊日志原来写死成 {{BOT_ROOT}}/群聊日志 —— 沙盒测不了「@ 提及会不会
// 被念进梦里」这种事，而它恰恰是上一版最脏的一处。
const LOGS = process.env.DREAM_LOGS || '{{BOT_ROOT}}/群聊日志';
const day = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10); // 北京时间日期
const pick = a => a[Math.floor(Math.random() * a.length)];
const clip = (s, n) => String(s || '').replace(/https?:\/\/\S+|\d+/g, '').trim().slice(0, n);
const clean = s => String(s).replace(/因为|所以|原来如此|原来|突然明白|其实/g, '');
const read = async p => { try { return await readFile(p, 'utf8'); } catch { return null; } };
const json = async p => { try { return JSON.parse(await read(p)); } catch { return null; } };
const firstSentence = s => clean(s).split(/[。！？!?；;\n]/).map(x => x.trim()).find(Boolean) || '';

async function material() {
  const heart = (await read(path.join(MEM, '内心.md'))) || (await read(path.join(MEM, `手账-${day}.md`))) || '';
  // STATE_HEAD_NOT_DREAM 2026-11-17（批次652）：内心.md 第一行是状态事实
  // 「精力 34/100；困意 100/100；对主人：好感 …」。它被 firstSentence 按「；」切开后，
  // 首句就是「精力 34/100」，长度过关 → 进了 thoughts → clip 又把数字抹掉 →
  // 梦里出现「墙上写着“精力 /”」。状态是给她看的，不是她想过的事。
  // 665 起 心气 的今日锚改成「今日记录：」，旧档里可能还留着「今天零碎着过了」，两个都认。
  const 像状态事实 = (s) => /^(精力|困意|心情|体力感|对主人|愿望|梦素材|今天零碎着过了|今日记录)/.test(s);
  const thoughts = heart.split(/\n+/)
    .map(s => firstSentence(s.replace(/^[-#*\s\d:.·]+/, '')))
    .filter(s => s.length >= 4 && !像状态事实(s))
    .slice(-2);
  const awkward = await json(path.join(MEM, '别扭.json'));
  const people = Object.values(awkward?.people || {});
  people.sort((a, b) => (b.level || 0) - (a.level || 0));
  const sleep = await json(path.join(MEM, '睡眠.json')) || {};
  // 从 endSleep 里被叫起来时，睡眠.json 还没落盘（那边故意不提前写：提前写会把
  // 「锁冲突 → 整笔结算回滚」变成「先落一半盘再失败」）。这一觉的真实质量由
  // 环境变量带进来，否则读到的是**上一次**睡眠的质量，好梦/坏梦会判反。
  if (process.env.DREAM_Q !== undefined && process.env.DREAM_Q !== '') {
    sleep.last_sleep = {
      quality: Number(process.env.DREAM_Q),
      deep_min: Number(process.env.DREAM_DEEP || 0),
      rem_min: Number(process.env.DREAM_REM || 0),
    };
  }
  const 病 = await json(path.join(MEM, '疾病.json'));
  // SICK_DREAM 2026-11-08（批次224）：烧着的时候梦会怪 —— 这是最便宜的真实感。
  const 烧 = !!(病 && (病.当前 || []).some((x) => x.名 === '发烧' && Number(x.重 || 0) >= 0.4));
  // WANT_FIELD 2026-11-09（批次342）：实际字段是「当下想要」。
  // 原来读 .items —— 永远是空数组，梦里那句「想要」一次都没生效过。
  // 顺手修 pick 调三次的老毛病：三次随机可能取到三个不同条目，拼出来的句子是错位的。
  const wantData = await json(path.join(MEM, '想要.json'));
  const wants = wantData?.['当下想要'] || wantData?.items || [];
  const w0 = wants.length ? pick(wants) : null;
  const want = w0 ? clip(w0?.what || w0?.name || w0?.text || '', 18) : '';
  const log1 = (await read(path.join(LOGS, `1051483012-${day}.jsonl`))) || '';
  const log2 = (await read(path.join(LOGS, `2000000001-${day}.jsonl`))) || '';
  const lines = (log1 + '\n' + log2).split('\n').flatMap(line => {
    try {
      const x = JSON.parse(line);
      if (x.self || x.is_self || x.role === 'assistant' || String(x.user_id) === '3556352474') return [];
      const s = String(x.message || x.text || x.content || x.raw_message || '')
        .replace(/\[[^\]]*\]/g, '')   // CQ 码 / [表情]
        .replace(/@\s*\S*/g, '')       // 梦里的「有人说」不该念出 @ 谁
        .replace(/\s+/g, ' ')
        .trim();
      // 纯符号、复读（哈哈哈哈）、链接都不要 —— 这些当「梦里的一句话」全是噪音
      const 能要 = s.length >= 4 && s.length <= 40
        && !/https?:/.test(s) && !/^[?？!！。.,、~～\s]+$/.test(s) && !/^(.)\1{3,}$/.test(s);
      return 能要 ? [s] : [];
    } catch { return []; }
  });
  // 只取一条，且在标点处截 —— 原来拼两条再硬切 16 字，实测切出
  // 「你整个文件夹删了重」（半个词）和「@ 何头像，我玩点别的」。
  const 短句 = (t, n) => {
    const x = String(t || '');
    if (x.length <= n) return x;
    const i = Math.max(x.lastIndexOf('，', n), x.lastIndexOf('。', n), x.lastIndexOf('！', n), x.lastIndexOf('？', n));
    return i >= 4 ? x.slice(0, i) : x.slice(0, n);
  };
  const chosen = 短句(lines.sort(() => Math.random() - .5)[0] || '', 20);
  // PLACE_DREAM 2026-11-14（批次418）：名词原来是从群聊原文 match(/[\u4e00-\u9fa5]{2,4}/g)
  // 切出来的 —— 中文没有词边界，实测切出「没教程居」「早该加入」，塞进梦里就是
  // 「没教程居摆在枕边」。三天的梦因此都带着乱码级的碎片。
  // 改成三个有依据的来源：她包里真有的东西、白天去过的地方、群聊里真正的一句话。
  const 资产 = await json(path.join(MEM, '资产.json'));
  // 地名要用地图里的真名字整词匹配。原来写的是
  // match(/(?:走到|去了|到了|在)([\u4e00-\u9fa5]{2,5})/) —— 贪婪吃五个字，
  // 「在家喝了咖啡」被提成「家喝了咖啡」，梦里就成了「又回到家喝了咖啡」。
  const 地图 = await json(path.join(TOOLS, '地图.json'));
  const 地名们 = Object.keys(地图?.地点 || {}).sort((a, b) => b.length - a.length); // 长的优先
  // DREAM_DAY_WINDOW 2026-11-15（批次497）：
  // 原来按「今天」筛。凌晨醒来的梦，今天的记录只有几分钟，白天的活动全在昨天 ——
  // 地点池恒空，梦里就永远没有「又回到家」。t422 M4「整词地名一次都没出现」
  // 在 00:00 之后跑必然红（不是抽样倒霉，是口径错了）。
  // 梦讲的是「这一觉之前去过哪」，用最近 24 小时才对。
  const 一天前 = new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 16).replace('T', ' ')
  const 去过 = (资产?.记录 || [])
    .filter((r) => String(r?.at || '') >= 一天前)
    .map((r) => {
      const w = String(r?.what || '');
      return 地名们.find((n) => w.includes(n)) || '';
    })
    .filter(Boolean);
  const 地点池 = [...new Set(去过)];
  const 物品表 = await json(path.join(MEM, '物品.json'));
  const 东西们 = (物品表?.items || [])
    .map((x) => String(x?.n || '').trim())
    .filter((s) => s.length >= 2 && s.length <= 6);
  // 昨天那句余味：她翻旧账时抽的就是这一句。连着两天一样，等于两天只有一天。
  const 昨天日 = new Date(Date.now() + 8 * 3600e3 - 86400e3).toISOString().slice(0, 10);
  const 昨梦 = (await read(path.join(MEM, '梦-' + 昨天日 + '.md'))) || '';
  const 昨余味 = (昨梦.match(/^余味[:：]\s*(.+)$/m) || [])[1]?.trim() || '';
  // DREAM_DEDUP_SAME_DAY 2026-11-14（批次424）：同一天醒两次会做两次梦（DREAM_AT_WAKE 挂在
  // endSleep），那时「昨天」那句根本没变，只按它去重就会跟今天上一句撞车 ——
  // t422 的 M9 偶发红就是这么来的（好池只有 7 句，撞一次看着像随机翻车）。
  // 顺手把 梦余味.json 里现成那句也排除掉：她翻旧账读的是最后一句，两句一样等于白说。
  let 上次余味 = '';
  try { const __j = await json(path.join(MEM, '梦余味.json')); 上次余味 = String(__j?.余味 || '').trim() } catch { /* 没有就算了 */ }
  return {
    thoughts, why: clip(people[0]?.why, 16), sleep, want, 烧, 昨余味, 上次余味,
    东西: pick(东西们) || '',
    白天: pick(地点池) || '',
    闲聊: chosen,
  };
}

function compose(m) {
  const last = m.sleep.last_sleep || {};
  const bad = (last.quality ?? 1) < .35 || (last.deep_min ?? 99) < 25;
  // HUMANIZE 2026-11-17（批次673，P0-5）：场景/身体/转折/结尾四个固定池整段删除。
  // 它们按睡眠好坏抽签，拼出来的是**没发生过的经历**，还会被 内心 / 回忆 / 自动回忆
  // 当成真梦长期召回。现在只写真实来源（睡眠账、去过的地方、包里的东西、
  // 她自己写过的话、群里真说过的一句）；一条真实素材都没有，就当天不做梦。
  const 睡眠事实 = (() => {
    const 小时 = Number(last.hours)
    const 质 = Number(last.quality)
    const 深 = Number(last.deep_min)
    const 段 = []
    if (Number.isFinite(小时) && 小时 > 0) 段.push('睡了 ' + Math.round(小时 * 10) / 10 + ' 小时')
    if (Number.isFinite(质)) 段.push('质量 ' + Math.round(质 * 100) + '%')
    if (Number.isFinite(深) && 深 > 0) 段.push('深睡 ' + Math.round(深) + ' 分钟')
    return 段.join('，')
  })()
  // 真实素材：每一条都能指回一个文件或一条记录，不抽签。
  const 细节 = []
  if (m.白天) 细节.push(['地点', '今天去过' + m.白天])
  if (m.东西) 细节.push(['物品', m.东西])
  if (m.thoughts[0]) 细节.push(['细节', clip(m.thoughts[0], 18)])
  if (m.thoughts[1]) 细节.push(['细节', clip(m.thoughts[1], 14)])
  if (m.want) 细节.push(['细节', '想要的：' + m.want])
  if (m.why) 细节.push(['细节', '别扭的事：' + m.why])
  if (m.闲聊) 细节.push(['细节', '群里那句：' + m.闲聊])
  if (!细节.length) return null
  const 素材 = [
    ...(睡眠事实 ? [['睡眠', 睡眠事实]] : []),
    ...细节,
  ]
  // 120 字上限：从尾部弹，睡眠与地点（最硬的两条证据）永远留着。
  while (素材.length > 2 && clean(素材.map(([, v]) => v).join('，')).length > 120) 素材.pop()
  // 余味取第一条真实素材；跟昨天/上一句撞了就换第二条，不再靠随机场景池。
  const 底色 = m.烧 ? '烧热' : bad ? '不安' : '暖'
  const 避 = [m.昨余味, m.上次余味].filter(Boolean)
  // 优先挑够长的素材（回忆池会滤掉「梦 < 8 字」的余味）；都短就用第一条。
  const 长素材 = 细节.map(([, v]) => v).filter((s) => String(s).length >= 6)
  let aftertaste = 底色 + '｜' + (长素材[0] || 细节[0][1])
  if (避.includes(aftertaste)) {
    const 换 = 长素材[1] || (细节[1] && 细节[1][1])
    if (换) aftertaste = 底色 + '｜' + 换
  }
  // DREAM_MOOD 2026-11-05：好坏在 bad 里算过（睡眠质量/深睡时长），这里直接带出去。
  // INNER_FACTS 2026-11-17（批次628/673）：梦文件只存素材，不拼第一人称叙事；
  // `余味:` 行仍是回忆/整合的稳定入口。
  const md = [
    `# ${day} 梦`,
    `余味: ${aftertaste}`,
    `情绪：${底色}`,
    ...素材.map(([k, v]) => `${k}：${v}`),
  ].join('\n') + '\n';
  return { md, 好: !bad, 余味: aftertaste };
}

/** 谁在叫它：父进程的命令行。做梦.mjs 有两个来源（心跳 11:30 / endSleep 醒来），
 *  还可能有第三个没发现的 —— 只记时间不够，得记下是谁。 */
function 谁叫的() {
  try {
    const 命令 = readFileSync('/proc/' + process.ppid + '/cmdline', 'utf8')
      .split('\0').filter(Boolean).join(' ');
    return 'ppid=' + process.ppid + ' ' + 命令.slice(0, 90);
  } catch { return 'ppid=' + process.ppid; }
}

/** 留痕：谁在什么时候做/跳过了梦。原来这个脚本一个字都不记，于是
 *  「今天 06:48 的梦是谁写的」这种问题只能靠 find -newermt 反推。 */
async function 记(行) {
  try {
    const p = path.join(MEM, '日志', '做梦.log');
    await mkdir(path.dirname(p), { recursive: true });
    const 时 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
    await appendFile(p, 时 + ' ' + 行 + '\n');
  } catch { /* 记不上不影响做梦 */ }
}

async function main() {
  try {
    if (process.argv.includes('--no-dream')) return;
    const 目标 = path.join(MEM, `梦-${day}.md`);
    // ONCE_A_DAY 2026-11-14（批次418）：醒来那一刻（endSleep）已经做过一个，
    // 心跳表里 11:30 那条只该是兜底（她那天没睡、或者醒来没走到 endSleep）。
    // 原来是同日覆盖 —— 但那不叫幂等，重跑一次内容全变，等于把醒来时那个
    // 真正配得上「昨晚」的梦冲掉。改成「有就不动」，要重做加 --force。
    const 已有 = await read(目标);
    // 谁在叫它，决定「已有梦」算不算数：
    //   · 醒来（endSleep）—— 这是刚刚那一觉的梦，永远做，覆盖掉之前那个。
    //     一天醒两次就该有两个梦，第二个才是「刚才那个」。
    //   · 定时（心跳 11:30）—— 只是兜底（那天没睡、或者醒来没走到 endSleep）。
    //     已经有梦就千万别动，否则会把醒来时那个真正配得上「昨晚」的冲掉。
    const 是醒来 = process.env.DREAM_SOURCE === '醒来';
    // DRY_BYPASS 2026-11-24：--dry 必须能穿过「已有就跳过」这道闸，
    // 否则在有梦的日子它一句话都不打，看起来像坏了。
    if (已有 && !是醒来 && !DRY && !process.argv.includes('--force') && !process.argv.includes('--print')) {
      await 记(`跳过：${day} 的梦已经在了（${已有.length} 字）· ${谁叫的()}`);
      return;
    }
    const 素材 = await material()
    const output = compose(素材)
    if (DRY) {
      // 只演练：把素材 + 组出来的文本打出来，一个字节都不落盘。
      console.log('=== 做梦 --dry（不写盘）===')
      console.log('日期: ' + day)
      console.log('素材: ' + JSON.stringify(素材, null, 2).slice(0, 2000))
      console.log('--- 组出来的梦 ---')
      console.log(output ? String(output.md || '').trim() : '(空 —— 没有真实素材，按红线今天无梦)')
      return
    };
    // HUMANIZE 2026-11-17（批次673，P0-5）：没有真实素材就不写梦文件。
    // 以前这里总会返回一段拼出来的叙事；现在宁可当天无梦，也不替她经历没发生的事。
    if (!output) { await 记(`${day} 没有真实素材，今天不做梦`); return }
    if (process.argv.includes('--print')) console.log(output.md.trimEnd());
    else {
      await writeFile(目标, output.md, 'utf8');
      // 醒来第一次状态推进会读它一次，然后把 已用 置 true —— 一天只影响一次，
      // 不会变成「一个梦管她一整天」。
      //
      // 但「一天醒两次」（凌晨醒一次又睡、早上再醒）时会走到这里第二遍：
      // 余味该换成新梦的（她翻旧账读的是最后一个梦），**加成本身不能再给一次** ——
      // 否则睡两觉心情抬两回，一天的情绪就被梦抬穿了。旧标记是今天的就跟着走。
      const 旧味 = await json(path.join(MEM, '梦余味.json'));
      const 旧标记 = (旧味 && 旧味.date === day) ? 旧味 : null;
      await writeFile(path.join(MEM, '梦余味.json'), JSON.stringify({
        date: day, 好: output.好, 余味: output.余味,
        at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
        已用: !!旧标记 && 旧标记.已用 === true,
        ...(旧标记 && 旧标记['情绪已用'] === true ? { 情绪已用: true } : {}),
      }, null, 2), 'utf8');
      await 记(`${day} 做好了 · 好=${output.好} · 余味「${output.余味}」· ${output.md.length} 字 · 来源=${process.env.DREAM_SOURCE || '定时'} · ${谁叫的()}`);
    }
  } catch (e) { console.error(`做梦失败：${e?.message || e}`); } // 不扰醒她，始终正常退出
}
await main();
