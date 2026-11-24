// 疾病.mjs —— 生病：判定、症状、连续恢复、发烧（批次221，2026-11-07）
//
// 一句话：病不是开关，是一条随时间走的曲线。`重` 0~1 是唯一强度，所有影响都按它缩放。
//
// 数据（记忆/疾病.json，只有这个文件写）：
//   { 当前:[{名,起,重,重At,症状:[],诱因}], 史:[{名,起,好At}], 上次判At, 上月:{月,次} }
//
// 依赖方向（别搞反，否则成环）：
//   疾病 → 饱渴/_底层/睡态（只读）
//   **疾病不 import 体温** —— 风险判定要的体温/体感/风雨由 状态推进 传快照进来；
//   反过来 体温.mjs 才能 import 疾病的 发烧偏移()。
//
// 用法：
//   node 疾病.mjs --看
//   node 疾病.mjs --判 [--force]     # 状态推进 调；--force 必中（只给测试）
//   node 疾病.mjs --tick             # 恢复推进 + 到点好（心跳 15 分钟）
//   node 疾病.mjs --好 感冒
//   node 疾病.mjs --重设 0.6
import fs from 'node:fs'
import path from 'node:path'
import { 读档, 改档 } from './_底层.mjs'
import * as 饱渴 from './饱渴.mjs'
import * as 饥饿 from './饥饿.mjs'

const MEM = process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const P = path.join(MEM, '疾病.json')
const 状态P = path.join(MEM, '状态.json')
const 自主P = path.join(MEM, '自主.json')

export const 病种 = {
  感冒: { 症状: ['鼻子堵', '头沉', '怕冷'], 基础率: 0.030, 发烧: 0.9 },
  发烧: { 症状: ['浑身发烫', '骨头缝里发酸', '没力气'], 基础率: 0.024, 发烧: 1.7 },
  肠胃炎: { 症状: ['肚子绞着疼', '没胃口'], 基础率: 0.028, 发烧: 0.3 },
}

const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 解析 = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00'); return Number.isFinite(t) ? t : 0 }
const 本月 = (ms = Date.now()) => 北京(ms).slice(0, 7)
const 空 = () => ({ 当前: [], 史: [], 上次判At: '', 上月: { 月: '', 次: 0 }, 值: 0, 值At: '', 上次加重At: '',
  用药: null, 挂水At: '', 就诊: null })
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }

function 档数据() {
  const d = 读档(P, null) || 空()
  if (!Array.isArray(d.当前)) d.当前 = []
  if (!Array.isArray(d.史)) d.史 = []
  if (!d.上月 || typeof d.上月 !== 'object') d.上月 = { 月: '', 次: 0 }
  if (!Number.isFinite(Number(d.值))) d.值 = 0
  if (!d.值At) d.值At = ''
  if (!d.用药 || typeof d.用药 !== 'object') d.用药 = null
  if (!d.挂水At) d.挂水At = ''
  if (!d.就诊 || typeof d.就诊 !== 'object') d.就诊 = null
  return d
}

// ── 恢复乘子：情绪（安慰剂）/ 休息 / 治疗 ─────────────────
export function 乘子(now = Date.now()) {
  let 情绪 = 1
  try {
    const st = load(状态P, {})
    const e = Number((st.layers || {}).emotional ?? 55)
    情绪 = e >= 70 ? 1.35 : e >= 55 ? 1.10 : e >= 40 ? 1.00 : e >= 25 ? 0.85 : 0.70
  } catch { /* 读不到按 1 */ }
  let 休息 = 0.9
  try {
    const 自主 = load(自主P, {})
    const 态 = String((自主.state && 自主.state.状态) || 自主.state || 自主.状态 || '')
    if (/睡|盹/.test(态)) 休息 = 1.5
    else if (/歇|发呆|躺|刷手机|玩电脑/.test(态)) 休息 = 1.2
  } catch { /* 读不到按 0.9 */ }
  // 治疗乘子 2026-11-08（批次224）：药起效期间恢复 ×1.3；挂水后 24 小时内 ×1.5。
  const 药 = 药效(now)
  let 治疗 = 1
  if (药.起效) 治疗 = Math.max(治疗, 1.3)
  const 挂 = 解析(档数据().挂水At)
  if (挂 && now - 挂 < 24 * 3600e3) 治疗 = Math.max(治疗, 1.5)
  return { 情绪, 休息, 治疗, 合: Math.round(情绪 * 休息 * 治疗 * 100) / 100 }
}

