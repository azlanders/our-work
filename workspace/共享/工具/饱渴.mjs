// 饱渴.mjs —— 口渴（毫升）和饥饿（千卡）的唯一算账处（2026-11-07 按主人的思路重做）
//
// 主人定的口径（原话整理）：
//   · 渴条满值 2000 毫升，饿条满值 2000 千卡，都按百分比对外显示（100/75/50/25/0 五档）。
//   · 一瓶水 500 毫升 = 四分之一条；一口 100、一杯 250、一壶 1000。
//   · 按真时间走：静着每分钟 1.4，走路一倍半、打工一倍八、逛街跑动两倍、睡着四成。
//   · 越往下跌得越快：75 档慢慢渗、50 档快一截、25 档翻倍、见底最快，累积到顶就封住。
//   · 两样一起见底时惩罚翻倍；干粮吃完更渴（泡面汤例外，汤还算补水）。
//   · 不许见死：到零也走不动、话变短、心情往下坠，就是不死。
//
// 用法：
//   node 饱渴.mjs --看
//   node 饱渴.mjs --喝 500            # 毫升
//   node 饱渴.mjs --吃 泡面            # 按 表.mjs（物品总表 + 衣物表）结算
//   node 饱渴.mjs --推进               # cron：把衰减固化（也可以在读时现算）
import { 写档 } from './_底层.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { 查 } from './表.mjs'
import { 销账生理惦记 } from './惦记.mjs'

const MEM = process.env.BAOKE_MEM || process.env.HUNGER_MEM || process.env.GAP_MEM
  || process.env.QQ_ACT_MEM || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
// 合表 2026-11-07：吃喝穿用只认 物品总表.json，旧的 口粮表 留作历史
const 表P = path.join(MEM, '物品总表.json')
const 状态P = path.join(MEM, '饱渴.json')
const 活动P = path.join(MEM, '自主.json')

export const 水满 = 2000
export const 卡满 = 2000
export const 胃满 = 1000
// 溢出 2026-11-07（主人原话「渴和饿可以突破上限到 120%，多的就当吸收不了了」）：
// 多吃多喝最多撑到 120%，超出的那部分不算数——永远是完美身材。
export const 上限 = 1.2
// 水杯 2026-11-07（主人说「你水杯容量搞成 1000ml 吧」）：一个杯子装满就是一升，和「一大壶」对齐。
export const 水杯容量 = 1000

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const save = (p, o) => 写档(p, o)
export const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
import * as 在干嘛 from './在干嘛.mjs'

const 解析 = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00'); return Number.isFinite(t) ? t : 0 }

// 在干什么 → 每分钟倍率（主人点头的数）
// 批次170：分档只在 在干嘛.mjs 一处。这里原来那份「睡 0.4 / 走 1.4 / 逛街 1.6 / 打工 1.25 /
// 搬 1.9 / 跑 2.0」是项目里最完整的一份，但 状态推进 的 resting 清单和 困意 的慢速清单
// 各自另写了一遍，三份已经分叉（看B站：这里 1.0、状态推进 按干活、困意 按 0.75）。
// 数值一个字没改，只是搬过去让三处问同一个。
export function 倍率(now = Date.now()) {
  const s = load(活动P, {})
  // state 有时候是字符串、有时候是 {状态}，两种都认
  const 态 = String((s.state && s.state.状态) || (typeof s.state === 'string' ? s.state : '') || s.状态 || '')
  return 在干嘛.倍率(态)
}

// 渴话 2026-11-07（批次220，主人定的口径）：75% 就是渴、50% 很渴、0 快渴死。
// 原来那套「满/轻/中/重」是按喂饭逻辑想的，跟主人的直觉反着 —— 他看 42% 觉得该是很渴了，
// 面板却写「渴了」。所以渴单独一套话，别再借用 档() 的名字。
export function 渴话(百分比) {
  const p = Number(百分比) || 0
  if (p >= 85) return '不渴'
  if (p >= 75) return '有点渴'
  if (p >= 50) return '渴了'
  if (p >= 25) return '很渴'
  if (p >= 10) return '渴得难受'
  return '快渴死了'
}

