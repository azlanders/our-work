import { 原子写 } from './_底层.mjs'
// 自拍.mjs —— 她想拍一张时调这个：读她「现在在哪、在干嘛、刚买了什么」，写一条请求
// 用法: node 自拍.mjs [--场景 公园] [--动作 散步] [--心情 还行] [--给谁 QQ号]
import { 睡着 } from './睡态.mjs'
import { 区域温度 } from './体温.mjs' // REGION_TEMP 2026-11-08（批次249）：照片按她所在区域的温度记，不是窗外那个
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

// ENTRY_GUARD 2026-11-14（批次459）：被 import 时不要跑主流程。
// 冒烟测试「逐个 import」会把每个 .mjs 当 CLI 真跑一遍（457 实测一次写 16 个真档），
// 而这些脚本顶层就是整条流程。只有 `node <本文件>` 才执行下面的主流程；被 import 时是空模块。
// 用 __path/__fileURLToPath 这两个别名，避免和各文件已有的 path/join 撞名。
import __path from 'node:path'
import { fileURLToPath as __fileURLToPath } from 'node:url'
const 是入口 = (() => {
  try { return !!process.argv[1] && __path.resolve(process.argv[1]) === __fileURLToPath(import.meta.url) } catch { return false }
})()

if (是入口) {
// SHOT_MEM / SHOT_BASE 给测试指沙盒：不然测一次就往她真自拍队列里塞一张假请求。
const MEM = process.env.SHOT_MEM || "{{BOT_ROOT}}/记忆"
// TOOLS 用来找同目录的 拍照想法.mjs —— 用脚本自身位置算，不写死绝对路径
const TOOLS = path.dirname(fileURLToPath(import.meta.url))
const BASE = process.env.SHOT_BASE || "{{BOT_ROOT}}/共享/自拍"
const read = (f) => { try { return JSON.parse(fs.readFileSync(path.join(MEM, f), "utf8")) } catch { return {} } }
const get = (k) => { const i = process.argv.indexOf("--" + k); return i >= 0 ? (process.argv[i + 1] ?? "") : "" }

// REDO_SOURCE 2026-11-06（批次113）：面板照片墙上点「重拍这张」。
//
// 这件事得先说清楚是什么：不是「现在再拍一张」，是「把那一张重画一遍」。
// 所以场景/动作/心情/话必须沿用原图 —— 她在便利店拍的那张，人此刻在家，
// 用现在的现场重画就会变成客厅，等于把要修的那张又画错了。
//
// 原料三层：成品 sidecar（批次113 起存了完整 req，能一字不差重放）
//         → 拍照本（她按下快门时自己写的话）
//         → 照片墙.json（人补的）。
// 只有三层都没有完整 req 的老照片，才用此刻的衣服和天色去补 —— 会换衣服换天色，
// 是没办法的办法，这种情况面板那边会照实说。
const 重跑ID = String(get("重跑") || "").trim().replace(/[^\w-]/g, "")
const 重跑源 = (() => {
  if (!重跑ID) return null
  const 读J = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")) } catch { return null } }
  const side = 读J(path.join(BASE, "成品", 重跑ID + ".json")) || {}
  const 本 = 读J(path.join(MEM, "拍照本.json")) || {}
  const 墙 = 读J(path.join(MEM, "照片墙.json")) || {}
  const 墙条 = (墙.photo && 墙.photo[重跑ID]) || {}
  const 本记 = (() => {
    const items = Array.isArray(本.items) ? 本.items : []
    for (let i = items.length - 1; i >= 0; i -= 1) if (items[i] && items[i].id === 重跑ID) return items[i]
    return {}
  })()
  const 完整 = side.req && side.req.场景 ? side.req : null
  return {
    id: 重跑ID,
    完整,
    原次数: Number((side.重跑 && side.重跑.次数) || 0),
    场景: String(side.场景 || 墙条.场景 || 本记.场景 || ""),
    动作: String(side.动作 || 墙条.动作 || 本记.动作 || ""),
    心情: String(side.心情 || 墙条.心情 || ""),
    主体: String(墙条.主体 || 本记.主体 || ""),
    话: String(本记.话 || 墙条.话 || ""),
    构图: String(本记.构图 || ""),
    画面: String(本记.画面 || ""),
    // 老照片的 sidecar 存的是中文（照片墙就这么显示的），本机认的是 key。
    // 不映射的话「俯拍」传到本机对不上白名单，机位就变成重新随机 —— 前后两张没法比。
    机位: String(side.机位 || ""),
    角度: ({
      平视: "eye", 俯拍: "high", 仰拍: "low", 贴脸: "close",
      eye: "eye", high: "high", low: "low", close: "close",
    })[String(side.角度 || 墙条.角度 || "").trim()] || "",
  }
})()

// SLEEP_GUARD 2026-11-05：睡着不拍照——自测时用 --试拍照 绕过自主行动的睡眠门，
// 结果排了一张「睡觉中的自拍」。真正的门应该设在入口这层。
// REDO_AWAKE 2026-11-06（批次113）：重拍是主人在面板上点的，不看她在不在睡。
if (睡着(MEM) && !process.argv.includes("--硬拍") && !重跑ID) {
  console.log("她在睡，不拍")
  process.exit(0)
}
const asset = read("资产.json")
const auto = read("自主.json")
const st = read("状态.json")
const bj = new Date(Date.now() + 8 * 3600e3)
// 最近买过什么：只看今天最后一条「买了 X（N 块）」
let 最近买 = ""
try {
  const 今天 = bj.toISOString().slice(0, 10)
  for (const r of (asset.记录 || []).slice().reverse()) {
    const t = String(r.at || ""), w = String(r.what || "")
    if (!t.startsWith(今天)) continue
    const m = w.match(/买了\s*([^（(]+)/)
    if (m) { 最近买 = m[1].trim(); break }
  }
} catch { /* 买过什么查不到就算了 */ }

// REL_SHOOT 2026-11-05：这张是拍给谁看的。
// 原来自拍只跟自己状态有关，不知道看的人是谁——对谁都一个样，等于没有「为谁打扮」这回事。
// 给了 --给谁 就查一下对那个人的好感：亲近的凑近点、生分的端着点。
// 只往请求里多加字段，不改任何已有字段——本机渲染认这些字段就用，不认也不碍事。
// REL_SHOOT_AUTO 2026-11-05：只等 --给谁 传参是不够的。
// 实测：她自主拍照时 自主行动.mjs 调的是 `自拍.mjs`，一个参数都不带，
// 于是 给谁/亲近度/镜头 永远是空的——这条联动等于没接。
// 现在没传就看 active-peer：30 分钟内最近一个跟她说过话的人。
// 有人就是「拍给他看」，没人就是自己拍着玩（不加这些字段）。
const PEER_FILE = process.env.SHOT_PEER || "{{DSH_ROOT}}/qq-active-peer.json"
function 刚在跟她说话的人() {
  try {
    const ap = JSON.parse(fs.readFileSync(PEER_FILE, "utf8"))
    let best = null
    for (const v of Object.values(ap.groups || {})) {
      const at = Number(v?.peerLastAt || 0)
      const uin = String(v?.peerUin || "")
      if (uin === "" || !Number.isFinite(at) || at <= 0) continue
      if (Date.now() - at > 30 * 60e3) continue
      if (best === null || at > best.at) best = { at, uin }
    }
    return best === null ? "" : best.uin
  } catch { return "" }
}

const 关系镜头 = (() => {
  const u = String(get("给谁") || 刚在跟她说话的人()).trim()
  if (u === "") return {}
  try {
    const fav = JSON.parse(fs.readFileSync(path.join(MEM, "好感度.json"), "utf8"))
    const score = Number((fav.people || {})[u]?.score)
    if (!Number.isFinite(score)) return { 给谁: u }
    return {
      给谁: u,
      亲近度: Math.round(score),
      镜头: score >= 70 ? "近一点，像凑过去给他看" : score >= 45 ? "正常距离" : "远一点，有点端着",
    }
  } catch { return { 给谁: u } }
})()

// PICK_SUBJECT 2026-11-05（批次77）：这张拍什么、写句什么，由她自己定。
// 原来不管什么时候拍，请求里都只有「场景/动作/心情」——渲染端只能画她自己，
// 七张照片全是大头照。现在先问她一句，允许她拍街、拍台阶、拍别人的背影。
// 调不通就用兜底：还是拍自己、话留空，不能因为「想不出来」就不拍了。
const 想法 = (() => {
  if (process.argv.includes("--不想") || 重跑ID) return null
  try {
    const r = spawnSync(process.execPath, [path.join(TOOLS, "拍照想法.mjs")], {
      encoding: "utf8",
      timeout: 60e3,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    })
    const last = String(r.stdout || "").trim().split("\n").filter(Boolean).pop()
    const j = JSON.parse(last)
    return j && j.来自 === "模型" ? j : null
  } catch { return null }
})()

// PLACE_ON_ROAD 2026-11-06（批次111）：资产.位置 是「上一个待过的地方」，真相在 资产.在途。
// 她走在半路按快门时，场景会被写成出发点 —— 刚从便利店出来，照片就标成「便利店」，
// 本机照出发点渲染，人在马路上，照片在店里。在途且还没到，场景一律写「路上」。
// 顺带定一条：在途的地点不属于任何一家店，室内=false 由下面的天气块按这个判断。
const 在途 = !重跑ID && asset.在途 && asset.在途.to && Number(asset.在途.arriveAt) - Date.now() > 0
  ? asset.在途
  : null

// INDOOR_FIELD 2026-11-06（批次111b）：室内原来藏在「天气」那个 try 块里。
// 天气.json 缺一次、或者没到取的时段，整块 return {} —— 室内 这个字段就跟着消失，
// 本机按「室外」渲染，便利店被写成露天，人在店里也是站在街上。
// 现在它独立成字段，只认 地图.json 的 地点.室内；在途一律 false（路上没有屋檐）。
// HOME_ROOM 2026-11-06（批次140）：在家的时候，场景要按「她在哪个区域」走。
//
// 原来 场景 只取 资产.位置 —— 洗澡时那是「家」，本机再把它映射成客厅，
// 于是她在浴室拍出来是客厅（mw4n6vddf7hj，动作=洗澡、场景=家，
// 而她写的画面明明是 "a small tiled bathroom filled with steam"）。
// 自主.区域 是 家区域.mjs 一直在写的（浴室/床/沙发/厨房/阳台/书桌/电脑桌），从来没人读。
const 区域房间 = { 床: '主卧', 沙发: '客厅', 厨房: '厨房', 餐厅: '餐厅', 浴室: '浴室', 阳台: '阳台', 书桌: '次卧', 电脑桌: '次卧' } // HOME_DINING 批次211
const 家里房间 = (() => {
  if (在途) return ''
  if (String(asset.位置 || '家') !== '家') return ''
  return 区域房间[String(auto.区域 || '')] || ''
})()

const 室内 = (() => {
  if (在途) return false
  // 家里的哪个房间都是室内 —— 别让「浴室」去 地图.json 里查不到就当室外
  if (家里房间) return true
  const 名 = (重跑源 && 重跑源.场景) || get("场景") || asset.位置 || "家"
  try {
    const 图 = JSON.parse(fs.readFileSync(path.join(TOOLS, "地图.json"), "utf8"))
    return ((图.地点 || {})[String(名)] || {}).室内 === true
  } catch { return false }
})()
let req = {
  id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
  at: bj.toISOString().slice(0, 16).replace("T", " "),
   // SUBJECT 2026-11-05：主体决定这张画什么。自己 / 风景 / 物件 / 别人 / 猫。
  // 画面是给渲染端的英文提示词，优先级最高；主体只用来分类和统计（照片墙上按它分组）。
  主体: get("主体") || (想法 && 想法.主体) || "自己",
  // SHOT_MODE 2026-11-06（批次114）：这一张是怎么拍的。
  //   自拍 = 手拿机位，她占画面主体（默认）
  //   固定 = 机位架在几步外，她入画、地方也入画
  //   空镜 = 画面里只有景 / 物 / 别人 / 猫，没有她
  // 空着不写也行：本机按主体推（自己 → 自拍，其余 → 空镜）。
  // 这里只透传，不在这里做判断 —— 判断只在本机的 定机位() 一处，免得两处不一致。
  机位: get("机位") || (想法 && 想法.机位) || "",
  构图: get("构图") || (想法 && 想法.构图) || "",
  画面: get("画面") || (想法 && 想法.画面) || "",
  话: get("话") || (想法 && 想法.话) || "",
  // 显式传了场景就以传的为准；没传且人在家，就用房间名（浴室/主卧/客厅/厨房/阳台）
  场景: get("场景") || (在途 ? "路上" : (家里房间 || asset.位置 || "家")),
  室内,
  在路上: 在途
    ? { 从: 在途.from, 去: 在途.to, 剩分: Math.max(1, Math.ceil((Number(在途.arriveAt) - Date.now()) / 60e3)) }
    : undefined,
  动作: get("动作") || auto.state || "待着",
  心情: get("心情") || (st.mood && st.mood.label) || "",
  // MOOD_VALUE 2026-11-05：把心情的强度也带上（-3..3），本机据此决定要不要「有活力」、
  // 以及会不会贴脸拍——心情低的时候硬笑就假了
  心情值: Number((st.mood && st.mood.intensity) ?? get("心情值") ?? 0),
  // OUTFIT_EN 2026-11-05：把她身上这套翻成英文，交给本机写进提示词——
  // 不然自拍永远穿着默认的女仆装，跟面板上「她穿什么」对不上
  穿着英: (() => {
    try {
      const 服装 = JSON.parse(fs.readFileSync("{{BOT_ROOT}}/共享/工具/服装表.json", "utf8"))
      const z = asset.着装 || {}
      const 件 = []
      for (const k of ["全身", "上", "下", "鞋"]) {
        const n = z[k]
        if (n && 服装[n] && 服装[n].英) 件.push(服装[n].英)
      }
      for (const n of (z.饰 || [])) if (服装[n] && 服装[n].英) 件.push(服装[n].英)
      if (!件.length) return ""
      return "She wears " + 件.join(", ") + "."
    } catch { return "" }
  })(),
  最近买,
  小时: bj.getUTCHours(),
  ...关系镜头,
  // WEATHER_SHOT 2026-11-05：窗外什么天，光线就有多亮。
  // 原来自拍的「光」是按小时估的，阴天也能拍出大太阳。
  // WEATHER_SHOT 2026-11-05（批次79 扩）：
  // 「光照 0.4」这种数字渲染端没法画。多给一句人话（光是什么样子的），
  // 再带上「正在下雨 / 风几级 / 在室内外」——
  // 不然她明明在便利店里头，画面里也会被画成站在雨里。
  ...(() => {
    try {
      const w = read("天气.json")
      if (!w || !w.天气) return {}
      const L = Number(w.光照 ?? 0.5)
      const 光词 = L <= 0.1 ? "很暗" : L <= 0.25 ? "偏暗" : L <= 0.5 ? "柔" : L <= 0.8 ? "明亮" : "刺眼"
      const 段 = String(w.时段 || "")
      // 她在屋里就是屋里那个温度：窗外 13°、屋里 22°，照片该记 22。
      const __环 = (() => { try { return 区域温度() } catch { return null } })()
      return {
        天气: w.天气, 温度: __环 ? Math.round(Number(__环.区域)) : w.温度, 光照: w.光照,
        室内: __环 ? !!__环.室内 : null, 位置: __环 ? String(__环.位 || '') : '',
        光线: (段 ? 段 + "·" : "") + 光词,
        时段: 段,
        正在下: !!(w.现在 && w.现在.下),
        降的什么: String((w.现在 || {}).降的什么 || ""),
        风: Number((w.风 || {}).级 || 0),
        能见度: Number(w.能见度 ?? 0) || undefined,
      }
    } catch { return {} }
  })(),
}

// REDO_REPLACE 2026-11-06（批次113）：重跑时整份换掉上面那个 req。
// 有完整 req 就原样重放（只换 id/重跑计数）——这是最准的一种；
// 没有就拿原场景/动作/心情/话 + 此刻的穿着天色拼一份，并标明「补的」。
if (重跑源 && !重跑源.完整 && !重跑源.场景) {
  // REDO_NO_BASE 2026-11-06（批次113）：sidecar 和照片墙里都没有这张的底子。
  // 这时候如果照着「此刻的现场」写一条，就会凭空虚造一张「她在家待着」的图，
  // 还顶着原来那个 id 覆盖照片墙 —— 比不重拍坏得多。直接拒绝。
  console.log("没有这张的底子，不能重拍：", 重跑源.id)
  process.exit(0)
}
if (重跑源) {
  const 底 = 重跑源.完整
    ? Object.assign({}, 重跑源.完整)
    : Object.assign({}, req, {
      主体: 重跑源.主体 || "自己",
      构图: 重跑源.构图,
      画面: 重跑源.画面,
      话: 重跑源.话,
      场景: 重跑源.场景 || "家",
      动作: 重跑源.动作 || "待着",
      心情: 重跑源.心情,
      在路上: undefined,
      补现场: true,
    })
  // 机位也跟着沿用：重拍一张空镜，不该突然冒出一个她。
  if (!底.机位 && 重跑源.机位) 底.机位 = 重跑源.机位
  底.id = 重跑源.id
  底.at = 重跑源.完整 && 重跑源.完整.at ? 重跑源.完整.at : req.at
  // 机位沿用原来那个：重拍是为了换掉画面里不对的东西，
  // 机位跟着一起变卦，前后两张连比较都没法比。
  if (重跑源.角度 && ["eye", "high", "low", "close"].includes(重跑源.角度)) 底.角度锁 = 重跑源.角度
  // REDO_ID 2026-11-06（批次119）：这个标记只有 {次数,上次}，面板想按 id 找「在不在重拍」
  // 就永远找不到（见 面板.mjs 的 REDO_ID_FIX）。谁读谁省一步，id 自己写上。
  底.重跑 = {
    id: 重跑ID,
    次数: Math.max(Number(重跑源.原次数 || 0), Number((底.重跑 && 底.重跑.次数) || 0)) + 1,
    上次: bj.toISOString().slice(0, 16).replace("T", " "),
  }
  req = 底
}

// 拍照本：id → 主体/构图/话。渲染端如果不认「话」，照片墙还能从这儿读回来。
// 只留最近 200 条，这是记录不是档案。
try {
  const 本P = path.join(MEM, "拍照本.json")
  let 本 = { items: [] }
  try { 本 = JSON.parse(fs.readFileSync(本P, "utf8")) } catch { /* 第一次跑 */ }
  const items = Array.isArray(本.items) ? 本.items : []
  // SHOT_WEATHER 2026-11-05（批次79）：把举起手机那一刻的天也记下来。
  // 不记的话，照片墙上永远看不出这张是雨天拍的还是大太阳拍的 ——
  // 可「外面在下雨」正是她当时为什么会拍它的原因。
  const 条 = {
    id: req.id, at: req.at, 主体: req.主体, 构图: req.构图, 话: req.话,
    天气: req.天气 || '', 时段: req.时段 || '', 光线: req.光线 || '', 室内: req.室内 === true,
  }
  // REDO_UPSERT 2026-11-06（批次113）：重拍沿用同一个 id，直接 push 会在本子里留两条
  // 同 id 的记录 —— 照片墙读到哪条看运气，可能读回她改之前那句话。同 id 就覆盖那一条。
  // REDO_UPSERT 2026-11-06（批次113）：同 id 只留一条，而且要把历史上多出来的合并掉。
  // 只覆盖「找到的第一条」不够 —— 读的时候是从后往前找最后一条，
  // 两份写读不一致，重拍之后照片墙可能还显示她改之前那句话。
  const 同id = items.map((x, i) => (x && x.id === req.id ? i : -1)).filter((i) => i >= 0)
  if (同id.length) {
    items[同id[0]] = Object.assign({}, items[同id[0]], 条)
    for (let k = 同id.length - 1; k >= 1; k -= 1) items.splice(同id[k], 1)
  } else items.push(条)
  本.items = items.slice(-200)
  原子写(本P, JSON.stringify(本, null, 1))
} catch { /* 记不上不影响拍照 */ }

fs.mkdirSync(path.join(BASE, "请求"), { recursive: true })
原子写(path.join(BASE, "请求", req.id + ".json"), JSON.stringify(req, null, 2))
console.log(
  (重跑源 ? "重拍已排队:" : "自拍已排队:"),
  req.id, "｜场景", req.场景, "｜主体", req.主体, "｜动作", req.动作, "｜心情", req.心情,
  "｜机位", req.机位 || "（按主体推）",
  "｜最近买", req.最近买 || "（没买）",
  (重跑源 ? "｜第 " + req.重跑.次数 + " 次重拍" + (重跑源.完整 ? "" : "（原请求没存，用此刻的现场补的）") : ""),
)
}
