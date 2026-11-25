#!/bin/bash
# 改完一处后跑：实例 → 模板 → 自检 → 其它实例。npm 版 onebot 的实例不推 dsh profile。
# 用法: 同步一圈.sh <instances/xxx.env> [--dry]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENVF=${1:?用法: 同步一圈.sh <instances/xxx.env> [--dry]}
DRY=${2:-}
[ -f "$ENVF" ] || { echo "找不到 $ENVF" >&2; exit 2; }
if [ -n "$DRY" ] && [ "$DRY" != "--dry" ]; then
  echo "未知参数: $DRY（用法: 同步一圈.sh <instances/xxx.env> [--dry]）" >&2
  exit 2
fi

# 仅读取源实例所需的 BOT_NAME / BOT_ROOT，避免污染子进程环境
BOT_NAME=$(env -i bash -c 'set -a; . "$1"; printf "%s" "${BOT_NAME:-}"' _ "$ENVF")
BOT_ROOT=$(env -i bash -c 'set -a; . "$1"; printf "%s" "${BOT_ROOT:-}"' _ "$ENVF")
: "${BOT_NAME:?}" "${BOT_ROOT:?}"

DRY_ARGS=()
[ "$DRY" = "--dry" ] && DRY_ARGS=(--dry)

echo "== 1/4 实例 → 模板（workspace） =="
bash "$HERE/同步模板.sh" "$BOT_ROOT" --vars "$ENVF" --force "${DRY_ARGS[@]}"

echo "== 2/4 实例 → 模板（DSH profile） =="
bash "$HERE/同步dsh.sh" "$ENVF" "${DRY_ARGS[@]}"

echo "== 3/4 模板自检 =="
bash "$HERE/自检.sh"

echo "== 4/4 模板 → 其它实例 =="
shopt -s nullglob
env_list=("$HERE"/instances/*.env)
shopt -u nullglob

if [ ${#env_list[@]} -eq 0 ]; then
  echo "  未找到 instances/*.env，跳过推送"
else
  src_real=$(readlink -f "$ENVF")
  for other in "${env_list[@]}"; do
    [ "$(readlink -f "$other")" = "$src_real" ] && continue
    echo "-- $(basename "$other") --"
    bash "$HERE/推给所有实例.sh" "$other" "${DRY_ARGS[@]}"
    # 在干净环境中读取 other 的 DSH_ROOT，杜绝跨实例环境变量污染
    other_dsh=$(env -i bash -c 'set -a; . "$1"; printf "%s" "${DSH_ROOT:-}"' _ "$other")
    if [ -n "$other_dsh" ] && grep -q 'file:./vendor/dsh-onebot-channel' "$other_dsh/profiles/web/package.json" 2>/dev/null; then
      bash "$HERE/推dsh.sh" "$other" "${DRY_ARGS[@]}"
    else
      echo "  跳过 dsh（$other 不是 vendor 版 onebot）"
    fi
  done
fi

echo "一圈同步完成。"
