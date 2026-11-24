import pathlib, re, sys

root = pathlib.Path(sys.argv[1])
prefix = sys.argv[2]

for p in sorted(root.glob("*.js")) + sorted(root.glob("*.mjs")):
    s = p.read_text(encoding="utf-8")
    orig = s
    s = s.replace(
        "const QQ_WS = process.env.QQ_WORKSPACE || `${QQ_WS}`",
        f"const QQ_WS = process.env.QQ_WORKSPACE || '{prefix}'",
    )
    s = re.sub(
        r"import\s+\{([^}]+)\}\s+from\s+`\$\{QQ_WS\}([^`]*)`",
        r"const {\1} = await import(`${QQ_WS}\2`)",
        s,
    )
    if s != orig:
        p.write_text(s, encoding="utf-8")
        print("fixed", p.name)
