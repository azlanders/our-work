// 全模块冒烟 · 第一层（子进程版）：能不能 import。
//
// 为什么不用同进程 import：有那么几个模块顶层跑了 CLI 主流程，里面会 process.exit()，
// 同进程 import 会直接把冒烟进程杀掉（第一次跑就是这样，输出只剩两行）。
// 所以每个模块开一个 `node -e "import(...)"` 子进程，超时 8 秒。
//
// 输出三类：加载成功 / 加载抛错 / 挂住或主动退出。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

// QUIET_NOTE：这个文件会 import 插件 lib，register / 各 registerXxxTool 会调 note()，
// 往**真**插件日志 {{DSH_ROOT}}/qq-bridge-load.log 写。实测全套跑一遍能塞进去几千行
// 「xxx registered」，把真信号（比如 [照片到货] 已投递）冲掉。测试一律闭嘴。
process.env.QUIET_NOTE = '1'

// SB_UNIQUE 2026-11-14（批次437）：原来和另一个冒烟测试共用 /tmp/smoke-mem，
// 全套里两个文件是并行进程，各自开头的 rmSync 会删掉对方正在用的沙盒。
const 沙 = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke1b-'))
const 真 = '{{BOT_ROOT}}/记忆'
const 工具 = '{{BOT_ROOT}}/共享/工具'
const 插件 = '{{DSH_ROOT}}/profiles/web/node_modules/dsh-onebot-channel/lib'

// ── 沙箱 ──
const 跳过 = new Set(['归档', '视频画面', '听过的歌', '日志'])
fs.rmSync(沙, { recursive: true, force: true })
fs.mkdirSync(沙 + '/日志', { recursive: true })
for (const f of fs.readdirSync(真)) {
  if (跳过.has(f)) continue
  const a = path.join(真, f), b = path.join(沙, f)
  const s = fs.statSync(a)
  if (s.isDirectory()) { fs.mkdirSync(b, { recursive: true }); continue }
  if (s.size > 2 * 1024 * 1024) continue
  fs.copyFileSync(a, b)
}

const 环境 = { ...process.env }
for (const k of ['QQ_AUTONOMY_MEM', 'GAP_MEM', 'QQ_ACT_MEM', 'HUNGER_MEM', 'BAOKE_MEM',
  'QQ_MEM', 'ITEM_MEM', 'SHOT_MEM', 'QQ_PANEL_MEM', 'QQ_AUTONOMY_TOOLS', 'QQ_WORK_TOOLS']) {
  环境[k] = 沙
}
环境.FISH_USAGE_LOG = 沙 + '/fish-usage-log.jsonl'
环境.FISH_OMNI_CONFIG = 沙 + '/fish-omni.json'
// OMNI_SANDBOX 2026-11-14（批次454）：同上 —— 配置不存在时 isMusicSyncEnabled 会 fail-open，
// 每跑一次全套就真同步一次、下载 4MB、写真档 一起听.json。写成明确关闭。
fs.writeFileSync(沙 + '/fish-omni.json', JSON.stringify({ 一起听: { 开启: false } }))
环境.QQ_MUSIC_MEM = 沙
环境.QQ_MUSIC_DL = 沙 + '/下载'
环境.UPSTREAM_LOG = 沙 + '/upstream.log'
环境.QQ_PLUGIN_LIB = 插件
环境.ST_BASE = 沙
// SMOKE_NO_MODEL 2026-11-14（批次455）：写日记 / 自主学习 / 拍照想法 一跑就调一次真模型。
// 冒烟只是验「能不能加载」，不该花钱，也不该在共享/工具 工作区留会话目录（已 143 条）。
环境.SMOKE_NO_MODEL = '1'
// GUARD 2026-11-14（批次456）：上面那份 env 名单是「尽力而为」——实测漏掉的那些模块
// 一次就往真档写了 16 个（疾病/体温/卫生/念头/提醒水位/活动台账/缺口台账/激素/状态/自主…）。
// 真正的闸在子进程里的 沙盒守卫.mjs：fs 的写入口全包一层，落在 {{BOT_ROOT}} 就改道到沙盒。
环境.NODE_OPTIONS = '--import ' + pathToFileURL(path.join(工具, '测试', '沙盒守卫.mjs')).href
环境.SMOKE_GUARD_ROOT = '{{BOT_ROOT}}'
环境.SMOKE_GUARD_SANDBOX = 沙
环境.SMOKE_GUARD_LOG = 沙 + '/.改道.log'
// SMOKE_DREAM 2026-11-14（批次431）：这个冒烟是**把每个 .mjs 当 CLI 直接跑一遍**，
// 于是 做梦.mjs 的 main() 也真的跑：它按 DREAM_MEM 找记忆目录、写 记忆/日志/做梦.log。
// 之前这两个变量没设 → 每次跑全套都往**真档**日志塞一行「跳过」，
// 做梦.log 里那些「07:02 07:04 谁在调」就是这么来的（批次415 加 ppid 后才看清是我自己）。
// 注意 DREAM_LOGS 是「群聊日志目录」（只读），跟写日志的地方不是一回事。
环境.DREAM_MEM = 沙
环境.DREAM_LOGS = 沙 + '/群聊日志'

const 指纹 = (p) => { try { const s = fs.statSync(p); return s.size + ':' + Math.round(s.mtimeMs) } catch { return '无' } }
const 真档 = ['饱渴.json', '饥饿.json', '资产.json', '自主.json', '状态.json', '关系.json',
  '睡醒.json', '睡眠.json', '工作.json', '打盹.json', '睡醒.json', '计划.json', '回头说.json',
  '物品总表.json', '物品.json', '天气.json'].map((f) => path.join(真, f))
