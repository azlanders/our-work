#!/usr/bin/env node
import { 原子写 } from './_底层.mjs'
// ⛔ 已停用（2026-11-05，批次 63）。**没有任何东西再调它。**
//
// 它原来由 poll.js 的 RENSHI_HOOK 每条群消息 spawn 一次：拿 奖惩.mjs --识别
// 用正则判「这句在夸她/骂她/催她/越界」，判完直接改状态、好感度、耐心。
//
// 为什么停：它自己的账本（奖惩.json 6 条）里 5 条是误判 ——
//   「别是又变成滚木了」→ 坏话（扣 1.2）
//   「定时挂在凌晨 4:20。这样她翻旧账会越来越不准」→ 越界（扣 0.9）
//   「③这条我不同意照抄。只注入当前触发者的画像」→ 被记得（**加** 0.9）
// 全是技术讨论。和「滚=骂人」同一个病。
//
// 现在：被夸、被骂、被冒犯，她自己用 qq_feel 记（见 lib/感受.mjs）。
// 想恢复某个类别之前，先想清楚「这个判断系统做得准吗」——
// 做不准就只递事实，别替她下结论。
//
// 下面保留原代码，仅供查阅。
// ────────────────────────────────────────────────────────────
// 认事.mjs —— 从一条消息里认出一件事，认到就落账（2026-11-02）
//
// 用法（桥在收到消息后异步调用，不阻塞对话）：
//   node 认事.mjs --from {{OWNER_UIN}} --text "你真可爱"
//
// 为什么单独一个脚本：
//   · 桥里直接跑奖惩会拖慢投递，还容易因为一次正则误判把整轮搞挂。
//   · 独立进程 + 节流文件：一分钟最多认三条，误判也不会连环扣。
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

const tools = '{{BOT_ROOT}}/共享/工具'
const throttleP = '{{BOT_ROOT}}/记忆/认事节流.json'
const args = process.argv.slice(2)
const val = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d }

const text = val('--text', '')
const from = val('--from', '')
if (!text) process.exit(0)

// 节流：一分钟最多三条，防止刷屏时连环扣
let th = { at: 0, count: 0 }
try { th = JSON.parse(readFileSync(throttleP, 'utf8')) } catch { /* 首次 */ }
const now = Date.now()
if (now - th.at > 60e3) { th = { at: now, count: 0 } }
if (th.count >= 3) process.exit(0)

// 先试跑，认出来才真落账
let kind = ''
try {
  // RECOG_CTX_V2：把「是不是在对她说」的线索一起传过去
  const ctxFlags = []
  if (args.includes('--at')) ctxFlags.push('--at')
  if (args.includes('--reply')) ctxFlags.push('--reply')
  if (args.includes('--private')) ctxFlags.push('--private')
  if (args.includes('--recent')) ctxFlags.push('--recent')
  if (args.includes('--others')) ctxFlags.push('--others')
  kind = execFileSync('/usr/local/bin/node', [tools + '/奖惩.mjs', '--识别', text, ...ctxFlags], { encoding: 'utf8', timeout: 10000 }).trim()
} catch { process.exit(0) }
if (!kind.startsWith('认成：')) process.exit(0)
const k = kind.replace('认成：', '').trim()

try {
  const out = execFileSync('/usr/local/bin/node', [tools + '/奖惩.mjs', '--' + k, ...(from ? ['--from', from] : []), '--why', text.slice(0, 24)], { encoding: 'utf8', timeout: 12000 }).trim()
  th.count += 1
  原子写(throttleP, JSON.stringify(th))
  console.log('认到「' + k + '」：' + out.split('\n')[0])
} catch (e) { console.log('落账失败：' + e.message.slice(0, 40)) }
