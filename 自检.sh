#!/bin/bash
# 模板自检：不出网、不碰线上服务。验证「复制开箱即用、没实例残留、占位符都能替换」。
# 用法: 自检.sh [--keep]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
FAIL=0
ok(){ echo "  ok   $*"; }
bad(){ echo "  FAIL $*"; FAIL=1; }

echo "[1/5] 实例残留扫描"
RES=$(cd "$HERE" && grep -rIl -E '哈基米|大肥鱼|1000000001|1000000002|103\.236\.87\.72|110\.42\.109\.146|/data/hajimi-|/data/qq-workspace|/root/\.dsh' \
  --exclude-dir=instances --exclude-dir=vendor --exclude=README.md --exclude=clean-persona.py --exclude=自检.sh . 2>/dev/null || true)
# body.hajimi-mode / x-bot-target:hajimi 是共用机制常量，不算实例残留
RES=$(printf '%s\n' "$RES" | while read -r f; do
  [ -z "$f" ] && continue
  n=$(grep -c -E '哈基米|大肥鱼|1000000001|1000000002|103\.236\.87\.72|110\.42\.109\.146|/data/hajimi-|/data/qq-workspace|/root/\.dsh' "$HERE/$f" 2>/dev/null || true)
  n=${n:-0}
  # 只允许 hajimi-mode / x-bot-target 这类机制常量
  m=$(grep -c -E 'body\.hajimi-mode|on-hajimi|x-bot-target|swHajimi|HAJIMI_' "$HERE/$f" 2>/dev/null || true)
  m=${m:-0}
  [ "$n" -gt "$m" ] && echo "$f"
done)
if [ -z "$RES" ]; then ok "无实例残留"; else bad "疑似残留: $(echo "$RES" | tr '\n' ' ')"; fi

echo "[2/5] 占位符核对"
python3 - "$HERE" <<'PY'
import re, sys, os
root=sys.argv[1]
install={'BOT_NAME','BOT_DISPLAY','BOT_NAME_UPPER','BOT_ROOT','DSH_ROOT','QQ_HOME','GATEWAY_URL','BOT_BOOK_DIR',
'ALT_BOT_DISPLAY','ALT_BOT_KEY','ALT_PANEL_PORT','ALT_SELF_UIN','GROUP_UIN','SELF_UIN','OWNER_UIN','HTTP_PORT','WS_PORT',
'WEB_PORT','PANEL_PORT','BRIDGE_TOKEN','WS_TOKEN',
'SVC_BOT','SVC_PANEL','SVC_GATEWAY','SVC_UPSTREAM','SVC_WATCHDOG','SVC_GPT',
'PATCH_SCRIPT','PATCH_DIR','GATEWAY_PORT','INSTALL_GATEWAY','FLEET_TOKEN'}
runtime={'DATE','MATERIAL','AV','PIC','BAR','COVER_FIRST','READING_ID'}
known=install|runtime
exts={'.md','.mjs','.js','.html','.json','.sh','.py','.tpl','.txt','.yml','.yaml','.css'}
bad=[]
for dp,dns,fns in os.walk(root):
    dns[:]=[d for d in dns if d not in {'instances','.git','vendor'}]
    for fn in fns:
        if os.path.splitext(fn)[1].lower() not in exts: continue
        p=os.path.join(dp,fn)
        try: s=open(p,encoding='utf-8').read()
        except Exception: continue
        for name in set(re.findall(r'\{\{([A-Z_]+)\}\}',s)):
            if name not in known: bad.append(f'{os.path.relpath(p,root)}: {name}')
if bad: print('  FAIL 未定义的占位符:\n   '+'\n   '.join(bad))
else: print('  ok   占位符都在已知列表里')
sys.exit(1 if bad else 0)
PY
[ $? -ne 0 ] && FAIL=1

echo "[3/5] 装到临时目录"
TMP=$(mktemp -d /tmp/tpl-selftest.XXXXXX)
cat > "$TMP/vars.env" <<ENV
BOT_NAME=selftest
BOT_ROOT=$TMP/ws
DSH_ROOT=$TMP/dsh
QQ_HOME=$TMP/qq
SELF_UIN=1000000002
OWNER_UIN=1000000001
HTTP_PORT=3099
WS_PORT=8199
WEB_PORT=3098
PANEL_PORT=39299
GATEWAY_PORT=39402
INSTALL_GATEWAY=1
FLEET_TOKEN=selftest-fleet-token
BRIDGE_TOKEN=selftest-bridge
WS_TOKEN=selftest-ws
GATEWAY_URL=http://127.0.0.1:39401
ALT_BOT_DISPLAY=二号机
ALT_BOT_KEY=alt
ALT_PANEL_PORT=8799
SVC_BOT=selftest-bot
SVC_PANEL=selftest-panel
SVC_GATEWAY=selftest-gateway
SVC_UPSTREAM=selftest-upstream
SVC_WATCHDOG=selftest-watchdog
SVC_GPT=selftest-gptsovits
PATCH_SCRIPT=reapply-patches-selftest.sh
PATCH_DIR=selftest-patches
ENV
if "$HERE/安装新bot.sh" "$TMP/vars.env" --workspace-only >"$TMP/install.log" 2>&1; then
  ok "workspace 生成成功"
