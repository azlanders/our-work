#!/usr/bin/env python3
"""QUIET_HOURS 2026-11-24：为主动搭话补上静默时段闸门（原子写 + --dry）。"""
import argparse
import os
import secrets
import sys
from pathlib import Path

MARK = "QUIET_HOURS 2026-11-24"
OLD = "    maintainProactiveReceipts(config, now)\n    let list = orderByStalest(candidates(config))\n"
NEW = (
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


def atomic_write(path: Path, text: str) -> None:
    tmp = path.parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def main() -> int:
    ap = argparse.ArgumentParser(description="Patch dsh-onebot-channel quiet hours gate")
    ap.add_argument("root", nargs="?", default=".", help="dsh-onebot-channel 目录")
    ap.add_argument("--dry", action="store_true", help="仅演练，不写入文件")
    args = ap.parse_args()

    p = Path(args.root) / "lib" / "proactive.js"
    if not p.is_file():
        print(f"FAIL 目标文件不存在: {p}", file=sys.stderr)
        return 2
    text = p.read_text(encoding="utf-8")
    if MARK in text:
        print(f"skip {p.name}: already patched")
        return 0
    if OLD not in text:
        print(f"FAIL {p}: 找不到目标片段，版本对不上，先人工确认", file=sys.stderr)
        return 1
    if args.dry:
        print(f"[dry] would patch {p}")
        return 0
    atomic_write(p, text.replace(OLD, NEW, 1))
    print(f"patched {p.name}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
