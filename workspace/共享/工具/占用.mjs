import { 吃喝动词 } from './在干嘛.mjs'

// 占用.mjs —— 她现在「走不开」吗？四个占用态，一处判
//
// 批次167（2026-11-07）。跟批次164 收「睡着」是同一类病：
//
//   吃饭   7 处读（工作 / 缺口 / 自主行动×3 / 面板）
//   洗澡   6 处读（缺口 / 自主行动×3 / 面板）
//   打盹   4 处读（状态推进 / 睡态 / 缺口 / 自主行动）
//   在岗   6 处读（同步QQ状态 / 活动 / 缺口×2 / 自主行动×3）
//
// 其中「在岗」已经分叉出真症状：缺口 认「待上 + 已到点 + 人在点上」（批次146 修的），
// 自主行动/活动/同步QQ状态 只认「状态=在岗」。沙盒复现（09:00:01 刚上班那一分钟）：
//
//   待上 → 缺口：「在咖啡店上班，不补缺口」           ✓
//   待上 → 自主行动：「现在去拍张照」→ state 被改掉    ✗
//   待上 → 活动：记成 打工（体力 -5）而不是 值班（-2.5）✗
//   在岗 → 自主行动：「这一轮不换动作」                ✓
//
// 所以「加一个新的占用态要改四处」这句话，改成「只在 占用.mjs 里加一条」。
//
// 三个坑写在代码里（都是真的踩过）：
//   · 吃饭 判 `到`、洗澡 判 `结束` —— 洗澡档里的 `到` 是【清洁度数字】，不是时间。
//   · 班次必须判 起止时段 —— 只认「状态=在岗」会让一条过期的班永远成立。
//   · 判据是「到点没到」，不是「文件在不在」。
import path from 'node:path'
import { 读档, 解析北京 } from './_底层.mjs'
import { 打盹中 } from './睡态.mjs'

const 取目录 = (d) => d || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'

/** 正在吃的这顿。判 `到` 不判文件存在 —— 文件常常还在，只是吃完了。 */
export function 在吃饭(目录, now = Date.now()) {
  const d = 读档(path.join(取目录(目录), '吃饭.json'), null)
  if (!d || typeof d !== 'object') return null
  const 到 = Number(d.到毫秒) || 解析北京(d.到, 0)
  if (!(到 > now)) return null
  return { 到, 在哪: String(d.在哪 || ''), 吃啥: String(d.吃啥 || '') }
}

/** 正在洗澡。时间在 `结束`；`到` 是洗到多干净的数字。 */
export function 在洗澡(目录, now = Date.now()) {
  const d = 读档(path.join(取目录(目录), '卫生.json'), {})
  const w = d && d.洗澡中
  if (!w || typeof w !== 'object') return null
  const 到 = Number(w.到毫秒) || 解析北京(w.结束, 0)
  if (!(到 > now)) return null
  return { 到, 在哪: String(w.在哪 || '') }
}

/** 正在医院排队 / 挂水（批次224）。判据只有 疾病.json 的 就诊 一处。 */
export function 在看病(目录, now = Date.now()) {
  const d = 读档(path.join(取目录(目录), '疾病.json'), null)
  const j = d && d.就诊
  if (!j || typeof j !== 'object') return null
  const 到 = 解析北京(j.到, 0)
  if (!(到 > now)) return null
  return { 阶段: String(j.阶段 || ''), 到, 在哪: String(j.点 || '医院'), 详情: j }
}

/** 正在打盹（短睡，不算一觉）。判据只有 睡态.mjs 一份，这里只是转发。 */
export function 在打盹(目录, now = Date.now()) {
  return 打盹中(目录, now)
}

/**
 * 这一班这会儿她算不算在岗。纯函数 —— 只看班次、资产快照、当前时刻。
 *
 * 判据只有这一份。批次172 之前这里是空的：工作.mjs 自己写着
 * `位 === 班.点 && !途中`，而 占用.在岗的班 只看「状态=在岗」。
 * 于是她 22:00 在便利店打卡守夜、05:54 走回家，06:00 到家时状态还是「在岗」
 * （班次 06:00 才到点），六个地方各自推出六种答案：
 *
 *   · 同步QQ状态  拼出「在家上便利店夜班」
 *   · 缺口        判「在上班」不补缺口；自主行动 判「走不开」不换动作
 *   · 自动作息    判「走不开，柜台后面眯一会儿」—— 可她人在家里
 *   · 工作.mjs    把它当成「人没到」，记「迟到 474 分钟」扣了 20 块
 *
 * 「在不在班上」是一个事实。一个事实只该有一处判。
 */
