// followup.js —— 她问完话，对方却没接：等场子真的安静下来，把当时的情境原样交给她，让她自己决定还说不说。
//
// 2026-11-04 重做（思路来自 BV1Vzxc6dEwp：不给规则，给上下文）：
//   以前是「到点必定追一句」，追的还是写死的预设句 —— 等于替她判断了「该不该开口」。
//   现在只做两件事：一，等没人说话的时候；二，把「你多久前问过什么、之后一直没人接」如实说出来。
//   说不说、说什么，归她自己。等多久也不写死：以「场子安静」为准，不是以秒表为准。
import { randomUUID } from 'node:crypto';
import { curiousCoeff } from './性格系数.mjs'
import { recentSaid } from './recent-say.js'
import { targetKeyOf } from './outbound.js';
import { note, serviceOf, bjHour, bjMinutesOfDay } from './env.js';
import { getConfig } from './config.js';
import { pickSessionId, deliver } from './deliver.js';

// 场子要安静这么久才算「真的没人接」。太短会在别人正打字的中途插一句。
const QUIET_AFTER = 45 * 1000;
// 还在响就往后挪，一次挪 30~60 秒；挪满三次不再等 —— 这地方本来就不安静，等下去也没意义。
const DEFER_MIN = 30 * 1000;
const DEFER_MAX = 60 * 1000;
const MAX_DEFER = 3;
// 她自己 90 秒内说过话就不提醒，她还在场。
const SELF_QUIET = 90 * 1000;

// FOLLOWUP_CTX 2026-11-04：要让她「顺着刚才的话说」而不是念预设句，得往她的会话里投一条提醒。
// 那需要宿主 ctx（拿 sessions 服务）。index.js 启动时注入；没有就退回预设句。
let hostCtx = null
export function setFollowupCtx(value) { hostCtx = value }

// key -> { target, timer, dueAt, done, askedAt, askedText, defer }
const sessions = new Map();
// key -> 最后一条入站消息的时刻。由 clearFollowup 顺手记：它就是「这边刚有人开口」的信号。
const quietAt = new Map();


/**
 * 最早什么时候可以看一眼。
 * 注意：这只是「最早」，不是「到点就投」—— 到点还要过 onDue 那三道检查。
 */
export function followupDelayMs(random = Math.random) {
  const minMs = 60 * 1000;
  const maxMs = 75 * 1000;
  return Math.round(minMs + random() * (maxMs - minMs));
}

/** 消息对象缺 id 会被 DSH 判成 corrupt（"lacks an identified message"），照 deliver.js 的做法补一个。 */
function withId(message) {
  const base = (message !== null && typeof message === 'object') ? message : {}
  const id = (typeof base.id === 'string' && base.id !== '') ? base.id : randomUUID()
  const source = (base.source && typeof base.source === 'object' && typeof base.source.kind === 'string' && base.source.kind !== '')
    ? base.source
    : { kind: 'user' }
  return { ...base, id, source }
}

/** 北京时间 HH:MM —— 系统时区是 UTC，这里不自己算会差八小时。 */
function hhmm(at) {
  return String(bjHour(at)).padStart(2, '0') + ':' + String(bjMinutesOfDay(at) % 60).padStart(2, '0')
}

function gapText(ms) {
  const sec = Math.max(1, Math.round(ms / 1000));
  if (sec < 120) return sec + ' 秒';
  const min = Math.round(sec / 60);
  if (min < 60) return min + ' 分钟';
  return Math.round(min / 60) + ' 小时';
}

/**
 * 投给她的那条「情境」。
 * 只陈述发生了什么，不给建议、不问「要不要说」—— 判断留给她。
 * 出处：BV1Vzxc6dEwp 里那句「接下来发生的事情是你自己生活的一部分」；
 * 落到这里就是最后半句「接下来做什么，你自己定」。
 */
function composeSituation(entry, waitedMs) {
  const now = Date.now();
  const asked = entry.askedText !== '' ? '「' + entry.askedText + '」' : '一句话';
  return '（情境：现在是 ' + hhmm(now) + '。你 ' + gapText(waitedMs) + '前问过 ' + asked +
    '，之后这边一直没人接。就这些，接下来做什么，你自己定。）';
}

/**
 * 往她的会话里投一条情境，让她自己决定补不补那句话。
 * @returns {Promise<boolean>} true = 已投出（会触发她一轮）；false = 走不通，调用方退回预设句
 */
async function nudgeViaAgent(entry, sessionKey, waitedMs) {
  const target = entry.target;
  if (hostCtx === null) { note('[followup] 没有宿主 ctx，退回预设句'); return false }
  let sessionId = '';
  try {
    sessionId = pickSessionId(getConfig(), String(target?.kind ?? ''), String(target?.id ?? ''))
  } catch { sessionId = '' }
  if (sessionId === '') { note('[followup] 这个目标没配会话，退回预设句'); return false }
  try {
    const text = composeSituation(entry, waitedMs)
    const used = await deliver(hostCtx, sessionId, text, target, undefined, { proactive: true, sourceKind: 'nudge' })
    if (!used) return false
    note(`[followup] 已投情境到 ${used}（${gapText(waitedMs)}），说不说由她，key=${sessionKey}`)
    return true
  } catch (e) {
    note(`[followup] 投情境失败：${e?.message ?? e}，退回预设句`)
    return false
  }
}

