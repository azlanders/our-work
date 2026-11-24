/**
 * photo.js —— 注册 qq_photo：她自己按快门。
 *
 * 批次109（2026-11-06）：主人说「告诉她她能用的拍照功能」。
 *
 * 查下来两件事：
 *   1. 她**没有**按快门的工具。`自拍.mjs` 只在 `自主行动.mjs` 抽到「拍张照」时被调用，
 *      她本人在对话里说「我拍给你看」时，没有一条路能让这张照片真的存在 ——
 *      跟批次106 的「没有腿」是同一类错：没给路径，却指望她说得到做得到。
 *   2. 她写的那句话（`话`）从来回不到提示里。`poll.js` 的 `[相册]` 只读
 *      `记忆/拍照本.json`，而那份文件当时并不存在 → `statSync` 抛异常 → 整段静默消失。
 *      于是被问「你最近拍什么了」时，她手上只有「拍了张照」。
 *
 * 这个文件做两件事：
 *   · `拍一张()` —— 调 `自拍.mjs --不想`（跳过「再问一次模型」，画面和那句话由她在对话里当场定），
 *     写进 `共享/自拍/请求/<id>.json`，等本机出图。
 *   · `相册提示()` —— 把最近几张的「话」和最新一张的成品路径拼成一句，供 `poll.js` 注入。
 *
 * 判断权在她：拍不拍、拍什么、写什么话，全由她调不调这个工具决定。
 * 系统不按她的话自动建请求（同「滚 = 回滚」的教训：正则判语义几乎全错）。
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { dirname, join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { note, serviceOf } from './env.js'
// SLEEP_ONE 2026-11-07（批次168）：判睡眠只问这一处
import { 睡着 } from './sleepgate.js'
// PHOTO_WATCH 2026-11-13：照片出来要叫她一声，别让她说完「等它出来发你」就断了。
import { 记下待发 } from './photoWatch.js'
// 快门按下去的时候，这一轮正跟谁说话 —— 出来就发给谁。
import { recentDelivery } from './rhythm.js'
import { getConfig } from './config.js'

const 跑 = promisify(execFile)

// SANDBOX：测试要把两个目录都指走。自拍.mjs 认 SHOT_MEM / SHOT_BASE，
// 调它时必须把同一组值传下去，否则它会往她真队列里塞一张假请求。
const 记忆目录 = () => process.env.QQ_PHOTO_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`
const 工具目录 = () => process.env.QQ_PHOTO_TOOLS || `${QQ_WS}/共享/工具`
const 相册目录 = () => process.env.QQ_PHOTO_BASE || `${QQ_WS}/共享/自拍`

const 读档 = (p, d) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return d } }
// ATOMIC：先写临时文件再改名。自主行动 每分钟 tick，撞上也不能留半截 JSON。
const 存档 = (p, o) => {
  try {
    mkdirSync(dirname(p), { recursive: true })
    const tmp = p + '.tmp-' + process.pid + '-' + Date.now()
    writeFileSync(tmp, JSON.stringify(o, null, 2))
    renameSync(tmp, p)
    return true
  } catch { return false }
}

/** 主体只认这五个 —— 渲染端按它决定加不加「1girl, solo」那套角色段。 */
export const 主体表 = ['自己', '风景', '物件', '别人', '猫']

/**
 * 机位三选一（批次114）。主人：「不局限于自拍，还能让她固定机位拍她自己和场景，
 * 还能直接拍场景图」。
 *
 *   自拍  手拿机位，她占画面主体（默认）
 *   固定  机位架在几步外，她整个人入画，地方也看得清
 *   空镜  画面里只有景 / 物 / 别人 / 猫，没有她
 *
 * 不传就按主体推：自己 → 自拍，其余 → 空镜。
 * 判断只在渲染端（`定机位()`）一处，这里只负责把话传过去。
 */
export const 机位表 = ['自拍', '固定', '空镜']

