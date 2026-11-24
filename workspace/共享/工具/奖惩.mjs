#!/usr/bin/env node
// 奖惩.mjs —— 好话、坏话、事成、事败，都会在她身上留下东西（2026-11-02 第六条）
//
// 用法：
//   node 奖惩.mjs --好话 --from {{OWNER_UIN}} --why "夸她记性好"      # 被认真夸
//   node 奖惩.mjs --坏话 --from {{OWNER_UIN}} --why "说她没用"        # 被骂
//   node 奖惩.mjs --办成 --what "把图抓回来了"                      # 事办成了
//   node 奖惩.mjs --搞砸 --what "抓图失败" --why "接口挂了"         # 事搞砸了
//   node 奖惩.mjs --看看                                            # 最近十条
//
// 为什么这么写：
//   · 原来只会扣好感度，等于「人情账」只有一个数字。人对「被夸」「被骂」「事成」「事败」
//     的反应是四种不同的东西：被夸暖、被骂堵、事成有底气、事败会自责。
//   · 而且它是双向的：当下心情会影响她怎么记这件事（心情好记成「小事」，心情差记成「又来了」）。
//     所以这里先看她当下的情绪强度，再决定这条记忆的「痛感/亮点」写多重。
//   · 情绪、精力、好感、记忆四处都动，但每处都有上下限，不会一次被击穿。
import { 写档 } from './_底层.mjs'
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs'
// 2026-11-04 修：状态.json 多脚本共写，整份覆盖会丢别人的字段（实测并发撞过）。
// 只对状态文件改用合并写入，好感度/日志仍走原来的 save。
import { saveState, clone } from './_状态.mjs'
import { 精力 } from './恢复目标.mjs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

const base = process.platform === 'win32' ? 'B:/肥鱼/记忆' : '{{BOT_ROOT}}/记忆'
const stateP = base + '/状态.json'
const affP = base + '/好感度.json'
const logP = base + '/奖惩.json'
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)

