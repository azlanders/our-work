// 性格系数.mjs：从 16PF 记忆计算行为系数；任何异常都退回中性 1.0，绝不抛错
import { readFileSync, existsSync, statSync } from 'node:fs';
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'

const 路径 = `${QQ_WS}/记忆/性格-16PF.json`;
const 中性 = 1.0;
const 夹取 = (v, 低, 高) => Math.min(高, Math.max(低, v));

// PERF 2026-11-05：mtime 缓存。这两个文件每次系数计算都要读，而系数又会随每条消息
// 调用（打字速度、分段间隔、主动搭话），一秒钟能读几十遍。文件只在状态推进时才变，
// 用 statSync 的 mtimeMs 判一下就够了 —— 2µs，比 readFileSync + JSON.parse 便宜一个量级。
const 缓存 = new Map(); // 路径 -> { mtimeMs, size, data }

function 读Json缓存(路径) {
  try {
    const st = statSync(路径);
    const hit = 缓存.get(路径);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.data;
    const data = JSON.parse(readFileSync(路径, 'utf8'));
    缓存.set(路径, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch { return null; } // 文件不存在、无权限、JSON 损坏都走中性
}

// 返回浅拷贝：叠增量() 会原地改对象，直接返回缓存对象会让改动累积到下一轮
function 读性格() {
  const 数据 = 读Json缓存(路径);
  return 数据 && typeof 数据 === 'object' ? { ...数据 } : null;
}

// GROWTH_DELTA 2026-11-03：把成长记录里的 16pf 微调叠进维度（跷跷板结果），让成长真的改行为
//
// INFINITE_LOOP_FIX 2026-11-05：这里原来写的是 叠增量(JSON.parse(...))，而 叠增量()
// 内部又调 读成长增量() —— 两个函数互相递归，靠「栈溢出抛 RangeError → 被 catch 吞掉」
// 才停下来。每个系数函数每调一次就读盘几千次（实测 10 次调用 14 万次系统调用、
// 单次 78ms），是我 2026-11-04 收拢 traitCoeff 时带进来的。
// 读增量就该只读增量，不需要把增量再叠到自身上。
function 读成长增量() {
  const j = 读Json缓存(`${QQ_WS}/记忆/生长记录.json`);
  const d = j && typeof j === 'object' && j[ '16pf_delta' ] ? j[ '16pf_delta' ] : {};
  return d && typeof d === 'object' ? { ...d } : {};
}

// APPLY_ALL 2026-11-03：其余系数函数也要吃成长增量，统一走这个
function 叠增量(性格) {
  try {
    const 增量 = 读成长增量();
    for (const k of Object.keys(增量)) {
      if (typeof 性格[k] === 'number') 性格[k] = 夹取(Number(性格[k]) + Number(增量[k] || 0), 1, 10);
    }
  } catch { /* 忽略 */ }
  return 性格;
}

function 算系数(维度们, 最低, 最高) {
  try {
    const 性格 = 读性格();
    if (!性格) return 中性;
    const 增量 = 读成长增量();
    for (const k of Object.keys(增量)) {
      if (typeof 性格[k] === 'number') 性格[k] = 夹取(Number(性格[k]) + Number(增量[k] || 0), 1, 10);
    }
    const 归一 = [];
    for (const 键 of 维度们) {
      const 分 = Number(性格[键]);
      if (!Number.isFinite(分)) return 中性; // 缺维度不硬猜，避免带偏行为
      归一.push(夹取((分 - 1) / 9, 0, 1)); // 1–10 分平滑归一到 0–1
    }
    const 平均 = 归一.reduce((和, v) => 和 + v, 0) / 归一.length;
    return 夹取(最低 + 平均 * (最高 - 最低), 最低, 最高);
  } catch { return 中性; }
}

export function eagerCoeff() { // 互动急切度：兴奋性、敢为性越高越接近 1.4
  return 算系数(['F_兴奋性', 'H_敢为性'], 0.7, 1.4);
}

export function sensitiveCoeff() { // 情绪敏感度：敏感性、忧虑性越高越接近 1.3
  return 算系数(['I_敏感性', 'O_忧虑性'], 0.8, 1.3);
}

// socialCoeff：社交主动度（A 乐群性 + H 敢为性），0.7~1.4；越高越爱主动搭话
export function socialCoeff() {
  try {
    const 原 = 读性格()
    if (!原) return 1
    const j = 叠增量(原)
    const a = Math.min(10, Math.max(1, Number(j['A_乐群性'] ?? 5)))
    const h = Math.min(10, Math.max(1, Number(j['H_敢为性'] ?? 5)))
    const v = 0.7 + (((a - 1) / 9 + (h - 1) / 9) / 2) * 0.7
    return Math.min(1.4, Math.max(0.7, v))
  } catch { return 1 }
}

// curiousCoeff：追根究底度（L 怀疑性 + Q4 紧张性），0.7~1.4；越高越想追问
export function curiousCoeff() {
  try {
    const 原 = 读性格()
    if (!原) return 1
    const j = 叠增量(原)
    const lo = Math.min(10, Math.max(1, Number(j['L_怀疑性'] ?? 5)))
    const q4 = Math.min(10, Math.max(1, Number(j['Q4_紧张性'] ?? 5)))
    const v = 0.7 + (((lo - 1) / 9 + (q4 - 1) / 9) / 2) * 0.7
    return Math.min(1.4, Math.max(0.7, v))
  } catch { return 1 }
}

// traitCoeff 2026-11-04：从 outbound / split / proactive 三个文件的内联副本收拢过来的。
//
// 收拢的理由不只是重复 —— proactive 那份还在用 require('node:fs')，ESM 下直接抛
// ReferenceError，被 catch 吞掉之后永远返回 1：主动搭话的性格系数从来没生效过，
// 乐群性 / 敢为性 / 忧虑性三个因子白写在 16PF 里。
//
// 公式保持原样（m(s) 把 1–10 映到 0.75–1.35），只额外叠上成长增量，
// 跟本节其他系数口径一致（APPLY_ALL 2026-11-03 的原意就是这个）。
export function traitCoeff(which) {
  try {
    const 原 = 读性格();
    if (!原) return 中性;
    const 性格 = 叠增量({ ...原 });
    const m = (s) => 0.75 + (Math.max(1, Math.min(10, Number(s) || 5)) - 1) * (0.6 / 9);
    const 表 = {
      // 打字速度：兴奋性为主，紧张性为辅
      typingSpeed: m(性格.F_兴奋性) * 0.6 + m(性格.Q4_紧张性) * 0.4,
      // 分段间隔：兴奋 + 紧张越高，间隔越短（所以取倒数）
      partGap: 1 / (m(性格.F_兴奋性) * 0.7 + m(性格.Q4_紧张性) * 0.3),
      // 主动搭话：乐群、敢为拉高，忧虑拉低
      proactive: m(性格.A_乐群性) * 0.5 + m(性格.H_敢为性) * 0.3 + (1 / m(性格.O_忧虑性)) * 0.2,
      // 闷气：敏感拉高，稳定拉低
      sulk: m(性格.I_敏感性) * 0.7 + (1 / m(性格.C_稳定性)) * 0.3,
    };
    return Number(表[which] ?? 1);
  } catch { return 中性; }
}

// hormoneCoeff 2026-11-05：激素 → 行为意愿的调制系数，0.7~1.3。
//
// 为什么要有它：激素之前只在 voiceHintOf 里变成一句「身体底色」，
// 但那句话只影响她怎么描述自己，不影响她**做不做**。这里把激素接进行为决策：
//   多巴胺高 → 更愿意主动搭话、更急着追问
//   皮质醇高 → 更不想动、更容易冷下来
//   催产素低 → 略疏离
// 读不到文件一律返回 1（中性），绝不让激素把行为卡死。
export function hormoneCoeff() {
  try {
    const j = 读Json缓存(`${QQ_WS}/记忆/激素.json`);
    if (!j) return 1;
    const d = Number(j?.v?.dopamine ?? 45);
    const c = Number(j?.v?.cortisol ?? 25);
    const o = Number(j?.v?.oxytocin ?? 40);
    const raw = 0.7 + (d / 100) * 0.5 - (c / 100) * 0.3 + (o / 100) * 0.1;
    return Math.min(1.3, Math.max(0.7, raw));
  } catch { return 1; }
}

// HORMONE_TEMPO 2026-11-05：激素 → 说话节奏（跟 hormoneCoeff 分工不同）。
//
// hormoneCoeff 管「愿不愿意做」（0.7~1.3，调主动搭话／追问的决策）；
// 这个管「身体快不快」（0.85~1.15，调打字速度和分条间隔）。
// 幅度必须小：她的性子是连续的，一句话忽快忽慢会很假。
// 多巴胺高 → 快、接得紧；皮质醇高 → 拖、回得慢；GABA 高（放松）→ 略慢半拍。
// 返回 >1 = 更快 / 间隔更短。读不到文件一律 1。
export function hormoneTempo() {
  try {
    const j = 读Json缓存(`${QQ_WS}/记忆/激素.json`);
    if (!j) return 1;
    const d = Number(j?.v?.dopamine ?? 45);
    const c = Number(j?.v?.cortisol ?? 25);
    const g = Number(j?.v?.gaba ?? 50);
    const raw = 1 + ((d - 45) / 100) * 0.35 - ((c - 25) / 100) * 0.35 - ((g - 50) / 100) * 0.15;
    return Math.min(1.15, Math.max(0.85, raw));
  } catch { return 1; }
}