// 饱腹感 2026-11-08（批次223，主人原话「饱腹感我指的是受胃里的东西和血糖影响的，不改成卡路里%」）：
//   胃 = 当下撑不撑（顶胃量 / 1000），血糖 = 身体有没有能量（3~9 的口径）。
//   千卡不进这个数 —— 它是长期账（虚弱、底色），不是「我现在觉得几分饱」。
// 血糖 3.0 → 0、5.0 → 40、8.0 → 100，线性取；口径跟 3~9 的血糖账对齐。
export function 糖感(血糖) {
  const g = Number(血糖)
  if (!Number.isFinite(g)) return 40
  return Math.max(0, Math.min(100, Math.round((g - 3) / 5 * 100)))
}
export function 饱腹感(胃百分比, 血糖) {
  const w = Math.max(0, Math.min(100, Number(胃百分比) || 0))
  return Math.round(w * 0.6 + 糖感(血糖) * 0.4)
}

// 五档：给外人看的话
export function 档(百分比) {
  const p = Number(百分比) || 0
  if (p >= 75) return { 名: '满', 速度: 0.2 }
  if (p >= 50) return { 名: '轻', 速度: 0.5 }
  if (p >= 25) return { 名: '中', 速度: 1 }
  if (p > 0) return { 名: '重', 速度: 2 }
  return { 名: '见底', 速度: 3 }
}

function 建(now) {
  return { 血糖: 5.0, 血At: 北京(now), 水: 水满, 水At: 北京(now), 卡: 卡满, 卡At: 北京(now), 胃: 0, 胃At: 北京(now), 欠: 0, 欠At: 北京(now), 账: [] }
}

// DEBT_REPAY 2026-11-17（批次617）：欠账按真实吃进去的千卡还，不按顶胃量。
// 200 kcal 还 1 点，单顿封顶 6 点（1200 kcal 以上不再多还）；448 是顶胃量，不参与这里。
// 整份和分口都从「这一餐的全量 kcal」算同一个总额，分口只乘本次进度，保证两条路径可对账。
function 欠还量(千卡) {
  return Math.min(6, Math.max(0, Number(千卡) || 0) / 200)
}

