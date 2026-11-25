#!/bin/bash
# 模板自检：不出网、不碰线上服务。验证「复制开箱即用、没实例残留、占位符都能替换、回归单测通过」。
# 用法: 自检.sh [--keep]
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KEEP=0
[ "${1:-}" = "--keep" ] && KEEP=1
FAIL=0
ok(){ echo "  ok   $*"; }
bad(){ echo "  FAIL $*"; FAIL=1; }

echo "[1/6] 实例残留扫描（逐匹配项剔除允许常量，杜绝同行漏检）"
if python3 - "$HERE" <<'PY'
import os, re, sys
root = sys.argv[1]
leak_re = re.compile(
    r'哈基米|大肥鱼|1000000001|1000000002|103\.236\.87\.72|110\.42\.109\.146|/data/hajimi-|/data/qq-workspace|/root/\.dsh|B:/肥鱼|/tmp/hajimi-|/tmp/qqqr-hajimi|/data/qq-qq',
    re.IGNORECASE,
)
allow_re = re.compile(r'body\.hajimi-mode|on-hajimi|x-bot-target|swHajimi|HAJIMI_', re.IGNORECASE)
skip_dirs = {'instances', 'vendor', '.git', 'node_modules', '__pycache__', '测试'}
skip_files = {'README.md', 'vars.example.env', 'clean-persona.py', '自检.sh', 'test-tpl-engine.py', 'REFACTOR-CHANGELOG.md', 'WAVE4-CHANGELOG.md', 'WAVE5-CHANGELOG.md'}
hits = []
for dp, dns, fns in os.walk(root):
    dns[:] = [d for d in dns if d not in skip_dirs]
    for fn in fns:
        if fn in skip_files:
            continue
        p = os.path.join(dp, fn)
        try:
            with open(p, 'rb') as fh:
                raw = fh.read()
            if b'\x00' in raw[:4096]:
                continue
            txt = raw.decode('utf-8')
        except Exception:
            continue
        for lineno, line in enumerate(txt.splitlines(), 1):
            stripped = allow_re.sub('', line)
            m = leak_re.search(stripped)
            if m:
                hits.append(f"{os.path.relpath(p, root)}:{lineno} ({m.group(0)})")
                break
if hits:
    print("  FAIL 疑似残留:", *hits[:15], sep="\n    ")
    sys.exit(1)
print("  ok   无实例残留")
PY
then :; else FAIL=1; fi

echo "[2/6] 占位符核对"
if python3 "$HERE/scripts/tpl_engine.py" check-known --root "$HERE"; then
  :
else
  FAIL=1
fi

echo "[3/6] 装到临时目录（含特殊字符 | & \\ 演练）"
TMP=$(mktemp -d /tmp/tpl-selftest.XXXXXX)
cat > "$TMP/vars.env" <<ENV
BOT_NAME=selftest
BOT_DISPLAY=测试机&一号
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
FLEET_TOKEN=selftest|fleet&token
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
if bash "$HERE/安装新bot.sh" "$TMP/vars.env" --workspace-only >"$TMP/install.log" 2>&1; then
  ok "workspace 生成成功"
else
  bad "workspace 生成失败（见 $TMP/install.log）"; sed -n '1,15p' "$TMP/install.log"
fi
if [ -d "$TMP/ws" ]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BAD=0
    while IFS= read -r f; do
      node --check "$f" >/dev/null 2>&1 || { echo "  FAIL node --check $f"; NODE_BAD=1; }
    done < <(find "$TMP/ws" -name '*.mjs' -print)
    [ "$NODE_BAD" = 0 ] && ok "全部 .mjs 语法通过" || FAIL=1
  else
    bad "缺少 node，无法校验 .mjs 语法"
  fi
fi

echo "[4/6] 桥/服务/dsh 模板渲染（通过 tpl_engine.py 实测）"
if python3 - "$HERE" "$TMP" <<'PY'
import json, os, subprocess, sys
from pathlib import Path
root, tmp = Path(sys.argv[1]), Path(sys.argv[2])
env_f = tmp / 'vars.env'
out_dir = tmp / 'rendered'
out_dir.mkdir(exist_ok=True)
bad = []
for tpl in sorted((root / 'bridge').glob('*.tpl')):
    dst = out_dir / tpl.stem
    r = subprocess.run(
        [sys.executable, str(root / 'scripts/tpl_engine.py'), 'render-file',
         '--env', str(env_f), '--src', str(tpl), '--dst', str(dst), '--check'],
        capture_output=True, text=True,
    )
    if r.returncode != 0:
        bad.append(f"{tpl.name}: {r.stderr.strip()}")
if bad:
    print("  FAIL 桥/服务模板渲染失败:", *bad, sep="\n    ")
    sys.exit(1)
print("  ok   全部桥/服务模板占位符齐全")

d = json.loads((out_dir / 'qq-bridge.config.json').read_text(encoding='utf-8'))
print(f"  ok   qq-bridge 展开后是合法 JSON（白名单 {len(d.get('工具白名单', []))} 个）")

pkg_dst = out_dir / 'package.json'
r2 = subprocess.run(
    [sys.executable, str(root / 'scripts/tpl_engine.py'), 'render-file',
     '--env', str(env_f), '--src', str(root / 'dsh/package.json.tpl'), '--dst', str(pkg_dst), '--check'],
    capture_output=True, text=True,
)
if r2.returncode != 0:
    print("  FAIL dsh/package.json.tpl 渲染失败:", r2.stderr.strip())
    sys.exit(1)
d2 = json.loads(pkg_dst.read_text(encoding='utf-8'))
bundles = d2.get('dsh', {}).get('profile', {}).get('bundles', [])
if 'dsh-live-compact' not in bundles:
    print("  FAIL dsh package.json 少了 dsh-live-compact")
    sys.exit(1)
print(f"  ok   dsh package.json 合法，bundles {len(bundles)} 个（含 live-compact）")
PY
then :; else FAIL=1; fi

echo "[5/6] 压缩切点回归"
if command -v node >/dev/null 2>&1 && [ -f "$HERE/tests/t-cut-drain.mjs" ]; then
  if node "$HERE/tests/t-cut-drain.mjs" "$HERE/dsh/vendor/dsh-live-compact/plan.js" >/dev/null 2>&1; then
    ok "纯聊天/带工具尾巴及配对完整性切点测试通过"
  else
    bad "压缩切点回归失败（跑 tests/t-cut-drain.mjs 看原因）"
  fi
else
  bad "缺少 node 或 tests/t-cut-drain.mjs，无法执行压缩切点回归"
fi

echo "[6/6] 模板引擎与回归单测"
if [ -f "$HERE/tests/test-tpl-engine.py" ]; then
  if python3 "$HERE/tests/test-tpl-engine.py" >/dev/null 2>&1; then
    ok "test-tpl-engine.py 全部通过"
  else
    bad "test-tpl-engine.py 失败（手动运行查看详情）"
  fi
else
  bad "缺少 tests/test-tpl-engine.py"
fi
if command -v node >/dev/null 2>&1 && [ -f "$HERE/tests/test-mnemonic.mjs" ]; then
  if node --test "$HERE/tests/test-mnemonic.mjs" >/dev/null 2>&1; then
    ok "test-mnemonic.mjs 全部通过"
  else
    bad "test-mnemonic.mjs 失败（手动运行查看详情）"
  fi
fi

[ "$KEEP" = 1 ] && echo "临时目录保留在 $TMP" || rm -rf "$TMP"

echo
if [ "$FAIL" = 0 ]; then echo "模板自检通过"; else echo "模板自检有问题"; fi
exit "$FAIL"