else
  bad "workspace 生成失败（见 $TMP/install.log）"; sed -n '1,10p' "$TMP/install.log"
fi
if [ -d "$TMP/ws" ]; then
  LEFT=$(grep -rIl -E '\{\{(BOT_NAME|BOT_NAME_UPPER|BOT_ROOT|DSH_ROOT|QQ_HOME|GATEWAY_URL|BOT_BOOK_DIR|ALT_BOT_DISPLAY|ALT_BOT_KEY|ALT_PANEL_PORT|ALT_SELF_UIN|GROUP_UIN|SELF_UIN|OWNER_UIN|HTTP_PORT|WS_PORT|WEB_PORT|PANEL_PORT|GATEWAY_PORT|FLEET_TOKEN|BRIDGE_TOKEN|WS_TOKEN|SVC_BOT|SVC_PANEL|SVC_GATEWAY|SVC_UPSTREAM|SVC_WATCHDOG|SVC_GPT)\}\}' "$TMP/ws" 2>/dev/null | head -5)
  [ -z "$LEFT" ] && ok "生成结果无占位符" || bad "未替换: $LEFT"
  NODE_BAD=0
  while IFS= read -r f; do node --check "$f" >/dev/null 2>&1 || { echo "  FAIL node --check $f"; NODE_BAD=1; }; done < <(find "$TMP/ws" -name '*.mjs' -print)
  [ "$NODE_BAD" = 0 ] && ok "全部 .mjs 语法通过" || FAIL=1
fi

echo "[4/5] 桥/服务模板渲染"
python3 - "$HERE" "$TMP" <<'PY'
import os,re,sys,io
root,tmp=sys.argv[1],sys.argv[2]
vals=dict(line.strip().split('=',1) for line in io.open(os.path.join(tmp,'vars.env'),encoding='utf-8') if '=' in line and not line.startswith('#'))
vals['BOT_NAME_UPPER']=vals['BOT_NAME'].upper()
vals.setdefault('BOT_BOOK_DIR',''); vals.setdefault('ALT_SELF_UIN',''); vals.setdefault('GROUP_UIN','')
bad=[]
for fn in os.listdir(os.path.join(root,'bridge')):
    if not fn.endswith('.tpl'): continue
    s=io.open(os.path.join(root,'bridge',fn),encoding='utf-8').read()
    for k,v in vals.items(): s=s.replace('{{'+k+'}}',v)
    left=set(re.findall(r'\{\{[A-Z_]+\}\}',s))
    if left: bad.append(f'{fn}: {sorted(left)}')
if bad: print('  FAIL 桥模板残留占位符: '+'; '.join(bad))
else: print('  ok   桥/服务模板占位符齐全')
import json
jp=os.path.join(root,'dsh','package.json.tpl')
if os.path.exists(jp):
    s2=io.open(jp,encoding='utf-8').read()
    for k,v in vals.items(): s2=s2.replace('{{'+k+'}}',v)
    try:
        d2=json.loads(s2)
        b=d2.get('dsh',{}).get('profile',{}).get('bundles',[])
        if 'dsh-live-compact' not in b:
            print('  FAIL dsh package.json 的 bundles 少了 dsh-live-compact'); bad.append('dsh-bundles')
        else:
            print('  ok   dsh package.json 合法，bundles %d 个（含 live-compact）' % len(b))
    except Exception as e:
        print('  FAIL dsh package.json 不是合法 JSON:', e); bad.append('dshjson')
j=io.open(os.path.join(root,'bridge','qq-bridge.config.json.tpl'),encoding='utf-8').read()
for k,v in vals.items(): j=j.replace('{{'+k+'}}',v)
try:
    d=json.loads(j)
    print('  ok   qq-bridge 模板展开后是合法 JSON（白名单 %d 个）' % len(d.get('工具白名单',[])))
except Exception as e:
    print('  FAIL qq-bridge 模板展开后不是合法 JSON:', e); bad.append('json')
sys.exit(1 if bad else 0)
PY
[ $? -ne 0 ] && FAIL=1
echo "[5/5] 压缩切点回归"
# CUT_TEST_2026：dsh-live-compact 的 walkOffTail 曾经引用未定义的 draining，
# 纯聊天会话永远切不动，token 一路涨。这条盯住它。
if command -v node >/dev/null 2>&1 && [ -f "$HERE/tests/t-cut-drain.mjs" ]; then
  if node "$HERE/tests/t-cut-drain.mjs" "$HERE/dsh/vendor/dsh-live-compact/plan.js" >/dev/null 2>&1; then
    ok "纯聊天/带工具尾巴都能选出切点"
  else
    bad "压缩切点回归失败（跑 tests/t-cut-drain.mjs 看原因）"
  fi
else
  ok "跳过（没有 node 或 tests/t-cut-drain.mjs）"
fi

[ "$KEEP" = 1 ] && echo "临时目录保留在 $TMP" || rm -rf "$TMP"

echo
if [ "$FAIL" = 0 ]; then echo "模板自检通过"; else echo "模板自检有问题"; fi
exit "$FAIL"