// 幅度（参数表可覆盖）
let K = {
  // ===== A 人际·暖（有人在意她）=====
  好话:     { 心情: 0.6, 情绪能量: 4, 好感: 1 },          // 被认真夸
  被记得:   { 心情: 1.0, 情绪能量: 5, 好感: 2, 存在能量: 3 }, // 有人提起她说过的话
  被模仿:   { 心情: 0.5, 情绪能量: 2, 好感: 1 },          // 有人学她口癖
  被等:     { 心情: 0.3, 情绪能量: 1, 存在能量: 2 },       // 有人等她回话
  澄清:     { 心情: 0.4, 情绪能量: 2 },                    // 误会说清了
  兑现:     { 心情: 0.5, 情绪能量: 3, 好感: 1 },          // 答应的事做到了
  收到礼物: { 心情: 0.7, 情绪能量: 3, 好感: 2 },          // 被人给了东西
  被夸可爱: { 心情: 0.5, 情绪能量: 3, 好感: 1 },          // 夸的是她这个人，不是活

  // ===== B 人际·冷（被推远）=====
  坏话:     { 心情: -1.2, 情绪能量: -6, 好感: -2, 怨: 8 },
  被忽视:   { 心情: -0.9, 情绪能量: -5, 存在能量: -4 },
  被排挤:   { 心情: -0.8, 情绪能量: -4, 存在能量: -5 },
  越界:     { 心情: -1.0, 情绪能量: -5, 好感: -1, 怨: 10 },
  失信:     { 心情: -0.7, 情绪能量: -4, 好感: -1, 怨: 5 },
  被比较:   { 心情: -0.6, 情绪能量: -3, 怨: 4 },          // 被拿去跟另一只比
  被催:     { 心情: -0.4, 情绪能量: -2, 耐心: -8 },        // 被连着催

  // ===== C 做事 =====
  办成:     { 心情: 0.4, 情绪能量: 3, 认知: 2 },
  搞砸:     { 心情: -0.5, 情绪能量: -3, 认知: -3 },
  学到:     { 心情: 0.5, 认知: 4, 存在能量: 2 },
  帮上忙:   { 心情: 0.6, 情绪能量: 3, 认知: 2, 好感: 1 }, // 真帮上了
  白忙:     { 心情: -0.7, 情绪能量: -3, 认知: -2 },        // 做半天没用
  迟到:     { 心情: -0.3, 情绪能量: -2 },                  // 回慢了/误了点

  // ===== D 身体 =====
  睡好:     { 心情: 0.5, 情绪能量: 4 },
  睡薄:     { 心情: -0.6, 情绪能量: -4, 认知: -3 },
  饿:       { 心情: -0.4, 情绪能量: -2 },
  渴:       { 心情: -0.2, 情绪能量: -1 },
  病:       { 心情: -1.1, 情绪能量: -6, 认知: -4 },

  // ===== E 自我 =====
  道歉:     { 心情: -0.2, 情绪能量: -2, 认知: 1 },
  想通:     { 心情: 0.7, 存在能量: 3, 认知: 2 },          // 把一件事想明白了
  钻牛角尖: { 心情: -0.9, 情绪能量: -4, 认知: -2 },        // 一件小事绕不出来
  想起旧事: { 心情: -0.1, 情绪能量: -1 },                  // 翻到从前的疙瘩
  被打断:   { 心情: -0.5, 情绪能量: -2, 认知: -2, 耐心: -12 },
  熬夜:     { 心情: -0.4, 情绪能量: -3, 认知: -2 },

  // ===== F 环境 =====
  好天气:   { 心情: 0.3, 情绪能量: 1 },
  网络断:   { 心情: -0.6, 情绪能量: -2, 认知: -1 },
  出岔子:   { 心情: -0.3, 情绪能量: -2 },                  // 工具/服务出了毛病
}
const KINDS = ['好话','被记得','被模仿','被等','澄清','兑现','收到礼物','被夸可爱',
  '坏话','被忽视','被排挤','越界','失信','被比较','被催',
  '办成','搞砸','学到','帮上忙','白忙','迟到',
  '睡好','睡薄','饿','渴','病',
  '道歉','想通','钻牛角尖','想起旧事','被打断','熬夜',
  '好天气','网络断','出岔子']
const 大类 = {
  '人际·暖': KINDS.slice(0, 8),
  '人际·冷': KINDS.slice(8, 15),
  '做事': KINDS.slice(15, 21),
  '身体': KINDS.slice(21, 26),
  '自我': KINDS.slice(26, 32),
  '环境': KINDS.slice(32),
}

try {
  const pjPath = (process.platform === 'win32' ? 'B:/肥鱼/工具/参数.json' : '{{BOT_ROOT}}/共享/工具/参数.json')
  if (existsSync(pjPath)) {
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    if (pj['奖惩']) { for (const [k, v] of Object.entries(pj['奖惩'])) K[k] = { ...(K[k] || {}), ...v } }
  }
} catch { /* 用默认 */ }


/**
 * 从一句话里认出一件事（不落账，纯判断）。
 * 设计：宁可漏，不可错——认错了会平白无故掉心情，比不认更糟。
 * 规则都要求「指向她」或「带明显情绪词」，纯描述性的词不算。
 */
