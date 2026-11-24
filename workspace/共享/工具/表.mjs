// 表.mjs —— 物品的唯一边界（2026-11-07，批次156）
//
// 主人：「根据我搞的总表的思路 优化其他系统 使其对接更容易 加减更容易」
//
// 为什么要有文件：加一样东西原来要写三处（物品总表 / 商店-生活 / 口粮表），
// 已经分叉出 5 处价不一致（水手服、白裙子、小皮鞋、蓝色发带在旧穿衣表里是 0）。
// 以后只在一处加一行 —— 价格、售卖点、吃法、效果都在同一条里。
//
// 落盘分两张（语义不同，分开更好读）：
//   记忆/物品总表.json   吃喝 / 用 / 服务（分组.吃喝、用、服务）
//   记忆/衣物表.json     穿 / 饰（分类细，带标签、覆盖）
// 合并口径只从这里出，别的脚本不许再自己拼。
//
// 用法（命令行）：
//   node 表.mjs                 # 一行汇总
//   node 表.mjs --查 泡面        # 单条明细
//   node 表.mjs --店 超市        # 这地方卖什么
//   node 表.mjs --服务 澡堂      # 这地方能干什么
//   node 表.mjs --缺            # 加东西时漏了什么
//   node 表.mjs --撞            # 同名不同价
//   node 表.mjs --孤儿          # 商店表里有、总表没有
//   node 表.mjs --标签 短袖
import fs from 'node:fs'
import path from 'node:path'

const MEM = process.env.ITEM_MEM || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const TOOLS = process.env.QQ_TOOLS || '{{BOT_ROOT}}/共享/工具'

const P总 = path.join(MEM, '物品总表.json')
const P衣 = path.join(MEM, '衣物表.json')
const P店 = path.join(TOOLS, '商店-生活.json')

const _mt = (p) => { try { return fs.statSync(p).mtimeMs } catch { return 0 } }
const _读 = (p, d = {}) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }

