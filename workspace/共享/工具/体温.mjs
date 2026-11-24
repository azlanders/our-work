// 体温.mjs —— 她身上冷暖这件事（2026-11-07，照主人给的思路）
//
// 主人定的思路：
//   · 先算「体感」：区域温度（图书馆有空调、公园就是室外）＋衣服的保暖，再算上走动/干活产的热；
//     空着肚子少一份热，自然往冷那边滑。
//   · 体温往体感那边慢慢靠，差得越多靠得越快，速度不写死，按风、湿、穿多少算，还掺一点随机。
//   · 冷热各四档：有点冷/冷/很冷/失温；有点热/热/很热/中暑。到后两档掉精力、掉心情，久了咬健康。
//
// 用法：
//   node 体温.mjs --看
//   node 体温.mjs --推进        # cron：把这段时间的变化固化
import { 写档 } from './_底层.mjs'
import * as 疾病 from './疾病.mjs'
import fs from 'node:fs'
import path from 'node:path'
import * as 穿衣 from './穿衣.mjs'
// MAP 2026-11-07（批次163）：地图问 地点.mjs 要，别再自己拼路径（拼错过一次）
import { 读图 } from './地点.mjs'

const MEM = process.env.TEMP_MEM || process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const P = path.join(MEM, '体温.json')
const 天气P = path.join(MEM, '天气.json')
const 资产P = path.join(MEM, '资产.json')
const 饱渴P = path.join(MEM, '饱渴.json')
const 自主P = path.join(MEM, '自主.json')

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const save = (p, o) => 写档(p, o)
export const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 解析 = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00'); return Number.isFinite(t) ? t : 0 }

// 圈子里的常识：室内有空调或暖气，太冷太热都会被拉回一段；室外就照真实温度
const 室内温 = (外) => Math.max(20, Math.min(26, 外 + (外 < 20 ? 12 : 外 > 26 ? -8 : 0)))

export function 区域温度(now = Date.now()) {
  const w = load(天气P, {})
  const 外 = Number(w.温度 ?? 18)
  const 位 = String(load(资产P, {}).位置 || '家')
  // 地图只有 地点.mjs 读的那一份（工具/地图.json）。这里原来是 记忆/地图.json ——
  // 文件不存在，地 恒为 {}，于是下面那句「没写室内就按常识补」成了唯一判据。
  const 地 = (读图().地点 || {})[位] || {}
  // 场地没写「室内」的，按常识补：打工点、街市、公园是露天的，其余默认室内（有空调/暖气）
  const 露天 = ['打工点', '街市', '公园']
  const 室内 = 地.室内 === true || (!露天.includes(位) && 地.室内 !== false)
  // WIND 2026-11-07（批次162）：风只在室外算 —— 屋里没有 4 级风，窗缝漏那点不算。
  // 级→0~1 的折算也收在这里一处（风折），别让每个调用方各写一个除数：
  // 原来体温用 级/6、穿衣默认 0，页面和体温能差出一整档。
  const 风级 = Number((w.风 && w.风.级) || 0)
  return {
    外, 区域: 室内 ? 室内温(外) : 外, 室内, 位,
    风级, 风: 室内 ? 0 : 风级, 风米: Number((w.风 && w.风.米) || 0),
    风折: 室内 ? 0 : Math.min(1, 风级 / 8),
    湿度: Number(w.湿度 ?? 60), 雨: !!(w.现在 && w.现在.下),
  }
}

