import pathlib, sys

p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding="utf-8")
old = """        const res = await watchVideoUnified(src, {
          prompt,
          ...(args?.from !== undefined ? { from: Number(args.from) } : {}),
          ...(args?.to !== undefined ? { to: Number(args.to) } : {}),
        })"""
new = """        const res = await watchVideoUnified(src, {
          prompt,
          maxSheets: 1,
          detail: 'low',
          ...(args?.from !== undefined ? { from: Number(args.from) } : {}),
          ...(args?.to !== undefined ? { to: Number(args.to) } : {}),
        })"""
if old not in s:
    print('anchor not found')
    sys.exit(1)
p.write_text(s.replace(old, new, 1), encoding="utf-8")
print('patched density')
