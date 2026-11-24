#!/bin/bash
# 从模板生成一个新 bot 的 workspace、桥配置、systemd 单元。
# 只写文件，不发任何 QQ 消息，不动现有 bot。
# 用法: 安装新bot.sh <vars.env> [--dry]
set -euo pipefail
env_file=${1:?用法: 安装新bot.sh <vars.env> [--dry|--workspace-only]}
DRY=0
WS_ONLY=0
case "${2:-}" in
  --dry) DRY=1 ;;
  --workspace-only) WS_ONLY=1 ;;
esac
set -a
. "$env_file"
set +a

for v in BOT_NAME BOT_ROOT DSH_ROOT SELF_UIN OWNER_UIN HTTP_PORT WS_PORT WEB_PORT PANEL_PORT BRIDGE_TOKEN WS_TOKEN; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "缺少变量 $v" >&2; exit 1; }
done

BOT_NAME_UPPER=$(printf '%s' "$BOT_NAME" | tr 'a-z' 'A-Z' | tr -c 'A-Z0-9' '_')
QQ_HOME=${QQ_HOME:-/data/$BOT_NAME-qq}
GATEWAY_URL=${GATEWAY_URL:-}
GATEWAY_PORT=${GATEWAY_PORT:-0}
INSTALL_GATEWAY=${INSTALL_GATEWAY:-0}
FLEET_TOKEN=${FLEET_TOKEN:-}
if [ "$INSTALL_GATEWAY" = 1 ] && [ -z "$FLEET_TOKEN" ]; then
  FLEET_TOKEN=$(python3 -c 'import secrets;print(secrets.token_hex(16))')
fi
BOT_BOOK_DIR=${BOT_BOOK_DIR:-}
SVC_BOT=${SVC_BOT:-$BOT_NAME-bot}
SVC_PANEL=${SVC_PANEL:-$BOT_NAME-panel}
SVC_GATEWAY=${SVC_GATEWAY:-$BOT_NAME-gateway}
SVC_UPSTREAM=${SVC_UPSTREAM:-$BOT_NAME-upstream}
SVC_WATCHDOG=${SVC_WATCHDOG:-$BOT_NAME-watchdog}
SVC_GPT=${SVC_GPT:-$BOT_NAME-gptsovits}
PATCH_SCRIPT=${PATCH_SCRIPT:-reapply-patches-$BOT_NAME.sh}
PATCH_DIR=${PATCH_DIR:-$BOT_NAME-patches}
BOT_DISPLAY=${BOT_DISPLAY:-$BOT_NAME}
ALT_BOT_DISPLAY=${ALT_BOT_DISPLAY:-二号机}
ALT_BOT_KEY=${ALT_BOT_KEY:-}
ALT_PANEL_PORT=${ALT_PANEL_PORT:-}
ALT_SELF_UIN=${ALT_SELF_UIN:-}
GROUP_UIN=${GROUP_UIN:-}

TPL="$(cd "$(dirname "$0")" && pwd)"
[ -e "$BOT_ROOT" ] && { echo "$BOT_ROOT 已存在，先确认是不是要覆盖" >&2; exit 1; }
[ -e "$DSH_ROOT" ] && { echo "$DSH_ROOT 已存在，先确认是不是要覆盖" >&2; exit 1; }

subst() {
  sed -e "s|{{BOT_NAME_UPPER}}|$BOT_NAME_UPPER|g" \
      -e "s|{{BOT_NAME}}|$BOT_NAME|g" \
      -e "s|{{BOT_DISPLAY}}|$BOT_DISPLAY|g" \
      -e "s|{{BOT_ROOT}}|$BOT_ROOT|g" \
      -e "s|{{DSH_ROOT}}|$DSH_ROOT|g" \
      -e "s|{{QQ_HOME}}|$QQ_HOME|g" \
      -e "s|{{GATEWAY_URL}}|$GATEWAY_URL|g" \
      -e "s|{{BOT_BOOK_DIR}}|$BOT_BOOK_DIR|g" \
      -e "s|{{ALT_BOT_DISPLAY}}|$ALT_BOT_DISPLAY|g" \
      -e "s|{{ALT_BOT_KEY}}|$ALT_BOT_KEY|g" \
      -e "s|{{ALT_PANEL_PORT}}|$ALT_PANEL_PORT|g" \
      -e "s|{{ALT_SELF_UIN}}|$ALT_SELF_UIN|g" \
      -e "s|{{GROUP_UIN}}|$GROUP_UIN|g" \
      -e "s|{{SELF_UIN}}|$SELF_UIN|g" \
      -e "s|{{OWNER_UIN}}|$OWNER_UIN|g" \
      -e "s|{{HTTP_PORT}}|$HTTP_PORT|g" \
      -e "s|{{WS_PORT}}|$WS_PORT|g" \
      -e "s|{{WEB_PORT}}|$WEB_PORT|g" \
      -e "s|{{PANEL_PORT}}|$PANEL_PORT|g" \
      -e "s|{{GATEWAY_PORT}}|$GATEWAY_PORT|g" \
      -e "s|{{FLEET_TOKEN}}|$FLEET_TOKEN|g" \
      -e "s|{{BRIDGE_TOKEN}}|$BRIDGE_TOKEN|g" \
      -e "s|{{WS_TOKEN}}|$WS_TOKEN|g" \
      -e "s|{{SVC_BOT}}|$SVC_BOT|g" \
      -e "s|{{SVC_PANEL}}|$SVC_PANEL|g" \
      -e "s|{{SVC_GATEWAY}}|$SVC_GATEWAY|g" \
      -e "s|{{SVC_UPSTREAM}}|$SVC_UPSTREAM|g" \
      -e "s|{{SVC_WATCHDOG}}|$SVC_WATCHDOG|g" \
      -e "s|{{SVC_GPT}}|$SVC_GPT|g" \
      -e "s|{{PATCH_SCRIPT}}|$PATCH_SCRIPT|g" \
      -e "s|{{PATCH_DIR}}|$PATCH_DIR|g" "$1"
}