const 前 = 真档.map(指纹).join('|')

const 跑一个 = (目录, f) => {
  const url = pathToFileURL(path.join(目录, f)).href
  环境.SMOKE_GUARD_TAG = f   // 只为了改道日志里能点名
  const 码 = `import(${JSON.stringify(url)}).then(()=>{process.stdout.write('\\n__OK__')}).catch(e=>{process.stdout.write('\\n__ERR__'+(e&&e.message||e))})`
  const r = spawnSync(process.execPath, ['-e', 码], { timeout: 3000, encoding: 'utf8', env: 环境, maxBuffer: 4 << 20 })
  const 出 = String(r.stdout || '') + String(r.stderr || '')
  const 顶层输出 = String(r.stdout || '').replace(/__OK__|__ERR__[\s\S]*/, '').trim()
  if (出.includes('__OK__')) return { 状态: 'ok', 顶层输出 }
  if (出.includes('__ERR__')) {
    const msg = 出.split('__ERR__')[1].split('\n')[0].slice(0, 140)
    return { 状态: /Cannot find package|Cannot find module|ERR_MODULE_NOT_FOUND/.test(msg) ? '缺依赖' : '错误', msg, 顶层输出 }
  }
  if (r.signal || r.error) return { 状态: '挂住', msg: String(r.signal || r.error).slice(0, 80), 顶层输出 }
  return { 状态: '主动退出', msg: 'exit ' + r.status, 顶层输出 }
}

const 结果 = { ok: [], 错误: [], 缺依赖: [], 挂住: [], 主动退出: [], 顶层输出: [] }
const 扫 = (目录, 文件们, 标签) => {
  let i = 0
  for (const f of 文件们) {
    const r = 跑一个(目录, f)
    结果[r.状态].push({ 标签, f, msg: r.msg })
    if (r.顶层输出) 结果.顶层输出.push({ 标签, f, 字: r.顶层输出.length, 头: r.顶层输出.split('\n')[0].slice(0, 64) })
    i++
    if (i % 20 === 0) console.log('  [' + 标签 + '] ' + i + '/' + 文件们.length + ' … ' + f)
  }
}

const 工具文件 = fs.readdirSync(工具).filter((f) => f.endsWith('.mjs')).sort()
const 插件文件 = fs.readdirSync(插件).filter((f) => f.endsWith('.js')).sort()
console.log('待加载：共享工具 ' + 工具文件.length + ' 个，插件 lib ' + 插件文件.length + ' 个（每个一个子进程）\n')

扫(工具, 工具文件, '共享')
扫(插件, 插件文件, '插件')

const 总 = 工具文件.length + 插件文件.length
console.log('=== 汇总（共 ' + 总 + ' 个）===')
console.log('  加载成功   ' + 结果.ok.length)
console.log('  加载抛错   ' + 结果.错误.length)
console.log('  缺别的包   ' + 结果.缺依赖.length)
console.log('  挂住/超时  ' + 结果.挂住.length)
console.log('  主动 exit  ' + 结果.主动退出.length)

if (结果.错误.length) {
  console.log('\n--- 加载抛错（要修）---')
  for (const x of 结果.错误) console.log('  ★ [' + x.标签 + '] ' + x.f + '\n      ' + x.msg)
}
if (结果.挂住.length) {
  console.log('\n--- 挂住（8 秒没返回）---')
  for (const x of 结果.挂住) console.log('  ⏱ [' + x.标签 + '] ' + x.f + '  ' + x.msg)
}
if (结果.主动退出.length) {
  console.log('\n--- import 时就主动 exit（顶层跑了 CLI）---')
  for (const x of 结果.主动退出) console.log('  ⚠ [' + x.标签 + '] ' + x.f + '  ' + x.msg)
}
if (结果.顶层输出.length) {
  console.log('\n--- import 时有输出（顶层跑了东西）' + 结果.顶层输出.length + ' 个 ---')
  for (const x of 结果.顶层输出) console.log('  · [' + x.标签 + '] ' + x.f + '  ' + x.字 + ' 字  「' + x.头 + '」')
}
if (结果.缺依赖.length) {
  console.log('\n--- 缺别的包（只在宿主里能跑，不算问题）' + 结果.缺依赖.length + ' 个 ---')
  for (const x of 结果.缺依赖.slice(0, 10)) console.log('  · [' + x.标签 + '] ' + x.f + '  ' + x.msg)
  if (结果.缺依赖.length > 10) console.log('  …还有 ' + (结果.缺依赖.length - 10) + ' 个')
}

// 改道清单：哪些模块 import 时就想写线上（已被守卫改道，一个字节都没写进去）
let 改道行 = []
try { 改道行 = fs.readFileSync(沙 + '/.改道.log', 'utf8').trim().split('\n').filter(Boolean) } catch {}
if (改道行.length) {
  const 按模块 = {}
  for (const 行 of 改道行) {
    const 名 = 行.split('\t')[0] || '(未知)'
    按模块[名] = (按模块[名] || 0) + 1
  }
  const 名单 = Object.entries(按模块).sort((a, b) => b[1] - a[1])
  console.log('\n=== import 时就想写线上真档的模块 ' + 名单.length + ' 个（已改道到沙盒，没写进去）===')
  for (const [名, 次数] of 名单) console.log('  · ' + 名 + '  ' + 次数 + ' 次')
  console.log('  （这些模块缺入口保护：import 就会跑主流程。env 名单永远补不全，靠这道闸。）')
}

const 后 = 真档.map(指纹).join('|')
console.log(前 === 后 ? '\n真实文件未被触碰（指纹一致）' : '\n★★★ 真实文件被动了，本轮作废')
fs.rmSync(沙, { recursive: true, force: true })