// ── 读：当前病况（只读，不写盘）──────────────────────────
export function 读(now = Date.now()) {
  const d = 档数据()
  const 当前 = d.当前.map((x) => ({ ...x }))
  const 重 = 当前.reduce((m, x) => Math.max(m, Number(x.重) || 0), 0)
  const 症状 = 当前.flatMap((x) => (Array.isArray(x.症状) ? x.症状 : []))
  const 主 = 当前.slice().sort((a, b) => (Number(b.重) || 0) - (Number(a.重) || 0))[0] || null
  const 发烧偏移 = Math.min(1.8, 当前.reduce((s, x) => {
    const 种 = 病种[x.名] || { 发烧: 0.6 }
    return s + Number(种.发烧 || 0) * Math.pow(Number(x.重) || 0, 1.2)
  }, 0))
  const 就 = d.就诊
  return {
    当前, 数: 当前.length, 重: Math.round(重 * 1000) / 1000,
    就诊: 就 ? {
      阶段: 就.阶段, 方案: 就.方案, 到: 就.到,
      剩分: Math.max(0, Math.round(((解析(就.到) || now) - now) / 60e3)),
    } : null,
    药: 药效(now),
    值: Math.round(Number(d.值) || 0),
    名: 主 ? 主.名 : '', 症状, 发烧偏移: Math.round(发烧偏移 * 100) / 100,
    体力扣: Math.round(重 * 25),
    心情扣: Math.round(重 * 20) / 10,
    乘子: 乘子(now),
  }
}

/** 发烧给体温的偏移（体温.mjs 调它；疾病不读体温，避免成环）。
 *  2026-11-08（批次224）：退烧药 −0.8、挂水后 6 小时 −0.5，都从这里扣。 */
export function 发烧偏移(now = Date.now()) {
  const r = 读(now)
  const 退 = 药效(now).退烧 + (解析(档数据().挂水At) && now - 解析(档数据().挂水At) < 6 * 3600e3 ? 0.5 : 0)
  return Math.max(0, Math.round((r.发烧偏移 - 退) * 100) / 100)
}

// ── 药效 2026-11-08（批次224，主人「药有生效时间」）────────
// 吃下去不是立刻好：30~45 分钟才起效，起效后 6 小时恢复 ×1.3。
// 分钟数按「当前分钟数」取，可复现，测试不用等半小时。
export function 吃药(名 = '', now = Date.now()) {
  const n = String(名 || '')
  const 分钟 = 30 + (Math.floor(now / 60000) % 16)
  const 用药 = { 名: n, 吃At: 北京(now), 起效At: 北京(now + 分钟 * 60e3), 到At: 北京(now + (分钟 + 360) * 60e3), 退烧: /退烧/.test(n) }
  // 批次609：锁内重读再改，别拿启动时的旧副本整档覆盖（心跳可能刚推进过病况）。
  return 改档(P, (d) => {
    d.用药 = 用药
    return { 名: n, 分钟, 起效At: 用药.起效At, 退烧: 用药.退烧 }
  }, 空())
}

export function 药效(now = Date.now()) {
  const y = 档数据().用药
  if (!y) return { 名: '', 起效: false, 剩分: 0, 退烧: 0 }
  const 起 = 解析(y.起效At), 到 = 解析(y.到At)
  const 起效 = !!起 && now >= 起 && now < 到
  return { 名: String(y.名 || ''), 起效, 剩分: Math.max(0, Math.round((到 - now) / 60e3)), 退烧: 起效 && y.退烧 ? 0.8 : 0 }
}