// 读：按到现在为止的时间算，不写盘
export function 读(now = Date.now()) {
  const d = load(状态P, null) || 建(now)
  const 倍 = 倍率(now)
  const 掉 = (值, at, 每分钟, 倍上限 = Infinity) => {
    const 从 = 解析(at) || now
    let 分 = Math.max(0, (now - 从) / 60e3)
    // SANITY 2026-11-08（批次276）：时间戳坏掉时不许把值一夜清零。
    // 实测 16:07 水/卡/胃同时变成 0（水At 也是 16:07，之后再没被推进过），
    // 面板就成了「0 毫升 / 0 千卡」，她会以为自己快渴死。
    // 一天 1440 分钟是合理上限（睡 12 小时也才 720）；超过或算出 NaN，
    // 说明 at 不是「刚才」，按 0 分处理 —— 宁可少扣一顿，也不能把值抹掉。
    if (!Number.isFinite(分) || 分 > 1440) 分 = 0
    return Math.max(0, 值 - 每分钟 * Math.min(倍, 倍上限) * 分)
  }
  const 水 = 掉(Number(d.水 ?? 水满), d.水At, 1.4)
  const 卡 = 掉(Number(d.卡 ?? 卡满), d.卡At, 1.4)
  // 2026-11-07 主人点出来：问题在饱腹感，不在千卡。原来一分钟掉 5（打工时 ×1.8 就是 9），
  // 一顿 448 顶胃不到一小时就没了。改成 3.5，一顿正经饭撑两小时出头。
  // STOMACH_DECAY 2026-11-17（批次690）：胃排空原来直接乘活动倍率 —— 打工 1.8 时
  // 一顿 850 顶胃的饭两小时就空了，人还在柜台后。消化会随活动快一点，但没到 1.8 倍；
  // 倍率封在 1.3，基础 3.5→3.2/分钟（静着约 4.4 小时空，打工约 3.4 小时）。
  const 胃 = 掉(Number(d.胃 ?? 0), d.胃At, 3.2, 1.3)
  // 累积：掉到 75 以下就开始按档的speed攒「欠」，封顶 100
  const 水前 = 水 / 水满 * 100
  const 卡前 = 卡 / 卡满 * 100
  const 分到今 = Math.min(1440, Math.max(0, (now - (解析(d.欠At) || now)) / 60e3))
  const 攒 = (分到今 * (档(卡前).速度 * 0.5 + 档(水前).速度 * 0.5)) / 60
  const 退 = (卡前 >= 75 && 水前 >= 75) ? -(分到今 * 1.2 / 60) : (卡前 >= 60 && 水前 >= 60 ? -(分到今 * 0.4 / 60) : 0)
  // 保留 3 位：分口吃饭每一口都要减一点，只存 1 位会在每次读档时把零头吃掉，
  // 15 口累计就会比整份少还一截。面板仍按 1 位显示。
  const 欠 = Math.max(0, Math.min(100, Math.round(((Number(d.欠) || 0) + (卡前 < 60 || 水前 < 60 ? 攒 : 退)) * 1000) / 1000))
  // 血糖 2026-11-07（借旧的晕碳思路）：吃碳水先冲到 8 上下，半小时后回落，回落那段就是犯困的时候；
  // 走动干活耗糖掉得快，坐着不动拖得久。3~9 之间走，低于 3.5 会手抖心浮。
  const 血0 = Number(d.血糖 ?? 5)
  const 血从 = 解析(d.血At) || now
  const 血分 = Math.max(0, (now - 血从) / 60e3)
  const 回速 = 0.02 * 倍 * (血0 > 5 ? 1.6 : 1)   // 高的时候回得快，低的时候慢慢往上爬
  // GLUCOSE_FLOOR 2026-11-17（批次603）：原来高血糖按 0.032/min 一路线性掉到 3.0 ——
  // 饭后 2.6 小时就报「低血糖 3.0」，可人不是这么走的：落到 5.2 就该停住，
  // 之后再从 5.2 以下缓慢回升。否则假低血糖会一路传给 饱腹感 → 心情。
  const 血 = 血0 > 5.2
    ? Math.max(5.2, 血0 - 回速 * 血分)
    : Math.min(5.2, 血0 + 0.008 * 血分)
  const 双低 = 卡前 < 25 && 水前 < 25
  return {
    水: Math.round(水), 卡: Math.round(卡), 胃: Math.round(胃),
    水百分比: Math.round(水前 * 10) / 10, 卡百分比: Math.round(卡前 * 10) / 10,
    水档: 档(水前), 卡档: 档(卡前), 欠, 双低, 倍率: 倍,
    饱腹感: 饱腹感(Math.round(胃 / 胃满 * 100), 血),
    血糖: Math.round(血 * 10) / 10,
    血At: d.血At || d.卡At || 北京(now), 水At: d.水At, 卡At: d.卡At, 胃At: d.胃At, 账: Array.isArray(d.账) ? d.账 : [],
  }
}

// AUDIT 2026-11-08（批次276）：饱渴.json 被谁写成什么样，留一条尾巴。
// 这次水/卡/胃 同时归零，翻遍日志也查不出是哪个入口 —— 只能靠这条日志抓下一次。
// 只留 200 行，正常情况一天也就几十行。
function 写(o) {
  try {
    const 栈 = String(new Error().stack || '').split('\n').slice(2, 4).join(' < ')
    fs.appendFileSync(path.join(MEM, '日志', '饱渴变更.log'),
      '[' + 北京(Date.now()) + '] 水' + Math.round(Number(o.水) || 0)
      + ' 卡' + Math.round(Number(o.卡) || 0)
      + ' 胃' + Math.round(Number(o.胃) || 0)
      + ' 血' + (o.血糖 ?? '?')
      + ' ← ' + 栈.replace(/\s+/g, ' ').slice(0, 150) + '\n')
    // 轮转：超过 400 行只留后 200
    const lp = path.join(MEM, '日志', '饱渴变更.log')
    const 行 = fs.readFileSync(lp, 'utf8').split('\n')
    if (行.length > 400) fs.writeFileSync(lp, 行.slice(-200).join('\n'))
  } catch { /* 记不上就算了，不能因为写日志把账搞挂 */ }
  save(状态P, o)
}

