#!/usr/bin/env python3
# VIDEO_IMAGE_SHRINK 2026-11-24
# qq_watch_video 的分镜拼图原图常有 1MB+，塞进上下文一次烧掉 150 万 token；
# 原来的 120KB 门槛是「太大就不挂图」，她等于看不见画面。改成先压成 900 宽的 JPEG 再挂。
# 用法：python3 dsh-onebot-channel-video-image-shrink.py <dsh-onebot-channel 目录>
import sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
tool = root / 'lib' / 'tool.js'
text = tool.read_text(encoding='utf-8')
marker = '压分镜图'
if marker in text:
    print('skip tool.js: already patched')
    raise SystemExit(0)

helper = """/** 分镜拼图原图常有 1MB+，直接塞进上下文一次能烧掉一百多万 token。
 *  转成 900 宽以内的 JPEG 再挂；还是太大就继续缩，缩不下来就不挂。 */
function 压分镜图(png) {
  for (const 宽 of [900, 720, 560]) {
    try {
      const out = execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-f', 'image2pipe', '-i', 'pipe:0',
        '-vf', `scale=min(${宽}\\\\,iw):-2`, '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'],
      { input: png, timeout: 15000, maxBuffer: 8 * 1024 * 1024 })
      if (out.length > 0 && out.length <= 60_000) return { data: new Uint8Array(out), mediaType: 'image/jpeg' }
    } catch { /* 这一档缩不动就试更小的一档 */ }
  }
  note('video', `分镜图压不到 60KB，这轮不挂图（原图 ${Math.round(png.length / 1024)}KB）`)
  return null
}

export async function registerWatchVideoTool(ctx) {
"""
if 'export async function registerWatchVideoTool(ctx) {' not in text:
    raise SystemExit('tool.js: 找不到 registerWatchVideoTool，版本对不上')
text = text.replace('export async function registerWatchVideoTool(ctx) {\n', helper, 1)

old = """            const inputs = res.sheets
              .filter((s) => s?.png && s.png.length > 0 && s.png.length <= 120_000)
              .slice(0, 1)
              .map((s, idx) => ({ data: new Uint8Array(s.png), mediaType: 'image/png', name: `video-sheet-${idx + 1}.png` }))
"""
new = """            const 首张 = res.sheets.find((s) => s?.png && s.png.length > 0)
            const 压缩后 = 首张 ? 压分镜图(首张.png) : null
            const inputs = 压缩后 ? [{ ...压缩后, name: 'video-sheet.jpg' }] : []
"""
if old not in text:
    raise SystemExit('tool.js: 找不到分镜图挂载片段，版本对不上')
tool.write_text(text.replace(old, new, 1), encoding='utf-8')
print('patched tool.js')