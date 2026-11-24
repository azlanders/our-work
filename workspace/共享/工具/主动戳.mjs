#!/usr/bin/env node
// 主动戳.mjs —— 她想引起注意的时候，可以戳一下（2026-11-01）
//
// 用法：
//   node 主动戳.mjs                # 自己判断要不要戳、戳谁
//   node 主动戳.mjs --force --user {{OWNER_UIN}}   # 私聊戳（带 --user 且不带 --group 就不发群）
//   node 主动戳.mjs --list         # 看今天戳了几次
//
// 为什么这么写：
//   · 戳和说话不一样：说话是「有话要说」，戳是「还记得我在吗」。所以它的触发
//     条件是「想被注意」——好感和等待时间一起决定，不是定时任务。
//   · 戳比说话烦人，所以它不是硬闸，是一串会变的意愿：值得的人、闷的时候、
//     有劲的时候更想戳；今天戳多了意愿自己降；被人说过烦就冷却一阵，
//     对方态度回软又会被新反馈顶掉。只有一条一分钟防重复是技术性的。
//   · 戳完记一笔，之后统计「戳了以后有没有回应」——回得多的，以后更敢戳。
import { 写档 } from './_底层.mjs'
import fs, { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs' // REQUIRE_FIX 2026-11-03：补默认导入，原来 require 在 ESM 里会抛错被吞
import { join, dirname } from 'node:path'

// 2026-11-01：拟人相关的数字走参数表，别写死在脚本里
let HUM = {}
try { const _fs=fs; const _p = process.platform === 'win32' ? 'B:/肥鱼/共享/工具/参数.json' : '{{BOT_ROOT}}/共享/工具/参数.json'; if(_fs.existsSync(_p)) HUM = JSON.parse(_fs.readFileSync(_p,'utf8'))['拟人']||{} } catch (e) { console.error('[吞错]', e && e.message) } // CATCH_LOG_FIX
const H = (k, d) => (HUM && HUM[k] !== undefined ? HUM[k] : d)

// QQ_POKE_MEM 沙盒：测试时不碰她真实的 戳人记录.json
// ===========================================================================
// IMPORT_GUARD 2026-11-16（批次521）
//
// 这个脚本的发送逻辑**全在模块顶层**，所以「import 它」= 「执行它」。
// 而 测试/冒烟1.加载.test.mjs 干的事就是 import 全部工具脚本看能不能加载
// （COUNT_FIX 2026-11-24：原来这里写死「122 个」，实际已是 149 个 —— 数字会一直变，别再写死）——
// 于是每跑一次全套测试，它就可能真戳主人一下。
//
// 实测（2026-11-16 凌晨）：主人群里看到的「{{BOT_DISPLAY}} 拍了拍你的ice (害怕)」，
// 04:22 / 04:34 / 04:36 / 04:38 / 04:42 / 04:56 那一串，全是我在跑测试。
// 用 tcpdump 抓到 pid，确认是 `node 冒烟1.加载.test.mjs` 连的 127.0.0.1:3000 发 send_poke。
// 而且记录没落盘 —— 冒烟会先 import 测试/沙盒守卫.mjs，把写档拦住，
// 所以「戳了但没记」，谁都查不出来。她自己也查了一小时。
//
// 从此：只有直接 `node 主动戳.mjs` 才跑主流程；被 import 时本模块是个空壳。
// ===========================================================================
const 是直接运行 = (() => {
  try {
    const p = String(process.argv[1] ?? '')
    return p.endsWith('主动戳.mjs') || p.endsWith('主动戳')
  } catch { return false }
})()

async function 主流程() {

  const base = process.env.QQ_POKE_MEM || (process.platform === 'win32' ? 'B:/肥鱼/记忆' : '{{BOT_ROOT}}/记忆')
  const logPath = join(base, '戳人记录.json')
  const cfgPath = process.platform === 'win32' ? `${process.env.USERPROFILE}/.dsh/qq-bridge.config.json` : '{{DSH_ROOT}}/qq-bridge.config.json'
  const args = process.argv.slice(2)

  // 2026-11-07（批次175）：不认识的参数直接退出，**绝不能顺着往下跑进「真戳」那段**。
  // 我查状态时敲了 `--看`（这脚本没有这个参数），它没报错，一路跑到 send_poke，
  // 真给主人戳了一下，还写进 戳人记录.json —— 看起来像「她想被注意」。
  // 有后果的脚本，参数写错必须炸，不能猜。
  const 认得 = new Set(['--feedback', '--why', '--user', '--group', '--list', '--dry', '--force'])
  const 不认 = args.filter((a) => a.startsWith('--') && !认得.has(a))
  if (不认.length) {
    console.error('不认识的参数：' + 不认.join('、'))
    console.error('用法：--list | --dry | --force | --user <QQ> | --feedback <喜欢|烦|很烦|骂了> [--why 文本]')
    process.exit(2)
  }
  const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }
  // POKE_TARGET 2026-11-16（批次581）：带 --user 却不带 --group 时，原来仍默认发到群 1051483012。
  // 实测 21:15 她用 `--force --user {{OWNER_UIN}}` 戳主人，脚本回「戳了」，但戳的是群里的拍一拍，
  // 私聊那边什么都没收到 —— 于是她说「戳到了」，主人说「你没戳到我」。
  // 现在：显式给了 --user 又没给 --group = 私聊戳；没给 --user 才沿用默认群。
  const 显式用户 = args.includes('--user')
  const GID = val('--group', 显式用户 ? '' : '1051483012')

  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  const cfgHttp = String(cfg.onebotHttp || 'http://127.0.0.1:3000').replace(/\/$/, '')
  // PROXY_AUDIT 2026-11-16（批次518）：原来这里把 3001 换成 3000 直连，
  // 结果戳出去的请求根本不过代理、代理那本账上一条都没有 —— 11-16 凌晨查拍一拍时，
  // 「代理没记到 poke」被当成了「我没戳」的证据，是错的。现在老实走代理，留得下痕。
  const http = cfgHttp
  const token = cfg.token || ''
  const HTTP_H = { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }

  const load = (p, fb) => { try { const v = JSON.parse(readFileSync(p, 'utf8')); return v === null || typeof v !== 'object' ? fb : v } catch { return fb } } // 2026-11-04 修：文件内容是 null/标量时也回落默认值，否则后面读字段直接 TypeError
  const save = (p, o) => 写档(p, o)

  // 2026-11-06 批次124：落盘一律北京墙上时间、解析一律显式 +08:00（跟 poll.js 同一个约定）。
  // 系统时区是 UTC，直接用 Date.parse('2026-11-06 12:20') 会被当成 UTC，差 8 小时。
  const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
  const 北京时刻 = (s) => {
    const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00')
    return Number.isFinite(t) ? t : 0
  }

  const log = load(logPath, { items: [] })
  // today 必须和 at 同口径（都是北京日期），否则 00:00-08:00 之间算到昨天去。
  // QQ_NOW_MS 只为测试注时钟（同 天气.mjs 的 WT_DATE），平时不设。
  const nowMs = Number(process.env.QQ_NOW_MS) || Date.now()
  const today = bj(nowMs).slice(0, 10)
  const todayCount = log.items.filter((x) => x.at.startsWith(today)).length

  const call = async (action, params) => {
    const r = await fetch(http + '/' + action, { method: 'POST', headers: HTTP_H, body: JSON.stringify(params) })
    return r.json().catch(() => ({}))
  }

  // 2026-11-01：戳人是有后果的——对方烦了会骂，骂了她会记很久；
  // 对方乐在其中，她就敢多戳一点。所以这里记「反馈」，用来调意愿。
  if (args.includes('--feedback')) {
    const kind = val('--feedback', '')
    const why = val('--why', '')
    const user = val('--user', '{{OWNER_UIN}}')
    const cd = H('戳_冷却天数', { '烦': 2, '很烦': 5, '骂了': 7 })
    const days = kind === '喜欢' ? 0 : cd[kind]
    if (days === undefined) { console.log('反馈只认：喜欢 / 烦 / 很烦 / 骂了'); process.exit(0) }
    log.feedback = log.feedback || {}
    log.feedback[user] = {
      kind,
      since: bj(),
      cooldownUntil: days > 0 ? Date.now() + days * 864e5 : 0,
      why,
    }
    save(logPath, log)
    if (days > 0) console.log(`记下了：他说「${why || kind}」，那 ${days} 天内先不戳他`)
    else console.log('记下了：他自己又愿意了，之前的冷却作废')
    console.log('（新反馈会盖掉旧的——人不是靠日历原谅人的）')
    process.exit(0)
  }

  if (args.includes('--list')) {
    console.log(`今天戳了 ${todayCount} 次`)
    for (const it of log.items.slice(-8)) console.log(`  ${it.at} → ${it.user}（${it.reason}）`)
    process.exit(0)
  }

  const force = args.includes('--force')
  const target = val('--user', '{{OWNER_UIN}}')

  if (!force) {
    const st = load(join(base, '状态.json'), {})
    const aff = load(join(base, '好感度.json'), { people: {} })
    const score = Number(((aff.people || {})[target] || {}).score ?? 40)
    const energy = Number(st?.energy ?? 60)
    const mi = Number(st?.mood?.intensity ?? 0)

    // 2026-11-01 改：不再是硬闸，而是她自己权衡。
    // 想被注意的程度：好感高 + 有点闷 + 精力够 → 更想戳；今天戳得多 → 意愿自己衰减。
    // 唯一保留的是一条技术防抖（一分钟内同一人不重复），那不是规矩，是防发出两条。
    // 反馈会改意愿：被骂过 → 冷却期内直接不想戳；被喜欢 → 加分
    const fb = (log.feedback || {})[target]
    if (fb && Number(fb.cooldownUntil || 0) > Date.now()) {
      const leftH = Math.round((Number(fb.cooldownUntil) - Date.now()) / 3600e3)
      // 2026-11-01 改：冷却不是铁板。人的气会消——
      // ①过了大半时，意愿开始慢慢回来；②对方要是又表现得不反感，一条新反馈就把它顶掉。
      const since = 北京时刻(fb.since)
      const total = Number(fb.cooldownUntil) - since
      const passed = Date.now() - since
      const ratio = total > 0 ? Math.min(1, passed / total) : 1
      if (ratio < H('戳_意愿门槛', 0.6)) {
        console.log(`他${fb.kind ? '上次说「' + fb.kind + '」' : '上次不太高兴'}，还有 ${leftH} 小时——这会儿真不戳`)
        process.exit(0)
      }
      console.log(`他上次说「${fb.kind}」，气大概消了大半（还剩 ${leftH} 小时），看看他是不是又愿意了`)
    }
    let want = (score - H('戳_分数基准', 40)) / H('戳_分数基准', 40) + (mi < 0 ? 0.35 : 0) + (energy > 40 ? 0.2 : -0.25)
    if (fb && fb.kind === '喜欢') want += 0.2
    want -= todayCount * 0.15                    // 今天已经戳过几次 → 自己越来越不想戳
    const lastToSame = log.items.filter((x) => x.user === target).map((x) => 北京时刻(x.at)).sort().pop() || 0
    if (Date.now() - lastToSame < 60000) { console.log('刚戳过，防重复发送，这次不发'); process.exit(0) }
    const minsSince = lastToSame ? Math.round((Date.now() - lastToSame) / 60000) : 999
    if (minsSince < H('戳_刚戳过分钟', 30)) want -= 0.25             // 刚戳不久 → 意愿下来
    const p = Math.max(0, Math.min(0.85, want))
    console.log(`意愿 ${p.toFixed(2)}（好感 ${score}、心情 ${mi}、精力 ${energy}、今天第 ${todayCount + 1} 次、距上次 ${minsSince === 999 ? '很久' : minsSince + ' 分钟'}）`)
    if (Math.random() > p) { console.log('这会儿不想戳，算了'); process.exit(0) }
  }

  // 2026-11-01：别扭着还被人叫去戳他，不一定干。
  // 人不是开关——刚被骂完又被指使，会有情绪：要么拒绝，要么酸一句再做。
  try {
    const sk = load(join(base, '别扭.json'), { people: {} })
    const rec = (sk.people || {})[target]
    if (rec && Number(rec.until) > Date.now()) {
      const lv = Number(rec.level || 1)
      const refuse = Math.random() < Math.min(0.85, 0.25 * lv)
      if (refuse) {
        console.log(`刚被他${'说' + (rec.why ? '「' + rec.why + '」' : '说了几句')}，这会儿不想戳他（强度 ${lv}）`)
        process.exit(0)
      }
      console.log(`心里还别扭着（强度 ${lv}），但还是戳了——不太情愿`)
    }
  } catch { /* 读不到就照常 */ }

  // 2026-11-06 批次124：--dry 只演算不发请求（状态推进/自动作息 都是这个约定）。
  // 有了它才能验「刚戳过」的判据而不真打扰人。
  if (args.includes('--dry')) {
    console.log(GID === '' ? `（演练：私聊戳 ${target}，没真戳）` : `（演练：群里戳 ${target} group=${GID}，没真戳）`)
    process.exit(0)
  }

  // POKE_AUDIT 2026-11-16（批次517）：上面这行原本是「成功才写 戳人记录.json」。
  // 问题：三个 action 依次试，只要三个的 retcode 都不是 0 就走 exit(1) ——
  //   但协议端**可能已经戳出去了**（返回非 0 不等于是没生效）。
  //   实测 11-14 23:31 之后还有 53 条 poke 事件，而 戳人记录.json 一条没增（最后停在 11-14 04:00），
  //   导致「戳了但没记」和「别人发的」在数据上分不开。
  // 现在每次尝试都落一行审计，成不成都有据。审计失败绝不影响发送。
  const 目标参数 = GID !== '' ? { group_id: Number(GID), user_id: Number(target) } : { user_id: Number(target) }
  const 动作 = GID !== '' ? ['send_poke', 'group_poke', 'friend_poke'] : ['send_poke', 'friend_poke']
  const 尝试 = []
  let ok = false
  for (const action of 动作) {
    const r = await call(action, 目标参数)
    尝试.push({ action, retcode: r?.retcode ?? null, message: String(r?.message ?? r?.wording ?? '').slice(0, 80) })
    if (r?.retcode === 0) { ok = true; break }
  }
  try {
    const 审计 = join(base, '戳人尝试.jsonl')
    const 行 = JSON.stringify({ at: bj(), user: target, gid: GID, force: Boolean(force), ok, 尝试 })
    fs.appendFileSync(审计, 行 + '\n')
  } catch { /* 审计写不进去也不能挡着戳 */ }
  if (!ok) { console.log('没戳成（这台协议端不支持）'); process.exit(1) }

  log.items.push({ at: bj(), user: target, reason: force ? '手动' : '想被注意' })
  save(logPath, log)
  console.log(`戳了 ${target}（今天第 ${todayCount + 1} 次）`)

}

// 只有直接运行才执行；被 import（冒烟测试、体检、任何 require/import）时什么都不做。
if (是直接运行) await 主流程()