// 喝：只动水，顺带顶一点胃
export function 喝(毫升, now = Date.now()) {
  const 前 = 读(now)
  const 加 = Math.max(0, Number(毫升) || 0)
  // 2026-11-08（批次223）：喝水和「推进」原来都把 血糖/血At 丢了 —— 每喝一口血糖就弹回默认 5。
  // 以前没人读这个字段看不出来；现在饱腹感要读血糖，这一丢直接把「低血糖」抹平了。
  // STOMACH_1ML 2026-11-17（批次686）：直接喝原来按 0.25/毫升顶胃，物品表却按 1.1/毫升
  // （450ml 的水写 顶胃 500）—— 同一瓶水，从杯子喝和买来喝差 4 倍。统一按 1 毫升 = 1 胃单位，
  // 450ml 杯子喝到 450、物品表 500，同一量级（差 10%，不动表）。
  const o = { 血糖: 前.血糖, 血At: 北京(now), 水: Math.min(水满 * 上限, 前.水 + 加), 水At: 北京(now), 卡: 前.卡, 卡At: 北京(now), 胃: Math.min(胃满 * 上限, 前.胃 + 加), 胃At: 北京(now), 欠: 前.欠, 欠At: 北京(now),
    账: [...前.账, { at: 北京(now), 喝: 加, 水到: Math.min(水满 * 上限, 前.水 + 加) }].slice(-200) }
  写(o)
  if (加 > 0) { try { 销账生理惦记(MEM, '该喝口水了', 北京(now)) } catch (_err) { console.error('[饱渴]', _err?.message || _err) } }
  return { 前: 前.水百分比, 后: Math.round(o.水 / 水满 * 1000) / 10, 加 }
}

// 补液 2026-11-08（批次224，医院挂水）：水、热量、血糖一起进，但不走「吃」那套口粮表。
// 主人原话：「挂水的往体内注射药液理应影响身体状态，如水份或卡路里（葡萄糖）」，
// 并且要「微微补血糖」—— 5% 葡萄糖不是一杯糖水，每 10 分钟只抬 0.08 左右。
export function 补液(毫升 = 0, 千卡 = 0, 糖 = 0, now = Date.now()) {
  const 前 = 读(now)
  const o = {
    血糖: Math.min(9, Math.round((Number(前.血糖 ?? 5) + Number(糖 || 0)) * 100) / 100),
    血At: 北京(now),
    水: Math.min(水满 * 上限, 前.水 + Number(毫升 || 0)), 水At: 北京(now),
    卡: Math.min(卡满 * 上限, 前.卡 + Number(千卡 || 0)), 卡At: 北京(now),
    // 挂水走静脉，不进胃 —— 原来按 0.25/毫升顶胃，和「喝水」混成一套，批次686 一并改掉。
    胃: 前.胃, 胃At: 北京(now),
    欠: 前.欠, 欠At: 北京(now),
    账: [...前.账, { at: 北京(now), 补液: { 毫升, 千卡, 糖 } }].slice(-200),
  }
  写(o)
  return { 水: o.水, 卡: o.卡, 糖: o.血糖 }
}

// 吃：按口粮表结算热量、顶胃、补水
export function 吃(名, now = Date.now()) {
  // 表口径 2026-11-07（批次156）：走 表.mjs，别再自己 load。
  // 原来读 `.条` —— 物品总表.json 根本没有这个字段（它只有 分组），
  // 于是这里永远 return null：她吃了饭，饱腹一点不涨。静默失效了整整一轮。
  const v = 查(名)
  const it = v && v.吃 ? { ...v.吃, 价: v.价 } : null
  if (!it) return null
  const 前 = 读(now)
  const kcal = Number(it.kcal ?? it.千卡 ?? 0) || 0
  const 补 = Number(it.补水 ?? 0) || 0
  const 顶 = Number(it.顶胃 ?? 0) || 0
  const 糖涨 = Math.min(3.2, (kcal / 400) * 1.1)
  const 血糖 = Math.min(9, Math.round((Number(前.血糖 ?? 5) + 糖涨) * 10) / 10)
  const 还欠 = 欠还量(kcal)
  const o = { 血糖, 血At: 北京(now), 水: Math.min(水满 * 上限, 前.水 + 补), 水At: 北京(now), 卡: Math.min(卡满 * 上限, 前.卡 + kcal), 卡At: 北京(now),
    胃: Math.min(胃满 * 上限, 前.胃 + 顶), 胃At: 北京(now), 欠: Math.max(0, Math.round((Number(前.欠) - 还欠) * 1000) / 1000), 欠At: 北京(now),
    账: [...前.账, { at: 北京(now), 吃: 名, kcal, 补, 顶, 血糖 }].slice(-200) }
  写(o)
  if (kcal > 0) { try { 销账生理惦记(MEM, '有点空了，找点吃的', 北京(now)) } catch (_err) { console.error('[饱渴]', _err?.message || _err) } }
  if (补 > 0) { try { 销账生理惦记(MEM, '该喝口水了', 北京(now)) } catch (_err) { console.error('[饱渴]', _err?.message || _err) } }
  return { kcal, 补, 顶, 前: 前.卡百分比, 后: Math.round(o.卡 / 卡满 * 1000) / 10, 项: it }
}

