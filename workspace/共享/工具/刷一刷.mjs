#!/usr/bin/env node
/**
 * 刷一刷.mjs —— 「躺着划手机」：只抓标题和时长，不进模型。
 *
 * 为什么要和「看B站 / 逛贴吧」分开：
 *   看 = 点开一条，下载、听声音、看画面、写手账。贵，一天只能几次。
 *   刷 = 拇指往下划，看标题和时长，划过就过。便宜，一天几十次都行。
 * 混成一个动作的结果就是现在这样 —— 一天只有一票「看B站」，抽十几次签抽不到，
 * 她 11-13 说「这两天轮到的全是打瞌睡、喝水、洗澡，困得没劲儿看片」。
 *
 * 主人原话（2026-11-14）：「完全可以把她看b站和贴吧设置频繁点，我每天都要刷一百多条视频呢，闲着的时候」
 *
 * 成本：纯 HTTP，0 token。B 站走公开热门接口；贴吧走 dsh-tieba-dive 的 listBar（它自己带 cookie + 限速）。
 *
 * 批次 694：贴吧原来只存标题，她 11-17 21:04 就照标题编了「底下还有一堆人认真分析半天」。
 * 现在刷到贴吧时顺带 `readThread` 点开一条读正文（纯 HTTP，仍 0 token），读到的才进注入，
 * 读不到（被风控 / 删帖）就退回只有标题 —— 绝不硬编。
 *
 * 批次 695：`readThread` 返回的 `floors` 本来就含楼主和后面的回复（实测 21 层），
 * 所以「连楼层一起读」不额外发请求 —— 只是把以前扔掉的那几层捡回来。
 * 主人原话：「楼层回复和评论一起读」。
 *
 * 用法：
 *   node 刷一刷.mjs --tick      # 心跳：自己判该不该刷、刷哪个（睡着/洗澡/吃饭/没劲儿 都跳过）
 *   node 刷一刷.mjs --bili      # 强制刷一次 B 站（调试）
 *   node 刷一刷.mjs --tieba     # 强制刷一次贴吧（调试）
 *   node 刷一刷.mjs --dry       # 只判据 + 取数，不写任何文件
 *
 * 写什么：
 *   记忆/刷手机.json   最近一次刷到的（stateFastHintOf 每轮读它，让她说得出「刚刷到什么」）
 *   记忆/刷过.jsonl    滚动 2000 条，供「点进去看一条」时挑 —— 刷过没看的才是候选
 *   记忆/刷吧轮.json   贴吧吧轮到第几个（和学习轮的 贴吧轮.json 分开，别互相顶）
 *   自主.json          只在「发呆/摸鱼/待命」这种空档才改 state+note，其余一律不碰
 */
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { 改档, 读档 } from './_底层.mjs'
import { 睡着, 打盹中 } from './睡态.mjs'
import { 在吃饭, 在洗澡 } from './占用.mjs'
import { 改 as 改自主 } from './自主状态.mjs'

// SANDBOX 2026-11-14：依赖的 睡态/占用 都读 QQ_AUTONOMY_MEM，这里跟着认同一个变量 ——
// 否则测试只隔离了本脚本自己的文件，睡着/吃饭却还在读线上真实目录，判据会「假通过」。
const base = process.env.QQ_BROWSE_MEM || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const tools = process.env.QQ_BROWSE_TOOLS || process.env.QQ_AUTONOMY_TOOLS || '{{BOT_ROOT}}/共享/工具'
const args = process.argv.slice(2)
const DRY = args.includes('--dry')
const FORCE = args.includes('--bili') ? 'B站' : (args.includes('--tieba') ? '贴吧' : '')
const QUIET = args.includes('--quiet')   // 心跳用：没到点/被拦都不该每分钟往日志里塞一行
const VERBOSE = args.includes('--verbose')