echo "1/5 建 workspace 骨架"
if [ "$DRY" = 1 ]; then
  echo "   [dry] $BOT_ROOT <- $TPL/workspace"
else
  mkdir -p "$BOT_ROOT"
  tar -C "$TPL/workspace" -cf - . | tar -C "$BOT_ROOT" -xf - 2>/dev/null || true
  mkdir -p "$BOT_ROOT"/{记忆,写日记,日记,群聊日志,表情库,收到的图片,收到的文件,屏幕,下载,logs} 2>/dev/null || true
  python3 - "$BOT_ROOT" <<PY
import os, sys
root = sys.argv[1]
vals = {
 'BOT_NAME': '''$BOT_NAME''', 'BOT_DISPLAY': '''$BOT_DISPLAY''', 'BOT_NAME_UPPER': '''$BOT_NAME_UPPER''',
 'BOT_ROOT': '''$BOT_ROOT''', 'DSH_ROOT': '''$DSH_ROOT''', 'QQ_HOME': '''$QQ_HOME''',
 'GATEWAY_URL': '''$GATEWAY_URL''', 'BOT_BOOK_DIR': '''$BOT_BOOK_DIR''',
 'ALT_BOT_DISPLAY': '''$ALT_BOT_DISPLAY''', 'ALT_BOT_KEY': '''$ALT_BOT_KEY''', 'ALT_PANEL_PORT': '''$ALT_PANEL_PORT''',
 'ALT_SELF_UIN': '''$ALT_SELF_UIN''', 'GROUP_UIN': '''$GROUP_UIN''',
 'SELF_UIN': '''$SELF_UIN''', 'OWNER_UIN': '''$OWNER_UIN''',
 'HTTP_PORT': '''$HTTP_PORT''', 'WS_PORT': '''$WS_PORT''',
 'WEB_PORT': '''$WEB_PORT''', 'PANEL_PORT': '''$PANEL_PORT''',
 'GATEWAY_PORT': '''$GATEWAY_PORT''', 'FLEET_TOKEN': '''$FLEET_TOKEN''',
 'BRIDGE_TOKEN': '''$BRIDGE_TOKEN''', 'WS_TOKEN': '''$WS_TOKEN''',
 'SVC_BOT': '''$SVC_BOT''', 'SVC_PANEL': '''$SVC_PANEL''', 'SVC_GATEWAY': '''$SVC_GATEWAY''',
 'SVC_UPSTREAM': '''$SVC_UPSTREAM''', 'SVC_WATCHDOG': '''$SVC_WATCHDOG''', 'SVC_GPT': '''$SVC_GPT''',
 'PATCH_SCRIPT': '''$PATCH_SCRIPT''', 'PATCH_DIR': '''$PATCH_DIR''',
}
exts = {'.md','.mjs','.js','.html','.json','.sh','.py','.tpl','.txt','.yml','.yaml','.css'}
skip = {'node_modules','_归档','备份','临时','.git'}
left = []
for dp, dns, fns in os.walk(root):
    dns[:] = [d for d in dns if d not in skip]
    for fn in fns:
        if os.path.splitext(fn)[1].lower() not in exts: continue
        fp = os.path.join(dp, fn)
        try: s = open(fp, encoding='utf-8').read()
        except Exception: continue
        if '{{' not in s: continue
        for k, v in vals.items(): s = s.replace('{{'+k+'}}', v)
        open(fp, 'w', encoding='utf-8').write(s)
        for k in vals:
            if '{{'+k+'}}' in s:
                left.append(fp + ':' + k); break