// ── 就诊 2026-11-08（批次224）────────────────────────────
// 挂号 → 排队（急诊 5-15，普通 10-40）→ 看诊 5 分钟 → 挂水 90-150 或开药走人。
// 挂水每 10 分钟补 40ml 水 + 30kcal 葡萄糖 + 血糖 0.08；结束只减重 0.25，不是立刻好。
export function 挂号(now = Date.now()) {
  let 结果 = null
  改档(P, (d) => {
    if (d.就诊 && 解析(d.就诊.到) > now) { 结果 = { ok: false, why: '已经在看了' }; return false }
    const r = 读(now)
    if (!r.数) { 结果 = { ok: false, why: '没病' }; return false }
    const 急诊 = r.重 >= 0.7
    const 分 = 急诊 ? 5 + (Math.floor(now / 60000) % 11) : 10 + (Math.floor(now / 60000) % 31)
    const 方案 = r.重 >= 0.5 ? '挂水' : '开药'
    d.就诊 = { 阶段: '排队', 起: 北京(now), 到: 北京(now + 分 * 60e3), 方案, 点: '医院', 上次补At: '' }
    结果 = { ok: true, 分, 方案, 急诊, 重: r.重 }
  }, 空())
  return 结果
}

export function 就诊推进(now = Date.now()) {
  let 结果 = { 变: '' }
  let 减 = 0
  let 补 = 0
  改档(P, (d) => {
    const j = d.就诊
    if (!j) { 结果 = { 变: '' }; return false }
    if (j.阶段 === '排队') {
      if (now < 解析(j.到)) { 结果 = { 变: '', 剩分: Math.max(0, Math.round((解析(j.到) - now) / 60e3)) }; return false }
      if (j.方案 === '挂水') {
        const 分 = 90 + (Math.floor(now / 60000) % 61)
        d.就诊 = { ...j, 阶段: '挂水', 起: 北京(now), 到: 北京(now + 分 * 60e3), 上次补At: 北京(now) }
        结果 = { 变: '挂水', 分 }
        return
      }
      d.就诊 = null
      结果 = { 变: '开药完' }
      减 = 0.15               // 开药回家吃：只降一点，剩下的靠恢复曲线
      return
    }
    if (j.阶段 === '挂水') {
      const 上次 = 解析(j.上次补At) || 解析(j.起) || now
      补 = Math.max(0, Math.floor((now - 上次) / (10 * 60e3)))
      if (补 > 0) j.上次补At = 北京(上次 + 补 * 10 * 60e3)
      if (now >= 解析(j.到)) {
        d.就诊 = null
        d.挂水At = 北京(now)
        结果 = { 变: '挂水完', 补 }
        减 = 0.25
        return
      }
      结果 = { 变: '', 补, 剩分: Math.max(0, Math.round((解析(j.到) - now) / 60e3)) }
    }
  }, 空())
  // 补液写的是 饱渴 档（另一个文件锁），减重会再锁本档 —— 都放到锁外，避免嵌套锁。
  if (补 > 0) {
    for (let i = 0; i < 补; i++) 饱渴.补液(40, 30, 0.08, now)
    // CACHE_REFRESH 2026-11-17（批次677）：挂水加的是千卡，饱腹缓存也要跟上。
    try { 饥饿.刷新饱腹(now) } catch { /* 缓存刷不上不影响挂水 */ }
  }
  if (减) 减重(减, now)
  return 结果
}

