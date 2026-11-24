#!/bin/bash
# 从现有实例把「通用文件」同步回模板，并把实例路径/服务名换成占位符。
# 用法: 同步模板.sh <实例 workspace> [--vars <实例 env>] [--name <短名>] [--dry]
set -euo pipefail
BASE=${1:-/data/bot-workspace}
shift || true
NAME=""
VARS=""
EXTRA=""
DRY=""
NEWER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --name) NAME=${2:-}; shift 2 ;;
    --vars) VARS=${2:-}; shift 2 ;;
    --dry) DRY=1; shift ;;
    --newer|--force) NEWER=1; shift ;;
    *) echo "未知参数 $1" >&2; exit 2 ;;
  esac
done
if [ -n "$VARS" ]; then
  set -a; . "$VARS"; set +a
  NAME=${NAME:-${BOT_NAME:-}}
  EXTRA=${EXTRA_SUBS:-}
PATCH_SCRIPT=${PATCH_SCRIPT:-reapply-patches-${BOT_NAME:-bot}.sh}
PATCH_DIR=${PATCH_DIR:-${BOT_NAME:-bot}-patches}
fi
[ -n "$NAME" ] || { echo "必须用 --name 或 --vars 指定实例短名，否则服务名不会还原成占位符" >&2; exit 2; }
TPL="$(cd "$(dirname "$0")" && pwd)/workspace"
HERE="$(cd "$(dirname "$0")" && pwd)"

python3 - "$BASE" "$TPL" "$NAME" "${DRY:-}" "$EXTRA" "${NEWER:-}" "${SELF_UIN:-}" "${OWNER_UIN:-}" "${ALT_SELF_UIN:-}" "${GROUP_UIN:-}" "${SVC_BOT:-}" "${SVC_PANEL:-}" "${SVC_GATEWAY:-}" "${SVC_UPSTREAM:-}" "${SVC_WATCHDOG:-}" "${SVC_GPT:-}" "${PATCH_SCRIPT:-}" "${PATCH_DIR:-}" <<'PY'
import json, os, sys, re

base, tpl, name, dry, extra, newer = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == '1', sys.argv[5], sys.argv[6] == '1'
self_uin, owner_uin, alt_uin, group_uin = (sys.argv[7:11] + ['']*4)[:4]
SVC_BOT, SVC_PANEL, SVC_GATEWAY, SVC_UPSTREAM, SVC_WATCHDOG, SVC_GPT, PATCH_SCRIPT, PATCH_DIR = (sys.argv[11:19] + ['']*8)[:8]
root = os.path.dirname(os.path.abspath(tpl))
cfg = json.load(open(os.path.join(root, '模板清单.json'), encoding='utf-8'))

exts = tuple(cfg['通用工具扩展名'])
plain_files = cfg.get('通用工具文件', [])
init_files = set(cfg.get('仅初始化文件', []))
excl_files = set(cfg.get('模板排除文件', []))
tool_dir = cfg['通用工具目录']
skip_dirs = set(cfg['排除目录'])
root_files = cfg['通用根文件']
repl = list(cfg['路径替换'])

up = ''.join(c if c.isalnum() else '_' for c in name.upper())
name_rules = [
    ('/data/%s-qq' % name, '{{QQ_HOME}}'),
    ('/data/%s-workspace' % name, '{{BOT_ROOT}}'),
    ('/data/%s-dsh' % name, '{{DSH_ROOT}}'),
    ('/root/%s-patches' % name, '/root/{{BOT_NAME}}-patches'),
    ('reapply-patches-%s.sh' % name, 'reapply-patches-{{BOT_NAME}}.sh'),
    ('napcat-%s' % name, 'napcat-{{BOT_NAME}}'),
    ('onebot-proxy-%s' % name, 'onebot-proxy-{{BOT_NAME}}'),
    ('%s-fleet.json' % name, '{{BOT_NAME}}-fleet.json'),
    ('%s-heartbeat' % name, '{{BOT_NAME}}-heartbeat'),
    ('%s-upstream' % name, '{{BOT_NAME}}-upstream'),
    ('%s-gateway' % name, '{{BOT_NAME}}-gateway'),
    ('%s-panel' % name, '{{BOT_NAME}}-panel'),
    ('%s-bot' % name, '{{BOT_NAME}}-bot'),
    (up + '_FLEET_CONFIG', '{{BOT_NAME_UPPER}}_FLEET_CONFIG'),
]
uin_rules = []
for v, ph in ((alt_uin,'{{ALT_SELF_UIN}}'), (group_uin,'{{GROUP_UIN}}'), (owner_uin,'{{OWNER_UIN}}'), (self_uin,'{{SELF_UIN}}')):
    if v: uin_rules.append((v, ph))
