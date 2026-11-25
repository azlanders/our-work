#!/bin/bash
# 从模板生成一个新 bot 的 workspace、桥配置、systemd 单元。
# 只写文件，不发任何 QQ 消息，不动现有 bot。
# 用法: 安装新bot.sh <vars.env> [--dry] [--workspace-only]
set -euo pipefail
env_file=${1:?用法: 安装新bot.sh <vars.env> [--dry] [--workspace-only]}
[ -f "$env_file" ] || { echo "找不到 $env_file" >&2; exit 2; }

DRY=0
WS_ONLY=0
for arg in "${@:2}"; do
  case "$arg" in
    --dry|--dry-run) DRY=1 ;;
    --workspace-only|--ws-only) WS_ONLY=1 ;;
    *) echo "未知参数: $arg（支持 --dry / --workspace-only）" >&2; exit 2 ;;
  esac
done

TPL="$(cd "$(dirname "$0")" && pwd)"
eval "$(python3 "$TPL/scripts/tpl_engine.py" export-shell --env "$env_file" --strict-env)"

BOT_NAME_UPPER=$(printf '%s' "$BOT_NAME" | tr 'a-z' 'A-Z' | tr -c 'A-Z0-9' '_')
BOT_DISPLAY=${BOT_DISPLAY:-$BOT_NAME}
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
ALT_BOT_DISPLAY=${ALT_BOT_DISPLAY:-二号机}
ALT_BOT_KEY=${ALT_BOT_KEY:-}
ALT_PANEL_PORT=${ALT_PANEL_PORT:-}
ALT_SELF_UIN=${ALT_SELF_UIN:-}
GROUP_UIN=${GROUP_UIN:-}
WATCHDOG_DIR=${WATCHDOG_DIR:-/root/运维服务}

export BOT_NAME BOT_DISPLAY BOT_NAME_UPPER BOT_ROOT DSH_ROOT QQ_HOME GATEWAY_URL BOT_BOOK_DIR
export ALT_BOT_DISPLAY ALT_BOT_KEY ALT_PANEL_PORT ALT_SELF_UIN GROUP_UIN
export SELF_UIN OWNER_UIN HTTP_PORT WS_PORT WEB_PORT PANEL_PORT GATEWAY_PORT INSTALL_GATEWAY
export FLEET_TOKEN BRIDGE_TOKEN WS_TOKEN
export SVC_BOT SVC_PANEL SVC_GATEWAY SVC_UPSTREAM SVC_WATCHDOG SVC_GPT PATCH_SCRIPT PATCH_DIR

if [ "$DRY" = 0 ]; then
  [ -e "$BOT_ROOT" ] && { echo "$BOT_ROOT 已存在，先确认是不是要覆盖" >&2; exit 1; }
  if [ "$WS_ONLY" = 0 ]; then
    [ -e "$DSH_ROOT" ] && { echo "$DSH_ROOT 已存在，先确认是不是要覆盖" >&2; exit 1; }
  fi
fi

render_to() {
  local src="$1" dst="$2" mode="${3:-}"
  local args=(--src "$src" --dst "$dst" --check)
  [ -n "$mode" ] && args+=(--chmod "$mode")
  python3 "$TPL/scripts/tpl_engine.py" render-file "${args[@]}"
}

echo "1/5 建 workspace 骨架"
if [ "$DRY" = 1 ]; then
  echo "  [dry] $BOT_ROOT <- $TPL/workspace"
else
  mkdir -p "$BOT_ROOT"
  tar -C "$TPL/workspace" -cf - . | tar -C "$BOT_ROOT" -xf -
  mkdir -p "$BOT_ROOT"/{记忆,写日记,日记,群聊日志,表情库,收到的图片,收到的文件,屏幕,下载,logs}
  python3 "$TPL/scripts/tpl_engine.py" render-dir --root "$BOT_ROOT" --check
fi

