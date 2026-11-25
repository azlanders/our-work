#!/bin/bash
# {{BOT_NAME}} 看门狗：回合卡住 / 上下文掉线 / WS 断线才重启 {{SVC_BOT}}。
# 协议端（{{SVC_UPSTREAM}}）健康失败只重启协议端，且 30 分钟内最多一次；不连带重启 bot。
set -uo pipefail
LOG={{DSH_ROOT}}/qq-bridge-load.log
STAMP=/run/{{SVC_WATCHDOG}}.last
UPSTREAM_STAMP=/run/{{SVC_WATCHDOG}}-upstream.last
BOT={{SVC_BOT}}
UPSTREAM_SVC={{SVC_UPSTREAM}}
[ -n "$UPSTREAM_SVC" ] || UPSTREAM_SVC=snowluma
TOKEN={{BRIDGE_TOKEN}}

systemctl is-active --quiet "$BOT" || exit 0
[ -f "$LOG" ] || exit 0

read_int() {
  local v
  v=$(cat "$1" 2>/dev/null || echo 0)
  [[ "$v" =~ ^[0-9]+$ ]] && echo "$v" || echo 0
}

restart() {
  local now last
  now=$(date -u +%s)
  if [ -f "$STAMP" ]; then
    last=$(read_int "$STAMP")
    [ $((now - last)) -lt 900 ] && exit 0
  fi
  echo "[watchdog] $1; restarting $BOT"
  if systemctl restart "$BOT"; then
    echo "$now" > "$STAMP"
  else
    echo "[watchdog] ERROR: failed to restart $BOT (cooldown not locked)" >&2
  fi
  exit 0
}

ALIVE='已转发回复|本回合已划走|已抑制自动转发|跳过自动转发|回复转发已启动|qq_send final'

line=$(grep "等 30s" "$LOG" 2>/dev/null | tail -1 || true)
if [ -n "$line" ]; then
  ts=$(printf '%s' "$line" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z).*/\1/')
  if [ -n "$ts" ] && epoch=$(date -d "$ts" +%s 2>/dev/null) && [ -n "$epoch" ]; then
    age=$(( $(date -u +%s) - epoch ))
    if [ "$age" -ge 180 ] && [ "$age" -lt 600 ]; then
      stuckAt=$(printf '%s' "$ts" | cut -c1-19)
      cutoff=$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null || true)
      lastOk=$(grep -E "$ALIVE" "$LOG" 2>/dev/null | tail -1 | cut -c1-19 || true)
      if [ -n "$lastOk" ] && [[ "$lastOk" > "$stuckAt" ]]; then
        :
      elif [ -n "$lastOk" ] && [ -n "$cutoff" ] && [[ "$lastOk" > "$cutoff" ]]; then
        :
      else
        restart "stuck turn ${age}s ago (no turn finished since)"
      fi
    fi
  fi
fi

if tail -400 "$LOG" 2>/dev/null | grep -q "inactive context"; then
  lastErr=$(grep "inactive context" "$LOG" 2>/dev/null | tail -1 | awk '{print $1}' || true)
  lastOk=$(grep "已转发回复" "$LOG" 2>/dev/null | tail -1 | awk '{print $1}' || true)
  # 修复：必须先判 [ -n "$lastErr" ]，避免 GNU date -d "" 返回当天 00:00:00 触发误判
  if [ -n "$lastErr" ] && eE=$(date -d "$lastErr" +%s 2>/dev/null) && [ -n "$eE" ]; then
    oE=0
    if [ -n "$lastOk" ]; then
      oE=$(date -d "$lastOk" +%s 2>/dev/null || echo 0)
    fi
    if [ "$eE" -gt "${oE:-0}" ]; then
      age=$(( $(date -u +%s) - eE ))
      if [ "$age" -ge 15 ] && [ "$age" -le 900 ]; then
        restart "agent context inactive ${age}s"
      fi
    fi
  fi
fi

line=$(grep -aE "\[ws\] (已连接|连接断开)" "$LOG" 2>/dev/null | tail -1 || true)
if printf '%s' "$line" | grep -q "连接断开"; then
  ts=$(printf '%s' "$line" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z).*/\1/')
  if [ -n "$ts" ] && epoch=$(date -d "$ts" +%s 2>/dev/null) && [ -n "$epoch" ]; then
    age=$(( $(date -u +%s) - epoch ))
    [ "$age" -ge 600 ] && restart "ws down ${age}s"
  fi
fi

HB=/run/{{BOT_NAME}}-onebot-health.fail
resp=""
if resp=$(curl -fsS --max-time 8 -X POST "http://127.0.0.1:{{HTTP_PORT}}/get_login_info" \
    -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}' 2>/dev/null) \
   && printf '%s' "$resp" | grep -q '"user_id"'; then
  rm -f "$HB"
else
  n=$(read_int "$HB")
  n=$((n + 1))
  echo "$n" > "$HB"
  if [ "$n" -ge 2 ]; then
    rm -f "$HB"
    now=$(date -u +%s)
    last=$(read_int "$UPSTREAM_STAMP")
    if [ $((now - last)) -ge 1800 ]; then
      echo "[watchdog] onebot health failed twice; restarting $UPSTREAM_SVC (bot left alone)"
      if systemctl restart "$UPSTREAM_SVC"; then
        echo "$now" > "$UPSTREAM_STAMP"
      else
        echo "[watchdog] ERROR: failed to restart $UPSTREAM_SVC (cooldown not locked)" >&2
      fi
    else
      echo "[watchdog] onebot health failed twice; $UPSTREAM_SVC restarted recently, skip"
    fi
    exit 0
  fi
fi
