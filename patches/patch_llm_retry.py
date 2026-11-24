import io, os, sys
base = "/usr/local/lib/nodejs/node-v22.23.4-linux-x64/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js"
p = sys.argv[1] if len(sys.argv) > 1 else base
s = io.open(p, encoding="utf-8").read()
if "DEFAULT_MAX_RETRIES = 1;" in s:
    print("already 1"); sys.exit(0)
old = "const DEFAULT_MAX_RETRIES = 5;"
if old not in s:
    print("anchor missing"); sys.exit(1)
io.open(p, "w", encoding="utf-8").write(s.replace(old, "const DEFAULT_MAX_RETRIES = 1;", 1))
print("patched", p)