// 分组是嵌套的：吃喝.正餐.{名:条目}。认条目的判据是「有类别」，别的一律往下走。
function _平(o, 出) {
  for (const [k, v] of Object.entries(o || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    if (v.类别) 出[k] = v
    else _平(v, 出)
  }
  return 出
}

let _缓 = null
// 按 mtime 判断要不要重读：同一个进程里改了表也能立刻看到（踩过「改了表脚本还读旧值」）
export function 所有() {
  // CACHE_SIG 2026-11-24：签名原来只有 总表:衣物表 的 mtime，
  // 而 撞价() / 孤儿() 读的是 商店-生活.json —— 只改商店表时缓存不会失效，
  // 自检结果就会对不上实际。补上第三个 mtime。
  const sig = `${_mt(P总)}:${_mt(P衣)}:${_mt(P店)}`
  if (_缓 && _缓.sig === sig) return _缓.表
  const 平 = _平(_读(P总).分组, {})
  for (const [k, v] of Object.entries(_读(P衣).件 || {})) {
    if (v && typeof v === 'object') 平[k] = v
  }
  _缓 = { sig, 表: 平 }
  return 平
}

export const 查 = (名) => 所有()[名] || null

export function 价(名) {
  const v = 查(名)
  if (!v) return 0
  const p = v.价 ?? v.穿?.价 ?? 0
  return Number(p) || 0
}

const 是服务 = (v) => String(v?.类别) === '服务'

// 某地能买到什么（服务不算「买」）
export function 店(地点) {
  const 出 = []
  for (const [名, v] of Object.entries(所有())) {
    if (是服务(v)) continue
    if (!Array.isArray(v.售卖点) || !v.售卖点.includes(地点)) continue
    出.push({
      名, 价: 价(名), 类别: v.类别,
      饱腹: v.饱腹 ?? null,
      吃法: v.吃法 || null,
      分钟: Number(v.分钟) || null,
    })
  }
  return 出
}

// 某地能做什么（泡澡、电影、抓娃娃…）
export function 服务(地点) {
  return Object.entries(所有())
    .filter(([, v]) => 是服务(v) && (v.售卖点 || []).includes(地点))
    .map(([名, v]) => ({ 名, 价: 价(名), 效果: v.效果 || {}, 分钟: Number(v.分钟) || null }))
}

export function 按标签(签) {
  return Object.entries(所有())
    .filter(([, v]) => (v.标签 || []).includes(签) || (v.饰品 || '') === 签)
    .map(([名]) => 名)
}

// 一件东西算不算写全了：加新条目时看这个，不用猜
export function 缺项() {
  const 出 = []
  for (const [名, v] of Object.entries(所有())) {
    const 问题 = []
    if (!v.类别) 问题.push('没写类别')
    if (是服务(v)) {
      if (!Number(v.价)) 问题.push('服务没写价')
      if (!(v.售卖点 || []).length) 问题.push('服务没写售卖点')
      if (问题.length) 出.push({ 名, 问题 })
      continue
    }
    if (!Number.isFinite(Number(v.占格)) || Number(v.占格) < 0) 问题.push('没写占几格')
    if (['吃', '喝', '零食'].includes(v.类别)) {
      const 有吃数 = v.吃 && (Number(v.吃.kcal) || Number(v.吃.补水))
      if (!有吃数 && !Number(v.饱腹)) 问题.push('热量、水、饱腹都没写')
    }
    if (v.类别 === '穿') {
      if (!v.穿) 问题.push('没有穿的数')
      else if (!v.穿.部位 || !Number.isFinite(Number(v.穿.保暖))) 问题.push('没写部位或保暖')
      if (!(v.标签 || []).length) 问题.push('没有标签')
    }
    if (v.类别 === '饰' && !v.饰品) 问题.push('没写戴在哪')
    if (问题.length) 出.push({ 名, 问题 })
  }
  return 出
}

// 同名不同价：总表 / 衣物表 / 商店表 三处比对
export function 撞价() {
  const 源 = {}
  const 记 = (名, p, from) => { (源[名] = 源[名] || []).push({ 价: p, from }) }
  for (const [名, v] of Object.entries(所有())) 记(名, v.价 ?? v.穿?.价 ?? null, '总表')
  for (const [名, v] of Object.entries(_读(P店).商品 || {})) 记(名, v.价 ?? null, '商店-生活')
  const 出 = []
  for (const [名, 处] of Object.entries(源)) {
    const 集 = [...new Set(处.map((x) => x.价))]
    if (集.length > 1) 出.push({ 名, 各处: 处 })
  }
  return 出
}

// 商店表里有、总表查不到的（买了之后算不出饱腹/保暖）
export function 孤儿() {
  const 表 = 所有()
  return Object.keys(_读(P店).商品 || {}).filter((名) => !表[名])
}

export function 汇总() {
  const 表 = 所有()
  const 类 = {}
  for (const v of Object.values(表)) 类[v.类别] = (类[v.类别] || 0) + 1
  const 分 = Object.entries(类).map(([k, n]) => `${k}${n}`).join(' ')
  return `${Object.keys(表).length} 样（${分}）｜缺项 ${缺项().length}｜撞价 ${撞价().length}｜孤儿 ${孤儿().length}`
}

// ---------- 命令行 ----------
// 批次578：endsWith('表.mjs') 会把 物品总表.mjs 也当成入口，import 时误跑 CLI。
const 是主 = process.argv[1] && path.basename(process.argv[1]) === '表.mjs'
if (是主) {
  const a = process.argv.slice(2)
  const 取 = (k) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : null }
  if (a.includes('--查')) {
    const n = 取('查')
    const v = 查(n)
    console.log(v ? `${n}｜${JSON.stringify(v, null, 1)}` : `表里没有「${n}」`)
  } else if (a.includes('--店')) {
    const 地 = 取('店')
    const 列 = 店(地)
    console.log(`${地}：能买 ${列.length} 样　能玩 ${服务(地).length} 项`)
    for (const x of 列.sort((p, q) => p.价 - q.价)) {
      console.log(`  ${x.名}  ${x.价} 元${x.饱腹 != null ? '  饱腹' + x.饱腹 : ''}${x.吃法 ? '  ' + x.吃法 : ''}`)
    }
    for (const x of 服务(地)) console.log(`  [玩] ${x.名}  ${x.价} 元`)
  } else if (a.includes('--服务')) {
    const 地 = 取('服务')
    console.log(`${地}：`, 服务(地))
  } else if (a.includes('--标签')) {
    console.log(按标签(取('标签')).join('、'))
  } else if (a.includes('--撞')) {
    const 列 = 撞价()
    console.log(`同名不同价 ${列.length} 处`)
    for (const x of 列) console.log(`  ${x.名}  ${x.各处.map((y) => `${y.from}:${y.价}`).join(' ≠ ')}`)
  } else if (a.includes('--孤儿')) {
    const 列 = 孤儿()
    console.log(`商店有、总表没有 ${列.length} 个`)
    for (const n of 列) console.log('  ' + n)
  } else if (a.includes('--缺')) {
    const 列 = 缺项()
    console.log(`没写全 ${列.length} 样`)
    for (const x of 列) console.log(`  ${x.名}：${x.问题.join('、')}`)
  } else {
    console.log(汇总())
  }
}