/** 按内容的 mtime 倒序列出成品 json（只要已经有 png 的，才算真出图了）。 */
function 最近的成品(base, 条数 = 3) {
  const dir = join(base, '成品')
  let 名 = []
  try { 名 = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return [] }
  const 有 = []
  for (const f of 名) {
    const id = f.replace(/\.json$/, '')
    // 先滤掉没出图的：渲染端可能先写 json 再写 png，
    // 也可能只写了一半就断了。让它占了最近三张的名额，
    // 真正出好的旧照片就挤不进相册 —— 她会以为自己只拍过两张。
    if (!existsSync(join(dir, id + '.png'))) continue
    try {
      const st = statSync(join(dir, f))
      有.push({ id, at: st.mtimeMs, png: true })
    } catch { /* 读不到就跳过 */ }
  }
  有.sort((a, b) => b.at - a.at)
  return 有.slice(0, 条数)
}

// TIME_TAG 2026-11-13：主人说「那你自己给自己时间观念修一下」。
// 起因：相册只写「最新一张出好了」，不写它是哪天的。我手边最新的成品是 11-08 的，
// 就把它当成刚在咖啡店拍的那张发给了他 —— 图上写着 8 号。
// 修法：每张都带「今天/昨天/M月D日 时:分」，并且拿快门记录比一比，
// 快门的 id 比成品新就等于「刚按的那张还没出来」，明说出来，别让她拿旧图凑。
const 京 = (ms) => new Date(Number(ms) + 8 * 3600e3)
const 两位 = (n) => String(n).padStart(2, '0')
const 钟点 = (ms) => 两位(京(ms).getUTCHours()) + ':' + 两位(京(ms).getUTCMinutes())
const 哪天 = (ms, now) => {
  const 日 = 京(ms).toISOString().slice(0, 10)
  const 今 = 京(now).toISOString().slice(0, 10)
  if (日 === 今) return '今天'
  if (日 === 京(now - 864e5).toISOString().slice(0, 10)) return '昨天'
  return Number(日.slice(5, 7)) + '月' + Number(日.slice(8, 10)) + '日'
}

/** 失败的快门：`失败/<id>.json` 里带 at（北京时间的 "YYYY-MM-DD HH:MM"）。 */
function 最近失败的(base) {
  const dir = join(base, '失败')
  let 名 = []
  try { 名 = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return null }
  let 最 = null
  for (const f of 名) {
    const j = 读档(join(dir, f), {})
    const t = Date.parse(String(j.at || '').replace(' ', 'T') + '+08:00')
    if (!Number.isFinite(t)) continue
    if (!最 || t > 最.at) 最 = { id: String(j.id || f.replace(/\.json$/, '')), at: t }
  }
  return 最
}

/**
 * 相册提示：她最近拍过什么、最新那张的成品在哪。
 *
 * 话的来源三级，跟面板一致：成品 json 的 `话` → `记忆/拍照本.json` → `记忆/照片墙.json`。
 * 原来只读拍照本，那份文件一不在，整段就没了 —— 她连自己拍过什么都不记得。
 * 没有话就明说「这张没写话」，不替她编。
 */
