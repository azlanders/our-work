import { atomicWriteFileSync } from './atomic-fs.js'
// 碎片话题.mjs —— 当前对话里出现了旧事的关键词，才把那条旧事翻出来接一句。
//
// 触发条件比 碎片召回.mjs 严：weight≥0.75、得有 tags、得命中 2~6 字的滑窗词，
// 冷却也更短（2 小时，两个冷却文件都看）。它是有由头的闪回，那个是没由头的走神。
import fs from 'node:fs';
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import path from 'node:path';
import { 读碎片文件 } from './碎片公共.mjs';

const DIR = `${QQ_WS}/记忆`;
const FILE = path.join(DIR, '碎片.jsonl');

// 2026-11-05：读碎片 + mtime 缓存原来是本文件内联一份、碎片召回.mjs 里又一份，
// 已抽到 碎片公共.mjs。两个模块读同一个 碎片.jsonl，缓存也共享。

const COOL_FILES = ['话题冷却.json', '碎片冷却.json'].map(x => path.join(DIR, x));
const TWO_HOURS = 2 * 60 * 60 * 1000;
const BUSY = /帮我|怎么|为什么|能不能|是不是|多久|报错|bug|改一下|写个|算一下/i;
const HAPPY = /哈哈|笑死|草|乐|绷/;
const NEGATIVE = new Set(['吵架', '别扭', '冷']);
const STOP = new Set(['一个', '有点', '然后', '后来', '当时', '自己', '那个', '这个', '真的',
  '一下', '觉得', '知道', '看到', '走到', '回来', '过去', '现在', '没有', '就是', '还是']);
const length = s => [...s].length;

function loadFragments() {
  return 读碎片文件(FILE, (p) => fs.readFileSync(p, 'utf8')).split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return [];
    try {
      const x = JSON.parse(line);
      return x && x.weight >= 0.75 && x.scene && Array.isArray(x.tags) ? [x] : [];
    } catch { return []; }
  });
}

// 中文无词库，用场景短语的 2～6 字滑窗寻找可复核的具体词。
function sceneHit(scene, text) {
  const words = new Set();
  for (const part of scene.split(/[\s，。！？、；：,.!?;:"“”‘’（）()…~～-]+/)) {
    const chars = [...part];
    for (let n = Math.min(6, chars.length); n >= 2; n--)
      for (let i = 0; i + n <= chars.length; i++) {
        const word = chars.slice(i, i + n).join('');
        if (!STOP.has(word) && text.includes(word)) words.add(word);
      }
  }
  return words.size > 0;
}

function pick(text, fragments) {
  if (length(text) < 8 || length(text) <= 3 || BUSY.test(text)) return null;
  if (/^(?:\s|\[(?:图片|表情)\])*$/.test(text)) return null;
  const candidates = [];
  for (const item of fragments) {
    const tag = item.tags.find(t => text.includes(t));
    if (!tag || !sceneHit(item.scene, text)) continue;
    if (item.tags.some(t => NEGATIVE.has(t)) && HAPPY.test(text)) continue;
    candidates.push({ item, tag });
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
}

function latestCooldown() {
  return COOL_FILES.reduce((latest, file) => {
    try {
      const at = Number(JSON.parse(fs.readFileSync(file, 'utf8')).lastAt);
      return Number.isFinite(at) ? Math.max(latest, at) : latest;
    } catch { return latest; }
  }, 0);
}

export function topicLine(text, opts = {}) {
  try {
    if (typeof text !== 'string' || Date.now() - latestCooldown() < TWO_HOURS) return '';
    const chosen = pick(text, loadFragments());
    // opts.random 仅方便宿主注入骰子，默认仍严格为 25%。
    const roll = opts.random ?? Math.random;
    if (!chosen || roll() >= 0.25) return '';
    const { item, tag } = chosen;
    atomicWriteFileSync(COOL_FILES[0], JSON.stringify({ lastAt: Date.now() }));
    // REDLINE 2026-11-17（批次622）：命中只给旧事素材，不生成「我想起来了」的固定台词。
    if (item.weight < 0.85) return `[旧事素材·模糊] 和「${tag}」有关，具体哪天想不起来；提不提、怎么提由你定。`;
    const scene = [...item.scene.replace(/[\r\n]+/g, '')].slice(0, 18).join('');
    return `[旧事素材] ${scene}（和「${tag}」有关）；提不提、怎么提由你定。`;
  } catch { return ''; }
}

export function offlineTest(lines) {
  const hits = [];
  try {
    const fragments = loadFragments();
    for (const text of lines) {
      if (typeof text !== 'string') continue;
      const chosen = pick(text, fragments);
      if (chosen) hits.push({ text, scene: chosen.item.scene, tag: chosen.tag });
    }
  } catch { /* 离线统计同样不抛异常 */ }
  return { count: hits.length, hits };
}

// poll.js：import { topicLine } from './碎片话题.mjs'，群聊闲聊时调用 topicLine(msg)，空串即不发言。
// 离线估噪：node --input-type=module -e "import{offlineTest}from'./碎片话题.mjs';console.log(offlineTest(process.argv.slice(1)))" '消息一' '消息二'
// 消息较多时改用脚本读日志成字符串数组，再 console.log(offlineTest(lines))；该函数忽略概率与冷却，也不写冷却。
