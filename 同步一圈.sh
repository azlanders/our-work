#!/bin/bash
# 改完一处后跑：实例 → 模板 → 自检 → 其它实例。npm 版 onebot 的实例不推 dsh profile。
# 用法: 同步一圈.sh <instances/xxx.env> [--dry]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ENVF=${1:?用法: 同步一圈.sh <instances/xxx.env> [--dry]}
DRY=${2:-}
[ -f "$ENVF" ] || { echo "找不到 $ENVF" >&2; exit 2; }

set -a
. "$ENVF"
set +a
: "${BOT_NAME:?}" "${BOT_ROOT:?}"

echo "== 1/4 实例 → 模板（workspace） =="
bash "$HERE/同步模板.sh" "$BOT_ROOT" --vars "$ENVF" --force

echo "== 2/4 实例 → 模板（DSH profile） =="
bash "$HERE/同步dsh.sh" "$ENVF"

echo "== 3/4 模板自检 =="
bash "$HERE/自检.sh"

echo "== 4/4 模板 → 其它实例 =="
for other in "$HERE"/instances/*.env; do
  # SELF_SKIP_2026-11-24：ENVF 常写成相对路径（instances/hajimi.env），
  # 和 glob 出来的绝对路径不相等，结果把刚同步过的实例又推一遍。
  [ "$(readlink -f "$other")" = "$(readlink -f "$ENVF")" ] && continue
  echo "-- $(basename "$other") --"
  if [ "$DRY" = "--dry" ]; then
    bash "$HERE/推给所有实例.sh" "$other" --dry
  else
    bash "$HERE/推给所有实例.sh" "$other"
  fi
  # 只给用 vendor 装插件的实例推 dsh；npm 版 onebot 的旧实例先跳过
  other_dsh=""
  other_dsh=$(set -a; . "$other"; set +a; printf '%s' "${DSH_ROOT:-}")
  if [ -n "$other_dsh" ] && grep -q 'file:./vendor/dsh-onebot-channel' "$other_dsh/profiles/web/package.json" 2>/dev/null; then
    if [ "$DRY" = "--dry" ]; then
      bash "$HERE/推dsh.sh" "$other" --dry
    else
      bash "$HERE/推dsh.sh" "$other"
    fi
  else
    echo "   跳过 dsh（$other 不是 vendor 版 onebot）"
  fi
done

echo "一圈同步完成。"