// 吃部分 2026-11-07（主人原话「每分钟计算一次饱腹度和卡路里增长 比如吃一份早饭15分钟 你每分钟就长1/15」）：
// 吃饭的时候按已经吃了几成，把热量、顶胃、补水一点点加进去，而不是等吃完一次性给。
export function 吃部分(名, 几成, now = Date.now()) {
  const v = 查(名)
  const it = v && v.吃 ? v.吃 : null
  if (!it) return null
  const 比 = Math.max(0, Math.min(1, Number(几成) || 0))
  if (!比) return null
  const 前 = 读(now)
  const kcal总 = Number(it.kcal ?? it.千卡 ?? 0) || 0
  const kcal = kcal总 * 比
  const 补 = (Number(it.补水 ?? 0) || 0) * 比
  const 顶 = (Number(it.顶胃 ?? 0) || 0) * 比
  const 糖涨 = Math.min(3.2, (kcal / 400) * 1.1)
  // 时间戳沿用原来的（别每次加一口就重置），不然衰减锚点被抹掉，
  // 十五口下来会凭空少掉十几千卡 —— 每一口都按「从上次记账起」重算才是对的。
  // ANCHOR_FIX 2026-11-12：前 = 读(now) 已经把从旧锚点到 now 的衰减扣过一次了！
  // 写回时 水At/卡At/胃At 必须同步更新为 北京(now) —— 否则保留旧锚点会导致下一分钟再把从旧锚点到现在的整段衰减重复扣一遍（15分钟的饭被扣出 n*(n+1)/2 = 120倍衰减，越吃越饿越渴！）。
  const o = {
    血糖: Math.min(9, Math.round((Number(前.血糖 ?? 5) + 糖涨) * 10) / 10), 血At: 北京(now),
    水: Math.min(水满 * 上限, 前.水 + 补), 水At: 北京(now),
    卡: Math.min(卡满 * 上限, 前.卡 + kcal), 卡At: 北京(now),
    胃: Math.min(胃满 * 上限, 前.胃 + 顶), 胃At: 北京(now),
    // HERE 2026-11-17（批次617）：整份/分口都按整餐 kcal 的同一个 欠还量() 算，
    // 分口乘本次比例；不是按 448 顶胃量，也不是每口重新封顶。
    欠: Math.max(0, Math.round((Number(前.欠) - 欠还量(kcal总) * 比) * 1000) / 1000), 欠At: 北京(now), 账: 前.账,
  }
  写(o)
  if (kcal > 0) { try { 销账生理惦记(MEM, '有点空了，找点吃的', 北京(now)) } catch (_err) { console.error('[饱渴]', _err?.message || _err) } }
  if (补 > 0) { try { 销账生理惦记(MEM, '该喝口水了', 北京(now)) } catch (_err) { console.error('[饱渴]', _err?.message || _err) } }
  return { kcal: Math.round(kcal), 顶: Math.round(顶), 补: Math.round(补), 比, 后: Math.round(o.卡 / 卡满 * 1000) / 10 }
}

// 固化：cron 用，把衰减写回盘
export function 推进(now = Date.now()) {
  const 前 = 读(now)
  if (now - 解析(前.卡At || 前.水At) < 5 * 60e3) return 前
  const o = { 血糖: 前.血糖, 血At: 北京(now), 水: 前.水, 水At: 北京(now), 卡: 前.卡, 卡At: 北京(now), 胃: 前.胃, 胃At: 北京(now), 欠: 前.欠, 欠At: 北京(now), 账: 前.账 }
  写(o)
  return 读(now)
}