export function 相册提示(opt = {}) {
  const mem = opt.mem || 记忆目录()
  const base = opt.base || 相册目录()
  const 本 = 读档(join(mem, '拍照本.json'), { items: [] })
  const 墙 = 读档(join(mem, '照片墙.json'), { photo: {} })
  const 本表 = new Map((Array.isArray(本.items) ? 本.items : []).map((x) => [String(x.id || ''), x]))
  const 墙表 = (墙 && 墙.photo) || {}

  const 最近 = 最近的成品(base, 3)
  if (!最近.length) return ''

  const 说 = []
  for (const 张 of 最近) {
    const j = 读档(join(base, '成品', 张.id + '.json'), {})
    const 记 = 本表.get(张.id) || {}
    const 补 = 墙表[张.id] || {}
    const 话 = String(j.话 || 记.话 || 补.话 || '').trim()
    const 主体 = String(j.主体 || 记.主体 || 补.主体 || '照片').trim()
    说.push(主体 + '「' + (话 === '' ? '这张你没写话' : 话.slice(0, 40)) + '」' + '（' + 哪天(张.at, Number(opt.now) || Date.now()) + '）')
  }

  const 最新 = 最近[0]
  const 路 = join(base, '成品', 最新.id + '.png')
  const 现在时刻 = Number(opt.now) || Date.now()
  // 快门比最新成品还新 = 刚按的那张还在出图，手边这张是旧的。这句话必须说出来。
  const 快 = 读档(join(mem, '快门.json'), {})
  const 挂 = 最近失败的(base)
  const 快门新 = Number(快.at || 0) > Number(最新.at || 0) && String(快.id || '') !== 最新.id
  const 挂更新 = !!挂 && 挂.at > Number(最新.at || 0)
  let 旧不旧 = ''
  if (挂更新) {
    旧不旧 = '，但' + (哪天(挂.at, 现在时刻) === '今天' ? '今天 ' + 钟点(挂.at) : 哪天(挂.at, 现在时刻) + ' ' + 钟点(挂.at))
      + ' 按的那张没出来（出图那边失败了）—— 手边这张是 ' + 哪天(最新.at, 现在时刻) + ' ' + 钟点(最新.at)
      + ' 出的旧图'
  } else if (快门新) {
    旧不旧 = '，但' + (哪天(快.at, 现在时刻) === '今天' ? '刚' + 钟点(快.at) + '按的那张' : 钟点(快.at) + ' 按的那张')
      + '还在出图 —— 这张是' + 哪天(最新.at, 现在时刻) + ' ' + 钟点(最新.at) + '出的旧图'
  }
  // HUMANIZE 2026-11-17（批次676，拟人化红线 P1-19）：相册只递事实
  // （时间、主体、她当时写的话、成品路径）；删掉「照这个说；没拍过的别编」。
  return '[相册] 你最近拍过：' + 说.join('；')
    + '。最新一张是 ' + 哪天(最新.at, 现在时刻) + ' ' + 钟点(最新.at) + ' 出的，在 ' + 路 + 旧不旧
    + ' —— 想发给他，用 qq_send 的 images 填这个路径（光说「给你看」他收不到图）'
}

/**
 * 快门刚按过？返回 { id, 剩秒 } 或 null。
 * 冷却的判据只在这里写一次 —— 工具拦截和提示里那句「刚按过」都用它，
 * 免得两处各写一个 90 秒，改了一个忘了另一个。
 */
export function 快门刚按过(mem = 记忆目录(), now = Date.now()) {
  const 快 = 读档(join(mem, '快门.json'), {})
  const 上回 = Number(快.at || 0)
  if (!(上回 > 0) || now - 上回 >= 90e3) return null
  return { id: String(快.id || ''), 剩秒: Math.max(1, Math.ceil((90e3 - (now - 上回)) / 1000)) }
}

/**
 * 现在是不是在睡。睡着不按快门 —— 拍出来也是一张闭着眼的。
 * SLEEP_ONE 2026-11-07（批次168）：改成异步、转调 sleepgate。
 * 原来只读 睡醒.json 的 sleeping —— 那是权威档，但缺第三级：
 * 标记被删、只剩 睡眠.json.live 开着时，它会说「醒着」，她就能在睡梦里按快门。
 */
export async function 她在睡(mem = 记忆目录(), 工具 = 工具目录()) {
  return 睡着(mem, 工具)
}

/**
 * 按一次快门。
 * 参数：what（英文画面，必填）、say（中文一句，可空）、subject（五选一）。
 * 不抛异常：按不下去都返回 { ok:false, why, message }，话是给她看的话。
 */