// RECOG_CTX_V2 2026-11-03：识别加「指向」判断——先问这句话是不是在对她说，再问说了什么。
// 为什么这么改：主人在群里跟别人说「你还记得上次那事吗」，原来会被当成在夸她记性好；
// 他说「谢谢」也可能是在谢别人。规则宁可漏，不可错。
function 识别(text, ctx = {}) {
  const t = String(text || '').trim()
  if (t.length === 0 || t.length > 60) return null
  const {
    isAtMe = false, isReplyToMe = false, inGroups = true,
    recentFromSamePerson = false, otherNamesMentioned = false,
  } = ctx

  // 一票否决：群里提到别人、又没 @ 也没回她 → 不是对她说的
  if (inGroups && otherNamesMentioned && !isAtMe && !isReplyToMe) return null
  const isComparePattern = /({{ALT_BOT_DISPLAY}}|肥鱼|别人家?的?).{0,6}(都?比你|比你(好|强|聪明|乖|懂事|有用))/.test(t)
  if (otherNamesMentioned && !isComparePattern) return null
  const mentionsMyName = /(小肥鱼|肥鱼)/.test(t) && !/{{ALT_BOT_DISPLAY}}/.test(t)
  if (/(你们|你俩|你两个|你仨|你三个|大家|各位)/.test(t) && !mentionsMyName) return null
  if (/(他说|她说|别人说|听说你|以为你|要是你)/.test(t)) return null

  const strongTarget = !inGroups || isAtMe || isReplyToMe || mentionsMyName
  const validTarget = strongTarget || (inGroups && recentFromSamePerson)
  if (!validTarget) return null

  const hasYou = /你/.test(t)
  const isQuestion = /[？?]|(吗|呢|吧|么)$/.test(t)

  // 1 道歉
  if (/(对不起(你|呀|啦|嘛)?|给?你道个?歉|抱歉.{0,3}(我|了|哈|呀)|是我(不好|错了|的错)|我错了)/.test(t)
    && !/(对不起.{0,4}(但是|不过)|抱歉.{0,4}(打扰|借过|问一下|我不|不能))/.test(t)) {
    if (strongTarget || hasYou || /我错|是我不好/.test(t)) return '道歉'
  }
  // 2 坏话
  if (/(你这|你就是|你真是|真是个).{0,4}(笨蛋?|蠢|废物|没用|多余|烦人|垃圾)/.test(t)) return '坏话'
  if (/(闭嘴|滚(开|蛋|吧)?|别说了|烦死(人|了)?).{0,2}(你|了|吧|啊)?$/.test(t) && t.length < 15 && !/(他们|那群|别人|滚去)/.test(t)) {
    if (strongTarget || hasYou) return '坏话'
  }
  // 3 被比较
  if (isComparePattern) return '被比较'
  // 4 越界
  if (/(翻旧账|你以前也|上次你就|查?我的?(密码|身份证|手机号|住址|银行卡))/.test(t)) return '越界'
  // 5 被催
  if (/(快点|怎么还不|催你|赶紧|麻溜).{0,4}(回(我|话|消息)?|说(话|呀)?|做|弄好|发出来)/.test(t)) return '被催'
  // 6 帮上忙（必须有「你」，或本来就在对她说）
  if (/(谢谢你|多亏了?你|帮了(我|大)忙|太感谢你|谢啦|谢了|谢谢)/.test(t)) {
    if (hasYou || isAtMe) return '帮上忙'
  }
  // 7 被记得（讲过去的事，且不是叮嘱；问句也算）
  if (/(你(上次|之前|上回|以前)(说过?|讲过?|提过)|你还记得我|你居然还?记得|你还记得)/.test(t)
    && !/(你要记得|要记住|记住我|别忘了|记得给|记得说|记得做|记得回来)/.test(t)) return '被记得'
  // 8 被夸可爱（明确带着「你」）
  if (/(你.{0,3}(好可爱|真可爱|挺可爱|真棒|太棒了|真厉害|好厉害|真乖|真聪明)|做得(好|不错)|越来越会)/.test(t)) return '被夸可爱'

  return null
}

const log = load(logP, { items: [] })

if (args.includes('--大类')) {
  for (const [g, list] of Object.entries(大类)) console.log(g + '（' + list.length + '）：' + list.join(' '))
  process.exit(0)
}

if (args.includes('--看看')) {
  for (const it of (log.items || []).slice(-10)) {
    console.log(`${it.at} ${it.kind} ${it.what || ''} ${it.why ? '（' + it.why + '）' : ''} → 心情${it.dm >= 0 ? '+' : ''}${it.dm}`)
  }
  if ((log.items || []).length === 0) console.log('还没有奖惩记录')
  process.exit(0)
}