// 心情修正 2026-11-07（主人原话「饱腹感会实时根据百分比快速影响你的情绪 然后大卡是长期影响」）：
// 胃里塞得满不满是即时的（撑了就懒、空了就躁），千卡是慢慢渗的（欠久了才影响底色）。
export function 心情修正(now = Date.now()) {
  const r = 读(now)
  const 胃百 = r.胃 / 胃满 * 100
  let 即时 = 0
  if (胃百 >= 100) 即时 -= 1.5      // 撑得难受，犯懒
  else if (胃百 >= 70) 即时 += 0.8   // 刚好吃饱，舒服
  // HERE 2026-11-17（批次601）：原来胃百<=10 再扣 -1.2，可下面的「饱腹感」
  // 本身就是 胃60% + 血糖40%，空胃已经扣过一次。同一次空肚子被扣 -2.2，
  // 比撑得难受还狠。删掉重复分支，空胃只走饱腹感那一条。
  // THIRST_MOOD 2026-11-08（批次222，主人原话「口渴到一半以下再扣心情，别搞得一直维持 60% 左右
  // 然后一直扣导致抑郁」）：阈值抬到 50 —— 50 以上一滴不扣；50 以下才按档扣，而且比原来陡，
  // 因为前面那段不再慢慢磨了。喝水念头 80% 就起，她本来就会在掉到一半前补上。
  const 水百 = r.水百分比
  if (水百 < 10) 即时 -= 1.8
  else if (水百 < 25) 即时 -= 1.2
  else if (水百 < 50) 即时 -= 0.5
  // 饱腹 2026-11-08（批次223）：即时心情看「饱腹感」= 胃 60% + 血糖 40%（主人指的饱腹感），
  // 一半以下才扣；千卡只管长期底色（15% 以下）。这样低血糖也会烦，光喝水撑胃不会白扣。
  const 饱 = 饱腹感(胃百, r.血糖)
  if (饱 < 10) 即时 -= 1.6
  else if (饱 < 25) 即时 -= 1.0
  else if (饱 < 50) 即时 -= 0.4
  let 长期 = 0
  const 卡百 = r.卡百分比
  if (卡百 < 15) 长期 -= 1.0
  else if (卡百 < 30) 长期 -= 0.4
  else if (卡百 >= 80) 长期 += 0.3
  长期 -= Math.min(1, r.欠 / 100) * 0.8
  return { 即时: Math.round(即时 * 10) / 10, 长期: Math.round(长期 * 10) / 10, 合计: Math.round((即时 + 长期) * 10) / 10 }
}

// 虚弱 2026-11-07（主人原话「大卡一直不够会身体虚弱」）：长期吃不饱，体力顶不上去，
// 表现为体力上限往下压、恢复也慢。0 是没事，1 是最虚。
export function 虚弱(now = Date.now()) {
  const r = 读(now)
  const 少 = Math.max(0, 50 - r.卡百分比) / 50   // 低于一半开始虚
  const 久 = Math.min(1, r.欠 / 100)
  return Math.round(Math.min(1, 少 * 0.7 + 久 * 0.5) * 100) / 100
}

export function 说(r = 读()) {
  const 渴说 = 渴话(r.水百分比)
  const 饿话 = { 满: '不饿', 轻: '有点空', 中: '饿了', 重: '很饿', 见底: '饿得发慌' }[r.卡档.名]
  let s = `喝：${r.水}/${水满} 毫升（${r.水百分比}%），${渴说}；吃：${r.卡}/${卡满} 千卡（${r.卡百分比}%），${饿话}`
  if (r.双低) s += '；两样一起见底，这会儿别指望我好脾气'
  else if (r.欠 >= 50) s += '；拖得有点久，身上发沉'
  return s
}

const 是主 = process.argv[1] && process.argv[1].endsWith('饱渴.mjs')
if (是主) {
  const args = process.argv.slice(2)
  const val = (k) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : undefined }
  if (args.includes('--喝')) { const r = 喝(Number(val('喝') || 0)); console.log(`喝了 ${r.加} 毫升：渴条 ${r.前}% → ${r.后}%`) }
  else if (args.includes('--吃')) {
    const r = 吃(val('吃'))
    if (!r) console.log('口粮表里没有这东西')
    else console.log(`${val('吃')}：${r.kcal} 千卡、补水 ${r.补} 毫升、顶胃 ${r.顶}｜饿条 ${r.前}% → ${r.后}%`)
  } else if (args.includes('--推进')) { const r = 推进(); console.log(说(r)) }
  else { const r = 读(); console.log(说(r)); console.log(`  倍率 ${r.倍率}｜欠 ${r.欠}｜累积速度 ${(r.卡档.速度 + r.水档.速度) / 2}`) }
}