// ── 硬体感：她自己必须知道的事（事实陈述，不是指令）──────
export function 体感行(now = Date.now()) {
  const r = 读(now)
  if (!r.数) return ''
  const 种 = 病种[r.名] || {}
  const 症状 = r.症状.slice(0, 3).join('、')
  let s = `病 ${r.名} ${Math.round(r.重 * 100)}%（${症状}`
  if (r.发烧偏移 >= 0.3) s += `，有点低烧`
  s += '）'
  // 重到一定程度，头晕是躲不开的（主人：身体因素带来的强制感受，不靠她"想不想"）
  if (r.重 >= 0.6) s += '；站起来会一阵发晕'
  else if (r.重 >= 0.35 && r.体力扣 >= 8) s += '；身上发沉'
  // 就诊阶段是身体事实：排队/挂水时她确实走不开（挂水的手背上还贴着胶布）
  if (r.就诊) s += r.就诊.阶段 === '排队' ? '；在医院排队，叫到号才轮上' : '；挂着水，手背上贴着胶布'
  else if (r.药 && r.药.起效) s += '；药在起效'
  return s
}

/** 软倾向：只是"想"，不是命令；自主行动拿它调权重，不强制。 */
export function 倾向(now = Date.now()) {
  const r = 读(now)
  if (!r.数) return { 想躺着: 0, 想说话: 1 }
  const 重 = r.重
  return {
    想躺着: Math.round(Math.min(1, 重 * 1.4) * 100) / 100,
    想说话: Math.round(Math.max(0.4, 1 - 重 * 0.8) * 100) / 100,
  }
}

// ── 推进：按真实经过时间恢复（睡觉跨 8 小时也照算）────────
export function 推进(now = Date.now()) {
  就诊推进(now)              // 就诊状态先走一步（排队到点/挂水补液/结束），再算恢复
  改档(P, (d) => {
    if (!d.当前.length) return false
    const 乘 = 乘子(now).合
    const 留 = []
    for (const x of d.当前) {
      const 种 = 病种[x.名] || { 基础率: 0.028 }
      const 从 = 解析(x.重At) || 解析(x.起) || now
      const dt = Math.max(0, Math.min(24, (now - 从) / 3600e3))
      let 重 = Math.max(0, Number(x.重 || 0) - Number(种.基础率) * dt * 乘)
      // 恶化链：感冒拖过 12 小时还重，就转成发烧 —— 不是新抽一个病
      if (x.名 === '感冒' && 重 >= 0.6 && now - (解析(x.起) || now) >= 12 * 3600e3) {
        x.名 = '发烧'
        x.重 = Math.max(0.75, 重)
        x.症状 = 病种.发烧.症状.slice()
        x.诱因 = String(x.诱因 || '') + '（拖成了发烧）'
        重 = x.重
      }
      x.重 = Math.round(重 * 1000) / 1000
      x.重At = 北京(now)
      if (x.重 > 0.05) 留.push(x)
      else d.史 = [...d.史, { 名: x.名, 起: x.起, 好At: 北京(now) }].slice(-50)
    }
    if (!留.length && d.当前.length) d.值 = Math.min(Number(d.值) || 0, 300)   // 刚好，别立刻再病
    d.当前 = 留
  }, 空())
  return 读(now)
}

// ── 疾病值 2026-11-08（批次222，主人要的 0-1000 机制）──────
// 口径（主人原话整理）：
//   · 总量 1000，平时是「常驻扣除」往下压，恶劣条件往上推，加减和乘法一起用；
//   · **不是概率抽卡** —— 到阈值才病，600 起步，800 加重；绝不会有「1/1000 小概率生病」；
//   · 睡得沉、歇着、吃饱了，恢复更快；跑动吹风，积累更快。
export const 值满 = 1000

