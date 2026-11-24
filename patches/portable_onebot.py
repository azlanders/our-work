import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
inst = sys.argv[2]
dry = "--apply" not in sys.argv
prefix = f"/data/{inst}-workspace"

files = []
statics = []
for p in sorted(root.glob("*.js")) + sorted(root.glob("*.mjs")):
    s = p.read_text(encoding="utf-8", errors="replace")
    if prefix not in s:
        continue
    files.append(p)
    for m in re.finditer(r"^\s*(?:import|export)\b[^\n]*?['\"]" + re.escape(prefix), s, re.M):
        statics.append((p.name, m.group(0).strip()))

print(f"files={len(files)} statics={len(statics)}")
for name, line in statics:
    print("  STATIC", name, line[:120])

if dry:
    for p in files:
        n = p.read_text(encoding="utf-8").count(prefix)
        print(f"  {p.name}: {n}")
    sys.exit(0)

for p in files:
    s = p.read_text(encoding="utf-8")
    if "const QQ_WS =" not in s:
        # 放在第一个 import 行之后；没有 import 就放文件最前
        m = re.search(r"^(?:import|export)\b[^\n]*\n", s, re.M)
        decl = f"const QQ_WS = process.env.QQ_WORKSPACE || '{prefix}'\n"
        if m:
            s = s[: m.end()] + decl + s[m.end():]
        else:
            s = decl + s
    # file:///data/... 先处理，避免普通字符串替换漏掉
    s = s.replace(f"file://{prefix}", "file://${QQ_WS}")
    # 普通字符串 / 双引号字符串 / 模板字符串统一换成模板字符串
    s = re.sub(r"'/data/" + re.escape(inst) + r"-workspace([^']*)'", r"`${QQ_WS}\1`", s)
    s = re.sub(r'"/data/' + re.escape(inst) + r'-workspace([^"]*)"', r"`${QQ_WS}\1`", s)
    s = s.replace(f"`/data/{inst}-workspace", "`${QQ_WS}")
    p.write_text(s, encoding="utf-8")
    print("patched", p.name)