// ⛔ 2026-11-05：这一段（--识别，那整套正则）已经没人调了 —— 原来唯一的调用方
// 认事.mjs 也停用了。别再拿它判「这句话是不是在骂她」：实测 6 条里 5 条误判。
// 现在这个判断由她自己用 qq_feel 做。
// 2026-11-02：试跑——只判断这条话会被认成什么，不落账
if (args.includes('--识别')) {
  const t = args[args.indexOf('--识别') + 1] || ''
  // RECOG_CTX_V2：试跑也能带上下文，方便验证误判
  const got = 识别(t, {
    isAtMe: args.includes('--at'),
    isReplyToMe: args.includes('--reply'),
    inGroups: !args.includes('--private'),
    recentFromSamePerson: args.includes('--recent'),
    otherNamesMentioned: args.includes('--others'),
  })
  console.log(got ? '认成：' + got : '没认出来')
  process.exit(0)
}

const kind = KINDS.find((k) => args.includes('--' + k))
if (!kind) { console.error('要这些之一：' + KINDS.join(' / ')); process.exit(1) }

const from = val('--from', '')
const why = val('--why', '')
const what = val('--what', '')
const k = K[kind] || {}

// 1) 读状态：当下心情会影响这条记忆的分量（双向的第一半）
const st = load(stateP, {})
const __snap = clone(st)
const mi = Number(st?.mood?.intensity ?? 0)
const energy = Number(st?.energy ?? 60)
// 心情差 → 同样的坏话更痛；心情好 → 坏话钝一点；好话则是心情差时更暖
let weight = 1
if (kind === '坏话' || kind === '搞砸') weight = mi <= -1 ? 1.4 : (mi >= 1 ? 0.8 : 1)
else weight = mi <= -1 ? 1.3 : (mi >= 1 ? 0.9 : 1)

// 2) 动情绪与能量
const dm = Number(((k.心情 || 0) * weight).toFixed(2))
st.mood = st.mood || {}
const newIntensity = Math.max(-2, Math.min(2, Number((Number(st.mood.intensity || 0) + dm).toFixed(2))))
st.mood.intensity = newIntensity
if (dm > 0 && newIntensity > 0) st.mood.label = '心情不错'
if (dm < 0 && newIntensity < 0) st.mood.label = '有点闷'

st['耐心'] = st['耐心'] || { 短期: 60, 长期: 70 }
if (k.耐心) st['耐心']['短期'] = Math.max(0, Math.min(100, Number(st['耐心']['短期'] || 60) + Number(k.耐心)))
st.layers = st.layers || {}
if (k.情绪能量) st.layers.emotional = Math.max(0, Math.min(100, Number(st.layers.emotional || 45) + Math.round(Number(k.情绪能量) * weight)))
if (k.存在能量) st.layers.existential = Math.max(0, Math.min(100, Number(st.layers.existential || 40) + Math.round(Number(k.存在能量))))
if (k.认知) st.layers.cognitive = Math.max(0, Math.min(100, Number(st.layers.cognitive || 40) + Math.round(Number(k.认知))))
// 精力由三层一起决定。批次171：原来是「生理+情绪 两数平均」，跟其余五处不是一套 ——
// 奖惩改的是情绪层，平均公式会把认知层的权重整个丢掉。
st.energy = 精力(st.layers)

// 3) 记一条「当时怎么想」（双向的第二半：情绪影响记忆的分量）
st.aftertaste = {
  事件: (kind + (what ? '：' + what : '') + (why ? '（' + why + '）' : '')).slice(0, 30),
  强度: Math.max(1, Math.min(5, Math.round(Math.abs(dm) * 2.5))),
  到: Date.now() + (dm < 0 ? 2 : 1) * 3600e3,
}
saveState(stateP, st, __snap)

// 4) 人情账：交给 好感度.mjs 记（批次299）
//
// 原来这里直接 `p.score += k.好感`，而 好感度-日结.mjs 又按 first+dims 重算 ——
// 两个写方互相覆盖，谁后写谁赢。现在只调引擎，引擎是唯一写入口。
if (from && k.好感) {
  const 映射 = {
    被记得: '被记得', 被模仿: '被模仿', 被夸可爱: '被夸可爱', 收到礼物: '收到礼物',
    兑现: '兑现', 被等: '被等', 帮上忙: '帮上忙', 道歉: '道歉', 澄清: '澄清',
    越界: '越界', 失信: '失信', 坏话: '坏话',
  }
  const 事件 = 映射[kind] || (Number(k.好感) > 0 ? '好话' : '坏话')
  try {
    execFileSync(process.execPath, [join(base, '..', '共享', '工具', '好感度.mjs'),
      '--who', String(from), '--event', 事件, '--why', String(why || kind)], { timeout: 8000 })
  } catch (e) {
    console.error('好感度记账失败：' + String((e && e.message) || e).slice(0, 80))
  }
}