if left:
    print('   还有没替换的占位符:', *left[:10], sep='\n   ')
PY
fi

if [ "$WS_ONLY" = 0 ]; then
echo "2/5 建 DSH 数据目录"
if [ "$DRY" = 1 ]; then
  echo "   [dry] $DSH_ROOT/qq-bridge.config.json"
  echo "   [dry] $DSH_ROOT/profiles/web/{vendor,package.json,cordis.patch.yml}"
else
  mkdir -p "$DSH_ROOT"
  subst "$TPL/bridge/qq-bridge.config.json.tpl" > "$DSH_ROOT/qq-bridge.config.json"
  chmod 600 "$DSH_ROOT/qq-bridge.config.json"
  mkdir -p "$DSH_ROOT/profiles/web"
  cp -a "$TPL/dsh/vendor" "$DSH_ROOT/profiles/web/vendor"
  subst "$TPL/dsh/package.json.tpl" > "$DSH_ROOT/profiles/web/package.json"
  subst "$TPL/bridge/cordis.patch.yml.tpl" > "$DSH_ROOT/profiles/web/cordis.patch.yml"
fi

echo "3/5 写 SnowLuma onebot 配置"
SL_CFG=/opt/snowluma/config
if [ "$DRY" = 1 ]; then
  echo "   [dry] $SL_CFG/onebot_$SELF_UIN.json"
elif [ -d "$SL_CFG" ]; then
  subst "$TPL/bridge/onebot.json.tpl" > "$SL_CFG/onebot_$SELF_UIN.json"
  echo "   $SL_CFG/onebot_$SELF_UIN.json"
else
  echo "   跳过：$SL_CFG 不存在" >&2
fi

echo "4/5 写 systemd 单元"
if [ "$DRY" = 1 ]; then
  echo "   [dry] /etc/systemd/system/$BOT_NAME-bot.service"
  echo "   [dry] /etc/systemd/system/$SVC_PANEL.service"
  [ "$INSTALL_GATEWAY" = 1 ] && echo "   [dry] /etc/systemd/system/$SVC_GATEWAY.service"
  echo "   [dry] /etc/$BOT_NAME""bot.env"
  echo "   [dry] /root/运维服务/$BOT_NAME-watchdog.sh"
else
  subst "$TPL/bridge/dsh-bot.service.tpl" > "/etc/systemd/system/$BOT_NAME-bot.service"
  subst "$TPL/bridge/panel.service.tpl" > "/etc/systemd/system/$SVC_PANEL.service"
  if [ "$INSTALL_GATEWAY" = 1 ]; then
    subst "$TPL/bridge/gateway.service.tpl" > "/etc/systemd/system/$SVC_GATEWAY.service"
  fi
  subst "$TPL/bridge/dshbot.env.tpl" > "/etc/$BOT_NAME""bot.env"
  chmod 600 "/etc/$BOT_NAME""bot.env"
  if [ -d /root/运维服务 ]; then
    subst "$TPL/bridge/watchdog.sh.tpl" > "/root/运维服务/$BOT_NAME-watchdog.sh"
    chmod +x "/root/运维服务/$BOT_NAME-watchdog.sh"
  fi
fi

fi

if [ "$WS_ONLY" = 0 ] && [ "$DRY" = 0 ]; then
  echo "4.5/5 安装 DSH 插件依赖（pnpm，首次要联网，几分钟）"
  if ! (cd "$DSH_ROOT/profiles/web" && pnpm install --silent); then
    echo "   pnpm install 失败，手动：cd $DSH_ROOT/profiles/web && pnpm install" >&2
  fi
fi

echo "5/5 完成，后续手工步骤："
cat <<EOF

1. QQ 进程：给 $BOT_NAME 准备独立 QQ 安装目录（$QQ_HOME），独立 Xvfb 显示号，
   不要让两个 QQ 进程共用同一个 user data 目录。
2. 扫码登录：拉起 QQ 后看 Xvfb 画面；登录失效时 qq-login-click 会按显示号找窗口点登录。
3. 起服务：systemctl daemon-reload && systemctl enable --now $BOT_NAME-bot $SVC_PANEL
   （要接多模型网关再加 $SVC_GATEWAY；没有网关时面板的「模型接口」页会自己显示未接，不会去读别家的）
4. 验证：curl -s -X POST http://127.0.0.1:$HTTP_PORT/get_login_info \
        -H 'Authorization: Bearer $BRIDGE_TOKEN' -H 'Content-Type: application/json' -d '{}'
5. 看门狗：把 $BOT_NAME-watchdog.sh 加一个 1 分钟的 timer（参考 dshbot-watchdog.timer）。
6. 模板里没有的东西（SOUL.md、记忆初值）要按这个 bot 自己写；人设只写 SOUL.md，cordis 不再写 personaPrefix。
EOF
