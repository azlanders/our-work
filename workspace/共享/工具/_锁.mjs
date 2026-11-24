// _锁.mjs —— 写文件前先抢一把最温柔的锁
// 用法：
//   import { 加锁 } from './_锁.mjs'
//   const 放 = 加锁('状态.json')   // 抢不到会在 2 秒后放弃并继续，不会卡住任何任务
//   try { 写文件 } finally { 放() }
// 为什么这么写：
//   · 用 mkdir 当锁（目录创建是原子操作），不依赖第三方库、不管文件系统差异。
//   · **抢不到也继续**：宁可偶尔丢一次更新，也不能让她的定时任务卡死在锁上——
//     真正要防的是「两个进程同时写、把 JSON 写坏」，那一步已经用原子写解决了。
//   · 带超时清理：锁目录超过 10 秒没释放就当作进程已死，直接抢过来。
import fs from 'node:fs'
import path from 'node:path'

const LOCK_DIR = process.env.QQ_LOCK_DIR || '{{BOT_ROOT}}/记忆/.locks'
const STALE_MS = 10_000
const WAIT_MS = 2000
// 2026-11-16（P0）：同一进程里已经持有的锁要能重入。
// 资产 CLI 现在整段持锁，内部还会调 改档()（它也要同一把锁）；不重入就会自己等自己。
const 本进程持有 = new Set()

function 抢一次(p, strict = false) {
  try { fs.mkdirSync(p); return true } catch (e) {
    if (e.code !== 'EEXIST') {
      if (strict) throw e
      return true // 兼容旧调用者：非严格模式保持原策略
    }
    try {
      const st = fs.statSync(p)
      if (Date.now() - st.mtimeMs > STALE_MS) { fs.rmdirSync(p); return false }
    } catch { return false }
    return false
  }
}

export function 加锁(name, options = {}) {
  const key = String(name)
  if (本进程持有.has(key)) return () => {}
  const strict = options.strict === true
  const configuredWait = options.waitMs ?? process.env.QQ_LOCK_WAIT_MS
  const waitMs = Number.isFinite(Number(configuredWait)) ? Math.max(0, Number(configuredWait)) : WAIT_MS
  try { fs.mkdirSync(LOCK_DIR, { recursive: true }) } catch (e) { if (strict) throw e; return () => {} }
  const p = path.join(LOCK_DIR, String(name).replace(/[^\w.\u4e00-\u9fa5-]/g, '_') + '.lock')
  const t0 = Date.now()
  while (!抢一次(p, strict)) {
    if (Date.now() - t0 > waitMs) {
      if (strict) throw new Error('文件锁超时：' + String(name))
      return () => {} // 兼容旧调用者：非严格模式抢不到仍按既有策略放弃锁
    }
    // BUSYWAIT_FIX 2026-11-24：原来是 15ms 纯自旋，单核 VPS 上空转 CPU。
    // 改用 Atomics.wait 睡过去（跟 _隧道.mjs 的 睡() 同一套写法）。
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15)
  }
  本进程持有.add(key)
  let 已放 = false
  return () => {
    if (已放) return
    已放 = true
    本进程持有.delete(key)
    try { fs.rmdirSync(p) } catch { /* 别人抢走或已删都不管 */ }
  }
}