function 每小时变化(快照 = {}, 睡 = 0, 歇 = 0) {
  let 净 = -8                                  // 常驻扣除：什么都不干也会慢慢回落
  if (睡) 净 -= 6                              // 睡着再快一点（-14）
  else if (歇) 净 -= 2                         // 在家歇着（-10）
  if (Number(快照.体温 ?? 37) < 36) 净 += 12
  if (Number(快照.体温 ?? 37) < 35.5) 净 += 10
  if (Number(快照.体感 ?? 23) < 18) 净 += 8
  if (Number(快照.体感 ?? 23) < 12) 净 += 5
  if (快照.雨) 净 += 5
  if (Number(快照.风折 ?? 0) > 0.4) 净 += 6
  if (快照.熬夜) 净 += 10
  净 += Math.min(20, Math.max(0, Number(快照.虚弱 ?? 0) * 20))
  if (Number(快照.卡百分比 ?? 100) < 40) 净 += 8
  // 乘法：外套（跑动/吹风/淋雨一起出现）比单看更强，但不超过 1.8 倍
  let 乘 = 1
  if (快照.雨 && Number(快照.风折 ?? 0) > 0.4) 乘 = 1.3
  if (快照.雨 && 快照.熬夜) 乘 = Math.max(乘, 1.2)
  // RATE_CAP 2026-11-24：所有加法项同时命中时能叠到 +96/h，乘 1.3 = +125/h，
  // 从 0 到 600（得病线）只要 4.8 小时 —— 现实很难同时凑齐，但公式没有上限保护。
  // 封到 60/h：最坏情况也要 10 小时才病倒，跟她「熬一整夜才感冒」的体感对得上。
  return { 净: Math.min(60, 净 * 乘), 乘 }
}

/** 推进疾病值（状态推进每 15 分钟调一次）。返回当前值。 */
export function 累(快照 = {}, now = Date.now(), 睡 = 0, 歇 = 0) {
  let 值 = 0
  改档(P, (d) => {
    // 从 = 上次真正落盘的值At。dt 上限 12 小时是为了防「停机两天一次算两天」，
    // 但代价是：如果这中间改档抛错，值At 没更新，下一次会拿同一个 从 再算一遍 ——
    // 同一段时间被累加两次。DISEASE_DEDUP 2026-11-24：加一个「本分钟已算过」的短路。
    const 从 = 解析(d.值At) || now
    if (now - 从 < 60e3) { 值 = Number(d.值) || 0; return false }
    const dt = Math.max(0, Math.min(12, (now - 从) / 3600e3))
    if (dt > 0) {
      const r = 每小时变化(快照, 睡, 歇)
      d.值 = Math.max(0, Math.min(值满, Math.round((Number(d.值) || 0) + r.净 * dt)))
    }
    d.值At = 北京(now)
    值 = d.值
  }, 空())
  return 值
}

/** 只看当前疾病值，不动盘。 */
export function 疾病值(now = Date.now()) {
  return Math.round(Number(档数据().值) || 0)
}

// ── 风险：五项叠加，只用来算「每小时涨多少」，不再当概率 ─────
export function 风险(快照 = {}) {
  const 温 = Number(快照.体温 ?? 37)
  const 体感 = Number(快照.体感 ?? 23)
  const 雨 = !!快照.雨
  const 风折 = Number(快照.风折 ?? 0)
  const 熬夜 = !!快照.熬夜
  const 虚弱 = Number(快照.虚弱 ?? 0)
  const 卡 = Number(快照.卡百分比 ?? 100)
  let r = 0
  if (温 < 36.0) r += 0.25
  if (温 < 35.5) r += 0.20
  if (体感 < 18) r += 0.20
  if (体感 < 12) r += 0.10
  if (雨) r += 0.12
  if (风折 > 0.4) r += 0.12
  if (熬夜) r += 0.12
  if (虚弱 > 0.3) r += 0.15
  if (卡 < 40) r += 0.12
  return Math.round(Math.min(1, r) * 1000) / 1000
}

