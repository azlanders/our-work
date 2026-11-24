// 关系调试.mjs —— 面板「主人分数 / 别扭分」的写入换算（2026-11-17，批次604）
//
// 为什么单独一份：面板原来直接写 好感度.json 的 score 和 别扭.json 的 score，
// 两个都是派生字段/错误字段名。换算逻辑放这里，面板只调用，测试也能直接测。

const 权重 = { 亲近: 0.5, 安全: 0.3, 兴致: 0.2 }
const 三维 = ['亲近', '安全', '兴致']
const 取数 = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const 一位 = (v) => Math.round(v * 10) / 10
const 加权 = (d) => 三维.reduce((s, k) => s + 权重[k] * 取数(d[k]), 0)

/**
 * 把四维缩放到目标 score（0.5亲近 + 0.3安全 + 0.2兴致）。
 *
 * 2026-11-17（批次 660，审计 P1-2）：只按比例缩放会在某一维贴 0/100 时丢掉残差。
 * 例如 {亲近:100, 安全:100, 兴致:0} 目标 100：k=1.25，两维被夹回 100，
 * 重算仍是 80 —— 面板当场显示 100，下一轮结算回到 80，看起来「写了没用」。
 * 现在缩放后再把残差按各维剩余空间补一次，保证目标分真的可达。
 */
export function 缩放四维(dims, 目标) {
  const d = { 亲近: 40, 安全: 55, 兴致: 45, 思念: 0, ...(dims || {}) }
  const 目标值 = Math.max(0, Math.min(100, 取数(目标)))
  const cur = 加权(d)
  if (cur > 0) {
    const k = 目标值 / cur
    for (const key of 三维) d[key] = 一位(Math.max(0, Math.min(100, 取数(d[key]) * k)))
  } else {
    for (const key of 三维) d[key] = 一位(Math.min(100, 目标值))
  }
  // 残差回填：贴边的那一维吃不下，就把差值交给还有余量的维。
  // 权重和正好是 1，所以 0~100 的目标分一定可达；最多 4 轮，0.05 以内算收敛。
  for (let i = 0; i < 4; i++) {
    const 差 = 目标值 - 加权(d)
    if (Math.abs(差) < 0.05) break
    const 空间 = {}
    let 总空间 = 0
    for (const key of 三维) {
      const 空 = Math.max(0, 差 > 0 ? 100 - 取数(d[key]) : 取数(d[key]))
      空间[key] = 空
      总空间 += 权重[key] * 空
    }
    if (总空间 <= 0) break
    for (const key of 三维) {
      const 加 = 空间[key] * (差 / 总空间)
      d[key] = 一位(Math.max(0, Math.min(100, 取数(d[key]) + 加)))
    }
  }
  return d
}

/**
 * 面板写「主人分数」的完整入口：四维换算 + 渲染值 + 结算时间。
 *
 * lastTick 不更新的话，好感度.mjs 下一次结算会按「距上次结算多久」把刚写的值衰减一遍，
 * 面板改完隔一轮又漂回去。这里把 lastTick 推到当下，让写入从此刻开始计时。
 */
export function 写主人分数(p, 目标, now = Date.now()) {
  const 人 = (p && typeof p === 'object') ? p : {}
  const 目标值 = Math.max(0, Math.min(100, 取数(目标)))
  人.dims = 缩放四维(人.dims, 目标值)
  人.score = 一位(加权(人.dims))
  人.lastTick = now
  return 人
}

/** 面板调试图写出的别扭档：level 是真源，until 给 30 分钟~5 小时的调试窗口。 */
export function 别扭调试档(level, 旧 = {}, now = Date.now()) {
  const lv = Math.max(0, Math.min(100, Number(level) || 0))
  const o = (旧 && typeof 旧 === 'object') ? 旧 : {}
  return {
    level: lv,
    why: lv > 0 ? '调试图' : (o.why || ''),
    need: o.need || '',
    since: o.since || now,
    until: lv > 0 ? now + Math.max(30 * 60e3, lv * 3 * 60e3) : now,
  }
}