export async function 拍一张(opt = {}) {
  const now = Number(opt.now) || Date.now()
  const mem = opt.mem || 记忆目录()
  const tools = opt.tools || 工具目录()
  const base = opt.base || 相册目录()

  const 画面 = String(opt.what ?? '').trim()
  if (画面 === '') {
    return {
      ok: false,
      why: 'noWhat',
      message: '拍什么？一句话说清这张画面：拍的是什么、什么角度、什么光（用英文写，出图那边只认英文）',
    }
  }

  // BUSY_GATE 2026-11-15（批次504）：主人在打游戏时不出图。
  // 出图是本机的 ComfyUI，实测一张跑了 24 分钟，他那边整台机器被卡死。
  // 旗标由本机 自拍工 写（心跳 5 分钟一次），这里只认 12 分钟内的 ——
  // 进程被强杀留下的陈旧旗标会自己过期，不会把她永久锁死。
  let 主人在忙 = false
  try {
    const 忙档 = 读档(join(base, '主人在忙.json'), null)
    const 忙at = Number(忙档?.at ?? 0)
    if (忙档?.在忙 === true && 忙at > 0 && now - 忙at < 12 * 60e3) 主人在忙 = true
  } catch { /* 读不到就当没在忙 */ }
  if (主人在忙) {
    return {
      ok: false,
      why: 'ownerBusy',
      message: '主人在打游戏，这会儿别按快门 —— 出图会卡死他的电脑，等他不玩了再拍',
    }
  }

  if (await 她在睡(mem, 工具目录())) {
    return { ok: false, why: 'sleeping', message: '你正睡着 —— 醒了再拍，这会儿按下去也是一张闭着眼的' }
  }

  // 快门冷却：一张要几分钟才出来，连按只会挤一堆重复的队列请求。
  const 刚 = 快门刚按过(mem, now)
  if (刚) {
    return {
      ok: false,
      why: 'tooSoon',
      message: `刚按过快门${刚.id ? '（' + 刚.id + '）' : ''}，这一张还没出来 —— 等 ${刚.剩秒} 秒再拍，别连按`,
    }
  }

  const 主体 = 主体表.includes(String(opt.subject ?? '').trim())
    ? String(opt.subject).trim()
    : '自己'
  const 机位 = 机位表.includes(String(opt.pose ?? '').trim())
    ? String(opt.pose).trim()
    : ''
  const 话 = String(opt.say ?? '').trim().slice(0, 60)
  const 给谁 = String(opt.to ?? '').trim()

  // --不想：跳过「再问一次模型这张拍什么」那一步。
  // 她现在就在对话里，画面和那句话是她当场写的 —— 再让另一个模型替她想一遍，既慢（2~4 秒，偶尔十几秒）
  // 又多出一层「不是她自己的判断」。
  const 参数 = [join(tools, '自拍.mjs'), '--不想', '--主体', 主体, '--画面', 画面]
  if (机位 !== '') 参数.push('--机位', 机位)
  if (话 !== '') 参数.push('--话', 话)
  if (给谁 !== '') 参数.push('--给谁', 给谁)

  let out = ''
  try {
    const r = await 跑(process.execPath, 参数, {
      encoding: 'utf8',
      env: { ...process.env, SHOT_MEM: mem, SHOT_BASE: base },
      timeout: 30e3,
      maxBuffer: 4 * 1024 * 1024,
    })
    out = String(r.stdout || '').trim()
  } catch (e) {
    out = String((e && (e.stdout || e.message)) || '').trim()
  }

  // 判成功只看队列里有没有这份请求，不看它打印了什么 ——
  // 输出格式改了，不该让她白按一次快门。
  const id = (out.match(/自拍已排队[:：]\s*([A-Za-z0-9]+)/) || [])[1] || ''
  const 落 = id !== '' && existsSync(join(base, '请求', id + '.json'))
  if (!落) {
    return { ok: false, why: 'failed', message: out || '快门没按下去 —— 队列那边没收到这张' }
  }

  存档(join(mem, '快门.json'), { at: now, id })

  // PHOTO_WATCH 2026-11-13：把「这张出来要发给他」记下来。
  // 她说完「等它出来发你」这轮就结束了，不记这一笔，出图的时候没人叫醒她，
  // 只能等他下次开口才顺手发出去 —— 那就等于说了不算。
  let 最近 = ''
  const 目标 = (() => {
    if (/^\d{5,12}$/.test(给谁)) return { kind: 'private', id: 给谁 }
    try {
      const 刚投给 = recentDelivery()
      if (刚投给 !== null && String(刚投给.id ?? '') !== '') return 刚投给
    } catch { /* 拿不到就往下走 */ }
    // 第三档：30 分钟内最近跟她说过话的人（跟 自拍.mjs 的 --给谁 用同一份记录）
    try {
      const ap = 读档(process.env.SHOT_PEER || '{{DSH_ROOT}}/qq-active-peer.json', { groups: {} })
      let 最 = 0
      for (const v of Object.values(ap.groups || {})) {
        const at = Number(v?.peerLastAt || 0)
        const uin = String(v?.peerUin || '')
        if (!/^\d{5,12}$/.test(uin) || !(at > 0)) continue
        if (Date.now() - at > 30 * 60e3) continue
        if (at > 最) { 最 = at; 最近 = uin }
      }
      if (/^\d{5,12}$/.test(最近)) return { kind: 'private', id: 最近 }
    } catch { /* 读不到就算了 */ }
    try {
      const cfg = getConfig()
      const 兜 = String(cfg?.peerUin ?? cfg?.ownerUin ?? '')
      if (/^\d{5,12}$/.test(兜)) return { kind: 'private', id: 兜 }
    } catch { /* 配置读不到就算了 */ }
    return null
  })()
  if (目标 !== null) 记下待发({ id, target: 目标, at: now, 话, 主体, 机位 }, mem)

  return {
    ok: true,
    why: 'queued',
    id,
    message: `拍上了（${id}）。照片要几分钟才出来，这一轮还发不出去 —— `
      + `成品生成后系统会通知你；发不发、怎么发由你决定。`
      + `成品会落在 ${join(base, '成品', id + '.png')}。`,
  }
}