/** 判定一次。force=true 必中（只给测试）；返回 {中, 风险, 病}。 */
export function 判(快照 = {}, now = Date.now(), force = false) {
  let 结果 = null
  改档(P, (d) => {
    const r = 风险(快照)
    const 拒绝 = []
    // 已经有病：值还在 800 以上、且距上次加重超过 6 小时 → 加重（不是再得一个病）
    if (d.当前.length) {
      const 值0 = Number(d.值) || 0
      const 距加 = now - (解析(d.上次加重At) || 0)
      if (值0 >= 800 && 距加 >= 6 * 3600e3) {
        const x = d.当前[0]
        x.重 = Math.min(1, Math.round((Number(x.重 || 0) + 0.15) * 1000) / 1000)
        x.重At = 北京(now)
        if (x.重 >= 0.75 && x.名 === '感冒') { x.名 = '发烧'; x.症状 = 病种.发烧.症状.slice(); x.诱因 += '（加重）' }
        d.上次加重At = 北京(now)
        结果 = { 中: true, 风险: 风险(快照), 值: 值0, 加重: true, 病: x.名 }
        return
      }
      拒绝.push('already')
    }
    const 月 = 本月(now)
    if (d.上月.月 === 月 && Number(d.上月.次) >= 2) 拒绝.push('month-cap')
    const 免疫 = d.史.some((h) => now - (解析(h.好At) || 0) < 48 * 3600e3)
    if (免疫) 拒绝.push('immune')
    // THRESHOLD 2026-11-08（批次222）：不再掷骰子。疾病值到 600 才得病，800 才加重；
    // 「1/1000 小概率」那套会出现「明明好好的突然病倒」，主人明确不要。
    const 值 = Number(d.值) || 0
    const 中 = force || (!拒绝.length && 值 >= 600)
    if (!中) { 结果 = { 中: false, 风险: r, 值, 拒绝 }; return false }
    const 肠胃 = Number(快照.卡百分比 ?? 100) < 35 && Number(快照.虚弱 ?? 0) > 0.4
    const 名 = 肠胃 ? '肠胃炎' : '感冒'
    const 种 = 病种[名]
    // 值越高，一开始就越重：600 → 0.35，1000 → 0.85
    const 初重 = Math.round((0.35 + Math.min(400, Math.max(0, 值 - 600)) / 400 * 0.5) * 1000) / 1000
    d.当前.push({
      名, 起: 北京(now), 重: 初重, 重At: 北京(now),
      症状: 种.症状.slice(), 诱因: 诱因话(快照),
    })
    d.上月 = { 月, 次: (d.上月.月 === 月 ? Number(d.上月.次) || 0 : 0) + 1 }
    d.上次判At = 北京(now)
    d.上次加重At = 北京(now)
    结果 = { 中: true, 风险: r, 值, 病: 名 }
  }, 空())
  return 结果
}

function 诱因话(s = {}) {
  const t = []
  if (Number(s.体温 ?? 37) < 36) t.push('冻着了')
  if (s.雨) t.push('淋了雨')
  if (Number(s.体感 ?? 23) < 18) t.push('穿少了')
  if (s.熬夜) t.push('熬夜')
  if (Number(s.虚弱 ?? 0) > 0.3) t.push('一直没吃好')
  return t.join('+') || '说不上来'
}

/** 病好 / 降重（吃药、看病调）。 */
export function 减重(量 = 0.2, now = Date.now()) {
  改档(P, (d) => {
    for (const x of d.当前) x.重 = Math.max(0, Math.round((Number(x.重 || 0) - 量) * 1000) / 1000)
    d.当前 = d.当前.filter((x) => {
      if (x.重 > 0.05) return true
      d.史 = [...d.史, { 名: x.名, 起: x.起, 好At: 北京(now) }].slice(-50)
      return false
    })
  }, 空())
  return 读(now)
}

export function 好(名 = '', now = Date.now()) {
  改档(P, (d) => {
    const 留 = []
    for (const x of d.当前) {
      if (!名 || x.名 === 名) d.史 = [...d.史, { 名: x.名, 起: x.起, 好At: 北京(now), 手动: true }].slice(-50)
      else 留.push(x)
    }
    d.当前 = 留
  }, 空())
  return 读(now)
}

