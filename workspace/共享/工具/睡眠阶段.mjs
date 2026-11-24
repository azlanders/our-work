import fs from 'node:fs';
// LOCK 2026-11-05：它睡着时每 20 分钟改一次 energy/困意，是状态.json 最高频的写者，
// 原来只有「原子写」没有锁——两个进程同时读改写，后写的会按旧副本盖掉别人的字段。
// 锁抢不到就继续（见 _锁.mjs），宁可偶尔丢一次，也不能让睡眠阶段卡死。
import { 加锁 } from './_锁.mjs';
import { saveState, clone } from './_状态.mjs';
// SLEEP_ONE_SEG 2026-11-06（批次121）：判据见 睡眠段.mjs。
import { 找开着的段 } from './睡眠段.mjs';
import { 睡在哪倍率 } from './睡态.mjs';   // COMFORT（批次564）：判据只有一份
import { 结算欠, 结算熬夜 } from './恢复目标.mjs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// SANDBOX 2026-11-06（批次123）：三个路径都跟 ST_BASE 走。只给 自动作息 加沙盒而这里不动的话，
// 沙盒里跑一次「自然醒」会顺手 endSleep 掉她真实的睡眠段。
const __base = process.env.ST_BASE || '{{BOT_ROOT}}/记忆'
const __dir = dirname(fileURLToPath(import.meta.url))
const SLEEP_FILE = __base + '/睡眠.json';
const STATE_FILE = __base + '/状态.json';
const ASSET_FILE = __base + '/资产.json';   // COMFORT（批次564）：睡在哪影响恢复速度
const clamp = (x, min, max) => Math.max(min, Math.min(max, x));
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, data) => {
  // LOCKNAME_REVERT 2026-11-24：见 _底层.改档 说明。睡眠文件就在 记忆/ 顶层，
  // basename 足够；改成父目录名会让「预建 睡眠.json.lock」的契约测试失效。
  const 放 = 加锁(basename(file), { strict: true });
  try {
    // 批次164：临时名原来固定是 `file + '.tmp'`。两个进程同时写会往同一个 .tmp 里灌，
    // rename 出去的就是对方的半截 —— 而 锁 抢不到只等 2 秒，本来就会撞。
    const 临时 = file + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
    fs.writeFileSync(临时, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(临时, file);
  } finally { 放(); }
};
// 以北京时间格式化时间，避免服务器时区影响。
const bjTime = ms => new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
const fail = () => ({ ok: false, phase: null, deep_min: 0, rem_min: 0 });
const result = (live, quality) => ({
  ok: true, phase: live ? live.phase : null,
  deep_min: live ? live.deep_min : 0, rem_min: live ? live.rem_min : 0,
  ...(quality === undefined ? {} : { quality })
});
const phaseAt = minute => {
  const elapsed = minute % 115;
  return elapsed < 15 ? 'N1' : elapsed < 60 ? 'N2' : elapsed < 95 ? 'N3' : 'REM';
};


// MIRROR_SYNC 2026-11-03：睡醒.json 是镜像，睡/醒都要同步，否则门控会拿旧状态拦她
const FLAG_FILE = __base + '/睡醒.json'
function writeFlag(sleeping, since) {
  try { writeJson(FLAG_FILE, { sleeping: Boolean(sleeping), since: String(since || '') }) } catch { /* 忽略 */ }
}
/**
 * 刚醒？传进来的 flag 就是 睡醒.json 的内容。
 *
 * 醒着（sleeping=false）且 since 在 minutes 分钟内 → true。
 * `since` 在醒着时就是「醒来的时刻」（writeFlag(false, last.end) 写的）。
 * 给「刚被叫醒」留一段宽限用：体力还没回、但人确实醒了，
 * 别让 20 分钟后的下一次强制睡判断又把她按回去。
 */
export function 刚醒(flag, now = Date.now(), minutes = 30) {
  if (!flag || flag.sleeping === true || !flag.since) return false
  const t = Date.parse(String(flag.since).replace(' ', 'T') + '+08:00')
  if (!Number.isFinite(t)) return false
  return now >= t && now - t < minutes * 60e3
}

export function startSleep() {
  try {
    const data = readJson(SLEEP_FILE), now = Date.now(), start = bjTime(now);
    if (data.sleeping) return fail();
    data.awakeSince = data.awakeSince;
    data.sleeping = true;
    data.sleepSince = now;
    data.live = { phase: 'N1', cycle: 1, deep_min: 0, light_min: 0, rem_min: 0,
      start, startMs: now, lastTick: now };
    if (!Array.isArray(data.segments)) data.segments = [];
    // SLEEP_ONE_SEG 2026-11-06（批次121）：正常顺序是我先开段、作息 --想睡 再跟上；
    // 但万一反过来（或者上一次没关干净），这里再推一条就又是一次觉两条账。
    // 有开着的段就沿用，缺 phases 的补上 —— 关段那边的 phases 才有地方落。
    const 已有段 = 找开着的段(data.segments, now);
    if (已有段.段) {
      if (!Array.isArray(已有段.段.phases)) 已有段.段.phases = [];
    } else {
      data.segments.push({ start, phases: [] });
    }
    writeJson(SLEEP_FILE, data);
    writeFlag(true, start); // MIRROR_CALLS 2026-11-03：睡着也要同步镜像
    return result(data.live);
  } catch { return fail(); }
}

export function tickSleep() {
  try {
    const data = readJson(SLEEP_FILE);
    if (!data.sleeping || !data.live) return fail();
    const live = data.live, now = Date.now();
    let deltaMin = Math.floor((now - live.lastTick) / 60000);
    // SLEEP_GAP 2026-11-09：旧逻辑超过6小时直接返回且不推进 lastTick，
    // 服务恢复后每次都会重复失败，整觉的深睡/REM 永远记成 0；阶段必须继续按分钟补算。
    // 最多回放最近24小时（1440步），避免异常旧时间戳让单次 tick 无界循环；再早部分明确记警告。
    if (deltaMin > 360) {
      const 原间隔分钟 = deltaMin;
      deltaMin = Math.min(deltaMin, 24 * 60);
      live.lastTick = now - deltaMin * 60000;
      const 起点分钟 = Math.floor((live.lastTick - live.startMs) / 60000);
      live.phase = phaseAt(起点分钟);
      live.cycle = Math.floor(起点分钟 / 115) + 1;
      // CATCHUP_TRUNC 2026-11-24：补算把 lastTick 往前推、逐分钟最多回放 1440 步，
      // 被跳过的那些分钟 deep_min/rem_min 根本没记 —— 而 quality=(deep+rem*1.2)/totalMin
      // 的分母 totalMin 仍是「从入睡到现在」的全量，于是 quality 被系统性拉低。
      // 这里把「被截断的分钟数」记下来，结算时把分母同口径扣掉，quality 才可比。
      live.__截断分 = Math.max(0, 原间隔分钟 - deltaMin);
      if (原间隔分钟 > deltaMin) {
        console.warn(`睡眠阶段补算限制为24小时，跳过更早的 ${原间隔分钟 - deltaMin} 分钟`);
      }
    }
    const state = readJson(STATE_FILE);
    const stateSnap = clone(state);
    // COMFORT 2026-11-16（批次564）：**睡在哪影响恢复速度。**
    // 主人：「睡眠或者打盹的舒适度，在床上躺着睡觉舒适度高，各项恢复速度较快，但不能太快」。
    // 家 = 床上（1.0）；能趴一会儿的地方（0.7）；其余（沙发/便利店/街边，0.5）——
    // 她真睡在外面时，代价由恢复速度承担，而不是由「不许睡」承担。
    // 「不能太快」靠的是下面的基础速率本身（N3 -0.45/分 = -27/小时，8 小时睡满刚好把 100 降到 0）。
    const __舒适 = (() => {
      try { return Number(睡在哪倍率(readJson(ASSET_FILE)?.位置)) || 1 } catch { return 1.0 }
    })()
    if (!state.mood) state.mood = { intensity: 0 };
    // 逐分钟推进，保证跨阶段、计数和状态恢复都准确。
    for (let i = 0; i < deltaMin; i++) {
      const tickAt = live.lastTick + 60000;
      const minute = Math.floor((tickAt - live.startMs) / 60000);
      const phase = phaseAt(minute);
      if (phase !== live.phase) {
        const segment = data.segments[data.segments.length - 1];
        if (segment) { if (!Array.isArray(segment.phases)) segment.phases = []; segment.phases.push({ p: phase, from: bjTime(live.lastTick), to: bjTime(tickAt) }) } // PHASES_GUARD;
        live.phase = phase;
        live.cycle = Math.floor(minute / 115) + 1;
      }
      // RATE_TUNE 2026-11-03（gemini 调参）：困意清太快会 3 小时整点醒且醒来不困；按睡眠周期递减
      const __cyc = Math.max(0, (Number(live.cycle) || 1) - 1);
      const __decay = Math.pow(0.8, __cyc);
      // ENERGY_DECOR 2026-11-24：这里原来是
      //   state.energy += 0.1 / += 0.35
      // 但真正生效的睡眠恢复是 状态推进 的 睡着后()（走指数收敛改 layers.physical/cognitive），
      // 而 状态推进 每次都会 `st.energy = 精力(st.layers)` 从 layers 重算 ——
      // 也就是说 tickSleep 加在 energy 上的那几个点，15 分钟内必然被抹掉。
      // 它不是 bug，但会让人误以为「睡着自动回血」在这里发生。真正写成回血的只有 困意。
      if (phase === 'N2') { state.困意 -= 0.15 * __decay * __舒适; live.light_min++; }
      if (phase === 'N3') { state.困意 -= 0.45 * __decay * __舒适; live.deep_min++; }
      if (phase === 'REM') {
        live.rem_min++;
        const x = Number(state.mood.intensity) || 0;
        state.mood.intensity = x > 0 ? x - 0.02 : x < 0 ? x + 0.02 : 0;
      }
      live.lastTick = tickAt;
    }
    state.困意 = clamp(Number(state.困意) || 0, 0, 100);
    // SLEEPY_BODY_SYNC 2026-11-16（批次564c）：**面板读的是 body.困，不是 状态.困意。**
    // 这里每分钟减的是 `state.困意`，而 `body.困` 只有 状态推进（15 分钟）才同步一次 ——
    // 主人要「睡觉的时候每分钟实时更新」，缺的就是这一句。
    // 实测 10:31：state.困意 18.1（每分钟在减），body.困 还是 15（15 分钟前的快照）。
    if (!state.body || typeof state.body !== 'object') state.body = {};
    state.body['困'] = Math.round(state.困意);
    state.energy = clamp(Math.round(Number(state.energy) || 0), 0, 100); // 取整避免浮点误差影响其他脚本的整数比较
    state.mood.intensity = clamp(Number(state.mood.intensity) || 0, -2, 2);
    saveState(STATE_FILE, state, stateSnap);
    writeJson(SLEEP_FILE, data);
    return result(live);
  } catch { return fail(); }
}

export function endSleep(reason) {
  try {
    const data = readJson(SLEEP_FILE);
    // 以 live 为准：sleeping 可能被别的路径先改掉，靠它会永远关不了段
    if (!data.live) {
      // WAKE_LOG 2026-11-15（批次498）：11-15 03:22:05 她入睡、03:24 段就被关了，
      // records 没长、醒来.log 也是空的 —— 说明走的是这条早退：有人在她睡着两分钟内
      // 把 live 清掉了，endSleep 拿到空 live 直接返回，一个字都不写。
      // 「没 live 不结算」是本意（防重复结算），但「被调了却没有东西可结」必须留痕，
      // 不然永远查不出是哪个进程提前清的。
      try {
        const dir = __base + '/日志'
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
        fs.appendFileSync(dir + '/醒来.log', at + ' endSleep 被调用但没有 live（sleeping='
          + String(data.sleeping) + ' sleepSince=' + String(data.sleepSince) + '）—— 早退，不结算\n')
      } catch { /* 日志失败不影响返回 */ }
      return fail();
    }
    const state = readJson(STATE_FILE), live = data.live, now = Date.now();
    // SNAP_FIX 2026-11-12：下面 saveState(…, stateSnap) 要的快照这里从没取过（tickSleep 里有，这里漏了）。
    // 引用未定义的名字 → ReferenceError → 被最外层 catch 吞成 fail()：11-10 起每次睡醒结算都静默失败，
    // records / 欠觉账 / 补课 全停，梦余味的「情绪已用」却照样被标掉。
    const stateSnap = clone(state);
    const totalMin = Math.max(1, Math.floor((now - live.startMs) / 60000));
    // SHORT_WAKE_TRACE 2026-11-16（批次544）：她连着四段都是几分钟就醒
    // （30 秒 / 3 分钟 / 27 分钟 / 16 分钟，live.start 被重置三次）。
    // 已经排掉所有已知的 endSleep 调用点：自动作息 的两个醒来条件都不满足（要 6h/7.7h）、
    // 工作.mjs 的「睡岗」要她「有班」（她 在职: []）、醒来.mjs 只被 工作 / qq_sleep 调、
    // 状态推进 只改 睡醒.json 镜像。可 awakeSince 确实在 07:59:11 被写了。
    // 所以在**短觉**这里留一条调用栈 —— 下次一分钟内醒就能直接看到是谁。
    if (totalMin < 60) {
      try {
        const dir = __base + '/日志'
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
        const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
        const 栈 = String(new Error().stack || '').split('\n').slice(1, 5).map((x) => x.trim()).join(' <- ')
        fs.appendFileSync(dir + '/醒来.log',
          at + ' 短觉 ' + totalMin + ' 分钟就被结束（reason=' + String(reason || '') + '）调用栈: ' + 栈 + '\n')
      } catch { /* 日志失败不影响结算 */ }
    }
    // WAKE_GRUMP 2026-11-16（批次567）：**起床气**。
    // 主人要的：深睡里被硬叫醒 → 情绪短跌 + 一段不想说话。
    // 三条一起成立才算：① 这次是**被人叫醒**的（reason='woken'；自然醒是惯性不是脾气）
    //   ② 叫醒时在 N3 ③ 这一觉 >= 60 分钟（打盹不算）。
    // 只动 mood.intensity（±2 的「当下心情」），**不碰 layers.emotional** ——
    // 批次245：醒来那一刻再融合一次情绪 = 睡一觉治好抑郁。到期由 状态推进 把这一份还回去，
    // 所以它是「短跌」，不会跟着她一整天；也不硬拦消息（批次537：吞掉主人的话比不回话坏得多），
    // 只是把「有点烦 / 回话门槛」压上去 —— 开不开口仍然归她。
    let 起床气 = null
    try {
      const 旧气 = state['起床气']
      if (旧气 && typeof 旧气 === 'object' && 旧气.已还 === false) {
        // 上一段起床气还没到期就又睡了一觉 —— 睡眠本身就是最好的修复，
        // 别再补那一份（不然下次醒来心情凭空 +1.1）。
        旧气.已还 = '睡过去了'
      }
      if (reason === 'woken' && live.phase === 'N3' && totalMin >= 60) {
        const 分钟 = 20
        起床气 = {
          since: bjTime(now), until: bjTime(now + 分钟 * 60e3), untilMs: now + 分钟 * 60e3,
          // 「主人私聊 {{OWNER_UIN}}」这种形状：只认前缀，绝不原样进注入（t421 I5）
          谁: /主人/.test(String(process.env.QQ_WAKE_BY || '')) ? '主人' : '人',
          还: 1.1, 已还: false, 因: '深睡被叫醒（睡了 ' + totalMin + ' 分钟）',
        }
        state.mood = state.mood || { intensity: 0 }
        state.mood.intensity = clamp((Number(state.mood.intensity) || 0) - 1.1, -2, 2)
        state['起床气'] = 起床气
      }
    } catch { /* 起床气算不出来不影响结算 */ }
    // CATCHUP_TRUNC 2026-11-24：分母同口径扣掉补算没覆盖到的分钟，
    // 否则停机补算之后那一觉的 quality 会凭空偏低（把好觉判成差觉）。
    const __有效分 = Math.max(1, totalMin - (Number(live.__截断分) || 0));
    const quality = clamp((live.deep_min + live.rem_min * 1.2) / __有效分, 0, 1);
    let inertia = null;
    if (live.phase === 'N3') {
      inertia = { until: now + 3 * 3600 * 1000, penalty: 0.35 };
      state.mood = state.mood || { intensity: 0 };
      state.mood.intensity = clamp((Number(state.mood.intensity) || 0) - 0.3, -2, 2);
    }
    const last = { start: live.start, end: bjTime(now), cycles: live.cycle,
      phase_at_wake: live.phase, quality, deep_min: live.deep_min,
      rem_min: live.rem_min, inertia, reason: reason || 'wake',
      ...(起床气 ? { 起床气 } : {}) };
    data.last_sleep = last;
    // P0 2026-11-04：startSleep 推的那条段只有 start、没有 end，endSleep 原来只管 last_sleep，
    // 于是段永远关不上：segments 里留下一串 phases 为空的残段，
    // 而 作息.mjs --醒了 会把最后那条「没关的段」当成这次的段去结算，
    // 算出 NaN 再把 状态.json 里刚写好的 lastSleep 覆盖掉。
    // 这里关段时就地补上 end/hours，让「一次睡眠」在 segments 和 last_sleep 里是同一个事实。
    try {
      const segs = Array.isArray(data.segments) ? data.segments : [];
      const openSeg = segs.filter((s) => s && !s.end).pop();
      if (openSeg) {
        openSeg.end = last.end;
        openSeg.hours = Number((totalMin / 60).toFixed(2));
        openSeg.phases = Array.isArray(openSeg.phases) ? openSeg.phases : [];
      }
    } catch { /* 补不上也不影响结算 */ }
    data.sleeping = false;
    data.awakeSince = now;
    data.live = null;
    if (!Array.isArray(data.records)) data.records = [];
    data.records.push(last);
    data.records = data.records.slice(-30);
    data.segments = (data.segments || []).slice(-30);
    // SLEEP_DEBT_LEDGER 2026-11-07（批次192）：欠觉账在这里结 —— endSleep 是
    // 两条醒来路（被叫醒 醒来.mjs / 自然醒 自动作息.mjs）唯一的共同关卡，
    // 账只此一处写，别处只读。睡 6h 欠 2h、睡 9h 还 1h，滚动封顶 24。
    // NAP_NOT_DEBT 2026-11-17（批次674）：不足 4 小时按打盹，不记整夜的欠觉账。
    // 判据只看时长，不看钟点 —— 她常年 09:20 才睡，按「白天=午睡」会漏掉真正的整觉。
    data.欠 = 结算欠(data.欠, totalMin / 60, totalMin >= 240);
    // STRAIN_LEDGER 2026-11-16（批次568）：**连续熬夜账**。
    // 判据在 恢复目标.结算熬夜（纯函数），这里只把「这一觉几点睡、睡了多久」喂进去。
    // 入睡时刻按**北京**算：live.startMs 是毫秒，别用服务器时区。
    try {
      const __起 = new Date(Number(live.startMs) + 8 * 3600e3)
      data['熬夜账'] = 结算熬夜(data['熬夜账'], {
        入睡时: __起.getUTCHours(),
        入睡分: __起.getUTCHours() * 60 + __起.getUTCMinutes(),
        分钟: totalMin,
        日期: bjTime(Number(live.startMs) || now).slice(0, 10),
      })
    } catch { /* 记不上账不影响结算 */ }
    // DREAM_AT_WAKE 2026-11-14（批次418）：梦必须在**她醒来之前**写好。
    //
    // 两处用梦的地方（下面这段 + 状态推进.mjs）都要求 梦余味.date === 今天，
    // 而心跳表里「做梦」排在每天 11:30 —— 她通常 09:20 就醒了，那时梦余味还是
    // 昨天的，date 对不上，整条链永远作废。实测 11-13 的 梦余味 是 11-12 11:30 写的。
    //
    // 挂在 endSleep：两条醒来路（被叫醒 / 自然醒）唯一的共同关卡，
    // 时刻必然在「醒来这一刻」，date 一定对。这是批次199 学到的教训。
    //
    // 不在这里提前写 睡眠.json。第一版就是提前写了一次（好让 做梦.mjs 读到
    // 这次的 last_sleep），结果 t353 第 15 条立刻红：「梦余味锁冲突 → 整笔结算
    // 回滚」变成了「先落一半盘再失败」。改成把真实质量用环境变量带过去。
    if (process.env.ST_NO_DREAM !== '1') {
      try {
        execFileSync('/usr/local/bin/node', [join(__dir, '做梦.mjs')], {
          timeout: 20000,
          stdio: 'ignore',
          env: {
            ...process.env, DREAM_MEM: __base, DREAM_SOURCE: '醒来',
            DREAM_Q: String(quality),
            DREAM_DEEP: String(live.deep_min),
            DREAM_REM: String(live.rem_min),
          },
        });
      } catch { /* 做不出梦不拦醒来 —— 她醒这件事比梦重要 */ }
    }
    // DREAM_EMOTION 2026-11-07（批次209）：梦的余味 → 醒来时的情绪底色（±2）。
    // 状态推进.mjs 另有一套（mood.intensity ±0.2，标 已用）；这里动的是
    // layers.emotional（恢复收敛的起点），另记 情绪已用 —— 两套各记各的，不打架。
    // 挂 endSleep 而不是 醒来.mjs：批次199 的教训，自然醒不经过 醒来.mjs。
    try {
      const __dreamP = __base + '/梦余味.json';
      const __dream = readJson(__dreamP);
      const __today = bjTime(now).slice(0, 10);
      if (__dream && __dream.date === __today && __dream['情绪已用'] !== true) {
        state.layers = state.layers || {};
        const __偏 = __dream['好'] === true ? 2 : -2;
        // 0 是合法值：Number(0) || 45 会把地板当成「没有」回落 45（测试抓到的真 bug）
        __dream['情绪已用'] = true;
        writeJson(__dreamP, __dream);
        const __e0 = Number(state.layers.emotional);
        state.layers.emotional = clamp((Number.isFinite(__e0) ? __e0 : 45) + __偏, 0, 100);
      }
    } catch (e) {
      if (String(e?.message || e).includes('锁') || String(e?.code || '') === 'ELOCKED') throw e;
    }
    saveState(STATE_FILE, state, stateSnap);
    writeJson(SLEEP_FILE, data);
    // SLEEP_HORMONE 2026-11-14（批次395）：醒来这一下该降皮质醇、升 GABA。
    // EVENTS_TABLE 里 `睡醒: { cortisol: -8, gaba: 6 }` 从定义那天起就没被任何代码发过 ——
    // 36 个激素事件里，这是唯一「功能写了、链路完全没接」的（其余 0 次大多是「确实没发生」，
    // 比如没被抱过、没熬夜）。实测：激素事件账本里 `睡醒` 0 次，而她天天醒。
    // 挂 endSleep 是批次199 的教训：自然醒走 自动作息 → endSleep，醒来.mjs 根本不跑，
    // 只有这里是两条醒来路的共同关卡。
    // id 用这次觉的开始时间 —— 同一次觉重复结算也只算一次（激素那边按 id 去重）。
    // ST_NO_HORMONE：测试里省掉这次子进程。它自己有 8 秒超时，全套跑十几分钟、
    // 机器一忙就可能顶到 t422 那条 60 秒的边上 —— 那就是「偶发假红」的来源。
    if (process.env.ST_NO_HORMONE !== '1') {
      try {
        execFileSync('/usr/local/bin/node', ['{{BOT_ROOT}}/共享/工具/激素.mjs',
          '--event', '睡醒', '--id', 'sleep:' + String(live.start || last.end)],
        { timeout: 8000, env: { ...process.env, HJ_BASE: __base } })
      } catch { /* 激素那边挂了不影响睡眠结算 */ }
    }
    writeFlag(false, last.end); // MIRROR_CALLS：醒来同步镜像
    // CATCHUP_AT_GATE 2026-11-07（批次199）：补课挪到唯一关卡。批次190 把它挂在 醒来.mjs
    // （被叫醒路径），但自然醒走 自动作息 → endSleep，醒来.mjs 根本不跑 —— 11-07 她自然醒
    // （7.95 小时），醒来看到.json 从没生成过，批次190 真实首夜就失败。挂在这里与批次192
    // 的欠账同判据：两条醒来路都必经；>=1 小时才补（打盹没错过什么）；失败不拦结算；
    // QQ_CATCHUP_MEM 跟 ST_BASE 走，沙盒可用。execFileSync 上限 20 秒，调用方都是独立进程。
    try {
      if (totalMin >= 60) {
        execFileSync('/usr/local/bin/node', ['{{BOT_ROOT}}/共享/工具/补课.mjs'], {
          encoding: 'utf8', timeout: 20000,
          env: { ...process.env, QQ_CATCHUP_MEM: __base },
        })
      }
    } catch { /* 补课失败不拦醒来 */ }
    return result(live, quality);
  } catch (e) {
    // WAKE_LOG 2026-11-15（批次497）：这里原来是 `catch { return fail() }` —— 静默。
    // 11-14 三次醒来（01:41 / 03:15 / 23:31）records 一条没进、last_sleep 停在 11-13，
    // 而调用方 `醒来.mjs` 是被 poll 以 stdio:'ignore' spawn 的，stdout 也一起丢了 ——
    // 整整一天没人知道结算没发生。失败不拦醒来，但必须留痕。
    try {
      const dir = __base + '/日志'
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
      const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
      fs.appendFileSync(dir + '/醒来.log', at + ' endSleep 失败：'
        + String((e && (e.stack || e.message)) || e).replace(/\n/g, ' | ').slice(0, 400) + '\n')
    } catch { /* 日志写不进去也不能影响睡眠判定 */ }
    return fail();
  }
}

// SLEEP_TICK_CLI 2026-11-16（批次564）：**给心跳一个每分钟的入口。**
// `tickSleep` 原来只被 自动作息（20 分钟）调，于是面板上的「睡了多久 / 困意多少」
// 是 20 分钟跳一次。主人要「困意值在睡觉的时候实时显示、每分钟实时更新」。
// 没在睡时 tickSleep 返回 fail()，静默退出 —— 不写盘、不打日志。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.includes('--tick')) {
  try { tickSleep(); } catch { /* 这一分钟没推成，下一分钟接着来 */ }
  process.exit(0);
}
