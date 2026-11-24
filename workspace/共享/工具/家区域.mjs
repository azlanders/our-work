// 家区域.mjs —— 她在家里待在哪个区域、在干什么（2026-11-05，主人要求「家里分几个区域，她在哪个区域干什么」）
//
// 用法：
//   node 家区域.mjs --tick      # 按当下状态挑一个区域与子活动（cron 每 20 分钟跑）
//   node 家区域.mjs --看看
//
// 为什么这么写：
//   · 人待在家不是只有「家」一个笼统位置：床、电脑桌、沙发、厨房、浴室、阳台，做的事完全不一样。
//   · 区域由「她正在干什么」推出来，不随机乱跳；只有摸鱼这种模糊状态才在「床上刷手机 / 电脑前」之间抽。
//   · 只在真的在家时才写，出门就把区域清空，免得面板说「在街市·床上」。
//   · 写进 自主.json 的 区域 / 地盘 两个字段，面板和她每轮的提示都能读到。
import { 改 as 改自主 } from './自主状态.mjs'
import { 睡着 } from './睡态.mjs'
import fs from 'node:fs'
import path from 'node:path'

const DIR = '{{BOT_ROOT}}'
const MEM = process.env.QQ_AUTONOMY_MEM || path.join(DIR, '记忆')
const AU = path.join(MEM, '自主.json')
const ASSET = path.join(MEM, '资产.json')
const WAKE = path.join(MEM, '睡醒.json')

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
// DEAD_SAVE 2026-11-12：这里原来有一行 save = … 写档(…)，写档 没 import、save 也没人调（批次169 之后都走 改自主）。删掉免得哪天被接上。
const bj = (ms = Date.now()) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

const args = process.argv.slice(2)
const 自主 = load(AU, {})
const 资产 = load(ASSET, {})
const 醒着 = !睡着(MEM)   // 批次164：判据在 睡态.mjs
const 位置 = String(资产.位置 || '家')
const 状态 = String(自主.state || '')

// 区域 → 在那干什么的一句话（同时是她自拍姿势的依据）
const 区域表 = {
  床: ['躺着刷手机', '窝着刷B站', '趴着刷贴吧', '补觉', '躺着看天花板'],
  电脑桌: ['在电脑前打游戏', '在电脑前看视频', '在电脑前瞎逛'],
  沙发: ['瘫在沙发上', '抱着毯子发呆', '坐在沙发上啃零食'],
  书桌: ['在桌前翻书', '在桌前记东西'],
  厨房: ['在厨房弄吃的', '在厨房煮东西'],
  浴室: ['在浴室洗澡', '在浴室吹头发'],
  阳台: ['在阳台晾衣服', '在阳台吹风'],
  餐厅: ['坐在餐桌前吃饭', '在餐桌旁喝东西'], // HOME_DINING 2026-11-07（批次211）：本机九间白模里有餐厅，VPS 这边原来只有 7 区
}

function 选区域() {
  if (!醒着) return ['床', '睡着']
  if (/洗澡|洗头/.test(状态)) return ['浴室', '在浴室洗澡']
  if (/做饭|煮/.test(状态)) return ['厨房', 抽(区域表.厨房)]
  // HOME_DINING 批次211：吃饭不一定都在厨房，餐桌（餐厅）才是正经吃饭的地方
  if (/吃|饿/.test(状态)) {
    return Math.random() < 0.6
      ? ['餐厅', 抽(区域表.餐厅)]
      : ['厨房', 抽(区域表.厨房)]
  }
  if (/看|读|学习|翻书|笔记/.test(状态)) return ['书桌', 抽(区域表.书桌)]
  if (/睡|躺|困|补觉/.test(状态)) return ['床', 抽(区域表.床)]
  if (/晾|晒|阳台/.test(状态)) return ['阳台', 抽(区域表.阳台)]
  if (/电脑|游戏|打游戏/.test(状态)) return ['电脑桌', 抽(区域表.电脑桌)]
  if (/发呆|歇|闲着|待命|摸鱼|刷手机|玩电脑/.test(状态)) {
    return Math.random() < 0.55
      ? ['床', 抽(['躺着刷手机', '窝着刷B站', '趴着刷贴吧'])]
      : ['电脑桌', 抽(区域表.电脑桌)]
  }
  if (/收拾|擦|整理|家务/.test(状态)) return ['沙发', '在收拾屋子']
  return ['沙发', 抽(区域表.沙发)]
}
function 抽(a) { return a[Math.floor(Math.random() * a.length)] }