if [ "$WS_ONLY" = 0 ]; then
  echo "2/5 建 DSH 数据目录"
  if [ "$DRY" = 1 ]; then
    echo "  [dry] $DSH_ROOT/qq-bridge.config.json"
    echo "  [dry] $DSH_ROOT/profiles/web/{vendor,package.json,cordis.patch.yml}"
  else
    mkdir -p "$DSH_ROOT/profiles/web/vendor"
    render_to "$TPL/bridge/qq-bridge.config.json.tpl" "$DSH_ROOT/qq-bridge.config.json" 600
    cp -a "$TPL/dsh/vendor/." "$DSH_ROOT/profiles/web/vendor/"
    python3 "$TPL/scripts/tpl_engine.py" render-dir --root "$DSH_ROOT/profiles/web/vendor" --all-text --skip-empty --check
    render_to "$TPL/dsh/package.json.tpl" "$DSH_ROOT/profiles/web/package.json"
    render_to "$TPL/bridge/cordis.patch.yml.tpl" "$DSH_ROOT/profiles/web/cordis.patch.yml"
  fi

  echo "3/5 写 SnowLuma onebot 配置"
  SL_CFG=${SL_CFG:-/opt/snowluma/config}
  if [ "$DRY" = 1 ]; then
    echo "  [dry] $SL_CFG/onebot_$SELF_UIN.json"
  elif [ -d "$SL_CFG" ]; then
    render_to "$TPL/bridge/onebot.json.tpl" "$SL_CFG/onebot_$SELF_UIN.json"
  else
    echo "  跳过：$SL_CFG 不存在" >&2
  fi

  echo "4/5 写 systemd 单元"
  if [ "$DRY" = 1 ]; then
    echo "  [dry] /etc/systemd/system/$SVC_BOT.service"
    echo "  [dry] /etc/systemd/system/$SVC_PANEL.service"
    [ "$INSTALL_GATEWAY" = 1 ] && echo "  [dry] /etc/systemd/system/$SVC_GATEWAY.service"
    echo "  [dry] /etc/${BOT_NAME}bot.env"
    echo "  [dry] $WATCHDOG_DIR/$SVC_WATCHDOG.sh"
  else
    render_to "$TPL/bridge/dsh-bot.service.tpl" "/etc/systemd/system/$SVC_BOT.service"
    render_to "$TPL/bridge/panel.service.tpl" "/etc/systemd/system/$SVC_PANEL.service"
    if [ "$INSTALL_GATEWAY" = 1 ]; then
      render_to "$TPL/bridge/gateway.service.tpl" "/etc/systemd/system/$SVC_GATEWAY.service"
    fi
    render_to "$TPL/bridge/dshbot.env.tpl" "/etc/${BOT_NAME}bot.env" 600
    if [ -d "$WATCHDOG_DIR" ]; then
      render_to "$TPL/bridge/watchdog.sh.tpl" "$WATCHDOG_DIR/$SVC_WATCHDOG.sh" 755
    fi
  fi
fi

if [ "$WS_ONLY" = 0 ] && [ "$DRY" = 0 ]; then
  echo "4.5/5 安装 DSH 插件依赖（pnpm，首次要联网，几分钟）"
  if ! (cd "$DSH_ROOT/profiles/web" && pnpm install --silent); then
    echo "  pnpm install 失败，手动：cd $DSH_ROOT/profiles/web && pnpm install" >&2
  fi
fi

echo "5/5 完成，后续手工步骤："
cat <<EOF

1. QQ 进程：给 $BOT_NAME 准备独立 QQ 安装目录（$QQ_HOME），独立 Xvfb 显示号，
   不要让两个 QQ 进程共用同一个 user data 目录。
2. 扫码登录：拉起 QQ 后看 Xvfb 画面；登录失效时 qq-login-click 会按显示号找窗口点登录。
3. 起服务：systemctl daemon-reload && systemctl enable --now $SVC_BOT $SVC_PANEL
   （要接多模型网关再加 $SVC_GATEWAY；没有网关时面板的「模型接口」页会自己显示未接，不会去读别家的）
4. 验证：curl -s -X POST http://127.0.0.1:$HTTP_PORT/get_login_info \\
          -H 'Authorization: Bearer $BRIDGE_TOKEN' -H 'Content-Type: application/json' -d '{}'
5. 看门狗：把 $SVC_WATCHDOG.sh 加一个 1 分钟的 timer（参考 dshbot-watchdog.timer）。
6. 模板里没有的东西（SOUL.md、记忆初值）要按这个 bot 自己写；人设只写 SOUL.md，cordis 不再写 personaPrefix。
EOF
