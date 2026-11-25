#!/bin/bash
# 把模板里的通用文件推到某个实例，替换占位符。用于「改一处，同步所有」。
# 用法: 推给所有实例.sh <vars.env> [--dry]
set -euo pipefail
ENVF=${1:?用法: 推给所有实例.sh <vars.env> [--dry]}
DRY=${2:-}
[ -f "$ENVF" ] || { echo "找不到 $ENVF" >&2; exit 2; }
if [ -n "$DRY" ] && [ "$DRY" != "--dry" ]; then
  echo "未知参数: $DRY（用法: 推给所有实例.sh <vars.env> [--dry]）" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 "$HERE/scripts/tpl_engine.py" export-shell --env "$ENVF")"
: "${BOT_NAME:?}" "${BOT_ROOT:?}"

BACKUP_DIR=${BACKUP_DIR:-/root/bak2}
if [ "$DRY" != "--dry" ] && [ -d "$BOT_ROOT" ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  ROOTS=()
  while IFS= read -r f; do
    [ -n "$f" ] && ROOTS+=("$f")
  done < <(cd "$BOT_ROOT" && find . -maxdepth 1 -type f -printf '%P\n')
  ITEMS=()
  [ -d "$BOT_ROOT/共享/工具" ] && ITEMS+=("共享/工具")
  ITEMS+=("${ROOTS[@]}")
  if [ ${#ITEMS[@]} -gt 0 ]; then
    tar czf "$BACKUP_DIR/实例-$BOT_NAME-$STAMP.tar.gz" -C "$BOT_ROOT" "${ITEMS[@]}"
  fi
fi

python3 - "$HERE" "$ENVF" "$DRY" <<'PY'
import importlib.util
import json
import os
import sys
from pathlib import Path

here, envf, dry = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3] == "--dry"

spec = importlib.util.spec_from_file_location("tpl_engine", str(here / "scripts/tpl_engine.py"))
tpl = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tpl)

vals = tpl.build_vars(envf)
base = Path(vals["BOT_ROOT"])
tpl_ws = here / "workspace"

cfg = json.loads((here / "模板清单.json").read_text(encoding="utf-8"))
tool_dir = cfg["通用工具目录"]
skip_dirs = set(cfg["排除目录"])
exts = tuple(cfg["通用工具扩展名"])
plain = cfg.get("通用工具文件", [])
init_only = set(cfg.get("仅初始化文件", []))
excl_files = set(cfg.get("模板排除文件", []))
root_files = cfg["通用根文件"]

changed = 0
unchanged = 0

def put(src: Path, rel: str) -> None:
    global changed, unchanged
    dst = base / rel
    data = tpl.render_text(src.read_text(encoding="utf-8"), vals)
    old = dst.read_text(encoding="utf-8") if dst.is_file() else None
    if old == data:
        unchanged += 1
        return
    if dry:
        print(f"[dry] would write {rel}")
    else:
        tpl.atomic_write_text(dst, data)
    changed += 1

for n in root_files:
    s = tpl_ws / n
    if s.is_file():
        put(s, n)

for n in plain:
    s = tpl_ws / tool_dir / n
    if s.is_file():
        put(s, os.path.normpath(os.path.join(tool_dir, n)))

tools_root = tpl_ws / tool_dir
if tools_root.is_dir():
    for dp, dns, fns in os.walk(tools_root):
        dns[:] = [d for d in dns if d not in skip_dirs]
        rd = os.path.relpath(dp, tools_root)
        for fn in fns:
            if not fn.endswith(exts):
                continue
            if fn in init_only or fn in excl_files:
                continue
            put(Path(dp) / fn, os.path.normpath(os.path.join(tool_dir, rd, fn)))

tag = " (dry)" if dry else ""
print(f"template -> {base}: {changed} changed, {unchanged} unchanged{tag}")
PY
