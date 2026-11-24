/**
 * _总线.mjs —— 批次207（2026-11-07）：她的身体/状态数据统一门面。
 *
 * 问题：状态散在 10 个文件（状态/饱渴/饥饿/体温/卫生/激素/睡眠/睡醒/自主/资产），
 * 每个脚本各读各的，沙盒变量名五花八门（ST_BASE/QQ_AUTONOMY_MEM/HUNGER_MEM/TEMP_MEM/HJ_BASE），
 * 测试极易串味；两条关键联动断头：激素→状态基线、身体感受→缺口决策。
 *
 * 现在：
 *   · 读全身(memDir)     —— 一次聚合八份 + 睡/打盹（全部走既有单一真相模块）
 *   · 算激素心情偏置()   —— 打通「激素 → 情绪基线」（状态推进.mjs 在 eBase 上用它）
 *   · 发事件/注册事件     —— 统一联动写入口；以后加吃药/淋雨/换装加成，注册一个 handler 即可
 *
 * 红线（契约检查盯着）：
 *   · 不手算精力（走 恢复目标.精力）
 *   · 不直接写 状态.json（由业务 handler 走 _状态.saveState；本文件自己不写业务盘）
 *   · 不碰 睡眠.json 的判据（走 睡态.睡着/打盹中）
 * 沙盒：所有入口认 memDir 参数，其次 FISH_SANDBOX_DIR / QQ_AUTONOMY_MEM，测试零串味。
 */
import { appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { 读档 } from './_底层.mjs'
import { loadState, saveState, clone } from './_状态.mjs'
import { 精力 } from './恢复目标.mjs'
import { 睡着, 打盹中 } from './睡态.mjs'

export const 默认记忆 = '{{BOT_ROOT}}/记忆'

/** 记忆目录解析：显式参数 > 沙盒环境变量 > 线上默认。 */
export function 记忆目录(memDir) {
  return String(memDir || process.env.FISH_SANDBOX_DIR || process.env.QQ_AUTONOMY_MEM || 默认记忆)
}

/**
 * 记一条 existential 的变化轨迹。批次386。
 *
 * 为什么不用 `状态变更.log`：那个的跳变阈值是 5 点，而 existential 每次事件只变 0.4~0.8，
 * 永远写不进去 —— 这正是「它冻了 10 天没人发现」的直接原因。
 * 只在事件发生时记（写日记、学到，每天 1~3 条），漂移不记（高频小额会刷屏）。
 */
function 记存在(memDir, 用, 后) {
  try {
    const d = join(记忆目录(memDir), '日志')
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    appendFileSync(join(d, '存在层.log'), `${at}  ${用 >= 0 ? '+' : ''}${用}  → ${后}\n`)
  } catch { /* 记不上不影响状态 */ }
}

/** 一次读全身：八份档 + 睡/打盹。全部安全读，坏档回退 {}。 */
export function 读全身(memDir) {
  const M = 记忆目录(memDir)
  return {
    睡: 睡着(M),
    打盹: 打盹中(M),
    状态: 读档(join(M, '状态.json'), {}),
    饱渴: 读档(join(M, '饱渴.json'), {}),
    体温: 读档(join(M, '体温.json'), {}),
    卫生: 读档(join(M, '卫生.json'), {}),
    激素: 读档(join(M, '激素.json'), {}),
    自主: 读档(join(M, '自主.json'), {}),
    资产: 读档(join(M, '资产.json'), {}),
  }
}

/**
 * 激素 → 情绪偏置（批次207：打通「激素 → 状态基线」）。
 * 激素.json 的当前值在 v，B 是慢漂移的设定点（被夹在基线 85%~115%）。
 * HERE 2026-11-17（批次601）：原来优先读 B —— 设定点永远到不了 65 的阈值，
 * 「多巴胺高 / 皮质醇高压」两条分支实际上是死路；改读 v，B 只做缺失兜底。
 * 多巴胺高 + 皮质醇低 → 情绪基线 +2；皮质醇高压 → -3。
 * 心情偏 ±0.15/0.2 只递出去给未来用（每 tick 叠加会把 mood 泵坏，别直接用）。
 */
export function 算激素心情偏置(激素档) {
  const d = 激素档 || {}
  const v = (d.v && typeof d.v === 'object') ? d.v : null
  const B = (d.B && typeof d.B === 'object') ? d.B : null
  const 取 = (k, fb) => {
    const x = v?.[k] ?? B?.[k] ?? d[k]
    return Number.isFinite(Number(x)) ? Number(x) : fb
  }
  const 巴 = 取('dopamine', 45)
  const 皮 = 取('cortisol', 25)
  if (!Number.isFinite(巴) || !Number.isFinite(皮)) return { 情绪基线: 0, 心情偏: 0 }
  if (巴 >= 65 && 皮 <= 35) return { 情绪基线: 2, 心情偏: 0.15 }
  if (皮 >= 65) return { 情绪基线: -3, 心情偏: -0.2 }
  return { 情绪基线: 0, 心情偏: 0 }
}

/**
 * 学完记一笔（批次571，原名 学完涨认知）。
 *
 * **为什么不再涨 layers.cognitive**（主人 2026-11-16 的决定）：
 * 那个字段同时被当成两样东西 —— 「此刻脑子清不清醒」（困意扣 8~25、醒着 -1.6/h、
 * 睡着收敛回 82）和「学到多少」（这里 +1.5、封顶 95）。实测因此出现过
 * `cognitive 86.6` 高于设计目标 82 的怪值；而 outbound.js 的 `cog<35` 又把它当
 * 「困糊涂了」用 —— 她读完一篇 B 站，在改口率眼里反而更清醒；睡一觉又像「学的东西被睡没了」。
 *
 * 现在 cognitive 只表示「此刻清醒度」：醒着只掉、睡着收敛回 82，任何事件都不许往上推。
 * 「学到多少」这一批**没有搬家** —— 不新造 knowledge 字段，没有出口的字段就是第二个 existential。
 * 学习留下的痕迹是 `学习笔记.md`（她自己写的）和日志里的 `[learn]`。
 * 要给它真出口（影响聊天深度/接话质量）另开一批。
 *
 * LEARN_EXI 2026-11-14（批次386）：仍然记「心气」+0.4 —— 学到东西确实让人踏实一点，
 * 但它不进精力（existential 的定位是长期底色，不进「此刻能不能动」）。
 * 写盘走 _状态.saveState（diff 合并），不裸写 状态.json（契约红线 7）。
 */
export function 学完记一笔(memDir) {
  const P = join(记忆目录(memDir), '状态.json')
  const 前 = loadState(P, {})
  const 后 = clone(前)
  后.layers = 后.layers || {}
  const e0 = Number(后.layers.existential)
  后.layers.existential = Math.max(10, Math.min(95,
    Math.round(((Number.isFinite(e0) ? e0 : 50) + 0.4) * 100) / 100))
  后.energy = 精力(后.layers)
  saveState(P, 后, 前)
  记存在(memDir, 0.4, 后.layers.existential)
  // cognitive 照样回传：调用方要打日志，也方便测试钉住「它没动」
  return { cognitive: 后.layers.cognitive, existential: 后.layers.existential, energy: 后.energy }
}

/**
 * 涨存在 2026-11-14（批次386）：existential 的唯一写入口。
 *
 * 为什么要有：它原来只有 奖惩.mjs:232 一个写入点（条件 `if (k.存在能量)`），
 * 而 奖惩.mjs 和它唯一的调用方 认事.mjs 都在批次63 就停用了 —— 这个值从 2026-11-04
 * 就冻在 49，一直冻了 10 天。状态变更.log 26 行全是 physical，existential 零命中。
 * 后果：困意.mjs:95 的 `(60 - Ex) * 0.2` 永远是 2.2、状态推进.mjs:187 的
 * `0.15 * (Ex - 50)` 永远是 -0.15 —— 两个公式的注释都写着它对行为有影响，实际从没工作过。
 *
 * 现在的写入源（都是还在跑的路，见文件头注释）：
 *   · 写日记.mjs    写完 +0.8
 *   · 学完涨认知()  学到 +0.4
 *   · 状态推进.mjs  静默 >18h 时 -0.06/h；其余时间向 50 回归 0.5%/h
 *
 * 范围 [10, 95]：太低会让她「觉得活着没意思」，那不是靠一个数表达的；
 * 太高也不真实。真要极端值，走事件而不是靠漂移撞到边界。
 */
export function 涨存在(memDir, 加 = 0) {
  const P = join(记忆目录(memDir), '状态.json')
  const 前 = loadState(P, {})
  const 后 = clone(前)
  后.layers = 后.layers || {}
  const e0 = Number(后.layers.existential)
  const 增 = Number(加)
  const 用 = Number.isFinite(增) ? 增 : 0
  // 存 2 位小数：0.8 这种事件 +1 位够用，但 状态推进 的回归每 tick 只变 0.0125，
  // 存 1 位会被四舍五入吃掉，一辈子不动（批次386 的测试 C 段验出来的）。
  后.layers.existential = Math.max(10, Math.min(95,
    Math.round(((Number.isFinite(e0) ? e0 : 50) + 用) * 100) / 100))
  后.energy = 精力(后.layers)
  saveState(P, 后, 前)
  记存在(memDir, 用, 后.layers.existential)
  return { existential: 后.layers.existential, energy: 后.energy }
}

/**
 * 情绪三轴（批次573）：valence / arousal / drive。
 *
 * 为什么要有：`mood` 里这三个字段**一直是死的** ——
 * `arousal` 全仓没有写点也没有读点；`valence` 只有 poll.js 读（算「心 X」）没有写点 → 永远 50；
 * `drive` 被 poll.js 读 3 处、outbound.js 读 1 处（`anxious` → 打字停顿 ×0.7），
 * 也没有写点 → 永远 'calm'，那段分支从上线起一次都没跑过。
 *
 * 这不是「新造字段」，是把**有出口、没输入**的字段接活 —— 跟「没出口的字段就是第二个
 * existential」是同一件事的两面，一样是摆设。
 *
 * 判据只此一处：`状态推进` 只负责平滑与落盘，不自己再算一遍。
 *   · valence（-1~1）：好不好。多巴胺/催产素拉正，皮质醇拉负。
 *     负面系数比正面大 —— negative bias 是真的（一次被骂 ≈ 四次被夸，半衰期差又放大它）。
 *   · arousal（0~1）：绷不绷。肾上腺素主导（急性），皮质醇辅，GABA 反向。
 *   · drive：想干什么。压力+心跳一起上来 = anxious；奖赏高而压力低 = eager；否则 calm。
 */
export function 算情绪轴(激素档) {
  const d = 激素档 || {}
  const v = (d.v && typeof d.v === 'object') ? d.v : d
  const 数 = (x, fb) => (Number.isFinite(Number(x)) ? Number(x) : fb)
  const 夹 = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
  const dop = 数(v.dopamine, 45), cor = 数(v.cortisol, 25), oxy = 数(v.oxytocin, 40)
  const gab = 数(v.gaba, 50), adv = 数(v.adrenaline, 18)
  const val = 夹(1.6 * (
    0.55 * (dop - 45) / 50
    + 0.35 * (oxy - 40) / 50
    - 0.45 * (cor - 25) / 55), -1, 1)
  const aro = 夹(
    0.8 * (adv - 18) / 50
    + 0.25 * (cor - 25) / 60
    - 0.18 * (gab - 50) / 50, 0, 1)
  const drive = (cor - 25 >= 8 && adv - 18 >= 8) ? 'anxious'
    : (dop - 45 >= 8 && cor - 25 < 8) ? 'eager' : 'calm'
  return {
    valence: Math.round(val * 1000) / 1000,
    arousal: Math.round(aro * 1000) / 1000,
    drive,
  }
}

/**
 * 行为倾向（批次573）：肾上腺素 → 想动；皮质醇高 + GABA 低 → 想缩。
 *
 * 返回的是**倍率**，不是绝对票数 —— 调用方乘在自己原来的权重上。
 * 这样「她本来就想做的事」还是主线，激素只做加减，不会把某个动作从池子里顶出去
 * （顶出去就等于系统替她决定今天干什么了）。
 */
export function 算激素倾向(激素档) {
  const d = 激素档 || {}
  const v = (d.v && typeof d.v === 'object') ? d.v : d
  const 数 = (x, fb) => (Number.isFinite(Number(x)) ? Number(x) : fb)
  const 夹 = (x, lo, hi) => Math.max(lo, Math.min(hi, x))
  const cor = 数(v.cortisol, 25), gab = 数(v.gaba, 50), adv = 数(v.adrenaline, 18)
  return {
    想动: Math.round(夹(1 + (adv - 18) / 45, 0.6, 2.2) * 100) / 100,
    想缩: Math.round(夹(1 + (cor - 25) / 55 - (gab - 50) / 70, 0.55, 1.9) * 100) / 100,
  }
}

/** 直接按记忆目录算偏置（状态推进用这个，不重复读盘逻辑）。 */
export function 激素偏置(memDir) {
  return 算激素心情偏置(读档(join(记忆目录(memDir), '激素.json'), {}))
}

// ---- 事件总线：type -> handler[]；handler(payload, ctx) ----
const 处理器 = new Map()

/** 注册事件处理器。返回 false 表示参数不合法。 */
export function 注册事件(type, handler) {
  const t = String(type || '').trim()
  if (t === '' || typeof handler !== 'function') return false
  // ASYNC_GUARD 2026-11-24：发事件 是同步调 h() —— 传进来一个 async 函数，
  // 异常会掉进 unhandled rejection，errors 数组拿不到、ok 误报 true。
  // 这里直接拒绝，让写错的人当场看见，而不是线上静默丢事件。
  if (handler.constructor && handler.constructor.name === 'AsyncFunction') return false
  const arr = 处理器.get(t) || []
  arr.push(handler)
  处理器.set(t, arr)
  return true
}

/** 已注册的事件类型（自检/调试用）。 */
export function 事件类型() {
  return Array.from(处理器.keys())
}

/** 发事件：顺序执行该类型所有 handler，单个失败只记错不影响其他。 */
export function 发事件(type, payload, memDir, now = Date.now()) {
  const t = String(type || '').trim()
  const arr = 处理器.get(t) || []
  const ctx = { memDir: 记忆目录(memDir), now }
  const errors = []
  for (const h of arr) {
    try { h(payload || {}, ctx) } catch (e) {
      errors.push(String((e && e.message) || e))
    }
  }
  return { type: t, handlers: arr.length, ok: errors.length === 0, errors }
}

/** 清空注册表（只给单测用，线上没人调）。 */
export function 清空事件() {
  处理器.clear()
}