// ZONE_SELF 2026-11-05：主人说「不用设定固定死时间 让她自己思考」——
// 所以这里不再替她排班：--在/--干嘛 是她自己定的口子，脚本只记账；
// --tick 只在她还没定的时候给个默认，定了就不动，也不设「必须待满几分钟」。
// 来源分两种：`自定` 是她自己用 --在 说的，`自动` 是 tick 按状态补的。
// 只有自定的才在「状态没变」时不动；自动的每次都可以更新。
function 写入(区, 干什么, 来源 = '自动') {
  // 批次169：原来整份 save(自主) —— 那是启动时读的旧副本，一路跑下来
  // 自主行动/工作/洗澡 写的 state 全被它抹回去。现在锁内只改区域这几个字段。
  // 历史改叫「区域历史」：它不是「她做过什么」的账（那本叫 log，自主行动 要读），
  // 每 20 分钟一条「在家·床」混进 log 会把 recent 全占满，降权直接失效。
  改自主(MEM, (a) => {
    a.区域 = 区
    a.地盘 = 干什么
    a.区域来源 = 来源
    a.区域状态 = String(a.state || '')
    a.区域更新 = bj()
    a.区域历史 = [...(Array.isArray(a.区域历史) ? a.区域历史 : []), { at: bj(), state: '在家·' + 区, note: 干什么 }].slice(-30) // SLIM 批次210：200→30
  })
  console.log(`在家 · ${区}：${干什么}`)
}

if (args.includes('--看看')) {
  if (位置 !== '家') { console.log(`人不在家（在${位置}）`); process.exit(0) }
  console.log(`在家 · ${自主.区域 || '没记'}：${自主.地盘 || 自主.state || '闲着'}`)
  process.exit(0)
}

if (args.includes('--候选')) {
  for (const k of Object.keys(区域表)) console.log(k + '：' + 区域表[k].join(' / '))
  process.exit(0)
}

// 她自己定：--在 床 --干嘛 刷B站
if (args.includes('--在')) {
  const 区 = String(args[args.indexOf('--在') + 1] || '')
  if (!区域表[区]) { console.log('没有这个区域，--候选 看看有哪些'); process.exit(0) }
  if (位置 !== '家') { console.log(`人不在家（在${位置}）`); process.exit(0) }
  const 干嘛 = args.includes('--干嘛') ? String(args[args.indexOf('--干嘛') + 1] || '') : 抽(区域表[区])
  写入(区, 干嘛, '自定')
  process.exit(0)
}

if (args.includes('--tick')) {
  if (位置 !== '家') {
    const 清 = 改自主(MEM, (a) => {
      if (!a.区域) return false
      a.区域 = ''
      a.地盘 = ''
    })
    console.log(清 !== null ? '出门了，区域清空' : '不在家，不动')
    process.exit(0)
  }
  // ZONE_SOURCE 2026-11-06（批次140）：原来只写 `if (自主.区域)` —— 于是第一次 tick
  // 自动写的「床」也被当成「她自己定的」，洗澡了也不换，一直躺在床。
  // 现在看来源：自定且状态没变才不动；状态变了（去洗澡/做饭）照样跟着走。
  // 旧数据没有 区域来源，按 `自动` 处理，让它有机会更新过来。
  const 来源 = String(自主.区域来源 || '自动')
  const 状态变了 = String(自主.区域状态 || '') !== 状态
  if (自主.区域 && 来源 === '自定' && !状态变了) {
    console.log(`在家 · ${自主.区域}（${自主.地盘}），她自己定的，状态没变就不动`)
    process.exit(0)
  }
  const [区, 干什么] = 选区域()
  写入(区, 干什么, '自动')
  process.exit(0)
}

console.log('用法：--在 区域 [--干嘛 ...] / --候选 / --看看 / --tick')