let _PJ = {}
try { _PJ = JSON.parse(readFileSync(join(tools, '参数.json'), 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)

const 现在 = () => Date.now()
const 京 = (ms) => new Date(Number(ms) + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 今天 = () => new Date(现在() + 8 * 3600e3).toISOString().slice(0, 10)
// 判据类（没到点 / 为什么被拦）--quiet 下全静默：一天两百多次，塞进日志只会把真事埋掉。
const log = (...a) => { if (!QUIET) console.log(...a) }
// 结果类（真刷成了 / 抓取失败）**永远打** —— 日志里至少得能看出她今天刷没刷、有没有被 412 拦。
const 记 = (...a) => console.log(...a)

const 档P = join(base, '刷手机.json')
const 池P = join(base, '刷过.jsonl')
const 吧轮P = join(base, '刷吧轮.json')
const 失败P = join(base, '刷失败.jsonl')
const 学习锁 = join(base, '.自主学习.lock')

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'

/** 洗牌后取前 n 条。 */
function 抽(arr, n) {
  const a = arr.slice()
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a.slice(0, Math.max(0, n))
}

/** 已经刷到过的 id —— 用来躲开「又是这几条」。 */
function 刷过的() {
  const 集 = new Set()
  try {
    const 行 = readFileSync(池P, 'utf8').trim().split('\n').slice(-900)
    for (const l of 行) {
      try { const o = JSON.parse(l); if (o && o.id) 集.add(String(o.id)) } catch { /* 坏行跳过 */ }
    }
  } catch { /* 第一次跑没有池子 */ }
  return 集
}

async function 取B站(要几条) {
  const pn = 1 + Math.floor(Math.random() * 5)
  const r = await fetch(`https://api.bilibili.com/x/web-interface/popular?pn=${pn}&ps=20`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com/', Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
  })
  if (!r.ok) throw new Error(`热门接口 HTTP ${r.status}`)
  const j = await r.json()
  if (j.code !== 0) throw new Error(`热门接口 code ${j.code} ${j.message || ''}`)
  const 见过 = 刷过的()
  const 池 = (j.data?.list || []).filter((x) => x && x.bvid && x.title
    && Number(x.duration) >= 15 && Number(x.duration) <= 7200
    && !/广告|推广位/.test(String(x.title))
    && !见过.has(String(x.bvid)))
  if (池.length < 3) throw new Error('这一页全是刷过的，换一页再说')
  return 抽(池, 要几条).map((x) => ({
    平台: 'B站', id: String(x.bvid), 标题: String(x.title).replace(/\s+/g, ' ').trim(),
    时长: Number(x.duration) || 0, 作者: String(x.owner?.name || ''),
  }))
}

async function 取贴吧(要几条) {
  const mod = await import('{{DSH_ROOT}}/profiles/web/node_modules/dsh-tieba-dive/lib/tieba.js')
  mod.setGap(Number(H('刷_贴吧间隔毫秒', 1600)) || 1600)
  let bars = ['deepseek', '孙笑川', '弱智']
  try {
    const cfg = JSON.parse(readFileSync('{{DSH_ROOT}}/tieba-duty/config.json', 'utf8'))
    if (Array.isArray(cfg.bars) && cfg.bars.length) bars = cfg.bars.map(String)
  } catch { /* 读不到就用默认三个，跟线上一致 */ }
  const 轮 = 读档(吧轮P, { i: 0 }) || { i: 0 }
  const i = Number(轮.i) || 0
  const kw = bars[((i % bars.length) + bars.length) % bars.length]
  // 先写回再抓：万一这轮挂了，下次从下一个吧开始，不会卡死在同一个上
  if (!DRY) {
    try {
      const t = 吧轮P + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
      writeFileSync(t, JSON.stringify({ i: i + 1, at: 京(现在()) }) + '\n')
      renameSync(t, 吧轮P)
    } catch { /* 记不上不影响这一轮 */ }
  }
  const r = await mod.listBar(kw, { pn: 0 })
  const 见过 = 刷过的()
  const 池 = (r.threads || []).filter((t) => t && t.id && t.title
    && !/^置顶/.test(String(t.title))
    && !见过.has(String(t.id)))
  if (!池.length) throw new Error(`${kw}吧这一页都是看过的`)
  const 抽到 = 抽(池, 要几条).map((t) => ({
    // 手机版列表的 <a> 文本把回复数也包进去了（「斩杀DS？Gemini4 Hy这么强吗？ 156」），
    // 那个 156 不是标题 —— 不剥掉她会当成内容讲出来。只剥末尾的纯数字。
    平台: '贴吧', id: String(t.id), 标题: String(t.title).replace(/\s+/g, ' ').replace(/\s+\d{1,6}$/, '').trim(),
    时长: 0, 作者: kw + '吧',
  }))
  // 顺带点开读正文：只给标题，她就会照标题往下编（11-17 21:04 就是这么编的）。
  // 读一条正文不贵（纯 HTTP、走同一个限速 gap），读到的才带进注入；读不到就退回只有标题，
  // 绝不把「读到的」和「没读到的」混成一谈 —— 那是 692 要治的幻觉来源。
  if (Number(H('刷_贴吧读正文', 1)) !== 0 && 抽到.length > 0) {
    // 默认读 3 条：这是后台心跳（约 22 分钟一次），多读两条只多约 3 秒，不占对话延迟；
    // 只读 1 条的话，注入里八条帖子有七条还是「没点开」，她照样只能讲标题。
    const 读几条 = Math.max(0, Math.min(5, Number(H('刷_贴吧读正文条', 3)) || 3))
    for (const 条 of 抽到.slice(0, 读几条)) {
      try {
        const 帖 = await mod.readThread(条.id)
        const 拆 = 挑正文(帖?.floors)
        if (拆.正文) {
          条.正文 = 拆.正文.slice(0, Number(H('刷_贴吧正文字数', 160)) || 160)
          // 楼层回复跟着楼主一起带上：只给楼主，她就会替「底下的人」编分析（11-17 21:04 那次）。
          if (拆.回复.length) 条.回复 = 拆.回复
        }
      } catch (e) {
        // 读不到正文不算刷失败 —— 她这一轮照样知道划到了什么，只是没点开
        记(`${kw}吧那条没读到正文：${String(e && e.message || e).slice(0, 80)}`)
      }
    }
  }
  return 抽到
}

// 手机版页面不是每篇都给了正文：有的首楼就是「立即下载客户端」，有的整页只剩这句。
// 直接拿第一层当正文，等于把广告占位当成她读过的东西 —— 那是新的一种编造。
// 这里跳过占位层，取第一段像人话的当楼主；**后面的层就是楼层回复**，一起带出去。
// 一层正文都没有就返回空（宁可只说标题）。
const 占位层 = /^(立即下载客户端|打开APP|打开客户端|下载客户端|请下载|点击下载|继续浏览|登录后查看|该内容已被删除|此贴已被删除)$/
function 挑正文(floors) {
  const 最短 = Number(H('刷_贴吧正文最短', 12)) || 0
  const 层们 = []
  const 见过 = new Set()
  for (const 层 of (Array.isArray(floors) ? floors : [])) {
    const t = String(层 || '').replace(/\s+/g, ' ').trim()
    if (t === '' || 占位层.test(t)) continue
    // 手机版会把同一层拆进多个 content div（图注、补充说明），去重免得同一句说两遍
    if (见过.has(t)) continue
    见过.add(t)
    层们.push(t)
  }
  // 太短的（「如题」「RT」「顶」）当不了楼主，往后找一层
  const 主 = 层们.findIndex((t) => t.length >= 最短)
  if (主 < 0) return { 正文: '', 回复: [] }
  const 回复条 = Math.max(0, Math.min(5, Number(H('刷_贴吧回复条', 3)) || 0))
  const 回复字数 = Number(H('刷_贴吧回复字数', 60)) || 60
  const 回复 = 层们.slice(主 + 1, 主 + 1 + 回复条)
    .filter((t) => t.length >= Math.min(4, 最短))
    .map((t) => t.slice(0, 回复字数))
  return { 正文: 层们[主], 回复 }
}

/** 判据：她这会儿能不能刷手机。返回 '' = 可以，否则是「为什么不能」。
 *  注意「还没到点」不在这里判 —— 那是另一回事（静默退出，不写日志），在 main 开头。 */
function 拦着() {
  const 刷 = 读档(档P, {}) || {}
  if (睡着(base)) return '睡着'
  // 眯一会儿的时候不会刷手机 —— 她自己 11-13 说的就是「困得没劲儿看片」。
  // 打盹不算睡（睡态.睡着 是 false），所以得单独拦一道，不然她会在「打瞌睡」里刷视频。
  if (打盹中(base)) return '在打瞌睡'
  if (在洗澡(base)) return '在洗澡'
  if (在吃饭(base)) return '在吃饭'
  const 状 = 读档(join(base, '状态.json'), {}) || {}
  const 精 = Number(状.energy)
  if (Number.isFinite(精) && 精 < Number(H('刷_精力下限', 18))) return `精力只剩${Math.round(精)}，没劲儿刷`
  // 今天刷太多次了？防止某种死循环把她的状态钉在「看B站」上
  const 今 = 今天()
  const 次 = 刷.今天 === 今 ? (Number(刷.次数) || 0) : 0
  if (次 >= Number(H('刷_每天上限', 30))) return `今天已经刷了${次}次`
  return ''
}

async function main() {
  const 刷 = 读档(档P, {}) || {}
  // 到点没到 —— 静默退出，不写日志（心跳每 5 分钟一次，别刷屏）
  // 「还没到点」一天会命中两百多次 —— 只有手动带 --verbose 才打，心跳日志里不留痕。
  if (!FORCE && Number(刷.nextAt) > 现在()) {
    if (VERBOSE) console.log(`还没到点（下次 ${京(刷.nextAt).slice(11, 16)}）`)
    return
  }
  const 为什么 = 拦着()
  if (为什么) { log('这轮不刷：' + 为什么); return }

  const 平台 = FORCE || (Math.random() < Number(H('刷_B站占比', 0.75)) ? 'B站' : '贴吧')
  const 基础 = Number(H('刷_每次条', 7)) || 7
  const 要几条 = Math.max(3, Math.min(12, 基础 + Math.floor(Math.random() * 4) - 1))

  let 条们 = []
  try {
    条们 = 平台 === 'B站' ? await 取B站(要几条) : await 取贴吧(要几条)
  } catch (e) {
    // 抓不到不能算「刷过了」—— 否则 nextAt 被推后，她白白空等一轮
    const reason = String(e && e.message || e).slice(0, 240)
    try {
      if (!DRY) appendFileSync(失败P, JSON.stringify({ at: 京(现在()), 平台, reason }) + '\n')
    } catch { /* 失败日志写不上不阻断原错误 */ }
    记(`刷${平台}没刷成：${reason}`)
    return
  }
  if (!条们.length) { 记(`刷${平台}没刷到新东西`); return }

  if (DRY) {
    console.log(`[dry] 会刷${平台} ${条们.length} 条：`)
    for (const t of 条们) console.log('  · ' + t.标题)
    return
  }

  const now = 现在()
  const 今 = 今天()
  const 间隔 = Number(H('刷_间隔分钟', 22)) || 22
  const 浮动 = Number(H('刷_浮动分钟', 8)) || 0
  const 下次 = now + Math.round((间隔 + (Math.random() * 2 - 1) * 浮动) * 60000)

  // 1) 刷手机.json：这次刷到的 + 今天累计
  改档(档P, (旧) => {
    const o = (旧 && typeof 旧 === 'object') ? 旧 : {}
    const 同日 = o.今天 === 今
    o.at = now
    o.北京 = 京(now)
    o.平台 = 平台
    o.今天 = 今
    o.次数 = (同日 ? (Number(o.次数) || 0) : 0) + 1
    o.今日条数 = (同日 ? (Number(o.今日条数) || 0) : 0) + 条们.length
    o.nextAt = 下次
    // 正文一起落下：stateFastHintOf / 刚划到段 每轮读它，读到的才有资格讲内容（批次694）
    o.最近 = 条们.map((t) => ({
      标题: t.标题, id: t.id, 作者: t.作者, 时长: t.时长,
      正文: t.正文 || '', 回复: Array.isArray(t.回复) ? t.回复 : [],
    }))
    return o
  }, {})

  // 2) 刷过.jsonl：滚动 2000 行
  try {
    let 旧行 = []
    try { 旧行 = readFileSync(池P, 'utf8').split('\n').filter(Boolean) } catch { /* 首次 */ }
    const 新行 = 条们.map((t) => JSON.stringify({
      at: 京(now), 平台: t.平台, id: t.id, 标题: t.标题, 作者: t.作者, 时长: t.时长,
      正文: t.正文 || '', 回复: Array.isArray(t.回复) ? t.回复 : [], 看过: false,
    }))
    const 全 = [...旧行, ...新行].slice(-2000)
    const t = 池P + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
    writeFileSync(t, 全.join('\n') + '\n')
    renameSync(t, 池P)
  } catch (e) { console.log('刷过池没写上：' + String(e && e.message || e).slice(0, 80)) }

  // 3) 只有当她在空档里，才把 state 改成「在刷」。
  //    正在学（学习锁在）或已经在看B站/逛贴吧时不碰 —— 那条 note 是学习轮写的「看了《xx》：…」，
  //    覆盖掉等于把她刚读完的东西从记忆里擦掉。
  const 空档 = ['发呆', '摸鱼', '待命', '翻旧账', '学点东西', '']
  const 现态 = String((读档(join(base, '自主.json'), {}) || {}).state || '')
  const 目标态 = 平台 === 'B站' ? '看B站' : '逛贴吧'
  if (existsSync(学习锁)) log('学习轮在跑，不动状态')
  else if (空档.includes(现态)) {
    const 提要 = 条们.slice(0, 3).map((t) => t.标题.slice(0, 14)).join('／')
    改自主(base, (aut) => {
      aut.state = 目标态
      aut.since = now
      aut.note = `刷${平台}：${提要}${条们.length > 3 ? '…' : ''} 共${条们.length}条`
      return true
    })
  }

  记(`${京(now).slice(11, 16)} 刷${平台} ${条们.length} 条：${条们.slice(0, 3).map((t) => t.标题.slice(0, 16)).join(' / ')}`)
}

await main()