svc_rules = []
for v, ph in ((SVC_BOT,'{{SVC_BOT}}'), (SVC_PANEL,'{{SVC_PANEL}}'), (SVC_GATEWAY,'{{SVC_GATEWAY}}'), (SVC_UPSTREAM,'{{SVC_UPSTREAM}}'), (SVC_WATCHDOG,'{{SVC_WATCHDOG}}'), (SVC_GPT,'{{SVC_GPT}}'), (PATCH_SCRIPT,'{{PATCH_SCRIPT}}'), (PATCH_DIR,'{{PATCH_DIR}}')):
    if v: svc_rules.append((v, ph))
repl = uin_rules + svc_rules + name_rules + repl
if extra:
    for pair in extra.split(';'):
        if not pair.strip():
            continue
        a, b = pair.split('>', 1)
        repl.insert(0, {'from': a.strip(), 'to': b.strip()})

def conv(text):
    for rule in repl:
        a, b = (rule if isinstance(rule, tuple) else (rule['from'], rule['to']))
        text = text.replace(a, b)
    return re.sub(r"process\.env\.(\{\{[A-Z_]+\}\}[A-Za-z0-9_]*)", r"process.env['\1']", text)

copied = 0

skipped = 0
conflicts = []

def _load_clean():
    import ast, os
    cp = os.path.join(os.path.dirname(tpl), 'clean-persona.py')
    if not os.path.isfile(cp):
        return [], []
    tree = ast.parse(open(cp, encoding='utf-8').read())
    vals = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and getattr(node.targets[0], 'id', '') in ('TOKENS', 'SENTENCES'):
            try:
                vals[node.targets[0].id] = ast.literal_eval(node.value)
            except Exception:
                pass
    return vals.get('TOKENS', []), vals.get('SENTENCES', [])

_C_TOKENS, _C_SENT = _load_clean()

def norm(t):
    for a, b in _C_SENT:
        t = t.replace(a, b)
    for a, b in _C_TOKENS:
        t = t.replace(a, b)
    for a, b in _C_SENT:
        t = t.replace(a, b)
    return t

def write(src, rel):
    global copied, skipped
    dst = os.path.join(tpl, rel)
    if not newer and os.path.isfile(dst):
        try:
            old = open(dst, encoding='utf-8', errors='replace').read()
            new = conv(open(src, encoding='utf-8', errors='replace').read())
        except Exception:
            old, new = None, None
        if old is not None and norm(old) != norm(new):
            conflicts.append(rel)
            return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    if dry:
        print('would copy', rel)
    else:
        with open(src, encoding='utf-8', errors='replace') as fh:
            data = conv(fh.read())
        with open(dst, 'w', encoding='utf-8') as fh:
            fh.write(data)
    copied += 1

for n in root_files:
    src = os.path.join(base, n)
    if os.path.isfile(src):
        write(src, n)

src_tools = os.path.join(base, tool_dir)
for fn in plain_files:
    src = os.path.join(src_tools, fn)
    if os.path.isfile(src):
        write(src, os.path.normpath(os.path.join(tool_dir, fn)))

for dirpath, dirnames, filenames in os.walk(src_tools):
    dirnames[:] = [d for d in dirnames if d not in skip_dirs]
    rel_dir = os.path.relpath(dirpath, src_tools)
    for fn in filenames:
        if not fn.endswith(exts):
            continue
        if fn in init_files or fn in excl_files:
            continue
        write(os.path.join(dirpath, fn), os.path.normpath(os.path.join(tool_dir, rel_dir, fn)))

print(f'{base} -> {tpl}: {copied} files{" (dry)" if dry else ""}')
if conflicts:
    print(f'冲突 {len(conflicts)} 个（加 --force 用实例版本覆盖模板）:')
    for c in conflicts[:40]:
        print('  ', c)
PY

if [ -z "${DRY:-}" ]; then
  python3 "$HERE/clean-persona.py" "$TPL"
fi
