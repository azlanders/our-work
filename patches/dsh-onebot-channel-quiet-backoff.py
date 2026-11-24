#!/usr/bin/env python3
# QUIET_BACKOFF 2026-11-24
# 主动搭话空转：她选择 qq_pass / 没开口时回执冷却固定 15 分钟，冷却一过又烧一整轮 28k 上下文。
# 改成按连续空转次数指数退避（15/30/60/120/240 分钟，封顶 4 小时）。
# 用法：python3 dsh-onebot-channel-quiet-backoff.py <dsh-onebot-channel 目录>
import io, sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
rt = root / 'receipt-transaction.mjs'
ob = root / 'lib' / 'outbound.js'

def patch(path, old, new, marker):
    text = path.read_text(encoding='utf-8')
    if marker in text:
        print(f'skip {path.name}: already patched')
        return
    if old not in text:
        raise SystemExit(f'{path}: 找不到目标片段，版本对不上，先人工确认')
    path.write_text(text.replace(old, new, 1), encoding='utf-8')
    print(f'patched {path.name}')

patch(rt,
      "  findMatching({ token, sessionId, target }) {\n",
      """  /**
   * 这个 target 连续「开了回合但一句没发」了几次。
   * 主动搭话的冷却靠它指数拉长：一次没说出口就每 15 分钟再烧 28k 上下文，
   * 一晚几十轮全是空转。
   */
  quietStreak(target, now = Date.now(), skipToken = '') {
    if (!validTarget(target)) return 0
    const targetKey = JSON.stringify(normalizedTarget(target))
    const rows = Object.values(this.loadForUse())
      .filter((entry) => String(entry.token ?? '') !== String(skipToken ?? ''))
      .filter((entry) => JSON.stringify(entry.target) === targetKey)
      .filter((entry) => Number(entry.stagedAt) <= Number(now))
      .sort((left, right) => Number(right.stagedAt) - Number(left.stagedAt))
    let streak = 0
    for (const entry of rows) {
      if (entry.status === 'not-sent' && !(Array.isArray(entry.messageIds) && entry.messageIds.length > 0)) {
        streak += 1
        continue
      }
      break
    }
    return streak
  }

  findMatching({ token, sessionId, target }) {
""",
      'quietStreak(target')

patch(ob,
      "          receiptStore.cancelNotSent({ ...record, now })\n",
      """          // QUIET_BACKOFF 2026-11-24：她没开口就别每 15 分钟再来一次。
          // 连续空转的冷却 15 分钟 × 2^n，封顶 4 小时。
          const 空转次数 = typeof receiptStore.quietStreak === 'function' ? receiptStore.quietStreak(record.target, now, record.token) : 0
          const 冷却 = Math.min(4 * 3600e3, 15 * 60e3 * Math.pow(2, Math.min(空转次数, 5)))
          receiptStore.cancelNotSent({ ...record, now, cooldownMs: 冷却 })
""",
      'QUIET_BACKOFF 2026-11-24')