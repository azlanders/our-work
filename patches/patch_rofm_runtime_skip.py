import pathlib, sys

p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
old = """      if (!ARCHIVABLE_ROLES.has(message.role)) continue
      if (isCheckpointMessage(message)) continue"""
new = """      if (!ARCHIVABLE_ROLES.has(message.role)) continue
      if (isCheckpointMessage(message)) continue
      if (sourceEvent?.data?.source?.kind === 'runtime-context') continue"""
if old not in s:
    print('anchor not found')
    sys.exit(1)
p.write_text(s.replace(old, new, 1), encoding='utf-8')
print('patched')
