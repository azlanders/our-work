#!/bin/bash
# 把实例的 DSH profile 通用部分同步回模板：package.json / cordis.patch.yml / vendor。
# 用法: 同步dsh.sh <vars.env> [--dry]
set -euo pipefail
ENVF=${1:?用法: 同步dsh.sh <vars.env> [--dry]}
DRY=${2:-}
set -a
. "$ENVF"
set +a
: "${BOT_NAME:?}" "${DSH_ROOT:?}"
TPL="$(cd "$(dirname "$0")" && pwd)"
PW="$DSH_ROOT/profiles/web"
[ -f "$PW/package.json" ] || { echo "找不到 $PW/package.json" >&2; exit 2; }
[ -f "$PW/cordis.patch.yml" ] || { echo "找不到 $PW/cordis.patch.yml" >&2; exit 2; }
[ -d "$PW/vendor" ] || { echo "找不到 $PW/vendor" >&2; exit 2; }

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
TOP="$(cd "$TPL/.." && pwd)"

mkdir -p /root/bak2
STAMP=$(date +%Y%m%d-%H%M%S)
if [ "$DRY" != "--dry" ]; then
  tar czf "/root/bak2/模板-dsh-$BOT_NAME-$STAMP.tar.gz" -C "$TPL" dsh bridge/cordis.patch.yml.tpl 2>/dev/null || true
fi

DRYFLAG=""
[ "$DRY" = "--dry" ] && DRYFLAG=1
python3 - "$PW" "$TPL" "$DRYFLAG" <<'PY'
import os, sys
pw, tpl, dry = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
env = dict(os.environ)
rules = []
def add(v, ph):
    if v: rules.append((v, ph))
for key in ('BOT_ROOT','DSH_ROOT','QQ_HOME','GATEWAY_URL','BOT_BOOK_DIR'):
    add(env.get(key, ''), '{{' + key + '}}')
for key in ('SELF_UIN','OWNER_UIN','HTTP_PORT','WS_PORT','WEB_PORT','PANEL_PORT','GATEWAY_PORT',
            'ALT_BOT_DISPLAY','ALT_BOT_KEY','ALT_PANEL_PORT','ALT_SELF_UIN','GROUP_UIN',
            'BRIDGE_TOKEN','WS_TOKEN','FLEET_TOKEN','SVC_BOT','SVC_PANEL','SVC_GATEWAY',
            'SVC_UPSTREAM','SVC_WATCHDOG','SVC_GPT','PATCH_SCRIPT','PATCH_DIR'):
    add(env.get(key, ''), '{{' + key + '}}')
name = env.get('BOT_NAME', '')
if name:
    add('/data/%s-qq' % name, '{{QQ_HOME}}')
    add('/data/%s-workspace' % name, '{{BOT_ROOT}}')
    add('/data/%s-dsh' % name, '{{DSH_ROOT}}')
rules.sort(key=lambda r: -len(r[0]))
def conv(text):
    for a, b in rules:
        text = text.replace(a, b)
    return text

def sync_text(src, dst):
    data = conv(open(src, encoding='utf-8', errors='replace').read())
    if dry:
        print('would write', dst)
        return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'w', encoding='utf-8').write(data)
    print('wrote', dst)

sync_text(os.path.join(pw, 'package.json'), os.path.join(tpl, 'dsh', 'package.json.tpl'))
sync_text(os.path.join(pw, 'cordis.patch.yml'), os.path.join(tpl, 'bridge', 'cordis.patch.yml.tpl'))
PY

if [ "$DRY" != "--dry" ]; then
  rsync -a --delete \
    --exclude '.bak*' --exclude '*.bak*' \
    --exclude '.old*' --exclude '*.old*' \
    --exclude '.pre*' --exclude '*.pre*' \
    --exclude 'node_modules' --exclude '__pycache__' \
    "$PW/vendor/" "$TPL/dsh/vendor/"
  # VENDOR_CONV 2026-11-24：vendor 原来原样 rsync，实例的 /data/<bot>-workspace、/data/<bot>-dsh
  # 全被写进模板，新 bot 装出来就串到旧 bot 的目录。这里和 package.json 用同一套规则换成占位符。
  python3 - "$TPL/dsh/vendor" <<'PY'
import os, sys
root = sys.argv[1]
env = dict(os.environ)
rules = []
for key in ('BOT_ROOT', 'DSH_ROOT', 'QQ_HOME', 'GATEWAY_URL', 'BOT_BOOK_DIR'):
    v = env.get(key, '')
    if v: rules.append((v, '{{' + key + '}}'))
name = env.get('BOT_NAME', '')
if name:
    rules.append(('/data/%s-qq' % name, '{{QQ_HOME}}'))
    rules.append(('/data/%s-workspace' % name, '{{BOT_ROOT}}'))
    rules.append(('/data/%s-dsh' % name, '{{DSH_ROOT}}'))
rules.sort(key=lambda r: -len(r[0]))
def conv(t):
    for a, b in rules: t = t.replace(a, b)
    return t
n = 0
for dp, dns, fns in os.walk(root):
    dns[:] = [d for d in dns if d not in ('node_modules', '__pycache__')]
    for f in fns:
        if not f.endswith(('.js', '.mjs', '.json', '.yml', '.yaml', '.md')): continue
        p = os.path.join(dp, f)
        try: s = open(p, encoding='utf-8').read()
        except Exception: continue
        t = conv(s)
        if t != s:
            open(p, 'w', encoding='utf-8').write(t)
            n += 1
print('vendor 占位符化', n, '个文件')
PY
  echo "vendor synced -> $TPL/dsh/vendor"
else
  echo "[dry] vendor rsync skipped"
fi