export function 算在岗(班, 资 = {}, now = Date.now()) {
  if (!班 || typeof 班 !== 'object') return false
  const a = 资 || {}
  const 位 = String(a.位置 || '')
  if (!位) return false                              // 位置不知道 —— 交给调用方保守处理
  const 途 = a.在途
  if (途 && Number(途.arriveAt) > now) return false   // 已经上路了，人在半路
  return 位 === String(班.点 || '')
}

/**
 * 正在上的这个班。返回班次本身（调用方要 .点/.活/.止）。
 *
 * 认两种：
 *   ① 状态=在岗            —— 工作.mjs 打过卡了
 *   ② 状态=待上 + 时段已开始 + 人就在这个点上 —— 打卡前的空窗
 *
 * ②是批次146 在 缺口 里补的：22:00:01 缺口和工作是同一秒的两个 cron，
 * 缺口先抽签时状态还是「待上」，于是她上班第一分钟买了一瓶水。
 * 那份修在缺口里，另外三处没跟上 —— 现在只有这一份。
 *
 * 批次172：① 原来直接 return，**不看人在哪儿**。状态=在岗 只说明「她打过卡」，
 * 不说明「她现在还在店里」。位置对不上就不算在岗 —— 跟 工作.mjs 的判定同一份判据。
 */
export function 在岗的班(目录, now = Date.now()) {
  const 目 = 取目录(目录)
  const 工 = 读档(path.join(目, '工作.json'), null)
  if (!工 || !Array.isArray(工.班次)) return null
  const 资 = 读档(path.join(目, '资产.json'), {}) || {}
  const 位 = String(资.位置 || '')
  for (const b of 工.班次) {
    if (!b) continue
    const 状态 = String(b.状态 || '')
    if (状态 !== '在岗' && 状态 !== '待上') continue
    const 起 = 解析北京(b.起, 0)
    const 止 = 解析北京(b.止, 0)
    if (!起 || !止 || now < 起 || now >= 止) continue
    if (算在岗(b, 资, now)) return b
    // 位置读不到（资产.json 被清过）时保守算在岗：宁可少放她乱跑，
    // 也别把正在上班的人从班上赶走。
    if (状态 === '在岗' && !位) return b
  }
  return null
}


/**
 * 她这会儿走不开吗。返回 { 什么, 到, 在哪, 详情 }，空闲返回 null。
 *
 * 顺序：上班 > 洗澡 > 吃饭 > 打盹。上班排最前是因为它占的时间最长
 * （4~8 小时），漏一次的代价最大（考勤、体力、困意三条线一起错）。
 */
export function 占着(目录, now = Date.now()) {
  const 班 = 在岗的班(目录, now)
  if (班) return { 什么: '上班', 到: 解析北京(班.止, 0), 在哪: String(班.点 || ''), 详情: 班 }
  const 病 = 在看病(目录, now)
  if (病) return { 什么: 病.阶段 === '挂水' ? '挂水' : '排队', 到: 病.到, 在哪: 病.在哪, 详情: 病 }
  const 洗 = 在洗澡(目录, now)
  if (洗) return { 什么: '洗澡', 到: 洗.到, 在哪: 洗.在哪, 详情: 洗 }
  const 饭 = 在吃饭(目录, now)
  if (饭) return { 什么: '吃饭', 到: 饭.到, 在哪: 饭.在哪, 详情: 饭 }
  if (在打盹(目录, now)) {
    const n = 读档(path.join(取目录(目录), '打盹.json'), null) || {}
    return { 什么: '打盹', 到: Number(n.到毫秒) || 解析北京(n.到, 0), 在哪: '', 详情: n }
  }
  return null
}

/** 一句话说清她为什么走不开（日志/面板用）。 */
export function 占用话(目录, now = Date.now()) {
  const o = 占着(目录, now)
  if (!o) return ''
  if (o.什么 === '上班') return `在${o.在哪}上班（${String((o.详情 || {}).活 || '班')}）`
  if (o.什么 === '挂水') return `在${o.在哪 || '医院'}挂水`
  if (o.什么 === '排队') return `在${o.在哪 || '医院'}排队等号`
  if (o.什么 === '洗澡') return `在${o.在哪 || '家'}洗澡`
  if (o.什么 === '吃饭') {
    const __啥 = String((o.详情 || {}).吃啥 || '饭')
    return `在${o.在哪 || '家'}${吃喝动词(__啥)}${__啥}`
  }
  return '在打盹'
}