// ── 命令行 ────────────────────────────────────────────────
const 是主 = process.argv[1] && process.argv[1].endsWith('疾病.mjs')
if (是主) {
  const args = process.argv.slice(2)
  const val = (k, d = '') => { const i = args.indexOf('--' + k); return i >= 0 ? (args[i + 1] ?? d) : d }
  if (args.includes('--看')) {
    const r = 读()
    if (!r.数) console.log('没病')
    else {
      for (const x of r.当前) console.log(`${x.名} 重 ${Math.round(x.重 * 100)}%（${x.症状.join('、')}）起 ${x.起}｜诱因 ${x.诱因 || '不明'}`)
      console.log(`发烧偏移 +${r.发烧偏移}℃｜体力扣 ${r.体力扣}｜恢复乘子 ${r.乘子.合}（情绪 ${r.乘子.情绪} × 休息 ${r.乘子.休息} × 治疗 ${r.乘子.治疗}）`)
      if (r.就诊) console.log(`就诊：${r.就诊.阶段}（方案 ${r.就诊.方案}，剩 ${r.就诊.剩分} 分）`)
      if (r.药 && r.药.名) console.log(`用药：${r.药.名}｜${r.药.起效 ? '起效中，还剩 ' + r.药.剩分 + ' 分' : '还没起效'}`)
    }
    process.exit(0)
  }
  if (args.includes('--判')) {
    // 状态推进 会把快照拼好传进来；命令行这里自己读一份，方便手测
    const 快 = { 体温: 36.5, 体感: 20, 雨: false, 风折: 0, 熬夜: false, 虚弱: 0, 卡百分比: 100 }
    const r = 判(快, Date.now(), args.includes('--force'))
    console.log(r.中 ? `病了：${r.病}（风险 ${r.风险}）` : `没病（风险 ${r.风险}，值 ${r.值}，${(r.拒绝 || []).join('/') || '正常'}）`)
    process.exit(0)
  }
  if (args.includes('--tick')) {
    const r = 推进()
    const j = 读().就诊
    console.log((r.数 ? `${r.名} ${Math.round(r.重 * 100)}%` : '没病') + (j ? `｜${j.阶段} 剩 ${j.剩分} 分` : ''))
    process.exit(0)
  }
  if (args.includes('--吃药')) {
    const r = 吃药(val('吃药'))
    console.log(`${r.名}：${r.分钟} 分钟后起效${r.退烧 ? '（退烧）' : ''}`)
    process.exit(0)
  }
  if (args.includes('--挂号')) {
    const r = 挂号()
    if (!r.ok) console.log('挂不上：' + r.why)
    else console.log(`挂上号了：${r.急诊 ? '急诊' : '普通号'}，排队 ${r.分} 分钟，医生方案 ${r.方案}`)
    process.exit(0)
  }
  if (args.includes('--就诊')) { const r = 就诊推进(); console.log(JSON.stringify(r)) ; process.exit(0) }
  if (args.includes('--好')) { const r = 好(val('好')); console.log(r.数 ? '还剩 ' + r.名 : '好了') ; process.exit(0) }
  if (args.includes('--重设')) {
    const w = Math.max(0, Math.min(1, Number(val('重设', 0.5))))
    const now = Date.now()   // 2026-11-08（批次224）：原来 北京() 没传时间，重设直接崩
    改档(P, (d) => {
      if (!d.当前.length) d.当前.push({ 名: '感冒', 起: 北京(now), 重: w, 重At: 北京(now), 症状: 病种.感冒.症状.slice(), 诱因: '手动' })
      else d.当前[0].重 = w
    }, 空())
    console.log('重设 ' + w)
    process.exit(0)
  }
  console.log('用法：--看 / --判 [--force] / --tick / --好 [名] / --重设 0.6')
}
