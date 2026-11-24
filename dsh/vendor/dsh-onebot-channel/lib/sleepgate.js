/**
 * sleepgate.js —— 「她睡着了没」在插件里只有这一处（批次168）
 *
 * 背景：批次164 在工具目录把 5 种睡眠判据收成了 睡态.mjs 的 睡着()，
 * 覆盖 16 个 .mjs。但那一批只扫了 共享/工具/ —— 插件目录（dsh-bot 进程）
 * 里 6 处一处没动，而且用了 4 种写法：
 *
 *   go.js      /睡/.test(自主.state)        ← 派生字段：状态推进 每 15 分钟才刷一次，
 *   items.js   /睡/.test(自主.state)           工作结算、自主行动还会把它写回别的值
 *   proactive  睡眠.json 的 sleeping          ← 写者自己注明「可能被别的路径先改掉，
 *                                              以 live 为准」；作息 --醒了 只改 睡醒.json
 *   photo.js   睡醒.json 的 sleeping          ← 权威档，但缺第三级（标记不在 → 看段）
 *   poll.js    睡醒.json（拼事实用）           ← 只描述，不驱动行为，合理
 *   poll.js    三级（标记 → 时间窗）           ← 唯一本来就对的那份
 *
 * 前四个改问这里；后两个不动。
 *
 * 两条边界写清楚，免得下一个人以为是随手抽的：
 *
 * 1) 判据不在本文件里重写，转调工具目录的 睡态.mjs。
 *    sleep.js 早就用过这个写法（`import('file://' + join(工具目录(), '睡眠阶段.mjs'))`），
 *    插件本来就依赖工具目录（qq_go 直接 spawn 走路.mjs）。
 *    在插件里再写一份三级判据 = 第 7 份，正是这一批要消掉的东西。
 *
 * 2) 拿不到 睡态.mjs 时降级成「只认权威标记」，不是第二套规则。
 *    那是 睡态 三级判据的第一档（严格子集）：标记 true 就是睡。
 *    宁可漏判「睡」，也不凭 自主.state 那种派生字段拦她 ——
 *    反了的话，她明明醒了（睡醒.json=false）却因为 state 还写着「睡觉」被工具拒绝，
 *    主人那边看到的就是「说我醒了，可她说走不动」。
 */
import { readFileSync } from 'node:fs'
const QQ_WS = process.env.QQ_WORKSPACE || '{{BOT_ROOT}}'
import { join } from 'node:path'

/** 记忆目录：跟随各工具自己的沙盒变量，最后落到真目录。 */
export const 记忆目录 = () =>
  process.env.QQ_SLEEPGATE_MEM || process.env.QQ_AUTONOMY_MEM || `${QQ_WS}/记忆`

/** 工具目录：调用方可以显式传（各自有自己的 QQ_*_TOOLS），不传用这个。 */
export const 工具目录 = () =>
  process.env.QQ_SLEEPGATE_TOOLS ||
  process.env.QQ_GO_TOOLS ||
  process.env.QQ_SLEEP_TOOLS ||
  `${QQ_WS}/共享/工具`

const 读档 = (p, d) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return d
  }
}

// 模块缓存：一个进程只解析一次。null 也是有效缓存值（这个目录确实没有 睡态.mjs）。
const 缓存 = new Map()

async function 睡态模块(工具) {
  if (缓存.has(工具)) return 缓存.get(工具)
  let m = null
  try {
    // 路径里有中文，必须转成 file:// URL 再 import；反斜杠只防 Windows 下跑测试
    m = await import('file://' + join(工具, '睡态.mjs').replace(/\\/g, '/'))
  } catch {
    m = null
  }
  缓存.set(工具, m)
  return m
}

/**
 * 她睡着了吗。
 * @param {string} [mem]  记忆目录（各工具已经算好自己的沙盒变量，传进来）
 * @param {string} [工具] 工具目录，缺省见 工具目录()
 * @returns {Promise<boolean>}
 */
export async function 睡着(mem = 记忆目录(), 工具 = 工具目录()) {
  const m = await 睡态模块(工具)
  if (m && typeof m.睡着 === 'function') {
    try {
      return m.睡着(mem) === true
    } catch {
      /* 落到下面的降级 */
    }
  }
  // 降级：只认权威标记（睡态 的第一档）。理由见文件头第 2 条。
  const 标记 = 读档(join(mem, '睡醒.json'), null)
  return !!(标记 && 标记.sleeping === true)
}
