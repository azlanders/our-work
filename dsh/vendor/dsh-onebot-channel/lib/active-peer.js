// 群聊当前对话对象：只维护状态，断窗后绝不主动发消息
import fs from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './env.js';

export const ACTIVE_PEER_FILE = join(DATA_DIR, 'qq-active-peer.json');
const FILE = ACTIVE_PEER_FILE;
const WINDOW = 180_000;
const END_WORDS = /先这样|去忙了|算了|88|拜拜|睡了|不说了|回头聊/;
const note = (...a) => console.error('[active-peer]', ...a);
const now = () => Date.now();
const textOf = s => String(s ?? '').trim();
const brief = s => textOf(s).replace(/\s+/g, ' ').slice(0, 120);
let db = { groups: {}, lastClosed: null };
try { db = { ...db, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_err) { console.error('[onebot:active-peer]', _err?.message || _err) }

function save() {
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, FILE);
}
function close(groupId, reason) {
  const s = db.groups[groupId];
  if (!s) return;
  db.lastClosed = {
    groupId, peerUin: s.peerUin, reason, closedAt: now(),
    peerMessages: (s.peerMessages || []).slice(-3),
    botReplies: (s.botReplies || []).slice(-3)
  };
  delete db.groups[groupId];
}
function expired(s, t) {
  const base = Math.max(s.botLastAt || 0, s.hardLastAt || 0);
  return base > 0 && t - base >= WINDOW;
}
function isSoft(text) {
  const t = textOf(text);
  if (!t) return true;
  if ([...t].length <= 3) return true;
  return /\p{Extended_Pictographic}/u.test(t) &&
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\s)+$/u.test(t);
}

export function noteBotSpoke(groupId, peerUin, text = '') {
  try {
    const s = db.groups[groupId];
    if (!s || (peerUin && String(peerUin) !== s.peerUin)) return;
    s.botLastAt = now(); // 回复完成时间参与超时基准计算
    s.botReplies = [...(s.botReplies || []), brief(text)].slice(-3);
    save();
  } catch (e) { note('noteBotSpoke:', e.message); }
}

export function notePeerSpoke(groupId, peerUin, text = '', atList = [], selfUin = '') {
  // AT_OTHER_RULE 2026-11-03：消息里 @ 了别人（不含本 bot）就换人说话，窗口作废
  try {
    const __ats = Array.isArray(atList) ? atList.map(String) : []
    const __others = __ats.filter((q) => q !== '' && q !== 'all' && q !== String(selfUin))
    if (__others.length > 0 && db.groups[groupId] && db.groups[groupId].peerUin === String(peerUin)) {
      close(groupId, 'at-other'); save(); return
    }
  } catch { /* 忽略 */ }
  try {
    const t = now(), uin = String(peerUin), body = textOf(text);
    let s = db.groups[groupId];
    if (s && s.peerUin !== uin) { close(groupId, 'peer-switch'); s = null; }
    if (!s) s = db.groups[groupId] = { peerUin: uin, botLastAt: 0, hardLastAt: t };
    s.peerLastAt = t;
    s.peerMessages = [...(s.peerMessages || []), brief(body)].slice(-3);
    if (END_WORDS.test(body)) { close(groupId, 'closing-word'); save(); return; }
    if (isSoft(body)) s.softLastAt = t; // 软回应不续 180 秒硬超时
    else s.hardLastAt = t;
    save();
  } catch (e) { note('notePeerSpoke:', e.message); }
}

export function noteOtherBotSpoke(groupId, botUin) {
  try {
    const s = db.groups[groupId];
    if (!s) return;
    s.otherBotUin = String(botUin); s.otherBotAt = now(); // 仅记录，不再据此断窗
    save();
  } catch (e) { note('noteOtherBotSpoke:', e.message); }
}

export function noteThirdPartyExchange(groupId, aUin, bUin, selfUin) {
  try {
    const s = db.groups[groupId];
    if (!s) return;
    const a = String(aUin), b = String(bUin), self = String(selfUin);
    if (a === b || a === self || b === self || a === s.peerUin || b === s.peerUin) return;
    close(groupId, 'third-party-exchange'); save();
  } catch (e) { note('noteThirdPartyExchange:', e.message); }
}

export function markOthers(groupId, others) {
  try {
    const s = db.groups[groupId];
    if (!s) return;
    s.others = [...new Set((Array.isArray(others) ? others : [others]).map(String))].slice(-20);
    s.othersAt = now(); save();
  } catch (e) { note('markOthers:', e.message); }
}

export function currentPeer(groupId) {
  try {
    const s = db.groups[groupId];
    if (!s) return null;
    if (expired(s, now())) { close(groupId, 'timeout'); save(); return null; }
    return s.peerUin;
  } catch (e) { note('currentPeer:', e.message); return null; }
}

export function dumpAll() {
  try { return JSON.parse(JSON.stringify(db)); }
  catch (e) { note('dumpAll:', e.message); return { groups: {}, lastClosed: null }; }
}

// 判据一：删除连续两人插话断窗，其他 bot/群友发言只记录。
// 判据二：窗口内两名第三方发生 @/引用交互时立即断窗。
// 判据三：对方消息命中收尾词时立即断窗，并在 lastClosed 留存摘要。
// 判据四：超时取 botLastAt 与 hardLastAt 较晚者，软回应仅更新 softLastAt。
