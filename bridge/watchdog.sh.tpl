#!/bin/bash
# {{BOT_NAME}} 看门狗：回合卡住 / 上下文掉线 / WS 断线才重启 {{SVC_BOT}}。
# 协议端（SnowLuma）健康失败只重启 snowluma，且 30 分钟内最多一次；不连带重启 bot。
LOG={{DSH_ROOT}}/qq-bridge-load.log
STAMP=/run/{{SVC_WATCHDOG}}.last
BOT={{SVC_BOT}}
TOKEN={{BRIDGE_TOKEN}}
systemctl is-active --quiet "$BOT" || exit 0
[ -f "$LOG" ] || exit 0

restart() {
  now=$(date -u +%s)
  if [ -f "$STAMP" ]; then
    last=$(cat "$STAMP" 2>/dev/null || echo 0)
    [ $((now - last)) -lt 900 ] && exit 0
  fi
  echo "$now" > "$STAMP"
  echo "[watchdog] $1; restarting $BOT"
  systemctl restart "$BOT"
  exit 0
}

ALIVE='已转发回复|本回合已划走|已抑制自动转发|跳过自动转发|回复转发已启动|qq_send final'

line=$(grep "等 30s" "$LOG" 2>/dev/null | tail -1)
if [ -n "$line" ]; then
  ts=$(printf '%s' "$line" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z).*/\1/')
  epoch=$(date -d "$ts" +%s 2>/dev/null)
  if [ -n "$epoch" ]; then
    age=$(( $(date -u +%s) - epoch ))
    if [ "$age" -ge 180 ] && [ "$age" -lt 600 ]; then
      stuckAt=$(printf '%s' "$ts" | cut -c1-19)
      cutoff=$(date -u -d '10 minutes ago' +%Y-%m-%dT%H:%M:%S 2>/dev/null)
      lastOk=$(grep -E "$ALIVE" "$LOG" 2>/dev/null | tail -1 | cut -c1-19)
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
  lastErr=$(grep "inactive context" "$LOG" 2>/dev/null | tail -1 | awk '{print $1}')
  lastOk=$(grep "已转发回复" "$LOG" 2>/dev/null | tail -1 | awk '{print $1}')
  eE=$(date -d "$lastErr" +%s 2>/dev/null)
  if [ -n "$lastOk" ]; then oE=$(date -d "$lastOk" +%s 2>/dev/null); else oE=0; fi
  if [ -n "$eE" ] && [ "$eE" -gt "${oE:-0}" ]; then
    age=$(( $(date -u +%s) - eE ))
    if [ "$age" -ge 15 ] && [ "$age" -le 900 ]; then
      restart "agent context inactive ${age}s"
    fi
  fi
fi

line=$(grep -aE "\[ws\] (已连接|连接断开)" "$LOG" 2>/dev/null | tail -1)
if printf '%s' "$line" | grep -q "连接断开"; then
  ts=$(printf '%s' "$line" | sed -E 's/^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+Z).*/\1/')
  epoch=$(date -d "$ts" +%s 2>/dev/null)
  if [ -n "$epoch" ]; then
    age=$(( $(date -u +%s) - epoch ))
    [ "$age" -ge 600 ] && restart "ws down ${age}s"
  fi
fi

HB=/run/{{BOT_NAME}}-onebot-health.fail
resp=$(curl -s --max-time 8 -X POST http://127.0.0.1:{{HTTP_PORT}}/get_login_info -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}')
if printf '%s' "$resp" | grep -q '"user_id"'; then
  rm -f "$HB"
else
  n=$(cat "$HB" 2>/dev/null || echo 0)
  n=$((n+1))
  echo "$n" > "$HB"
  if [ "$n" -ge 2 ]; then
    rm -f "$HB"
    now=$(date -u +%s)
    last=$(cat /run/snowluma-watchdog-restart.last 2>/dev/null || echo 0)
    if [ $((now - last)) -ge 1800 ]; then
      echo "$now" > /run/snowluma-watchdog-restart.last
      echo "[watchdog] onebot health failed twice; restarting snowluma (bot left alone)"
      systemctl restart snowluma
    else
      echo "[watchdog] onebot health failed twice; snowluma restarted recently, skip"
    fi
    exit 0
  fi
fi
