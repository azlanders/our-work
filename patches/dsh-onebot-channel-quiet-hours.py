#!/usr/bin/env python3
# QUIET_HOURS 2026-11-24
# 主动搭话静默时段：qq-bridge.config.json 里的 proactiveQuietFrom/To 一直被定义却没有任何地方读，
# 夜里 01:00~07:00 照样每 15 分钟爬起来发一轮，上游一拒绝就再烧一整轮约 28k 上下文，
# 一晚上几十轮一句没发出去。在 runProactiveOnce 里补上静默时段闸门（手动 force 触发放行）。
# 用法：python3 dsh-onebot-channel-quiet-hours.py <dsh-onebot-channel 目录>
import sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
p = root / 'lib' / 'proactive.js'
text = p.read_text(encoding='utf-8')
MARK = 'QUIET_HOURS 2026-11-24'
if MARK in text:
    print(f'skip {p.name}: already patched')
    raise SystemExit(0)
old = "    maintainProactiveReceipts(config, now)\n    let list = orderByStalest(candidates(config))\n"
new = (
    "    maintainProactiveReceipts(config, now)\n"
    "    // QUIET_HOURS 2026-11-24：配置里的 proactiveQuietFrom/To 一直被定义了却没有任何地方读。\n"
    "    // 夜里 01:00~07:00 照样每 15 分钟爬起来发一轮主动搭话，上游一拒绝就再烧一整轮\n"
    "    // 约 2.8 万上下文，一晚上几十轮一句没发出去。这里补上静默时段闸门；\n"
    "    // 手动 force 触发（「现在就想让她说一句」）放行。\n"
    "    if (!force) {\n"
    "      const 起 = minutesOf(config?.proactiveQuietFrom, -1)\n"
    "      const 止 = minutesOf(config?.proactiveQuietTo, -1)\n"
    "      if (起 >= 0 && 止 >= 0 && inQuietHours(bjMinutesOfDay(now), 起, 止)) {\n"
    "        result.skipped.push({ key: '*', reason: 'quiet-hours' })\n"
    "        return result\n"
    "      }\n"
    "    }\n"
    "    let list = orderByStalest(candidates(config))\n"
)
if old not in text:
    raise SystemExit(f'{p}: 找不到目标片段，版本对不上，先人工确认')
p.write_text(text.replace(old, new, 1), encoding='utf-8')
print(f'patched {p.name}')