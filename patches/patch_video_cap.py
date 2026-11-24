import pathlib, sys

tool = pathlib.Path(sys.argv[1])
s = tool.read_text(encoding="utf-8")

old = """          if (attachments && typeof attachments.saveImages === 'function' && Array.isArray(res.sheets) && res.sheets.length > 0) {
            const inputs = res.sheets
              .filter((s) => s?.png && s.png.length > 0)
              .map((s, idx) => ({ data: new Uint8Array(s.png), mediaType: 'image/png', name: `video-sheet-${idx + 1}.png` }))"""

new = """          if (args?.focus && attachments && typeof attachments.saveImages === 'function' && Array.isArray(res.sheets) && res.sheets.length > 0) {
            const inputs = res.sheets
              .filter((s) => s?.png && s.png.length > 0 && s.png.length <= 120_000)
              .slice(0, 1)
              .map((s, idx) => ({ data: new Uint8Array(s.png), mediaType: 'image/png', name: `video-sheet-${idx + 1}.png` }))"""

if old not in s:
    print('anchor not found')
    sys.exit(1)
s = s.replace(old, new, 1)

old2 = """        const hintZoom = res.mp4 ? `\\n（本地缓存文件：${res.mp4} —— 若需放大看某几秒画面细节，可传此路径调 video_zoom）` : ''
        return {
          engine: res.engine,
          fallbackReason: res.fallbackReason || '',
          mp4: res.mp4 || '',
          text: res.text + hintZoom,"""

new2 = """        const hintZoom = res.mp4 ? `\\n（本地缓存文件：${res.mp4} —— 若需放大看某几秒画面细节，可传此路径调 video_zoom）` : ''
        const hintPic = images.length ? '' : '\\n（画面缩略图未随结果返回；需要看具体画面时再用 video_zoom。）'
        return {
          engine: res.engine,
          fallbackReason: res.fallbackReason || '',
          mp4: res.mp4 || '',
          text: res.text + hintZoom + hintPic,"""

if old2 not in s:
    print('hint anchor not found')
    sys.exit(1)
s = s.replace(old2, new2, 1)
tool.write_text(s, encoding="utf-8")
print('patched tool.js')
