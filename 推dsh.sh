#!/bin/bash
# 把模板里的 DSH profile 推到实例：package.json / cordis.patch.yml / vendor。
# 用法: 推dsh.sh <vars.env> [--dry]
set -euo pipefail
ENVF=${1:?用法: 推dsh.sh <vars.env> [--dry]}
DRY=${2:-}
set -a
. "$ENVF"
set +a
: "${BOT_NAME:?}" "${DSH_ROOT:?}"
TPL="$(cd "$(dirname "$0")" && pwd)"
PW="$DSH_ROOT/profiles/web"
mkdir -p "$PW"

BOT_ROOT=${BOT_ROOT:-}
QQ_HOME=${QQ_HOME:-/data/$BOT_NAME-qq}
GATEWAY_URL=${GATEWAY_URL:-}
BOT_BOOK_DIR=${BOT_BOOK_DIR:-}
SVC_BOT=${SVC_BOT:-$BOT_NAME-bot}
SVC_PANEL=${SVC_PANEL:-$BOT_NAME-panel}
SVC_GATEWAY=${SVC_GATEWAY:-$BOT_NAME-gateway}
SVC_UPSTREAM=${SVC_UPSTREAM:-$BOT_NAME-upstream}
SVC_WATCHDOG=${SVC_WATCHDOG:-$BOT_NAME-watchdog}
SVC_GPT=${SVC_GPT:-$BOT_NAME-gptsovits}
PATCH_SCRIPT=${PATCH_SCRIPT:-reapply-patches-$BOT_NAME.sh}
PATCH_DIR=${PATCH_DIR:-$BOT_NAME-patches}
export BOT_NAME BOT_ROOT DSH_ROOT QQ_HOME GATEWAY_URL BOT_BOOK_DIR SVC_BOT SVC_PANEL SVC_GATEWAY SVC_UPSTREAM SVC_WATCHDOG SVC_GPT PATCH_SCRIPT PATCH_DIR
export SELF_UIN OWNER_UIN HTTP_PORT WS_PORT WEB_PORT PANEL_PORT GATEWAY_PORT
export ALT_BOT_DISPLAY ALT_BOT_KEY ALT_PANEL_PORT ALT_SELF_UIN GROUP_UIN BRIDGE_TOKEN WS_TOKEN
export FLEET_TOKEN

mkdir -p /root/bak2
STAMP=$(date +%Y%m%d-%H%M%S)
if [ "$DRY" != "--dry" ] && [ -d "$PW" ]; then
  tar czf "/root/bak2/dsh-$BOT_NAME-$STAMP.tar.gz" -C "$PW" package.json cordis.patch.yml vendor 2>/dev/null || true
fi

DRYFLAG=""
[ "$DRY" = "--dry" ] && DRYFLAG=1
python3 - "$PW" "$TPL" "$DRYFLAG" <<'PY'
import os, sys
pw, tpl, dry = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
env = dict(os.environ)
m = {k: env.get(k, '') for k in (
    'BOT_NAME','BOT_ROOT','DSH_ROOT','QQ_HOME','GATEWAY_URL','BOT_BOOK_DIR',
    'SELF_UIN','OWNER_UIN','HTTP_PORT','WS_PORT','WEB_PORT','PANEL_PORT',
    'BRIDGE_TOKEN','WS_TOKEN','ALT_BOT_DISPLAY','ALT_SELF_UIN','ALT_BOT_KEY',
    'ALT_PANEL_PORT','GROUP_UIN','SVC_BOT','SVC_PANEL','SVC_GATEWAY',
    'SVC_UPSTREAM','SVC_WATCHDOG','SVC_GPT','GATEWAY_PORT','FLEET_TOKEN',
    'PATCH_SCRIPT','PATCH_DIR')}
m['BOT_NAME_UPPER'] = ''.join(c if c.isalnum() else '_' for c in env.get('BOT_NAME', '').upper())
m['BOT_DISPLAY'] = env.get('BOT_DISPLAY') or env.get('BOT_NAME', '')

def render(text):
    for k in sorted(m, key=len, reverse=True):
        text = text.replace('{{' + k + '}}', m[k])
    return text

def put(src, dst):
    data = render(open(src, encoding='utf-8', errors='replace').read())
    if dry:
        print('would write', dst); return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'w', encoding='utf-8').write(data)
    print('wrote', dst)

put(os.path.join(tpl, 'dsh', 'package.json.tpl'), os.path.join(pw, 'package.json'))
put(os.path.join(tpl, 'bridge', 'cordis.patch.yml.tpl'), os.path.join(pw, 'cordis.patch.yml'))
PY

if [ "$DRY" != "--dry" ]; then
  rsync -a --delete \
    --exclude 'node_modules' --exclude '__pycache__' \
    "$TPL/dsh/vendor/" "$PW/vendor/"
  # VENDOR_RENDER_2026-11-24：同步dsh.sh 把 vendor 里的实例路径占位符化了，
  # 推回去只做 rsync 会把 {{BOT_ROOT}} 原样送到实例，静态 import 直接炸。
  # 推完按同样映射还原一遍；还有剩下的占位符就报错，别让坏 vendor 静默上线。
  python3 - "$PW/vendor" <<'PY'
import os, re, sys
root = sys.argv[1]
keys = ['BOT_NAME','BOT_ROOT','DSH_ROOT','QQ_HOME','GATEWAY_URL','BOT_BOOK_DIR',
        'SELF_UIN','OWNER_UIN','HTTP_PORT','WS_PORT','WEB_PORT','PANEL_PORT',
        'GATEWAY_PORT','ALT_BOT_DISPLAY','ALT_BOT_KEY','ALT_PANEL_PORT','ALT_SELF_UIN',
        'GROUP_UIN','BRIDGE_TOKEN','WS_TOKEN','FLEET_TOKEN','SVC_BOT','SVC_PANEL',
        'SVC_GATEWAY','SVC_UPSTREAM','SVC_WATCHDOG','SVC_GPT','PATCH_SCRIPT','PATCH_DIR']
m = {k: os.environ.get(k, '') for k in keys}
name = os.environ.get('BOT_NAME', '')
m['BOT_NAME_UPPER'] = ''.join(c if c.isalnum() else '_' for c in name.upper())
m['BOT_DISPLAY'] = os.environ.get('BOT_DISPLAY') or name
n = 0
dirty = []
for dirpath, _, files in os.walk(root):
    for f in files:
        p = os.path.join(dirpath, f)
        try:
            with open(p, 'rb') as fh:
                data = fh.read()
        except OSError:
            continue
        if b'\0' in data[:4096]:
            continue
        try:
            text = data.decode('utf-8')
        except UnicodeDecodeError:
            continue
        new = text
        for k in sorted(m, key=len, reverse=True):
            if m[k]:
                new = new.replace('{{' + k + '}}', m[k])
        if new != text:
            with open(p, 'w', encoding='utf-8') as fh:
                fh.write(new)
            n += 1
        if re.search(r'\{\{[A-Z_]+\}\}', new):
            dirty.append(p)
print(f'vendor rendered {n} files')
if dirty:
    print('vendor 里还有没渲染的占位符:', *dirty[:5], sep='\n  ')
    sys.exit(3)
PY
  echo "vendor synced -> $PW/vendor"
else
  echo "[dry] vendor rsync skipped"
fi
