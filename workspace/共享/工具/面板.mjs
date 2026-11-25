#!/usr/bin/env node
import { sendPngFile, isFreshFile } from './出口/面板响应/index.mjs'
// 面板.mjs v7 —— 注册登录 + 访客只看人话 + 主人可预览客人视角（2026-11-02）
//
// 为什么这么写：
//   · 主人前两条要求：①别人登录看不见具体数值，只给文字描述（数值→人话）；②主人能一键切到客人视角，看看外面长什么样；③登录改成 QQ 号注册 + 密码，先不做验证系统。
//   · 密码只存加盐 sha256，不存明文；owner 也是注册出来的，谁先注册 {{OWNER_UIN}} 这个号谁就是主人（内网、人少，先这样）。
//   · 权限仍在服务端：访客接口只回「描述字段」，原始数值根本不下发，不是前端藏起来。
import { 写档, 改档 } from './_底层.mjs'
import { loadState as 读状态, saveState as 存状态 } from './_状态.mjs'
import { 睡着 } from './睡态.mjs'
// OCCUPY 2026-11-07（批次167）：在岗判据只在 占用.mjs 一份
import { 在岗的班, 占着, 占用话, 在吃饭, 在洗澡, 在看病, 在打盹 } from './占用.mjs'
import * as 账本 from './账本.mjs'
// THINK_PAGE 2026-11-14（批次387）：实时看她思考。数据由中转的 思考流.mjs 旁路写入。
import { 读思考, 记思考 } from './思考流.mjs'
// TODO_UI 2026-11-08（批次229）：待办读写只在 待办.mjs 一处；面板只做权限与转发。
import * as 待办 from './待办.mjs'
import { createServer } from 'node:http'
import { dirname } from 'node:path'
import { gzipSync } from 'node:zlib'
// DEBUG_NET 2026-11-08（批次230）：调试页要看两条出口通不通，只做 400ms 连接测试，不发数据。
import { connect } from 'node:net'
// 2026-11-02 参数化：拟人阈值统一从 参数.json 的「拟人」段读，读不到用默认值
import { readFileSync as _rf } from 'node:fs'
import { readdirSync as _rd, statSync as _st } from 'node:fs'   // SELFIE_ROUTE：列目录/看时间，别在 ESM 里用 require
import { mkdirSync as _mkd, renameSync as _rn, rmSync as _rm } from 'node:fs'   // WALL_TRASH 2026-11-06（批次135）：回收站
// PLACE_FN 2026-11-05（批次79）：营业时间只在 地点.mjs 里维护一份，
// 面板别再自己算一遍 —— 两套判断迟早会不一致，而且是静默的。
import { 营业中 as 营业中79, 读档 as 读地点79, 读图 } from './地点.mjs'
// DIARY 2026-11-05：日记怎么解析、客人能看多少，全在 日记.mjs 里。
// 面板只负责「发出去」—— 权限判断只能有一处，散在渲染里迟早漏。
import { 有哪些 as 日记列表, 读一篇 as 日记读, 给角色 as 日记给, 当天天气 as 日记天 } from './日记.mjs'
// HUNGER 2026-11-06（批次139）：肚子。规则只有 饥饿.mjs 一份，面板不自己算。
import { 读 as 读饥饿, 标签 as 饥饿标签, 刷新饱腹 as 刷新饥饿饱腹 } from './饥饿.mjs'
import * as 疾病 from './疾病.mjs'
// REL_DEBUG 2026-11-17（批次604）：好感 score / 别扭 level 的换算只在 关系调试.mjs 一份。
import { 写主人分数, 别扭调试档 } from './关系调试.mjs'
// BOARD 2026-11-08（批次228）：留言板。存取与重叠判据只在 留言板.mjs 一份。
import * as 留言板 from './留言板.mjs'
// 人物页 2026-11-07：身上穿了什么、体温多少，也一起下发（照僵尸毁灭工程那个人形界面）
import * as 穿衣 from './穿衣.mjs'
import * as 体温 from './体温.mjs'
// PHOTO_ID 2026-11-07（批次161）：成品目录里的 png 不全是照片 ——
// 验证截图曾经存进去，照片墙就多了一张 02:20 的面板截图。判据只在 成品图.mjs 一份。
import { 是成品图 } from './成品图.mjs'
// ARRIVE 2026-11-05（批次85）：她「到当前这个地方」是什么时候。
// 优先 走路.mjs 到达时写的 到此At（批次85 起才有）。
// 老数据没这个字段，就从账目记录里倒着找最后一条「从X走到<现在这里>」——
// 那是 走路.mjs 到达时写的，at 就是到达时刻（记录里是北京时间，转毫秒要减 8 小时）。
// 都找不到（比如她一直在家没动过）返回 0，面板就不显示时长，别拿「昨天几点」冒充。
const 到达时刻 = (a) => {
  const 位 = String((a || {}).位置 || '家')
  const 有 = Number((a || {}).到此At || 0)
  if (有 > 0) return 有
  try {
    const rs = (a || {}).记录 || []
    for (let i = rs.length - 1; i >= 0; i--) {
      const t = String((rs[i] || {}).what || '')
      if (!t.includes('走到' + 位)) continue
      const m = String((rs[i] || {}).at || '').match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
      if (!m) continue
      return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - 8 * 3600e3
    }
  } catch (e) { /* 读不到就算了 */ }
  return 0
}
const requireDir = (d) => _rd(d)
const requireStat = (f) => _st(f)
let _PJ = {}
const P_ = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)
// ALIAS_FIX 2026-11-02：下面访客人话函数用的是短名 P()，原来没定义，补上别名
const P = (k, d) => P_(k, d)
try { _PJ = JSON.parse(_rf('{{BOT_ROOT}}/共享/工具/参数.json', 'utf8'))['拟人'] || {} } catch { _PJ = {} }
const H = (k, d) => (_PJ[k] !== undefined ? _PJ[k] : d)

import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync, chmodSync } from 'node:fs'
// TTS_CFG 2026-11-12：说的 base 有推导规则（兼容模式 → 原生 /api/v1），
// 面板要显示的就是真正会去请求的那个地址，别自己再抄一份推导。
import { 说配置 } from './语音合成.mjs'
// LAYERS 2026-11-17（批次669）：四层视图的纯派生逻辑放在单独模块里，便于单测。
import { 派生四层, 最近一个请求, 路由统计 } from './黑箱四层.mjs'
import { 候选时段, 凭证可用, 校验时段, 有效倍率, 基础倍率, 谷期 } from './接口时段.mjs'
import { 内心短句, 留话摘句 } from './首页话语.mjs'
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { 有效感受 } from './有效感受.mjs'

// ENV_FALLBACK 2026-11-12：面板和 dsh-bot 是两个 systemd 单元，只有后者带 EnvironmentFile。
// omni 的 key/base 就写在 /etc/dshbot.env 里 —— 面板读不到，页面上就永远显示「没有」，
// 点「验一把」也永远说「key 或 base 没配」。这里补一层兜底：
// **只补 DASHSCOPE_* 四个**，不做全量加载 —— 全量会把 BAOKE_MEM 之类的路径变量带进面板进程，
// 那些变量会被下面 import 的模块当目录用，等于悄悄换了读哪个目录。
try {
  const 要补 = ['DASHSCOPE_API_KEY', 'DASHSCOPE_BASE_URL', 'DASHSCOPE_UPLOAD_URL', 'DASHSCOPE_MODEL']
  const 已读 = new Set()
  for (const 行 of readFileSync('/etc/dshbot.env', 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(行)
    if (!m || !要补.includes(m[1]) || 已读.has(m[1])) continue
    已读.add(m[1])
    const 值 = String(m[2] || '').replace(/^["'](.*)["']\s*$/, '$1').trim()
    if (!process.env[m[1]] && 值) process.env[m[1]] = 值
  }
} catch { /* 没这个文件也不影响面板启动 */ }

const PORT = Number(process.env.PORT || 8787)
const base = process.env.QQ_PANEL_MEM || '{{BOT_ROOT}}/记忆'   // SANDBOX 2026-11-07（批次176）：测试可注入目录；不设变量时行为完全不变
const tools = '{{BOT_ROOT}}/共享/工具'
const NODE = '/usr/local/bin/node'
const OWNER = '{{OWNER_UIN}}'
const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
const save = (p, o) => 写档(p, o)

// —— 密钥（签 cookie）与用户表
const keyP = tools + '/面板密钥.json'
let KEY = load(keyP, null)
if (!KEY) { KEY = { secret: randomBytes(24).toString('hex') }; save(keyP, KEY) }
const usersP = tools + '/面板用户.json'
let USERS = load(usersP, { users: {} })
const saveUsers = () => save(usersP, USERS)

const hashPw = (pw, salt) => createHash('sha256').update(salt + ':' + pw).digest('hex')
const sign = (payload) => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return body + '.' + createHmac('sha256', KEY.secret).update(body).digest('base64url')
}
const verify = (token) => {
  if (!token || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const want = createHmac('sha256', KEY.secret).update(body).digest('base64url')
  try {
    if (mac.length !== want.length || !timingSafeEqual(Buffer.from(mac), Buffer.from(want))) return null
    const p = JSON.parse(Buffer.from(body, 'base64url').toString())
    return p.exp > Date.now() ? p : null
  } catch { return null }
}
const cookieOf = (req) => {
  const m = String(req.headers.cookie || '').match(/fish_session=([^;]+)/)
  return m ? decodeURIComponent(m[1]) : ''
}

// WEAR_TABLE_FIX 2026-11-03：原来面板里有一份写死的家具价，而且根本没有服装表
// （穿上/换下的代码引用了 服装表，运行起来就 ReferenceError，整页 500）。
// 现在两张表都从共享 json 读，价格和类别只有一处来源。
const 家具表 = (() => { try { return JSON.parse(readFileSync(tools + '/家具表.json', 'utf8')) } catch { return {} } })()
const 服装表 = (() => {
  // 2026-11-07 衣服移到 记忆/衣物表.json（带标签），面板价目也读它；没有就退回旧的那张
  try {
    const 衣 = JSON.parse(readFileSync('{{BOT_ROOT}}/记忆/衣物表.json', 'utf8')).件 || {}
    const 出 = {}
    for (const [n, v] of Object.entries(衣)) 出[n] = { 价: Number((v.穿 && v.穿.价) || v.价 || 0), 类别: '穿', 标签: v.标签 || [] }
    if (Object.keys(出).length) return 出
  } catch (_err) { console.error('[面板]', _err?.message || _err) }
  try { return JSON.parse(readFileSync(tools + '/服装表.json', 'utf8')) } catch { return {} }
})()
const SHOP = Object.assign({},
  Object.keys(家具表).reduce((o, k) => { o[k] = Number(家具表[k].价 || 0); return o }, {}),
  Object.keys(服装表).reduce((o, k) => { o[k] = Number(服装表[k].价 || 0); return o }, {})
)
// FURNITURE_MERGE 2026-11-03：舒适度统一读家具表（家具表已在上面定义，这里不再重复声明）
const COMFORT = Object.fromEntries(Object.entries(家具表).map(([k, v]) => [k, Number(v.舒适 || 0)]))

const tailChain = (n = 4) => {
  try {
    const raw = readFileSync(base + '/链.md', 'utf8')
    return raw.split(/^## /m).filter((x) => x.trim()).slice(-n).map((b) => '## ' + b.trim())
  } catch { return [] }
}

// 数值 → 人话（访客只看到这些）
const 精力话 = (e) => e == null ? '说不清' : e >= P('面板_精力足', 75) ? '精神头很足' : e >= P('面板_精力中', 55) ? '还算有精神' : e >= P('面板_精力低', 35) ? '有点乏' : e >= P('面板_精力差', 20) ? '挺累的' : '快撑不住了'
const 心情话 = (mi, sleeping) => sleeping ? '睡着' : mi >= 1 ? '心情不错' : mi <= -1 ? '有点闷' : '一般'
const 睡话 = (h) => h <= 0 ? '还没睡过' : h < 3 ? '睡了会儿' : h < 6 ? '睡得不算多' : '睡得还行'
const 钱话 = (m) => m < P('面板_钱少', 20) ? '兜里没几个钱' : m < P('面板_钱中', 60) ? '有点零花钱' : m < P('面板_钱多', 150) ? '攒了些' : '攒了不少'
const 家话 = (n, c) => n === 0 ? '屋里还空着' : c < P('面板_家几样', 4) ? '添了几样小东西' : c < P('面板_家有样', 10) ? '屋子有点样子了' : '屋子挺舒服的'
// WASH 2026-11-05（批次89）：身上这件事的人话。数值给主人，人话给客人。
const 清洁话 = (n) => n == null ? '说不清' : n >= 85 ? '清清爽爽' : n >= 70 ? '还算清爽' : n >= 55 ? '有点黏' : n >= 40 ? '身上不太舒服' : '该洗澡了'
const 多久话 = (分) => {
  if (分 == null) return '还没正式洗过'
  if (分 < 60) return 分 + ' 分钟前'
  if (分 < 24 * 60) return Math.round(分 / 60) + ' 小时前'
  return Math.round(分 / (24 * 60)) + ' 天前'
}

// DEBUG_TABS_V2 2026-11-03：调试页改成小选项分类——按「状态/睡眠/资产/账目/链与记录/其他」分组返回，
// 前端点哪个就只看哪一块。数据还是那些，只是不再堆成一大段。
// DEBUG_ALL 2026-11-08（批次230）：调试页从「6 坨原始 JSON」改成「18 个系统的中文清单」。
//
// 为什么要这么改：
//   · 原来每组是 readFileSync 直接 dump，满屏英文键（energy / layers / mood / state / nextAt），
//     主人得自己在脑子里翻译这个数是什么、正常范围是多少。
//   · 而且只接了 6 组，体温、渴、饿、病、工作、物品、位置、待办、心跳、出口全看不到 ——
//     要查「她为什么不动」得 ssh 上来越过一堆文件。
//
// 现在的结构：每组 = { id, name, 说明, 行:[{标签,值,注}], 原始 }。
// 前端渲染成「中文标签 / 值 / 一句人话注释」，原始 JSON 折在下面只给排障用。
// 派生值一律走真源模块（饱渴/饥饿/疾病/体温/穿衣/占用/工作/地点），不在这里重算 ——
// 同一个口径写两处必然分叉，这条已经踩过好几次。
// SETTABLE 2026-11-12（主人要求：面板上能实时改数值调试）。
//
// 为什么是一张白名单表，而不是「随便传个路径和值」：
//   面板能写的东西必须能一眼数清。给一个通用 JSON 编辑器，等于给一把能改任何状态、
//   绕开所有真源写入口的万能钥匙 —— 饱渴有衰减、状态有 saveState 的差异合并、
//   钱要过账本，绕过去就是静默坏数据（批次258 那 45% 丢钱就是这么来的）。
//
// 每个可调项只声明：范围、单位、怎么读、怎么写。写只有两条路：
//   · 状态类 → _状态.saveState(p, 改后, 改前)：按差异合并进磁盘最新那份，
//     不会把别人这几十毫秒里写的字段整份抹掉。
//   · 其它档 → _底层.改档(p, 改)：锁内重读再写。
// 「位置」故意不在表里：搬人只有 移动.mjs 一个入口，面板不给自己开后门。
//
// DEBUG_OVERRIDE 2026-11-17：状态推进 / 困意 / 睡眠阶段都会把状态写回磁盘，
// 手动改的值下一次心跳就没了。状态项因此额外落一条「调试覆盖」记录；
// 面板进程低频回读，发现被心跳改回就重新盖成目标值，到期自动解除。
const 调试覆盖时长 = 2 * 3600e3
const 调试分区 = [
  { id: 'body', 名: '身体', 说明: '精力、四层里的体力/认知、睡眠压力和身体感受。' },
  { id: 'emotion', 名: '情绪', 说明: '情绪层、存在层、当下心情、耐心与激素。' },
  { id: 'life', 名: '生活', 说明: '吃喝、清洁、疾病、工作、现金与自动行动参数。' },
  { id: 'relation', 名: '关系', 说明: '对主人的好感与别扭分。' },
]
const 可调项 = [
  // —— 状态.json（走 saveState）——
  { id: 'energy', 名: '精力', 区: 'body', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 1,
    说明: '体力、认知、情绪合成后的当前精力。',
    读: (s) => s.energy, 写: (v, s) => { s.energy = v } },
  { id: 'layers.physical', 名: '体力层', 区: 'body', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 0.1,
    说明: 'layers.physical：身体还能撑多久；病、虚弱、熬夜会压它的上限。',
    读: (s) => (s.layers || {}).physical,
    写: (v, s) => { s.layers = s.layers || {}; s.layers.physical = v } },
  { id: 'layers.cognitive', 名: '认知层', 区: 'body', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 0.1,
    说明: 'layers.cognitive：专注、思考和清醒程度。',
    读: (s) => (s.layers || {}).cognitive,
    写: (v, s) => { s.layers = s.layers || {}; s.layers.cognitive = v } },
  { id: 'layers.emotional', 名: '情绪层', 区: 'emotion', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 0.1,
    说明: 'layers.emotional：这一阵的情绪底色。',
    读: (s) => (s.layers || {}).emotional,
    写: (v, s) => { s.layers = s.layers || {}; s.layers.emotional = v } },
  { id: 'layers.existential', 名: '存在层', 区: 'emotion', 组: 'core', 单位: '点', 小: 10, 大: 95, 步: 0.1,
    说明: 'layers.existential：长期心气，不进精力，只当底色。',
    读: (s) => (s.layers || {}).existential,
    写: (v, s) => { s.layers = s.layers || {}; s.layers.existential = v } },
  { id: 'mood.intensity', 名: '心情强度', 区: 'emotion', 组: 'core', 单位: '分', 小: -2, 大: 2, 步: 0.1,
    说明: 'mood.intensity：当下的心情强弱，负数是闷，正数是好；心跳会把它收敛在 ±2。',
    读: (s) => (s.mood && s.mood.intensity) || 0,
    写: (v, s) => { s.mood = (s.mood && typeof s.mood === 'object') ? s.mood : {}; s.mood.intensity = v } },
  { id: 'mood.valence', 名: '心情方向', 区: 'emotion', 组: 'core', 单位: '', 小: -1, 大: 1, 步: 0.01,
    说明: 'mood.valence：偏愉快还是偏难受，负数偏难受。',
    读: (s) => (s.mood || {}).valence,
    写: (v, s) => { s.mood = (s.mood && typeof s.mood === 'object') ? s.mood : {}; s.mood.valence = v } },
  { id: 'mood.arousal', 名: '唤醒度', 区: 'emotion', 组: 'core', 单位: '', 小: 0, 大: 1, 步: 0.01,
    说明: 'mood.arousal：平静到兴奋/紧绷的程度。',
    读: (s) => (s.mood || {}).arousal,
    写: (v, s) => { s.mood = (s.mood && typeof s.mood === 'object') ? s.mood : {}; s.mood.arousal = v } },
  { id: 'sleepy', 名: '困意', 区: 'body', 组: 'core', 单位: '点', 小: 0, 大: 160, 步: 1,
    说明: '困意可以超过 100；超过 100 会进入熬夜惩罚档。',
    读: (s) => s['困意'], 写: (v, s) => { s['困意'] = v } },
  { id: 'weak', 名: '虚弱', 区: 'body', 组: 'core', 单位: '', 小: 0, 大: 1, 步: 0.01,
    说明: '长期吃不够造成的虚弱，0 是没事，1 是最虚。',
    读: (s) => s['虚弱'], 写: (v, s) => { s['虚弱'] = v } },
  { id: 'hoursAwake', 名: '清醒时长', 区: 'body', 组: 'core', 单位: '小时', 小: 0, 大: 72, 步: 0.5,
    说明: '从这次醒来起累计清醒了多久。',
    读: (s) => s.hoursAwake, 写: (v, s) => { s.hoursAwake = v } },
  { id: 'body.困', 名: '身体：困', 区: 'body', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 1,
    说明: 'body.困：身体自己感觉到的困。',
    读: (s) => (s.body || {})['困'], 写: (v, s) => { s.body = s.body || {}; s.body['困'] = v } },
  { id: 'body.累的那种痒', 名: '身体：累得发痒', 区: 'body', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 1,
    说明: 'body.累的那种痒：体力越低越明显。',
    读: (s) => (s.body || {})['累的那种痒'], 写: (v, s) => { s.body = s.body || {}; s.body['累的那种痒'] = v } },
  { id: 'body.说不清的不舒服', 名: '身体：说不清的不舒服', 区: 'body', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 1,
    说明: 'body.说不清的不舒服：熬夜或情绪很低时出现。',
    读: (s) => (s.body || {})['说不清的不舒服'], 写: (v, s) => { s.body = s.body || {}; s.body['说不清的不舒服'] = v } },
  { id: 'patience.short', 名: '短期耐心', 区: 'emotion', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 1,
    说明: '耐心.短期：被催、被打断会掉，认知水平决定它的恢复上限。',
    读: (s) => (s['耐心'] || {})['短期'],
    写: (v, s) => {
      s['耐心'] = (s['耐心'] && typeof s['耐心'] === 'object') ? s['耐心'] : {}
      s['耐心']['短期'] = v
      s['耐心']['短期更新于'] = 京秒()
    } },
  { id: 'patience.long', 名: '长期耐心', 区: 'emotion', 组: 'core', 单位: '点', 小: 0, 大: 100, 步: 1,
    说明: '耐心.长期：只在看到真实改变时回升。',
    读: (s) => (s['耐心'] || {})['长期'],
    写: (v, s) => {
      s['耐心'] = (s['耐心'] && typeof s['耐心'] === 'object') ? s['耐心'] : {}
      s['耐心']['长期'] = v
      s['耐心']['长期更新于'] = 京秒()
    } },
  // —— 饱渴.json（水/胃/卡/血糖；改字段必须同时把 at 拨到现在，否则下一次读按旧时间衰减）——
  { id: 'water', 名: '水', 区: 'life', 组: 'drink', 单位: 'ml', 小: 0, 大: 2400, 步: 50, 文件: '饱渴.json',
    说明: '当前补水量；写入时会把衰减起点拨到现在。',
    读: (o) => o['水'], 写: (v, o) => { o['水'] = v; o['水At'] = 京秒() } },
  { id: 'sugar', 名: '血糖', 区: 'life', 组: 'drink', 单位: 'mmol/L', 小: 3, 大: 9, 步: 0.1, 文件: '饱渴.json',
    说明: '血糖水平；写入时会把衰减起点拨到现在。',
    读: (o) => o['血糖'], 写: (v, o) => { o['血糖'] = v; o['血At'] = 京秒() } },
  { id: 'stomach', 名: '胃内容量', 区: 'life', 组: 'food', 单位: 'ml', 小: 0, 大: 1200, 步: 50, 文件: '饱渴.json',
    说明: '胃里现在有多少东西，决定当下的饱腹感。',
    读: (o) => o['胃'], 写: (v, o) => { o['胃'] = v; o['胃At'] = 京秒() } },
  { id: 'kcal', 名: '千卡', 区: 'life', 组: 'food', 单位: 'kcal', 小: 0, 大: 2400, 步: 100, 文件: '饱渴.json',
    说明: '长期能量账，影响虚弱、心情和体力上限。',
    读: (o) => o['卡'], 写: (v, o) => { o['卡'] = v; o['卡At'] = 京秒() } },
  // —— 刷手机（批次392）：刷一刷.mjs 每个 tick 现读，改完下个 tick 生效，不用重启 ——
  // 文件指到 共享/工具/参数.json：从 记忆/ 出发就是 '../共享/工具/参数.json'。
  // 写走 改档（锁内重读），跟别的项同一条路，不给面板开第二个写入口。
  ...['刷_间隔分钟:两次之间:分钟:3:240:1', '刷_浮动分钟:间隔浮动:±分钟:0:60:1',
    '刷_每天上限:每天最多:次:1:200:1', '刷_每次条:每次几条:条:3:12:1',
    '刷_B站占比:B站占比:比例:0:1:0.05', '刷_精力下限:没劲儿门槛:精力:0:100:1',
    '刷_贴吧读正文:贴吧读正文:开关:0:1:1', '刷_贴吧读正文条:读几条正文:条:0:5:1',
    '刷_贴吧正文字数:正文最多:字:40:400:20', '刷_贴吧正文最短:正文最短:字:0:100:2',
    '刷_贴吧回复条:带几层回复:层:0:5:1', '刷_贴吧回复字数:每层最多:字:20:200:10',
    '自主_看B站每天上限:看B站每天:次:1:10:1', '自主_逛贴吧每天上限:逛贴吧每天:次:1:10:1'].map((s) => {
    const [键, 名, 单位, 小, 大, 步] = s.split(':')
    return { id: 'browse.' + 键, 名, 区: 'life', 组: 'browse', 单位, 小: Number(小), 大: Number(大), 步: Number(步),
      说明: '自动行动参数，下一轮读取时生效。',
      文件: '../共享/工具/参数.json',
      读: (o) => (o['拟人'] || {})[键],
      写: (v, o) => { o['拟人'] = o['拟人'] || {}; o['拟人'][键] = v } }
  }),
  // —— 贴表情（批次397）——
  // 这个上限一直只在 参数.json 里，面板上没有入口：值是 0 = 不限，而设计原意是「每小时有个数」。
  // 她近几天 1~5 次/小时，没到需要拦的程度，所以**默认值不动**，只是把开关摆在主人手边。
  ...['贴表情_每小时上限:每小时上限:次/时:0:20:1'].map((s) => {
    const [键, 名, 单位, 小, 大, 步] = s.split(':')
    return { id: 'react.' + 键, 名, 区: 'life', 组: 'react', 单位, 小: Number(小), 大: Number(大), 步: Number(步),
      说明: '0 表示不限；只影响她主动贴表情的频率。',
      文件: '../共享/工具/参数.json',
      读: (o) => (o['拟人'] || {})[键],
      写: (v, o) => { o['拟人'] = o['拟人'] || {}; o['拟人'][键] = v } }
  }),
  // —— 其余单档 ——
  { id: 'temp', 名: '体温', 区: 'body', 组: 'body', 单位: '℃', 小: 34, 大: 41, 步: 0.1, 文件: '体温.json',
    说明: '当前体温，写入时会把测量时间拨到现在。',
    读: (o) => o['体温'], 写: (v, o) => { o['体温'] = v; o['at'] = 京秒() } },
  { id: 'clean', 名: '清洁度', 区: 'life', 组: 'clean', 单位: '点', 小: 0, 大: 100, 步: 5, 文件: '卫生.json',
    说明: '身上有多清爽，越低越想洗澡。',
    读: (o) => o['清洁'], 写: (v, o) => { o['清洁'] = v } },
  { id: 'sick', 名: '疾病值', 区: 'life', 组: 'sick', 单位: '点', 小: 0, 大: 1000, 步: 50, 文件: '疾病.json',
    说明: '疾病真源；600 得病、800 加重。', 危险: true,
    读: (o) => o['值'], 写: (v, o) => { o['值'] = v } },
  { id: 'credit', 名: '信用', 区: 'life', 组: 'work', 单位: '点', 小: 0, 大: 100, 步: 5, 文件: '工作.json',
    说明: '工作信用，影响排班和收入。',
    读: (o) => o['信用'], 写: (v, o) => { o['信用'] = v } },
  // 钱：记录里不写「N 块」，否则 账本 的兜底规则会把它算成一笔真开销/收入
  { id: 'money', 名: '现金', 区: 'life', 组: 'money', 单位: '元', 小: 0, 大: 100000, 步: 10, 文件: '资产.json',
    说明: '会写进资产记录，直接影响她的真实余额。', 危险: true,
    读: (o) => o['钱'],
    写: (v, o) => { o['钱'] = v; o['记录'] = Array.isArray(o['记录']) ? o['记录'] : []; o['记录'].push({ at: 京分(), what: '调试图：现金改成 ' + v }) } },
  { id: 'score', 名: '主人分数', 区: 'relation', 组: 'relation', 单位: '点', 小: 0, 大: 100, 步: 1, 文件: '好感度.json',
    说明: '写的是四维（按比例缩放），score 只是渲染值；下一轮结算会按四维重算。', 危险: true,
    读: (o) => ((o.people || {})[OWNER] || {}).score,
    // SCORE_DERIVED 2026-11-17（批次604）：score 是 0.5亲近+0.3安全+0.2兴致的渲染值，
    // 原来直接写 score，下一轮 好感度.mjs 一结算就被四维重算覆盖，面板看起来“写了没用”。
    // 现在按比例缩放四维，让重算后的分数真的落在目标附近；score 同步写一份只做当下显示。
    // 批次 660（审计 P1-2）：残差回填 + 同步 lastTick，避免下一轮结算回弹/立刻衰减。
    写: (v, o) => {
      o.people = o.people || {}
      o.people[OWNER] = 写主人分数(o.people[OWNER] || {}, v, Date.now())
    } },
  { id: 'sulk', 名: '别扭分', 区: 'relation', 组: 'relation', 单位: '点', 小: 0, 大: 100, 步: 1, 文件: '别扭.json',
    说明: '真源字段是 level（0~100）；高值会明显改变说话方式。', 危险: true,
    读: (o) => { const x = (o.people || {})[OWNER]; return (x && typeof x === 'object') ? x.level : x },
    // SULK_LEVEL 2026-11-17（批次604）：别扭.mjs 写的是 level/why/need/since/until，
    // 面板原来读写 score —— 两边长期不一致，高值也不会改变说话方式。改回 level；
    // until 给一个调试图用的窗口（30 分钟~5 小时），下次 别扭.mjs 会按真档再收敛。
    写: (v, o) => {
      o.people = o.people || {}
      const x = o.people[OWNER]
      o.people[OWNER] = 别扭调试档(v, x, Date.now())
    } },
  { id: 'hor.dopamine', 名: '多巴胺', 区: 'emotion', 组: 'hormone', 单位: '点', 小: 0, 大: 100, 步: 1, 文件: '激素.json',
    说明: '影响心情方向、动力和长期基线。',
    读: (o) => (o.v || {}).dopamine, 写: (v, o) => { o.v = o.v || {}; o.v.dopamine = v } },
  { id: 'hor.cortisol', 名: '皮质醇', 区: 'emotion', 组: 'hormone', 单位: '点', 小: 0, 大: 100, 步: 1, 文件: '激素.json',
    说明: '压力激素；高值会把情绪基线往下压。',
    读: (o) => (o.v || {}).cortisol, 写: (v, o) => { o.v = o.v || {}; o.v.cortisol = v } },
  { id: 'hor.oxytocin', 名: '催产素', 区: 'emotion', 组: 'hormone', 单位: '点', 小: 0, 大: 100, 步: 1, 文件: '激素.json',
    说明: '亲近感相关的激素，影响情绪轴。',
    读: (o) => (o.v || {}).oxytocin, 写: (v, o) => { o.v = o.v || {}; o.v.oxytocin = v } },
  { id: 'hor.gaba', 名: 'GABA', 区: 'emotion', 组: 'hormone', 单位: '点', 小: 0, 大: 100, 步: 1, 文件: '激素.json',
    说明: '平静相关的激素，偏低时更容易紧绷。',
    读: (o) => (o.v || {}).gaba, 写: (v, o) => { o.v = o.v || {}; o.v.gaba = v } },
  // ADRENALINE 2026-11-16（批次572）：第五个。面板改它立刻生效 ——
  // 但 激素.mjs 的 tick 会把它拉回 18，想看效果得当场看。
  { id: 'hor.adrenaline', 名: '肾上腺素', 区: 'emotion', 组: 'hormone', 单位: '点', 小: 0, 大: 100, 步: 1, 文件: '激素.json',
    说明: '急性唤醒；会被激素心跳拉回常态。',
    读: (o) => (o.v || {}).adrenaline, 写: (v, o) => { o.v = o.v || {}; o.v.adrenaline = v } },
]

// 一键（前端两个按钮）。只组合上面已有的项，不另开写入口。
const 一键 = {
  __full: [['energy', 85], ['water', 2000], ['stomach', 800], ['kcal', 1800], ['sleepy', 10], ['clean', 95]],
  __heal: [['sick', 0], ['weak', 0]],
}

const 京秒 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
const 京分 = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

// ═══════════════════════════════════════════════════════════════════════════
// DOC_EDIT 2026-11-14（批次390）：人格与设定，面板上直接改。
//
// 为什么单独一套：可调项 那套是「数字 + 上下限 + 字段读写」，而这几份是整篇文本
// （md / json），要的是「读全文 → 编辑 → 校验 → 备份 → 原子写」。
//
// 白名单五个 key，不接受任意路径 —— 跟 DEBUG_SET 一个原则：面板不该有一把万能钥匙。
// 备份落在 记忆/.文档备份/，同 key 只留最近 20 份。
// DOC_SKELETON 2026-11-24：人味/黑话本这类「数据型」文档，第一次打开时按中性骨架自动生成，
// 免得新 bot 复制完模板点开是空的或直接报 ENOENT。
const __人味骨架 = {
  "说明": "八类人味，压成短句。注入时只从这里取，别在代码里再散写一遍。改这里等于改她的行为倾向。新 bot 先把每一类填成自己的话。",
  "表达": {"许可": [], "倾向": ""},
  "关系账": {"记什么": [], "用法": ""},
  "约定与时间": {"承诺": "", "久别重逢": "", "纪念日": "", "深夜": ""},
  "身体当理由": {"例子": [], "倾向": ""},
  "说不清的偏": {"内容": [], "原则": ""},
  "空白": {"沉默五种": [], "无聊": ""},
  "怕与要": {"怕": [], "要": []},
  "自省": {"节奏": "", "用法": ""}
}

const 文档白名单 = {
  SOUL: { 名: 'SOUL 人设', 路: '{{BOT_ROOT}}/SOUL.md', 类: 'md' },
  人味: { 名: '人味八类', 路: '{{BOT_ROOT}}/记忆/人味.json', 类: 'json', 默认: __人味骨架 },
  门牌: { 名: '门牌', 路: '{{BOT_ROOT}}/门牌.md', 类: 'md' },
  热记忆: { 名: '热记忆', 路: '{{BOT_ROOT}}/热记忆.md', 类: 'md' },
  // SLANG_DOC 2026-11-14（批次394）：梗知识.md 已并入 圈子黑话.json（唯一真源）。
  // 这里换成「黑话本」——主人能直接改/加词条（JSON 会校验），比编辑一个废弃的 md 有用。
  黑话本: { 名: '黑话本', 路: '{{BOT_ROOT}}/记忆/圈子黑话.json', 类: 'json', 默认: [] },
}
const 文档备份目录 = '{{BOT_ROOT}}/记忆/.文档备份'
const 文档上限 = 65536

// ══ 给她的话 LETTER 2026-11-15（批次494）══════════════════════════
// 主人要的是「我给她的留言」：他在面板上写一段，她那边能看到；
// **她回不回、回什么、要不要因此做点什么，全由她自己定** —— 面板只负责「把话送到」。
// 按天一个文件（跟日记一样），放在 给她的话/YYYY-MM-DD.md。
// 投递侧在 voiceSlots.js 的 slotLetter（每轮注入一段「他今天给你留了话：…」）。
const 留言目录 = '{{BOT_ROOT}}/共享/给她的话' // 和 poll.js 的 留言段() 保持一致（那边走 QQ_SHARED 派生）
const 留言上限 = 20000

function 留言日期(x) {
  const d = String(x || '').trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d
  return new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
}

function 读留言(date) {
  const d = 留言日期(date)
  const p = `${留言目录}/${d}.md`   // 面板没有 path.join，全库都是模板字符串拼的
  try {
    const st = _st(p)
    return {
      ok: true, date: d, 内容: readFileSync(p, 'utf8'),
      字: readFileSync(p, 'utf8').trim().length,
      mtime: new Date(st.mtimeMs + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
    }
  } catch {
    return { ok: true, date: d, 内容: '', 字: 0, mtime: '' }
  }
}

function 写留言(date, 内容) {
  const d = 留言日期(date)
  const 文 = String(内容 == null ? '' : 内容)
  if (文.length > 留言上限) return { ok: false, msg: '太长了：' + 文.length + ' 字，上限 ' + 留言上限 }
  try {
    _mkd(留言目录, { recursive: true })
    // 空内容 = 删掉这一天（他写错了想撤掉）
    if (文.trim() === '') {
      try { unlinkSync(`${留言目录}/${d}.md`) } catch { /* 本来就没有 */ }
      return { ok: true, date: d, 字: 0, 删了: true }
    }
    writeFileSync(`${留言目录}/${d}.md`, 文, 'utf8')
    return { ok: true, date: d, 字: 文.trim().length }
  } catch (e) {
    return { ok: false, msg: '写不进去：' + String((e && e.message) || e).slice(0, 100) }
  }
}

function 留言列表() {
  try {
    return _rd(留言目录)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .map((f) => {
        const p = `${留言目录}/${f}`
        const st = _st(p)
        let 字 = 0
        try { 字 = readFileSync(p, 'utf8').trim().length } catch { /* 读不到就当 0 */ }
        return { date: f.slice(0, 10), 字, mtime: new Date(st.mtimeMs + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') }
      })
      .sort((a, b) => (a.date < b.date ? 1 : -1))
  } catch { return [] }
}

function 读文档(key) {
  const 项 = 文档白名单[key]
  if (!项) return { ok: false, msg: '没有这份文档：' + key }
  try {
    let 内容
    try {
      内容 = readFileSync(项.路, 'utf8')
    } catch (e) {
      if (!e || e.code !== 'ENOENT' || 项.默认 === undefined) throw e
      try { _mkd(dirname(项.路), { recursive: true }) } catch (_err) { console.error('[面板]', _err?.message || _err) }
      writeFileSync(项.路, JSON.stringify(项.默认, null, 2) + '\n', 'utf8')
      内容 = readFileSync(项.路, 'utf8')
    }
    const st = _st(项.路)
    const 备份数 = (() => { try { return _rd(文档备份目录).filter((f) => f.startsWith(key + '-')).length } catch { return 0 } })()
    return {
      ok: true, key, 名: 项.名, 类: 项.类, 内容,
      字节: st.size, 上限: 文档上限, 备份数,
      mtime: new Date(st.mtimeMs + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
    }
  } catch (e) {
    return { ok: false, msg: '读不到：' + String((e && e.message) || e).slice(0, 100) }
  }
}

function 写文档(key, 内容) {
  const 项 = 文档白名单[key]
  if (!项) return { ok: false, msg: '没有这份文档：' + key }
  const 文 = String(内容 == null ? '' : 内容)
  if (文.length > 文档上限) return { ok: false, msg: '太长了：' + 文.length + ' 字，上限 ' + 文档上限 }
  if (文.trim() === '') return { ok: false, msg: '不能清空 —— 这是她的人格文件，空了她就不是她了' }
  if (项.类 === 'json') {
    try { JSON.parse(文) } catch (e) {
      // JSON_WHERE 2026-11-14（批次464）：原来只回「第几行第几列」，但编辑框可能已经滚到别处，
      // 主人根本看不到是哪一行错。这里把出错位置**那一行的原文**一起回过去（截 80 字）。
      const 消 = String((e && e.message) || e)
      let 位置 = ''
      try {
        const m = 消.match(/position (\d+)/)
        if (m) {
          const i = Number(m[1])
          const 头 = 文.slice(0, i)
          const 行号 = 头.split('\n').length
          const 列 = i - 头.lastIndexOf('\n')
          const 行文 = 文.split('\n')[行号 - 1] || ''
          位置 = ' ｜ 第 ' + 行号 + ' 行第 ' + 列 + ' 列：' + 行文.trim().slice(0, 80)
        }
      } catch { /* 位置算不出来就只给原始消息 */ }
      return { ok: false, msg: 'JSON 格式不对，没保存（文件没动，点「重新读」可还原）：' + 消.slice(0, 80) + 位置 }
    }
  }
  try {
    const 旧 = readFileSync(项.路, 'utf8')
    if (旧 === 文) return { ok: true, key, 名: 项.名, 未变: true, msg: '一个字都没改' }
    const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ').replace(/[: ]/g, '-')
    const 备份名 = key + '-' + at + '.bak'
    try {
      _mkd(文档备份目录, { recursive: true })
      writeFileSync(文档备份目录 + '/' + 备份名, 旧, 'utf8')
      // 同 key 只留最近 20 份；先排序再删最旧的
      const 们 = _rd(文档备份目录).filter((f) => f.startsWith(key + '-') && f.endsWith('.bak')).sort()
      for (const f of 们.slice(0, Math.max(0, 们.length - 20))) { try { _rm(文档备份目录 + '/' + f, { force: true }) } catch { /* 删不掉就算了 */ } }
    } catch { /* 备份失败不拦保存 */ }
    const tmp = 项.路 + '.tmp'
    writeFileSync(tmp, 文, 'utf8')
    _rn(tmp, 项.路)
    return { ok: true, key, 名: 项.名, 字节: 文.length, 备份: 备份名, msg: '已保存（旧版备份成 ' + 备份名 + '）' }
  } catch (e) {
    return { ok: false, msg: '写不进去：' + String((e && e.message) || e).slice(0, 120) }
  }
}

const 数差极小 = (a, b) => {
  const x = Number(a)
  const y = Number(b)
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 0.0005
}

const 找可调项 = (id) => 可调项.find((x) => x.id === id)
  || (id === 'mood' ? 可调项.find((x) => x.id === 'mood.intensity') : null)

function 调试覆盖表(st) {
  const x = st && st['调试覆盖']
  return x && typeof x === 'object' && !Array.isArray(x) ? x : {}
}

async function 写一项(id, 值) {
  const 项 = 找可调项(id)
  if (!项) return { ok: false, msg: '没有这一项：' + id }
  const n = Number(值)
  if (!Number.isFinite(n)) return { ok: false, msg: '要给个数字' }
  const v = Math.min(项.大, Math.max(项.小, Math.round(n * 1000) / 1000))
  const now = Date.now()
  try {
    if (!项.文件) {
      const p = base + '/状态.json'
      const 前 = 读状态(p, {})
      const 后 = JSON.parse(JSON.stringify(前))
      const 旧 = Number(项.读(前))
      项.写(v, 后)
      后['更新时间'] = 京分(now)
      后['调试覆盖'] = 后['调试覆盖'] && typeof 后['调试覆盖'] === 'object' && !Array.isArray(后['调试覆盖'])
        ? 后['调试覆盖'] : {}
      后['调试覆盖'][项.id] = {
        值: v,
        at: 京秒(now),
        到: 京秒(now + 调试覆盖时长),
        到Ms: now + 调试覆盖时长,
      }
      存状态(p, 后, 前)
      const 再 = 读状态(p, {})
      const 回 = Number(项.读(再))
      const 覆盖 = 调试覆盖表(再)[项.id] || {}
      const 写成 = 数差极小(回, v)
      return {
        ok: 写成, id: 项.id, 名: 项.名, 前: Number.isFinite(旧) ? 旧 : null, 值: v, 后: Number.isFinite(回) ? 回 : null,
        更新: String(再['更新时间'] || ''), 覆盖至: String(覆盖['到'] || ''),
        msg: 写成 ? ('已写入并回读确认，覆盖到 ' + String(覆盖['到'] || '') + ' 自动解除')
          : '写入后回读不一致；覆盖守卫会在下一轮再拉一次',
      }
    }
    let 前后 = null
    改档(base + '/' + 项.文件, (o) => {
      const 旧 = Number(项.读(o))
      项.写(v, o)
      前后 = { 前: Number.isFinite(旧) ? 旧 : null, 后: v }
    }, {})
    // CACHE_REFRESH 2026-11-17（批次677）：面板改千卡后，饥饿.json 的派生缓存要跟上；
    // 写 饱渴.json 的锁必须已经放开，所以放在 改档 返回之后，不在 项.写 里做。
    if (项.id === 'kcal') {
      try { 刷新饥饿饱腹() } catch { /* 缓存刷不上不影响这次写入本身 */ }
    }
    const 源 = load(base + '/' + 项.文件, {})
    const 回 = Number(项.读(源))
    const 写成 = 数差极小(回, v)
    let 更新 = ''
    try { 更新 = 京分(_st(base + '/' + 项.文件).mtimeMs) } catch (_err) { console.error('[面板]', _err?.message || _err) }
    return {
      ok: 写成, id: 项.id, 名: 项.名, 值: v, ...(前后 || {}), 回: Number.isFinite(回) ? 回 : null, 更新,
      msg: 写成 ? '已写入并回读确认' : '写入后回读不一致，请重试',
    }
  } catch (e) {
    return { ok: false, msg: '没写成：' + String((e && e.message) || e).slice(0, 120) }
  }
}

async function 清调试覆盖(id) {
  try {
    const p = base + '/状态.json'
    const 前 = 读状态(p, {})
    const 表 = 调试覆盖表(前)
    if (!Object.keys(表).length) return { ok: true, msg: '现在没有调试覆盖' }
    const 后 = JSON.parse(JSON.stringify(前))
    if (id === '__all') delete 后['调试覆盖']
    else {
      delete 后['调试覆盖'][id]
      if (!Object.keys(后['调试覆盖']).length) delete 后['调试覆盖']
    }
    后['更新时间'] = 京分()
    存状态(p, 后, 前)
    const 再 = 读状态(p, {})
    const 还 = 调试覆盖表(再)
    const 干净 = id === '__all' ? !Object.keys(还).length : !还[id]
    return {
      ok: 干净,
      msg: 干净 ? (id === '__all' ? '已清除全部调试覆盖' : '已解除这一项的覆盖') : '覆盖没清掉，请重试',
    }
  } catch (e) {
    return { ok: false, msg: '解除覆盖失败：' + String((e && e.message) || e).slice(0, 120) }
  }
}

let __守覆盖中 = false
async function 守调试覆盖() {
  if (__守覆盖中) return
  __守覆盖中 = true
  try {
    const p = base + '/状态.json'
    const 前 = 读状态(p, null)
    if (!前 || typeof 前 !== 'object' || Array.isArray(前)) return
    const 表 = 调试覆盖表(前)
    if (!Object.keys(表).length) return
    const now = Date.now()
    const 后 = JSON.parse(JSON.stringify(前))
    let 有变 = false
    for (const [id, 记] of Object.entries(表)) {
      const 项 = 找可调项(id)
      const 到期 = Number(记 && 记['到Ms'])
      if (!项 || 项.文件 || !Number.isFinite(到期) || 到期 <= now) {
        delete 后['调试覆盖'][id]
        有变 = true
        continue
      }
      if (!数差极小(项.读(后), 记['值'])) {
        项.写(Number(记['值']), 后)
        有变 = true
      }
    }
    if (!Object.keys(后['调试覆盖'] || {}).length) delete 后['调试覆盖']
    if (!有变) return
    后['更新时间'] = 京分(now)
    存状态(p, 后, 前)
  } catch (_err) { console.error('[面板]', _err?.message || _err) } finally {
    __守覆盖中 = false
  }
}

async function 写一项或一键(id, 值) {
  if (一键[id]) {
    const 结果 = []
    for (const [k, v] of 一键[id]) 结果.push(await 写一项(k, v))
    const 坏 = 结果.filter((x) => !x.ok)
    return 坏.length
      ? { ok: false, msg: '有 ' + 坏.length + ' 项没写成：' + 坏.map((x) => x.msg).join('；') }
      : { ok: true, msg: '改好了 ' + 结果.length + ' 项', 项: 结果 }
  }
  return 写一项(id, 值)
}

async function debugDump() {
  const cap = (t, n) => String(t || '').slice(-n)
  // TS_READABLE 2026-11-05：13 位毫秒时间戳渲染成「日期 时:分」，只是显示层处理。
  const 好看 = (t) => String(t || '').replace(/(?<!\d)(1[5-9]\d{11})(?!\d)/g, (m) => {
    const n = Number(m)
    if (!Number.isFinite(n) || n < 1.4e12 || n > 2.2e12) return m
    return new Date(n + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  })
  // 顺手把「2026-11-04T10:27」这种不带时区的 UTC 写法也换成北京时间。
  const 统一时区 = (t) => String(t || '').replace(/(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/g, (m, d, hh, mm) => {
    const dt = new Date(Date.parse(d + 'T' + hh + ':' + mm + ':00Z') + 8 * 3600e3)
    return dt.toISOString().slice(0, 16).replace('T', ' ')
  })
  const text = (p, n = 3000) => { try { return 统一时区(好看(cap(readFileSync(p, 'utf8'), n))) } catch { return '(读不到)' } }
  const 原始 = (p, n = 40) => { try { return 统一时区(好看(JSON.stringify(JSON.parse(readFileSync(p, 'utf8')), null, 1).slice(-n * 120))) } catch { return '(读不到)' } }
  const 取 = (p, fb = null) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return fb } }
  const 试 = (fn, fb = null) => { try { const v = fn(); return v === undefined ? fb : v } catch { return fb } }
  const N = (v, d = 1) => {
    const n = Number(v)
    return (v === null || v === undefined || v === '' || !Number.isFinite(n)) ? '—' : String(Math.round(n * 10 ** d) / 10 ** d)
  }
  const it = (标签, 值, 注) => ({
    标签: String(标签),
    值: (值 === undefined || 值 === null || 值 === '') ? '—' : String(值),
    注: 注 ? String(注) : '',
  })
  const groups = []
  const g = (id, name, 说明, 行, 原) => groups.push({ id, name, 说明: 说明 || '', 行: (行 || []).filter(Boolean), 原始: 原 || '' })

  // 这些模块的 MEM 是 `process.env.XXX || 目录`，面板进程没设过 → 补默认值，别让 import 崩。
  // 补的是同一个目录，对别处无影响；模块顶层只求值一次，不用恢复。
  for (const k of ['BAOKE_MEM', 'HUNGER_MEM', 'GAP_MEM', 'TEMP_MEM', 'CLOTH_MEM', 'WORK_MEM', 'QQ_AUTONOMY_MEM']) {
    if (!process.env[k]) process.env[k] = base
  }
  const 模块 = {}
  const 载 = async (name) => {
    if (!(name in 模块)) {
      try { 模块[name] = await import('./' + name + '.mjs') } catch { 模块[name] = null }
    }
    return 模块[name]
  }

  const 今 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  const 现刻 = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

  // ── 1 核心状态 ────────────────────────────────────────
  const st = 取(base + '/状态.json', {}) || {}
  const L = st.layers || {}
  const 层值 = (k) => (L[k] === undefined ? 100 : L[k])
  // LAYERS_TRUTH 2026-11-16（批次571）：这里原来四层一起 Math.min，还写着
  // 「精力是木桶：四层一起取最低」—— 但 恢复目标.精力() 只取
  // 体力^0.6 × 认知^0.4 × 情绪修正，**existential 根本不参与**。面板在说谎，看板的人会误判。
  // existential 的定位改成「心气」：不进精力，只当长期底色（主人 2026-11-16 拍的）。
  const 最薄 = Math.min(层值('physical'), 层值('emotional'), 层值('cognitive'))
  g('core', '核心状态', '精力按 体力^0.6 × 认知^0.4 × 情绪修正 算 —— 三层里最拖后腿的那层压得最狠；存在层不进这个公式。', [
    it('更新时间', 好看(st.更新时间), '状态推进最后一次跑的时间；超过 20 分钟没变说明心跳没转'),
    it('精力', N(st.energy) + ' / 100', '总精力；上限会被病、虚弱、熬夜、冷热、情绪压低'),
    it('体力层', N(L.physical), 'physical：走动、打工、运动'),
    it('情绪层', N(L.emotional), 'emotional：心情与激素'),
    it('认知层', N(L.cognitive), 'cognitive：熬夜、困意'),
    it('存在层', N(L.existential), 'existential：长期心气。不进精力，只当底色；掉下去时她心里会空'),
    it('当前瓶颈', N(最薄), '体力 / 认知 / 情绪 三层里最低的那个 —— 精力主要被它拖住'),
    it('心情', (st.mood && st.mood.label ? st.mood.label : '—') + '（强度 ' + N(st.mood && st.mood.intensity, 2) + '）', '面板立绘、对话语气都读它'),
    // LAYERS_TRUTH（批次571）：删掉「循环」这一行 —— `st.loop` 全仓没有写方，
    // 面板永远显示 '—'。一个永远显示空值的字段比不显示更误导（跟 别扭.json 那个坑同类）。
    it('困意', N(st.困意) + ' / 100', '70 以上开始想睡'),
    it('虚弱', N(st.虚弱), '长期吃不够；按比例砍体力上限，跟病相乘不是相加'),
    it('疾病值', N(st.疾病值) + ' / 1000', '≥600 才会病，≥800 加重'),
    it('醒着', N(st.hoursAwake) + ' 小时', '从上次自然醒算'),
  ], 原始(base + '/状态.json', 30))

  // ── 2 睡眠 ────────────────────────────────────────────
  const 睡 = 取(base + '/睡眠.json', {}) || {}
  const 醒档 = 取(base + '/睡醒.json', {}) || {}
  const 盹档 = 取(base + '/打盹.json', {}) || {}
  const 段表 = Array.isArray(睡.segments) ? 睡.segments : []
  const 末段 = 段表[段表.length - 1] || {}
  const 今日睡 = 试(() => {
    const 起 = Date.parse(今 + 'T00:00:00+08:00')
    const 止 = 起 + 86400e3
    let 分 = 0
    for (const seg of 段表) {
      const a = 解析时刻(seg.start)
      const b = seg.end ? 解析时刻(seg.end) : Date.now()
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue
      const x = Math.max(a, 起), y = Math.min(b, 止)
      if (y > x) 分 += (y - x) / 60000
    }
    return Math.round(分 / 6) / 10
  }, '—')
  g('sleep', '睡眠', '判据只认 睡态.睡着()（它先看 睡醒.json 的标记）；别读 自主.state 或 睡眠.json.sleeping。', [
    it('现在', 试(() => (睡着(base) ? '睡着' : '醒着'), '—'), 'sleepgate 用的就是这个判据'),
    it('最近一段', 末段.start ? (好看(末段.start) + ' → ' + (末段.end ? 好看(末段.end) : '还没醒')) : '—', '睡眠.json 里最后一段'),
    it('这一段', 末段.start ? (N(试(() => { const a = 解析时刻(末段.start); const b = 末段.end ? 解析时刻(末段.end) : Date.now(); return (b - a) / 3600e3 }, 0)) + ' 小时') : '—', '还没醒就算到现在'),
    it('今天睡了', N(今日睡) + ' 小时', '按和今天有交叠的段算，跨零点也算'),
    it('醒来', 好看(醒档.at) || '—', '睡醒.json 的记录'),
    it('睡醒标记', 醒档.sleeping === undefined ? '没有' : (醒档.sleeping ? 'sleeping=true（睡着）' : 'sleeping=false（醒着）'), '这个标记优先于 睡眠.json'),
    it('打盹', 盹档.到 ? ('到 ' + 好看(盹档.到)) : '没有', '打盹不写 睡醒.json'),
  ], 原始(base + '/睡眠.json', 12) + '\n\n— 睡醒 —\n' + 原始(base + '/睡醒.json', 4) + '\n\n— 打盹 —\n' + 原始(base + '/打盹.json', 4))

  // ── 3 体温与穿衣 ──────────────────────────────────────
  const 温 = await 载('体温')
  const 温r = 试(() => (温 ? 温.读() : {}), {}) || {}
  const 穿 = await 载('穿衣')
  const 穿r = 试(() => (穿 ? 穿.快照({ 湿: 0, 风: 0 }) : {}), {}) || {}
  const 露 = 试(() => (Array.isArray(穿r.露着) ? 穿r.露着.join('、') : ''), '')
  // WARM_GAP 2026-11-14（批次403）：该穿() 的「差」以前没人看，面板上也看不见。
  const 差r = 试(() => (穿 && 穿.该穿 ? 穿.该穿(Date.now()) : {}), {}) || {}
  g('body', '体温与穿衣', '体温是身体发动机的温度，体感是皮肤觉得多冷多热。', [
    it('体温', N(温r.体温, 2) + ' ℃', '每轮朝目标靠；发烧时被 疾病.发烧偏移 顶高（最多 +1.8）'),
    it('目标', N(温r.目标, 2) + ' ℃', '37 + (体感 − 23) × 0.08，再加病理偏移'),
    it('体感', N(温r.体感 && 温r.体感.值) + ' ℃', '风、湿、太阳加成后的「她觉得多冷」'),
    it('档', 试(() => 温.档(温r.体温).名, '—'), '从很冷到很热；体力上限的扣分从这里出'),
    it('上次更新', 好看(温r.at), ''),
    it('穿着加权', N(穿r.加权, 2) + ' 度', '各部位保温加起来，越高越暖'),
    it('最薄处', 穿r.最薄 || '—', '最薄那个部位，冷风从这里进'),
    it('露着', 露 || '没有', '没被衣服盖住的部位'),
    it('部位数', 穿r.部位 ? (Object.keys(穿r.部位).length + ' 处') : '—', '头/脖子/上身/下身/手/脚等'),
    it('明天该穿', (Array.isArray(差r.挑) ? 差r.挑.join('、') : '') || '—',
      '按明天最低温和有没有雨，从衣柜里挑的一套'),
    it('差多少保暖', N(差r.差, 1) + ' 度',
      '> 0 = 衣柜里没有更厚的了；她冷的时候体感槽会把这句话告诉她，买不买由她'),
  ], 原始(base + '/体温.json', 8))

  // ── 4 渴 ──────────────────────────────────────────────
  const 饱渴 = await 载('饱渴')
  const 饱r = 试(() => (饱渴 ? 饱渴.读() : {}), {}) || {}
  // 渴话只在 饥饿.读() 里（它内部合并了 饱渴），所以先取一份，后面「饿」那组复用。
  const 饿r = 试(() => 读饥饿(), {}) || {}
  g('drink', '渴（水）', '水 ≥85 不渴，75 有点渴，50 渴了，25 很渴，<10 快渴死。', [
    it('水', N(饱r.水百分比) + '%（' + Math.round(Number(饱r.水) || 0) + ' / 2000 毫升）', '每小时掉约 60~90 毫升；睡醒、出汗掉得更快'),
    it('渴话', 饿r.渴话 || '—', '她自己、面板、插件说的是同一句'),
    it('水档', 饱r.水档 ? (饱r.水档.名 + '（掉得 ' + 饱r.水档.速度 + ' 倍）') : '—', '喝水意向的分档'),
    it('上次喝水', 好看(饱r.水At), ''),
    it('水杯', 试(() => {
      const o = 取(base + '/物品.json', {}) || {}
      const c = (o.items || []).find((x) => x && x.n === '水杯')
      if (!c || !c.容器) return '没有杯子'
      const 量 = ((c.容器.成分) || []).reduce((n, x) => n + (Number(x.量) || 0), 0)
      return Math.round(量) + ' / ' + (Number(c.容器.容量) || 1000) + ' 毫升'
    }, '—'), '街上只能喝杯里的；接水点能把杯加满'),
    it('最近账', 试(() => (饱r.账 || []).slice(-3).map((x) => (x.at || '').slice(11) + ' ' + (x.说明 || (x.喝 ? ('喝水 ' + x.喝 + 'ml') : '') || (x.吃 ? ('吃 ' + (typeof x.吃 === 'string' ? x.吃 : (x.吃.吃了 || ''))) : '') || (x.补液 ? ('补液 ' + (x.补液.毫升 || 0) + 'ml/' + (x.补液.千卡 || 0) + 'kcal') : '') || '')).join('；'), '—'), ''),
  ], 原始(base + '/饱渴.json', 10))

  // ── 5 饿 ──────────────────────────────────────────────
  g('food', '饿（胃与千卡）', '两本账：胃是「肚子里有没有东西」，千卡是长期能量。面板大字「饱腹感」= 胃 60% + 血糖 40%。', [
    it('胃', N(Number(饱r.胃 || 0) / ((饱渴 && 饱渴.胃满) || 1000) * 100, 1) + '%（' + Math.round(Number(饱r.胃) || 0) + ' / ' + ((饱渴 && 饱渴.胃满) || 1000) + ' 毫升）', '按 3.5/分 空；水有临时饱腹（临时 12，45/小时掉）'),
    it('饱腹感', N(饿r.饱腹感) + '%', '胃 60% + 血糖 40%；想不想吃按它算，不看千卡'),
    it('血糖', N(饱r.血糖, 1) + ' mmol/L', '低于 3.5 算低血糖，会补发一条「饿」激素事件'),
    it('千卡', N(饱r.卡百分比) + '%（' + Math.round(Number(饱r.卡) || 0) + ' / 2000）', '只管长期：低于 30% 扣心情、压体力上限'),
    it('欠账', N(饱r.欠, 1) + ' 顿', '长期没吃够攒的'),
    it('上次吃', (饿r.最后吃了 || '—') + '（' + 好看(饿r.最后吃At) + '）', ''),
    it('今天', 试(() => { const t = 饿r.今天 || {}; return (t.顿 || 0) + ' 顿 · 零食 ' + (t.零食 || 0) + ' 次' }, '—'), ''),
    it('最近账', 试(() => (饿r.账 || []).slice(-3).map((x) => (x.at || '').slice(11) + ' ' + (x.吃了 || x.说明 || '')).join('；'), '—'), ''),
  ], 原始(base + '/饥饿.json', 10))

  // ── 6 疾病 ────────────────────────────────────────────
  const 病r = 试(() => 疾病.读(), {}) || {}
  const 病当 = (病r.当前 || [])[0]
  g('sick', '疾病', '疾病值是攒出来的，不是概率抽卡：≥600 才病，≥800 加重。', [
    it('疾病值', N(病r.值) + ' / 1000', '平时 −8/小时，睡着 −14，在家歇 −10；冷/雨/风/熬夜/虚弱往上推'),
    it('现在', 病当 ? (病当.名 + ' ' + Math.round(Number(病当.重 || 0) * 100) + '%') : '健康', 病当 ? '重 0~1，压体力上限和心情' : '没病'),
    it('症状', 病当 && 病当.症状 ? 病当.症状.join('、') : '—', ''),
    it('发烧偏移', N(病r.发烧偏移, 2) + ' ℃', '加到体温目标上；退烧药 −0.8、挂水 −0.5'),
    it('体力扣', N(病r.体力扣, 1) + '%', '按比例砍上限，跟虚弱相乘'),
    it('心情扣', N(病r.心情扣, 2) + ' / 轮', '每 15 分钟一轮'),
    it('用药', 病r.药 ? ((病r.药.名 || '有药') + '，' + 好看(病r.药.起效At) + ' 起效') : '没有', '吃下 30~45 分钟才生效'),
    it('就诊', 病r.就诊 ? ((病r.就诊.阶段 || '看诊') + '（到 ' + 好看(病r.就诊.到) + '）') : '没有', '排队 / 挂水期间走不开'),
    it('本月', N(病r.数) + ' 次', '一个月最多 2 次'),
  ], 原始(base + '/疾病.json', 12))

  // ── 7 激素 ────────────────────────────────────────────
  const 激素档 = 取(base + '/激素.json', {}) || {}
  const hv = 激素档.v || {}, hb = 激素档.B || {}
  // ADRENALINE 2026-11-16（批次572）：第五个。它和皮质醇的区别要写清楚 ——
  // 一个是「当下心跳」，一个是「一直提着心」，分不清就会以为两个是重复的。
  const 激素名 = { dopamine: '多巴胺', cortisol: '皮质醇', oxytocin: '催产素', gaba: 'GABA', adrenaline: '肾上腺素' }
  const 激素注 = {
    dopamine: '有劲、想做事、想要东西',
    cortisol: '压力、警惕、撑住（慢性，半衰期 3 小时）',
    oxytocin: '亲、被在乎、想靠人',
    gaba: '松、静、睡得着',
    adrenaline: '绷着、心跳快、想动（急性，半衰期 21 分钟；不漂设定点）',
  }
  const 激素行 = Object.keys(激素名).map((k) => {
    const cur = Number(hv[k] ?? 0), bv = Number(hb[k] ?? 0)
    const d = Math.round((cur - bv) * 10) / 10
    const 箭头 = d > 2 ? ' ↑' : d < -2 ? ' ↓' : ' →'
    return it(激素名[k], N(cur) + '（平常 ' + N(bv) + '）', 激素注[k] + '；偏离 ' + (d > 0 ? '+' : '') + d + 箭头)
  })
  const 近事件 = 试(() => {
    const raw = readFileSync(base + '/激素事件.jsonl', 'utf8').trim()
    // EVENT_TIME 2026-11-16（批次572）：这里原来直接拼 j.at（unix 毫秒），
    // 面板上显示成 1794804884286 —— 主人截图圈出来的就是这个。
    // j.at 是毫秒数，另外有些老行可能带 at 字符串，两种都兜住。
    return raw.split('\n').slice(-6).map((l) => {
      try {
        const j = JSON.parse(l)
        const t = typeof j.at === 'number' ? 好看(j.at) : String(j.at || '')
        return (t ? t.slice(11, 16) + ' ' : '') + (j.kind || '')
      } catch { return '' }
    }).filter(Boolean).join('；')
  }, '')
  g('hormone', '激素', '五个值互相拉扯；偏离平常值超过 2 就是明显状态（箭头）。肾上腺素是急性的，不参与设定点漂移。', 激素行.concat([
    it('最近事件', 近事件 || '没有', '发病、吵架、亲密这些都发一次事件'),
    it('上次 tick', 好看(激素档.lastTick), '激素每轮往基线回落'),
  ]), 原始(base + '/激素.json', 10) + (近事件 ? ('\n\n— 最近事件 —\n' + 近事件) : ''))

  // ── 8 占用 ────────────────────────────────────────────
  const 占 = 试(() => 占着(base), null)
  g('occupy', '占用（在干什么）', '被占用时不能走动、逛街；只有物理占用才硬拦，其余只调权重。', [
    it('现在', 占 ? String(占.什么 || '占着') : '空着', 占 ? ('在 ' + (占.在哪 || '?') + '，到 ' + 好看(占.到)) : '可以自由行动'),
    it('占用话', 试(() => 占用话(base), '') || '—', '她对外的说法'),
    it('上班', 试(() => { const b = 在岗的班(base); return b ? (String(b.活 || '班') + '（' + b.起 + ' → ' + b.止 + '）') : '没有' }, '—'), '判据在 占用.在岗的班() 一处'),
    it('吃饭', 试(() => (在吃饭(base) ? '是' : '不是'), '—'), '吃饭要花时间，60% 落餐厅'),
    it('洗澡', 试(() => (在洗澡(base) ? '是' : '不是'), '—'), ''),
    it('看病', 试(() => (在看病(base) ? '是' : '不是'), '—'), '排队 / 挂水'),
    it('打盹', 试(() => (在打盹(base) ? '是' : '不是'), '—'), '短睡，不进 睡眠.json'),
  ], '')

  // ── 9 位置 ────────────────────────────────────────────
  const 资 = 取(base + '/资产.json', {}) || {}
  const 自 = 取(base + '/自主.json', {}) || {}
  const 地 = String(资.位置 || '—')
  const 地档 = 试(() => 读地点79(), {})
  const 营 = 试(() => 营业中79(地, 地档), null)
  g('place', '位置与地图', '搬人只有 移动.mjs 一个入口；place 写的是出发地。', [
    it('位置', 地, ''),
    it('营业', 营 ? (营.ok ? '开着' : ('关着（' + (营.因 || '') + '）')) : '—', '营业时间与周几休息都从 地图.json 读'),
    it('营业段', 营 && Array.isArray(营.段) && 营.段.length ? 营.段.map((x) => x.join('-')).join('、') : '—', ''),
    it('区域', 自.区域 || '—', '她对自己所在片区的说法'),
    it('地盘', 自.地盘 || '—', ''),
    it('区域状态', 自.区域状态 || '—', ''),
    it('在途目标', 自.place || '—', '走动时的目的地'),
  ], 原始(base + '/资产.json', 3))

  // ── 10 工作 ───────────────────────────────────────────
  const 工 = 取(base + '/工作.json', {}) || {}
  const 班次 = Array.isArray(工.班次) ? 工.班次.slice() : []
  const 下一班 = 班次.filter((b) => String(b.止 || '') >= 现刻()).sort((x, y) => String(x.起 || '').localeCompare(String(y.起 || '')))[0]
  g('work', '工作', '「状态=在岗」只说明打过卡，不说明她还在店里；在不在班上一律问 占用.在岗的班()。', [
    it('在职', Array.isArray(工.在职) && 工.在职.length ? 工.在职.join('、') : '—', ''),
    it('信用', N(工.信用, 0), '请假、迟到、睡岗会扣'),
    it('下一班', 下一班 ? (String(下一班.活 || '') + '：' + 下一班.起 + ' → ' + 下一班.止 + '（' + (下一班.状态 || '待上') + '）') : '没有排班', ''),
    it('班次数', 班次.length + ' 条', '最近 20 条留在文件里'),
    it('最近一班', 班次.length ? (String(班次[班次.length - 1].活 || '') + '：' + (班次[班次.length - 1].起 || '') + ' → ' + (班次[班次.length - 1].止 || '') + '（' + (班次[班次.length - 1].状态 || '?') + '）') : '—', ''),
    it('统计', 试(() => JSON.stringify(工.统计 || {}).slice(0, 120), '—'), ''),
  ], 原始(base + '/工作.json', 10))

  // ── 11 钱与账 ─────────────────────────────────────────
  const 信贷 = 资.信贷 || {}
  const 记录 = Array.isArray(资.记录) ? 资.记录 : []
  const 花呗 = 信贷.花呗 || {}
  const 贷款 = 信贷.贷款 || {}
  g('money', '钱与账', '钱只经 账本.mjs 解析；三个「账」别混：资产.记录 / 活动.kind=买 / 自主.state。', [
    it('现金', '¥' + N(资.钱, 0), ''),
    it('花呗', '已用 ' + N(花呗.已用, 0) + ' / ' + N(花呗.额度, 0) + '，日息 ' + N(花呗.日息, 4), '钱不够先刷这个'),
    it('贷款', '已用 ' + N(贷款.已用, 0) + ' / ' + N(贷款.额度, 0) + '，日息 ' + N(贷款.日息, 4), '花呗不够才动'),
    it('上次结息', 信贷.上次结息 || '—', '每天结一次，同一天只结一次（重跑不会滚息）'),
    it('最近流水', 记录.slice(-6).map((x) => (x.at || '').slice(5) + ' ' + (x.what || '')).join('；') || '（空）', ''),
    it('记录条数', 记录.length, '资产.记录，只增不删'),
  ], 原始(base + '/资产.json', 6))

  // ── 12 物品 ───────────────────────────────────────────
  const 物 = 取(base + '/物品.json', {}) || {}
  const 件 = Array.isArray(物.items) ? 物.items : []
  const 包 = 件.filter((x) => x && x.在 === '包')
  const 家 = 件.filter((x) => x && x.在 === '家')
  const 杯 = 包.find((x) => x && x.n === '水杯')
  const 杯量 = ((杯 && 杯.容器 && 杯.容器.成分) || []).reduce((n, x) => n + (Number(x.量) || 0), 0)
  g('items', '物品与水杯', '包里的跟着她走，家里的留在家里；借来的要标归还时间。', [
    it('包', 包.length + ' 件', 包.map((x) => x.n + (Number(x.数) > 1 ? '×' + x.数 : '')).join('、') || '空着'),
    it('家', 家.length + ' 件', 家.slice(0, 12).map((x) => x.n).join('、') || '空着'),
    it('水杯', 杯 ? (Math.round(杯量) + ' / ' + (Number(杯.容器 && 杯.容器.容量) || 1000) + ' 毫升') : '没有', 杯 && 杯.容器 && Array.isArray(杯.容器.成分) ? 杯.容器.成分.map((x) => x.物 + ' ' + x.量).join(' + ') : ''),
    it('借的', 件.filter((x) => x && x.借自).length + ' 件', 件.filter((x) => x && x.借自).map((x) => x.n + '（' + x.借自 + '，' + String(x.该还 || '').slice(5) + ' 前还）').join('、') || '没有'),
    it('建表', 物.建 || '—', '物品表第一次建的时间'),
  ], 原始(base + '/物品.json', 8))

  // ── 13 自主行动 ───────────────────────────────────────
  const 自日 = Array.isArray(自.log) ? 自.log : []
  g('self', '自主行动', '她自己决定下一件事做什么；想法类只调权重，不硬拦。', [
    it('现在', 自.state || '—', ''),
    it('从', 好看(自.since), '什么时候开始做这件事'),
    it('下次', 好看(自.nextAt), '下一次抽签的时间'),
    it('表单', 自.form || '—', ''),
    it('今天做过', 自日.filter((x) => String(x.at || '').startsWith(今)).length + ' 次', '看B站 / 逛贴吧 每天各限一轮'),
    it('最近', 自日.slice(-6).map((x) => String(x.at || '').slice(11) + ' ' + (x.state || '')).join('；') || '—', ''),
  ], 原始(base + '/自主.json', 8))

  // ── 14 关系 ───────────────────────────────────────────
  const 好感 = 取(base + '/好感度.json', { people: {} }) || {}
  const 印象 = 取(base + '/印象状态.json', {}) || {}
  const 别 = 取(base + '/别扭.json', { people: {} }) || {}
  const 人们 = Object.keys(好感.people || {})
  g('relation', '关系与好感', '分数只是说话的松紧开关，不是排行榜。', [
    it('人数', 人们.length + ' 人', 人们.map((q) => q + '（' + N((好感.people[q] || {}).score, 1) + '）').join('、') || '—'),
    // SETTABLE_UI 2026-11-12：把主人那两档单独列出来，调试时一眼能看到、也能直接改。
    it('主人分数', N((((好感.people || {})[OWNER] || {}).score), 1), '参与分寸的那一个数；下面是四维'),
it('别扭分', 试(() => { const x = (别.people || {})[OWNER]; return N((x && typeof x === 'object') ? x.level : x, 1) }, '—'), '涨到阈值就不理人'),
    // BATCH298（2026-11-09）：只显示一个数字，主人看不出它是死的（60 卡了四天）。
    // 把「最近一次为什么变」和「参不参与分寸」摊开，变了能看见，没变也知道为什么。
    it('最近一次变化', 试(() => {
      const me = (好感.people || {})[OWNER] || {}
      const x = (me.log || [])[0]
      if (!x) return '还没有记录'
      return String(x.at || '').slice(5) + ' ' + String(x.kind || '') + ' ' + (Number(x.delta) > 0 ? '+' : '') + N(x.delta, 0) + '（' + String(x.why || '没写原因').slice(0, 18) + '）'
    }, '—'), '日结每天 11:50 结一次；「只展示」不影响她怎么跟你说话'),
    it('参与分寸', ((好感.people || {})[OWNER] || {})['只展示'] ? '只展示' : '参与', '批次246 主人定的：能看见它在动，但别让数字决定她怎么说话'),
    it('四个状态', 试(() => {
      const d = ((好感.people || {})[OWNER] || {}).dims || {}
      if (d['亲近'] === undefined) return '（还是 v1 档，等迁移）'
      return '亲近 ' + d['亲近'] + ' · 安全 ' + d['安全'] + ' · 兴致 ' + d['兴致'] + ' · 思念 ' + d['思念']
    }, '—'), '都会回落：兴致 3 天、亲近 21 天、安全 60 天；分数 = 0.5亲近+0.3安全+0.2兴致'),
    it('印象', 试(() => Object.keys(印象).map((q) => q + ' ' + N((印象[q] || {}).turns, 0) + ' 轮').join('、'), '—'), '轮数是「聊过多少回合」'),
it('别扭', 试(() => { const p = 别.people || {}; const k = Object.keys(p); return k.length ? k.map((q) => q + ' ' + N((p[q] || {}).level ?? p[q], 0)).join('、') : '没有' }, '—'), '生气到一定分就不理人'),
  ], 原始(base + '/好感度.json', 8))

  // ── 15 记忆 ───────────────────────────────────────────
  const 链 = 试(() => { const raw = readFileSync(base + '/链.md', 'utf8'); const t = raw.slice(-900); const i = t.indexOf('\n## '); return (i >= 0 ? t.slice(i + 1) : t).trim() }, '（读不到）')
  const 惦记数 = 试(() => {
    const m = new Map()
    for (const l of readFileSync(base + '/惦记.jsonl', 'utf8').trim().split(/\r?\n/).filter(Boolean)) {
      try { const j = JSON.parse(l); if (j && j.what) m.set(String(j.what), j) } catch (_err) { console.error('[面板]', _err?.message || _err) }
    }
    const open = [...m.values()].filter((x) => x.done !== true).length
    return `${open} 条未决（共 ${m.size} 项）`
  }, '0 条')
  const 手账今 = 试(() => readFileSync(base + '/手账-' + 今 + '.md', 'utf8').trim().slice(0, 200), '')
  const 梦名 = 试(() => { const fs = _rd(base).filter((f) => f.startsWith('梦-')); return fs.sort().slice(-1)[0] || '' }, '')
  const 梦文 = 梦名 ? 试(() => readFileSync(base + '/' + 梦名, 'utf8').trim().slice(0, 200), '') : ''
  g('memory', '记忆与记录', '她的「回忆」来自手账和梦；翻旧账只抽心气和梦余味，不碰技术库。', [
    it('手账今天', 手账今 ? '已写' : '还没写', 手账今 ? 手账今.replace(/\s+/g, ' ').slice(0, 90) : '每天 04:00 前后由心跳生成'),
    it('最近梦', 梦名 || '没有', 梦文 ? 梦文.replace(/\s+/g, ' ').slice(0, 80) : ''),
    it('惦记', String(惦记数), '她主动记下的「回头要问的事」'),
    it('链', 链 === '（读不到）' ? '读不到' : (链.split('\n').filter((l) => l.startsWith('## ')).length + ' 条最近条目'), '末尾 900 字的条目数'),
  ], 链)

  // ── 16 调度与外部 ─────────────────────────────────────
  const 探 = (port) => new Promise((res) => {
    let 已答 = false
    const 完 = (ok) => { if (已答) return; 已答 = true; try { s.destroy() } catch { /* 已经关了 */ } res(ok) }
    const s = connect({ host: '127.0.0.1', port })
    s.setTimeout(400)
    s.on('connect', () => 完(true))
    s.on('timeout', () => 完(false))
    s.on('error', () => 完(false))
  })
  const 心表 = 取(tools + '/心跳表.json', {}) || {}
  const 心迹 = 取(base + '/.心跳上次.json', {}) || {}
  const 群行数 = 试(() => readFileSync('{{BOT_ROOT}}/共享/日志/群聊强度.jsonl', 'utf8').trim().split('\n').filter(Boolean).length, 0)
  const 板天 = 试(() => 留言板.天数(), 0)
  const 待条 = 试(() => 待办.列().length, 0)
  const [通7890, 通1080, 通9880, 通网关, 通18089] = await Promise.all([探(7890), 探(1080), 探(9880), HAS_GATEWAY ? 探(GW_PORT) : Promise.resolve(false), 探(18089)])
  g('systems', '调度与外部', '心跳每分钟一次；墙外走 7890，B 站走手机家宽的 1080。', [
    it('心跳任务', (心表.任务 || []).length + ' 条', '加任务改 心跳表.json，别往 crontab 塞（会被外部还原）'),
    it('上次 tick', 好看(心迹.lastStart), '心跳脚本最后一次开跑的时刻'),
    it('距上次 tick', 心迹.lastStart ? (Math.round((Date.now() - Number(心迹.lastStart)) / 60000) + ' 分钟') : '—', '超过 3 分钟没动 = 心跳停了（先看 crontab 有没有被还原）'),
    it('待办', 待条 + ' 条', '面板那张「需要你处理」'),
    it('留言板', (Array.isArray(板天) ? 板天.length : 板天) + ' 天', '有贴过的天数，同一天只算一次'),
    it('群聊强度', 群行数 + ' 行', 'observe 阶段：只记录本来会回哪些，不改回复行为'),
    it('出口 7890', 通7890 ? '通' : '不通', '墙外：pixiv / YouTube / github 主站'),
    it('出口 1080', 通1080 ? '通' : '不通', '手机家宽：B 站；断了抓取回落直连 412'),
    it('接口网关 ' + (HAS_GATEWAY ? GW_PORT : '未接'), 通网关 ? '在线' : '未起', '多模型接口 · Anthropic/OpenAI 协议转换'),
  ], '')

  // ── 16.2 语音与音画 ───────────────────────────────────
  const 音画配 = 取('{{DSH_ROOT}}/fish-omni.json', {}) || {}
  const 说配 = 音画配.说 || {}
  const 听配 = 音画配.听 || {}
  const 看配 = 音画配.看视频 || {}
  const 歌配 = 音画配.一起听 || {}
  const 歌档 = 取(base + '/一起听.json', {}) || {}
  g('voice_av', '语音与音画', '本机 GPT-SoVITS 真人少女声线（9880）、看视频双引擎与网易云一起听实时健康度。', [
    it('本机 GPT-SoVITS', 通9880 ? '在线（127.0.0.1:9880）' : '离线（自动兜底云端）', 'fish-gptsovits.service · tangyuge_v2pp 8情绪切片（她自己的包）'),
    it('当前发声协议', `${说配.协议 || 'gptsovits'} · ${说配.模型 || 'tangyuge-v2ProPlus'}`, `情绪/音色：${说配.音色 || 'auto'}`),
    it('耳朵模型（听）', 听配.模型 || 'qwen3.8-omni-flash', '听语音条、听音乐旋律、看视频多模态主引擎'),
    it('看视频模式', 看配.模式 === 'storyboard' ? 'Storyboard 插件直出' : 'Omni 优先 → 挂了自动切 Storyboard', 'WebUI 用量页可随时切换'),
    it('本机 Whisper ASR', 通18089 ? '热备在线（18089）' : '按需休眠中', 'Storyboard 兜底抽帧时的本地语音转写服务'),
    it('网易云一起听', 歌配.开启 === false ? '已关闭' : (歌档.name ? `开启 · 最近《${歌档.name}》` : '开启 · 待点歌'), 歌档.artist ? `${歌档.artist}｜累计循环 ${歌档.replayCount || 1} 次` : ''),
  ], '')

  // ── 16.5 卫生 ─────────────────────────────────────────
  // CL_DBG 2026-11-12：清洁度、洗澡中、头发湿。原来只在 snapshot 里算给「身体页」，
  // 调试页看不到 —— 她「为什么不肯出门」「为什么在浴室挂两小时」得翻这个。
  const 卫 = 取(base + '/卫生.json', {}) || {}
  const 洗中 = 卫.洗澡中 && typeof 卫.洗澡中 === 'object' ? 卫.洗澡中 : null
  g('clean', '卫生与清洁', '清洁度掉到 40 以下她会想去洗澡；洗澡期间走不开。', [
    it('清洁度', N(卫.清洁) + ' / 100', '每轮掉一点，洗一次回满', 'clean'),
    it('上次洗', 卫.上次洗 || '—', ''),
    it('洗过几次', N(卫.次数, 0) + ' 次', ''),
    it('洗澡中', 洗中 ? ('到 ' + 好看(洗中.结束) + '（在 ' + (洗中.在哪 || '?') + '）') : '没在洗', '洗澡占着人，走不开'),
    it('头发湿到', 卫.头发湿到 || '—', '湿着头发出门会感冒'),
  ], 原始(base + '/卫生.json', 6))

  // ── 16.6 照片 ─────────────────────────────────────────
  // PHOTO_DBG 2026-11-12：成品目录是「本机出图 → 共享盘」的落点，照片墙读它。
  const 成品目录 = '{{BOT_ROOT}}/共享/自拍/成品'
  const 成品们 = 试(() => requireDir(成品目录).filter(是成品图)
    .map((f) => ({ f, t: 试(() => requireStat(成品目录 + '/' + f).mtimeMs, 0) }))
    .filter((x) => x.t > 0).sort((a, b) => b.t - a.t), [])
  const 今照 = 成品们.filter((x) => new Date(x.t + 8 * 3600e3).toISOString().slice(0, 10) === 今)
  g('photo', '照片与自拍', '出图在本机，成品落在共享目录；照片墙读的就是这里。', [
    it('成品总数', 成品们.length + ' 张', '从上线到现在'),
    it('今天', 今照.length + ' 张', ''),
    it('最近一张', 成品们[0] ? (好看(成品们[0].t) + ' · ' + 成品们[0].f) : '没有', ''),
    it('最近 3 张', 成品们.slice(0, 3).map((x) => x.f.replace(/\.png$/, '')).join('、') || '—', ''),
  ], '')

  // ── 16.7 心跳任务 ──────────────────────────────────────
  // HEART_DETAIL 2026-11-12：心跳只记一个 lastStart，不记每个任务跑没跑；
  // 但每个任务都往自己的日志写尾巴 —— 日志 mtime 就是它上次真跑的时刻，骗不了人。
  // 排法：超时的排最前（超过间隔 3 倍、且至少 30 分钟没动静），其余按「多久没跑」倒序。
  // 问「她为什么不动」时先看这一组：某个 tick 没转，后面全跟着停。
  const 日志目录 = base + '/日志'
  // HEART_SRC 2026-11-12（第二版）：判据改成调度层自己记的账（记忆/.心跳任务.json，跑了才写）。
  // 第一版用「日志 mtime」，实测 6 条超时里 5 条是误报 —— 工作/同步QQ状态/自主行动 带 --quiet，
  // 根本没日志可更新。教训跟批次278 一样：判据只能抓它认识的那种写法，quiet 任务全被误伤。
  const 任务账 = 取(base + '/.心跳任务.json', {}) || {}
  const 心们 = (心表.任务 || []).map((t) => {
    const 名 = String(t.名 || t.脚本 || '?')
    const 记账 = Number(任务账[名]) || 0
    const lf = String(t.日志 || '')
    const mt = lf ? 试(() => requireStat(日志目录 + '/' + lf).mtimeMs, 0) : 0
    // 没账就不拿日志 mtime 冒充「上次跑」—— 封面日志停在 3 天前，但它每 5 分钟都在跑，
    // 只是脚本没输出。日志只作线索写在注里，不参与判据（第一版就是栽在这）。
    const 日志分 = mt ? Math.round((Date.now() - mt) / 60000) : -1
    const 分 = 记账 ? Math.round((Date.now() - 记账) / 60000) : -1
    const 隔 = Number(t.间隔分) || 0
    // 阈值：分钟级按 3 倍（最少 20 分）；日/周/月级按「一个周期 + 3 小时」。
    // HEART_THRESHOLD 2026-11-13（批次372c）：日级任务没有 间隔分 字段，原来被 `隔 <= 60`
    // 这条接住算成 20 分钟 —— 12 条一天跑一次的活全被标「超时」，其实都在按点跑
    // （日报「1407 分钟前」正是昨天 21:00 那次）。日级 27 小时、周级 7 天 + 3 小时、月级 30 天 + 3 小时。
    const 周期 = 隔 > 0 ? 0
      : (t.每周 !== undefined && t.每周 !== null ? 7 * 1440
        : (t.每月 !== undefined && t.每月 !== null ? 30 * 1440
          : (t.每天 ? 1440 : 0)))
    const 阈 = 隔 > 0 ? (隔 <= 60 ? Math.max(隔 * 3, 20) : 隔 + 180) : (周期 ? 周期 + 180 : 20)
    // 只有「有账」的才判超时。没账的可能是刚上线、也可能是一天只跑一次的任务，
    // 拿日志 mtime 猜会重演第一版的假警报 —— 宁可显示「没记录」。
    const 超 = 记账 ? (分 > 阈) : false
    // 调度怎么写：间隔分优先；没有就是「每天/每周/每月 + 时:分」那套（批次213 起支持）。
    // 原来统一写「每 ? 分」，一半的任务都是问号 —— 等于没告诉人它该多久跑一次。
    const hh = String(Number(t.时 ?? 0)).padStart(2, '0') + ':' + String(Number(t.分 ?? 0)).padStart(2, '0')
    const 调度 = 隔 ? ('每 ' + 隔 + ' 分')
      : (t.每天 ? ('每天 ' + hh)
      : ((t.每周 !== undefined && t.每周 !== null) ? ('每周' + '日一二三四五六'[Number(t.每周) || 0] + ' ' + hh)
      : ((t.每月 !== undefined && t.每月 !== null) ? ('每月 ' + Number(t.每月) + ' 号 ' + hh) : '?')))
    return { 名, 分, 隔, 调度, 超, 记账: !!记账, 日志分 }
  }).sort((a, b) => (b.超 ? 1 : 0) - (a.超 ? 1 : 0) || (b.记账 ? 1 : 0) - (a.记账 ? 1 : 0) || b.分 - a.分)
  const 超们 = 心们.filter((x) => x.超)
  const 心行 = [
    it('任务数', 心们.length + ' 条', '加任务改 心跳表.json，别塞 crontab'),
    it('上次 tick', 好看(心迹.lastStart), ''),
    it('距上次 tick', 心迹.lastStart ? (Math.round((Date.now() - Number(心迹.lastStart)) / 60000) + ' 分钟') : '—', '超过 3 分钟没动 = 心跳停了'),
    it('超时的', 超们.length ? (超们.length + ' 条') : '没有', 超们.slice(0, 10).map((x) => x.名).join('、') || '全部按时在跑'),
  ].concat(心们.slice(0, 28).map((x) => it(
    x.名,
    (x.分 < 0 ? '没记录' : ('上次 ' + x.分 + ' 分钟前')) + ' · ' + x.调度,
    x.超 ? '⚠ 超时了'
      : (x.记账 ? '' : ('没有调度记录' + (x.日志分 >= 0 ? '；日志 ' + x.日志分 + ' 分钟前写过' : '；它没有日志')))
  )))
  g('heart', '心跳任务', '时刻来自 .心跳任务.json（跑了才写，2026-11-12 起）；超时的排最前面。', 心行, '')

  // ── 16.8 记忆召回 ─────────────────────────────────────
  // RECALL_DBG 2026-11-12：海马体每轮拿她这句话去撞记忆库，cue 必须是他真实说的话。
  // cue 里带「（关于他：…）[HH:MM]」这类注入前缀 = 预激活失明，只有 diag 能看出来。
  const 海马diag = 试(() => {
    const raw = readFileSync('{{DSH_ROOT}}/hippocampus/diag.log', 'utf8').trim().split('\n')
    return raw.slice(-4).join('\n')
  }, '（读不到 {{DSH_ROOT}}/hippocampus/diag.log）')
  g('recall', '记忆召回（海马体）', '每轮开口前先拿他这句话撞记忆库；cue 带注入前缀就是失明了。', [
    it('diag 行数', 试(() => readFileSync('{{DSH_ROOT}}/hippocampus/diag.log', 'utf8').trim().split('\n').length + ' 行', '—'), '只留最近一段'),
    it('最近一行', 试(() => readFileSync('{{DSH_ROOT}}/hippocampus/diag.log', 'utf8').trim().split('\n').slice(-1)[0] || '—', '—'), ''),
  ], 海马diag)

  // ── 16.9 群聊与投递 ───────────────────────────────────
  // CHATTER 2026-11-12：群聊强度是 observe 阶段（只记录本来会回哪些）；群聊日志每 5 分钟落一次。
  const 群强 = 试(() => readFileSync('{{BOT_ROOT}}/共享/日志/群聊强度.jsonl', 'utf8').trim().split('\n').filter(Boolean), [])
  const 群强今 = 群强.filter((l) => l.includes(今)).length
  const 群日志数 = (gid) => 试(() => readFileSync('{{BOT_ROOT}}/群聊日志/' + gid + '-' + 今 + '.jsonl', 'utf8').trim().split('\n').filter(Boolean).length, 0)
  g('chatter', '群聊与投递', '群聊强度只记录不拦；群聊日志每 5 分钟落一次，行数就是今天说了多少。', [
    it('群聊强度', 群强.length + ' 行', '累计；今天 ' + 群强今 + ' 行'),
    it('冰屋群今天', 群日志数('2000000001') + ' 条', '5 人群'),
    it('主群今天', 群日志数('1051483012') + ' 条', ''),
  ], '')

  // ── 16.10 计划与念头 ──────────────────────────────────
  // PLAN_DBG 2026-11-12：计划是早上给自己定的小目标（连跑 6 天 0 完成过）；
  // 念头是自主行动前的碎碎念，只调权重不硬拦。
  const 计划档 = 取(base + '/计划.json', {}) || {}
  const 今日计划 = 试(() => (计划档.days || {})[今] || null, null)
  const 想档 = 取(base + '/想要.json', {}) || {}
  const 念头们 = 试(() => readFileSync(base + '/念头.jsonl', 'utf8').trim().split(/\r?\n/).slice(-4)
    .map((l) => {
      try {
        const j = JSON.parse(l)
        const 词 = [j.想到 || j.念 || j.什么 || j.what || '', j.建议 ? ('(' + j.建议 + ')') : ''].filter(Boolean).join('')
        return (String(j.at || '').slice(11) + ' ' + 词).trim().slice(0, 36)
      } catch { return '' }
    })
    .filter(Boolean).join('；'), '')
  g('plan', '计划与念头', '计划只影响权重，不硬拦；定完没完成会挂在「今天完成」里。', [
    it('今天的目标', 今日计划 ? ((今日计划.goals || []).map((x) => x.id).join('、') || '没定') : '没定', 今日计划 ? ('定于 ' + (今日计划.madeAt || '')) : ''),
    it('今天完成', 今日计划 ? ((今日计划.done || []).length + ' 个') : '—', ''),
    it('当下想要', ((想档['当下想要'] || [])).map((x) => x.what).join('；') || '没有', '欲望是主动开口的燃料'),
    // TOPIC 2026-11-12：她自己记下、还没说出口的事（qq_later 的「想聊」）。
    // 主动开口时会被当成材料递给她 —— 这里只是让主人看得见她在惦记什么。
    it('想聊的', 试(() => {
      const j = 取(base + '/想聊.json', {}) || {}
      const 未 = (Array.isArray(j.items) ? j.items : []).filter((x) => x && !x.done)
      if (!未.length) return '没有'
      return 未.length + ' 条：' + 未.map((x) => String(x.what || '').slice(0, 18)).join('；')
    }, '没有'), '她自己记下、还没说出口的；主动开口时会想起来'),
    it('最近念头', 念头们 || '没有', ''),
  ], 原始(base + '/计划.json', 5))

  // ── 16.11 天气 ────────────────────────────────────────
  const 天档 = 取(base + '/天气.json', {}) || {}
  g('weather', '天气', '她看到的天气；体温、穿衣、出门都读它。', [
    it('温度', N(天档.温度) + ' ℃', ''),
    it('天气', String(天档.天气 || '—'), ''),
    it('更新', 好看(天档.at || 天档.更新 || 天档.更新At), ''),
  ], 原始(base + '/天气.json', 8))

  // ── 16.12 学习与冲浪 ──────────────────────────────────
  // MEDIA 2026-11-12：B站/贴吧学来的进 学习笔记，刷群存最近一批群友原话。
  const 学笔 = 试(() => readFileSync(base + '/学习笔记.md', 'utf8').trim(), '')
  const 刷档 = 取(base + '/刷到的.json', {}) || {}
  const 刷条 = Array.isArray(刷档.条目) ? 刷档.条目 : []
  const 表情库 = 取(base + '/表情编号库.json', {}) || {}
  g('media', '学习与冲浪', '她聊天时的活水话题从这里来；学习笔记是长期沉淀。', [
    it('学习笔记', 学笔 ? (学笔.split('\n').length + ' 行') : '还没有', 学笔 ? 学笔.replace(/\s+/g, ' ').slice(0, 110) : ''),
    it('刷到的', 刷条.length + ' 条', '看于 ' + String(刷档.看于 || '—')),
    it('刷到的最近', 试(() => JSON.stringify(刷条.slice(-2)).slice(0, 160), '—'), '群友原话，去掉图片占位符'),
    it('表情库', Object.keys(表情库).length + ' 个', '斗图时的收藏候选'),
  ], '')

  // ── 16.13 刷手机（批次392）────────────────────────────
  // 主人原话「完全可以把她看b站和贴吧设置频繁点，我每天都要刷一百多条视频呢，闲着的时候」。
  // 这一屏给三个能看见的数：上次刷是什么时候、今天划过去多少条、池子里积了多少。
  // 「刷」和「看」是两件事：刷 = 只划标题（0 成本，一天几十次）；看 = 点开一条（学习轮，一天 3 次）。
  const 刷档2 = 取(base + '/刷手机.json', {}) || {}
  const 刷最近2 = Array.isArray(刷档2.最近) ? 刷档2.最近 : []
  const 刷今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  g('browse', '刷手机', '刷 = 只划标题，不花 token；看 = 点开一条认真看，一天几次。旁边那组阈值能直接改。', [
    it('上次刷', 刷档2.at ? 好看(刷档2.at) : '还没刷过', String(刷档2.平台 || '')),
    it('今天', 刷档2.今天 === 刷今天
      ? ((Number(刷档2.次数) || 0) + ' 次 · ' + (Number(刷档2.今日条数) || 0) + ' 条')
      : '0 次', ''),
    it('刚划到', 刷最近2.slice(0, 3).map((x) => String((x && x.标题) || '').slice(0, 24)).join(' / ') || '—', ''),
    it('池子', 试(() => readFileSync(base + '/刷过.jsonl', 'utf8').trim().split('\n').filter(Boolean).length + ' 条', '0'),
      '刷过但没点开的；学习轮从这里挑'),
  ], 原始(base + '/刷手机.json', 6))

  // ── 16.14 工具用量（批次396）──────────────────────────────
  // USE396 2026-11-14：账本 记忆/工具调用.jsonl 只覆盖「插件自己注册之后、走同一个 tools 服务」的工具。
  // 实测：会话流里 56 种工具，账本只记 26 种，漏掉 memory_update 533 次 / memory_remember 449 /
  // memory_judge 435 / web_search 20 / read_animation 7 / search_meme_wiki 18 ——
  // 拿它判「零调用」会把正常在用的工具报成死的（批次395 就这么误判了一整批）。
  // 所以这一屏读的是 工具用量.mjs 从宿主 stream.jsonl 派生的 记忆/工具用量.json（一行不落）。
  const 用工 = 取(base + '/工具用量.json', {}) || {}
  const 用工排 = Object.entries(用工.按工具 || {})
  const 零调 = Array.isArray(用工.零调用) ? 用工.零调用 : []
  g('usage', '工具用量', '她这几天真正调过哪些工具。「零调用」只算下发给她的（没下发的不算问题）。每小时重算一次。', [
    it('窗口', (Number(用工.窗口天) || 0) + ' 天',
      String(用工.窗口起 || '') + ' ~ ' + String(用工.窗口止 || '')),
    it('总调用', 用工.工具行数 != null
      ? (Number(用工.工具行数) + ' 次 / ' + 用工排.length + ' 种')
      : '还没统计', '生成于 ' + String(用工.生成于 || '—')),
    it('用得最多', 用工排.slice(0, 5).map(([k, v]) => k + ' × ' + v.次).join('；') || '—', ''),
    it('零调用', 零调.length ? 零调.join(' ') : '没有（下发的都在用）', '下发了但窗口内一次没调'),
    it('数据源', (Array.isArray(用工.数据源) ? 用工.数据源.length : 0) + ' 个会话流',
      (Array.isArray(用工.数据源) ? 用工.数据源.map((x) => String(x.会话 || '').slice(0, 12)).join(' ') : '')),
  ], 原始(base + '/工具用量.json', 5))

  // ── 16.15 贴表情（批次397）────────────────────────────
  // 主人问过「她是不是老贴表情」。以前只有 参数.json 里一个 0/6 的数字，看不见她实际贴了几次。
  // 这里给两个事实：最近一小时几次、上限是多少（0 = 不限）。上限本身在下面那组滑块里能改。
  const 表情流 = 试(() => readFileSync(base + '/表情回应.jsonl', 'utf8').trim().split('\n').filter(Boolean), [])
  const 表情近时 = 试(() => {
    const 切 = Date.now() - 3600e3
    return 表情流.reduce((n, l) => {
      try { const x = JSON.parse(l); return (Number(x.at) || 0) >= 切 ? n + 1 : n } catch { return n }
    }, 0)
  }, 0)
  const 表情上限 = 试(() => Number((取(base + '/../共享/工具/参数.json', {})['拟人'] || {})['贴表情_每小时上限']) || 0, 0)
  g('react', '贴表情', '她主动贴表情的次数与上限。0 = 不限。下面那组滑块能直接改上限。', [
    it('近一小时', 表情近时 + ' 次', 表情上限 > 0 ? ('上限 ' + 表情上限 + ' 次/时' + (表情近时 >= 表情上限 ? '（已到顶）' : '')) : '不限'),
    it('累计', 表情流.length + ' 次', '记在 记忆/表情回应.jsonl'),
    it('每小时上限', 表情上限 > 0 ? (表情上限 + ' 次') : '不限（0）', '改完她下一次贴表情就按新值判'),
  ], 原始(base + '/表情回应.jsonl', 4))

  // ── 17 参数 ───────────────────────────────────────────
  // SETTABLE_LIST 2026-11-12：把「能改哪几项、现在多少」算出来给前端。
  // 现值一律重读一次文件：这一屏可能是几十秒前抓的，别拿旧值糊人。
  const 状态源 = 取(base + '/状态.json', {}) || {}
  const 覆盖源 = 调试覆盖表(状态源)
  const 源缓存 = new Map()
  const 调源 = (x) => {
    const p = x.文件 ? base + '/' + x.文件 : base + '/状态.json'
    if (!源缓存.has(p)) 源缓存.set(p, 取(p, {}) || {})
    return 源缓存.get(p)
  }
  const 调现值 = (x) => {
    try {
      const v = Number(x.读(调源(x)))
      return Number.isFinite(v) ? Math.round(v * 1000) / 1000 : 0
    } catch { return 0 }
  }
  const 调更新 = (x) => {
    if (!x.文件) return String(状态源['更新时间'] || '')
    try { return 京分(_st(base + '/' + x.文件).mtimeMs) } catch { return '' }
  }
  const 调项清单 = () => 可调项.map((x) => {
    const 覆 = 覆盖源[x.id] || {}
    return {
      id: x.id, 名: x.名, 区: x.区 || 'body', 组: x.组, 单位: x.单位, 小: x.小, 大: x.大, 步: x.步, 值: 调现值(x),
      说明: x.说明 || '', 危险: !!x.危险, 更新: 调更新(x),
      覆盖于: String(覆['at'] || ''), 覆盖至: String(覆['到'] || ''),
    }
  })

  // ── 0 人格与设定（批次390）：这几份不是"数值"，是"她是谁"。──
  g('soul', '人格与设定', '这几份改的是她是谁 —— 改完要重启 dsh-bot 才生效（2026-11-14 实测：不重启的话注进去的一直是旧长度，不是每轮重读）。调试页顶部那排按钮能直接改，紧挨着还有一颗「重启宿主」。', [
    ...Object.entries(文档白名单).map(([k, v]) => {
      const st = 试(() => _st(v.路), null)
      return it(v.名, st ? (Math.round(st.size / 102.4) / 10) + ' KB' : '（读不到）',
        st ? ('改于 ' + new Date(st.mtimeMs + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')) : '')
    }),
  ], 试(() => readFileSync(文档白名单.SOUL.路, 'utf8').slice(0, 1500), ''))

  g('config', '参数与开关', '拟人阈值都从 参数.json 读，读不到用代码里的默认值。', [
    it('参数.json', 试(() => Object.keys(取(tools + '/参数.json', {}) || {}).length + ' 个顶层段', '—'), ''),
    it('功能开关', 试(() => JSON.stringify(取(base + '/功能开关.json', {}) || {}).slice(0, 160), '—'), ''),
    it('人味', 试(() => JSON.stringify(取(base + '/人味.json', {}) || {}).slice(0, 120), '—'), ''),
  ], 原始(tools + '/参数.json', 14))

  // ── 18 数据文件体检 ───────────────────────────────────
  const 档们 = 试(() => _rd(base)
    .filter((f) => /\.(json|jsonl|md)$/.test(f))
    .map((f) => {
      const s2 = _st(base + '/' + f)
      return { f, kb: Math.round(s2.size / 102.4) / 10, at: new Date(s2.mtimeMs + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ') }
    })
    .sort((x, y) => String(y.at).localeCompare(String(x.at))), [])
  g('raw', '数据文件体检', '按最后修改时间倒序：哪个停更，对应的任务就是没跑。', 
    档们.slice(0, 28).map((x) => it(x.f, (x.kb < 0.1 ? '<0.1' : x.kb) + ' KB', '最后写于 ' + x.at)), '')

  // SETTABLE_UI 2026-11-12：把「能改哪些值、现在是多少」一起下发，前端不再写死范围。
  return {
    ok: true, at: 现刻(), groups, 调项: 调项清单(), 调试分区,
    调试说明: '保存后由面板守住两小时；状态推进、困意或睡眠心跳把它改回时，会自动再盖成你填的值。',
  }
}

// BJ_PARSE 2026-11-05：睡眠段的 start 带秒（01:00:01），end 不带（07:00）。
// 原来统一拼 ':00+08:00'，带秒那条变成 'T01:00:01:00+08:00' —— 非法日期，
// Date.parse 返回 NaN，整段被过滤掉。于是今天明明睡了 6 小时，面板显示「还没睡过」。
const 解析时刻 = (v) => {
  const s = String(v || '').trim()
  if (s === '') return NaN
  const n = s.replace(' ', 'T')
  return Date.parse((/T\d{2}:\d{2}:\d{2}$/.test(n) ? n : n + ':00') + '+08:00')
}

function snapshot(role) {
  const st = load(base + '/状态.json', {})
  const aut = load(base + '/自主.json', {})
  const aff = load(base + '/好感度.json', { people: {} })
  // SULK_FIELD 批次171：前端 pickState 判「别扭着」读的是 s.sulk，而面板从来没下发过它 ——
  // 别扭.json 甚至没被这个文件读过。她别扭到 60 分，立绘还是那副「发呆」脸。
  const 别扭档 = load(base + '/别扭.json', { people: {} })
  const sleep = load(base + '/睡眠.json', { segments: [] })
  const flag = load(base + '/睡醒.json', {})
  const a = load(base + '/资产.json', { 钱: 0, 包: [], 家: [] })
  const bj = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  // SLEEP_WINDOW 2026-11-04：睡眠段改成「和今天有交叠就算」，跨零点的觉不再被丢掉
  const dayStart = Date.parse(bj + 'T00:00:00+08:00')
  const dayEnd = dayStart + 86400e3
  const 段时长 = (s) => {
    const st = 解析时刻(s.start)
    const en = s.end ? 解析时刻(s.end) : Date.now()
    if (!Number.isFinite(st) || !Number.isFinite(en)) return 0
    const a = Math.max(st, dayStart)
    const b = Math.min(en, dayEnd)
    return b > a ? (b - a) / 3600e3 : 0
  }
  // SLEEP_DEDUP 2026-11-05：睡眠.json 里同一次觉存了两条 —— 一条只有起止（汇总），
  // 一条带 phases（明细），start/end 差一秒。不去重的话 6 小时会被算成 12 小时。
  // 同一个起止只留 phases 多的那条（明细更可信）。
  const 去重段 = (() => {
    const m = new Map()
    for (const s of (sleep.segments || [])) {
      const key = String(s.start || '').slice(0, 16) + '|' + String(s.end || '').slice(0, 16)
      const prev = m.get(key)
      if (!prev || ((s.phases || []).length > (prev.phases || []).length)) m.set(key, s)
    }
    return [...m.values()]
  })()
  const today = 去重段.filter((s) => {
    const st = 解析时刻(s.start)
    const en = s.end ? 解析时刻(s.end) : Date.now()
    return Number.isFinite(st) && Number.isFinite(en) && en > dayStart && st < dayEnd
  })
  const total = Math.round(today.reduce((x, s) => x + 段时长(s), 0) * 10) / 10
  const home = a.家 || []
  // HOME_NORMALIZE 2026-11-03：家里的摆件可能是「名字字符串」，也可能是 3D 摆放写进来的
  // 对象 {n:'台灯',x,y,z,rot}。取名字统一走这里，否则舒适度会按 undefined 算成 0。
  const 家具名 = (x) => (typeof x === 'string' ? x : (x && typeof x === 'object' ? String(x.n || '') : ''))
  const comfort = home.reduce((s, x) => s + Number(COMFORT[家具名(x)] || 0), 0)
  const sleeping = 睡着(base)   // 批次164：判据在 睡态.mjs
  const mi = Number(st?.mood?.intensity ?? 0)
  // WASH_VIEW 2026-11-05（批次89）：清洁度、上次洗澡、在不在洗、头发干没干。
  // 之前这块只有 卫生.json 自己知道 —— 面板上没有、她自己也不看。
  const __hy = (() => {
    try {
      const h = JSON.parse(readFileSync(base + '/卫生.json', 'utf8'))
      const 清 = h.清洁 == null || !Number.isFinite(Number(h.清洁)) ? null : Math.round(Number(h.清洁))
      const 洗 = h.洗澡中 && typeof h.洗澡中 === 'object' ? h.洗澡中 : null
      const 解 = (s) => {
        const t = Date.parse(String(s || '').replace(' ', 'T') + ':00+08:00')
        return Number.isFinite(t) ? t : 0
      }
      const 结束 = 洗 ? 解(洗.结束) : 0
      const 在洗 = !!(结束 && 结束 > Date.now())
      const 湿 = 解(h.头发湿到) > Date.now()
      const 上次At = 解(h.上次洗)
      const 上次分 = 上次At ? Math.max(0, Math.round((Date.now() - 上次At) / 60e3)) : null
      return {
        owner: {
          clean: 清,
          value: 清 == null ? '—' : '清洁 ' + 清 + ' / 100',
          ago: 多久话(上次分),
          lastAt: h.上次洗 || '',
          times: Number(h.次数 || 0),
          washing: 在洗 ? { remainMin: Math.max(0, Math.ceil((结束 - Date.now()) / 60e3)), to: 洗.到 ?? null, place: 洗.在哪 || '' } : null,
          hairWet: 湿,
        },
        // 客人只配知道一句人话：在洗澡 / 刚洗完 / 有点黏。
        say: 在洗 ? '在洗澡' : 湿 ? '刚洗完澡' : 清洁话(清),
      }
    } catch { return { owner: null, say: '' } }
  })()

  // PHOTO_TODAY 2026-11-05（批次91）：她「今天拍的照片」，不再是只有最新一张。
  // 主人要的是能左右翻 —— 一天里她可能在便利店拍一张、在电影院拍一张。
  // 时间正序（左早右晚），前端默认停最新那张；客人只拿图和时间，角度/场景不下发。
  const __photos = (() => {
    try {
      const dir = '{{BOT_ROOT}}/共享/自拍/成品'
      const fs2 = { readdirSync: (d) => requireDir(d), statSync: (f) => requireStat(f), readFileSync: (f) => _rf(f, 'utf8') }
      const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
      const 角度名 = { eye: '平视', high: '俯拍', low: '仰拍', close: '贴脸' }
      return fs2.readdirSync(dir)
        .filter(是成品图)
        .map((f) => ({ f, t: fs2.statSync(dir + '/' + f).mtimeMs }))
        .filter((x) => new Date(x.t + 8 * 3600e3).toISOString().slice(0, 10) === 今天)
        .sort((a, b) => a.t - b.t)
        .map(({ f, t }) => {
          const id = f.replace(/\.png$/, '')
          let 说明 = null
          try {
            const meta = JSON.parse(fs2.readFileSync(dir + '/' + id + '.json', 'utf8'))
            说明 = [角度名[meta.角度] || meta.角度, meta.场景].filter(Boolean).join(' · ')
          } catch { /* 没有元信息就不显示 */ }
          const 基础 = { id, at: new Date(t + 8 * 3600e3).toISOString().slice(11, 16) }
          return role === 'owner' ? { ...基础, 说明 } : 基础
        })
    } catch { return [] }
  })()

  // STATUS_WORD 2026-11-05（批次94）：她这会儿该被描述成什么，一次算清、两处共用。
  //
  // 批次86 给主人那份加了 doneAt 判断，客人的 say.activity 一直还在直读 aut.state ——
  // 于是同一时刻主人看到「闲着」，客人看到「走动」。走动是她 21:49 那一轮的动作，
  // 21:49 就到地方了（doneAt 就是那一秒），可 state 要挂到 22:51 才换。
  // 客人面板上那行就是「走动 · 能做买、借伞、热饭、坐」，跟「人在便利店」自相矛盾。
  const 状态词 = (() => {
    const 完 = Number(aut.doneAt || 0)
    if (完 > 0 && Date.now() - 完 > 3 * 60e3) return '闲着'
    return aut.state || '待命'
  })()

  // RECENT_LIFE 2026-11-05（批次84）：她最近干了什么。
  //
  // 老版把两套记录硬拼，读出来像「买了三次但什么也没买」：
  //   18:30 （没感觉）超市 · 买 / 18:00 便利店 · 买 / 17:30 买了粥和咸菜（12 块）
  // 「买」是 活动.mjs 每 30 分钟记的「人在买类地方待着」，不是买了东西；
  // 买了什么、花了多少只在 资产.记录 里。所以这里分工：
  //   · 资产记录 = 真事，全列（走路、买卖、给钱，自带金额）
  //   · 台账 = 只补「在哪儿待过」，且相邻同地点同类别合并成一段，
  //     这一段里已经有真事就不再说一遍（同一件事出现两次最误导）
  // 另外「（没感觉）」不再显示 —— 那是系统掂量这次有没有效果，不是她做了什么。
  //
  // DAY_SLIDER 2026-11-05（批次94）：主人要「一整天用滑条看」。所以这里只管算一份
  // 流水（倒序、全部），条数和裁剪交给下面 recent / day 两个字段。
  // 别把同一套合并规则抄第二遍 —— 抄了以后改一处、另一处还是旧的，面板就开始自相矛盾。
  const 流水 = (() => {
    const 分钟 = (t) => {
      const m = String(t).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/)
      return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) / 60000 : NaN
    }
    const hhmm = (t) => String(t).slice(11, 16)

    const 真事 = []
    try {
      for (const x of (a.记录 || [])) {
        if (x && x.at && x.what) 真事.push({ at: String(x.at), what: String(x.what) })
      }
    } catch (e) { /* 忽略 */ }

    const 段们 = []
    try {
      const lg = (JSON.parse(readFileSync(base + '/活动台账.json', 'utf8')).log || [])
        .filter((x) => x && x.at)
        .sort((p, q) => String(p.at).localeCompare(String(q.at)))
      let 段 = null
      for (const x of lg) {
        const 地 = String(x.地点 || ''), 类 = String(x.kind || ''), 时 = String(x.at)
        // 35 分钟以内、同地点同类别才算「一直待着」。跨午夜的 23:30→00:00
        // 差值会算成 30 分钟，但日期不同，靠 分钟() 的真差值自然分开。
        if (段 && 段.地 === 地 && 段.类 === 类 && (分钟(时) - 分钟(段.到)) <= 35) {
          段.到 = 时
          continue
        }
        段 = { 起: 时, 到: 时, 地, 类 }
        段们.push(段)
      }
    } catch (e) { /* 没台账就算了 */ }

    const 待过 = 段们
      .filter((d) => !真事.some((r) => r.at >= d.起 && r.at <= d.到))
      .map((d) => {
        const 在哪 = d.地 === '家' ? '在家待着' : '在' + d.地
        // 面板左列已经在显示时间（11-05 18:30），文案里别再写一遍。
        // 只有一条 tick 就是「这会儿在这儿」；多条才算待了一段，说清待到几点。
        return { at: d.起, what: hhmm(d.起) === hhmm(d.到) ? 在哪 : 在哪 + '待到 ' + hhmm(d.到) }
      })

    return 真事.concat(待过).sort((p, q) => String(q.at).localeCompare(String(p.at)))
  })()

  // RECENT_GUEST 2026-11-05（批次92）：客人那份要抹掉钱。
  // 判据只有两条，都能对着文本说出来，不去猜她这笔是不是「私人」的：
  //   ① 以「主人给了 / 借给 / 还了」开头 —— 那是主人和她的账，两条就露底了
  //   ② 其它条目去掉金额（括号里的「（12 块）」，和露在外面的「押金 10 块」）
  // 返回 '' 表示整条不要。
  //
  // 写成函数声明而不是箭头常量，是为了测试能原样抠出去跑（`function 名(...)` 到配对括号）。
  function 给客人看(t) {
    let s = String(t)
    if (/^主人(给了|借给|还了|收回)/.test(s)) return ''
    s = s.replace(/\s*[（(]\s*\d+\s*块[^）)]*[）)]/g, '')
    s = s.replace(/\s*\d+\s*块/g, '')
    return s.replace(/\s{2,}/g, ' ').trim()
  }
  // 按上面的判据过一遍，数够 上限 条就停 —— 滤掉的占不了名额。
  function 裁给客人(列, 上限) {
    const 条 = []
    for (const x of 列) {
      const what = 给客人看(x.what)
      if (!what) continue
      条.push({ at: x.at, what })
      if (条.length >= 上限) break
    }
    return 条
  }

  // STOCK 2026-11-07（批次150）：物品.json 是唯一真相（资产.包 只是镜像）。
  // 一次读出来，按「在」分两堆：包里给客人和主人，家里只给主人。
  const __物 = (() => {
    try {
      const d = JSON.parse(readFileSync(base + '/物品.json', 'utf8'))
      const list = Array.isArray(d.items) ? d.items : []
      return list.map((x) => ({
        n: String(x.n || ''),
        在: String(x.在 || ''),
        类: String(x.类 || ''),
        数: Math.max(1, Number(x.数) || 1),
        // 来：买 / 借 / 接（水杯接的一杯水）。面板要分得清哪瓶是买的、哪杯是接的。
        来: String(x.来 || ''),
        借自: x.来 === '借' ? String(x.自 || '') : '',
        该还: x.来 === '借' ? String(x.该还 || '') : '',
        // 容器 2026-11-08（批次223）：水杯要报「装了多少/容量」，面板才看得出 0/1000 还是 700/1000。
        容器: x.容器 || null,
      })).filter((x) => x.n)
    } catch { return [] }
  })()
  // HUNGER 2026-11-06（批次139）原本算在主人那段里，批次150 挪到 pub 之前 ——
  // 客人现在也要看「几分饱」，不能等到 return 之后才算。
  // 渴饿 2026-11-07（主人要的面板跟进）：两条都按毫升/千卡报，同时给百分比和档名，
  // 前面那层「几分饱」还留着，老的展示不至于突然没数。
  // 人物页要的两样：身上这套的保暖，和现在的体温
  // WIND 2026-11-07（批次162）：面板的保暖要跟体温用同一套 湿/风。
  // 原来这里写死 {湿:0, 风:0}：页面写着不刮风的保暖，体温那边按刮风算，两个数打架。
  // 室内/露天那份判断只在 体温.区域温度 里有一份，这里直接问它，不再抄一遍。
  const __环 = (() => { try { return 体温.区域温度() } catch { return null } })()
  const __湿 = __环 && __环.雨 ? 0.6 : 0
  const __风 = __环 ? __环.风折 : 0
  // SNAPSHOT 2026-11-07（批次163）：算 和 九区 是同一次计算的两个视图，
  // 原来这里连着调两遍（表读两遍、穿着读两遍），现在一次 快照 两个名字都指它。
  const __身 = (() => { try { return 穿衣.快照({ 湿: __湿, 风: __风 }) } catch { return null } })()
  const __温九区 = (() => { try { return 体温.分区() } catch { return null } })()
  const __穿 = __身
  const __九区 = __身
  const __体温 = (() => { try { return 体温.读() } catch { return null } })()
  const __病 = (() => { try { return 疾病.读() } catch { return null } })()
  const __肚 = (() => {
    try {
      const h = 读饥饿()
      const 渴词 = h.渴话 || ""
      return {
        v: Math.round(h.饱腹), 词: 饥饿标签(h.饱腹),
        渴: Math.round(h.水), 渴百分比: Math.round(Number(h.水百分比) || 0), 渴词,
        // 2026-11-08（批次223）：饱腹感 = 胃 + 血糖（主人指的那个数），不是胃里还剩多少。
        饱腹感: Math.round(Number(h.饱腹感) || 0),
        胃百分比: Math.round(Number(h.临时) || 0),
        血糖: h.血糖 ?? null,
        饿: Math.round(Number(h.卡) || 0), 饿百分比: Math.round(Number(h.食物) || 0),
        今日顿: Number(h.今天?.顿 || 0), 今日零食: Number(h.今天?.零食 || 0), 最后吃了: String(h.最后吃了 || ''),
      }
    } catch { return null }
  })()

  const pub = {
    time: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
    role,
    sleeping,
    // DONE_STATE 2026-11-05（批次86）：一次性动作做完了就报「闲着」，别再报动作名。
    // 拍张照、逛贴吧这些几十秒就干完的活儿，`state` 标签却要挂到下一轮（80~220 分钟）才换 ——
    // 面板原来只看 state，于是从 15:57 到 18:15 一直显示「拍张照 · 便利店（已经 80 分钟）」，
    // 主人看到的就是「动作卡在拍照上了」。其实 15:57 那一下就完事了。
    // `poll.js` 早就用 `doneAt` 区分「做完了 / 正在做」，面板这边一直漏着。
    // 不用再抄一份动作名单：`doneAt` 只在一次性动作那轮才写成非 0，
    // 「发呆/摸鱼」那轮会被重设成 0。
    // 怎么算的见上面 STATUS_WORD —— 客人那份（say.activity）现在也读这一个。
    activity: 状态词,
    // SLEEPY_FIELD 批次171：前端 pickState 读 s.sleepy 决定画不画「犯困」，
    // 而 状态推进 写的是 状态.json 的「困意」—— 字段名对不上，这个立绘从上线起就没亮过。
    // 加在 pub 而不是主人段：客人到 849 行就 return pub 了，拿不到主人段；
    // 而「困不困」跟 energy 一样是身体状态，不是行踪细节。
    sleepy: st['困意'] == null ? null : Math.round(Number(st['困意'])),
    // SULK_FIELD 批次171：别扭值（别扭.mjs 的 people[谁].level，0~100，>=60 才画「别扭着脸」）
    sulk: Number(((别扭档.people || {})[OWNER] || {}).level || 0),
    // MOOD_FIELD 批次171：前端 pickState 读 s.mood.label 判「有点闷 / 心情不错」，
    // 而 pub 里只有 say.mood 那一句**文字**，顶层没有 mood —— 这两个立绘也是死的。
    // 主人段 return {...pub, mood:{label,intensity}} 会覆盖，形状一致，不用担心。
    mood: { label: 心情话(mi, sleeping), intensity: mi },
    // ACTIVITY_SINCE 2026-11-05（批次85）：这个数字原来只按 自主.json 的 since 算，
    // 于是「发呆 · 街市（已经 59 分钟）」—— 可她到街市才 11 分钟，那 48 分钟是在超市的。
    // 走路不改 state，换地方时 since 不动，旧地点的时间就被算进了新地点。
    // 取「状态开始」和「到这个地方」里较晚的那个：两个都对，数才准。
    //
    // 闲着的时候直接给 0：那是「做完之后闲到现在」的时间，不是在做这件事的时间。
    // 前端见 0 就不显示括号；她刚做完什么，「她最近在做什么」那一行会写。
    activityMinutes: (() => {
      const 完 = Number(aut.doneAt || 0)
      if (完 > 0 && Date.now() - 完 > 3 * 60e3) return 0
      const 起 = Math.max(Number(aut.since || 0), 到达时刻(a))
      return 起 > 0 ? Math.round((Date.now() - 起) / 60e3) : 0
    })(),
    // SLEEP_HOURS 2026-11-05：主人视图的「睡眠」卡一直在读 s.sleepHours，
    // 但快照里根本没这个字段 —— 副标题永远是空的。这里补上。
    sleepHours: total,
    place: a.位置 || '家',
    // PLACE_FN 2026-11-05（批次79）：她所在的这个地方，此刻开着没、能做些什么。
    // 面板原来只有地点名 —— 「图书馆周一闭馆」「两点只有便利店开着」这些都看不见。
    ...(() => {
      try {
        const r = 营业中79(a.位置 || '家', 读地点79(base))
        const mm = 读图()
        const q = (mm.地点 || {})[a.位置 || '家'] || {}
        // PLACE_WHAT_DROP 2026-11-05（批次100）：`placeWhat` 不再下发。
        // 批次96 只在前端把「能做买、借伞、热饭、坐」藏起来了，JSON 里还留着 ——
        // 主人要的是「客人看不到」，那就该真的不下发，而不是前端藏。
        // 前端现在没有任何地方读它（grep 过），删掉不影响主人视图。
        return { placeOpen: r.ok, placeWhy: r.因 || '', placeIn: !!q.室内 }
      } catch {
        return { placeOpen: true, placeWhy: '', placeIn: false }
      }
    })(),
    // WASH_VIEW 2026-11-05（批次89）：主人看数字和时长；客人只拿 say.wash 那一句，
    // 具体清洁度不进 JSON（跟 inner 一样，私事不给客人）。
    // HYGIENE_GUEST 2026-11-07（批次150）：主人要求客人也看得到清洁。
    // 原来客人只有 say.wash 一句「在洗澡 / 有点黏」，看不出多干净、上次什么时候洗的。
    hygiene: __hy.owner,
    // 访客版：全是人话
    say: {
      energy: 精力话(st.energy),
      mood: 心情话(mi, sleeping),
      sleep: 睡话(total),
      money: 钱话(a.钱 ?? 0),
      home: 家话(home.length, comfort),
      activity: 状态词,
      wash: __hy.say,
    },
    // ── 身上和家里（批次150）──────────────────────────────────
    // 客人和主人都拿「包里」；「家里」只有主人 —— JSON 里干脆不下发，不是前端藏。
    包里: __物.filter((x) => x.在 === '包'),
    家里: role === 'owner' ? __物.filter((x) => x.在 === '家') : undefined,
    饱腹: __肚 ? __肚.v : null,
    饱腹词: __肚 ? __肚.词 : '',
    渴: __肚 ? __肚.渴 : null,
    渴百分比: __肚 ? __肚.渴百分比 : null,
    渴词: __肚 ? __肚.渴词 : '',
    饿: __肚 ? __肚.饿 : null,
    饿百分比: __肚 ? __肚.饿百分比 : null,
    今日顿: __肚 ? __肚.今日顿 : 0,
    今日零食: __肚 ? __肚.今日零食 : 0,
    最后吃了: __肚 ? __肚.最后吃了 : '',
    饱腹感: __肚 ? __肚.饱腹感 : null,
    胃百分比: __肚 ? __肚.胃百分比 : null,
    水杯: (() => {
      const c = __物.find((x) => x.n === '水杯')
      if (!c || !c.容器) return null
      const 毫升 = Array.isArray(c.容器.成分)
        ? c.容器.成分.reduce((n, x) => n + (Number(x.量) || 0), 0)
        : Number(c.容器.装) || 0
      return { 毫升: Math.round(毫升), 容量: Number(c.容器.容量) || 1000 }
    })(),
    病: __病 && __病.重 > 0 ? { 名: __病.名, 重: __病.重, 症状: __病.症状, 发烧: __病.发烧偏移, 值: __病.值 } : null,
    疾病值: __病 ? __病.值 : 0,
    // TODO_BOARD 2026-11-08（批次226）：主人那份才下发「需要主人处理」。
    // 只列等人处理的事，健康状态不占这里（super-agent 的规矩）。
    待办: role === 'owner' ? 待办.列() : undefined,
    穿: __穿 ? __穿.部位 : null,
    穿加权: __穿 ? __穿.加权 : null,
    穿最薄: __穿 ? __穿.最薄 : null,
    穿露着: __穿 ? __穿.露着 : null,
    九区: __九区 ? __九区.区 : null,
    温九区: __温九区 ? __温九区.区 : null,
    体温: __体温 ? __体温.体温 : null,
    体温档: __体温 ? 体温.档(__体温.体温).名 : null,
    体感: __体温 ? __体温.体感.值 : null,
    血糖: __肚 ? __肚.血糖 : null,
    musicTogether: (() => {
      // MUSIC_ONE 2026-11-12（批次364）：这里原来是 此刻音乐() 的**第二份实现** ——
      // 同一套判据写两遍，改了一处忘另一处。而且两份都在读错的数据源
      // （服务端 cookie 跟的是胧焯，PC 客户端是 feeiyuu）。
      // 现在只留一份：调 此刻音乐()，再把中文键映射成卡片要的英文键。
      try {
        const g = 此刻音乐(true)
        if (!g || g.开启 === false || !g.歌名) return null
        // 停下来超过一个半小时的，不再挂卡片（沿用原来那条截断）
        if (!g.正在播 && (Number(g.年龄分) || 0) > 90) return null
        return {
          active: Boolean(g.正在播),
          name: String(g.歌名 || ''),
          artist: String(g.歌手 || ''),
          ageMin: Number(g.年龄分) || 0,
          replayCount: Number(g.循环次数) || 1,
          // FEEL_GUEST 2026-11-12（主人要求：客人那份要和主人一模一样，含听感）
          feel: String(g.听感 || g.feel || '').slice(0, 90),
          progressSec: Number(g.进度秒) || 0,
          durationSec: Number(g.时长秒) || 0,
          syncSec: (g.同步秒 === null || g.同步秒 === undefined) ? null : Number(g.同步秒),
          account: String(g.当前号 || ''),
          实时: Boolean(g.实时),
        }
      } catch { return null }
    })(),
    // ── 她心里的事（2026-11-05 批次66）────────────────────────────
    // 上面那些全是「外面」：在哪、在干嘛、多少钱、睡了几小时。
    // 她这半个月长出来的东西（内心、天气、自己记的感受、梦）原来一个都没进来 ——
    // 面板上看得见她站着，看不见她在想什么。

    inner: (() => {
      if (role !== 'owner' || sleeping) return null
      try {
        return 内心短句(readFileSync(base + '/内心.md', 'utf8')) || null
      } catch (e) { return null }
    })(),

    // WEATHER_VIEW：窗外什么天。她今天做的每件事、每张自拍都发生在这个天里。
    weather: (() => {
      try {
        const w = JSON.parse(readFileSync(base + '/天气.json', 'utf8'))
        if (!w || !w.天气) return null
        // REGION_TEMP 2026-11-08（批次249）：温度要标清楚是室内还是室外。
        // 窗外 13° 和她屋里 22° 不是一回事 —— 面板/照片以前只写窗外那个，看着像她冻着。
        // 判据不另写一份：直接问 体温.区域温度()（它已经有 室内/位/区域）。
        const __环T = (() => { try { return 体温.区域温度() } catch { return null } })()
        const 区温 = __环T ? Math.round(Number(__环T.区域)) : (w.温度 ?? null)
        const 内外 = __环T ? (__环T.室内 ? '室内' : '室外') : ''
        const deg = 区温 == null ? '' : '（' + (内外 ? 内外 + ' ' : '') + 区温 + '°）'
        const 话 = (w.话 || w.天气) + deg
        // WEATHER_GUEST 2026-11-05（批次100）：天气不再分两版。
        //
        // 批次79 把天气做厚了（体感/风/湿度/日出日落/预报），批次93 只把「物候」补给了客人，
        // 其余字段仍然只给主人 —— 结果是客人那张「她现在」的副标题只跑得出第一句
        // 「下着小雨，路面湿了一层（17°）」，前端 `天副` 五段代码等于四段空转。
        //
        // 判断：天气不是她的私事。她淋的那场雨，客人也在同一个城里淋；
        // 「几点日落」跟「树黄了」是同一层的事实。这份字段表里现在没有一项
        // 需要为主人保留 —— 以后新加天气字段时先问一句「这个只给主人吗」，再决定要不要拆回两版。
        return {
          话, 天气: w.天气, 温度: w.温度 ?? null, 季节: w.季节 || '', 光照: w.光照 ?? null,
          // REGION_TEMP（批次249）：外面那个温度照旧留着（窗外），另给一份她现在所在区域的。
          区域温度: 区温, 室内: __环T ? !!__环T.室内 : null, 位置: __环T ? String(__环T.位 || '') : '',
          // SEASON_VIEW 2026-11-05（批次82）：季节段和物候。
          // 季节不是天气的注脚 —— 它决定她穿什么、街上什么样、想不想出门。
          季节段: w.季节段 || '', 物候: w.物候 || null,
          // WEATHER_RICH 2026-11-05（批次79）：新天气系统知道的东西比「一句话」多得多。
          时段: w.时段 || '', 体感: w.体感温度 ?? null, 湿度: w.湿度 ?? null,
          风: w.风 || null, 云: w.云 ?? null, 能见度: w.能见度 ?? null,
          日出: w.日出 || '', 日落: w.日落 || '',
          最高: w.最高 ?? null, 最低: w.最低 ?? null,
          降水: w.现在 ? { 下: !!w.现在.下, 强: w.现在.雨强 ?? 0, 什么: w.现在.降的什么 || '' } : null,
          预报: Array.isArray(w.预报) ? w.预报.slice(0, 2) : [],
        }
      } catch (e) { return null }
    })(),

    // FEELING_VIEW：她自己记下的感觉（感受.jsonl）。
    // 这是「成长」那条线的入口 —— 她判过被骂/被夸/想岔了/被注意到，面板上该看得见。
    // 访客只给条数：那是她跟具体某个人的事。
    feelings: (() => {
      try {
        const raw = readFileSync(base + '/感受.jsonl', 'utf8').trim()
        if (raw === '') return role === 'owner' ? [] : null
        const rows = 有效感受(raw)
        if (rows.length === 0) return role === 'owner' ? [] : null
        if (role !== 'owner') return { 条数: rows.length }
        return rows.slice(-8).reverse().map((r) => ({
          at: String(r.at || '').slice(5),
          kind: String(r.kind || ''),
          why: String(r.why || '').slice(0, 36),
          who: String(r.who || '')
        }))
      } catch (e) { return role === 'owner' ? [] : null }
    })(),

    // DREAM_VIEW：昨晚的梦。做梦.mjs 每天 11:30 写，梦余味会改第二天的心情 ——
    // 面板上看不见这条线，很奇怪。
    dream: (() => {
      try {
        const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
        const t = readFileSync(base + '/梦-' + d + '.md', 'utf8').trim()
        if (t === '') return null
        // 跳过 markdown 标题行：梦文件第一行是「# 2026-11-05 梦」，摘要不能拿它充数
        const lines = t.split(String.fromCharCode(10)).map((x) => x.trim())
          .filter((x) => x !== "" && !x.startsWith("#"))
        if (lines.length === 0) return null
        const 摘要 = lines[0].slice(0, 90)
        return role === 'owner'
          ? { 摘要, 全文: t.slice(0, 600), 行数: lines.length }
          : { 摘要: '昨晚做了个梦' }
      } catch (e) { return null }
    })(),

    // OUTFIT_VIEW 2026-11-05：她身上穿着什么（主人看结构，客人只看一句人话）
    outfit: (() => {
      const z = a.着装 || {}
      const 件 = [z.上, z.下, z.鞋].filter(Boolean)
      const 饰 = Array.isArray(z.饰) ? z.饰 : []
      if (role !== 'owner') {
        const 话 = 件.length ? '穿着' + 件.join('、') + (饰.length ? '，还戴了' + 饰.join('和') : '') : ''
        // OUTFIT_SHAPE 2026-11-12（批次365）：原来客人只拿到 ，而前端「穿了什么」那块板
        // 读的是 上/下/鞋/饰 —— 形状对不上，客人那边四个格子全显示「没穿」。
        // 穿着本来是给客人看的（照片墙都能看），只是**衣柜**（家里存着多少件）归主人。
        // 两种都给：老的读「话」的地方不受影响，新板子读分字段。
        return { 话, 上: z.上 || '', 下: z.下 || '', 鞋: z.鞋 || '', 饰 }
      }
      // WARDROBE_HOME 2026-11-08（批次232）：衣柜挪到状态页「家里存着」，这里带个总数，前端写「衣柜（N 件）」
      return { 上: z.上 || '', 下: z.下 || '', 鞋: z.鞋 || '', 饰, 衣柜: (a.衣柜 || []).slice(0, 12), 衣柜数: (a.衣柜 || []).length }
    })(),
    homeCount: home.length,
    // MAP_VIEW 2026-11-05：她的活动地图。主人看到全部地点与坐标，客人只看到她现在在哪。
    map: (() => {
      let m = { 地点: {} }
      m = 读图()   // 读不到就是 { 地点: {} }，跟原来的兜底一样
      const here = a.位置 || '家'
      // GUEST_MAP 2026-11-05：客人也能看地图。
      // PLACE_DESC_GUEST 2026-11-05（批次93）：desc 也给客人了。原来那条注释写着
      // 「那是她在那个地方做过什么」—— 说反了。desc 是地点自己的样子
      // （「有摊位、灯笼和人流，逛逛不用花钱也开心」），不是她的行踪。
      // 掐掉的后果是客人地图下面只剩一句「她现在在街市」，街市是什么样一句没有。
      //
      // PLACE_T_GUEST 2026-11-05（批次100）：`t`（从家走几分钟）也给客人。
      // 13 分钟是这个地点到家的路程，不是她今天走了几步。给了之后客人的 tooltip
      // 才和主人一样是 `街市 · 13 分 · 有摊位、灯笼和人流`，不再只有后半句。
      //
      // 到这里两版的 places 已经完全一样，所以不再分叉 —— 少一条分支少一处漂移。
      // 将来若要为主人保留点什么（比如她自己标的「去过几次」），再拆开。
      return {
        here,
        kind: (m.地点[here] || {}).kind || '',
        // VX_VY 2026-11-05：画面的视觉坐标也得带出去，否则前端只用 x/y 算位置、布局改了看不到
        places: Object.entries(m.地点 || {}).map(([name, p]) => ({ name, x: p.x, y: p.y, vx: p.vx, vy: p.vy, t: p.t, kind: p.kind, desc: p.desc })),
      }
    })(),
    // TRAVEL_VIEW 2026-11-05：路上状态（在途时不改 位置，只报还剩几分钟）
    travel: (() => {
      const t = a.在途
      if (!t || !t.arriveAt) return null
      const left = Math.max(0, Math.ceil((t.arriveAt - Date.now()) / 60e3))
      // LIVE_POS 2026-11-05：主人要「她的坐标每 10 秒实时更新」——
      // 服务端只给「从哪到哪、什么时候出发、什么时候到、两点坐标」，怎么走由前端自己插值算，别每 10 秒打一次接口。
      // 原来这里靠 base.replace(/记忆$/, '共享/工具/地图.json') 拼路径 —— 路径一改就静默 null。
      // 现在只问 地点.读图()，同一趟行程读一次就够（点位要查两个地点）。
      const 图 = 读图()
      const 点位 = (n) => { const q = (图.地点 || {})[n]; return q ? { x: q.x, y: q.y } : null }
      return { to: t.to, from: t.from, remainMin: left, startAt: t.startAt, arriveAt: t.arriveAt, fromXY: 点位(t.from), toXY: 点位(t.to) }
    })(),
    // LAST_DONE 2026-11-05：她最近做完的那件事（读了什么、买到了什么）。
    // 活动台账只记「在哪、什么类型」，细节在 自主.json 的 last 里 ——
    // 不摆出来，面板上就只剩「逛贴吧」三个字，看不出她到底看了什么。
    // 访客只知道「刚做了什么」，读到的内容是她的私事，不给。
    // LAST_FRESH 2026-11-05（批次86）：两道闸。
    // ① 没有 note 就不摆 —— 「发呆」「摸鱼」不是「做完的事」，摆出来像在汇报空气。
    // ② 90 分钟以前的也不算「刚做完」。15:57 拍完照、之后一直发呆，这一行能挂到晚上
    //    七点半，主人看到的就是「动作卡在拍照」。
    last: (() => {
      const l = aut && aut.last
      if (!l || (!l.note && !l.feel)) return null
      const 时 = Date.parse(String(l.at || '').replace(' ', 'T') + '+08:00')
      if (!Number.isFinite(时) || Date.now() - 时 > 90 * 60e3) return null
      // CONTENT_FEEL 2026-11-05（批次87）：她读完那一下的反应（人话，在 自主行动.mjs 里映射好）。
      // 主人能看全；客人只给「什么动作 + 什么反应」，不给读了什么 ——
      // 她看了哪个帖子是私事，她刚才在乐不是。
      // RECENT_GUEST 2026-11-05（批次92）：客人那份也带上时刻了 —— 他那边现在多了一张
      // 「她最近在做什么」，第一行要写「刚 21:40 看B站，笑了出来」，没有时刻就只是半句话。
      return role === 'owner'
        ? { at: String(l.at || ''), what: String(l.what || ''), note: String(l.note || ''), feel: String(l.feel || '') }
        : { at: String(l.at || ''), what: String(l.what || ''), feel: String(l.feel || '') }
    })(),
    // 最近 8 条，可能跨天 —— 这块一直是「刚刚/今天」的快速一览。
    // 客人 6 条（批次92），钱已经由 裁给客人 抹掉了。
    // RECENT_GUEST 2026-11-07（批次150）：主人要客人「最近在做什么看完整点」。
    // 原来只裁 6 条，滑条里今天一大半都看不到 —— 改成 12 条（钱仍然抹掉）。
    recent: role === 'owner' ? 流水.slice(0, 8) : 裁给客人(流水, 12),
    // DAY_SLIDER 2026-11-05（批次94）：今天一整天，给前端那根滑条用。
    //   · 只取今天 —— 跨天的历史不属于「一整天」，想看昨天是另一件事；
    //   · 正序（早 → 晚）：滑条左端是早上、右端是现在，跟人看时间的方向一致；
    //   · 上限 80 条：一天撑死这个量级，再多滑条也没法拖。
    // 客人也是今天全天，只是每条都过一遍 裁给客人。
    day: (() => {
      const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
      const 今天的 = 流水.filter((x) => String(x.at).startsWith(今天))
      // DAY_ALL 2026-11-08（批次228，主人要求）：客人也看完整的一天（含数值）。
      // 原来客人这份要过 裁给客人()，绝大多数活动被判成「不方便给客人看」，
      // 于是客人那张「她最近在做什么」永远写着「今天还没记下什么」。
      return 今天的.slice(0, 80).reverse()
    })(),
    // PLAN_VIEW 2026-11-05：今天想做的小事（她早上自己定的，做了会打勾）
    plan: (() => {
      try {
        const pj = JSON.parse(readFileSync(base + '/计划.json', 'utf8'))
        const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
        const t = (pj.days || {})[d] || { goals: [], done: [] }
        const items = (t.goals || []).map((g) => ({ id: g.id, 说明: g.说明 || '', done: (t.done || []).includes(g.id) }))
        return items.length ? items : null
      } catch (e) { return null }
    })(),
    // NOTES_VIEW 2026-11-05：她留给你的话（要钱、道谢），只给主人看
    notes: role !== 'owner' ? undefined : (() => {
      try {
        const 旧留言 = load(base + '/留言.json', { items: [] })
        return 留话摘句(旧留言?.items, 留言板.天数().map(留言板.读))
      } catch (e) { return [] }
    })(),
    // TODAY_ACCOUNT 2026-11-05：今天的收支（从记录里算，不另存一份）
    // 批次174：口径在 账本.mjs。这里原来有自己的一份正则 —— 认「给了」但认不出
    // 「打工赚了 20」（没有「块」字）和新的工资格式「上班：…（475 分钟，130 块，扣了 20）」，
    // 于是首页说她今天赚 100，日记说赚 250。
    today: role !== 'owner' ? undefined : (() => {
      const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
      const __账 = 账本.汇总((a.记录 || []).filter((r) => String(r.at || '').startsWith(d)))
      return { 花: __账.花, 赚: __账.赚, 笔数: __账.笔 }
    })(),
    // DEBT_VIEW 2026-11-05：她欠了多少（花呗 + 贷款），只有主人能看
    debt: role !== 'owner' ? undefined : (() => {
      try {
        const 信 = a.信贷 || {}
        const 花呗 = Math.round(Number((信.花呗 || {}).已用 || 0) * 100) / 100
        const 贷款 = Math.round(Number((信.贷款 || {}).已用 || 0) * 100) / 100
        return { 花呗, 贷款, 共欠: Math.round((花呗 + 贷款) * 100) / 100 }
      } catch { return { 花呗: 0, 贷款: 0, 共欠: 0 } }
    })(),
    // SELFIE_VIEW 2026-11-05：今天拍的照片（时间正序），左右能翻。
    // selfie 留着当「最新一张」的兼容字段（首页背景轮换、别处还在读它）。
    // GUEST_SELFIE：客人也能看，但只给图和时间 —— 角度/场景是她自己那边的细节。
    selfie: __photos.length ? __photos[__photos.length - 1] : null,
    selfies: __photos,
    // TREND_VIEW 2026-11-05：最近几天的小结（读 每日快照.json，只给主人）
    days: role !== 'owner' ? undefined : (() => {
      try {
        const s = JSON.parse(readFileSync(base + '/每日快照.json', 'utf8'))
        return (s.days || []).slice(-7).map((d) => ({ date: d.date, 钱: d.money, 体力: d.energy, 心情: d.mood, 花: d.花, 赚: d.赚 }))
      } catch (e) { return [] }
    })(),
  }
  if (sleeping) {
    pub.activity = '睡着'
    pub.activityMinutes = Math.round(total * 60)
    // SLEEP_PLACE 2026-11-06（批次107）：睡着不等于在床上。
    // 原来无条件写「床上」，可她 00:20 是 energy=4 在便利店被强制睡的，
    // 资产.位置 一动没动 —— 面板就成了「她现在在便利店」+「在床上睡着了」，
    // 两句话当面打架。只有人真在家才是床；在外面就是在外面的地方睡着了。
    const __真位 = String(pub.place || a.位置 || '家')
    pub.place = __真位 === '家' ? '床上' : __真位
    pub.say.activity = '睡着'
  }

  // WORK_PANEL 2026-11-06（批次112）：她有班要上，但面板一个字都不显示 ——
  // 主人只能从「人在便利店」猜她在干嘛，也看不到「这一班已经被扣了 12 块」。
  // 只递事实：在岗/还差多久下班/迟到多少分钟/今天几点的班/扣了多少/信用。
  // 睡岗和迟到都是工作.mjs 判的，这里只读结果，不另算一遍。
  try {
    const __工 = JSON.parse(readFileSync(base + '/工作.json', 'utf8'))
    const __n = Date.now()
    const __t = (x) => Date.parse(String(x).replace(' ', 'T') + '+08:00')
    const __今 = new Date(__n + 8 * 3600e3).toISOString().slice(0, 10)
    const __班们 = (Array.isArray(__工.班次) ? __工.班次 : []).filter(
      (b) => b && (String(b.起 || '').startsWith(__今) || String(b.止 || '').startsWith(__今))
    )
    // OCCUPY 2026-11-07（批次167）：判据问 占用.mjs。
    // 原来这里是 `状态==='在岗' && now<止` —— 不判起点，而且上班第一分钟（待上 + 已在店里）
    // 会被判成「迟到了」：缺口/自主行动 都说她在上班，面板说她迟到，两边打架。
    const __在岗 = 在岗的班(base)
    // 「迟到了」= 时段已经开始了、但还不在岗。__在岗 已经覆盖「在岗」和「待上+人已在店里」，
    // 所以这里排除的是「已经下班/结算」的班 —— 不再用 `!== '在岗'` 那个字面，
    // 判在岗只有 占用.mjs 一处（契约检查第 579 项会抓）。
    // LATE_ONE_SOURCE 2026-11-07（批次176）：迟到判据只有 工作.mjs 一处，面板照抄，不许自己简化。
    //   工作.mjs:182 的真判据 =「从没打过卡（!打卡At）」+「迟到分>=5」+「比记过的更多」。
    //   打卡后又离开的人算早退 —— 迟到是「还没到过」的事（批次172 修的就是这个，那次她
    //   22:00 准点打卡守到 05:54，被判「迟到 474 分钟」）。
    //   面板原来只判「时段内 + 不在岗」，于是打过卡又走开的人被标成「迟到 150 分钟」，
    //   而账上一分没扣 —— 主人当面看见两个数打架。
    const __迟到分 = (b) => Math.floor((__n - __t(b.起)) / 60000)
    const __迟 = __在岗 ? null : __班们.find((b) =>
      !String(b.打卡At || '') && String(b.状态) !== '完成' && __n >= __t(b.起) && __n < __t(b.止) && __迟到分(b) >= 5
    )
    const __段 = (b) => (b ? String(b.起).slice(11) + '-' + String(b.止).slice(11) : '')
    const __工配 = load(tools + '/工作.json', { 活: {} }).活 || {}
    pub.work = {
      模式: '自由日结零工',
      可选零工: Object.entries(__工配).map(([k, v]) => ({ 活: k, 点: v.点, 时薪: v.时薪 })),
      信用: Number(__工.信用 ?? 100),
      在岗: !!__在岗,
      点: __在岗 ? String(__在岗.点 || '') : '',
      活: __在岗 ? String(__在岗.活 || '') : '',
      时段: __段(__在岗 || __迟),
      剩分: __在岗 ? Math.max(1, Math.round((__t(__在岗.止) - __n) / 60000)) : 0,
      迟到分: __迟 ? __迟到分(__迟) : 0,
      扣: Number((__在岗 || __迟 || {}).扣 || 0),
      今天: __班们.map((b) => ({
        活: String(b.活 || ''), 点: String(b.点 || ''),
        起: String(b.起 || '').slice(11), 止: String(b.止 || '').slice(11),
        状态: String(b.状态 || ''), 扣: Number(b.扣 || 0),
      })),
      最近: (Array.isArray(__工.最近) ? __工.最近 : []).slice(-3),
    }
  } catch { /* 没工作档案就不给这块 */ }

  // GUEST_NO_MINUTES 2026-11-05（批次100）：时长只给主人。
  // 她在一个地方待了多久是行踪细节 —— 客人知道她在便利店就够了，
  // 不需要知道「已经 42 分钟」。这个数字本身也常不准（批次85 才修过口径）。
  // 用 delete 而不是置 0：JSON 里连这个键都不该出现，否则将来前端一读就又把口子开了。
  if (role !== 'owner') {
    delete pub.activityMinutes
    // 客人看得到「她在上班」，看不到她挣多少、扣了多少 —— 那是她的账。
    if (pub.work) { delete pub.work.信用; delete pub.work.扣; delete pub.work.最近; delete pub.work.今天 }
    return pub
  }
  const me = (aff.people || {})[OWNER] || {}
  // HUNGER 2026-11-06（批次139）的 __肚 已挪到 pub 之前（批次150：客人也要看）。
  return {
    ...pub,
    // EAT_VIEW 2026-11-06（批次144）：她正坐下来吃什么、还有多久。
    // 不给前端就等于「面板上她在家发呆、实际在餐厅吃火锅」—— 跟洗澡那次同一个坑。
    吃饭: (() => {
      try {
        const f = JSON.parse(readFileSync(base + '/吃饭.json', 'utf8'))
        const t = Date.parse(String(f.到 || '').replace(' ', 'T') + ':00+08:00')
        if (!Number.isFinite(t) || t <= Date.now()) return null
        return { 吃啥: String(f.吃啥 || ''), 在哪: String(f.在哪 || ''), 到: String(f.到 || ''), 剩: Math.max(1, Math.round((t - Date.now()) / 60000)) }
      } catch { return null }
    })(),
    energy: st.energy == null ? null : Math.round(Number(st.energy)), // ROUND_NUMBERS 2026-11-03：别把浮点尾巴显示给人看
    mood: { label: st?.mood?.label || '', intensity: mi },
    layers: st.layers || {},
    patience: st['耐心'] || {},
    body: st.body || {},
    strain: st['熬夜'] || null,
    affinity: me.score ?? null,
    affinityLog: (me.log || []).slice(0, 3),
    money: a.钱 ?? 0,
    bag: a.包 || [],
    // ITEMS_VIEW 2026-11-05（批次75）：她手上的东西在哪儿、哪些是借的、什么时候要还。
    // 面板原来只有「包里 1 件」这一行，看不出那把伞是跟便利店借的。
    items: (() => {
      try {
        const d = JSON.parse(readFileSync(base + '/物品.json', 'utf8'))
        const list = Array.isArray(d.items) ? d.items : []
        return list.map((x) => ({
          n: String(x.n || ''),
          在: String(x.在 || ''),
          借自: x.来 === '借' ? String(x.自 || '') : '',
          该还: x.来 === '借' ? String(x.该还 || '') : '',
          // 批次144：吃的能存着、能有几份，前端才分得清「薯片×2」和「两把伞」
          类: String(x.类 || ''),
          数: Math.max(1, Number(x.数) || 1),
        })).filter((x) => x.n)
      } catch { return [] }
    })(),
    // WEAR_BAG_V1：前端要知道哪件是衣服、以及她现在穿着什么
    服装表: Object.keys(服装表).reduce(function (o, k) { o[k] = 服装表[k].类别; return o }, {}),
    着装: { 上: (a.着装 && a.着装.上) || '', 下: (a.着装 && a.着装.下) || '', 鞋: (a.着装 && a.着装.鞋) || '', 饰: (a.着装 && a.着装.饰) || [] },
    home,
    comfort,
    shop: SHOP,
    sleepToday: Number(total.toFixed(1)),
    sleepSegments: today.length,
    chain: tailChain(4),
  }
}

// WALL_REDO 2026-11-06（批次113）：照片墙上「这张不对，重拍一次」。
//
// 它调的是 自拍.mjs --重跑 <id>：把**原来那张**重画一遍（场景/动作/心情/话/机位都沿用），
// 不是「现在再拍一张」。人在家、照片是便利店的，重拍出来还得是便利店。
// 排队之后由本机的自拍工出图，覆盖同名 png；前端靠 /api/wall 的 v 变没变来判断出没出。
// 顺带说清楚：这一步只在这里做角色校验，前端那个按钮藏不藏不算数。
const 重拍中 = new Map()
function 重拍(id) {
  const 图 = '{{BOT_ROOT}}/共享/自拍/成品/' + id + '.png'
  if (!existsSync(图)) return { ok: false, msg: '成品里没有这张' }
  const 上次 = Number(重拍中.get(id) || 0)
  if (Date.now() - 上次 < 60e3) return { ok: false, msg: '上一张还在重拍，等一分钟再点' }
  // 出图要一两分钟，连点五次会排出五张同 id 的活儿，
  // 后出的一张盖前面一张，显卡白占着，最后留下哪张看运气。
  重拍中.set(id, Date.now())
  if (重拍中.size > 200) for (const [k, v] of 重拍中) if (Date.now() - v > 3600e3) 重拍中.delete(k)
  let out = ''
  try {
    out = String(execFileSync(NODE, [tools + '/自拍.mjs', '--重跑', id], { encoding: 'utf8', timeout: 30e3 })).trim()
  } catch (e) {
    重拍中.delete(id)
    return { ok: false, msg: '没排上：' + (e.message || '') }
  }
  if (/不能重拍|没有这张|在睡，不拍/.test(out)) {
    重拍中.delete(id)
    return { ok: false, msg: out.split('\n').pop() }
  }
  return { ok: true, msg: out.split('\n').pop(), v: Math.round(requireStat(图).mtimeMs) }
}

// WALL_DELETE 2026-11-06（批次120）：照片墙上主人能删照片。
//
// 只删这张自己的东西：成品 png、同 id 的 sidecar json、缩略图/预览缓存，
// 再从 照片墙.json 和 拍照本.json 里摘掉那一条。
// **日记不动** —— 日记正文是她自己写的字，删一张图不该顺手挖掉她一段话；
// 而且日记右页的照片是每次现扫成品目录扫出来的（那天照片()），图没了它自己就不贴了。
// 每个文件单独 try：缩略图可能压根没生成过，一个失手不该连累别的。
function 删照片(id) {
  if (!id) return { ok: false, msg: '没给 id' }
  const 成品 = '{{BOT_ROOT}}/共享/自拍/成品/'
  if (!existsSync(成品 + id + '.png')) return { ok: false, msg: '成品里没有这张' }
  // 正在重拍时不许删：自拍工过一两分钟会把同名 png 写回来，删了它照样长出来，
  // 还留下一个没有图的 sidecar —— 墙上多一条空白。
  if (existsSync('{{BOT_ROOT}}/共享/自拍/请求/' + id + '.json')) {
    return { ok: false, msg: '这张正在重拍，等它出完再删' }
  }
  const 名单 = [
    成品 + id + '.png',
    成品 + id + '.json',
    '{{BOT_ROOT}}/共享/自拍/缩略图/' + id + '.jpg',
    '{{BOT_ROOT}}/共享/自拍/预览/' + id + '.jpg',
  ]
  // WALL_TRASH 2026-11-06（批次135）：删了还能捞回来。
  // 以前直接 unlink，删错就没了 —— 灯箱里两个按钮挨着，误触很容易。
  // 整条（png/json/缩略图/预览）挪进 _回收站/<id>-<时间>/，保留 7 天；
  // 每次删除顺手清掉过期的。删除.log 照旧记一行。
  const 回收根 = '{{BOT_ROOT}}/共享/自拍/_回收站'
  const 戳 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace(/[-:T]/g, '')
  const 袋 = 回收根 + '/' + id + '-' + 戳
  let 移了 = 0
  try { _mkd(袋, { recursive: true }) } catch { /* 建不出来就退回删除 */ }
  for (const p of 名单) {
    try {
      if (!existsSync(p)) continue
      _rn(p, 袋 + '/' + p.slice(p.lastIndexOf('/') + 1))
      移了 += 1
    } catch {
      try { unlinkSync(p); 移了 += 1 } catch { /* 单个删不掉不影响别的 */ }
    }
  }
  try {
    for (const d of _rd(回收根)) {
      const 全 = 回收根 + '/' + d
      try { if (Date.now() - _st(全).mtimeMs > 7 * 864e5) _rm(全, { recursive: true, force: true }) } catch { /* 清不掉下次再清 */ }
    }
  } catch { /* 回收站还没建 */ }
  try {
    const p = base + '/照片墙.json'
    const 墙 = load(p, {})
    if (墙 && 墙.photo && 墙.photo[id]) { delete 墙.photo[id]; save(p, 墙) }
  } catch { /* 没这份就跳过 */ }
  try {
    const p = base + '/拍照本.json'
    const 本 = load(p, { items: [] })
    if (本 && Array.isArray(本.items)) {
      const 剩 = 本.items.filter((x) => !(x && x.id === id))
      if (剩.length !== 本.items.length) { 本.items = 剩; save(p, 本) }
    }
  } catch { /* 同上 */ }
  // 留一行档：她哪天真问「那张呢」，能答得上来是什么时候没的、谁没的。
  try {
    appendFileSync('{{BOT_ROOT}}/共享/自拍/删除.log',
      new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ') + '  主人删了 ' + id + '（' + 移了 + ' 个文件，进回收站 7 天）\n')
  } catch { /* 记不上不影响删 */ }
  return { ok: true, msg: '删掉了（回收站留 7 天）' }
}

function act(body) {
  // SLEEP_GATE_PANEL 2026-11-03：睡着的时候不接受动作，别让她在面板上边睡边逛街
  try {
    const __sl = load(base + '/睡眠.json', {})
    if (__sl && __sl.sleeping === true) return '她睡着呢，等她醒了再说'
  } catch { /* 读不到就放行 */ }
  const run = (args) => {
    try { return execFileSync(NODE, [tools + '/资产.mjs', ...args], { encoding: 'utf8', timeout: 15000 }).trim() }
    catch (e) { return '失败了：' + (e.message || '') }
  }
  if (body === 'work') return run(['--打工'])
  if (body === 'stroll') return run(['--逛'])
  if (body.startsWith('buy:')) { const it = body.slice(4); if (!SHOP[it]) return '店里没有这件'; return run(['--买', it]) }
  // WEAR_BAG_V1 2026-11-03：衣服不能当家具摆（原来点水手服会把它摆进家）
  if (body.startsWith('wear:')) return run(['--穿', body.slice(5)])
  if (body.startsWith('unwear:')) return run(['--脱', body.slice(7)])
  if (body.startsWith('put:')) {
    const it = body.slice(4)
    if (Object.prototype.hasOwnProperty.call(服装表, it)) return '这是衣服，得穿身上，不能当家具摆'
    // FOOD_NOT_FURNITURE 2026-11-06（批次144）：零食牛奶是拿来吃的，不是摆件。
    // 让它走 --摆 会变成房间里的一个 3D 薯片（当装饰），而且它还在她包里 —— 两处都有。
    if (Object.prototype.hasOwnProperty.call(SHOP, it) && ['吃', '喝', '零食'].includes(String(SHOP[it].类别 || ''))) {
      return '这是吃的，放着就行，不用摆成家具'
    }
    const a = load(base + '/资产.json', { 包: [] })
    if (!(a.包 || []).includes(it)) return '包里没有这件'
    return run(['--摆', it])
  }
  return '不认识的动作'
}

// AUTH_PAGE_FILE 2026-11-05：登录页改成独立文件，方便整页重做（改样式不用动这个 6000 行的文件）。
// 读不到就退回一句提示，不至于 500。
// COVER_TMPL 2026-11-05：登录页背景改成轮换，首屏那一下要立刻有图 ——
// 等 JS 拉完 /cover/list 再设背景，中间会白一截。所以把第一张的地址直接写进 CSS，
// 浏览器解析样式时就开始加载，和 HTML 并行。
const AUTH_TMPL = (() => {
  try { return _rf('{{BOT_ROOT}}/共享/工具/登录页.html', 'utf8') } catch { return '<h1>登录页读不到</h1>' }
})()

// COVER_LIST 2026-11-05：能拿去轮换的那些封面。
// 只列「成品有、封面也压好了」的 id —— 没压好的新照片最多晚几分钟进轮换（cron 每分钟扫），
// 换来的是这条公开路由永远不用现压图。面板的请求处理是同步的，这里跑一次 convert 就是卡 0.5 秒。
// 3 秒缓存兜住连刷；登录页访问频率本来就低，够用。
let _coverCache = { at: 0, list: [] }
function coverList() {
  if (Date.now() - _coverCache.at < 3000) return _coverCache.list
  let ids = []
  try {
    const src = '{{BOT_ROOT}}/共享/自拍/成品'
    const dst = '{{BOT_ROOT}}/共享/自拍/封面'
    const have = new Set(requireDir(dst).filter((f) => f.endsWith('.jpg')).map((f) => f.replace(/\.jpg$/, '')))
    const list = requireDir(src).filter((f) => f.endsWith('.png')).map((f) => f.replace(/\.png$/, ''))
    // 按成品的 mtime 排：封面文件的 mtime 是压图时间，不是拍照时间，排出来会乱
    list.sort((a, b) => requireStat(src + '/' + a + '.png').mtimeMs - requireStat(src + '/' + b + '.png').mtimeMs)
    ids = list.filter((id) => have.has(id))
  } catch { ids = [] }
  _coverCache = { at: Date.now(), list: ids }
  return ids
}
function authPageHtml() {
  const ids = coverList()
  // 首屏放最新那张：和以前的表现一致，只是从 2.9MB 的原图换成 225KB 的封面
  const first = ids.length ? ('/cover/' + ids[ids.length - 1] + '.jpg') : '/cover'
  return AUTH_TMPL.replace(/\{\{COVER_FIRST\}\}/g, first)
}

// OLD_APP 已删除（2026-11-12，主人原话：「这个页面早就舍弃了」）。
// 它生前只做两件事：简洁页读不到时兜底、未匹配路由的默认响应。
// 代价是每次没带 cookie 打开 / 都会看到那份 197KB 的旧界面（标题「{{BOT_DISPLAY}} · 现在」，
// 永远挂着「读状态中…」），看着像面板坏了 —— 现在 / 与 /login 一律给登录页，别的路径 404。

// DUMP_STATE 2026-11-07（批次150）：命令行加 --dump 直接把两份快照打到 stdout，
// 不起服务、不用登录 —— 改下发字段之后，能当场确认客人那份到底有没有漏、有没有多。
if (process.argv.includes('--dump')) {
  const 哪 = process.argv.includes('--guest') ? 'guest' : (process.argv.includes('--owner') ? 'owner' : null)
  const out = 哪 ? snapshot(哪) : { guest: snapshot('guest'), owner: snapshot('owner') }
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}


// ═══════════════════════════════════════════════════════════════════════════
// API_SWITCH 2026-11-08（批次284）：调试页即时切换她的接口
//
// 为什么不再直接改 /etc/dshbot.env：
//   那样每切一次都要 restart dsh-bot，她正在回话就断一轮；而且 portdan 这类中转站
//   的模型名是 deepseek-v4.1-flash，dsh 发的是 deepseek-flash —— 只换 base+key 会
//   400 model_not_found。
//
// 现在的形状：dsh 固定指向本机 39301（接口中转.mjs / systemd fish-upstream），
// 中转每次请求现读 {{DSH_ROOT}}/fish-upstream.json 换上游、key、模型名。
// 于是「切钥匙」= 改一个 JSON，下一句生效，**不重启她**。
//
// 三条底线不变：
//   1. **先验后切**：写配置前拿这把钥匙真发一条 1 token 的请求；401 不写盘。
//   2. **完整 key 不出后端**：只回「前 7 … 后 4」。
//   3. **写前备份 + 中转不健康就拒绝切**，别把她一个人扔在没有上游的地方。
const UPSTREAM_CONF = process.env.FISH_UPSTREAM_CONF || '{{DSH_ROOT}}/fish-upstream.json'
// GATEWAY_DEFAULT_OFF 2026-11-24：同一台机器上 39401 可能是别家 bot 的网关，
// 默认不认；要接自己的网关就显式设 FISH_GATEWAY_PORT。
const HAS_GATEWAY = !!process.env.FISH_GATEWAY_PORT && process.env.FISH_GATEWAY_PORT !== '0'
const GW_PORT = Number(process.env.FISH_GATEWAY_PORT || 0)
const UPSTREAM_HEALTH = process.env.FISH_UPSTREAM_HEALTH || 'http://127.0.0.1:39401/health'
const FLEET_TOKEN = process.env.FLEET_TOKEN || ''
const fleetHeaders = FLEET_TOKEN ? { 'x-fleet-token': FLEET_TOKEN } : {}
const API_KEYS_FILE = process.env.FISH_KEYS_FILE || '{{DSH_ROOT}}/fish-api-keys.json'
const 官方BASE = 'https://api.deepseek.com/anthropic'

/** 钥匙打码：前 7 位 + 后 4 位。短到看不清就直说，别假装正常。 */
function 遮钥匙(k) {
  const s = String(k || '')
  if (!s) return '（空）'
  if (s.length < 18) return '（太短，像粘漏了）'
  return s.slice(0, 7) + '…' + s.slice(-4)
}

/** 线上正在用的（从中转配置读；读不到返回 null）。 */
function 读中转配置() {
  try {
    const j = JSON.parse(readFileSync(UPSTREAM_CONF, 'utf8'))
    return j && j.base ? j : null
  } catch { return null }
}

/** 候选档：主人加过的钥匙 + 它们各自的 upstream。0600，只在 {{DSH_ROOT}} 下。 */
function 读候选钥匙() {
  return 读候选原档() ?? []
}

function 读候选原档() {
  try {
    const j = JSON.parse(readFileSync(API_KEYS_FILE, 'utf8'))
    return Array.isArray(j) ? j : null
  } catch (error) { return error?.code === 'ENOENT' ? [] : null }
}

function 存候选钥匙(list) {
  const tmp = API_KEYS_FILE + '.' + randomBytes(8).toString('hex') + '.tmp'
  try {
    _mkd(dirname(API_KEYS_FILE), { recursive: true })
    writeFileSync(tmp, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    _rn(tmp, API_KEYS_FILE)
    return true
  } catch {
    try { unlinkSync(tmp) } catch (_err) { console.error('[面板]', _err?.message || _err) }
    return false
  }
}

function 回填候选结果(旧项, 字段) {
  const 最新 = 读候选原档()
  if (!最新) return false
  for (const item of 旧项) {
    const hit = 最新.find((entry) => entry.id === item.id && entry.key === item.key && entry.base === item.base)
    if (hit) for (const field of 字段) hit[field] = item[field]
  }
  return 存候选钥匙(最新)
}

/** 时间戳（北京时间，14 位）。 */
function 时刻() {
  return new Date(Date.now() + 8 * 3600e3).toISOString().replace(/[-:T]/g, '').slice(0, 14)
}

/**
 * 真打一次，确认这把钥匙在这个上游上活着。
 *   · 官方（deepseek.com）走 /user/balance，能顺便带余额；
 *   · 其它中转按 Anthropic 协议发一条 max_tokens=8 的（那才是 dsh 真正用的协议）。
 * 只看格式、只看长度都不算证据 —— 主人上次给的两把就是格式对但服务端 401。
 */
async function 验钥匙(raw, base, map) {
  const key = String(raw || '').trim()
  if (!/^sk-[A-Za-z0-9_-]{16,}$/.test(key)) return { ok: false, msg: '格式不像钥匙（sk- 开头）' }
  if (!凭证可用(读候选原档(), key)) return { ok: false, 时段禁用: true, msg: '不在允许时段或候选配置不可读，未发验证请求' }
  const b = String(base || '').replace(/\/+$/, '')
  const 是官方 = b === '' || b.includes('api.deepseek.com') // 同上，批次321 修
  try {
    if (是官方) {
      const host = b && b.includes('/anthropic') ? 'https://api.deepseek.com' : (b || 'https://api.deepseek.com')
      const r = await fetch(host + '/user/balance', {
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(15000),
      })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch { /* 非 JSON */ }
      if (!r.ok || !j || j.is_available !== true) {
        let msg = (j && j.error && j.error.message) || t || ('HTTP ' + r.status)
        return { ok: false, msg: String(msg).split(key).join('***').slice(0, 160) }
      }
      const bi = (j.balance_infos || [])[0] || {}
      return { ok: true, 余额: Number(bi.total_balance || 0), 币: bi.currency || 'CNY', 协议: 'balance' }
    }
    // 中转站：按 dsh 真正用的协议打一条最小的
    const 模型 = (map && (map['deepseek-flash'] || map['deepseek-v4-pro'] || Object.values(map)[0])) || 'deepseek-flash'
    const r = await fetch(b + '/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: 模型, max_tokens: 8, messages: [{ role: 'user', content: 'ping' }] }),
      // 中转站首字延迟经常 10~40 秒（它自己去排上游），30 秒太紧，给 75 秒
      signal: AbortSignal.timeout(75000),
    })
    const t = await r.text()
    let j = null
    try { j = JSON.parse(t) } catch { /* 非 JSON */ }
    if (!r.ok || !j || j.type !== 'message') {
      let msg = (j && j.error && j.error.message) || (j && j.message) || t || ('HTTP ' + r.status)
      return { ok: false, msg: String(msg).split(key).join('***').slice(0, 180) }
    }
    const 回 = Array.isArray(j.content) ? j.content.find((x) => x && (x.type === 'text' || x.type === 'thinking')) : null
    const out = { ok: true, 协议: 'messages', 模型, 回声: 回 ? String(回.text || 回.thinking || '').slice(0, 24) : '' }
    // KEY_BALANCE 2026-11-09（批次316）：验通之后顺手把余额也查了 —— 主人要每把钥匙都显示余额。
    // 查不到不算失败（有的站确实没这个接口），只是没有 余额 字段，前端显示「—」。
    try {
      const ru = await fetch(b + '/v1/usage', {
        headers: { authorization: 'Bearer ' + key },
        signal: AbortSignal.timeout(12000),
      })
      const tu = await ru.text()
      let ju = null
      try { ju = JSON.parse(tu) } catch { /* 非 JSON */ }
      const 钱 = ju && (typeof ju.remaining === 'number' ? ju.remaining : (typeof ju.balance === 'number' ? ju.balance : null))
      if (ru.ok && 钱 !== null) { out.余额 = 钱; out.币 = String(ju.unit || 'USD') }
    } catch { /* 没有余额接口就算了，不影响「这把能用」的结论 */ }
    return out
  } catch (e) {
    return { ok: false, msg: '连不上：' + String((e && e.message) || e).slice(0, 140) }
  }
}

/**
 * 只查余额，不发对话请求（批次317）。
 *
 * 为什么单开一个：`验钥匙` 要按 dsh 真正用的协议发一条 max_tokens=8 的请求，
 * 中转站首字经常 10~40 秒，三把钥匙串起来就是两分钟。而「显示余额」只需要一次 GET，
 * 三把并发 1~2 秒就完了 —— 打开页面就该看见，不该等主人去点「全部验一遍」。
 */
async function 查一把余额(key, base) {
  const b = String(base || '').replace(/\/+$/, '')
  const k = String(key || '')
  if (k === '') return { ok: false, msg: '没有钥匙' }
  if (!凭证可用(读候选原档(), k)) return { ok: false, 时段禁用: true }
  if (b === '' || /api\.deepseek\.com/.test(b)) {
    try {
      const host = b && b.includes('/anthropic') ? 'https://api.deepseek.com' : (b || 'https://api.deepseek.com')
      const r = await fetch(host + '/user/balance', {
        headers: { authorization: 'Bearer ' + k },
        signal: AbortSignal.timeout(12000),
      })
      const j = await r.json()
      // NEG_BALANCE 2026-11-19（批次745）：欠费时 is_available:false 但余额数字是真的。
      if (!r.ok || !j || !Array.isArray(j.balance_infos) || !j.balance_infos.length) return { ok: false, msg: '余额接口没给数据' }
      const bi = (j.balance_infos || [])[0] || {}
      return {
        ok: true,
        余额: Number(bi.total_balance || 0),
        币: bi.currency || 'CNY',
        可用: j.is_available === true,
      }
    } catch (e) { return { ok: false, msg: String((e && e.message) || e).slice(0, 80) } }
  }
  try {
    const r = await fetch(b + '/v1/usage', {
      headers: { authorization: 'Bearer ' + k },
      signal: AbortSignal.timeout(12000),
    })
    const j = await r.json()
    const 钱 = typeof j.remaining === 'number' ? j.remaining : (typeof j.balance === 'number' ? j.balance : null)
    if (!r.ok || 钱 === null) return { ok: false, msg: '这个站没有余额接口' }
    return { ok: true, 余额: 钱, 币: String(j.unit || 'USD'), 计划: String(j.planName || '') }
  } catch (e) { return { ok: false, msg: String((e && e.message) || e).slice(0, 80) } }
}

/**
 * 拉这把钥匙真正能用的模型（批次322）。
 *
 * 两条路，格式不同：
 *   · 官方 deepseek：GET https://api.deepseek.com/models → {object:"list", data:[{id,name,...}]}
 *   · 中转站       ：GET <base>/v1/models          → {data:[{id,type,display_name}]}
 *
 * 为什么之前写「内置 5 个候选」：当时用错 key 试 /v1/models 拿了 401，就以为没有这个接口。
 * 实际是拿**官方 key** 去请求 portdan —— 换成那把 portdan 的 key 立刻 200。
 * 教训：试接口之前先确认手里这支 key 属于哪个上游。
 */
async function 查一把模型(key, base) {
  const b = String(base || '').replace(/\/+$/, '')
  const k = String(key || '')
  if (k === '') return { ok: false, msg: '没有钥匙' }
  if (!凭证可用(读候选原档(), k)) return { ok: false, 时段禁用: true, msg: '不在允许时段，未查询模型清单' }
  const 是官方 = b === '' || b.includes('api.deepseek.com')
  const url = 是官方
    ? ((b && b.includes('/anthropic') ? 'https://api.deepseek.com' : (b || 'https://api.deepseek.com')) + '/models')
    : (b + '/v1/models')
  try {
    const r = await fetch(url, { headers: { authorization: 'Bearer ' + k }, signal: AbortSignal.timeout(12000) })
    const t = await r.text()
    let j = null
    try { j = JSON.parse(t) } catch { /* 非 JSON */ }
    const arr = j && Array.isArray(j.data) ? j.data : []
    if (!r.ok || !arr.length) {
      return { ok: false, msg: '这个上游没给模型列表（HTTP ' + r.status + '）' }
    }
    const 列表 = arr
      .map((x) => ({ id: String((x && x.id) || ''), 名: String((x && (x.name || x.display_name)) || (x && x.id) || '') }))
      .filter((x) => x.id !== '')
    return { ok: true, 列表 }
  } catch (e) { return { ok: false, msg: String((e && e.message) || e).slice(0, 80) } }
}

/** 中转活着吗（活着才谈得上切）。 */
async function 中转健康() {
  try {
    const r = await fetch(UPSTREAM_HEALTH, { signal: AbortSignal.timeout(4000) })
    const j = await r.json()
    return { ok: r.ok && j && j.ok === true, 详情: j }
  } catch (e) {
    return { ok: false, 详情: { msg: String((e && e.message) || e).slice(0, 120) } }
  }
}

/** 原子写中转配置：先写 .tmp 再 rename，绝不让它读到半截 JSON。 */
function 写中转配置(next) {
  const 备份 = UPSTREAM_CONF + '.bak-' + 时刻()
  try { writeFileSync(备份, readFileSync(UPSTREAM_CONF, 'utf8'), { encoding: 'utf8', mode: 0o600 }) } catch { /* 第一次没有旧文件 */ }
  const tmp = UPSTREAM_CONF + '.tmp'
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
  _rn(tmp, UPSTREAM_CONF)
  try {
    const olds = _rd('{{DSH_ROOT}}')
      .filter((f) => /^fish-upstream\.json\.bak-\d{14}$/.test(f))
      .sort()
      .reverse()
    for (const f of olds.slice(3)) {
      try { unlinkSync('{{DSH_ROOT}}/' + f) } catch { /* 删不掉就算了 */ }
    }
  } catch { /* 轮转失败不影响这次写入 */ }
  return 备份
}

/**
 * 切上游：验钥匙 → 查中转健康 → 备份 → 原子写 → 回读 /health 证明生效。
 * 不重启 dsh-bot：下一句请求就走新上游。
 */
async function 换上游(hit) {
  const 名 = String(hit.名 || '')
  const base = String(hit.base || '').replace(/\/+$/, '')
  const key = String(hit.key || '').trim()
  const map = hit.map && typeof hit.map === 'object' ? hit.map : {}
  const 验 = await 验钥匙(key, base, map)
  if (!验.ok) return { ok: false, msg: '这把没验过，没敢切：' + (验.msg || '（服务端没给原因）') }
  const 康 = await 中转健康()
  if (!康.ok) {
    return { ok: false, msg: '本机网关没应答（39401），先 systemctl status fish-upstream —— 这时候切等于把她扔半路' }
  }
  const 旧 = 读中转配置() || {}
  // KEEP_UNKNOWN 2026-11-09（批次325）：先展开旧配置再覆盖 ——
  // 原来这里是白名单式重建，批次324 加的 路由/最低余额/头超时 会在每次切 key 时被写丢，
  // 表现就是「切了一次 key，路由顺序全没了」。展开旧配置能自动兼容以后新加的字段。
  const next = {
    ...旧,
    名: 名 || (base ? base.replace(/^https?:\/\//, '') : 'deepseek 官方'),
    base: base || 官方BASE,
    key,
    map,
    // 兜底沿用上一次的；如果之前没有、而这次切到第三方，就自动挂上官方做兜底
    fallback: 旧.fallback && 旧.fallback.base && 旧.fallback.key ? 旧.fallback : null,
  }
  if (!next.fallback && !/(^|\.)api\.deepseek\.com/.test(next.base)) {
    const 线上 = (() => {
      try {
        const m = /^DEEPSEEK_API_KEY=(.+)$/m.exec(readFileSync('/etc/dshbot.env', 'utf8'))
        return m ? String(m[1]).trim() : ''
      } catch { return '' }
    })()
    if (线上 && 线上 !== key) next.fallback = { base: 官方BASE, key: 线上, map: {} }
  }
  if (旧.base === next.base && 旧.key === key && JSON.stringify(旧.map || {}) === JSON.stringify(map)) {
    return { ok: true, msg: '已经在用这个上游了，没动', 生效: true, 余额: 验.余额 }
  }
  let 备份 = ''
  try { 备份 = 写中转配置(next) } catch (e) {
    return { ok: false, msg: '写中转配置失败：' + String((e && e.message) || e).slice(0, 120) }
  }
  const 后 = await 中转健康()
  const 生效 = 后.ok && 后.详情 && String(后.详情.名 || '') === String(next.名)
  return {
    ok: 生效,
    生效,
    名: next.名,
    尾: key.slice(-4),
    余额: 验.余额,
    兜底: next.fallback ? next.fallback.base : null,
    msg: 生效
      ? '已切到 ' + next.名 + '（' + 遮钥匙(key) + '），下一句就生效，没重启她' + (验.余额 !== undefined ? '；余额 ¥' + 验.余额 : '')
      : '配置写了但中转回读不一致，去看 {{BOT_ROOT}}/记忆/日志/接口中转.log 和 systemctl status fish-upstream',
    备份,
  }
}

// MUSIC_ACCOUNTS 2026-11-12：一起听支持多个网易云号，唯一真源是 {{DSH_ROOT}}/netease-accounts.json。
// 面板只读不写 cookie —— 换号要用 一起听歌.mjs --扫码 或手工把 cookie 塞进去。
const MUSIC_ACCOUNTS = process.env.QQ_MUSIC_ACCOUNTS || '{{DSH_ROOT}}/netease-accounts.json'
// LIVE_MUSIC 2026-11-12（主人：都到下一首歌了，听感还是前一首；时长严重不同步）：
// 网易云自己的「最近播放」要等**一分钟**才把新歌写进去 —— 实测 19:23 切歌、19:24:12 才出现。
// 轮询再快也快不过数据源。所以主人在 PC 上跑一个小上报器，读网易云窗口标题（「歌名 - 歌手」）
// 每 2 秒推一次，这里按它当「当前曲」；超过 20 秒没上报（关机 / 关播放器）就当没有。
function 实时曲() {
  try {
    const r = load(base + '/一起听实时.json', null)
    if (!r || !r.歌名) return null
    const at = Number(r.at) || 0
    if (Date.now() - at > 20000) return null
    return r
  } catch { return null }
}

// NOW_MUSIC 2026-11-12：给 /api/now 用的最小快照 —— 只读 一起听.json + 账号档，不碰别的文件。
// 面板每 3 秒拉它一次判断「换歌了没有」，换歌才去 loadState（重）；进度由前端本地推。
function 此刻音乐(是主人) {
  try {
    const 开 = (读接入()['一起听'] || {}).开启 !== false
    if (!开) return { 开启: false, 正在播: false, 歌名: '' }
    const m = load(base + '/一起听.json', {}) || {}
    // 上报器（读 PC 本地库那份）只要还活着，就一律以它为准。
    // 以前写成「和最近播放不同名才用它」—— 但云端那个 cookie 跟的是另一个号（胧焯 1688715169，
    // PC 客户端是 feeiyuu 3579627609），比出来永远不同名，等于每次白比一遍，
    // 歌名和进度还在两边来回跳。现在不比了，直接信它。
    const 实 = 实时曲()
    if (实) {
      const since = Number(实.since) || Number(实.at) || Date.now()
      const 长 = Number(实.durationSec) || 0
      const 进 = Math.max(0, Math.round((Date.now() - since) / 1000))
      // 听感/歌词在 一起听.json 里，只能靠 songId 认亲。对不上就是上一首的听感 ——
      // 主人报过「都到下一首了听感还是前一首」，所以宁可空着。
      const 同曲 = Number(实.songId) > 0 && Number(实.songId) === Number(m.songId)
      const 感 = 同曲 ? String(m.omniFeel || '').slice(0, 90) : ''
      return {
        开启: true,
        正在播: true,
        歌名: String(实.歌名 || ''),
        歌手: String(实.歌手 || ''),
        songId: Number(实.songId) || 0,
        // HONEST 2026-11-12（批次363）：上报器只知道歌名和「第一次看到这个标题的时刻」，
        // 不知道真实播放位置 —— 从中间开始听、或者单曲循环到第几遍，它都推不对。
        // 所以只在「推算还在第一遍内」时给进度，超了就留空：少一个数字，好过给一个错数字。
        // 等云端最近播放跟上（约 70 秒）会自动换成账号那份的真进度。
        进度秒: 长 > 0 && 进 <= 长 + 5 ? 进 : 0,
        时长秒: 长,
        同步秒: 0,
        当前号: String(读音乐账号().当前 || ''),
        年龄分: 0,
        循环次数: 1,
        // 卡片读的是 feel，两个都给（换歌替换出来的卡只读 feel 会丢掉这半句）
        听感: 感,
        feel: 感,
        实时: true,
      }
    }
    const 账 = 读音乐账号()
    const 长 = Math.round(Number(m.durationSec) || 0)
    const 龄 = m.playTime ? (Date.now() - Number(m.playTime)) : 1e12
    // STALE 2026-11-12（批次364）：兜底这份来自云端「最近播放」，而那个 cookie 跟的是
    // 另一个号（胧焯 1688715169，PC 客户端是 feeiyuu 3579627609）。
    // 超过 90 分钟的记录一律不认 —— 宁可不显示，也别把她挂在别人听的歌上。
    if (龄 > 90 * 60e3) return { 开启: true, 正在播: false, 歌名: '' }
    const 窗基 = Math.min(12 * 60e3, Math.max(180e3, 长 * 1000 + 75e3))
    // WIN 2026-11-12（批次363）：上报器正在推同一首 → 这首歌确实还开着，窗口放到 6 倍曲长。
    // 单曲循环时云端 playTime 不刷新，以前超过一首歌就被判「已播完」，卡片挂住不动。
    const 窗 = 实 ? Math.max(窗基, 长 * 1000 * 6) : 窗基
    const 在 = !m.disabled && 龄 >= -60000 && 龄 <= 窗
    return {
      开启: true,
      正在播: Boolean(在),
      歌名: String(m.name || ''),
      歌手: String(m.artist || ''),
      进度秒: 在 ? Math.max(0, Number(m.progressSec) || 0) : 0,
      时长秒: 长,
      同步秒: m.checkedAt ? Math.max(0, Math.round((Date.now() - Number(m.checkedAt)) / 1000)) : null,
      当前号: String(账.当前 || ''),
      // CARD_PATCH 2026-11-12：前端换歌时只重画那一张卡，所以要给齐卡片上的字段。
      // 听感只给主人（跟 /api/state 一个口径），客人那份是空串。
      年龄分: Math.max(0, Math.round(龄 / 60000)),
      循环次数: Number(m.replayCount || 1),
      // 同上：客人也拿听感（主人要求两边一致）
      听感: String(m.omniFeel || '').slice(0, 90),
    }
  } catch { return { 开启: true, 正在播: false, 歌名: '' } }
}

function 读音乐账号() {
  try {
    const j = JSON.parse(readFileSync(MUSIC_ACCOUNTS, 'utf8'))
    if (j && Array.isArray(j.账号)) return j
  } catch { /* 还没建过号 */ }
  return { 当前: '', 账号: [] }
}

const FLEET_CONF = process.env['FISH_FLEET_CONFIG'] || '{{DSH_ROOT}}/fish-fleet.json'

/** 接口配置（面板与接口网关共用同一份）。 */
function 读舰队配置() {
  try {
    const j = JSON.parse(readFileSync(FLEET_CONF, 'utf8'))
    if (j && Array.isArray(j.slots) && j.slots.length) return j
  } catch { /* 没有就当没接口 */ }
  return null
}

/** FLEET_SNAP 2026-11-23：{{ALT_BOT_DISPLAY}} 走接口网关，不是 {{BOT_DISPLAY}} 的接口中转。
    原来这里整段读 fish-upstream.json —— 那文件在本机根本不存在，页面一直
    「读不到接口配置」，看着像在显示 {{BOT_DISPLAY}} 的路由组。这里按接口列表派生同一套形状。 */
function 舰队快照(舰队, 康) {
  const 现在 = Date.now()
  const 描述 = (康 && 康.详情) || {}
  const 活性 = String(描述.activeSlot || 舰队.activeSlot || '')
  const 兜底 = String(舰队.fallbackSlot || '')
  const 槽们 = 舰队.slots.map((x) => ({ ...x }))
  const 型名 = (x) => String((x && (x.别名 || x.model)) || '').trim()
  const 型号序 = Array.isArray(舰队.modelOrder) && 舰队.modelOrder.length
    ? 舰队.modelOrder.map(String)
    : [...new Set(槽们.map((x) => 型名(x)).filter(Boolean))]
  // ROUTE_SLOT_2026：显示顺序要和网关实际尝试顺序一致 —— 型号 → 倍率 → 同型号内手动顺序。
  const 槽序表 = (() => {
    const 现有 = 舰队.slots.map((s) => String(s.id))
    const 排过 = Array.isArray(舰队.slotOrder) ? 舰队.slotOrder.map(String).filter((id) => 现有.includes(id)) : []
    return [...排过, ...现有.filter((id) => !排过.includes(id))]
  })()
  槽们.sort((a, b) => {
    const 位 = (x) => {
      const i = 型号序.indexOf(型名(x))
      return i < 0 ? 999 : i
    }
    const 槽 = (x) => {
      const i = 槽序表.indexOf(String(x.id))
      return i < 0 ? 999 : i
    }
    return 位(a) - 位(b) || 有效倍率(a, 现在) - 有效倍率(b, 现在) || 槽(a) - 槽(b)
  })
  const 候选 = 槽们.map((x) => ({
    id: String(x.id || ''),
    名: 型名(x) || String(x.codename || x.id || ''),
    备注: String(x.note || ''),
    遮: 遮钥匙(String(x.key || '')),
    base: String(x.base || ''),
    上游: String(x.base || '').replace(/^https?:\/\//, ''),
    查: null,
    用量: x.stats && Number(x.stats.calls) ? { calls: Number(x.stats.calls) || 0, tok: 0, cache: 0 } : null,
    map: x.model ? { default: String(x.model) } : {},
    // FLEET_MODELS_2026：前端要的是 { 列表:[{id}], 错 } 这个形状，
    // 原来给的是字符串，`选.模型.列表` 永远 undefined → 界面一直卡在「正在读模型清单…」。
    模型: {
      列表: 型号序.map((id) => ({ id })),
      错: 型号序.length ? '' : '没有登记型号',
      于: '舰队清单',
    },
    时段: '',
    时段可用: true,
    倍率: 基础倍率(x),
    峰谷: x.峰谷 === true,
    峰倍率: x.峰倍率 == null ? null : Number(x.峰倍率),
    谷倍率: x.谷倍率 == null ? null : Number(x.谷倍率),
    当前倍率: 有效倍率(x, 现在),
    谷期: 谷期(现在),
    停用: x.停用 === true,
  }))
  const 链 = 候选.map((c, i) => ({
    序: i + 1,
    id: c.id,
    名: c.名,
    上游: c.模型 || c.上游,
    跳过: '',
    连续失败: 0,
    余额: null,
    最后: String((槽们[i].stats && 槽们[i].stats.lastAt) || ''),
    倍率: c.倍率,
    当前倍率: c.当前倍率,
    峰谷: c.峰谷,
    峰倍率: c.峰倍率,
    谷倍率: c.谷倍率,
    谷期: c.谷期,
    停用: c.停用,
  }))
  const 现 = {
    名: '模型接口',
    组名: '模型接口',
    上游: '127.0.0.1:8083',
    路由: 候选.map((c) => c.id),
    fallback: 兜底 ? { base: '127.0.0.1:8083' } : null,
  }
  const health = { 先试: 活性, 路由: 链 }
  const 最近 = 槽们
    .filter((x) => x.stats && x.stats.lastAt && !x.stats.lastErr)
    .sort((a, b) => String(b.stats.lastAt).localeCompare(String(a.stats.lastAt)))[0]
  return {
    ok: true,
    模型选项: [...new Set(候选.map((c) => c.模型).filter(Boolean))],
    中转: {
      活着: !!(康 && 康.ok),
      名: 最近 ? 型名(最近) : '接口 · 127.0.0.1:39401',
      在用: 最近 ? { 名: 型名(最近), 模型: 最近.model || '', 于: 最近.stats.lastAt } : null,
      上游: '127.0.0.1:8083',
      遮: '',
      尾: '',
      模型映射: {},
      兜底: 兜底 ? '备用 ' + 兜底 : '',
      health: 康 ? 康.详情 : null,
    },
    路由: { 源: '型号优先 + 倍率', 先试: 链[0] ? 链[0].id : '', 链, 最低余额: 0, 型号序 },
    候选,
    四层: 派生四层({ 候选, 现, health, 康, 监听: '127.0.0.1:39401' }),
    文件: FLEET_CONF,
    配置: FLEET_CONF,
  }
}

/** 快照：中转当前在用什么 + 候选清单（全部打码）。 */
function 接口快照(康) {
  const 舰队 = 读舰队配置()
  if (舰队) return 舰队快照(舰队, 康)
  const 现 = 读中转配置() || {}
  const health = 康 && 康.详情 ? 康.详情 : null
  // KEY_USAGE 2026-11-09（批次313）：每把钥匙今天用了多少。
  // 数据来自中转的日汇总，按「上游名」累计 —— 同一个上游挂两把钥匙时分不开
  // （请求里只有 key，记账只记了名）。要精确到钥匙，得在记账时加 key 尾号，另开一批。
  // IDENTITY 2026-11-09（批次334）：先按 id 查（改名不影响），老档再按名字兜底
  let 用量名 = {}
  let 用量钥 = {}
  try {
    const j = JSON.parse(readFileSync('{{DSH_ROOT}}/fish-usage.json', 'utf8'))
    用量名 = j.byName || {}
    用量钥 = j.byId || {}
  } catch { /* 没有就当空 */ }
  const 取用量 = (x) => {
    const u = 用量钥[String(x.id || '')] || 用量名[String(x.名 || '')] || 用量名[String(x.base || '')]
    if (!u) return null
    return {
      calls: Number(u.calls) || 0,
      tok: (Number(u.in) || 0) + (Number(u.out) || 0),
      cache: Number(u.cache) || 0,
    }
  }
  const 原候选 = 读候选钥匙()
  const 现在 = Date.now()
  const 候选 = 原候选.map((x) => ({
    id: String(x.id || ''),
    名: String(x.名 || ''),
    备注: String(x.备注 || ''),
    遮: 遮钥匙(x.key),
    base: String(x.base || ''),
    上游: String(x.base || '（deepseek 官方）').replace(/^https?:\/\//, ''),
    查: x.查 || null,
    用量: 取用量(x),
    // SWITCH_MODEL 2026-11-09（批次320）：把映射也带出去，前端才能显示「发什么→实际用什么」
    map: (x.map && typeof x.map === 'object') ? x.map : {},
    模型: x.模型 || null,
    时段: 候选时段(x),
    时段可用: 凭证可用(原候选, x.key, 现在),
    倍率: 基础倍率(x),
    峰谷: x.峰谷 === true,
    峰倍率: x.峰谷 === true && x.峰倍率 != null && Number.isFinite(Number(x.峰倍率)) ? Number(x.峰倍率) : null,
    谷倍率: x.峰谷 === true && x.谷倍率 != null && Number.isFinite(Number(x.谷倍率)) ? Number(x.谷倍率) : null,
    当前倍率: 有效倍率(x, 现在),
    谷期: 谷期(现在),
    停用: x.停用 === true,
  }))
  // 候选模型：内置几个常见的 + 候选/当前已经用到的。
  // 为什么不做「从上游拉列表」：portdan 的 /v1/models 对 sk- key 返回 401（它要的是后台登录态），
  // 用不存在的模型名试探也只回「not supported」不列清单。所以这里给候选 + 允许手填，
  // 真正能不能用由 action:'map' 发一条真请求验。
  const 模型集 = new Set(['deepseek-v4.1-flash', 'deepseek-v4-pro', 'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'])
  for (const c of 候选) for (const v of Object.values(c.map || {})) if (v) 模型集.add(String(v))
  for (const v of Object.values(现.map || {})) if (v) 模型集.add(String(v))
  return {
    ok: true,
    模型选项: [...模型集],
    中转: {
      活着: !!(康 && 康.ok),
      名: String(现.名 || ''),
      上游: String(现.base || '').replace(/^https?:\/\//, ''),
      遮: 遮钥匙(现.key),
      尾: 现.key ? String(现.key).slice(-4) : '',
      模型映射: 现.map || {},
      兜底: 现.fallback && 现.fallback.base ? String(现.fallback.base).replace(/^https?:\/\//, '') : '',
      health,
    },
    // ROUTE 2026-11-09（批次324/325）：路由链。
    // 链本身由中转算（它才知道冷却和余额），这里只是搬过来。
    // 中转挂了（health 为 null）就退回「配置里排的 id 顺序」，至少能看到主人排的意图。
    路由: {
      源: (Array.isArray(现.路由) && 现.路由.length) ? '已排' : '未排（只走当前这把）',
      先试: health?.先试,
      链: (health && Array.isArray(health.路由) && health.路由.length)
        ? health.路由
        : (Array.isArray(现.路由) ? 现.路由 : []).map((id, i) => {
            const c = 候选.filter((x) => String(x.id || '') === String(id))[0]
            return {
              序: i + 1, id: String(id), 名: c ? String(c.名 || '') : '（已删除）',
              上游: c ? String(c.base || '').replace(/^https?:\/\//, '') : '',
              跳过: '', 连续失败: 0, 余额: null, 最后: '',
              倍率: c ? 基础倍率(c) : 1,
              当前倍率: c ? 有效倍率(c, 现在) : 1,
              峰谷: c ? c.峰谷 === true : false,
              峰倍率: c && c.峰倍率 != null && Number.isFinite(Number(c.峰倍率)) ? Number(c.峰倍率) : null,
              谷倍率: c && c.谷倍率 != null && Number.isFinite(Number(c.谷倍率)) ? Number(c.谷倍率) : null,
              谷期: 谷期(现在),
              停用: c ? c.停用 === true : false,
            }
          }),
      最低余额: Number(现.最低余额) || 0.5,
    },
    候选,
    // LAYERS 2026-11-17（批次669）：四层视图（供应商 / 路由 / 路由组 / 网关）。
    //
    // 起因：主人指出「换的顺序」只剩官方一条，看着像密钥丢了。根因在 668（探测脚本清空路由），
    // 但更根本的是**这套东西没有层级**：一条候选里同时揉着供应商身份、凭证、上游地址、
    // 模型映射和健康状态，「路由」只是一个 id 数组。出任何问题都只能靠猜是哪一层坏了。
    //
    // 这里把现有数据**派生**成四层给前端画，不改存储、不改选路逻辑：
    //   供应商 = 按 base 归并（空 base = deepseek 官方）；同一供应商下几把 key 是并列候选。
    //   路由   = 候选（一把 key + 它的模型映射 + 健康）。
    //   路由组 = 配置里的「路由」id 数组 + 策略（当前只有 order）。
    //   网关   = 中转自己（监听地址、当前指针、兜底）。
    // 纯派生：删掉这段，`中转` / `路由` / `候选` 三个老字段完全不受影响。
    四层: 派生四层({ 候选, 现, health, 康 }),
    文件: API_KEYS_FILE,
    配置: UPSTREAM_CONF,
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BALANCE 2026-11-08（批次286）：WebUI 顶部的余额 / 用量
//
// 谁能看：**登录了就能看，客人也看**——只给一个数字，不含任何 key 片段。
// 为什么不全显示「钱」：
//   deepseek 官方有 /user/balance，能拿真余额；
//   portdan 这类中转站没有「用 sk 钥匙查余额」的接口（/v1/dashboard/*、
//   /api/user/* 全是 404，余额只在它自己的登录后台里），所以那边显示的是
//   **接口中转自己记的当日用量**（调用次数 / token），不假装有钱。
//
// 缓存 5 分钟：面板刷得再勤也不去打上游；手动刷（force=1）15 秒内只放一次。
const BALANCE_CACHE = process.env.FISH_BALANCE_CACHE || '{{DSH_ROOT}}/fish-balance.json'
const USAGE_FILE = process.env.FISH_USAGE_FILE || '{{DSH_ROOT}}/fish-usage.json'
const BALANCE_TTL = 5 * 60 * 1000
const BALANCE_FORCE_GAP = 15 * 1000
let 上次强刷 = 0

/**
 * 今日（北京时间）的用量行。中转没记账就给 0，绝不编。
 * 口径统一走**流水**（和「用量」页同一份数据），流水还没有（刚重启/刚清）才退回
 * 中转的日汇总 —— 否则顶部余额胶囊和用量页会显示两个不一样的「今日次数」。
 */
function 今日用量(名) {
  const 今 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  try {
    const rows = 读流水().filter((r) => String(r.at || '').slice(0, 10) === 今 && (!名 || r.上游 === 名))
    if (rows.length > 0) {
      return rows.reduce((acc, r) => ({
        calls: acc.calls + 1,
        in: acc.in + (Number(r.入) || 0),
        out: acc.out + (Number(r.出) || 0),
      }), { calls: 0, in: 0, out: 0 })
    }
  } catch { /* 流水读不到就退回汇总 */ }
  try {
    const j = JSON.parse(readFileSync(USAGE_FILE, 'utf8'))
    if (!j || j.date !== 今 || !j.byName) return { calls: 0, in: 0, out: 0 }
    const row = j.byName[名] || j.byName[''] || {}
    return { calls: Number(row.calls) || 0, in: Number(row.in) || 0, out: Number(row.out) || 0 }
  } catch { return { calls: 0, in: 0, out: 0 } }
}

function 读余额缓存() {
  try { return JSON.parse(readFileSync(BALANCE_CACHE, 'utf8')) } catch { return null }
}

function 写余额缓存(value) {
  try {
    _mkd('{{DSH_ROOT}}', { recursive: true })
    const tmp = BALANCE_CACHE + '.tmp'
    writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 })
    _rn(tmp, BALANCE_CACHE)
  } catch { /* 缓存写不了不影响返回 */ }
}

/**
 * 取余额：先看缓存（5 分钟），过期才打上游。
 * 失败也返回一个能显示的对象（ok:false + 原因），前端不至于空着。
 */
async function 取余额(force) {
  // FLEET_BALANCE 2026-11-23：{{ALT_BOT_DISPLAY}} 走黑奴舰队（gemini-web2api），没有「余额」接口。
  // 原来这里读 fish-upstream.json，页面只剩一句「还没配置上游」—— 只能报今日调用量。
  const 舰队余额 = 读舰队配置()
  if (舰队余额) {
    const 今 = 今日用量('')
    return { ok: true, 类型: 'usage', 供应商: '模型接口', 上游: '127.0.0.1:8083',
      取于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
      今日: 今, 说明: 'gemini-web2api 不计费，只报今日调用' }
  }
  const c = 读中转配置()
  if (!c) return { ok: false, 供应商: '', 说明: '还没配置上游', 今日: 今日用量('') }
  if (!凭证可用(读候选原档(), c.key)) return { ok: false, 供应商: c.名, 说明: '不在允许时段，未刷新余额', 今日: 今日用量(c.名 || '') }
  const base = String(c.base || '')
  const 名 = String(c.名 || '')
  // OFFICIAL_MATCH 2026-11-09（批次321）：原来用 /(^|\.)api\.deepseek\.com/，
  // 要求前面是行首或点；而 base 是 'https://api.deepseek.com/anthropic'，前面是 '//'，
  // 于是官方被判成中转站 → 去打 /anthropic/v1/usage → 404 → 胶囊显示「余额读不到」。
  const 是官方 = base === '' || base.includes('api.deepseek.com')
  // 尾 6 位而不是 4 位：两把 sk-…abcd 撞尾的概率比想象中高，撞了就会显示别人的余额
  const 键 = String(c.key || '').slice(-6) + '|' + base
  const 缓存 = 读余额缓存()
  const now = Date.now()
  const 新鲜 = 缓存 && 缓存.键 === 键 && now - Number(缓存.取于 || 0) < BALANCE_TTL
  if (!force && 新鲜) return { ...缓存.数据, 缓存: true }
  if (force && 新鲜 && now - 上次强刷 < BALANCE_FORCE_GAP) {
    return { ...缓存.数据, 缓存: true, 说明: '刚刷过，15 秒内不重复打上游' }
  }
  上次强刷 = now

  const out = {
    ok: true,
    类型: 是官方 ? 'balance' : 'usage',
    供应商: 名 || (base ? base.replace(/^https?:\/\//, '') : 'deepseek 官方'),
    上游: base ? base.replace(/^https?:\/\//, '') : 'api.deepseek.com',
    取于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
  }
  if (是官方) {
    try {
      const host = base && base.includes('/anthropic') ? 'https://api.deepseek.com' : (base || 'https://api.deepseek.com')
      const r = await fetch(host + '/user/balance', {
        headers: { authorization: 'Bearer ' + String(c.key || '') },
        signal: AbortSignal.timeout(12000),
      })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch { /* 非 JSON */ }
      // NEG_BALANCE 2026-11-19（批次745）：欠费时上游回 is_available:false，但
      // balance_infos 里的 total_balance 是**真数字**（这次是 -0.10）。旧写法把它
      // 当成「没给数据」，胶囊就只剩一句「余额读不到」——而主人真正要知道的正是
      // 「已经欠费了」。现在只要有 balance_infos 就照实显示，可用性另标一个字段。
      if (!r.ok || !j || !Array.isArray(j.balance_infos) || !j.balance_infos.length) {
        out.ok = false
        out.说明 = '余额接口没给数据：' + String((j && j.error && j.error.message) || t || ('HTTP ' + r.status)).slice(0, 120)
      } else {
        const bi = (j.balance_infos || [])[0] || {}
        out.余额 = Number(bi.total_balance || 0)
        out.币 = bi.currency || 'CNY'
        out.赠送 = Number(bi.granted_balance || 0)
        out.可用 = j.is_available === true
        if (!out.可用) out.说明 = '上游标记账户不可用（余额不足/欠费），充值后恢复'
      }
    } catch (e) {
      out.ok = false
      out.说明 = '连不上余额接口：' + String((e && e.message) || e).slice(0, 100)
    }
  } else {
    // PORTDAN_BALANCE 2026-11-09（批次315）：中转站其实支持用 key 查余额。
    // 批次286 当时试的是 /v1/dashboard/* 和 /api/user/*（全 404），就以为没有、只显示本机记账。
    // 找到的依据：magpie 的 providers-state.json 里记着
    //   balanceFound = https://portdan.com/v1/usage，balanceFoundField = $remaining
    // 实测返回：{remaining:17.31, unit:"USD", planName:"钱包余额",
    //   daily_usage:[{date, requests, input_tokens, output_tokens, cache_read_tokens, cost, actual_cost}]}
    // actual_cost 是**折后真实扣费**（缓存命中便宜十倍），比按牌价估的 cost 准得多。
    try {
      const url = base.replace(/\/+$/, '') + '/v1/usage'
      const r = await fetch(url, {
        headers: { authorization: 'Bearer ' + String(c.key || '') },
        signal: AbortSignal.timeout(12000),
      })
      const t = await r.text()
      let j = null
      try { j = JSON.parse(t) } catch { /* 非 JSON */ }
      const 钱 = j && (typeof j.remaining === 'number' ? j.remaining : (typeof j.balance === 'number' ? j.balance : null))
      if (r.ok && 钱 !== null) {
        out.ok = true
        out.类型 = 'balance'
        out.余额 = 钱
        out.币 = String(j.unit || 'USD')
        out.计划 = String(j.planName || '')
        // 上游自己算的今日账：次数/token/实际扣费。跟本机流水交叉着看，
        // 对不上说明有请求没经过中转（比如别的设备直接打上游）。
        const 今 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
        const 日 = (Array.isArray(j.daily_usage) ? j.daily_usage : []).find((x) => String(x && x.date) === 今) || null
        if (日) {
          out.今日上游 = {
            次: Number(日.requests) || 0,
            入: Number(日.input_tokens) || 0,
            出: Number(日.output_tokens) || 0,
            缓读: Number(日.cache_read_tokens) || 0,
            扣费: Number(日.actual_cost) || 0,
            牌价: Number(日.cost) || 0,
          }
        }
      } else {
        out.ok = false
        out.说明 = '余额接口没给数据：' + String((j && (j.error || j.message)) || t || ('HTTP ' + r.status)).slice(0, 100)
      }
    } catch (e) {
      out.ok = false
      out.说明 = '连不上余额接口：' + String((e && e.message) || e).slice(0, 100)
    }
    if (!out.说明) out.说明 = ''
  }
  out.今日 = 今日用量(名)
  写余额缓存({ 键, 取于: now, 数据: out })
  return out
}

// ═══════════════════════════════════════════════════════════════════════════
// USAGE 2026-11-08（批次287）：token 用量页
//
// 数据来源只有一个：接口中转（39301）写的逐次流水 {{DSH_ROOT}}/fish-usage-log.jsonl。
// 为什么要中转来记：dsh 的调用不经过我们，只有中转看得见每次请求的 usage。
// 「因为什么用的」= 这次请求里**末条用户消息的头 32 字** + 用途分类
// （带 tool_result 的叫「工具回填」、带图的叫「看图」、其余叫「对话」）。
// 只记摘要，不记她的回复全文；列表只给主人，客人只拿汇总数字。
const USAGE_LOG = process.env.FISH_USAGE_LOG || '{{DSH_ROOT}}/fish-usage-log.jsonl'
// RENAME_SYNC 2026-11-09（批次333）：改过名字的钥匙，旧名字 → 新名字。
// 为什么不直接改流水文件：中转正在 append，重写会把正在写的那几行吞掉。
// 这里只维护一张映射，汇总时现算，既不动历史、也可逆。
const 别名文件 = process.env.FISH_ALIAS_FILE || '{{DSH_ROOT}}/fish-name-alias.json'

function 读别名() {
  try {
    const j = JSON.parse(readFileSync(别名文件, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch { return {} }
}

/** 顺着映射链一直找到最新的名字。改过两次名也能到对的地方，带防环。 */
function 正名(名, 别名) {
  let n = String(名 || '')
  const 别名表 = 别名 || {}
  const 走过 = new Set()
  while (别名表[n] && !走过.has(n)) { 走过.add(n); n = String(别名表[n]) }
  return n
}

/** 记一条 旧名 → 新名；之前指向「旧名」的也要跟着指到「新名」，否则链就断了。 */
function 记别名(旧, 新) {
  const a = String(旧 || '').trim()
  const b = String(新 || '').trim()
  if (!a || !b || a === b) return false
  try {
    const m = 读别名()
    for (const k of Object.keys(m)) if (String(m[k]) === a) m[k] = b
    m[a] = b
    delete m[b] // 新名字自己不用再映射
    const tmp = 别名文件 + '.tmp'
    writeFileSync(tmp, JSON.stringify(m, null, 2), { encoding: 'utf8', mode: 0o600 })
    _rn(tmp, 别名文件)
    return true
  } catch { return false }
}

/** 当天的累计是按「名字」存的（中转写的 fish-usage.json:byName），改名时要把旧账并过去。 */
function 合并当日用量(旧, 新) {
  try {
    const p = '{{DSH_ROOT}}/fish-usage.json'
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (!j || !j.byName || !j.byName[旧]) return false
    const a = j.byName[旧]
    const b = j.byName[新] || (j.byName[新] = { calls: 0, in: 0, out: 0, cache: 0 })
    b.calls = (Number(b.calls) || 0) + (Number(a.calls) || 0)
    b.in = (Number(b.in) || 0) + (Number(a.in) || 0)
    b.out = (Number(b.out) || 0) + (Number(a.out) || 0)
    b.cache = (Number(b.cache) || 0) + (Number(a.cache) || 0)
    delete j.byName[旧]
    const tmp = p + '.tmp'
    writeFileSync(tmp, JSON.stringify(j, null, 2), { encoding: 'utf8', mode: 0o600 })
    _rn(tmp, p)
    return true
  } catch { return false }
}

let __流水缓存 = { key: '', rows: [] }
function 读流水() {
  let key = ''
  for (const f of [USAGE_LOG + '.1', USAGE_LOG]) {
    try { const s = _st(f); key += f + ':' + s.size + ':' + Math.floor(s.mtimeMs) + '|' } catch { key += f + ':none|' }
  }
  if (key && key === __流水缓存.key) return __流水缓存.rows
  const out = []
  for (const f of [USAGE_LOG + '.1', USAGE_LOG]) {
    try {
      const text = readFileSync(f, 'utf8')
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try { out.push(JSON.parse(line)) } catch { /* 半截行跳过 */ }
      }
    } catch { /* 没有就没有 */ }
  }
  __流水缓存 = { key, rows: out }
  return out
}

/**
 * 测试噪音（批次466）：t353 注入假 fetch，却没把 FISH_USAGE_LOG 指到沙盒，于是往真流水里写了
 * 「omni + 结果 ok + 0 token + 十几毫秒」的记录（历史 366 条）。真调用不可能这么快 ——
 * 实测 omni 单次 0.6~6.5 秒，走公网到 DashScope；TTS 也只会更慢。
 * 这个判据只用来**把假记录从统计里剔掉**，不删文件（历史不可逆）。
 */
function 是测试噪音(r) {
  if (!r || !r.omni) return false
  const tok = (Number(r.入) || 0) + (Number(r.出) || 0)
  const 毫秒 = Number(r.用时毫秒) || 0
  return tok === 0 && 毫秒 < 100 && String(r.结果 || 'ok') === 'ok'
}

/**
 * 探测上游的探针（批次466）：每 10 分钟打 3 次模型，一天约 590 次，全部记成「对话」。
 * 后果是「她今天说了 1512 次话」里有 593 次是她根本没参与的连通性测试 —— 摘要那一栏
 * 还会显示「调用 probe 工具，x 填 ok」。改标记不改口径：钱是真花的，所以留在合计里，
 * 但按用途单独一类，别让人把它当成她在说话。
 */
function 是探针(r) {
  return String((r && r.摘要) || '').startsWith('调用 probe 工具')
}

/**
 * TITLE_NOISE 2026-11-14（批次487）：宿主的「给会话起个标题」也是走同一条 LLM 通道的，
 * 今天 173 次（每次 700~900 token），摘要以 `Generate the session title` 开头。
 * 它原来混在「对话」里 —— 面板上看到「对话 2175 次」会以为她说了这么多话，
 * 其实其中 173 次是标题生成。归到「标题生成」一类。
 * 它和探针的区别：探针是主动监控，标题是宿主行为，两者都不是她在说话。
 */
function 是标题(r) {
  return String((r && r.摘要) || '').startsWith('Generate the session title')
}

/**
 * 取上游账单（批次316）—— 余额、今天/昨天真实扣费、逐日消耗。
 *
 * 数据源：`GET <上游>/v1/usage`（portdan 这类站支持，用 key 就能查）。
 * 为什么值得单独拉：它给的 `actual_cost` 是**折后真实扣费**，缓存命中的输入
 * 只按一成计价 —— 我们自己按牌价估会高估四倍（今天牌价 1.10 / 实际 0.22）。
 * 官方 deepseek 没有这个接口（走 /user/balance），返回 null，前端显示「查不到」。
 */
// CACHE_BY_KEY 2026-11-09（批次318）：缓存必须带键。
// 原来只按时间判断 —— 换 key 之后 5 分钟内还返回**旧 key 的余额**，
// 表现就是「我换了 key，用量页的余额没变」。键 = key 尾 6 位 + 上游，跟 取余额 同一口径。
let 账单缓存 = { 键: '', at: 0, 数据: null }
async function 取上游账单() {
  const c = 读中转配置()
  if (!c || !凭证可用(读候选原档(), c.key)) return null
  const 键 = String(c.key || '').slice(-6) + '|' + String(c.base || '')
  if (账单缓存.数据 && 账单缓存.键 === 键 && Date.now() - 账单缓存.at < 5 * 60e3) return 账单缓存.数据
  const base = String(c.base || '').replace(/\/+$/, '')
  if (base === '' || /api\.deepseek\.com/.test(base)) return null
  try {
    const r = await fetch(base + '/v1/usage', {
      headers: { authorization: 'Bearer ' + String(c.key || '') },
      signal: AbortSignal.timeout(12000),
    })
    const j = await r.json()
    const 钱 = typeof j.remaining === 'number' ? j.remaining : (typeof j.balance === 'number' ? j.balance : null)
    if (!r.ok || 钱 === null) return null
    const 今 = (j.usage && j.usage.today) || {}
    const 日 = Array.isArray(j.daily_usage) ? j.daily_usage : []
    // daily_usage 只有最近几天；昨天不一定是「昨天」，取倒数第二条（不含今天那条）
    const 今天 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    const 昨 = 日.filter((x) => String(x && x.date) !== 今天).slice(-1)[0] || null
    const 扣 = (Number(今.actual_cost) || 0)
    const 昨扣 = 昨 ? (Number(昨.actual_cost) || 0) : 0
    // 还能撑几天：有昨天的数就用昨天，没有就用今天；都没有就不猜
    const 日均 = 昨扣 > 0 ? 昨扣 : 扣
    const out = {
      ok: true,
      余额: 钱,
      币: String(j.unit || 'USD'),
      计划: String(j.planName || ''),
      模式: String(j.mode || ''),
      今日: {
        次: Number(今.requests) || 0,
        入: Number(今.input_tokens) || 0,
        出: Number(今.output_tokens) || 0,
        缓读: Number(今.cache_read_tokens) || 0,
        扣费: 扣,
        牌价: Number(今.cost) || 0,
      },
      昨天: 昨 ? { 日: String(昨.date || ''), 次: Number(昨.requests) || 0, 扣费: 昨扣, 牌价: Number(昨.cost) || 0 } : null,
      按天: 日.map((x) => ({
        日: String((x && x.date) || '').slice(5),
        次: Number(x.requests) || 0,
        扣费: Number(x.actual_cost) || 0,
        牌价: Number(x.cost) || 0,
        入: Number(x.input_tokens) || 0,
        缓读: Number(x.cache_read_tokens) || 0,
      })),
      还能撑天: 日均 > 0 ? Math.round((钱 / 日均) * 10) / 10 : null,
      取于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' '),
    }
    账单缓存 = { 键, at: Date.now(), 数据: out }
    return out
  } catch { return null }
}

// ── OMNI 接入（听 / 说）2026-11-12 ─────────────────────────────
// 主人要「像接口界面那样实时换 key，接别的模型让她听声音和发语音」。
// 跟「她的接口」一个思路：配置写文件，调用方每次现读 —— 改完下一句生效，不重启任何进程。
//   听：{{DSH_ROOT}}/fish-omni.json 的「听」段，视频音频.mjs 读它调 omni
//   说：同一个文件的「说」段，语音合成.mjs 读它做 TTS
// key 留空 = 回退环境变量（/etc/dshbot.env 里原来那套），所以不配也照样能跑。
const 接入档路径 = '{{DSH_ROOT}}/fish-omni.json'
const 试听目录 = '{{BOT_ROOT}}/共享/面板试听'
const 读接入 = () => load(接入档路径, {})
function 存接入(o) {
  写档(接入档路径, o)
  // 里面有明文 key：权限必须是 600。设不上只记一笔，不算保存失败。
  try { chmodSync(接入档路径, 0o600) } catch { /* 文件系统不给就算了 */ }
}
// 打码只留头尾，够认出是哪把，不够拿去用
function 遮(k) {
  const s = String(k || '')
  if (!s) return ''
  return s.length <= 12 ? '•'.repeat(s.length) : (s.slice(0, 6) + '…' + s.slice(-4))
}
function 接入快照() {
  const c = 读接入()
  const 听 = c['听'] || {}, 说 = c['说'] || {}, 看 = c['看视频'] || {}, 歌配 = c['一起听'] || {}
  const 看模 = String(看.模式 || c.videoMode || '').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'omni'
  const 歌开 = 歌配.开启 !== false
  const 歌态 = load(base + '/一起听.json', {}) || {}
  const 环 = process.env
  const 听key = String(听.key || 环.DASHSCOPE_API_KEY || '')
  const 听base = String(听.base || 环.DASHSCOPE_BASE_URL || '')
  const 听up = String(听.upload || 环.DASHSCOPE_UPLOAD_URL || '')
  const 说key = String(说.key || 环.DASHSCOPE_API_KEY || '')
  const 说base = String(说.base || 环.DASHSCOPE_BASE_URL || '')
  return {
    ok: true,
    听: {
      名: String(听.名 || 'omni'),
      base: 听base,
      upload: 听up,
      模型: String(听.模型 || 环.DASHSCOPE_MODEL || 'qwen3.8-omni-flash'),
      遮: 遮(听.key),
      来源: 听.key ? '配置' : (环.DASHSCOPE_API_KEY ? '环境变量' : '没有'),
      可用: Boolean(听key && 听base && 听up),
    },
    说: (() => {
      // 用 语音合成.mjs 自己那份口径：它会把 compatible-mode/v1 推成 api/v1，
      // 面板显示的就是真要去请求的地址，不是配置里那串半成品。
      const 实 = 说配置()
      return {
        协议: 实.协议,
        base: 实.base,
        模型: 实.模型,
        音色: 实.音色,
        遮: 遮(说.key),
        来源: 说.key ? '配置' : (环.DASHSCOPE_API_KEY ? '环境变量' : '没有'),
        可用: 实.协议 === 'gptsovits' ? Boolean(实.base) : Boolean(实.key && 实.base),
      }
    })(),
    看视频: {
      模式: 看模,
      插件可用: existsSync('{{DSH_ROOT}}/profiles/web/vendor/dsh-video-storyboard/package.json'),
    },
    一起听: (() => {
      const 账 = 读音乐账号()
      return {
        开启: 歌开,
        正在播: Boolean(歌开 && 歌态.ok && 歌态.active && !歌态.disabled),
        歌名: String(歌态.name || ''),
        歌手: String(歌态.artist || ''),
        切歌分: Number.isFinite(Number(歌态.ageMin)) ? Number(歌态.ageMin) : null,
        // 播到第几秒：最近播放只给「开始时刻」，按它往后推，封顶到曲长
        进度秒: Number.isFinite(Number(歌态.progressSec)) ? Number(歌态.progressSec) : 0,
        时长秒: Number.isFinite(Number(歌态.durationSec)) ? Number(歌态.durationSec) : 0,
        // 上一次同步距现在多少秒 —— 「不同步」的时候先看这个数
        同步秒: 歌态.checkedAt ? Math.max(0, Math.round((Date.now() - Number(歌态.checkedAt)) / 1000)) : null,
        当前号: String(账.当前 || ''),
        账号: (账.账号 || []).map((x) => ({ id: String(x.id || ''), 名: String(x.名 || x.id || '') })),
      }
    })(),
    改于: String(c.改于 || ''),
  }
}

// OMNI_MODELS 2026-11-12：从 {base}/models 拉这个 key 真能用的模型，按用途分类。
// 「自动识别」不是猜模型名 —— 编一个去请求只会得到 Model not exist（qwen-tts 就这么栽的）。
// 把清单列出来、标出哪些能做语音合成、哪些能听音频/视频，点一下填进去。
const 像听 = (id) => /omni|audio|vision|realtime/i.test(id) && !/tts|asr|speech|voice/i.test(id)
const 像说 = (id) => (/tts|speech|voice|cosy|sami/i.test(id) || /^qwen3(\.5)?-omni-(flash|plus)$/i.test(id)) && !/asr|realtime/i.test(id)

// LOCAL_VOICE 2026-11-12（批次370）：本机 GPT-SoVITS 的音色包与权重档。
// 起因：协议选的是 gptsovits，面板「模型」里却摆着云端模型名，主人问「本地的去哪了」。
// 而 9880 本身有 /set_sovits_weights 与 /set_gpt_weights，可以运行时热换 —— 不用重启。
const 音色根 = '/data/gpt-sovits/voices'
const 语音配置 = '/data/gpt-sovits/GPT_SoVITS/configs/fish_tts.yaml'
const 本机TTS地址 = 'http://127.0.0.1:9880'

/** yaml 的 custom 段在最前面，后面的 v1:/v2:… 也有同名字段，所以只切前半段处理。 */
function 语配置头() {
  const t = readFileSync(语音配置, 'utf8')
  const 切 = t.indexOf('\nv1:')
  return { 头: 切 > 0 ? t.slice(0, 切) : t, 尾: 切 > 0 ? t.slice(切) : '' }
}

function 当前权重() {
  try {
    const { 头 } = 语配置头()
    const so = (/^ {2}vits_weights_path:\s*(.+)$/m.exec(头) || [])[1] || ''
    const gp = (/^ {2}t2s_weights_path:\s*(.+)$/m.exec(头) || [])[1] || ''
    return { sovits: so.trim(), gpt: gp.trim() }
  } catch { return { sovits: '', gpt: '' } }
}

function 档列表(目录, 后缀) {
  let 文件们 = []
  try { 文件们 = _rd(目录) } catch { return [] }
  return 文件们.filter((f) => f.endsWith(后缀)).map((f) => {
    const 完整 = 目录 + '/' + f
    let 字节 = 0, 改 = ''
    // MTIME_UTC 2026-11-14（批次442）：`s.mtime` 是文件系统的 UTC 时间，直接 toISOString()
    // 出来就是 UTC —— 面板上「改」那一列比北京时间早 8 小时，主人会照它判断「这份音色是不是刚训完」。
    // 同一个文件里另外 5 处显示时间（320/988/1003 行）都是 `mtimeMs + 8 * 3600e3`，只有这里漏了。
    // 注意别一刀切：算「距今多久」的（`Date.now() - mtimeMs`）不需要 +8，只有**显示给人看**的才要。
    try { const s = _st(完整); 字节 = s.size; 改 = new Date(s.mtime.getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') } catch { /* 读不到就留空 */ }
    // 文件名里的 eN 就是训练轮次：feiyu_e3_s231.pth / feiyu-e12.ckpt
    const m = /-?e(\d+)/.exec(f)
    return { 文件: f, 路径: 完整, 轮: m ? Number(m[1]) : 0, 字节, 改 }
  }).sort((a, b2) => a.轮 - b2.轮)
}

function 本地音色档() {
  const 包 = []
  try {
    for (const 名 of _rd(音色根)) {
      const 目录 = 音色根 + '/' + 名
      try { if (!_st(目录).isDirectory()) continue } catch { continue }
      const sovits = 档列表(目录 + '/weights', '.pth')
      const gpt = 档列表(目录 + '/weights', '.ckpt')
      if (!sovits.length && !gpt.length) continue
      包.push({ 名, sovits, gpt })
    }
  } catch { /* 目录不在就当空 */ }
  return { ok: true, 根: 音色根, 当前: 当前权重(), 包 }
}

async function 换权重(sovits, gpt) {
  const so = String(sovits || '').trim()
  const gp = String(gpt || '').trim()
  const 合法 = (p) => p === '' || (p.startsWith(音色根 + '/') && p.indexOf('..') < 0 && /\.(pth|ckpt)$/.test(p))
  if (!合法(so) || !合法(gp)) return { ok: false, msg: '路径不合法（只认 voices 目录下的 .pth / .ckpt）' }
  if (!so && !gp) return { ok: false, msg: '两个都没选' }
  const 调 = async (端点, p) => {
    const r = await fetch(本机TTS地址 + 端点 + '?weights_path=' + encodeURIComponent(p), { signal: AbortSignal.timeout(120000) })
    const t = await r.text()
    if (!r.ok) throw new Error(端点 + ' HTTP ' + r.status + '：' + t.slice(0, 120))
    return t.trim().slice(0, 120)
  }
  const 结果 = []
  try {
    if (so) 结果.push('SoVITS ' + (await 调('/set_sovits_weights', so)))
    if (gp) 结果.push('GPT ' + (await 调('/set_gpt_weights', gp)))
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e).slice(0, 200), 当前: 当前权重() }
  }
  // 写回 yaml：只动 custom 段的这两行。写不进去也不影响这次生效。
  try {
    const { 头, 尾 } = 语配置头()
    let 新头 = 头
    if (so) 新头 = 新头.replace(/^ {2}vits_weights_path:.*$/m, '  vits_weights_path: ' + so)
    if (gp) 新头 = 新头.replace(/^ {2}t2s_weights_path:.*$/m, '  t2s_weights_path: ' + gp)
    if (新头 !== 头) writeFileSync(语音配置, 新头 + 尾)
  } catch { /* 忽略 */ }
  return { ok: true, 结果, 当前: 当前权重() }
}

const 滤开关文件 = '{{DSH_ROOT}}/fish-leak.json'
const 探测档文件 = '{{DSH_ROOT}}/upstream-probe.json'

/** 上游探测结果（探测上游.mjs 每 10 分钟写一次）。 */
function 读探测() {
  try {
    return { ok: true, 探测: JSON.parse(readFileSync(探测档文件, 'utf8')) }
  } catch {
    return { ok: true, 探测: null }
  }
}

/** 读接口层「滤推演块」开关。文件不在就当开着 —— 泄漏比慢半秒难受。 */
function 读滤开关() {
  try {
    const j = JSON.parse(readFileSync(滤开关文件, 'utf8'))
    return { ok: true, on: j && j.过滤推演块 !== false, 关思考: j && j.关闭思考 !== false, 记录: j && j.记录思考 !== false }
  } catch {
    return { ok: true, on: true, 关思考: true, 记录: true, 无文件: true }
  }
}

/** 写开关。中转每请求现读，写完下一个请求就生效，不用重启任何服务。 */
function 写滤开关(on, 关思考, 记录) {
  try {
    // 只改传进来的字段，别把没传的按默认值覆盖掉 —— 两个开关共用一个文件
    let 旧 = {}
    try { 旧 = JSON.parse(readFileSync(滤开关文件, 'utf8')) || {} } catch { /* 没有就从空开始 */ }
    if (typeof on === 'boolean') 旧.过滤推演块 = on
    if (typeof 关思考 === 'boolean') 旧.关闭思考 = 关思考
    if (typeof 记录 === 'boolean') 旧.记录思考 = 记录
    旧._说明 = '过滤推演块：text 块开头 80 字符无中文就丢。关闭思考：请求里剥掉 thinking（上游会把思考写进正文时用）。记录思考：把 thinking 旁路写到 记忆/思考流.jsonl 给面板看。'
    writeFileSync(滤开关文件, JSON.stringify(旧, null, 2) + '\n', 'utf8')
    return { ok: true, on: 旧.过滤推演块 !== false, 关思考: 旧.关闭思考 !== false, 记录: 旧.记录思考 !== false }
  } catch (e) {
    return { ok: false, msg: String((e && e.message) || e).slice(0, 160) }
  }
}

async function 拉omni模型() {
  const c = 读接入()['听'] || {}
  const 环 = process.env
  const key = String(c.key || 环.DASHSCOPE_API_KEY || '')
  const base = String(c.base || 环.DASHSCOPE_BASE_URL || '').replace(/\/+$/, '')
  if (!key || !base) return { ok: false, msg: 'key 或 base 没配' }
  // 留一行：主人点没点、请求到没到、上游几秒回的 —— 排查「点了没用」先看这条。
  const 记模型日志 = (s) => { try { appendFileSync('{{BOT_ROOT}}/记忆/日志/omni-模型.log', 京分() + ' ' + s + '\n') } catch { /* 记不上不影响拉模型 */ } }
  记模型日志('拉模型 base=' + base + ' key=' + String(key).slice(-4))
  try {
    const r = await fetch(base + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(20000) })
    if (!r.ok) { 记模型日志('上游 HTTP ' + r.status); return { ok: false, msg: 'HTTP ' + r.status } }
    const d = await r.json()
    const 全部 = (Array.isArray(d?.data) ? d.data : []).map((x) => String((x && x.id) || '')).filter(Boolean)
    // 排序不是洁癖：`xxx-realtime` 是流式接口，/chat/completions 打过去会 4xx；
    // 把能直接用的排前面，省得主人点第一个就踩坑。说那边先把 qwen 排前面 ——
    // 这个 key 下实测能用的就是 qwen3-tts-flash。
    const 排听 = (a, b) => (/realtime/i.test(a) ? 1 : 0) - (/realtime/i.test(b) ? 1 : 0) || a.localeCompare(b)
    const 排说 = (a, b) => (/^qwen3-omni-flash$|^qwen3-tts-flash$/.test(b) ? 2 : (/qwen/i.test(b) ? 1 : 0)) - (/^qwen3-omni-flash$|^qwen3-tts-flash$/.test(a) ? 2 : (/qwen/i.test(a) ? 1 : 0)) || a.localeCompare(b)
    return {
      ok: true,
      总: 全部.length,
      // OMNI_NO_REALTIME 2026-11-14（批次473）：`xxx-realtime` 是**流式(WebSocket)**接口，
      // 而这里的音画理解是一次性 /chat/completions。实测：qwen3.8-omni-flash-realtime /
      // qwen3.5-omni-flash-realtime / qwen-audio-3.1-realtime-plus 对视频和音频**全部**
      // 0.3~0.6 秒返回空（model-output-empty），随后静默降级 Storyboard。
      // 原来只是把它们排到最后（注释里写了「打过去会 4xx」）—— 主人滚到底还是点了。
      // 现在干脆不进候选，免得选了个必然用不了的。
      听: 全部.filter(像听).filter((x) => !/realtime/i.test(x)).sort(排听),
      说: 全部.filter(像说).sort(排说),
      全部,
    }
  } catch (e) {
    return { ok: false, msg: '连不上：' + String((e && e.message) || e).slice(0, 100) }
  }
}

// OMNI_BALANCE 2026-11-12：这个 MaaS 网关**没有余额接口**（/user/balance、/balance、
// /dashboard/billing/credit_grants 全 404，实测过）。所以这里先真去试一遍：
// 试通了就显示真数，试不通就明说「这个网关不提供」，然后把消耗摊开 ——
// 只显示 chat 那条链的余额，会让人以为那就是全部。
// 缓存 10 分钟：三个 404 并行也要几秒，不能每次刷新都打。
let __omni余额 = { at: 0, 值: null }
async function 查omni余额() {
  if (__omni余额.值 && Date.now() - __omni余额.at < 10 * 60e3) return __omni余额.值
  const c = 说配置()
  const base = String(c.base || '').replace(/\/+$/, '')   // 原生 /api/v1
  const 试 = ['/user/balance', '/balance', '/dashboard/billing/credit_grants']
  const 结果 = { ok: false, msg: '这个网关没有余额接口（' + 试.join('、') + ' 全 404，另试过 billing/usage/quota 也 404）；真要余额得登阿里云控制台看', 查于: 京分() }
  if (c.key && base) {
    const 回 = await Promise.all(试.map(async (p) => {
      try {
        const r = await fetch(base + p, { headers: { Authorization: 'Bearer ' + c.key }, signal: AbortSignal.timeout(6000) })
        if (!r.ok) return null
        return await r.json()
      } catch { return null }
    }))
    for (const j of 回) {
      if (!j) continue
      const 钱 = Number(j.total_balance ?? j.balance ?? j.total_available ?? j.credit ?? NaN)
      if (Number.isFinite(钱)) {
        结果.ok = true
        结果.余额 = 钱
        结果.币 = String(j.currency || j.cur || 'CNY')
        结果.msg = ''
        break
      }
    }
  }
  __omni余额 = { at: Date.now(), 值: 结果 }
  return 结果
}

// 听/说 各调了多少：从同一份流水里筛 omni 字段，跟她说话的 token 分开。
function omni用量() {
  const 数 = (ls) => {
    const o = { 听: 0, 听tok: 0, 说: 0, 说字: 0, 失败: 0 }
    for (const r of ls) {
      if (String(r.结果 || 'ok') !== 'ok') o.失败 += 1
      if (r.omni === '说') { o.说 += 1; o.说字 += Number(r.字) || 0 }
      else { o.听 += 1; o.听tok += (Number(r.入) || 0) + (Number(r.出) || 0) }
    }
    return o
  }
  let rows = []
  // 假记录不进「听/说」计数（真调用见 是测试噪音 的注释）
  try { rows = 读流水().filter((r) => r.omni && !是测试噪音(r)) } catch { rows = [] }
  const 今 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
  const 七 = new Date(Date.now() + 8 * 3600e3 - 6 * 86400e3).toISOString().slice(0, 10)
  return {
    今日: 数(rows.filter((r) => String(r.at || '').slice(0, 10) === 今)),
    近7天: 数(rows.filter((r) => String(r.at || '').slice(0, 10) >= 七)),
  }
}

// 验「听」：发一句最短的文本请求。omni 也能吃纯文本，所以不用真拿一段音频去试。
// 只验 key/base/模型名对不对 —— 音频能力得真放一段才知道，那是她自己用的时候的事。
async function 验听() {
  const c = 读接入()['听'] || {}
  const 环 = process.env
  const key = String(c.key || 环.DASHSCOPE_API_KEY || '')
  const base = String(c.base || 环.DASHSCOPE_BASE_URL || '').replace(/\/+$/, '')
  const 模型 = String(c.模型 || 环.DASHSCOPE_MODEL || 'qwen3.8-omni-flash')
  if (!key || !base) return { ok: false, msg: 'key 或 base 没配' }
  try {
    const r = await fetch(base + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 模型, messages: [{ role: 'user', content: '在吗' }], max_tokens: 8, stream: false }),
      signal: AbortSignal.timeout(30000),
    })
    const t = String(await r.text().catch(() => '')).slice(0, 200)
    if (!r.ok) return { ok: false, msg: 'HTTP ' + r.status + '：' + t }
    let 回 = ''
    try { 回 = String((JSON.parse(t) || {}).choices?.[0]?.message?.content || '').slice(0, 40) } catch { 回 = '' }
    return { ok: true, msg: '通了' + (回 ? '，它回了「' + 回 + '」' : '') }
  } catch (e) {
    return { ok: false, msg: '连不上：' + String((e && e.message) || e).slice(0, 120) }
  }
}

// 试听：真合成一句，落到 共享/面板试听/，前端用 <audio> 直接放。
// 这是唯一能在页面上判断「这把 key 到底会不会说话」的办法 —— 光验 key 不算数。
async function 试说(文本) {
  const { 合成 } = await import('./语音合成.mjs')
  const r = await 合成(String(文本 || '喂，听得到吗').slice(0, 200), { 出目录: 试听目录 })
  if (!r.ok) return { ok: false, msg: r.reason }
  return { ok: true, url: '/api/omni/audio/' + r.file, 字节: r.bytes, 模型: r.模型, msg: '合成好了，点播放' }
}

function 用量汇总(days, 给列表) {
  const 天 = Math.max(1, Math.min(30, Number(days) || 7))
  const 今 = new Date(Date.now() + 8 * 3600e3)
  const 到 = 今.toISOString().slice(0, 10)
  const 起 = new Date(今.getTime() - (天 - 1) * 86400e3).toISOString().slice(0, 10)
  // OMNI_SEPARATE 2026-11-14（批次466）：听音频 / 看视频**不进这张表**。
  // 3174 行那段注释早就写了「不能混进她说话的 token」，但代码从来没排除过 ——
  // omni 的 入/出 照样进合计、按上游、按天，列表里也照样出现（就是那两个 0 / 0）。
  // 它们自己的计数在「语音与音画」（数omni），这里只算对话。
  const rows = 读流水()
    .filter((r) => {
      if (r.omni) return false
      const d = String(r.at || '').slice(0, 10)
      return d >= 起 && d <= 到
    })
    // 探针归到「上游探测」一类（副本，不改缓存里的原行）
    // TITLE_NOISE 2026-11-14（批次487）：标题生成也单独归一类，别混进「对话」
    .map((r) => (是探针(r) ? { ...r, 用途: '上游探测' } : 是标题(r) ? { ...r, 用途: '标题生成' } : r))
  // IDENTITY 2026-11-09（批次334）：分组键用**候选 id**，显示名从候选档现查。
  // 名字是标签，主人随时会改；id 建了就不变。没有 id 的老流水才退回名字 + 别名。
  const 别名 = 读别名()
  const 候选名 = new Map()
  const 候选号 = new Map()
  try {
    for (const x of 读候选钥匙()) {
      候选名.set(String(x.id || ''), String(x.名 || x.id || ''))
      候选号.set(String(x.名 || ''), String(x.id || ''))
    }
  } catch { /* 读不到就退回名字 */ }
  /**
   * 一条流水该归到哪一组。
   * 有 `钥`（批次334 之后记的）→ 直接按 id，名字现查候选档，改名自动跟。
   * 没有 `钥`（历史 100 多条）→ 先把历史名过一遍别名表，再拿这个名去候选里**反查 id**。
   *   少这一步，同一把钥匙会显示成两行（id 一行、名字一行，名字还一模一样）。
   */
  const 归谁 = (r) => {
    const 钥 = String(r.钥 || '')
    if (钥) return { 键: 钥, 名: 候选名.get(钥) || String(r.上游 || 钥) }
    const 名1 = 正名(r.上游 || '?', 别名)
    const 号 = 候选号.get(名1)
    if (号) return { 键: 号, 名: 候选名.get(号) || 名1 }
    return { 键: '名:' + 名1, 名: 名1 }
  }
  // USAGE_SPLIT 2026-11-09（批次310/311）：缓存单列。命中缓存的输入便宜十倍，
  // 不单列就会把「上下文重复读」看成「她好贵」——而实际上大头常常是命中缓存的那部分。
  const 空行 = () => ({ calls: 0, 入: 0, 出: 0, 缓读: 0, 缓写: 0, 思考: 0 })
  const 合计 = 空行()
  const 今日 = 空行()
  const 天表 = new Map()
  for (let i = 0; i < 天; i += 1) {
    const d = new Date(今.getTime() - (天 - 1 - i) * 86400e3).toISOString().slice(0, 10)
    天表.set(d, 空行())
  }
  const 上游 = new Map()
  const 用途 = new Map()
  for (const r of rows) {
    const 入 = Number(r.入) || 0
    const 出 = Number(r.出) || 0
    const 缓读 = Number(r.缓读) || 0
    const 缓写 = Number(r.缓写) || 0
    const 思考 = Number(r.思考) || 0
    const d = String(r.at || '').slice(0, 10)
    for (const box of [合计, 天表.get(d), d === 到 ? 今日 : null]) {
      if (!box) continue
      box.calls += 1
      box.入 += 入
      box.出 += 出
      box.缓读 += 缓读
      box.缓写 += 缓写
      box.思考 += 思考
    }
    const 归 = 归谁(r)
    const u = 上游.get(归.键) || 空行()
    u.calls += 1; u.入 += 入; u.出 += 出; u.缓读 += 缓读
    u.名 = 归.名
    上游.set(归.键, u)
    // 按用途不只数次数：小请求次数多但几乎不花 token，只看次数会把结论带偏
    const k = 用途.get(r.用途 || '对话') || { calls: 0, 入: 0, 出: 0, 缓读: 0 }
    k.calls += 1; k.入 += 入; k.出 += 出; k.缓读 += 缓读
    用途.set(r.用途 || '对话', k)
  }
  const 排 = (m) => [...m.entries()]
    .map(([键, v]) => ({
      名: v.名 || 键, calls: v.calls, 入: v.入 || 0, 出: v.出 || 0,
      缓读: v.缓读 || 0,
      // 命中率 = 命中缓存的输入 / 总输入。分母是 0 时给 0，不编。
      命中率: (v.入 || 0) > 0 ? Math.round(((v.缓读 || 0) / v.入) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.calls - a.calls)
  // OMNI_USAGE 2026-11-12：听音频 / 看视频 / 语音合成 单独算。
  // 它们跟 chat 走同一个流水文件（omni 字段有值），但不能混进「她说话的 token」——
  // TTS 根本没有 token，只有字数；塞进 入/出 会让人以为上下文又涨了。
  const 数omni = (ls) => {
    const o = { 听: 0, 听tok: 0, 说: 0, 说字: 0 }
    for (const r of ls) {
      if (r.omni === '说') { o.说 += 1; o.说字 += Number(r.字) || 0 }
      else { o.听 += 1; o.听tok += (Number(r.入) || 0) + (Number(r.出) || 0) }
    }
    return o
  }
  const omni行 = rows.filter((r) => r.omni)
  const out = {
    ok: true,
    天数: 天,
    从: 起,
    到: 到,
    // STATS 2026-11-17（批次672）：拓扑卡底部「请求 / 改道 / 错误」。
    // 口径见 黑箱四层.mjs 的 路由统计()：omni 与 0 token 噪音不算请求，
    // 改道 = 轨迹长度 - 1，错误 = 轨迹里 HTTP >= 400 的次数。只读汇总，不改记账。
    统计: {
      今日: 路由统计(rows.filter((r) => String(r.at || '').slice(0, 10) === 到)),
      区间: 路由统计(rows),
    },
    omni: {
      区间: 数omni(omni行),
      今日: 数omni(omni行.filter((r) => String(r.at || '').slice(0, 10) === 到)),
    },
    合计: { ...合计, tok: 合计.入 + 合计.出, 命中率: 合计.入 > 0 ? Math.round((合计.缓读 / 合计.入) * 1000) / 10 : 0 },
    今日: { ...今日, tok: 今日.入 + 今日.出, 命中率: 今日.入 > 0 ? Math.round((今日.缓读 / 今日.入) * 1000) / 10 : 0 },
    按天: [...天表.entries()].map(([d, v]) => ({
      日: d.slice(5), 全: d, calls: v.calls, 入: v.入, 出: v.出, 缓读: v.缓读,
      命中率: v.入 > 0 ? Math.round((v.缓读 / v.入) * 1000) / 10 : 0,
    })),
    按上游: 排(上游),
    按用途: 排(用途),
    // LASTREQ 2026-11-17（批次671）：主人要「最近一个请求怎么路由的」那张卡。
    // 数据全在流水里，这里只做**只读汇总**，不改任何记账：
    //   首字/毫秒 → 从请求到第一段正文 / 整包到达的耗时（670 之前首字恒为 0，老数据会显示「—」）
    //   路由      → 670 起无论成败都记，形如 [{名, 命中:true}, {名, 状态, 因}]
    //   缓存      → 缓读/入，命中率高说明这条前缀被复用了
    // 只取「对话」类且真的调过模型的（omni/TTS 没有这些字段，混进来会显示 0）。
    最近请求: 最近一个请求(rows, (r) => 归谁(r).名),
  }
  if (给列表) {
    out.列表 = rows
      .slice(-200)
      .reverse()
      .map((r) => ({
        at: String(r.at || '').slice(5, 16),
        用途: r.用途 || '对话',
        摘要: String(r.摘要 || ''),
        上游: 归谁(r).名,
        入: Number(r.入) || 0,
        出: Number(r.出) || 0,
        缓读: Number(r.缓读) || 0,
        思考: Number(r.思考) || 0,
        首字: Number(r.首字) || 0,
        模型: String(r.模型 || ''),
        毫秒: Number(r.毫秒) || 0,
        兜底: r.兜底 === true,
        // TRACE_LIST 2026-11-17（批次672）：抄 magpie 请求流水那页 —— 每行点开能看到
        // 这次真的试了哪几把钥匙、谁失败谁命中。670 之前的老记录没有 路由 字段，
        // 这里给空数组，前端显示「这条是老记录」，不编轨迹。
        路由: Array.isArray(r.路由)
          ? r.路由.filter(Boolean).map((x) => ({
            名: String(x.名 || ''),
            命中: x.命中 === true,
            状态: Number(x.状态) || 0,
            因: String(x.因 || x.不换 || ''),
          }))
          : [],
      }))
  }
  return out
}

// LOGIN_LIMIT 2026-11-12：登录/注册限流。8787 是公网口、主人的 QQ 号谁都知道，原来密码可以无限次地试。
// 只记失败：同一 IP 10 分钟 10 次、同一账号 10 分钟 8 次（防换 IP 打同一个号）；注册同一 IP 一小时 5 次。
// 内存里记就够：重启清零无所谓，要防的是连续不断地撞。
const __限流 = new Map()
const __清窗 = (k, 窗) => { const now = Date.now(); const a = (__限流.get(k) || []).filter((t) => now - t < 窗); if (a.length) __限流.set(k, a); else __限流.delete(k); return a }
const 超限 = (k, 上限, 窗) => __清窗(k, 窗).length >= 上限
const 记一次 = (k, 窗) => { const a = __清窗(k, 窗); a.push(Date.now()); __限流.set(k, a.slice(-64)) }
setInterval(() => { for (const k of [...__限流.keys()]) __清窗(k, 3600e3) }, 300e3).unref()

const 面板服务 = createServer((req, res) => {
  const url = req.url.split('?')[0]
  // V2_OFFLINE 2026-11-05（批次100）：`/v2` 那套新界面已下线（主人决定）。
  //
  // 原来这里会把 新UI.html（1476 行）整份吐出去，而且**先于鉴权**命中 ——
  // 没登录的人也能看。那页一直没接洗澡、最近在做什么、照片轮播、季节物候，
  // 留着最危险的是「以为它是最新的」。文件已归档到 bak2 并从工具目录删掉。
  //
  // 保留一个 302 到 /：收藏过 /v2 的人不会看到登录页一脸懵。
  if (url === '/v2') {
    res.writeHead(302, { location: '/' })
    return res.end()
  }
  // 精简版 2026-11-05：登录后访问 / 直接给「状态 + 调试」两页；老界面留在 /old
  const acceptGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))
  const send = (code, type, body, extra) => {
    const hdrs = { 'content-type': type, ...(extra || {}) }
    const canZip = acceptGzip && /^(text\/|application\/json|image\/svg)/i.test(String(type || '')) && !hdrs['content-encoding']
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8')
    if (canZip && buf.length > 1024) {
      hdrs['content-encoding'] = 'gzip'
      hdrs['vary'] = 'Accept-Encoding'
      const z = gzipSync(buf, { level: 5 })
      res.writeHead(code, hdrs)
      return res.end(z)
    }
    res.writeHead(code, hdrs)
    res.end(buf)
  }
  if (url === '/' && verify(cookieOf(req))) {   // 2026-11-05 改为验签，光有 cookie 不行
    try {
      const html = _rf('{{BOT_ROOT}}/共享/工具/简洁页.html')
      // HOST_BOT 2026-11-24：告诉前端「这家面板是谁」。以前前端默认 CURRENT_BOT='fish'，
      // {{ALT_BOT_DISPLAY}} 面板一打开就把所有 /api 转发给 {{BOT_DISPLAY}} 面板 → 显示人设、思考/调试页没这台 cookie 打不开。
      let _html = String(html)
      const _alt = String(process.env.ALT_BOT_KEY || '')
      const _hostBot = _alt === 'fish' ? 'hajimi' : (_alt === 'hajimi' ? 'fish' : '')
      if (_hostBot) _html = _html.replace(/<head[^>]*>/, (m) => m + '<script>window.__HOST_BOT=' + JSON.stringify(_hostBot) + '</script>')
      return send(200, 'text/html; charset=utf-8', _html, { 'cache-control': 'no-store' })
    } catch (e) { /* 读不到就落回老界面 */ }
  }
  // COVER_POS 2026-11-05：放在 send 之后、鉴权之前——放前面会 TDZ 崩掉整个面板
  // COVER_ROUTE 2026-11-05（必须在鉴权之前：登录页还没有会话）：登录页要用她的照片当背景，但那时还没有会话，
  // 所以单独开一条**公开**的封面路由，只给最新一张、不带任何元信息。
  // 注意：这是全站唯一一条不需要登录的图片路由，别人打开登录页就能看到——主人要求的。
  // COVER_ROTATE 2026-11-05：登录页的背景轮换。三条都在鉴权之前 —— 那时候还没有会话。
  //   /cover/list        有哪些能轮（只列已经压好的封面）
  //   /cover/<id>.jpg    单张封面，长缓存：id 不复用，同一 id 的图不会变
  //   /cover             兜底，最新一张
  // 范围说明：这是全站唯一不需要登录的图片面。轮换等于把历史自拍也放到登录页上了，
  // 原来只公开最新一张。给的只是她自己的脸，不带时间、地点、场景、说明。
  if (url === '/cover/list') {
    const ids = coverList()
    return send(200, 'application/json; charset=utf-8', JSON.stringify({
      ok: true,
      // small 是同一张的 900 宽版本（约 85KB，大图 225KB）。手机用小的：
      // 1600 的图在手机上要多解 3 倍像素，纹理能到 5.7MB，老机型会掉帧。
      photos: ids.map((id) => ({ id, src: '/cover/' + id + '.jpg', small: '/cover/' + id + '@s.jpg' })),
      interval: 10000,   // 每 10 秒发起一次切换
      fade: 1600,        // 交叉淡化时长，和登录页 CSS 里的 --fade 默认值保持一致
    }), { 'cache-control': 'no-store' })
  }
  if (url.startsWith('/cover/')) {
    let id = url.slice(7).replace(/\.jpg$/, '')
    const small = id.endsWith('@s')          // <id>@s.jpg = 手机用的 900 宽那版
    if (small) id = id.slice(0, -2)
    // 白名单：只认目录里真列出来的 id。@s 先剥掉再校验，别让人用 @ 后缀绕过去。
    // 不拼路径、不把 id 交给 shell，穿越不了
    if (!/^[a-z0-9]{6,32}$/.test(id) || !coverList().includes(id)) return send(404, 'text/plain; charset=utf-8', '没有')
    const dir = '{{BOT_ROOT}}/共享/自拍/封面/'
    try {
      const buf = _rf(dir + id + (small ? '@s' : '') + '.jpg')
      return send(200, 'image/jpeg', buf, { 'cache-control': 'public, max-age=604800, immutable' })
    } catch {
      // 小图还没压出来：发大图，别 404（宁可多花点流量，不能让背景空着）
      if (small) {
        try {
          const buf = _rf(dir + id + '.jpg')
          return send(200, 'image/jpeg', buf, { 'cache-control': 'public, max-age=300' })
        } catch { /* 落到 404 */ }
      }
      return send(404, 'text/plain; charset=utf-8', '没有')
    }
  }
  if (url === '/cover' || url === '/cover.png') {
    const ids = coverList()
    if (ids.length) {
      try {
        const buf = _rf('{{BOT_ROOT}}/共享/自拍/封面/' + ids[ids.length - 1] + '.jpg')
        return send(200, 'image/jpeg', buf, { 'cache-control': 'public, max-age=300' })
      } catch { /* 封面读不到就退回原图，别让登录页没背景 */ }
    }
    try {
      const dir = '{{BOT_ROOT}}/共享/自拍/成品'
      const list = requireDir(dir).filter(是成品图)
      if (!list.length) return send(404, 'text/plain; charset=utf-8', '没有')
      list.sort((a, b) => requireStat(dir + '/' + b).mtimeMs - requireStat(dir + '/' + a).mtimeMs)
      const buf = _rf(dir + '/' + list[0])
      return send(200, 'image/png', buf, { 'cache-control': 'public, max-age=60' })
    } catch { return send(404, 'text/plain; charset=utf-8', '没有') }
  }
  const json = (o, extra) => send(200, 'application/json; charset=utf-8', JSON.stringify(o), { 'cache-control': 'no-store', ...(extra || {}) })
  // API_JSON_400 2026-11-04：坏 JSON 直接 400，别再静默当空对象（前端会把「没收到参数」当成别的原因）
  // BODY_CAP 2026-11-12：请求体封顶 2MB。原来 b += c 没有上限，而 /login /register 在鉴权之前就读 body —— 没登录的人也能把内存灌满。
  const readBody = (cb) => { let b = ''; let n = 0; let over = false; req.on('data', (c) => { if (over) return; n += c.length; if (n > 2 * 1024 * 1024) { over = true; send(413, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '请求体太大' })); req.destroy(); return } b += c }); req.on('end', () => { if (over) return; let j; try { j = JSON.parse(b || '{}') } catch (e) { return send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '请求体不是合法 JSON：' + e.message })) } cb(j) }) }

  // SCENE_BG 2026-11-02：场景插画从共享区读，别塞进 HTML
  // WEBP 2026-11-07：底图换 webp（1536px 只有 175KB，同尺寸 png 要 1.08MB）。
  // 路由不认这个后缀时会掉到首页分支返回 text/html，浏览器当图片解码失败 → 白图。
  if (url.startsWith('/img/') && (url.endsWith('.svg') || url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.webp'))) {
    // IMG_TRAVERSAL 2026-11-12：这条路由在鉴权之前。原来直接拼路径，/img/../../../../../usr/share/x.png 这种
    // 不带 cookie 就能读到工作区外的图（实测 200）。现在任何一段以点开头（.. / . / 隐藏文件）或带反斜杠的一律 404。
    const rel = url.slice(5)
    if (rel.includes('\\') || rel.split('/').some((seg) => seg === '' || seg.startsWith('.'))) { res.writeHead(404); return res.end('没有这张图') }
    const f = tools + '/img/' + rel
    if (existsSync(f)) {
      res.writeHead(200, { 'content-type': url.endsWith('.svg') ? 'image/svg+xml; charset=utf-8' : url.endsWith('.png') ? 'image/png' : url.endsWith('.webp') ? 'image/webp' : 'image/jpeg', 'cache-control': 'max-age=300' })
      return res.end(readFileSync(f))
    }
    res.writeHead(404); return res.end('没有这张图')
  }

  // LIVE_MUSIC_IN 2026-11-12：PC 上报器入口。走独立密钥（X-Music-Key），不用 cookie ——
  // 上报器跑在主人家里的电脑上，没有面板登录态。只能写一个「当前曲」，写不了别的。
  if (url === '/api/music/now' && req.method === 'POST') {
    const 钥 = String(req.headers['x-music-key'] || '')
    const 真钥 = String((load(tools + '/面板密钥.json', {}) || {})['音乐上报'] || '')
    if (!真钥 || 钥 !== 真钥) {
      return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: 'key 不对' }))
    }
    return readBody(async (j) => {
      try {
        // STRUCT 2026-11-12（批次364）：读 PC 本地库的上报器会给结构化字段
        // （songId / songName / artist / durationSec），老的只给 title。
        // 有结构化字段就直接用 —— 不再按「 - 」切分（歌名里带「 - 」会被切错），
        // 也不再去搜总时长（搜出来常常是同名翻唱，长度完全不对）。
        const 给名 = String(j?.songName || '').trim()
        const 给手 = String(j?.artist || '').trim()
        const 原 = String(j?.title || '').trim()
        if (!给名 && 原 === '') return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, 空: true }))
        let 歌名, 歌手
        if (给名) {
          歌名 = 给名
          歌手 = 给手
        } else {
          // 窗口标题形如「歌名 - 歌手」；歌名里本身可能带「 - 」，所以从右切
          const 碎 = 原.split(' - ')
          歌名 = (碎.length >= 2 ? 碎.slice(0, -1).join(' - ') : 原).trim()
          歌手 = 碎.length >= 2 ? String(碎[碎.length - 1]).trim() : ''
        }
        const 现 = load(base + '/一起听实时.json', {}) || {}
        const 同曲 = String(现.歌名) === 歌名
        const since = Number(j?.since) > 0
          ? Number(j.since)
          : (同曲 && Number(现.since) > 0 ? Number(现.since) : Date.now())
        const 给长 = Number(j?.durationSec) || 0
        // 时长：上报器给了就用（本地库给的是毫秒级精确值）；老的没给才去搜
        let durationSec = 给长 > 0 ? Math.round(给长) : (同曲 ? (Number(现.durationSec) || 0) : 0)
        const 给id = Number(j?.songId) || 0
        if (!durationSec) {
          try {
            const r = await fetch('http://127.0.0.1:3999/search?keywords=' + encodeURIComponent(歌名 + ' ' + 歌手) + '&limit=1',
              { signal: AbortSignal.timeout(4000) })
            const d = await r.json()
            // SEARCH_DT 2026-11-12：/search 返回的是 duration（毫秒），不是 dt ——
            // 用 dt 判会永远拿到 0，卡片就没有总时长。两个都认。
            // SEARCH_MATCH 2026-11-12（批次363）：以前盲取第一条，同名翻唱/纯音乐一大把，
            // 总时长就张冠李戴（「Hero」能搜出 1 分钟的练习曲）。歌名和歌手都得对上，
            // 对不上宁可不给总时长 —— 少一个数字，好过给一个错数字。
            const 净 = (x) => String(x || '').toLowerCase().replace(/[\s\-_·・()（）\[\]【】]/g, '')
            const 要名 = 净(歌名), 要手 = 净(歌手)
            const 候 = Array.isArray(d?.result?.songs) ? d.result.songs : []
            const s = 候.find((x) => {
              if (!x) return false
              const n = 净(x.name)
              if (!n || !要名) return false
              if (!(n === 要名 || n.indexOf(要名) >= 0 || 要名.indexOf(n) >= 0)) return false
              if (!要手) return true
              const ars = (Array.isArray(x.ar) ? x.ar : []).map((a) => 净(a && a.name)).filter(Boolean)
              if (!ars.length) return false
              return ars.some((a) => a.indexOf(要手) >= 0 || 要手.indexOf(a) >= 0)
            })
            const 毫秒 = Number(s?.dt) || Number(s?.duration) || 0
            if (毫秒 > 0) durationSec = Math.round(毫秒 / 1000)
          } catch { /* 搜不到不影响歌名先顶上 */ }
        }
        const 出 = {
          title: 原 || (歌名 + (歌手 ? ' - ' + 歌手 : '')),
          歌名, 歌手, since, durationSec,
          // songId 是「认亲」用的：听感/歌词存在 一起听.json 里，只能靠它对应
          songId: 给id > 0 ? 给id : (同曲 ? (Number(现.songId) || 0) : 0),
          at: Date.now(),
        }
        // TMPNAME_FIX 2026-11-24：与 _底层.写档 口径统一 —— 只带 pid 的话，
        // 同一进程内两次写（比如 /api 被连点两次）会撞同一个临时名。
        const tmp = base + '/一起听实时.json.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8)
        writeFileSync(tmp, JSON.stringify(出, null, 2), 'utf8')
        _rn(tmp, base + '/一起听实时.json')
        return send(200, 'application/json; charset=utf-8',
          JSON.stringify({ ok: true, 歌名, 歌手, durationSec }))
      } catch (e) {
        return send(500, 'application/json; charset=utf-8',
          JSON.stringify({ ok: false, msg: String(e?.message || e) }))
      }
    })
  }

  if (url === '/register' && req.method === 'POST') {
    const ip = String(req.socket.remoteAddress || '')
    if (超限('reg:' + ip, 5, 3600e3)) return send(429, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '注册太频繁了，过一会儿再来' }), { 'cache-control': 'no-store' })
    记一次('reg:' + ip, 3600e3)
    return readBody((j) => {
      const qq = String(j.qq || '').trim(), pw = String(j.pw || '')
      if (!/^\d{5,12}$/.test(qq)) return json({ ok: false, msg: 'QQ 号看着不对' })
      if (pw.length < 4) return json({ ok: false, msg: '密码至少四位' })
      if (USERS.users[qq]) return json({ ok: false, msg: '这个号注册过了，直接登录' })
      const salt = randomBytes(8).toString('hex')
      USERS.users[qq] = { salt, hash: hashPw(pw, salt), at: Date.now() }
      saveUsers()
      const role = qq === OWNER ? 'owner' : 'guest'
      const token = sign({ qq, role, exp: Date.now() + 12 * 3600e3 })
      json({ ok: true }, { 'set-cookie': 'fish_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly; Max-Age=43200; SameSite=Lax' })
    })
  }
  if (url === '/login' && req.method === 'POST') {
    return readBody((j) => {
      const qq = String(j.qq || '').trim(), pw = String(j.pw || '')
      const ip = String(req.socket.remoteAddress || '')
      const 窗 = 600e3
      if (超限('ip:' + ip, 10, 窗) || 超限('qq:' + qq, 8, 窗)) return send(429, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '试太多次了，十分钟后再来' }), { 'cache-control': 'no-store' })
      const u = USERS.users[qq]
      if (!u) { 记一次('ip:' + ip, 窗); return json({ ok: false, msg: '这个号还没注册' }) }
      if (hashPw(pw, u.salt) !== u.hash) { 记一次('ip:' + ip, 窗); 记一次('qq:' + qq, 窗); return json({ ok: false, msg: '密码不对' }) }
      __限流.delete('qq:' + qq)
      const role = qq === OWNER ? 'owner' : 'guest'
      const token = sign({ qq, role, exp: Date.now() + 12 * 3600e3 })
      json({ ok: true }, { 'set-cookie': 'fish_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly; Max-Age=43200; SameSite=Lax' })
    })
  }

  const sess = verify(cookieOf(req))
  if (!sess) {
    if (url.startsWith('/api/')) return send(401, 'application/json; charset=utf-8', JSON.stringify({ error: '未登录' }), { 'cache-control': 'no-store' }) // API_401 2026-11-04：未登录别回 200
    // V2_REMOVED 2026-11-05（批次100）：这里原来还有一条「未登录也能看 /v2」的分支，
    // 会直接读 新UI.html 吐出去。文件已归档删除，上面也 302 掉了，这条死代码一并去掉 ——
    // 留着它，哪天有人挪动 302 那段的顺序，它就会悄悄复活。
    return send(200, 'text/html; charset=utf-8', authPageHtml())
  }

  // QUOTA 2026-11-23：Gemini Web 的 5 小时 / 7 天额度。数据来自 额度.mjs
  // （读 gemini-web2api 的 cookie，走后端同一个代理出口问 Google）。
  // 2026-11-23 修：这段原来插在 /api/fleet/ 分支里，外面永远走不到。
  if (req.method === 'GET' && url.startsWith('/api/quota')) {
    const force = /[?&]force=1/.test(url)
    import('{{BOT_ROOT}}/共享/工具/额度.mjs')
      .then((m) => {
        const q = m.readQuota({ force })
        return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, quota: q, history: m.readHistory() }))
      })
      .catch((e) => send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: String((e && e.message) || e) })))
    return
  }

  // ══ HAJIMI_DUAL_AND_FLEET_START ══
  if (url.startsWith('/api/fleet/')) {
    if (!HAS_GATEWAY) return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: false, unavailable: true, msg: '本实例没接接口网关' }))
    if (String(sess.role) !== 'owner' || /[?&]as=guest(&|$)/.test(String(req.url || ''))) {
      return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '只有主人本人能改模型接口喵' }))
    }
    // 2026-11-24：QQ 已换 SnowLuma，napcat 的 qrcode.png 早就不更新了。
    // 现在实时抓 Xvfb 上的 QQ 登录窗（qq扫码.py 会自动切到扫码页）。
    const qrFile = '/tmp/qqqr-{{BOT_NAME}}.png'
    const 跑抓码 = (刷新) => new Promise((r) => {
      import('node:child_process').then(({ execFile }) => {
        execFile('python3', ['{{BOT_ROOT}}/共享/工具/qq扫码.py'].concat(刷新 ? ['--refresh'] : []),
          { timeout: 45000, env: { ...process.env, QQ扫码客户端: '{{QQ_HOME}}/app/qq', QQQR_OUT: qrFile, QQWIN_OUT: '/tmp/_qqwin-{{BOT_NAME}}.png' } }, (err) => r(!err))
      }).catch(() => r(false))
    })
    if (req.method === 'GET' && url === '/api/fleet/qrcode') {
      const 发图 = () => sendPngFile(res, qrFile, '二维码还没抓到，QQ 客户端可能没在跑')
      const 强刷 = /[?&]refresh=1/.test(String(req.url || ''))
      if (!强刷 && isFreshFile(qrFile, 4000)) return 发图()
      跑抓码(强刷).then(发图)
      return
    }
    if (req.method === 'GET' && url === '/api/fleet/qqwin') {
      const winFile = '/tmp/_qqwin-{{BOT_NAME}}.png'
      const 发全窗 = () => sendPngFile(res, winFile, '还没抓到 QQ 窗口')
      if (isFreshFile(winFile, 4000)) return 发全窗()
      跑抓码(false).then(发全窗)
      return
    }
    if (req.method === 'GET' && url === '/api/fleet/overview') {
      ;(async () => {
        const 探口 = (port) => new Promise((r) => {
          const s = connect({ host: '127.0.0.1', port, timeout: 600 })
          const 完 = (ok) => { try { s.destroy() } catch (_err) { console.error('[面板]', _err?.message || _err) } r(ok) }
          s.on('connect', () => 完(true))
          s.on('timeout', () => 完(false))
          s.on('error', () => 完(false))
        })
        const [upGate, bot3081, proxy3011, panel8788, tts9880] = await Promise.all([
          HAS_GATEWAY ? 探口(GW_PORT) : Promise.resolve(false), 探口(3081), 探口(3011), 探口(8788), 探口(9880)
        ])
        let qqLogin = { loggedIn: false, uin: '{{SELF_UIN}}', nickname: '', err: '' }
        try {
          const obCfg = JSON.parse(readFileSync('{{QQ_HOME}}/app/resources/app/app_launcher/napcat/config/onebot11_{{SELF_UIN}}.json', 'utf8'))
          const tok = obCfg?.network?.httpServers?.[0]?.token || ''
          const r = await fetch('http://127.0.0.1:3011/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
            body: JSON.stringify({ action: 'get_login_info', params: {} }),
            signal: AbortSignal.timeout(1800),
          })
          if (r.ok) {
            const j = await r.json()
            if (j && j.retcode === 0 && j.data && j.data.user_id) {
              qqLogin = { loggedIn: true, uin: String(j.data.user_id), nickname: String(j.data.nickname || '{{BOT_DISPLAY}}'), err: '' }
            }
          }
        } catch { qqLogin.err = '等待手机QQ扫码上工' }

        if (!qqLogin.loggedIn && (!existsSync(qrFile) || Date.now() - _st(qrFile).mtimeMs > 20000)) await 跑抓码(false)
        let qrMeta = { exists: false, mtimeMs: 0, ageSec: 0 }
        try {
          if (existsSync(qrFile)) {
            const st = _st(qrFile)
            qrMeta = { exists: st.size > 100, mtimeMs: Math.round(st.mtimeMs), ageSec: Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000)) }
          }
        } catch (_err) { console.error('[面板]', _err?.message || _err) }

        let fleet = { ok: false, slots: [], activeSlot: '', fallbackSlot: '', sharedKeys: [] }
        try {
          const fr = await fetch('http://127.0.0.1:' + GW_PORT + '/__fleet/state', { headers: fleetHeaders, signal: AbortSignal.timeout(2500) })
          if (fr.ok) fleet = await fr.json()
        } catch (_err) { console.error('[面板]', _err?.message || _err) }

        let soul = ''
        try { soul = readFileSync('{{BOT_ROOT}}/SOUL.md', 'utf8') } catch (_err) { console.error('[面板]', _err?.message || _err) }

        send(200, 'application/json; charset=utf-8', JSON.stringify({
          ok: true,
          services: { upGate, bot3081, proxy3011, panel8788, tts9880 },
          qq: qqLogin,
          qr: qrMeta,
          fleet,
          soul,
        }))
      })()
      return
    }
    if (req.method === 'POST' && url === '/api/fleet/action') {
      let raw = ''
      req.on('data', (c) => { if (raw.length < 65536) raw += c })
      req.on('end', async () => {
        try {
          const body = JSON.parse(raw || '{}')
          if (body.action === 'saveSoul') {
            const txt = String(body.soul || '').trim()
            if (!txt) return send(400, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: 'SOUL.md 不能为空喵' }))
            writeFileSync('{{BOT_ROOT}}/SOUL.md', txt + '\n', 'utf8')
            return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, msg: '{{BOT_DISPLAY}}灵魂工牌已保存生效喵！' }))
          }
          if (body.action === 'refreshQr') {
            const cp = await import('node:child_process')
            // 2026-11-23 修：原来重启的 napcat-fish.service 早就不存在（QQ 已换 SnowLuma），
            // 点「刷新二维码」只会报重启失败。现在先看 3011 是否已登录：
            // 登着就别动（重启会把她踢下线）；没登才重拉 SnowLuma 出新码。
            let 已登 = false
            try {
              const obCfg = JSON.parse(readFileSync('{{QQ_HOME}}/app/resources/app/app_launcher/napcat/config/onebot11_{{SELF_UIN}}.json', 'utf8'))
              const tok = obCfg?.network?.httpServers?.[0]?.token || ''
              const r = await fetch('http://127.0.0.1:3011/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) },
                body: JSON.stringify({ action: 'get_login_info', params: {} }),
                signal: AbortSignal.timeout(1800),
              })
              if (r.ok) {
                const j = await r.json()
                已登 = !!(j && j.retcode === 0 && j.data && j.data.user_id)
              }
            } catch (_err) { console.error('[面板]', _err?.message || _err) }
            if (已登) return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, msg: '{{BOT_DISPLAY}}已经在线上啦，不用扫码喵' }))
            // 2026-11-24：不再重启 SnowLuma（会把已登录的号踢掉）。直接让 QQ 登录窗
            // 切两次页签重新取码，然后由 qq扫码.py 截屏裁出来。
            cp.execFile('python3', ['{{BOT_ROOT}}/共享/工具/qq扫码.py', '--refresh'],
              { timeout: 45000, env: { ...process.env, QQ扫码客户端: '{{QQ_HOME}}/app/qq', QQQR_OUT: qrFile, QQWIN_OUT: '/tmp/_qqwin-{{BOT_NAME}}.png' } }, (err) => {
              if (err) return send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '刷新失败：' + (err.message || err) }))
              return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, msg: '新二维码好了，扫吧喵！' }))
            })
            return
          }
          if (body.action === 'restartHajimiBot') {
            const cp = await import('node:child_process')
            cp.execFile('systemctl', ['restart', 'dsh-bot.service'], { timeout: 15000 }, (err) => {
              if (err) return send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '重启失败：' + err.message }))
              return send(200, 'application/json; charset=utf-8', JSON.stringify({ ok: true, msg: '{{ALT_BOT_DISPLAY}}宿主已重启喵！' }))
            })
            return
          }
          const fr = await fetch('http://127.0.0.1:' + GW_PORT + '/__fleet/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...fleetHeaders },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30000),
          })
          const txt = await fr.text()
          return send(fr.status, 'application/json; charset=utf-8', txt)
        } catch (e) {
          return send(500, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: String(e.message || e) }))
        }
      })
      return
    }
  }

  // ALT_PANEL_PROXY 2026-11-24：切到另一个 bot 时转给它自己的面板；
  // 不再写死端口/实例名 —— {{ALT_BOT_DISPLAY}} 的面板点自己会转给自己，无限递归。
  const ALT_BOT_KEY = String(process.env.ALT_BOT_KEY || 'fish')
  const ALT_PANEL_PORT = Number(process.env.ALT_PANEL_PORT || '8787' || 0)
  const __目标bot = String(req.headers['x-bot-target'] || '')
  const __wantAlt = (__目标bot === ALT_BOT_KEY || String(req.url || '').includes('bot=' + ALT_BOT_KEY))
  if (__wantAlt && ALT_BOT_KEY !== '' && ALT_PANEL_PORT > 0 && (url.startsWith('/api/') || url.startsWith('/selfie/'))) {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', async () => {
      try {
        const fwdHeaders = { cookie: req.headers.cookie || '' }
        if (req.headers['content-type']) fwdHeaders['content-type'] = req.headers['content-type']
        const r = await fetch('http://127.0.0.1:' + ALT_PANEL_PORT + req.url, {
          method: req.method,
          headers: fwdHeaders,
          body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks),
          signal: AbortSignal.timeout(30000),
        })
        const buf = Buffer.from(await r.arrayBuffer())
        return send(r.status, r.headers.get('content-type') || 'application/json; charset=utf-8', buf)
      } catch (e) {
        return send(502, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '{{BOT_DISPLAY}}面板未响应：' + String(e.message || e) }))
      }
    })
    return
  }
  // ══ HAJIMI_DUAL_AND_FLEET_END ══


  // OWNER_POST 2026-11-09（批次349）：写操作默认只有主人。
  //
  // 原来每条 if 自己判 sess.role（23 处），新增写接口忘了判就是漏洞、而且没人会知道。
  // 这里加一道统一闸 —— **只拦不收**：下面各分支自己的判断全部保留，当双重保险。
  //
  // 这两个例外是**有意对外开放**的（客人可以贴便签、评论），写在这儿是为了让
  // 「为什么这两个不拦」有个明确出处，而不是看起来像忘了判。
  const 客人可写 = new Set(['/api/board/note', '/api/board/comment'])
  if (req.method === 'POST' && String(sess.role) !== 'owner' && !客人可写.has(url)) {
    return send(403, 'application/json; charset=utf-8',
      JSON.stringify({ ok: false, msg: '只有主人能改' }), { 'cache-control': 'no-store' })
  }

  // LOGOUT_BTN：退出登录——把会话 cookie 立刻作废，回到登录页
  if (url === '/logout') {
    res.writeHead(302, {
      location: '/',
      'set-cookie': 'fish_session=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax',
    })
    return res.end()
  }

  // CHAT_DRAWER 2026-11-03：面板聊天抽屉说的话，追加进「房间对话.json」，
  // 她下一轮会通过已有的 ROOM_SAY_HOOK 看到（最多带两条未读）。只允许主人。
  if (url === '/api/say' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能说话' })
    return readBody((j) => {
      const text = String((j && j.text) || '').trim()
      if (text.length === 0 || text.length > 120) return json({ ok: false, msg: '说点什么呢' })
      const at = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
      const room = load(base + '/房间对话.json', { items: [] })
      const items = Array.isArray(room.items) ? room.items : []
      items.push({ at, text, from: 'me', read: false })
      room.items = items.slice(-50)
      save(base + '/房间对话.json', room)
      return json({ ok: true, at })
    })
  }
  // GIVE_MONEY 2026-11-05：主人给她钱（只加钱，记一笔，不改别的）
  if (url === '/api/give' && req.method === 'POST') {
    if (sess.role !== 'owner') return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '只有主人能给她钱' }), { 'cache-control': 'no-store' })
    return readBody((j) => {
      const n = Math.round(Number(j.amount ?? 0))
      if (!Number.isFinite(n) || n === 0) return json({ ok: false, msg: '要给个数字' })
      if (n > 100000) return json({ ok: false, msg: '一次给太多了' })
      try {
        const ap = base + '/资产.json'
        // P0 2026-11-16：给钱也要走 改档，不能锁外读整档再写回。
        const 新钱 = 改档(ap, (a) => {
          a.钱 = Math.max(0, Number(a.钱 || 0) + n)
          a.记录 = Array.isArray(a.记录) ? a.记录 : []
          a.记录.push({ at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '), what: n > 0 ? `主人给了 ${n} 块` : `主人拿走 ${-n} 块` })
          if (a.记录.length > 200) a.记录 = a.记录.slice(-200)
          return a.钱
        }, { 钱: 0, 包: [], 家: [], 记录: [] })
        // GIVE_NO_THANKS 2026-11-05（批次81）：给钱**不代她道谢**，一句都不代。
        //
        // 原来这里 70% 概率往留言队列塞一句模板：「主人给了 X 块……这么多，我先存着不乱花。谢谢呀。」
        // 结果是同一件事被回两次 ——
        //   16:18 主人在面板给 200；
        //   聊天里主人又说「这周给你 200 零花钱」，她当场回了「一周两百，那我得算着花」「记下了」；
        //   16:20 那句模板被 投递留言.mjs 送到私聊，变成第二次回应。
        // 而且第二次她完全不知道是自己说的：模板不经过她的嘴，也不进她的对话历史。
        //
        // 这不是话术问题，是判断权问题。该不该谢、谢什么、什么时候谢，得她自己定。
        // 她也不缺这个信息 —— 位置提示里已经带着「兜里有 N 块，最近一笔 16:18 主人给了 200 块」，
        // 下次开口她自己看得到。给钱就只是给钱。
        return json({ ok: true, money: 新钱 })
      } catch (e) { return json({ ok: false, msg: '没写成：' + e.message }) }
    })
  }
  // WALL 2026-11-05（批次74）：照片墙。
  // 成品是 1920×1080 的 PNG，单张 2.9MB —— 6 张就 17MB，直接铺墙上根本转不动。
  // 缩略图(560px)/预览图(1100px) 由 /selfie/thumb|big 现压现缓存，这里只管元信息和她那段话。
  // 「她那段话」优先用 记忆/照片墙.json 里她自己写过的；没写过就把记录原样摆出来，不替她编。
  // DIARY_API 2026-11-05：日记。客人和主人都能进，看到的东西不一样。
  // 这一条排在 /api/wall 前面 —— 路由是顺序匹配的，先到先得。
  //
  // 三条边界，写在这里是因为只有这一处该决定它们：
  //   · 客人版**剥掉**私有段，不是前端藏起来（前端藏 = 源码里能看见）
  //   · 客人版不返回「有几处被划掉」，连数量也不给 —— 那本身就是信息
  //   · 右页那块小字（走过几个地方、花了多少、夜里梦到什么）只给主人
  const 那天照片 = (date) => {
    const dir = '{{BOT_ROOT}}/共享/自拍/成品'
    let list = []
    try { list = requireDir(dir).filter(是成品图) } catch { return [] }
    const out = []
    for (const f of list) {
      let mt = 0
      try { mt = requireStat(dir + '/' + f).mtimeMs } catch { continue }
      const d = new Date(mt + 8 * 3600e3).toISOString().slice(0, 10)
      if (d !== date) continue
      const id = f.replace(/\.png$/, '')
      let meta = {}
      try { meta = JSON.parse(readFileSync(dir + '/' + id + '.json', 'utf8')) } catch { /* 老照片没有 json */ }
      out.push({
        id,
        at: new Date(mt + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
        场景: String(meta.场景 || ''),
        主体: String(meta.主体 || ''),
        话: String(meta.话 || '').trim(),
        心情: String(meta.心情 || ''),
        天: { 天气: String(meta.天气 || ''), 时段: String(meta.时段 || '') },
      })
    }
    out.sort((a, b) => a.at.localeCompare(b.at))
    return out.slice(0, 3)
  }
  const 那天统计 = (date) => {
    const asset = load(base + '/资产.json', { 记录: [] })
    // 批次174：口径在 账本.mjs（滑条那栏的三天统计原来是第五份解析）。
    const __账 = 账本.某天(asset.记录 || [], date)
    const 花 = __账.花, 赚 = __账.赚
    const 活动 = load(base + '/活动台账.json', { log: [] })
    const 去处 = new Set((活动.log || [])
      .filter((x) => String(x.at || '').startsWith(date) && x.生效)
      .map((x) => x.地点).filter(Boolean))
    // 照片数用整天的，不受「右页只贴三张」的限制
    const 照 = (() => {
      try {
        const dir = '{{BOT_ROOT}}/共享/自拍/成品'
        return requireDir(dir).filter((f) => {
          if (!是成品图(f)) return false
          try { return new Date(requireStat(dir + '/' + f).mtimeMs + 8 * 3600e3).toISOString().slice(0, 10) === date } catch { return false }
        }).length
      } catch { return 0 }
    })()
    return { 去了: 去处.size, 花, 赚, 照片: 照 }
  }
  // 梦只取「余味」那一行。梦文件本身是记忆抽取的产物，里面有群号和人设条目，
  // 整篇贴到页面上既出戏又会漏东西 —— 取不到就不显示，宁缺。
  const 那天梦 = (date) => {
    try {
      const t = readFileSync(base + '/梦-' + date + '.md', 'utf8')
      const m = t.match(/余味[:：]\s*(.+)/)
      return m && m[1].trim() ? m[1].trim().slice(0, 120) : ''
    } catch { return '' }
  }

  if (url === '/api/diary') {
    const days = []
    for (const x of 日记列表()) {
      const 给 = 日记给(日记读(x.date), sess.role)
      // 整篇都被划掉的，客人这边是空的 —— 不要列出来，那等于告诉她「这里有东西」
      if (!给 || !给.sections.length) continue
      days.push({ date: x.date, 星期: 给.星期, 摘: 给.摘, 字: 给.字 })
    }
    return json({ ok: true, role: sess.role, days })
  }
  if (url.startsWith('/api/diary/')) {
    const date = decodeURIComponent(url.slice('/api/diary/'.length))
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({ ok: false, msg: '日期不是这个写法' })
    const 篇 = 日记读(date)
    if (!篇) return json({ ok: false, msg: '这一天没有日记' })
    const 给 = 日记给(篇, sess.role)
    if (!给.sections.length) return json({ ok: false, msg: '这一天没有日记' })
    const out = { date: 给.date, 题: 给.题, 星期: 给.星期, 写于: 给.写于, 字: 给.字, 摘: 给.摘, sections: 给.sections, 天气: 日记天(date) }
    out.照片 = 那天照片(date)
    if (sess.role === 'owner') {
      out.主人 = { 私段: 给.私段, 有划掉: 给.有划掉, 统计: 那天统计(date), 梦: 那天梦(date) }
    }
    return json({ ok: true, diary: out })
  }

  if (url === '/api/wall') {
    const 谁 = verify(cookieOf(req))
    if (!谁) return send(401, 'application/json; charset=utf-8', JSON.stringify({ ok: false }))
    // WALL_GUEST 2026-11-05（批次78）：照片墙对客人也开。
    // 原来这里有一条 role !== 'owner' → 403，是批次74 定的「只给主人」。
    // 主人改主意了：它是她愿意摆出来给人看的那一面，不是私人物证。
    // 缩略图和预览图那两条路由本来就只查「有没有登录」，所以这里放开就通了。
    // 注意 /api/selfies（首页背景轮换）仍然只给主人 —— 那个不是墙，是装饰。
    const dir = '{{BOT_ROOT}}/共享/自拍/成品'
    let 表 = {}
    try { 表 = (JSON.parse(readFileSync(base + '/照片墙.json', 'utf8')).photo) || {} } catch { /* 还没写过 */ }
    // 拍照本：她按下快门时自己写的那句话，id → {主体, 构图, 话}。
    // 和 照片墙.json 的区别是这份是自动记的，不需要人补；照片墙那份留着兜老照片。
    const 本记 = (() => {
      try {
        const d = JSON.parse(readFileSync(base + '/拍照本.json', 'utf8'))
        const m = {}
        for (const x of (d.items || [])) if (x && x.id) m[x.id] = x
        return m
      } catch { return {} }
    })()
    const 角度名 = { eye: '平视', high: '俯拍', low: '仰拍', close: '贴脸' }
    // WALL_REDO_LIVE 2026-11-06（批次116）：重拍中必须能被「重新点开」看见。
    //
    // 原来「正在重拍中」只活在前端内存里（点了才开轮询），一退出灯箱就全丢，
    // 再点进来照样写着「重拍这张」，很容易又点一次、或者以为没拍成。
    // 判据不用新文件：队列里还有这张的请求，就说明它还在排队或出图中。
    // 自拍工出完图会删掉请求，这个值自己就归 false 了 —— 不会卡住。
    const 是主人 = String((谁 && 谁.role) || '') === 'owner'
    const 排队中 = (() => {
      const m = {}
      try {
        for (const f of requireDir('{{BOT_ROOT}}/共享/自拍/请求')) {
          if (!f.endsWith('.json')) continue
          const 全 = '{{BOT_ROOT}}/共享/自拍/请求/' + f
          try {
            const j = JSON.parse(readFileSync(全, 'utf8'))
            // REDO_ID_FIX 2026-11-06（批次119）：重跑请求里的 重跑 只有 {次数,上次}，没有 id。
            // 按 j.重跑.id 找，永远找不到 —— 服务端一直判「没在重拍」，
            // 只有刚点下去那几秒前端自己写着，退出灯箱再点回来就没了（主人 10:20 截图那次）。
            // 重跑沿用原来那张图的 id，请求文件名就是那个 id，直接拿文件名当目标最稳。
            if (!j.重跑) continue
            const 目标 = String(j.重跑.id || j.id || f.replace(/\.json$/, ''))
            if (目标) m[目标] = requireStat(全).mtimeMs
          } catch { /* 正在写的半截文件，下一轮再说 */ }
        }
      } catch { /* 队列目录还没建 */ }
      return m
    })()
    let list = []
    try { list = requireDir(dir).filter(是成品图) } catch { list = [] }
    // WALL_ORDER 2026-11-06（批次135）：重拍覆盖的是同名 png，mtime 会被刷新 ——
    // 按 mtime 排就成了「刚重拍的那张跳到最前面」，可它还是那天拍的那张。
    // 拍摄时间在 拍照本.json 的 at（她按快门那一刻），没有才退回 png mtime。
    const 拍于 = (id) => {
      const t = (本记[id] && 本记[id].at) || (表[id] && 表[id].at)
      const ms = t ? Date.parse(String(t).replace(' ', 'T') + ':00+08:00') : NaN
      return Number.isFinite(ms) ? ms : null
    }
    list.sort((a, b) => {
      const ia = a.replace(/\.png$/, ''), ib = b.replace(/\.png$/, '')
      const ma = 拍于(ia), mb = 拍于(ib)
      if (ma !== null && mb === null) return -1
      if (ma === null && mb !== null) return 1
      if (ma !== null && mb !== null && ma !== mb) return mb - ma
      return requireStat(dir + '/' + b).mtimeMs - requireStat(dir + '/' + a).mtimeMs
    })
    const photos = list.slice(0, 60).map((f) => {
      const id = f.replace(/\.png$/, '')
      let meta = {}
      try { meta = JSON.parse(readFileSync(dir + '/' + id + '.json', 'utf8')) } catch { /* 老照片没有 json */ }
      const 记 = 表[id] || {}
      // WALL_VER 2026-11-06（批次113）：重拍覆盖的是同名 png，URL 一个字都不变。
      // 浏览器和缩略图缓存都只认 URL —— 不给个版本号，点完重拍看到的还是老那张，
      // 会以为按钮没生效。v 就是这张 png 的修改时间。
      const 改于 = requireStat(dir + '/' + f).mtimeMs
      const 场景 = String(meta.场景 || 记.场景 || '')
      const 动作 = String(meta.动作 || 记.动作 || '')
      const 心情 = String(meta.心情 || 记.心情 || '')
      // 三层优先级：成品 json 自带的 > 拍照本 > 人补的 照片墙.json
      const 她写 = String(meta.话 || 本记[id]?.话 || 记.话 || '').trim()
      // WORDS_NOT_SHOT 2026-11-06（批次119）：在家里拍空镜时，她的画面词不进提示词
      //（自拍工 的 HOME_NO_OUTSIDE：家里有白模底图，按房间出图，她写的「站台」不算数）。
      // 可那句话还被当成这张图的说明印在下面 —— 图是客厅，字是末班车站台，像在说别人家的照片。
      // 这里只递事实「这句话不是这张图拍的东西」，前端换个说法；她的话一个字都不删。
      const 在家 = ['家', '客厅', '主卧', '次卧', '厨房', '餐厅', '门厅', '过道', '阳台'].indexOf(场景) >= 0
      const 话外 = !!(她写 && 在家 && String(meta.机位 || '') === '空镜')
      const 主体 = String(meta.主体 || 本记[id]?.主体 || 记.主体 || '')
      // WALL_WEATHER 2026-11-05（批次79）：拍照当时的天。
      // 老照片没有这几个字段，返回空串，前端就不显示 —— 不拿今天的天气去冒充。
      const 天 = {
        天气: String(meta.天气 || 本记[id]?.天气 || ''),
        时段: String(meta.时段 || 本记[id]?.时段 || ''),
        光线: String(meta.光线 || 本记[id]?.光线 || ''),
        室内: (meta.室内 ?? 本记[id]?.室内) === true,
      }
      // WALL_REDO_PRIVATE 2026-11-06（批次116）：重拍是主人的功能，这两个字段
      // 连存在都不该让客人看见 —— 客人拿到「重拍过 1 次」，等于告诉他墙上有这个口子。
      const 在拍 = !!(是主人 && 排队中[id])
      const 条目 = {
        id,
        v: Math.round(改于),
        at: new Date(改于 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
        场景, 动作, 心情, 主体,
        角度: 角度名[meta.角度] || String(记.角度 || ''),
        // 没写过就空着。原来这里退回「在便利店 · 逛贴吧 · 心情还算有精神」，
        // 点开看到的是一串字段拼贴，像报表不像她会说的话 —— 宁可承认没有。
        话: 她写,
        有描述: !!她写,
        话外,
        天,
      }
      if (是主人) {
        条目.重跑 = Number((meta.重跑 && meta.重跑.次数) || 0)
        条目.重拍中 = 在拍
        // 排在队列里多久了。超过十分钟基本就是本机自拍工没开，前端好说人话。
        条目.重拍秒 = 在拍 ? Math.max(0, Math.round((Date.now() - 排队中[id]) / 1000)) : 0
      }
      return 条目
    })
    return json({ ok: true, photos })
  }
  // SELFIE_LIST 2026-11-05：背景轮换要一组图，不能只给最新一张。
  // 只给主人（客人拿不到照片列表），最多 40 张、按时间倒序。
  if (url === '/api/selfies') {
    const 谁 = verify(cookieOf(req))
    if (!谁) return send(401, 'application/json; charset=utf-8', JSON.stringify({ ok: false }))
    if (谁.role !== 'owner') return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false }))
    try {
      const dir = '{{BOT_ROOT}}/共享/自拍/成品'
      // 这个文件里 fs 是别名导入（_rd/_st），别直接写 readdirSync/statSync——会抛错被 catch 吞成空数组
      const list = requireDir(dir).filter(是成品图)
      list.sort((a, b) => requireStat(dir + '/' + b).mtimeMs - requireStat(dir + '/' + a).mtimeMs)
      return json({ ok: true, ids: list.slice(0, 40).map((f) => f.replace(/\.png$/, '')) })
    } catch { return json({ ok: true, ids: [] }) }
  }
  // WALL_IMG 2026-11-05（批次74）：照片墙的图。第一次访问现压，之后直接读缓存。
  // 必须排在下面的 /selfie/ 前面 —— 那条只认 .png，jpg 会 404。
  if ((url.startsWith('/selfie/thumb/') || url.startsWith('/selfie/big/')) && req.method === 'GET') {
    const 谁 = verify(cookieOf(req))
    if (!谁) return send(401, 'text/plain; charset=utf-8', '先登录')
    const 大 = url.startsWith('/selfie/big/')
    const 前缀 = 大 ? '/selfie/big/' : '/selfie/thumb/'
    const id = url.slice(前缀.length).replace(/[^\w.-]/g, '')
    if (!/^[\w-]+\.jpg$/.test(id)) return send(404, 'text/plain; charset=utf-8', '没有')
    const 名 = id.replace(/\.jpg$/, '')
    const 目录 = '{{BOT_ROOT}}/共享/自拍/' + (大 ? '预览' : '缩略图')
    const 目标 = 目录 + '/' + 名 + '.jpg'
    // WALL_CACHE_BUST 2026-11-06（批次113）：重拍覆盖同名 png，可缩略图早就躺在缓存里了。
    // 原来只看「文件在不在」，于是点了重拍、墙上的图永远是老那张 —— 看起来像按钮没生效。
    // 判据改成「比源图旧就重压」，浏览器那一层由 /api/wall 的 v 一起破。
    const 源 = '{{BOT_ROOT}}/共享/自拍/成品/' + 名 + '.png'
    let 要压 = !existsSync(目标)
    if (!要压) {
      try { 要压 = requireStat(目标).mtimeMs < requireStat(源).mtimeMs } catch { /* 源图没了就用手上这份 */ }
    }
    if (要压) {
      if (!existsSync(源)) return send(404, 'text/plain; charset=utf-8', '没有这张')
      try {
        execFileSync('convert', [源, '-resize', 大 ? '1100x' : '560x', '-quality', 大 ? '86' : '82', 目标], { timeout: 25000 })
      } catch { return send(500, 'text/plain; charset=utf-8', '压图失败') }
    }
    try { return send(200, 'image/jpeg', readFileSync(目标), { 'cache-control': 'private, max-age=3600' }) }
    catch { return send(404, 'text/plain; charset=utf-8', '没有这张') }
  }
  // SELFIE_ROUTE 2026-11-05：把她的自拍喂给页面（只读、只认成品目录里的文件）
  if (url.startsWith('/selfie/') && req.method === 'GET') {
    // SELFIE_AUTH 2026-11-05：这条路由插在鉴权之前，必须自己验一遍——
    // 不然没登录的人也能直接把她的照片拉走（自测时确实 200 了，才发现）
    // 只给主人：客人连 URL 也不该能拉图（state 里本来就不下发 selfie 字段，这里堵住直接访问）
    const 谁 = verify(cookieOf(req))
    if (!谁) return send(401, 'text/plain; charset=utf-8', '先登录')
    // GUEST_SELFIE_ROUTE 2026-11-05：主人要求客人也能看她刚拍的照片，去掉了 owner 限制。
    // 仍然要求登录；id 已过正则白名单，且只能读 成品/ 下的 .png。
    const id = url.slice('/selfie/'.length).replace(/[^\w.-]/g, '')
    if (!id.endsWith('.png')) return send(404, 'text/plain; charset=utf-8', '没有')
    try {
      const buf = readFileSync('{{BOT_ROOT}}/共享/自拍/成品/' + id)
      return send(200, 'image/png', buf, { 'cache-control': 'private, max-age=300' })
    } catch { return send(404, 'text/plain; charset=utf-8', '没有这张') }
  }
  // PREVIEW_AS_GUEST 2026-11-05：主人点一下就能预览客人视角。
  // 只对 owner 生效：带 as=guest 时返回**真正的客人快照**（服务端裁剪过的），
  // 不是前端拿主人数据假装——这样预览看到的和真客人一模一样。
  if (url === '/api/state') {
    const 要看客人 = /(?:^|&)as=guest(?:&|$)/.test(String(req.url.split('?')[1] || ''))
    // PREVIEW_ROLE 2026-11-13（批次 376）：客人视图要能告诉前端「你其实是主人」。
    // 原来只返回降权后的 snapshot(role='guest')，前端 `if (!预览客人) ROLE = s.role`
    // 于是预览时 ROLE 永远停在初始值 'guest' —— isOwner 恒 false，
    // 徽章显示「客人模式」而不是「客人视角（预览）· 点这里切回」。
    // 主人点过一次预览就被锁死在客人界面，连退出重登都没用（localStorage 里的标记还在）。
    // 只加一个身份字段，不泄漏任何客人看不到的数据。
    if (要看客人 && sess.role === 'owner') return json({ ...snapshot('guest'), 真身: 'owner' })
    return json(snapshot(sess.role))
  }
  // DEBUG_VIEW_HOOK：调试数据只给主人
  // DOC_EDIT 2026-11-14（批次390）：人格与设定的读写。白名单五个 key，owner only。
  if (url === '/api/doc') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '人格设定只有主人能看、能改' })
    if (req.method === 'GET') {
      const f = String(new URL(req.url, 'http://x').searchParams.get('f') || '')
      return json(读文档(f))
    }
    if (req.method === 'POST') {
      return readBody((j) => json(写文档(String((j && j.f) || ''), j && j.内容)))
    }
    return json({ ok: false, msg: '只认 GET / POST' })
  }
  // LETTER_API 2026-11-15（批次494）：给她的话。只有主人能写；她那边通过注入看到。
  if (url === '/api/letter') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '这是你写给她的，别人不能看' })
    if (req.method === 'GET') {
      const q = new URL(req.url, 'http://x').searchParams
      if (q.get('list') === '1') return json({ ok: true, list: 留言列表() })
      return json(读留言(q.get('date')))
    }
    if (req.method === 'POST') {
      return readBody((j) => json(写留言(j && j.date, j && j.内容)))
    }
    return json({ ok: false, msg: '只认 GET / POST' })
  }
  if (url === '/api/debug') {
    if (sess.role !== 'owner') return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '这里只有主人能看' }), { 'cache-control': 'no-store' })  // 2026-11-05 改 403
    return debugDump().then((d) => json(d)).catch((e) => json({ ok: false, msg: '调试数据取不出来：' + String((e && e.message) || e).slice(0, 140) }))
  }
  // DEBUG_SET 2026-11-12：调试页「改数值」。写什么在 可调项 白名单里，
  // 不接受任意路径 —— 面板不该有一把能绕开真源写入口的万能钥匙。
  // 统一闸（OWNER_POST）已经先拦过一道，这里再判一次角色：双保险，跟别的写接口一致。
  if (url === '/api/debug/set' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能改' })
    return readBody(async (j) => {
      const id = String((j && j.id) || '')
      if (j && j.clear) return json(await 清调试覆盖(id))
      const r = await 写一项或一键(id, j && j.value)
      return json(r)
    })
  }
  // RESTART_BOT 2026-11-14（批次393）：改完 SOUL.md 必须重启 dsh-bot 才生效 —— 这是实测出来的
  // （实测：不重启的话 text() 每轮都在被调，但读到的还是旧内容 —— 是 读灵魂() 的 mtime+size
  //   缓存没按 size 变化失效，不是「装配一次」。批次393 写成「装配一次」，批次395 用取样日志纠正。）
  // 面板上没有这个按钮的时候，主人改完人设只能 SSH 上来敲命令，那不叫「实时修改」。
  // 只给主人；只重启 dsh-bot（不动 panel / upstream / gpt-sovits —— 那三个跟人设无关）。
  if (url === '/api/restart-bot' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能重启她' })
    try {
      execFileSync('systemctl', ['restart', 'dsh-bot'], { encoding: 'utf8', timeout: 60000 })
      return json({ ok: true, msg: '已重启 dsh-bot，下一句就用新人设' })
    } catch (e) {
      return json({ ok: false, msg: '重启失败：' + String((e && e.message) || e).slice(0, 120) })
    }
  }
  if (url === '/api/wall/redo' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能让她重拍' })
    return readBody((j) => json(重拍(String(j.id || '').replace(/[^\w-]/g, ''))))
  }
  // MODEL_SWITCH 2026-11-06（批次138）：主人能在面板上实时切生图底模。
  // 自拍工在本机，读的是本地的 自拍档.json —— 面板够不到它。
  // 所以写一份到共享目录，自拍工每 5 分钟看一次 mtime，变了就拉下去覆盖。
  // 只给主人：换底模会让接下来每一张都慢 3~10 倍，不是客人该碰的开关。
  if (url === '/api/model') {
    const 档P = '{{BOT_ROOT}}/共享/自拍/档位.json'
    if (req.method === 'GET') {
      if (!sess || sess.role !== 'owner') return json({ ok: false })
      let 档 = { 底模: 'turbo', cfg: null, 步数: null, 负向: null }
      try { 档 = { ...档, ...JSON.parse(readFileSync(档P, 'utf8')) } } catch { /* 还没切过 */ }
      return json({ ok: true, ...档 })
    }
    if (req.method === 'POST') {
      if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能切底模' })
      return readBody((j) => {
        const v = String(j.底模 || '')
        if (!['turbo', 'raw'].includes(v)) return json({ ok: false, msg: '只有 turbo / raw' })
        try {
          _mkd('{{BOT_ROOT}}/共享/自拍', { recursive: true })
          writeFileSync(档P, JSON.stringify({
            底模: v, cfg: null, 步数: null, 负向: null,
            写入: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
            谁: '面板',
          }, null, 2), 'utf8')
          return json({ ok: true, 底模: v, msg: '已切到 ' + v + '，下一张生效' })
        } catch (e) {
          return json({ ok: false, msg: '写不进去：' + String(e.message || e) })
        }
      })
    }
  }
  // WALL_DELETE 2026-11-06（批次120）：删照片只给主人。客人连这个路由存在都不该知道。
  if (url === '/api/wall/delete' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能删照片' })
    return readBody((j) => json(删照片(String(j.id || '').replace(/[^\w-]/g, ''))))
  }
  if (url === '/api/act' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ result: '只有主人能替她做这些' })
    return readBody((j) => json({ result: act(String(j.do || '')) }))
  }
  // /room 2026-11-12 删除：3D 房间整套已经不在了（房间页.html / 房间.mjs / fish-room.service
  // 都按主人要求删掉），这条 302 只会把人送到一个连不上的 8790。

  // API_SWITCH 2026-11-08（批次284）：调试页的「她的接口」那条工具条。
  // GET  = 现在走哪个上游 + 候选清单（全部打码）
  // POST = test（每把都验）/ add（加一把，可带上游）/ del（删）/ switch（先验后切，不重启她）
  if (url === '/api/apikey') {
    // PERM 2026-11-09（批次325）：拆成「看得见」和「动得了」两件事。
    //   客人：GET 可以（只看到现在走哪把、顺序、每把余额与冷却），POST 一律拒。
    //   主人：全开。
    // 原来 GET 也被 owner 判断挡住，客人打开用量页会看到一句「只有主人能换她的接口」，
    // 而余额本来就是客人也能看的 —— 那反倒显得页面坏了。
    // PREVIEW_GUEST 2026-11-09（批次332）：主人点「预览客人」时前端会带 ?as=guest，
    // 那就要按客人渲染 —— 只降权不升权：session 本身是客人时，带什么都还是客人。
    const 在预览客人 = /[?&]as=guest(&|$)/.test(String(req.url || ''))
    const 是主人 = sess.role === 'owner' && !在预览客人
    if (req.method === 'POST' && 读舰队配置()) {
      if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能调' })
      // {{ALT_BOT_DISPLAY}} 的数据在 fish-fleet.json，接口页的这些操作直接翻译成网关动作
      return readBody(async (j) => {
        const act = String((j && j.action) || '')
        const id = String((j && j.id) || '')
        const 网关 = async (payload) => {
          const fr = await fetch('http://127.0.0.1:' + GW_PORT + '/__fleet/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...fleetHeaders },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(30000),
          })
          return await fr.json()
        }
        const 收尾 = async (r, ok) => {
          const snap = 接口快照(await 中转健康())
          return json({ ...snap, ok: ok === undefined ? r.ok !== false : ok, msg: (r && r.msg) || '' })
        }
        try {
          if (act === 'rename') {
            return json({ ok: false, msg: '「改名」只改显示名；型号名请在「模型接口 → 自建型号」里设' })
          }
          if (act === 'setModels') {
            return 收尾(await 网关({ action: 'setModels', models: j.models }))
          }
          if (act === 'assign') {
            const 名 = String(j.名 || '').trim().slice(0, 48)
            return 收尾(await 网关({ action: 'saveSlot', slot: { id, 别名: 名 } }))
          }
          if (act === 'map') {
            const 到 = String(j.到 || '').trim().slice(0, 80)
            if (!到) return json({ ok: false, msg: '没写要切到哪个模型' })
            return 收尾(await 网关({ action: 'saveSlot', slot: { id, model: 到 } }))
          }
          if (act === 'base') {
            const base = String(j.base || '').trim().replace(/\/+$/, '')
            if (base && !/^https?:\/\//i.test(base)) return json({ ok: false, msg: '上游要写完整地址，以 http:// 或 https:// 开头' })
            return 收尾(await 网关({ action: 'saveSlot', slot: { id, base } }))
          }
          if (act === 'rate') {
            return 收尾(await 网关({
              action: 'saveSlot',
              slot: { id, 倍率: Number(j.倍率), 峰谷: j.峰谷 === true, 峰倍率: j.峰谷 === true ? Number(j.峰倍率) : null, 谷倍率: j.峰谷 === true ? Number(j.谷倍率) : null },
            }))
          }
          if (act === 'disable') {
            return 收尾(await 网关({ action: 'saveSlot', slot: { id, 停用: j.停用 === true } }))
          }
          if (act === 'note') {
            return 收尾(await 网关({ action: 'saveSlot', slot: { id, note: String(j.备注 || '').trim().slice(0, 140) } }))
          }
          if (act === 'switch') {
            return 收尾(await 网关({ action: 'activate', id }))
          }
          if (act === 'route') {
            const fleet = 读舰队配置()
            const slots = fleet.slots || []
            const hit = slots.find((s) => String(s.id) === id)
            if (!hit) return json({ ok: false, msg: '找不到这个接口' })
            const 型名 = (x) => String((x && (x.别名 || x.model)) || '').trim()
            const 型号 = 型名(hit)
            const dir = String(j.方向 || '')
            const 同型号 = slots.filter((s) => 型名(s) === 型号 && s.停用 !== true)
            if (同型号.length > 1) {
              // 同型号挂多把钥匙：只在本型号这段里挪，保证不跨型号。
              const 现有 = slots.map((s) => String(s.id))
              const 排过 = Array.isArray(fleet.slotOrder) ? fleet.slotOrder.map(String).filter((x) => 现有.includes(x)) : []
              const 序 = [...排过, ...现有.filter((x) => !排过.includes(x))]
              const 块 = 同型号.map((s) => 序.indexOf(String(s.id))).filter((i) => i >= 0).sort((a, b) => a - b)
              const at = 块.indexOf(序.indexOf(id))
              const next = dir === '顶' ? 0 : dir === '底' ? 块.length - 1 : (dir === '上' ? at - 1 : at + 1)
              if (at < 0 || next < 0 || next >= 块.length || next === at) return json({ ok: true, msg: '已经到头了' })
              return 收尾(await 网关({ action: 'moveSlot', id, to: 块[next] }))
            }
            // 这个型号只有一把：上/下就是在调型号优先级。
            const order = (fleet.modelOrder && fleet.modelOrder.length) ? fleet.modelOrder.slice() : [...new Set(slots.map((s) => 型名(s)).filter(Boolean))]
            const i = order.indexOf(型号)
            if (i < 0) return json({ ok: false, msg: '找不到这个型号' })
            const to = dir === '顶' ? 0 : dir === '底' ? order.length - 1 : (dir === '上' ? i - 1 : i + 1)
            if (to < 0 || to >= order.length || to === i) return json({ ok: true, msg: '已经到头了' })
            order.splice(i, 1)
            order.splice(to, 0, 型号)
            return 收尾(await 网关({ action: 'setModelOrder', order }))
          }
          if (act === 'del') {
            return 收尾(await 网关({ action: 'deleteSlot', id }))
          }
          if (act === 'add') {
            const key = String(j.key || '').trim()
            if (!key) return json({ ok: false, msg: '没给钥匙' })
            const 名 = String(j.名 || '').trim().slice(0, 48)
            return 收尾(await 网关({ action: 'saveSlot', slot: { key, base: String(j.base || '').trim(), model: 名 || key.slice(-8), 别名: 名 } }))
          }
          if (act === 'test') {
            return 收尾(await 网关({ action: 'probe', id }))
          }
          if (act === 'balance') return 收尾({ ok: true })
          if (act === 'schedule') return 收尾({ ok: true, msg: '接口网关没有可用时段限制，已忽略' })
          return json({ ok: false, msg: '未知操作：' + act })
        } catch (e) {
          return json({ ok: false, msg: String((e && e.message) || e) })
        }
      })
    }
    if (req.method === 'GET') {
      return 中转健康().then((康) => {
        const 快 = 接口快照(康)
        if (是主人) return json(快)
        // MASK 2026-11-09（批次326）：客人连**上游网址和 key 片段**都不能看到。
        // 主人填的是哪家站、尾号是什么，属于运维信息。
        // 客人只需要知道「有几条通道、现在走哪条、各自什么状态」——
        // 名字是主人自己起的（「0.2倍率中转站」），那个可以留。
        const 脱敏候选 = (x) => ({
          id: x.id,
          名: x.名,
          遮: x.遮 ? '••••••' : '',
          上游: '',
          查: x.查 ? { ok: x.查.ok, 余额: x.查.余额, 币: x.查.币, at: x.查.at } : null,
          用量: x.用量 || null,
        })
        const 脱敏链 = (快.路由 && Array.isArray(快.路由.链) ? 快.路由.链 : []).map((x) => ({
          序: x.序,
          id: x.id,
          名: x.名,
          上游: '',
          跳过: x.跳过,
          连续失败: x.连续失败,
          余额: x.余额,
        }))
        return json({
          ok: true,
          只读: true,
          中转: { 活着: 快.中转.活着, 名: 快.中转.名, 上游: '', 遮: '' },
          路由: { 源: 快.路由 ? 快.路由.源 : '', 先试: 快.路由?.先试, 最低余额: 快.路由 ? 快.路由.最低余额 : null, 链: 脱敏链 },
          候选: (快.候选 || []).map(脱敏候选),
        })
      })
    }
    if (!是主人) return json({ ok: false, msg: '客人只能看，不能动她的接口' })
    if (req.method !== 'POST') return json({ ok: false, msg: '只认 GET / POST' })
    return readBody(async (j) => {
      const act = String((j && j.action) || '')
      try {
        if (!读候选原档()) return json({ ok: false, msg: '候选档不可读，未修改' })
        if (act === 'schedule') {
          const list = 读候选钥匙()
          const item = list.find((x) => x.id === j.id)
          if (!item) return json({ ok: false, msg: '没有这把钥匙' })
          const 时段 = 校验时段(j.时段)
          if (!时段) return json({ ok: false, msg: '时段无效；每日时段的开始和结束不能相同' })
          item.时段 = 时段
          if (!存候选钥匙(list)) return json({ ok: false, msg: '时段保存失败' })
          return json({ ...接口快照(await 中转健康()), ok: true, msg: '时段已保存，下一次请求生效' })
        }
        if (act === 'rate') {
          const list = 读候选钥匙()
          const item = list.find((x) => x.id === j.id)
          if (!item) return json({ ok: false, msg: '没有这把钥匙' })
          const 倍 = Number(j.倍率)
          if (!(Number.isFinite(倍) && 倍 >= 0 && 倍 <= 10)) return json({ ok: false, msg: '初始倍率要填 0~10 之间的数（0 = 免费）' })
          item.倍率 = 倍
          item.峰谷 = j.峰谷 === true
          if (item.峰谷) {
            const 峰 = Number(j.峰倍率)
            const 谷 = Number(j.谷倍率)
            if (!(Number.isFinite(峰) && 峰 >= 0 && 峰 <= 10)) return json({ ok: false, msg: '峰期倍率要填 0~10 之间的数（0 = 免费）' })
            if (!(Number.isFinite(谷) && 谷 >= 0 && 谷 <= 10)) return json({ ok: false, msg: '谷期倍率要填 0~10 之间的数（0 = 免费）' })
            item.峰倍率 = 峰
            item.谷倍率 = 谷
          } else {
            delete item.峰倍率
            delete item.谷倍率
          }
          if (!存候选钥匙(list)) return json({ ok: false, msg: '倍率保存失败' })
          return json({ ...接口快照(await 中转健康()), ok: true, msg: '倍率已保存；下一次请求按当前倍率重排' })
        }
        if (act === 'base') {
          const list = 读候选钥匙()
          const item = list.find((x) => x.id === j.id)
          if (!item) return json({ ok: false, msg: '没有这把钥匙' })
          const 新上游 = String(j.base || '').trim().replace(/\/+$/, '')
          if (新上游 && !/^https?:\/\//i.test(新上游)) return json({ ok: false, msg: '上游要写完整地址，以 http:// 或 https:// 开头' })
          item.base = 新上游
          item.查 = null
          item.模型 = null
          if (!存候选钥匙(list)) return json({ ok: false, msg: '上游保存失败' })
          const 现 = 读中转配置() || {}
          if (String(现.key || '') === String(item.key || '')) {
            写中转配置({ ...现, base: 新上游, 名: item.名 })
          }
          return json({ ...接口快照(await 中转健康()), ok: true, msg: 新上游 ? '上游已改成 ' + 新上游 : '上游已改回 deepseek 官方' })
        }
        if (act === 'disable') {
          const list = 读候选钥匙()
          const item = list.find((x) => x.id === j.id)
          if (!item) return json({ ok: false, msg: '没有这把钥匙' })
          item.停用 = j.停用 === true
          if (!存候选钥匙(list)) return json({ ok: false, msg: '停用状态保存失败' })
          return json({ ...接口快照(await 中转健康()), ok: true, msg: item.停用 ? '已停用，不再参与路由' : '已启用，下一次请求就会参与排序' })
        }
        if (act === 'test') {
          const list = 读候选钥匙()
          const 已查 = []
          for (const item of list) {
            const 查 = await 验钥匙(item.key, item.base, item.map)
            if (查.时段禁用) continue
            item.查 = {
              ok: 查.ok === true,
              消息: 查.ok ? (查.余额 !== undefined ? '余额 ¥' + 查.余额 : '通（' + (查.协议 || '') + (查.模型 ? ' · ' + 查.模型 : '') + '）') : String(查.msg || ''),
              余额: 查.ok && 查.余额 !== undefined ? 查.余额 : null,
              at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
            }
            已查.push(item)
          }
          if (已查.length && !回填候选结果(已查, ['查'])) return json({ ok: false, msg: '验钥匙结果写入失败' })
          const 康 = await 中转健康()
          return json(接口快照(康))
        }
        if (act === 'balance') {
          // 并发查，不串行；查不到的留着上次的值，不覆盖成 null
          const list = 读候选钥匙()
          await Promise.all(list.map(async (item) => {
            const 钱 = await 查一把余额(item.key, item.base)
            if (钱.时段禁用) return
            item.查 = item.查 || {}
            if (钱.ok) {
              item.查.余额 = 钱.余额
              item.查.币 = 钱.币
            } else {
              item.查.余额 = null
            }
            item.查.余额于 = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
          }))
          if (!回填候选结果(list, ['查'])) return json({ ok: false, msg: '余额写入失败' })
          const 康 = await 中转健康()
          return json(接口快照(康))
        }
        if (act === 'models') {
          // 拉某把钥匙能用的模型，存进候选档（下次开页面直接用，不再等）
          const id = String((j && j.id) || '')
          const list = 读候选钥匙()
          const item = list.filter((x) => String(x.id || '') === id)[0]
          if (!item) return json({ ok: false, msg: '没有这把钥匙' })
          const 查 = await 查一把模型(item.key, item.base)
          if (查.时段禁用) return json({ ok: false, msg: 查.msg })
          item.模型 = {
            列表: 查.ok ? 查.列表 : [],
            错: 查.ok ? '' : String(查.msg || ''),
            于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
          }
          if (!回填候选结果([item], ['模型'])) return json({ ok: false, msg: '模型列表写入失败' })
          return json(接口快照(await 中转健康()))
        }
        if (act === 'map') {
          // 切模型：改「dsh 发的名字 → 上游认的名字」这条映射。
          // 先发一条真请求验，通了才写盘 —— 名字填错会让她下一句就 400 model_not_found。
          const id = String((j && j.id) || '')
          const 源 = String((j && j.源) || 'deepseek-flash').trim()
          const 到 = String((j && j.到) || '').trim().slice(0, 80)
          if (!到) return json({ ok: false, msg: '没写要切到哪个模型' })
          const list = 读候选钥匙()
          const item = list.filter((x) => String(x.id || '') === id)[0]
          if (!item) return json({ ok: false, msg: '没有这把钥匙' })
          const 照 = { ...(item.map || {}), [源]: 到 }
          const 查 = await 验钥匙(item.key, item.base, 照)
          if (查.ok !== true) return json({ ok: false, msg: '这个模型名在这把钥匙上不通：' + String(查.msg || '').slice(0, 160) })
          item.map = 照
          item.查 = { ok: true, 消息: '通（' + 到 + '）', 余额: item.查 ? item.查.余额 : null, at: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') }
          if (!回填候选结果([item], ['map', '查'])) return json({ ok: false, msg: '模型映射写入失败' })
          // 正在用这把 → 中转配置同步改，下一句就生效（不用重启她）
          const 现 = 读中转配置() || {}
          if (String(现.名 || '') === String(item.名 || '')) {
            写中转配置({ ...现, map: 照 })
          }
          return json(接口快照(await 中转健康()))
        }
        if (act === 'rename') {
          // 改名字。注意：改名**不会**把历史用量搬过去 —— 中转的日汇总是按「上游名」累计的，
          // 改了名，今天之前的账还挂在旧名下。要合并得手工改 fish-usage.json。
          const id = String((j && j.id) || '')
          const 新名 = String((j && j.名) || '').trim().slice(0, 24)
          if (!新名) return json({ ok: false, msg: '名字不能空' })
          const list = 读候选钥匙()
          const item = list.filter((x) => String(x.id || '') === id)[0]
          if (!item) return json({ ok: false, msg: '没有这把钥匙' })
          if (list.some((x) => String(x.id) !== id && String(x.名 || '') === 新名)) {
            return json({ ok: false, msg: '已经有一把叫这个名字了' })
          }
          const 旧名 = String(item.名 || '')
          item.名 = 新名
          存候选钥匙(list)
          // RENAME_SYNC 2026-11-09（批次333）：不记这一笔，「花在哪」会多出一组 ——
          // 新请求记新名、旧账还挂着旧名，同一把钥匙占两行。
          记别名(旧名, 新名)
          合并当日用量(旧名, 新名)
          // 正在用的那把：配置里的名也要跟着改，否则「现在走 X」会一直显示旧名
          const 现 = 读中转配置() || {}
          if (String(现.名 || '') === 旧名) {
            写中转配置({ ...现, 名: 新名 })
          }
          return json(接口快照(await 中转健康()))
        }
        if (act === 'add') {
          const key = String((j && j.key) || '').trim()
          const 名 = String((j && j.名) || '').trim().slice(0, 24)
          // 备注是给人看的（主号/备用/便宜的那把），跟钥匙一起存，切走也还在
          const 备注 = String((j && j.备注) || '').trim().slice(0, 60)
          const base = String((j && j.base) || '').trim().replace(/\/+$/, '')
          if (!key) return json({ ok: false, msg: '没给钥匙' })
          const list = 读候选钥匙()
          if (list.some((x) => String(x.key) === key && String(x.base || '') === base)) {
            return json({ ok: false, msg: '这把（这个上游）已经在清单里了' })
          }
          // portdan 这类站的模型名和 dsh 发的不一样，写死一份映射：
          // dsh 发 deepseek-flash / deepseek-v4-pro，中转站认的是带小数点的那套。
          const map = /portdan\.com/.test(base)
            ? { 'deepseek-flash': 'deepseek-v4.1-flash', 'deepseek-v4-pro': 'deepseek-v4-pro' }
            : {}
          const 查 = await 验钥匙(key, base, map)
          if (查.时段禁用) return json({ ok: false, msg: 查.msg })
          const 最新 = 读候选原档()
          if (!最新 || 最新.some((x) => String(x.key) === key && String(x.base || '') === base)) {
            return json({ ok: false, msg: '候选档不可读或这把已经存在' })
          }
          const 新id = 'k' + Date.now().toString(36)
          最新.push({
            id: 新id,
            名,
            备注,
            base,
            key,
            map,
            加于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
            查: { ok: 查.ok === true, 消息: 查.ok ? (查.余额 !== undefined ? '余额 ¥' + 查.余额 : '通（' + (查.协议 || '') + '）') : String(查.msg || '') },
          })
          if (!存候选钥匙(最新)) return json({ ok: false, msg: '候选档保存失败' })
          // 新加的钥匙默认进路由；不然「所有钥匙」里看得见，实际永远不会被试用。
          const 现 = 读中转配置() || {}
          if (Array.isArray(现.路由) && !现.路由.includes(新id)) {
            写中转配置({ ...现, 倍率优先: true, 路由: [...现.路由, 新id] })
          }
          const 康 = await 中转健康()
          return json({ ok: true, msg: 查.ok ? '加上了，验通了' : '加上了，但这把现在验不过：' + (查.msg || ''), ...接口快照(康) })
        }
        if (act === 'note') {
          const id = String((j && j.id) || '')
          const 备注 = String((j && j.备注) || '').trim().slice(0, 60)
          const list = 读候选钥匙()
          const hit = list.find((x) => String(x.id || '') === id)
          if (!hit) return json({ ok: false, msg: '没找到这把' })
          hit.备注 = 备注
          if (!存候选钥匙(list)) return json({ ok: false, msg: '备注写不进去（文件权限？）' })
          const 康 = await 中转健康()
          return json({ ok: true, msg: 备注 ? ('备注存好了：' + 备注) : '备注清空了', ...接口快照(康) })
        }
        if (act === 'del') {
          const id = String((j && j.id) || '')
          const list = 读候选钥匙()
          const hit = list.find((x) => x.id === id)
          if (hit && 候选时段(hit)?.模式 !== '不限') return json({ ok: false, msg: '有时段限制的接口不可直接删除，防止仍在使用的凭证失去限制' })
          if (!存候选钥匙(list.filter((x) => x.id !== id))) return json({ ok: false, msg: '候选档保存失败' })
          const 康 = await 中转健康()
          return json({ ok: true, msg: '删了', ...接口快照(康) })
        }
        if (act === 'switch') {
          const id = String((j && j.id) || '')
          const list = 读候选钥匙().filter((x) => String(x.id || '') === id)
          const hit = list[0]
          if (!hit) return json({ ok: false, msg: '没找到这把钥匙' })
          const r = await 换上游(hit)
          // ROUTE 2026-11-09（批次325）：切到这把 = 把它排到路由第一位。
          // 不然「切了 key 但路由还指着原来那把」，下一句到底走谁就看运气了。
          if (!r || r.ok !== false) {
            const 现2 = 读中转配置() || {}
            const 全部 = 读候选钥匙().map((x) => String(x.id || '')).filter(Boolean)
            let 链 = Array.isArray(现2.路由) && 现2.路由.length ? 现2.路由.map(String) : 全部.slice()
            链 = [id, ...链.filter((x) => x !== id)]
            for (const x of 全部) if (链.indexOf(x) < 0) 链.push(x)
            写中转配置({ ...现2, 路由: 链 })
          }
          const 康 = await 中转健康()
          return json({ ...接口快照(康), ...r })
        }
        if (act === 'route') {
          // ROUTE_ORDER 2026-11-09（批次325）：主人在面板上实时调顺序。
          // 两种入参：
          //   { ids: ['B','A'] }        —— 直接设整条（前端拖拽/整体保存用）
          //   { id:'B', 方向:'上'|'下'|'顶'|'底' } —— 单步调整（按钮用，最不容易出错）
          // 只写配置，不重启 —— 中转每请求现读，下一句生效。
          const 现 = 读中转配置() || {}
          const 候选 = 读候选钥匙()
          const 全部 = 候选.map((x) => String(x.id || '')).filter(Boolean)
          if (!全部.length) return json({ ok: false, msg: '候选里一把钥匙都没有' })
          let 链 = Array.isArray(现.路由) && 现.路由.length
            ? 现.路由.map(String).filter((x) => 全部.indexOf(x) >= 0)
            : 全部.slice()
          链 = 链.filter((x, i) => 链.indexOf(x) === i)
          // 新加进来、还没排过的钥匙自动排到最后（不能因为「没排」就永远不用它）
          for (const x of 全部) if (链.indexOf(x) < 0) 链.push(x)

          const ids = Array.isArray(j && j.ids) ? j.ids.map((x) => String(x)) : null
          if (ids) {
            链 = ids.filter((x) => 全部.indexOf(x) >= 0)
            链 = 链.filter((x, i) => 链.indexOf(x) === i)
            for (const x of 全部) if (链.indexOf(x) < 0) 链.push(x)
          } else {
            const id = String((j && j.id) || '')
            const 方向 = String((j && j.方向) || '顶')
            const i = 链.indexOf(id)
            if (i < 0) return json({ ok: false, msg: '这把不在路由里' })
            if (方向 === '顶' && i > 0) { 链.splice(i, 1); 链.unshift(id) } else if (方向 === '上' && i > 0) {
              链.splice(i, 1); 链.splice(i - 1, 0, id)
            } else if (方向 === '下' && i < 链.length - 1) { 链.splice(i, 1); 链.splice(i + 1, 0, id) } else if (方向 === '底' && i < 链.length - 1) {
              链.splice(i, 1); 链.push(id)
            }
          }

          // 首选的 名/base/key/map 同步一份到顶层：老读法（/api/balance、余额胶囊）只看顶层字段。
          // base 为空的（官方那把）要补成官方地址，跟中转里 建链 的口径一致。
          const 首 = 候选.filter((x) => String(x.id) === 链[0])[0]
          const next = { ...现, 路由: 链 }
          if (首) {
            next.名 = String(首.名 || '')
            next.base = String(首.base || '').replace(/\/+$/, '') || 官方BASE
            next.key = String(首.key || '')
            next.map = 首.map && typeof 首.map === 'object' ? 首.map : {}
          }
          try { 写中转配置(next) } catch (e) {
            return json({ ok: false, msg: '写中转配置失败：' + String((e && e.message) || e).slice(0, 120) })
          }
          return json({ ok: true, msg: '已生效', ...接口快照(await 中转健康()) })
        }
        return json({ ok: false, msg: '不认识的 action：' + act })
      } catch (e) {
        return json({ ok: false, msg: '接口出错了：' + String((e && e.message) || e).slice(0, 160) })
      }
    })
  }
  // BALANCE_ROUTE 2026-11-08（批次286）：顶部余额/用量。**登录即可看，客人也有**，
  // 只回数字和供应商名，不回任何 key。?force=1 = 手动刷新（15 秒内只放一次）。
  if (url === '/api/balance') {
    const force = /(^|&)force=1(&|$)/.test(String(req.url.split('?')[1] || ''))
    return 取余额(force)
      .then((d) => json(d))
      .catch((e) => json({ ok: false, 说明: '读不到余额：' + String((e && e.message) || e).slice(0, 120) }))
  }
  // USAGE_ROUTE 2026-11-08（批次287）：token 用量。汇总给所有人（含客人），
  // 逐条流水只给主人——那里有聊天摘要，不是客人该看的。
  // OMNI_API 2026-11-12：听（omni）/ 说（TTS）的 key、base、模型。
  // 读给主人看（key 打码），写只有主人。改完写 {{DSH_ROOT}}/fish-omni.json，
  // 视频音频.mjs / 语音合成.mjs 每次调用现读 —— 下一句生效，不重启。
  // REALTIME 2026-11-12（主人：实时模式 = 她对话任务不停下来）：
  // 这个开关控制的是**她**，不是面板刷新 —— 插件在每回合结束时读这份文件，
  // 开着她就会在自己动过工具的回合结束后接着做（有连跑上限和冷却）。
  if (url === '/api/realtime') {
    const 档 = '{{DSH_ROOT}}/fish-realtime.json'
    const 读 = () => { try { return JSON.parse(readFileSync(档, 'utf8')) } catch { return {} } }
    if (req.method === 'GET') {
      const j = 读()
      return json({
        ok: true,
        开: j.实时 === true,
        上限: Number(j.上限) || 6,
        间隔秒: Number(j.间隔秒) || 4,
        可以改: String(sess.role) === 'owner',
      })
    }
    if (String(sess.role) !== 'owner') return json({ ok: false, msg: '只有主人能改' })
    return readBody((j) => {
      const 旧 = 读()
      const 新 = {
        实时: j.开 === true,
        上限: Math.max(1, Math.min(20, Number(j.上限) || Number(旧.上限) || 6)),
        间隔秒: Math.max(2, Math.min(60, Number(j.间隔秒) || Number(旧.间隔秒) || 4)),
        冷却分: Math.max(1, Math.min(180, Number(j.冷却分) || Number(旧.冷却分) || 20)),
        改于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
      }
      try {
        writeFileSync(档, JSON.stringify(新, null, 2))
        try { chmodSync(档, 0o600) } catch { /* 权限设不上不影响 */ }
      } catch (e) { return json({ ok: false, msg: '写不进开关：' + e.message }) }
      return json({ ok: true, 开: 新.实时, 上限: 新.上限, 间隔秒: 新.间隔秒 })
    })
  }

  // MUSIC_3S 2026-11-12：客户端每秒推，但「换歌了没有」只能问服务端。
  // 单开一条最轻的：读两个 json、几百字节；面板 3 秒一次，换歌才触发整页刷新。
  if (url === '/api/now' && req.method === 'GET') {
    return send(200, 'application/json; charset=utf-8',
      JSON.stringify({
        ok: true, at: Date.now(),
        // 预览客人（?as=guest）也按客人给：听感不下发，跟前端那个 fetch 包装一个口径。
        音乐: 此刻音乐(String(sess.role) === 'owner' && !/[?&]as=guest(&|$)/.test(String(req.url || ''))),
      }), { 'cache-control': 'no-store' })
  }

  if (url === '/api/omni') {
    // GUEST_RO 2026-11-12：客人也看得见这一段，跟「她的接口」一个待遇 —— 看得见、动不了、运维信息遮住。
    //   主人：全量（key 本来就是打码的）。
    //   客人：key 一律 ••••••，base / upload 抹空（填的是哪家网关、走哪个上传入口，属于运维信息），
    //         模型名和音色留着 —— 客人只需要知道「她现在用什么听、用什么说」。
    //   写：仍然只有主人。主人点「预览客人」带 ?as=guest 时也按客人渲染（只降权不升权）。
    const 在预览客人 = /[?&]as=guest(&|$)/.test(String(req.url || ''))
    const 是主人 = String(sess.role) === 'owner' && !在预览客人
    if (req.method === 'GET') {
      const 快 = Object.assign(接入快照(), { 用量: omni用量(), 客人: !是主人 })
      if (是主人) return json(快)
      const 脱敏 = (x) => {
        const o = x || {}
        return {
          名: o.名,
          协议: o.协议,
          模型: o.模型,
          音色: o.音色,
          base: '',
          upload: '',
          遮: o.遮 ? '••••••' : '',
          来源: o.来源,
          可用: o.可用,
        }
      }
      return json({
        ok: true,
        客人: true,
        改于: 快.改于,
        用量: 快.用量,
        听: 脱敏(快.听),
        说: 脱敏(快.说),
        看视频: { 模式: (快.看视频 || {}).模式 },
        一起听: { 开启: (快.一起听 || {}).开启 !== false },
      })
    }
    if (!是主人) return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '只有主人能改' }), { 'cache-control': 'no-store' })
    // 余额不在这里查：三个 404 并行也要几秒，首屏会被它拖住。前端单独发一次 balance。
    return readBody(async (j) => {
      const act = String((j && j.action) || 'save')
      try {
        if (act === 'test') return json({ ok: true, 听: await 验听() })
        if (act === 'models') return json(await 拉omni模型())
        if (act === 'local') return json(本地音色档())
        if (act === 'weights') return json(await 换权重(j && j.sovits, j && j.gpt))
        if (act === 'leak') return json(读滤开关())
        if (act === 'leakSet') return json(写滤开关(j && j.on, j && j.关思考, j && j.记录))
        if (act === 'probe') return json(读探测())
        if (act === 'thoughts') return json({ ok: true, 条: 读思考(j && j.n, j && j.谁), 记录中: 记思考() })
        if (act === 'balance') return json(Object.assign({ ok: true }, await 查omni余额(), { 用量: omni用量() }))
        if (act === 'testSay') return json(await 试说('喂，听得到吗'))
        if (act === 'speak') return json(await 试说(j && j.text))
        if (act === 'save') {
          const 旧 = 读接入()
          // key 的特殊值：不传/空串 = 不动（页面回传的是打码，拿它覆盖就废了）；'-' = 清掉回退环境变量
          const 合段 = (新段, 旧段) => {
            const o = Object.assign({}, 旧段 || {})
            for (const k of ['名', 'base', 'upload', '模型', '音色', '协议', '语气']) {
              if (新段 && 新段[k] !== undefined) o[k] = String(新段[k] || '').slice(0, 300)
            }
            if (新段 && 新段.key !== undefined) {
              const k = String(新段.key)
              if (k === '-') delete o.key
              else if (k && k.indexOf('•') < 0 && k.indexOf('…') < 0) o.key = k.slice(0, 300)
            }
            return o
          }
          const 旧看 = (旧 && 旧['看视频']) || {}
          const 新看 = j && j['看视频']
            ? { 模式: String(j['看视频'].模式 || '').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'omni' }
            : { 模式: String(旧看.模式 || '').trim().toLowerCase() === 'storyboard' ? 'storyboard' : 'omni' }
          const 旧歌 = (旧 && 旧['一起听']) || {}
          const 新歌 = (j && j['一起听'] && typeof j['一起听'].开启 === 'boolean')
            ? { 开启: j['一起听'].开启 }
            : { 开启: 旧歌.开启 !== false }
          // MUSIC_SWITCH 2026-11-12：换「跟谁一起听」。账号本体存在 netease-accounts.json，
          // 这里只改它的 当前 —— cookie 不出这个文件，也不进 fish-omni.json。
          if (j && j['一起听'] && j['一起听'].账号 !== undefined) {
            const 要 = String(j['一起听'].账号 || '')
            if (要) {
              const 账 = 读音乐账号()
              if (!(账.账号 || []).some((x) => String(x.id) === 要)) {
                return json({ ok: false, msg: '没有这个号：' + 要 })
              }
              账.当前 = 要
              写档(MUSIC_ACCOUNTS, 账)
              try { chmodSync(MUSIC_ACCOUNTS, 0o600) } catch { /* 权限没改成功不影响用 */ }
            }
          }
          const 新听 = 合段(j['听'], 旧['听'])
          // 同上：实时模型在这个接口上必然空响应，别让它存进去之后悄悄降级。
          if (/realtime/i.test(String(新听.模型 || ''))) {
            return json({
              ok: false,
              msg: '「听」的模型不能用实时版（' + String(新听.模型) + '）：'
                + 'realtime 走流式接口，这里的音画理解是一次性请求，实测只会拿到空响应、然后静默降级到 Storyboard。'
                + '能直接用的：qwen3.8-omni-flash（实测视频 2.0s、音频 14.2s 均正常）或 qwen3.5-omni-plus。',
            })
          }
          const 新 = {
            '听': 新听,
            '说': 合段(j['说'], 旧['说']),
            '看视频': 新看,
            '一起听': 新歌,
            改于: new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' '),
          }
          // 若主人刚关掉一起听，顺手把 一起听.json 标为 disabled，不用等下一分钟心跳
          if (!新歌.开启) {
            try {
              const 旧态 = load(base + '/一起听.json', null)
              if (旧态) 写档(base + '/一起听.json', Object.assign({}, 旧态, { active: false, disabled: true }))
            } catch (_err) { console.error('[面板]', _err?.message || _err) }
          }
          存接入(新)
          return json({ ok: true, msg: '存好了，下一句生效', 快照: 接入快照() })
        }
        return json({ ok: false, msg: '不认识的 action：' + act })
      } catch (e) {
        return json({ ok: false, msg: '出错了：' + String((e && e.message) || e).slice(0, 140) })
      }
    })
  }
  // 试听的 mp3：只给主人，名字必须是 语音合成.mjs 生成的那种，不接受路径
  if (url.startsWith('/api/omni/audio/')) {
    if (String(sess.role) !== 'owner') return send(403, 'text/plain; charset=utf-8', '只有主人能听')
    const 名 = decodeURIComponent(url.slice('/api/omni/audio/'.length))
    // 上游回来的可能是 wav（qwen3-tts-flash 就是），别把扩展名钉死在 mp3
    if (!/^tts-\d{8,20}\.(mp3|wav)$/.test(名)) return send(404, 'text/plain; charset=utf-8', '没有')
    const 型 = 名.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg'
    try { return send(200, 型, _rf(试听目录 + '/' + 名), { 'cache-control': 'no-store' }) }
    catch { return send(404, 'text/plain; charset=utf-8', '没有') }
  }
  if (url === '/api/usage') {
    const q = String(req.url.split('?')[1] || '')
    const m = /(?:^|&)days=(\d{1,2})/.exec(q)
    // GUEST_LIST 2026-11-09（批次333）：最近调用的「摘要」是她跟人说话的内容，
    // 客人不该看到。主人点「预览客人」时也算客人（只降权不升权）。
    const 在预览客人 = /[?&]as=guest(&|$)/.test(String(req.url || ''))
    const 表 = 用量汇总(m ? Number(m[1]) : 7, sess.role === 'owner' && !在预览客人)
    // BILL 2026-11-09（批次316）：余额和真实扣费挂在同一个响应上，
    // 免得前端为了一张卡再发一次请求。查不到就 账单:null，页面显示「查不到」。
    return 取上游账单().then((账) => json({ ...表, 账单: 账 })).catch(() => json({ ...表, 账单: null }))
  }
  // API_404 2026-11-04：未知 /api 路径返回 404 JSON，别把整页 HTML 当接口结果
  // ── 留言板 2026-11-08（批次228）────────────────────────────
  // 全部人同一块板；便签位置、颜色、评论都存在 共享/留言板/<日期>.json。
  // 重叠判据只在 留言板.找位() 一处，前端只是先试一下给个提示。
  if (url === '/api/board') {
    const date = String(new URL(req.url, 'http://x').searchParams.get('date') || '').trim()
    const 日 = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)
    const d = 留言板.读(日)
    return json({ ok: true, role: sess.role, date: 日, today: 留言板.今天(), notes: d.notes, days: 留言板.日表(留言板.今天()), 颜色: 留言板.颜色, 色: 留言板.色, photos: true })
  }
  if (url === '/api/board/photo' && req.method === 'GET') {
    const 参数 = new URL(req.url, 'http://x').searchParams
    const 图 = 留言板.取照片(参数.get('date'), 参数.get('id'))
    if (!图) return send(404, 'text/plain; charset=utf-8', '照片找不到了')
    return send(200, 'image/jpeg', 图, { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' })
  }
  const 可改板照片 = sess.role === 'owner' && !/[?&]as=guest(&|$)/.test(String(req.url || ''))
  const 板名 = (值) => {
    const 名 = String(值 || '').trim().slice(0, 12)
    // ROLE_NAME 2026-11-24：原来这里写死两个实例名判断「客人」。改成只把「主人」和
// 机器人自己的显示名认作非客人，实例名从环境变量/占位符来，模板通用。
  const __selfNames = String(process.env.BOARD_BOT_NAMES || '{{BOT_DISPLAY}}').split(',').map(x => x.trim()).filter(Boolean)
    return sess.role === 'owner' ? '主人' : (名 && !['主人', ...__selfNames].includes(名) ? 名 : '客人')
  }
  const 板操作 = (执行) => {
    try { return json(执行()) } catch (error) {
      console.warn('[留言板] 保存失败', error.code || error.message)
      return json({ ok: false, msg: '留言板保存失败，请重试' })
    }
  }
  if (url === '/api/board/photo' && req.method === 'POST') {
    if (!可改板照片) return json({ ok: false, msg: '只有主人能编辑照片' })
    return readBody((参数) => 板操作(() => 留言板.编辑照片(参数 || {})))
  }
  if (url === '/api/board/note' && req.method === 'POST') {
    return readBody((j) => 板操作(() => {
      if (j?.photo && !可改板照片) return { ok: false, msg: '只有主人能上传照片' }
      return 留言板.贴({
        date: j?.date, by: 板名(j?.by), color: j?.color, text: j?.text,
        x: j?.x, y: j?.y, w: j?.w, h: j?.h, photo: j?.photo,
      })
    }))
  }
  // BOARD_EDIT 2026-11-08（批次231）：挪位置、撕便签只给主人。
  // 客人可以贴、可以留言，但不能动别人的东西；服务端判，前端只是藏按钮。
  if (url === '/api/board/move' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能挪便签' })
    return readBody((j) => 板操作(() => 留言板.移动({ date: j?.date, id: j?.id, x: j?.x, y: j?.y })))
  }
  if (url === '/api/board/delete' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能撕便签' })
    return readBody((j) => 板操作(() => 留言板.撕({ date: j?.date, id: j?.id })))
  }
  if (url === '/api/board/comment' && req.method === 'POST') {
    return readBody((j) => 板操作(() => 留言板.评论({ date: j?.date, id: j?.id, by: 板名(j?.by), text: j?.text })))
  }

  // ── 待办 2026-11-08（批次229）──────────────────────────────
  // 主人点「需要你处理」那张卡进来：看全部、标为已处理、撤回、自己加一条。
  // 权限一律服务端判；读写规则全在 待办.mjs，这里只转发。
  if (url === '/api/todo') {
    // 批次352：跟 349 的写闸对齐，读也不再回 200+ok:false。
    // 预览客人也算客人（332 的教训：只看 sess.role 会把主人版露出去）。
    const 在预览 = /[?&]as=guest(&|$)/.test(String(req.url || ''))
    if (sess.role !== 'owner' || 在预览) return send(403, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '只有主人能看' }), { 'cache-control': 'no-store' })
    const d = 待办.读()
    return json({ ok: true, items: d.items, done: d.done.slice(-12) })
  }
  if (url === '/api/todo/done' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能处理' })
    return readBody((j) => {
      try { return json(待办.完成(j.id, '主人')) } catch (e) { return json({ ok: false, msg: '写不进去：' + e.message }) }
    })
  }
  if (url === '/api/todo/undo' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能撤回' })
    return readBody((j) => {
      try { return json(待办.撤回(j.id)) } catch (e) { return json({ ok: false, msg: '写不进去：' + e.message }) }
    })
  }
  if (url === '/api/todo/add' && req.method === 'POST') {
    if (sess.role !== 'owner') return json({ ok: false, msg: '只有主人能加' })
    return readBody((j) => {
      try { return json(待办.加({ 事项: j.事项, 来源: '主人' })) } catch (e) { return json({ ok: false, msg: '写不进去：' + e.message }) }
    })
  }

  if (url === '/qq') {
    if (!verify(cookieOf(req))) { res.writeHead(302, { location: '/login' }); return res.end() }
    return send(200, 'text/html; charset=utf-8', `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>QQ 登录</title>
<style>
 body{margin:0;background:#f4f4f5;font:15px/1.6 system-ui,"Microsoft YaHei";color:#222;display:flex;flex-direction:column;align-items:center;padding:18px}
 h1{font-size:17px;font-weight:600;margin:4px 0 12px}
 .card{background:#fff;border:1px solid #e4e4e7;border-radius:14px;padding:12px;box-shadow:0 1px 3px rgba(0,0,0,.05);margin-bottom:12px}
 img{display:block;max-width:100%;border-radius:8px}
 #win{width:min(560px,92vw)}
 #qr{width:min(320px,72vw)}
 button{padding:9px 18px;border:1px solid #d4d4d8;background:#fff;border-radius:9px;font:inherit;cursor:pointer}
 .tip{color:#71717a;font-size:13px}
</style>
<h1>QQ 登录窗口</h1>
<div class="card"><img id="win" src="/api/fleet/qqwin" alt="QQ 登录窗口"></div>
<div class="card"><img id="qr" src="/api/fleet/qrcode" alt="登录二维码"></div>
<div class="tip">每 4 秒自动刷新；码过期点下面的按钮，或直接在窗口里点「刷新」。</div>
<button id="rf">重新抓码</button>
<script>
const w=document.getElementById('win'),q=document.getElementById('qr');
function 刷(force){const t='?t='+Date.now()+(force?'&refresh=1':'');w.src='/api/fleet/qqwin'+t;q.src='/api/fleet/qrcode'+t;}
document.getElementById('rf').onclick=function(){刷(true)};
setInterval(function(){刷(false)},4000);
</script>`, { 'cache-control': 'no-store' })
  }
  if (url.startsWith('/api/')) return send(404, 'application/json; charset=utf-8', JSON.stringify({ ok: false, msg: '没有这个接口：' + url }))
  // 2026-11-12：老界面没了，兜底要说人话 ——
  // 没会话直接开 / 或 /login 的都该看到登录页（以前给的是那份旧界面，转一辈子「读状态中…」）。
  if (url === '/' || url === '/login') {
    return send(200, 'text/html; charset=utf-8', authPageHtml(), { 'cache-control': 'no-store' })
  }
  return send(404, 'text/html; charset=utf-8',
    '<!doctype html><meta charset="utf-8"><title>没有这个页面</title>'
    + '<div style="font:16px/1.8 system-ui;padding:48px;color:#333">没有这个页面 · <a href="/">回面板</a></div>')
})
面板服务.listen(PORT, '0.0.0.0', () => console.log('面板 v7 起来了：' + PORT))
守调试覆盖()
setInterval(守调试覆盖, 4000).unref()
