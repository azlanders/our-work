#!/bin/bash
# 把实例的 DSH profile 通用部分同步回模板：package.json / cordis.patch.yml / vendor。
# 用法: 同步dsh.sh <vars.env> [--dry]
set -euo pipefail
ENVF=${1:?用法: 同步dsh.sh <vars.env> [--dry]}
DRY=${2:-}
[ -f "$ENVF" ] || { echo "找不到 $ENVF" >&2; exit 2; }
if [ -n "$DRY" ] && [ "$DRY" != "--dry" ]; then
  echo "未知参数: $DRY（用法: 同步dsh.sh <vars.env> [--dry]）" >&2
  exit 2
fi

set -a
. "$ENVF"
set +a
: "${BOT_NAME:?}" "${DSH_ROOT:?}"

TPL="$(cd "$(dirname "$0")" && pwd)"
PW="$DSH_ROOT/profiles/web"
[ -f "$PW/package.json" ] || { echo "找不到 $PW/package.json" >&2; exit 2; }
[ -f "$PW/cordis.patch.yml" ] || { echo "找不到 $PW/cordis.patch.yml" >&2; exit 2; }
[ -d "$PW/vendor" ] || { echo "找不到 $PW/vendor" >&2; exit 2; }

BACKUP_DIR=${BACKUP_DIR:-/root/bak2}
DRY_ARGS=()
[ "$DRY" = "--dry" ] && DRY_ARGS=(--dry)

if [ "$DRY" != "--dry" ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP=$(date +%Y%m%d-%H%M%S)
  tar czf "$BACKUP_DIR/模板-dsh-$BOT_NAME-$STAMP.tar.gz" -C "$TPL" dsh bridge/cordis.patch.yml.tpl
fi

python3 "$TPL/scripts/tpl_engine.py" deinst-file --env "$ENVF" \
  --src "$PW/package.json" --dst "$TPL/dsh/package.json.tpl" "${DRY_ARGS[@]}"
python3 "$TPL/scripts/tpl_engine.py" deinst-file --env "$ENVF" \
  --src "$PW/cordis.patch.yml" --dst "$TPL/bridge/cordis.patch.yml.tpl" "${DRY_ARGS[@]}"

if [ "$DRY" != "--dry" ]; then
  rsync -a --delete --exclude='node_modules' --exclude='.git' --exclude='__pycache__' \
    "$PW/vendor/" "$TPL/dsh/vendor/"
  echo "synced vendor/ ($(find "$TPL/dsh/vendor" -mindepth 1 -maxdepth 1 | wc -l) entries)"
else
  echo "[dry] vendor rsync skipped"
fi
