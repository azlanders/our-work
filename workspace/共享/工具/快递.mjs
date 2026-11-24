// 快递.mjs —— 快递到货（批次219c，2026-11-07）
//
// 花钱.mjs `--买 X --送 快递` 时东西不进家：先记在 记忆/包裹.json，隔天到点由这里送进家。
// 跑腿和外卖不走这条 —— 跑腿当场到、外卖是吃饭那条路。
//
// 用法：
//   node 快递.mjs --tick     # 心跳表每 15 分钟一趟
//   node 快递.mjs --看       # 看看还有几件在路上
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { 改档 } from './_底层.mjs'

const MEM = process.env.QQ_AUTONOMY_MEM || '{{BOT_ROOT}}/记忆'
const TOOLS = process.env.QQ_AUTONOMY_TOOLS || '{{BOT_ROOT}}/共享/工具'
const 包裹P = path.join(MEM, '包裹.json')
const 资产P = path.join(MEM, '资产.json')

const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return d } }
const bjNow = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
const 解析 = (s) => { const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00'); return Number.isFinite(t) ? t : 0 }

const 是主 = process.argv[1] && process.argv[1].endsWith('快递.mjs')
if (是主) {
  const 包 = load(包裹P, { 件: [] })
  const 件 = Array.isArray(包.件) ? 包.件 : []
  const now = Date.now()
  const 到了 = 件.filter((x) => 解析(x.到At) && 解析(x.到At) <= now)
  const 路上 = 件.filter((x) => !(解析(x.到At) && 解析(x.到At) <= now))

  if (process.argv.includes('--看')) {
    if (!件.length) console.log('没有在路上的快递')
    else for (const x of 件) console.log(`${x.名}（${x.类}）预计 ${x.到At} 到`)
    process.exit(0)
  }
  if (!到了.length) { console.log('没有到点的快递'); process.exit(0) }

  // DELIVER_OK 2026-11-16（批次537）：原来这里写完「入库失败就留在路上，下一趟再送」这句注释，
  // 下一行却**无条件** `写档(包裹P, { ...包, 件: 路上 })` —— 到点的一律从包裹里抹掉。
  // 沙盒实测（物品.mjs 固定 exit 1）：打印「快递到了：洗发水（已放进家里）」、
  // 包裹件数 0、资产还记了一条「快递到了：洗发水」。东西没进家、记录没了、账是假的。
  // 现在只认真入成功的那几件：成功才移出包裹、才记账、才说「到了」。一件都没成就不动包裹。
  const 成 = []
  for (const x of 到了) {
    try {
      execFileSync(process.execPath, [
        path.join(TOOLS, '物品.mjs'), '--入', String(x.名),
        '--在', '家', '--类', String(x.类 || '零食'), '--价', String(Number(x.价) || 0),
      ], { encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_OPTIONS: '' } })
      成.push(x)
    } catch { /* 入库失败就留在路上，下一趟再送 */ }
  }
  if (!成.length) {
    console.log('到点了但一件都没入成，留在路上下一趟再试：' + 到了.map((x) => x.名).join('、'))
    process.exit(0)
  }
  // P0 2026-11-16：记录与包裹都改成锁内改，避免和 花钱/物品 同时写时互相覆盖。
  // 用「名|到At|记At」当键，因为 改档 会重读文件，对象引用对不上。
  const 成键 = new Set(成.map((x) => [x.名, x.到At, x.记At].join('|')))
  try {
    改档(资产P, (资) => {
      资.记录 = Array.isArray(资.记录) ? 资.记录 : []
      资.记录.push({ at: bjNow(), what: '快递到了：' + 成.map((x) => x.名).join('、') })
      if (资.记录.length > 200) 资.记录 = 资.记录.slice(-200)
      return 资
    }, { 记录: [] })
  } catch { /* 记不上不影响到货 */ }
  改档(包裹P, (最新) => {
    最新.件 = Array.isArray(最新.件) ? 最新.件 : []
    最新.件 = 最新.件.filter((x) => !成键.has([x.名, x.到At, x.记At].join('|')))
    return 最新
  }, { 件: [] })
  console.log('快递到了：' + 成.map((x) => x.名).join('、') + '（已放进家里）')
}
