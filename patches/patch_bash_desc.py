import pathlib, re, sys

p = pathlib.Path(sys.argv[1])
s = p.read_text(encoding='utf-8')
old_re = re.compile(r"return `Execute a bash command.*?do not retry another way\.`;", re.S)
new = ("return `Execute a bash command ('bash -c') and return stdout/stderr. Each call runs in a fresh shell; "
       "pass 'workdir' instead of using 'cd'. Long output is truncated to its tail. Provide 'description' before "
       "'command'. Before any delete or move, verify the resolved absolute target path. Commands may run under "
       "a file sandbox; a policy denial must not be retried another way.`;")
if not old_re.search(s):
    print('anchor not found')
    sys.exit(1)
p.write_text(old_re.sub(new, s, count=1), encoding='utf-8')
print('bash description shortened')