function schedule(entry, key, ms) {
  entry.timer = setTimeout(() => onDue(entry, key), ms);
  entry.timer.unref?.(); // 只剩追问计时器时，允许进程自然退出
  entry.dueAt = Date.now() + ms;
}

/**
 * 「最早时间」到了 —— 先看看这地方现在是什么情况，再决定投不投。
 * 三道闸：她自己刚说过话 / 场子还在响 / 真的没人接。
 */
function onDue(entry, key) {
  if (sessions.get(key) !== entry || entry.done) return;
  entry.timer = null;

  // 一、她 90 秒内刚说过话 —— 她还在场，用不着我们提醒。
  let lastAt = 0;
  try {
    const list = recentSaid(entry.target, 3) || [];
    if (list.length > 0) {
      lastAt = Number(list[list.length - 1].at) || 0;
      const said = String(list[list.length - 1].text ?? '').trim();
      if (said !== '') entry.askedText = said.slice(0, 60);
    }
  } catch { /* 查不到就照常往下走 */ }
  if (lastAt > 0 && Date.now() - lastAt < SELF_QUIET) {
    note('[followup] 她刚说过话，这次不看，key=' + key);
    sessions.delete(key);
    return;
  }

  // 二、场子还在响 —— 刚有人说话。别人正聊着，这时插一句很难听。往后挪。
  const quiet = Number(quietAt.get(key)) || 0;
  const silentFor = quiet > 0 ? Date.now() - quiet : Number.MAX_SAFE_INTEGER;
  if (silentFor < QUIET_AFTER && entry.defer < MAX_DEFER) {
    entry.defer += 1;
    const wait = DEFER_MIN + Math.round(Math.random() * (DEFER_MAX - DEFER_MIN));
    note(`[followup] 场子还在响（${Math.round(silentFor / 1000)} 秒前还有人说话），顺延第 ${entry.defer} 次，${Math.round(wait / 1000)} 秒后再看，key=${key}`);
    schedule(entry, key, wait);
    return;
  }

  // 三、安静了，也确实没人接。把情境交给她。
  entry.done = true; // 只投一次，投失败也不补，避免烦人
  const waited = Date.now() - entry.askedAt;
  void (async () => {
    const nudged = await nudgeViaAgent(entry, key, waited);
    if (nudged) return;
    // 没有会话上下文时无法把情境交给她判断；不再替她猜测对方是不是忙去了。
    note(`[followup] 无法注入情境，跳过固定兜底句，key=${key}`);
  })();
}

export function armFollowup(target, key, opts = {}) {
  const sessionKey = key || targetKeyOf(target);
  const old = sessions.get(sessionKey);

  // 投过以后就沉默，等对方回话（clearFollowup）或她重新开口（重新 arm）再说。
  if (old?.done) return;
  // 她那句没有明确等回应，就不主动打断对方。
  if (opts.asked !== true) return;

  if (old?.timer) clearTimeout(old.timer); // 同一 key 重新 arm，以最新一句为准

  // CURIOUS_WAIT 2026-11-03：天生爱追根问底的人等不了那么久
  let curious = 1;
  try { curious = curiousCoeff() } catch { curious = 1 }
  const delay = Math.max(60000, Math.round(followupDelayMs() / curious));

  const entry = {
    target,
    timer: null,
    dueAt: 0,
    done: false,
    askedAt: Date.now(),
    askedText: String(opts.text ?? '').trim().slice(0, 60),
    defer: 0,
  };
  sessions.set(sessionKey, entry);
  note(`[followup] 她说了一句等回应的话，最早 ${Math.round(delay / 1000)} 秒后看，到点还要等场子安静，key=${sessionKey}`);
  schedule(entry, sessionKey, delay);
}

/**
 * 这边有人说话了。
 *
 * 私聊里他开口了，就是在回应 —— 那条线接上了，撤掉。
 * 群里不一样：别人插话不代表接了她那句，所以计时器留着，只记下「刚才还热闹」，
 * 到点由 onDue 判断要不要顺延。
 */
export function clearFollowup(key) {
  if (typeof key !== 'string' || key === '') return;
  quietAt.set(key, Date.now());
  const entry = sessions.get(key);
  if (!entry) return;
  if (String(key).startsWith('group:')) return; // 群里继续挂着，等安静
  if (entry.timer) clearTimeout(entry.timer);
  sessions.delete(key); // 私聊：cancel 计时、清掉，下一轮可以重新 arm
}

export function followupState(key) {
  const entry = sessions.get(key);
  return entry
    ? { armed: Boolean(entry.timer) && !entry.done, dueAt: entry.dueAt, done: entry.done, defer: entry.defer }
    : { armed: false, dueAt: null, done: false, defer: 0 };
}
