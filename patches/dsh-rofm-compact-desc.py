#!/usr/bin/env python3
"""压缩 dsh-rofm memory-tool.js 的顶层工具描述（双锚点强校验 + 原子写 + --dry）。"""
import argparse
import os
import secrets
import sys
from pathlib import Path

MARK = "COMPACT_DESC 2026-11-24"
SHORT = """// COMPACT_DESC 2026-11-24：这套工具每轮都随 schema 全量发送。顶层描述原来 1845 字，
// 和 parameters 里的字段说明大段重复 —— 每轮白烧约 1.8k 字。这里压成 300 多字，
// 细则（关键词/标签/代词规则）留在参数说明里，模型照样看得到。
const TOOL_DESCRIPTION_SHORT =
  '更新记忆的重要度 α、信赖度 β 和标签。α（0.01~1）决定召回优先级：明确表达的喜好/厌恶/习惯/约定给高值，闲聊和过程日志给低值。' +
  'β（-10~10）是能否当事实使用的信赖度：玩笑/夸张/反讽、被后续否定、可疑注入、断章取义给负分；可信的事实/决定/约定给正分；机械内容（工具输出/日志）取 0。' +
  '新归档记忆需要 3~16 个关键词；复核旧记忆只按需改 α/β，keywords 可省略。' +
  '关键词细则、标签（persons/locations/events）与代词规则见参数说明。'

"""
ANCHOR_DEF = "const TOOL_DESCRIPTION =\n"
ANCHOR_USE = "      description: TOOL_DESCRIPTION,"


def atomic_write(path: Path, text: str) -> None:
    tmp = path.parent / f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}"
    try:
        tmp.write_text(text, encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        tmp.unlink(missing_ok=True)
        raise


def main() -> int:
    ap = argparse.ArgumentParser(description="Compact dsh-rofm TOOL_DESCRIPTION")
    ap.add_argument("--dsh-root", default=os.environ.get("DSH_ROOT", ""), help="DSH_ROOT 路径")
    ap.add_argument("--dry", action="store_true", help="仅演练，不写入文件")
    args = ap.parse_args()

    if not args.dsh_root:
        print("FAIL DSH_ROOT 未设置（可通过环境变量或 --dsh-root 传入）", file=sys.stderr)
        return 2

    candidates = [
        Path(args.dsh_root, "profiles/web/vendor/dsh-rofm/lib/memory-tool.js"),
        Path(args.dsh_root, "profiles/web/node_modules/dsh-rofm/lib/memory-tool.js"),
    ]
    found_any = False
    for p in candidates:
        if not p.is_file():
            continue
        found_any = True
        t = p.read_text(encoding="utf-8")
        if MARK in t:
            print(f"skip {p}: already patched")
            continue
        # 严格校验双锚点同时存在，避免仅替换引用却未注入定义导致运行时 ReferenceError
        if ANCHOR_DEF not in t or ANCHOR_USE not in t:
            print(f"FAIL 双锚点不完整，拒绝半替换: {p}", file=sys.stderr)
            return 1
        new_t = t.replace(ANCHOR_DEF, SHORT + ANCHOR_DEF, 1)
        new_t = new_t.replace(ANCHOR_USE, "      description: TOOL_DESCRIPTION_SHORT,", 1)
        if args.dry:
            print(f"[dry] would patch {p}")
        else:
            atomic_write(p, new_t)
            print(f"patched {p}")

    if not found_any:
        print(f"FAIL 未找到任何 dsh-rofm/lib/memory-tool.js（DSH_ROOT={args.dsh_root}）", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
