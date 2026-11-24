import pathlib, sys

p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
old = """export function storyboardTools(defineTool, ctx) {
  return [
    defineTool({ ...storyboardToolSpec(), execute: (args) => storyboard.execute(ctx, args) }),
    defineTool({ ...zoomToolSpec(), execute: (args) => zoom.execute(ctx, args) }),"""
new = """export function storyboardTools(defineTool, ctx) {
  const zoomSpec = zoomToolSpec()
  const keepZoomDesc = new Set(['input', 'from', 'to', 'cellId', 'maxFrames'])
  const liteZoom = {
    ...zoomSpec,
    parameters: Object.fromEntries(Object.entries(zoomSpec.parameters).map(([k, v]) => [k, keepZoomDesc.has(k)
      ? v
      : { type: v.type, ...(v.enum ? { enum: v.enum } : {}), ...(v.required ? { required: true } : {}) }])),
  }
  return [
    defineTool({ ...storyboardToolSpec(), execute: (args) => storyboard.execute(ctx, args) }),
    defineTool({ ...liteZoom, execute: (args) => zoom.execute(ctx, args) }),"""
if old not in s:
    print('anchor not found')
    sys.exit(1)
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('patched zoom schema')
