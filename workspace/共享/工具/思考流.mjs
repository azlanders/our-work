import { 原子写 } from './_底层.mjs'
/**
 * 思考流.mjs —— 把她每一轮的 thinking 旁路记下来，给面板的「实时思考」页看。
 *
 * 为什么单独做，不塞进 滤泄漏.mjs：
 *   滤泄漏 是个会缓冲的 Transform（要攒 80 字符判断是不是推演），一旦挂上就有
 *   0.5~1 秒首字延迟。而「看思考」这个功能不该拖慢她说话。
 *   这里逐 chunk 原样透传，只在旁边解析 SSE 攒 thinking_delta，零延迟。
 *
 * 数据：{{BOT_ROOT}}/记忆/思考流.jsonl，一行一条 {at, ms, 文}
 *   滚动保留最近 300 条（约半天到一天的量）。
 *
 * 开关：{{DSH_ROOT}}/fish-leak.json 的 "记录思考"（默认 true）。
 *   关掉就纯透传，一个字节都不多写。
 *
 * 隐私：思考里会引用她和主人的对话，所以只给 owner 看 —— 面板的 /api/omni
 *   在批次349 的统一闸后面，POST 默认 owner，天然挡住客人。
 */
import { Transform } from 'node:stream'
import { appendFileSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'

const 开关文件 = '{{DSH_ROOT}}/fish-leak.json'
// SANDBOX 2026-11-16（批次547）：这条路径原来是写死的，测它就等于往真档里灌假思考。
// 跟其它脚本一样给一个环境变量，测试才能真的跑 造记思流（那个 Transform 是核心）。
const 输出 = process.env.QQ_THINK_OUT || '{{BOT_ROOT}}/记忆/思考流.jsonl'
const 保留条数 = 300
const 单条上限 = 4000        // 一条思考最多存 4000 字，长的截断（不然文件涨太快）

/** 记录思考的开关。读不到当开着 —— 这是个只读功能，默认开比默认关好。 */
export function 记思考(路径 = 开关文件) {
  try {
    const j = JSON.parse(readFileSync(路径, 'utf8'))
    return j && j.记录思考 !== false
  } catch {
    return true
  }
}

const 北京 = (ms) => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19).replace('T', ' ')

let 写入计数 = 0
/** 供其它模块（接口网关）直接记一条，不经过 Transform。 */
export function 记一条(文, 起, 谁 = '她') { 落一条(文, 起, 谁) }
function 落一条(文, 起, 谁 = '她') {
  const t = String(文 || '').trim()
  if (!t) return
  try {
    const 行 = JSON.stringify({
      at: 北京(Date.now()),
      谁,
      秒: 起 ? Math.round((Date.now() - 起) / 100) / 10 : 0,
      文: t.length > 单条上限 ? t.slice(0, 单条上限) + '…（截断）' : t,
    })
    appendFileSync(输出, 行 + '\n')
    // 每 20 条收拾一次，别每条都读整个文件
    if (++写入计数 % 20 === 0) {
      try {
        if (statSync(输出).size > 1024 * 1024) {
          const 全 = readFileSync(输出, 'utf8').trim().split('\n')
          if (全.length > 保留条数) 原子写(输出, 全.slice(-保留条数).join('\n') + '\n')
        }
      } catch { /* 收拾失败不影响记录 */ }
    }
  } catch { /* 记不上不影响转发 */ }
}

/**
 * 造一个「只记录、不改流」的 Transform。
 * 逐 chunk 原样透传（cb(null, chunk)），旁路解析 SSE 的 thinking_delta。
 */
export function 造记思流(谁 = '她') {
  let 尾 = ''
  let 攒 = ''
  let 起 = 0
  return new Transform({
    transform(chunk, enc, cb) {
      try {
        const s = 尾 + chunk.toString('utf8')
        const 段s = s.split('\n\n')
        尾 = 段s.pop()
        for (const 段 of 段s) {
          for (const 行 of 段.split('\n')) {
            if (!行.startsWith('data:')) continue
            let j
            try { j = JSON.parse(行.slice(5).trim()) } catch { continue }
            if (j.type === 'content_block_delta' && j.delta && j.delta.type === 'thinking_delta') {
              if (!起) 起 = Date.now()
              攒 += String(j.delta.thinking || '')
            }
          }
        }
      } catch { /* 解析失败就只透传 */ }
      cb(null, chunk)
    },
    flush(cb) {
      try { 落一条(攒, 起, 谁) } catch { /* 忽略 */ }
      cb()
    },
  })
}

/**
 * 读最近 N 条（新的在前）。面板用。
 * 谁：'她' | '全部'（默认只给她 —— 中转是所有请求共用的，agent 自己的思考别混进来）
 */
export function 读思考(n = 40, 谁 = '她') {
  // ZERO_IS_VALUE 2026-11-16（批次547）：原来写 `Number(n) || 40` ——
  // `n=0` 是 falsy，会被当成「没给」回落 40，于是 `Math.max(1, …)` 那道夹**永远到不了**。
  // 跟 心跳.mjs 里「0 是合法值，不能用 `|| 默认`」是同一个坑。
  // 现在只有「给的压根不是数」才回落 40；给了 0 就老实夹成 1。
  const 请求 = Number(n)
  const 条数 = Math.max(1, Math.min(200, Number.isFinite(请求) ? 请求 : 40))
  try {
    if (!existsSync(输出)) return []
    const 行 = readFileSync(输出, 'utf8').trim().split('\n').filter(Boolean)
    const 筛 = 谁 === '全部' ? 行 : 行.filter((l) => {
      try { return (JSON.parse(l).谁 || '她') === 谁 } catch { return false }
    })
    return 筛.slice(-条数).reverse().map((l) => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch {
    return []
  }
}