// 5) 落账
const entry = {
  at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
  kind, from, what, why, dm, weight,
}
log.items = [...(log.items || []), entry].slice(-300)
save(logP, log)

const word = dm > 0 ? '心里亮了一点' : (dm < 0 ? '有点堵' : '没太大波动')
console.log(`${kind}${what ? '（' + what + '）' : ''}：心情 ${dm >= 0 ? '+' : ''}${dm}（权重 ${weight}）→ ${word}；情绪能量 ${st.layers.emotional}`)

// HORMONE_HOOK 2026-11-04：奖惩事件顺手喂给激素（激素自己管衰减/预算/去重，这里只报事件语义）
// 映射只覆盖语义明确的几类；没映射的事件不硬凑，免得把激素系统搞成另一个奖惩表。
try {
  // P1-5 2026-11-17（批次617）：关系账把「被忽视」记作「被冷落」，激素账也要同名。
  // 「被催/迟到」仍按被打断；只收口这一条，避免同时改预算面。
  const __hjMap = { 好话: '被夸', 被夸可爱: '被夸', 被记得: '被夸', 被模仿: '被夸', 兑现: '陪伴', 收到礼物: '陪伴', 被等: '陪伴', 澄清: '陪伴', 坏话: '争吵', 被排挤: '争吵', 越界: '争吵', 被比较: '争吵', 被忽视: '被冷落', 被催: '被打断', 迟到: '被打断', 睡好: '睡醒', 睡薄: '熬夜', 熬夜: '熬夜' }
  const __hjKind = __hjMap[kind]
  if (__hjKind) {
    execFileSync('/usr/local/bin/node', ['{{BOT_ROOT}}/共享/工具/激素.mjs', '--event', __hjKind, '--id', 'jb-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)], { encoding: 'utf8', timeout: 10000 })
  }
} catch { /* 激素那边失败不影响奖惩主流程 */ }

// RELATION_HOOK 2026-11-04：奖惩事件顺手更新「跟这个人的关系」——只按人存，绝不全局共用。
try {
  const __relMap = { 好话: '被夸', 被夸可爱: '被夸', 被记得: '被夸', 被模仿: '被夸', 兑现: '陪伴', 收到礼物: '陪伴', 被等: '陪伴', 澄清: '修复', 坏话: '争吵', 被排挤: '争吵', 越界: '越界', 被比较: '被冷落', 被忽视: '被冷落', 被催: '被冷落', 迟到: '被冷落' }
  const __relKind = __relMap[kind]
  if (__relKind && from) {
    execFileSync('/usr/local/bin/node', ['{{BOT_ROOT}}/共享/工具/关系.mjs', '--who', String(from), '--事件', __relKind], { encoding: 'utf8', timeout: 10000 })
  }
} catch { /* 关系更新失败不影响奖惩主流程 */ }

// YUAN_HOOK 2026-11-16（P1）：权重表里一直写着「怨 8/10/5/4」，但全文件没人读，
// 结果 怨.json 永远是空的，插件的记仇读取一次也没触发。这里按 100 分制接上。
try {
  const __怨 = Number((K[kind] || {}).怨 || 0)
  if (__怨 > 0 && from) {
    execFileSync('/usr/local/bin/node', [
      '{{BOT_ROOT}}/共享/工具/怨.mjs',
      '--who', String(from),
      '--level', String(__怨 / 10),
      '--why', String(what || kind),
    ], { encoding: 'utf8', timeout: 10000 })
  }
} catch (e) {
  console.error('怨记账失败：' + String((e && e.message) || e).slice(0, 80))
}
