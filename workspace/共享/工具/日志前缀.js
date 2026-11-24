// 2026-11-06 批次125 / 2026-11-12 架构升级：给 cron 起的每个 node 进程的日志输出加「北京时间 + 脚本名」前缀。
//
// 2026-11-12 关键修复（根治 JSON stdout 被前缀污染导致 JSON.parse 全军覆没）：
//   · 当脚本以 `--json` 被子进程调用时（如 `地点.mjs --json`、`看视频.mjs --json`、`回忆.mjs --json`），
//     stdout 是给父进程机器解析的严格 JSON，绝不能加 `[YYYY-MM-DD HH:MM:SS 脚本.mjs]` 前缀！
//     此前 `自主行动.mjs` 调 `地点.mjs --json` 在 cron 下每次都 `JSON.parse` 抛错静默退化为空列表 `[]`，
//     导致她白天「走动」全部变成假发呆！
//   · 挂上前缀的同时，自动清理 `process.env.NODE_OPTIONS` 中的本注入器：
//     顶层任务日志保留时间戳前缀，而它内部再 spawn 的工具子进程不会叠出 `[外层] [内层]` 双层乱码。
const { format } = require('node:util')

try {
  const args = Array.isArray(process.argv) ? process.argv.slice(2) : []
  const isJsonMode = args.includes('--json')
  const 入口名 = String(process.argv[1] || '').split(/[\\/]/).pop() || ''
  if (入口名 !== '心跳.mjs' && process.env.NODE_OPTIONS && process.env.NODE_OPTIONS.includes('日志前缀.js')) {
    const cleaned = process.env.NODE_OPTIONS
      .replace(/--import=file:\/\/\/[^\s"']*日志前缀\.js/g, '')
      .trim()
    if (cleaned) process.env.NODE_OPTIONS = cleaned
    else delete process.env.NODE_OPTIONS
  }
  if (process.env.LOG_PREFIX_OFF !== '1' && !isJsonMode) {
    const 名 = String(process.argv[1] || 'node').split(/[\\/]/).pop() || 'node'
    const 时刻 = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')
    for (const k of ['log', 'info', 'warn', 'error', 'debug']) {
      const 原 = console[k]
      if (typeof 原 !== 'function') continue
      console[k] = function (...a) {
        let s
        try { s = format.apply(null, a) } catch { s = a.map((x) => String(x)).join(' ') }
        const 前缀 = `[${时刻()} ${名}] `
        原.call(console, s.split('\n').map((l) => 前缀 + l).join('\n'))
      }
    }
  }
} catch { /* 全局注入，绝不能让它把脚本搞挂 */ }
