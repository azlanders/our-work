/**
 * env.js —— 数据目录、日志、宿主服务取用。
 *
 * 数据目录放在 ~/.dsh/，不放在插件目录里。
 * 插件是用 file: 依赖装进 profile 的 node_modules 的副本，pnpm 重装会覆盖插件目录，
 * 配置和状态写进去会被冲掉（路由表一丢就得重新配）。dsh-fish-memory 也是这么放的。
 */
import { appendFileSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// DATA_SANDBOX 2026-11-14（批次440）：让测试能把整个数据目录搬走。
// 起因：t439 故意造「10 条装不下」来测留痕，而 note() 写的是**真** load.log ——
// 每跑一次全套就往真日志里塞两条「关系卡装不下：10 条只进了 4 条」，
// 跟真的报警长得一模一样。这个项目已经治过好几次「测试污染生产数据」了
// （做梦.log、待办.json、心跳锁），这次轮到日志。
// 生产没设 DSH_DATA，行为一字不变。
export const DATA_DIR = process.env.DSH_DATA || join(homedir(), '.dsh')
export const CONFIG_FILE = join(DATA_DIR, 'qq-bridge.config.json')
export const STATE_FILE = join(DATA_DIR, 'qq-bridge-state.json')
export const LOAD_LOG = join(DATA_DIR, 'qq-bridge-load.log')

// ---- 北京时间换算（2026-11-04 收口）----
//
// VPS 的系统时区是 UTC，所以 new Date().getHours() / getDate() 拿到的都是 UTC 字段。
// 这个坑在项目里反复出现：消息时间显示早 8 小时、记忆消退按 UTC 日期算、
// 主动搭话的静默时段整体偏移 8 小时、"这么晚了"在早上 7 点成立。统一收到这里。
//
// 用「先加 8 小时再取 UTC 字段」而不是 Intl：中国没有夏令时，+8 是常数；
// 这样也不依赖 Node 的 ICU 数据，跟 project 里其它地方的写法一致。
const BJ_OFFSET_MS = 8 * 3600e3

/** 把各种入参收敛成一个时间戳。注意 Number(null)===0、Number('')===0，不能直接 Number()。 */
function tsOf(at) {
  if (at === null || at === undefined || at === '') return Date.now()
  const n = Number(at)
  return Number.isFinite(n) && n > 0 ? n : Date.now()
}

/** 北京时间几点（0..23）。 */
export function bjHour(at) {
  return new Date(tsOf(at) + BJ_OFFSET_MS).getUTCHours()
}

/** 北京时间当日第几分钟（0..1439），给「静默时段」这类区间判断用。 */
export function bjMinutesOfDay(at) {
  const d = new Date(tsOf(at) + BJ_OFFSET_MS)
  return d.getUTCHours() * 60 + d.getUTCMinutes()
}

/** 北京时间自然日 YYYY-MM-DD。日配额、按天命名的文件都用它，别用机器本地日期。 */
export function bjDayKey(at) {
  const d = new Date(tsOf(at) + BJ_OFFSET_MS)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 日志轮转阈值：超过 2 MB 时保留尾部 256 KB，防止无限增长。 */
const LOG_ROTATE_BYTES = 2 * 1024 * 1024
const LOG_KEEP_BYTES = 256 * 1024
/** 每 256 条 note 查一次大小：note 是事件驱动的低频路径，查太频也没意义。 */
const ROTATE_CHECK_EVERY = 256
let noteCount = 0

/**
 * 写一条日志。出问题先看 qq-bridge-load.log。
 * 轮转用「截尾重写」：旧内容从中间截断，时间顺序不变，最近的日志永远在文件末尾。
 */
/**
 * 北京时间对应的 Date 对象 —— 用 getUTC* 读出来的就是北京的年月日时分。
 *
 * 2026-11-04：全项目只有这一处该出现 +8。
 * 之前 poll / outbound / images 里各写了一遍 `new Date(Date.now() + 8 * 3600 * 1000)`，
 * 一共 8 处；这个项目在时区上真出过 bug，每多一处就是多一个漏改点。
 * 要年月日时分，拿这个对象的 getUTC* 读，别再自己加八小时。
 */
export function bjDate(at) {
  return new Date(tsOf(at) + BJ_OFFSET_MS)
}

export function note(tag, message) {
  // QUIET_NOTE 2026-11-14（批次440）：有些测试**故意**造「装不下」来验装填逻辑
  // （t404 的 B2：10 条 × 120 字 = 1200 字 > 上限 1000），而 note 写的是**真** load.log ——
  // 每跑一次全套就多一条「关系卡装不下：10 条只进了 8 条」，和真报警长得一模一样。
  // 这个项目治过好几次「测试污染生产数据」，这次轮到日志。测试里设 QUIET_NOTE=1 让它闭嘴。
  // 用运行时 process.env（不是模块常量）—— 同进程的测试在 import 之后设也能生效。
  if (process.env.QUIET_NOTE === '1') return
  // TAG_SPLIT 2026-11-14（批次443）：这个接口是 note(tag, message)，但 lib 里有 17 处
  // 只传了一个参数、把整句当 tag（followup.js 9 处、photoWatch.js 8 处）。
  // 结果是日志写成「[[followup] 她说了一句…] undefined」—— 方括号套方括号，
  // 尾巴还多一个 undefined，三天积了 83 行（`grep undefined` 从此不能用来找真故障）。
  // 这里兜一层：单参且形如 `[tag] 正文` 就拆开，不像就整句当正文、tag 留空。
  // 没去改那 17 个调用点：改 17 处要担 17 次手误，一处归一更稳。
  if (message === undefined) {
    const m = /^\[([^\]]+)\]\s*([\s\S]*)$/.exec(String(tag ?? ''))
    if (m) {
      tag = m[1]
      message = m[2]
    } else {
      message = ''
    }
  }
  try {
    noteCount += 1
    if (noteCount % ROTATE_CHECK_EVERY === 0) {
      try {
        const size = statSync(LOAD_LOG).size
        if (size > LOG_ROTATE_BYTES) {
          const tail = readFileSync(LOAD_LOG).subarray(size - LOG_KEEP_BYTES)
          // 从第一个换行开始截，避免半行
          const nl = tail.indexOf(0x0a)
          writeFileSync(LOAD_LOG, nl >= 0 ? tail.subarray(nl + 1) : tail)
          appendFileSync(LOAD_LOG, `${new Date().toISOString()} [log] 已轮转：原 ${size} 字节，保留尾部 ${LOG_KEEP_BYTES}\n`, 'utf8')
        }
      } catch {
        /* 轮转失败不影响记日志 */
      }
    }
    appendFileSync(LOAD_LOG, `${new Date().toISOString()} [${tag}] ${message}\n`, 'utf8')
  } catch {
    /* 记日志失败不该制造新故障 */
  }
}

/**
 * 取宿主服务：DSH 里两套并存——注册过的服务走 ctx.get(name)，
 * 内建服务（tools、systemPrompt 等）是 ctx 上的属性，get 取不到。
 */
export function serviceOf(ctx, key) {
  if (typeof ctx.get === 'function') {
    const registered = ctx.get(key)
    if (registered !== undefined && registered !== null) return registered
  }
  return ctx[key]
}
