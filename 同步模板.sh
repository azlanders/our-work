#!/bin/bash
# 从现有实例把「通用文件」同步回模板，并把实例路径/服务名换成占位符。
# 用法: 同步模板.sh <实例 workspace> [--vars <实例 env>] [--name <短名>] [--dry] [--force|--newer]
set -euo pipefail
BASE=${1:-/data/bot-workspace}
shift || true
NAME=""
VARS=""
DRY=""
NEWER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name)
      [ $# -ge 2 ] || { echo "--name 缺少参数值" >&2; exit 2; }
      NAME="$2"; shift 2 ;;
    --vars)
      [ $# -ge 2 ] || { echo "--vars 缺少参数值" >&2; exit 2; }
      VARS="$2"; shift 2 ;;
    --dry) DRY=1; shift ;;
    --newer|--force) NEWER=1; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done

HERE="$(cd "$(dirname "$0")" && pwd)"
TPL="$HERE/workspace"

if [ -n "$VARS" ]; then
  [ -f "$VARS" ] || { echo "找不到 $VARS" >&2; exit 2; }
  eval "$(python3 "$HERE/scripts/tpl_engine.py" export-shell --env "$VARS")"
  NAME=${NAME:-${BOT_NAME:-}}
fi
[ -n "$NAME" ] || { echo "必须用 --name 或 --vars 指定实例短名，否则服务名不会还原成占位符" >&2; exit 2; }

python3 - "$BASE" "$TPL" "$HERE" "$NAME" "${DRY:-0}" "${NEWER:-0}" "${VARS:-}" <<'PY'
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

base = Path(sys.argv[1])
tpl = Path(sys.argv[2])
here = Path(sys.argv[3])
name = sys.argv[4]
dry = sys.argv[5] == "1"
newer = sys.argv[6] == "1"
vars_file = Path(sys.argv[7]) if sys.argv[7] else None

def load_mod(mod_name: str, path: Path):
    spec = importlib.util.spec_from_file_location(mod_name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

tpl_eng = load_mod("tpl_engine", here / "scripts/tpl_engine.py")
clean_mod = load_mod("clean_persona", here / "clean-persona.py")

cfg = json.loads((here / "模板清单.json").read_text(encoding="utf-8"))
exts = tuple(cfg["通用工具扩展名"])
plain_files = cfg.get("通用工具文件", [])
init_files = set(cfg.get("仅初始化文件", []))
excl_files = set(cfg.get("模板排除文件", []))
tool_dir = cfg["通用工具目录"]
skip_dirs = set(cfg["排除目录"])
root_files = cfg["通用根文件"]

vals = tpl_eng.build_vars(vars_file, overrides={"BOT_NAME": name})
up = vals["BOT_NAME_UPPER"]

extra_map: dict[str, str] = {
    f"/data/{name}-qq": "{{QQ_HOME}}",
    f"/data/{name}-workspace": "{{BOT_ROOT}}",
    f"/data/{name}-dsh": "{{DSH_ROOT}}",
    f"/root/{name}-patches": "/root/{{BOT_NAME}}-patches",
    f"reapply-patches-{name}.sh": "reapply-patches-{{BOT_NAME}}.sh",
    f"napcat-{name}": "napcat-{{BOT_NAME}}",
    f"onebot-proxy-{name}": "onebot-proxy-{{BOT_NAME}}",
    f"{name}-fleet.json": "{{BOT_NAME}}-fleet.json",
    f"{name}-heartbeat": "{{BOT_NAME}}-heartbeat",
    f"{name}-upstream": "{{BOT_NAME}}-upstream",
    f"{name}-gateway": "{{BOT_NAME}}-gateway",
    f"{name}-panel": "{{BOT_NAME}}-panel",
    f"{name}-bot": "{{BOT_NAME}}-bot",
    f"{up}_FLEET_CONFIG": "{{BOT_NAME_UPPER}}_FLEET_CONFIG",
}
for rule in cfg.get("路径替换", []):
    a, b = (rule if isinstance(rule, (list, tuple)) else (rule["from"], rule["to"]))
    extra_map.setdefault(a, b)

extra_raw = os.environ.get("EXTRA_SUBS", "")
if extra_raw:
    for pair in extra_raw.split(";"):
        if not pair.strip():
            continue
        if ">" not in pair:
            print(f"[警告] 忽略格式错误的 EXTRA_SUBS 片段: {pair!r}", file=sys.stderr)
            continue
        a, b = pair.split(">", 1)
        extra_map[a.strip()] = b.strip()

def conv(text: str) -> str:
    out = tpl_eng.deinst_text(text, vals, extra_subs=extra_map)
    out = re.sub(r"process\.env\.(\{\{[A-Z_]+\}\}[A-Za-z0-9_]*)", r"process.env['\1']", out)
    return clean_mod.clean_text(out)

copied = 0
unchanged = 0
conflicts: list[str] = []

def sync_one(src: Path, rel: str) -> None:
    global copied, unchanged
    dst = tpl / rel
    new_data = conv(src.read_text(encoding="utf-8"))
    if dst.is_file():
        old_data = dst.read_text(encoding="utf-8")
        if old_data == new_data:
            unchanged += 1
            return
        if not newer:
            conflicts.append(rel)
            return
    if dry:
        print(f"[dry] would copy {rel}")
    else:
        tpl_eng.atomic_write_text(dst, new_data)
    copied += 1

for n in root_files:
    s = base / n
    if s.is_file():
        sync_one(s, n)

src_tools = base / tool_dir
for fn in plain_files:
    s = src_tools / fn
    if s.is_file():
        sync_one(s, os.path.normpath(os.path.join(tool_dir, fn)))

if src_tools.is_dir():
    for dp, dns, fns in os.walk(src_tools):
        dns[:] = [d for d in dns if d not in skip_dirs]
        rel_dir = os.path.relpath(dp, src_tools)
        for fn in fns:
            if not fn.endswith(exts):
                continue
            if fn in init_files or fn in excl_files:
                continue
            sync_one(Path(dp) / fn, os.path.normpath(os.path.join(tool_dir, rel_dir, fn)))

tag = " (dry)" if dry else ""
print(f"{base} -> {tpl}: {copied} updated, {unchanged} unchanged{tag}")
if conflicts:
    print(f"冲突 {len(conflicts)} 个（加 --force 用实例版本覆盖模板）:")
    for c in conflicts[:40]:
        print(" ", c)
PY
