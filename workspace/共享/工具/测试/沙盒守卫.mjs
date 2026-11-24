// 沙盒守卫.mjs —— 批次456（2026-11-14）
//
// 为什么有这个东西：
//   冒烟1b「把每个 .mjs 当 CLI 真跑一遍」——它靠一份**写死的环境变量名单**把模块指向沙盒。
//   名单漏一个模块，那个模块就写线上真档。实测跑一次写 16 个：
//     疾病 / 体温 / 卫生 / 念头 / 提醒水位 / 活动台账 / 缺口台账 / 激素 / 状态 / 自主 / 他的作息 …
//   而它自己的「真档指纹」只盯 16 个固定文件名，写脏了也看不见，还打印「真实文件未被触碰」。
//   一个个补 env 追不完（这个项目里同一个坑已经踩过 452/453/454/455 四次）。
//
// 做法：不猜模块读哪个 env、也不改模块。**在子进程里把 fs 的写入口全包一层**：
//   只要目标路径落在 SMOKE_GUARD_ROOT（默认 {{BOT_ROOT}}）里，
//   就改道到 SMOKE_GUARD_SANDBOX/改道/<相对路径>，并往 SMOKE_GUARD_LOG 记一行。
//   读仍然读真档（冒烟只验「能不能加载」，不验结果对不对）。
//
// 用法（父进程）：
//   环境.NODE_OPTIONS = '--import ' + pathToFileURL('<这个文件>').href
//   环境.SMOKE_GUARD_SANDBOX = 沙盒目录
//   环境.SMOKE_GUARD_LOG = 沙盒目录 + '/.改道.log'
//   环境.SMOKE_GUARD_TAG = '<模块名>'   // 可选，只为了日志里能点名
//
// 注意：patch 完必须 syncBuiltinESMExports()，否则 `import { writeFileSync } from 'node:fs'`
// 拿到的还是原函数（命名导入在模块链接时就把绑定固定了）。

import fs from 'node:fs'
import path from 'node:path'
import { syncBuiltinESMExports } from 'node:module'

const 根 = process.env.SMOKE_GUARD_ROOT || '{{BOT_ROOT}}'
const 沙 = process.env.SMOKE_GUARD_SANDBOX || ''
const 日志 = process.env.SMOKE_GUARD_LOG || ''
const 标签 = process.env.SMOKE_GUARD_TAG || ''

if (沙) {
  const 原append = fs.appendFileSync.bind(fs)
  const 原mkdir = fs.mkdirSync.bind(fs)

  const 记 = (api, 原路径, 新路径) => {
    if (!日志) return
    try { 原append(日志, 标签 + '\t' + api + '\t' + String(原路径) + '\t' + String(新路径) + '\n') } catch {}
  }

  const 该改 = (p) => {
    if (typeof p !== 'string' || !p) return null
    let abs
    try { abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(process.cwd(), p) } catch { return null }
    if (abs !== 根 && !abs.startsWith(根 + path.sep)) return null
    return path.join(沙, '改道', path.relative(根, abs))
  }

  const 包 = (名, 位置) => {
    const 原 = fs[名]
    if (typeof 原 !== 'function') return
    fs[名] = function (...a) {
      const 新 = 该改(a[位置])
      if (新) { try { 原mkdir(path.dirname(新), { recursive: true }) } catch {}; 记(名, a[位置], 新); a[位置] = 新 }
      return 原.apply(fs, a)
    }
  }

  // rename 要特殊处理：很多模块用「先写 x.tmp-xxx 再 rename」的原子写。
  // 源在真档、目标被改道到 /tmp，两边**不同文件系统** → EXDEV。
  // 处理：源如果在根内，优先用沙盒里的同名副本；真跨设备时 copy+unlink，
  // 但**只删带 .tmp- 的临时文件**（绝不删真数据）。
  const 原rename = fs.renameSync.bind(fs)
  fs.renameSync = function (a, b) {
    const 新B = 该改(b)
    let 源 = a
    if (typeof a === 'string') {
      const 沙源 = 该改(a)
      if (沙源) { try { fs.statSync(沙源); 源 = 沙源 } catch {} }
    }
    if (!新B) return 原rename(源, b)
    try {
      return 原rename(源, 新B)
    } catch (e) {
      if (e && e.code === 'EXDEV') {
        记('renameSync', a, 新B)
        fs.copyFileSync(源, 新B)
        if (源 !== a && /\.tmp-/.test(String(a))) { try { fs.unlinkSync(源) } catch {} }
        return
      }
      throw e
    }
  }

  包('writeFileSync', 0)
  包('appendFileSync', 0)
  包('createWriteStream', 0)
  包('copyFileSync', 1)      // 第二个参数是目标
  包('mkdirSync', 0)
  包('rmSync', 0)
  包('unlinkSync', 0)
  // RMDIR 2026-11-14（批次461）：漏了 rmdirSync —— 而 `_锁.mjs` 的解锁就是 rmdirSync。
  // 锁目录被改道到沙盒、解锁却删真路径（ENOENT），沙盒里的锁永远不释放 →
  // 任何用它加锁的脚本在守卫下必然「文件锁超时」。契约检查就是这么红的（自检 退出 1）。
  包('rmdirSync', 0)
  包('truncateSync', 0)

  // openSync 只在写模式才改道（'r' 读不动）
  const 原open = fs.openSync
  if (typeof 原open === 'function') {
    fs.openSync = function (p, 旗, ...rest) {
      const 是写 = typeof 旗 === 'string' ? /[wa+]/.test(旗) : (typeof 旗 === 'number' ? (旗 & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_APPEND | fs.constants.O_CREAT)) !== 0 : false)
      if (是写) {
        const 新 = 该改(p)
        if (新) { try { 原mkdir(path.dirname(新), { recursive: true }) } catch {}; 记('openSync', p, 新); return 原open.call(fs, 新, 旗, ...rest) }
      }
      return 原open.call(fs, p, 旗, ...rest)
    }
  }

  // promises 版
  const 原P = fs.promises
  const 包P = (名, 位置) => {
    const 原 = 原P[名]
    if (typeof 原 !== 'function') return
    原P[名] = async function (...a) {
      const 新 = 该改(a[位置])
      if (新) { try { 原mkdir(path.dirname(新), { recursive: true }) } catch {}; 记('promises.' + 名, a[位置], 新); a[位置] = 新 }
      return 原.apply(原P, a)
    }
  }
  包P('writeFile', 0)
  包P('appendFile', 0)
  包P('mkdir', 0)
  包P('rm', 0)
  包P('unlink', 0)

  syncBuiltinESMExports()
}
