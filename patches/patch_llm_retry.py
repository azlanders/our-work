#!/usr/bin/env python3
"""将 dsh-llm 的 DEFAULT_MAX_RETRIES 从 5 降至 1（幂等、原子写、自动探测全局 npm 路径）。"""
import argparse
import os
import secrets
import subprocess
import sys
from pathlib import Path


def detect_default_target() -> Path:
    r = subprocess.run(["npm", "root", "-g"], capture_output=True, text=True)
    if r.returncode != 0 or not r.stdout.strip():
        sys.exit("无法通过 `npm root -g` 定位全局包目录，请手动传入目标 index.js 路径")
    return Path(r.stdout.strip()) / "@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js"


def atomic_write(path: Path, text: str) -> None:
    tmp = path.parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def main() -> int:
    ap = argparse.ArgumentParser(description="Patch dsh-llm DEFAULT_MAX_RETRIES to 1")
    ap.add_argument("target", nargs="?", help="目标 dsh-llm/lib/index.js 路径")
    ap.add_argument("--dry", action="store_true", help="仅演练，不写入文件")
    args = ap.parse_args()

    p = Path(args.target) if args.target else detect_default_target()
    if not p.is_file():
        print(f"FAIL 目标文件不存在: {p}", file=sys.stderr)
        return 2

    s = p.read_text(encoding="utf-8")
    if "DEFAULT_MAX_RETRIES = 1;" in s:
        print(f"skip {p}: already 1")
        return 0

    old = "const DEFAULT_MAX_RETRIES = 5;"
    if old not in s:
        print(f"FAIL anchor missing in {p}: {old!r}", file=sys.stderr)
        return 1

    if args.dry:
        print(f"[dry] would patch {p}")
        return 0

    atomic_write(p, s.replace(old, "const DEFAULT_MAX_RETRIES = 1;", 1))
    print(f"patched {p}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