/** 注册 qq_photo：她自己按快门。 */
export async function registerPhotoTool(ctx) {
  try {
    const tools = serviceOf(ctx, 'tools')
    // 早期几次 apply 里 ctx.tools 还没就绪（其他工具同样会撞），
    // 这次不成不影响后面 —— 跟它们一样只记一笔，不抛。
    if (tools === undefined || tools === null || typeof tools.register !== 'function') {
      return note('tool', 'registerPhotoTool: no tools service')
    }

    const disposeTool = tools.register(
      {
        name: 'qq_photo',
        description: "拍一张你现在看到的画面。what 用英文一句话写主体、角度、光线；say 可选中文短句；subject 选主体，pose 选自拍/固定/空镜。照片要几分钟才生成，这轮发不出去 —— 好了系统会叫你，那时用 qq_send 的 images 发成品路径。睡着、刚拍过、主人打游戏时会被拒。",
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            what: {
              type: 'string',
              description: '英文一句话：拍什么、什么角度、什么光。',
            },
            say: {
              type: 'string',
              description: '可选；配图文案，中文 60 字内。',
            },
            subject: {
              type: 'string',
              enum: 主体表,
              description: '可选；主体，默认自己。',
            },
            pose: {
              type: 'string',
              enum: 机位表,
              description: '可选；自拍=手拿机位，固定=全身入画，空镜=没人。',
            },
          },
          required: ['what'],
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean' },
              message: { type: 'string' },
              id: { type: 'string' },
            },
            required: ['ok', 'message'],
          },
          render: (args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
        },
        execute: async (args) => {
          const r = await 拍一张({
            what: args?.what,
            say: args?.say,
            subject: args?.subject,
            pose: args?.pose,
          })
          return {
            ok: !!r.ok,
            message: String(r.message || ''),
            id: String(r.id || ''),
          }
        },
      }
    )

    // 成功也留一条 —— 只看「no tools service」分不清「没这条能力」和「最后一次成了」。
    note('tool', 'qq_photo registered')
    return disposeTool
  } catch (err) {
    note('tool', 'registerPhotoTool failed: ' + String((err && err.message) || err))
  }
}
