#!/bin/bash
# 归档并清理 patches/ 下已退役（dsh-rofm-*）及废弃/死脚本。
# 默认归档到 BACKUP_DIR/retired-patches-<STAMP>/ 再删除原文件；--dry 模式严格零写入。
# 用法: bash scripts/cleanup-retired-patches.sh [--dry]
set -euo pipefail
DRY=0
if [ "${1:-}" = "--dry" ]; then
  DRY=1
elif [ -n "${1:-}" ]; then
  echo "未知参数: $1（用法: $0 [--dry]）" >&2
  exit 2
fi

HERE="$(cd "$(dirname "$0")/.." && pwd)"
PDIR="$HERE/patches"
BACKUP_DIR=${BACKUP_DIR:-/root/bak2}
STAMP=$(date +%Y%m%d-%H%M%S)
ARCHIVE="$BACKUP_DIR/retired-patches-$STAMP"

RETIRED=(
  "dsh-rofm-compact-desc.py"
  "dsh-rofm-narrow-judge.py"
  "dsh-rofm-scoring-rate.py"
  "dsh-rofm-wake-probe.py"
  "patch_rofm_noprestep.py"
  "patch_rofm_runtime_skip.py"
  "patch_tool_whitelist.py"
  "portable_onebot.py"
  "fix_portable.py"
)

FOUND=()
for f in "${RETIRED[@]}"; do
  [ -f "$PDIR/$f" ] && FOUND+=("$f")
done

if [ ${#FOUND[@]} -eq 0 ]; then
  echo "patches/ 中已无待清理的退役/废弃脚本。"
  exit 0
fi

if [ "$DRY" = 1 ]; then
  echo "[dry] 将归档并移除以下 ${#FOUND[@]} 个退役/废弃补丁："
  for f in "${FOUND[@]}"; do echo "  patches/$f"; done
  exit 0
fi

mkdir -p "$ARCHIVE"
for f in "${FOUND[@]}"; do
  cp -a "$PDIR/$f" "$ARCHIVE/$f"
  rm -f "$PDIR/$f"
  echo "archived & removed: patches/$f -> $ARCHIVE/$f"
done
echo "完成清理 ${#FOUND[@]} 个退役补丁（备份在 $ARCHIVE）。"
