// 重启闸门：判断「她现在是不是在干活」，给重启/改代码前用。
//
// 由来（2026-11-16 05:04）：我判断「她闲着」用的是 `记忆/工具调用.jsonl` 最后一行时间。
// 但**那个文件只记 qq_* 工具，不记 bash** —— 她当时正在连跑 14 次 bash（05:02:50~05:04:39），
// 我看到的却是 04:57 的 qq_send，于是判定「她 7 分钟没动了」，05:04:45 重启，
// 把一个已经跑了 3 分钟的回合掐断，出站队列里那条回复被丢弃，游标已推进 → 永远不会再回。
//
// 正确判据（两个来源都要看）：
//   ① 会话文件 session.v4.jsonl.zstd 的 mtime —— 她每说一句、每调一次工具都会写，**bash 也算**
//   ② 桥接日志最后一行的时间 —— 收消息、投递、心跳都会写
//
// 用法：
//   node 共享/工具/重启闸门.mjs          → 打印判定，退出码 0=空闲可重启 / 1=在忙别动
//   node 共享/工具/重启闸门.mjs 300      → 自定义「多少秒内有写入算在忙」（默认 180）
import { statSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const 会话根 = '{{DSH_ROOT}}/sessions'
const 桥接日志 = '{{DSH_ROOT}}/qq-bridge-load.log'
const 默认窗口秒 = 180

function 最新会话写入() {
  let 最晚 = 0
  let 路径 = ''
  const 外 = existsSync(会话根) ? readdirSync(会话根) : []
  for (const 工作区 of 外) {
    const d = join(会话根, 工作区)
    let 内 = []
    try { 内 = readdirSync(d) } catch { continue }
    for (const 会话 of 内) {
      const f = join(d, 会话, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      try {
        const m = statSync(f).mtimeMs
        if (m > 最晚) { 最晚 = m; 路径 = f }
      } catch { /* 跳过 */ }
    }
  }
  return { 时刻: 最晚, 路径 }
}

function 日志尾时间() {
  if (!existsSync(桥接日志)) return { 时刻: 0, 行: '' }
  // 只读最后 64KB：日志已经几十 MB，别整份读
  let 文 = ''
  try {
    const 全部 = statSync(桥接日志).size
    const 起 = Math.max(0, 全部 - 64 * 1024)
    const fd = readFileSync(桥接日志)
    文 = fd.subarray(起).toString('utf8')
  } catch { return { 时刻: 0, 行: '' } }
  const 行们 = 文.split('\n').filter((l) => /^\d{4}-\d{2}-\d{2}T/.test(l))
  const 末 = 行们[行们.length - 1] ?? ''
  const m = 末.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3})Z/)
  const 时刻 = m ? Date.parse(m[1] + 'Z') : 0
  return { 时刻, 行: 末.slice(0, 100) }
}

function 主流程() {
  const 窗口 = Number(process.argv[2] ?? 默认窗口秒) || 默认窗口秒
  const now = Date.now()
  const 会话 = 最新会话写入()
  const 日志 = 日志尾时间()

  const 会话龄 = 会话.时刻 > 0 ? (now - 会话.时刻) / 1000 : Infinity
  const 日志龄 = 日志.时刻 > 0 ? (now - 日志.时刻) / 1000 : Infinity

  console.log('会话最后写入：' + (会话.时刻 > 0 ? 会话龄.toFixed(0) + ' 秒前' : '读不到')
    + (会话.路径 !== '' ? '  ' + 会话.路径.replace('{{DSH_ROOT}}/sessions/', '').slice(0, 60) : ''))
  console.log('桥接日志末行：' + (日志.时刻 > 0 ? 日志龄.toFixed(0) + ' 秒前' : '读不到'))
  if (日志.行 !== '') console.log('  ' + 日志.行)

  const 在忙 = 会话龄 < 窗口 || 日志龄 < Math.min(窗口, 60)
  console.log(在忙 ? '判定：在忙 —— 别重启（窗口 ' + 窗口 + ' 秒）' : '判定：空闲 —— 可以重启（窗口 ' + 窗口 + ' 秒）')
  process.exitCode = 在忙 ? 1 : 0
}

// ENTRY_GUARD：冒烟测试会 import 全部工具脚本，顶层不能直接跑
const 是直接运行 = (() => {
  try { return String(process.argv[1] ?? '').endsWith('重启闸门.mjs') } catch { return false }
})()
if (是直接运行) 主流程()