// 体感：区域温度 + 衣服的保暖 − 产热 − 空肚子那份
export function 体感(now = Date.now()) {
  const 环 = 区域温度(now)
  const c = 穿衣.算({ 湿: 环.雨 ? 0.6 : 0, 风: 环.风折 })
  const 态 = String((load(自主P, {}).state && load(自主P, {}).state.状态) || '')
  const 产热 = /打工|走|逛/.test(态) ? 3 : /睡|盹/.test(态) ? -1 : 0
  const b = load(饱渴P, {})
  const 卡百 = (Number(b.卡 ?? 2000) / 2000) * 100
  const 空肚 = 卡百 < 25 ? -1.5 : 卡百 < 50 ? -0.8 : 0
  // 末端 2026-11-07（批次162）：露在外面的手/脚/头/脖子各算一笔冷，风越大越亏。
  // 这一笔原来写了两遍（末端 一次、值 里又一次，而且值那份还漏了「穿得薄」两档）——
  // 现在只算一次，值 直接拿它。同一条规则写两处必然分叉，这次差点又是。
  const 风冷 = Number(环.风 || 0) >= 3 ? (Number(环.风) - 2) * 0.22 : 0
  let 末 = 0
  for (const [名, 露罚, 薄罚, 薄线] of [['手', 1.2, 0.6, 0.2], ['脚', 1.2, 0.5, 0.3], ['头', 1.0, 0.4, 0.2], ['脖子', 0.6, 0.3, 0.2]]) {
    const p = c.部位[名]
    if (!p) continue
    if (p.露着) 末 -= 露罚 + 风冷
    else if (p.暖 < 薄线) 末 -= 薄罚 + 风冷 * 0.5
  }
  const 末端 = Math.round(末 * 10) / 10
  return {
    环, 保暖: c.加权, 部位: c.部位, 最薄: c.最薄, 露着: c.露着, 产热, 空肚,
    风冷: Math.round(风冷 * 10) / 10,
    末端,
    值: Math.round((环.区域 + c.加权 * 0.6 + 末端 + 产热 + 空肚) * 10) / 10,
  }
}

// 分区 2026-11-07（主人：「那应该手的温度低啊」）：
// 体温只是一个数，但露在外面的手、脚、下臂本来就凉 —— 按各自的保暖算一批局部温。
export function 分区(now = Date.now()) {
  const r = 读(now)
  let 区暖 = null
  try { 区暖 = 穿衣.九区({ 湿: r.体感.环.雨 ? 0.6 : 0, 风: r.体感.环.风折 }).区 } catch { 区暖 = null }
  const 暖 = 区暖 || {}
  // 缺多少暖就往低拉多少度：薄一格掉两度，露着一格掉到「冰手」那个程度。
  // WIND 2026-11-07（批次162）：露着的那格还要再按风级往下掉 —— 12 度的风里光着的手，
  // 跟没风的 12 度不是一回事。用 环.风（室内恒为 0），别拿 风级 判 —— 屋里也有 4 级风。
  const 风罚 = r.体感.环.风 >= 3 ? (r.体感.环.风 - 2) * 0.5 : 0
  const 掉 = (名, 每格 = 2, 露掉 = 6.5) => {
    const v = 暖[名]
    if (v === undefined) return 0
    if (v <= -1) return 露掉 + 风罚
    return Math.max(0, (0.8 - v)) * 每格
  }
  const 躯 = Math.round((r.体温 - 0.2) * 100) / 100
  const 区 = {
    头: Math.round((躯 - 掉("头", 1.6, 3.0)) * 100) / 100,
    // 脖子：有身子往上冒的热，露着也比头暖一点
    脖子: Math.round((躯 - 掉("脖子", 1.6, 2.5)) * 100) / 100,
    上臂: Math.round((躯 - 掉("上臂", 1.2, 4.0)) * 100) / 100,
    下臂: Math.round((躯 - 掉("下臂", 2.2, 5.0)) * 100) / 100,
    手: Math.round((躯 - 掉("手", 3.0, 6.0)) * 100) / 100,
    上身: 躯,
    下身: Math.round((躯 - 0.2) * 100) / 100,
    大腿: Math.round((躯 - 掉("大腿", 1.2, 4.0)) * 100) / 100,
    小腿: Math.round((躯 - 掉("小腿", 2.2, 5.0)) * 100) / 100,
    脚: Math.round((躯 - 掉("脚", 3.0, 6.0)) * 100) / 100,
  }
  return { 区, 体温: r.体温 }
}

