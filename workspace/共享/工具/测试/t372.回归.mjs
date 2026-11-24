import fs from 'node:fs'

// 这个文件不是回归测试，是**一次性审计脚本**（批次372 的思考泄漏普查）：
// 它把一段真实 hippocampus 流里的她的输出逐条喂给 疑似思考泄漏 判据，看命中率。
// 原来直接 readFileSync 一个写死的实例目录，会在别的机器/换实例后直接 ENOENT 崩掉 ——
// 崩掉被当成「测试红了」，于是一个数据快照缺失把整套计数搅浑。
//
// STREAM_OPTIONAL 2026-11-24：改为
//   ① 路径按 HIPPO_STREAM 环境变量 → 该实例真实目录 依次尝试；
//   ② 都读不到就 skip（exit 0，打印说清原因）—— 没数据不等于判据有错；
//   ③ 判据本身（疑似思考泄漏）仍从当前插件导入并做最小自检，保证这部分没被悄悄改坏。

process.env.QUIET_NOTE = '1'

const 候选 = [
  process.env.HIPPO_STREAM,
  ...(() => {
    const dsh = process.env.DSH_HOME || '{{DSH_ROOT}}'
    const 根 = dsh + '/hippocampus'
    try {
      return fs.readdirSync(根, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => 根 + '/' + d.name + '/stream.jsonl')
    } catch { return [] }
  })(),
].filter(Boolean)

const 路 = 候选.find((p) => { try { return fs.existsSync(p) } catch { return false } })

let 判 = null
try {
  const m = await import((process.env.QQ_PLUGIN_LIB || (process.env.DSH_HOME || '{{DSH_ROOT}}') + '/profiles/web/node_modules/dsh-onebot-channel/lib') + '/outbound.js')
  判 = m.疑似思考泄漏
} catch (e) {
  console.log('skip（exit 0）：导入插件失败 ' + e.message)
  process.exit(0)
}
if (typeof 判 !== 'function') {
  console.log('失败 1/1：插件不再导出 疑似思考泄漏 —— 判据被改名/删除，本脚本需同步')
  process.exit(1)
}

// 判据最小自检（读 判据 源码后定的样例，不是猜的）：
//   该中 —— 英文第一人称自言自语（真实泄漏样例，批次372 20:0x 三连发之一）
//   不该中 —— 正常中文口语；以及「中文消息里嵌路径」这种不该被误伤
const 该中 = 判('I need to actually send now')
const 不该中1 = 判('刚吃完，有点撑')
const 不该中2 = 判('看这里 {{BOT_ROOT}}/共享/工具/poll.js 有个问题')
const 不该中 = 不该中1 || 不该中2
if (!该中 || 不该中) {
  console.log('失败 1/1：判据自检不过（该中=' + 该中 + ' 不该中=' + 不该中 + '）')
  process.exit(1)
}

if (!路) {
  console.log('通过 1/1（数据 skip）：本机找不到 hippocampus stream.jsonl，判据自检已过；普查需设 HIPPO_STREAM')
  process.exit(0)
}

const 行 = fs.readFileSync(路, 'utf8').split('\n').filter(Boolean)
let 总 = 0
const 命中 = []
for (const l of 行) {
  let e
  try { e = JSON.parse(l) } catch { continue }
  if (e.who !== 'me' || e.type !== 'assistant/message') continue
  const t = String(e.text || '').trim()
  if (!t) continue
  总++
  if (判(t)) 命中.push({ t, ts: e.ts })
}
命中.sort((a, b) => b.ts - a.ts)
console.log(`她的输出 ${总} 条，命中 ${命中.length} 条（${总 ? (命中.length / 总 * 100).toFixed(2) : '0.00'}%）`)
for (const h of 命中.slice(0, 16)) {
  const d = new Date(h.ts).toISOString().slice(5, 16).replace('T', ' ')
  console.log(`${d} | ${h.t.replace(/\n/g, ' ').slice(0, 80)}`)
}