#!/usr/bin/env bash
# pixiv-fetch.sh —— 给作品号，直接下原图（不用登录、不用浏览器、绕开人机验证）
#
# 用法：
#   ./pixiv-fetch.sh 142545101            # 下到 {{BOT_ROOT}}/下载/pixiv-142545101/
#   ./pixiv-fetch.sh 142545101 /tmp/out   # 指定目录
#
# 为什么用 pixiv.re：www.pixiv.net 和 i.pximg.net 在机房 IP 上会被人机验证/污染挡住，
# 而 pixiv.re 这类镜像是在它自己那边取图再转给你，实测直接 200、字节数与原图一致。
# 编号规则：<id>.jpg 第一张，-2.jpg 第二张，-3.jpg 第三张（注意是从 2 开始）。
set -u

ID="${1:-}"
DIR="${2:-{{BOT_ROOT}}/下载/pixiv-$ID}"

if [ -z "$ID" ]; then
  echo "用法: $0 <作品号> [目录]"
  exit 1
fi

mkdir -p "$DIR"
cd "$DIR" || exit 1

UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36'
got=0

# 第一张
if curl -sSL --max-time 60 -A "$UA" -o "${ID}_p0.jpg" \
     -w '%{http_code}' "https://pixiv.re/${ID}.jpg" | grep -q '^200$'; then
  got=$((got + 1))
else
  rm -f "${ID}_p0.jpg"
  echo "第一张就没下到 —— 作品号不对，或镜像挂了"
  exit 1
fi

# 第 2 张起（后缀从 2 开始）
n=2
while [ "$n" -le 20 ]; do
  if curl -sSL --max-time 60 -A "$UA" -o "${ID}_p$((n-1)).jpg" \
       -w '%{http_code}' "https://pixiv.re/${ID}-${n}.jpg" | grep -q '^200$'; then
    got=$((got + 1))
    n=$((n + 1))
  else
    rm -f "${ID}_p$((n-1)).jpg"
    break
  fi
done

echo "下了 $got 张，在 $DIR："
ls -la "${ID}"_p*.jpg 2>/dev/null | awk '{print $5, $9}'