export function 读(now = Date.now()) {
  const d = load(P, { 体温: 37.0, at: 北京(now) })
  const 前 = Number(d.体温 ?? 37)
  const t = 体感(now)
  // 目标：以 23 度为舒服点，往上往下各推一点；落在 34.5~39.5
  // FEVER 2026-11-07（批次221）：病理性升温。疾病只给偏移，不写体温文件；
  // 依赖方向固定 体温 → 疾病（疾病不读体温，避免成环）。
  const __烧 = (() => { try { return 疾病.发烧偏移(now) } catch { return 0 } })()
  const 目标 = Math.max(34.5, Math.min(39.5, 37 + (t.值 - 23) * 0.08 + __烧))
  const 从 = 解析(d.at) || now
  const 分 = Math.max(0, (now - 从) / 60e3)
  // 速度不写死：温差越大挪得越快；风、湿、穿得少再快一点；最多一分钟 0.06 度
  const 急 = Math.min(1.8, 1 + Math.abs(t.值 - 23) / 10 + t.环.风 / 8 + (t.环.雨 ? 0.3 : 0))
  // TICK 2026-11-07（批次162）：一分钟 0.06 度是给「实时连着算」定的；
  // 现在推进是十分钟一次，按 0.06 一步就能跨 0.6 度，体温会直接跳到目标、
  // 「慢慢靠过去」那层意思就没了。改成 0.012（约 0.7 度/小时）。
  const 步 = Math.min(Math.abs(目标 - 前), Math.min(0.012, Math.abs(目标 - 前) * 0.02) * 分 * 急)
  const 体 = Math.round((前 + Math.sign(目标 - 前) * 步) * 100) / 100
  return { 体温: 体, 目标: Math.round(目标 * 100) / 100, 体感: t, at: d.at, 分钟: Math.round(分) }
}

/**
 * 体温档。
 * @param {number} 温 实测体温
 * @param {number} [发烧] 其中由生病带来的偏移（疾病.发烧偏移）；>0.2 时最高只到「很热」，
 *   不按「中暑」罚 —— 39 度的发烧是难受、没力气，不是环境把人热虚脱了。
 */
export function 档(温, 发烧 = 0) {
  const v = Number(温) || 37
  if (v < 35.4) return { 名: '失温', 冷热: '冷', 罚: 3 }
  if (v < 35.7) return { 名: '很冷', 冷热: '冷', 罚: 2 }
  if (v < 36.1) return { 名: '冷', 冷热: '冷', 罚: 1 }
  if (v < 36.5) return { 名: '有点冷', 冷热: '冷', 罚: 0.5 }
  if (v <= 37.3) return { 名: '刚好', 冷热: '正常', 罚: 0 }
  if (v <= 37.8) return { 名: '有点热', 冷热: '热', 罚: 0.5 }
  if (v <= 38.4) return { 名: '热', 冷热: '热', 罚: 1 }
  if (v <= 39.2) return { 名: '很热', 冷热: '热', 罚: 2 }
  // 病理热封顶：发烧可以把体温推过 39.2，但罚只到「很热」这一级。
  if (Number(发烧) > 0.2) return { 名: '发烧', 冷热: '热', 罚: 2 }
  return { 名: '中暑', 冷热: '热', 罚: 3 }
}

export function 说(r = 读()) {
  const d = 档(r.体温)
  const 风 = r.体感.环.风级 >= 1
    ? `｜${r.体感.环.室内 ? '室内不算风' : `风 ${r.体感.环.风级} 级`}`
    : ''
  return `体温 ${r.体温}（${d.名}）｜体感 ${r.体感.值}（${r.体感.环.位}${r.体感.环.室内 ? '，室内' : '，室外'}${r.体感.环.雨 ? '，在下雨' : ''}）｜保暖 ${r.体感.保暖}${风}`
}

// 固化：把这一段时间的变化写回去
export function 推进(now = Date.now()) {
  const r = 读(now)
  // BOOTSTRAP 2026-11-07（批次162）：这条一直没生效过 —— 没有 体温.json 的时候，
  // 读() 把「上次」当成此刻，分钟永远是 0，于是这个 if 永远不成立，文件永远写不出来，
  // 体温就永远停在默认的 37.0。第一次跑先把「此刻 37 度」落盘，下次才有得比。
  if (!fs.existsSync(P)) {
    save(P, { 体温: 37, at: 北京(now), 上次档: 档(37).名 })
    return 读(now)
  }
  if (r.分钟 < 5) return r
  save(P, { 体温: r.体温, at: 北京(now), 上次档: 档(r.体温, 疾病.发烧偏移(now)).名 })
  return 读(now)
}

const 是主 = process.argv[1] && process.argv[1].endsWith('体温.mjs')
if (是主) {
  const args = process.argv.slice(2)
  if (args.includes('--推进')) console.log(说(推进()))
  else console.log(说(读()))
}
