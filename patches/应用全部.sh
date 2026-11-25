#!/bin/bash
# 把模板里的宿主级补丁打到本机 dsh 全局包上。幂等：已打过就跳过；任一失败返回非零退出码。
# 用法: 应用全部.sh [--dry]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DRY=""
if [ "${1:-}" = "--dry" ]; then
  DRY=1
elif [ -n "${1:-}" ]; then
  echo "未知参数: $1（用法: 应用全部.sh [--dry]）" >&2
  exit 2
fi

GLOBAL="$(npm root -g 2>/dev/null || true)"
PKG="$GLOBAL/@deepseek-ai/dsh/node_modules/@deepseek-ai"
if [ ! -d "$PKG" ]; then
  echo "找不到 dsh 全局包：$PKG" >&2
  exit 2
fi

BACKUP_DIR=${BACKUP_DIR:-/root/bak2}
STAMP=$(date +%Y%m%d-%H%M%S)
TMP_LOG=$(mktemp "/tmp/dsh-patch-$$.XXXXXX")
trap 'rm -f "$TMP_LOG"' EXIT

FAIL=0

apply_one() {
  local file="$1" target="$2" marker="$3"
  if [ ! -f "$target" ]; then
    echo "FAIL 缺目标：$target" >&2
    FAIL=1
    return 1
  fi
  if grep -q "$marker" "$target"; then
    echo "skip $(basename "$file")（已有 $marker）"
    return 0
  fi
  if ! ( cd "$PKG" && patch -p1 --dry-run < "$HERE/$file" >"$TMP_LOG" 2>&1 ); then
    echo "FAIL dry-run 失败：$file" >&2
    sed -n '1,20p' "$TMP_LOG" >&2
    FAIL=1
    return 1
  fi
  if [ -n "$DRY" ]; then
    echo "[dry] 验证通过，需要应用 $file -> ${target#$PKG/}"
    return 0
  fi
  mkdir -p "$BACKUP_DIR"
  cp -a "$target" "$BACKUP_DIR/$(basename "$target").bak-$STAMP"
  if ! ( cd "$PKG" && patch -p1 < "$HERE/$file" >"$TMP_LOG" 2>&1 ); then
    echo "FAIL 应用失败：$file" >&2
    sed -n '1,20p' "$TMP_LOG" >&2
    FAIL=1
    return 1
  fi
  echo "已应用 $file"
}

apply_one dsh-agent-loop-system-dedup.patch "$PKG/dsh-agent-loop/lib/index.js" TOKEN_DEDUP || true
apply_one dsh-agent-loop-runtime-dedup.patch "$PKG/dsh-agent-loop/lib/index.js" RUNTIME_DEDUP || true

if [ -n "$DRY" ]; then
  echo "[dry] patch_llm_retry.py $( [ "$(grep -c 'DEFAULT_MAX_RETRIES = 1;' "$PKG/dsh-llm/lib/index.js" 2>/dev/null || echo 0)" -gt 0 ] && echo '已打过' || echo '需要应用')"
else
  python3 "$HERE/patch_llm_retry.py" "$PKG/dsh-llm/lib/index.js" || FAIL=1
  node --check "$PKG/dsh-agent-loop/lib/index.js" || FAIL=1
  node --check "$PKG/dsh-llm/lib/index.js" || FAIL=1
fi

if [ "$FAIL" -ne 0 ]; then
  echo "宿主补丁应用存在失败项（$PKG）" >&2
  exit 1
fi
echo "宿主补丁检查完成（$PKG）"
