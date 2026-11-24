#!/bin/bash
# 用途：把视频拆成一张「时间线表」——按画面变化抽帧、逐帧读字、跟字幕对齐，先落文件再写总结
# 为什么这么写：
#   1. 之前看片子直接读字幕和封面就动笔，等于没看；这张表是硬前置，没有表不许写总结；
#   2. 抽帧按画面变化（select='gt(scene,0.3)'）而不是按秒，一镜一帧，几十到两百张；
#   3. 表落文件，上下文只读结论，别把几百帧塞进来。
# 用法：vidtable.sh <视频文件> [输出md]
set -u
SRC="${1:?用法: vidtable.sh <视频文件> [输出md]}"
OUT="${2:-/tmp/视频时间线-$(basename "$SRC" | tr ' ' '_').md}"
FRAMES=/tmp/vt-frames
rm -rf "$FRAMES"; mkdir -p "$FRAMES"

TOTAL=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$SRC" 2>/dev/null || echo 0)
echo "时长 ${TOTAL}s，按画面变化抽帧…"
ffmpeg -v error -i "$SRC" -vf "select='gt(scene,0.3)',showinfo" -vsync vfr -q:v 3 "$FRAMES/f%04d.jpg" 2>/dev/null
N=$(ls "$FRAMES"/*.jpg 2>/dev/null | wc -l)
echo "抽到 $N 帧"

{
  echo "# 视频时间线表"
  echo
  echo "- 源：$(basename "$SRC")"
  echo "- 时长：${TOTAL}s"
  echo "- 抽帧：按画面变化，共 $N 张"
  echo
  echo "| 序号 | 帧文件 | 画面里读到的字 |"
  echo "| --- | --- | --- |"
  i=0
  for f in "$FRAMES"/*.jpg; do
    i=$((i+1))
    txt=$(tesseract "$f" - -l chi_sim+eng 2>/dev/null | tr '\n' ' ' | sed 's/  */ /g' | cut -c1-80)
    [ -z "$txt" ] && txt="（没字）"
    echo "| $i | $(basename "$f") | $txt |"
  done
} > "$OUT"

echo "表写好了：$OUT（$N 行）。规矩：没读这张表不许写总结。"
