#!/bin/bash
# 把模板里的宿主级补丁打到本机 dsh 全局包上。幂等：已打过就跳过。
# 用法: 应用全部.sh [--dry]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DRY=""
[ "${1:-}" = "--dry" ] && DRY=1

GLOBAL="$(npm root -g 2>/dev/null || true)"
PKG="$GLOBAL/@deepseek-ai/dsh/node_modules/@deepseek-ai"
if [ ! -d "$PKG" ]; then
  echo "找不到 dsh 全局包：$PKG" >&2
  exit 2
fi

mkdir -p /root/bak2
STAMP=$(date +%Y%m%d-%H%M%S)

apply_one() {
  local file="$1" target="$2" marker="$3"
  if [ ! -f "$target" ]; then
    echo "缺目标：$target" >&2
    return 1
  fi
  if grep -q "$marker" "$target"; then
    echo "skip $(basename "$file")（已有 $marker）"
    return 0
  fi
  if [ -n "$DRY" ]; then
    echo "[dry] 需要应用 $file -> ${target#$PKG/}"
    return 0
  fi
  cp -a "$target" "/root/bak2/$(basename "$target").bak-$STAMP"
  if ! ( cd "$PKG" && patch -p1 --dry-run < "$HERE/$file" >/tmp/_patch_dry.log 2>&1 ); then
    echo "dry-run 失败：$file"
    sed -n '1,20p' /tmp/_patch_dry.log
    return 1
  fi
  if ! ( cd "$PKG" && patch -p1 < "$HERE/$file" >/tmp/_patch_apply.log 2>&1 ); then
    echo "应用失败：$file"
    sed -n '1,20p' /tmp/_patch_apply.log
    return 1
  fi
  echo "已应用 $file"
}

ok=0
apply_one dsh-agent-loop-system-dedup.patch "$PKG/dsh-agent-loop/lib/index.js" TOKEN_DEDUP && ok=1
apply_one dsh-agent-loop-runtime-dedup.patch "$PKG/dsh-agent-loop/lib/index.js" RUNTIME_DEDUP && ok=1

if [ -n "$DRY" ]; then
  echo "[dry] patch_llm_retry.py $( [ "$(grep -c 'DEFAULT_MAX_RETRIES = 1;' "$PKG/dsh-llm/lib/index.js" 2>/dev/null || echo 0)" -gt 0 ] && echo '已打过' || echo '需要应用')"
else
  python3 "$HERE/patch_llm_retry.py" "$PKG/dsh-llm/lib/index.js"
  node --check "$PKG/dsh-agent-loop/lib/index.js" || exit 1
  node --check "$PKG/dsh-llm/lib/index.js" || exit 1
fi

echo "宿主补丁检查完成（$PKG）"
