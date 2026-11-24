#!/bin/bash
# 把模板里的通用文件推到某个实例，替换占位符。用于「改一处，同步所有」。
# 用法: 推给所有实例.sh <vars.env> [--dry]
set -euo pipefail
ENVF=${1:?用法: 推给所有实例.sh <vars.env> [--dry]}
DRY=${2:-}
set -a
. "$ENVF"
set +a
BRIDGE_TOKEN=${BRIDGE_TOKEN:-}
WS_TOKEN=${WS_TOKEN:-}
DSH_ROOT=${DSH_ROOT:-}
: "${BOT_NAME:?}" "${BOT_ROOT:?}"
BOT_NAME_UPPER=$(printf '%s' "$BOT_NAME" | tr 'a-z' 'A-Z' | tr -c 'A-Z0-9' '_')
QQ_HOME=${QQ_HOME:-/data/$BOT_NAME-qq}
GATEWAY_URL=${GATEWAY_URL:-}
 # GATEWAY_PORT_RENDER 2026-11-24: 渲染表漏了 GATEWAY_PORT
GATEWAY_PORT=${GATEWAY_PORT:-}
BOT_BOOK_DIR=${BOT_BOOK_DIR:-}
SVC_BOT=${SVC_BOT:-$BOT_NAME-bot}
SVC_PANEL=${SVC_PANEL:-$BOT_NAME-panel}
SVC_GATEWAY=${SVC_GATEWAY:-$BOT_NAME-gateway}
SVC_UPSTREAM=${SVC_UPSTREAM:-$BOT_NAME-upstream}
SVC_WATCHDOG=${SVC_WATCHDOG:-$BOT_NAME-watchdog}
SVC_GPT=${SVC_GPT:-$BOT_NAME-gptsovits}
PATCH_SCRIPT=${PATCH_SCRIPT:-reapply-patches-$BOT_NAME.sh}
PATCH_DIR=${PATCH_DIR:-$BOT_NAME-patches}
ALT_BOT_DISPLAY=${ALT_BOT_DISPLAY:-二号机}
ALT_BOT_KEY=${ALT_BOT_KEY:-}
ALT_PANEL_PORT=${ALT_PANEL_PORT:-}
ALT_SELF_UIN=${ALT_SELF_UIN:-}
GROUP_UIN=${GROUP_UIN:-}
TPL="$(cd "$(dirname "$0")" && pwd)/workspace"
mkdir -p /root/bak2
STAMP=$(date +%Y%m%d-%H%M%S)
 # BACKUP_SCOPE 2026-11-24: 只备份模板会改写到的范围（根级普通文件 + 共享/工具）。
 # 原来整个 BOT_ROOT 3.2G，dry run 也等几分钟；dry 现在不备份。
if [ "$DRY" != "--dry" ]; then
  ROOTS=()
  while IFS= read -r f; do ROOTS+=("$f"); done < <(cd "$BOT_ROOT" && find . -maxdepth 1 -type f -printf '%P\n')
  tar czf "/root/bak2/实例-$BOT_NAME-$STAMP.tar.gz" -C "$BOT_ROOT" "共享/工具" "${ROOTS[@]}" 2>/dev/null || true
fi

python3 - "$TPL" "$BOT_ROOT" "$BOT_NAME" "$BOT_NAME_UPPER" "$DSH_ROOT" "$QQ_HOME" "$GATEWAY_URL" "$GATEWAY_PORT" "$BOT_BOOK_DIR" "$SELF_UIN" "$OWNER_UIN" "$HTTP_PORT" "$WS_PORT" "$WEB_PORT" "$PANEL_PORT" "$BRIDGE_TOKEN" "$WS_TOKEN" "${ALT_BOT_DISPLAY:-}" "${ALT_SELF_UIN:-}" "${ALT_BOT_KEY:-}" "${ALT_PANEL_PORT:-}" "${GROUP_UIN:-}" "${DRY:-}" "$(cd "$(dirname "$0")" && pwd)" "${SVC_BOT}" "${SVC_PANEL}" "${SVC_GATEWAY}" "${SVC_UPSTREAM}" "${SVC_WATCHDOG}" "${SVC_GPT}" "${PATCH_SCRIPT}" "${PATCH_DIR}" <<'PY'
import json, os, sys
(tpl, base, name, up, dsh, qq, gw, gwport, book, self_uin, owner_uin, http, ws, web, panel,
 btok, wtok, alt, altuin, altkey, altport, groupuin, dry, tplroot, svc_bot, svc_panel, svc_gateway, svc_up, svc_wd, svc_gpt, patch_script, patch_dir) = sys.argv[1:]
m = {'BOT_NAME':name,'BOT_DISPLAY':os.environ.get('BOT_DISPLAY') or name,'BOT_NAME_UPPER':up,'BOT_ROOT':base,'DSH_ROOT':dsh,'QQ_HOME':qq,
     'GATEWAY_URL':gw,'BOT_BOOK_DIR':book,'SELF_UIN':self_uin,'OWNER_UIN':owner_uin,
     'HTTP_PORT':http,'WS_PORT':ws,'WEB_PORT':web,'PANEL_PORT':panel,
     'BRIDGE_TOKEN':btok,'WS_TOKEN':wtok,'ALT_BOT_DISPLAY':alt,'ALT_SELF_UIN':altuin,'ALT_BOT_KEY':altkey,'ALT_PANEL_PORT':altport,'GROUP_UIN':groupuin,
     'SVC_BOT':svc_bot,'SVC_PANEL':svc_panel,'SVC_GATEWAY':svc_gateway,'SVC_UPSTREAM':svc_up,
     'SVC_WATCHDOG':svc_wd,'SVC_GPT':svc_gpt,
     'GATEWAY_PORT':gwport,
     'PATCH_SCRIPT':patch_script,'PATCH_DIR':patch_dir}
cfg = json.load(open(os.path.join(tplroot, '模板清单.json'), encoding='utf-8'))
tool_dir = cfg['通用工具目录']
skip_dirs = set(cfg['排除目录'])
exts = tuple(cfg['通用工具扩展名'])
plain = cfg.get('通用工具文件', [])
init_only = set(cfg.get('仅初始化文件', []))
excl_files = set(cfg.get('模板排除文件', []))
root_files = cfg['通用根文件']

def conv(s):
    for k, v in m.items():
        s = s.replace('{{'+k+'}}', v)
    return s

copied = 0
def put(src, rel):
    global copied
    dst = os.path.join(base, rel)
    if dry == '--dry':
        print('would write', rel); copied += 1; return
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(src, encoding='utf-8', errors='replace') as fh:
        data = conv(fh.read())
    with open(dst, 'w', encoding='utf-8') as fh:
        fh.write(data)
    copied += 1

for n in root_files:
    s = os.path.join(tpl, n)
    if os.path.isfile(s): put(s, n)
for n in plain:
    s = os.path.join(tpl, tool_dir, n)
    if os.path.isfile(s): put(s, os.path.normpath(os.path.join(tool_dir, n)))
for dp, dns, fns in os.walk(os.path.join(tpl, tool_dir)):
    dns[:] = [d for d in dns if d not in skip_dirs]
    rd = os.path.relpath(dp, os.path.join(tpl, tool_dir))
    for fn in fns:
        if not fn.endswith(exts): continue
        if fn in init_only or fn in excl_files: continue
        put(os.path.join(dp, fn), os.path.normpath(os.path.join(tool_dir, rd, fn)))
print(f'template -> {base}: {copied} files{" (dry)" if dry == "--dry" else ""}')
PY
