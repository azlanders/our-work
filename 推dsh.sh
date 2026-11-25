#!/bin/bash
# 把模板里的 DSH profile 推到实例：package.json / cordis.patch.yml / vendor。
# 用法: 推dsh.sh <vars.env> [--dry]
set -euo pipefail
ENVF=${1:?用法: 推dsh.sh <vars.env> [--dry]}
DRY=${2:-}
[ -f "$ENVF" ] || { echo "找不到 $ENVF" >&2; exit 2; }
if [ -n "$DRY" ] && [ "$DRY" != "--dry" ]; then
  echo "未知参数: $DRY（用法: 推dsh.sh <vars.env> [--dry]）" >&2
  exit 2
fi

set -a
. "$ENVF"
set +a
: "${BOT_NAME:?}" "${DSH_ROOT:?}"

TPL="$(cd "$(dirname "$0")" && pwd)"
PW="$DSH_ROOT/profiles/web"
BACKUP_DIR=${BACKUP_DIR:-/root/bak2}
DRY_ARGS=()
[ "$DRY" = "--dry" ] && DRY_ARGS=(--dry)

if [ "$DRY" != "--dry" ]; then
  mkdir -p "$PW" "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  if [ -f "$PW/package.json" ] || [ -d "$PW/vendor" ]; then
    tar czf "$BACKUP_DIR/dsh-$BOT_NAME-$STAMP.tar.gz" -C "$PW" \
      $( [ -f "$PW/package.json" ] && echo package.json ) \
      $( [ -f "$PW/cordis.patch.yml" ] && echo cordis.patch.yml ) \
      $( [ -d "$PW/vendor" ] && echo vendor )
  fi
fi

python3 "$TPL/scripts/tpl_engine.py" render-file --env "$ENVF" --check \
  --src "$TPL/dsh/package.json.tpl" --dst "$PW/package.json" "${DRY_ARGS[@]}"
python3 "$TPL/scripts/tpl_engine.py" render-file --env "$ENVF" --check \
  --src "$TPL/bridge/cordis.patch.yml.tpl" --dst "$PW/cordis.patch.yml" "${DRY_ARGS[@]}"

if [ "$DRY" != "--dry" ]; then
  rsync -a --delete --exclude='node_modules' --exclude='__pycache__' --exclude='.git' \
    "$TPL/dsh/vendor/" "$PW/vendor/"
  python3 "$TPL/scripts/tpl_engine.py" render-dir --env "$ENVF" \
    --root "$PW/vendor" --all-text --skip-empty --check
  echo "vendor synced -> $PW/vendor"
else
  echo "[dry] vendor rsync & render skipped"
fi
