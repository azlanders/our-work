#!/usr/bin/env bash
# ============================================================
# clash-linux-setup.sh —— 在 Linux 上把这份机场订阅跑起来（mihomo / clash.meta 内核）
#
# 用途：
#   一条命令搞定：下内核 → 拉订阅 → 修四处坑 → 起服务 → 自动挑一个真能通的节点 → 验 x.com。
#
# 用法：
#   chmod +x clash-linux-setup.sh
#   ./clash-linux-setup.sh "<订阅地址>" [安装目录，默认 ~/clash]
#
# 为什么这么写（2026-10-31 在本机 Windows 上踩完一遍后照着抄的）：
#   1. 内核必须用 mihomo（clash.meta），老版 clash 不认 hysteria2 —— 订阅里 14 条是 hysteria2。
#   2. 不加 geodata-mode: false 的话，内核启动时会去 GitHub 拉 GeoIP.dat，拉不到直接 fatal 退出，
#      端口根本不会开（本机就这么卡了二十分钟）。改成 false 走 mmdb；因为规则里的 GEOIP,CN 也被
#      删了，所以连 mmdb 都不用下。
#   3. allow-lan 一律关掉，代理只听 127.0.0.1，别让同网段的人白嫖。
#   4. store-selected: true 记住选中的节点，重启不用重新挑。
#   5. 最迷惑的一个坑：机场会在订阅最前面塞一串「套餐到期 / 官网网址 / 距离重置」的公告节点，
#      它们指向同一个可能已死的地址。主组默认选第一个 = 选中公告节点 → 节点延迟测试全绿、
#      但一开网页就超时。所以最后要挨个测延迟，挑一个真的。
#
# 依赖：curl、gzip、python3（挑节点用，没有就跳过自动挑选，手动选也行）
# ============================================================
set -euo pipefail

SUB_URL="${1:-}"
DIR="${2:-$HOME/clash}"
MIRROR="https://gh-proxy.com"          # 本机实测能下 GitHub 资产的镜像；直连常超时
VER="v1.19.33"
PORT=7890
CTRL=9090

if [ -z "$SUB_URL" ]; then
  echo "用法: $0 \"<订阅地址>\" [安装目录]"
  exit 1
fi

echo "== 1/5 准备目录 $DIR =="
mkdir -p "$DIR"
cd "$DIR"

echo "== 2/5 下内核 mihomo $VER（linux-amd64）=="
if [ ! -x ./mihomo ]; then
  curl -fsSL --retry 3 -C - -o mihomo.gz \
    "$MIRROR/https://github.com/MetaCubeX/mihomo/releases/download/$VER/mihomo-linux-amd64-$VER.gz"
  gzip -df mihomo.gz
  chmod +x mihomo
fi
./mihomo -v | head -1

echo "== 3/5 拉订阅、geo 库并修正配置 =="
curl -fsSL --retry 3 -o config.raw.yaml "$SUB_URL"
# geosite.dat 必须备一份：DNS 段里的 nameserver-policy 用了 geosite:cn，缺文件内核照样 fatal 退出。
# （country.mmdb / geoip.dat 不用 —— 规则里的 GEOIP,CN 在下面被删掉了。）
if [ ! -f geosite.dat ]; then
  curl -fsSL --retry 3 -C - -o geosite.dat \
    "$MIRROR/https://github.com/MetaCubeX/meta-rules-dat/releases/download/latest/geosite.dat"
fi
# 四处修补（用 sed 而不是手改，方便重复跑）
sed -e 's/^geodata-mode: true/geodata-mode: false/' \
    -e 's/^allow-lan: true/allow-lan: false/' \
    -e '/^[[:space:]]*-[[:space:]]*.GEOIP,CN,DIRECT./d' \
    -e "s/^mixed-port:.*/mixed-port: $PORT/" \
    -e "s/^external-controller:.*/external-controller: '127.0.0.1:$CTRL'/" \
    config.raw.yaml > config.yaml
# store-selected 只能加一次，重复跑脚本别叠加
grep -q '^store-selected:' config.yaml || sed -i '1i store-selected: true' config.yaml

echo "== 4/5 起服务 =="
pkill -f "$DIR/mihomo" 2>/dev/null || true
sleep 1
nohup ./mihomo -d "$DIR" -f config.yaml > mihomo.log 2>&1 &
sleep 8
if ! curl -sS --max-time 5 -o /dev/null "http://127.0.0.1:$CTRL/version"; then
  echo "控制器没起来，看 $DIR/mihomo.log 最后几行："
  tail -20 mihomo.log
  exit 1
fi

echo "== 5/5 自动挑节点（公告节点会让你看着像全通、实际全废）=="
if command -v python3 >/dev/null 2>&1; then
  python3 - "$CTRL" "$PORT" <<'PY'
import json, sys, urllib.parse, urllib.request

ctrl, port = sys.argv[1], sys.argv[2]
base = f"http://127.0.0.1:{ctrl}"

def get(path):
    return json.load(urllib.request.urlopen(base + path, timeout=10))

def put(path, payload):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"}, method="PUT")
    urllib.request.urlopen(req, timeout=10)

# 找到规则最后指向的那个组（订阅里的主组名每次可能不一样，所以按「被 MATCH 引用」找）
cfg = get("/configs")
groups = {name: v for name, v in get("/proxies")["proxies"].items()
          if v.get("type") in ("Selector", "URLTest", "Fallback", "LoadBalance")}
# 主组：包含节点最多的那个
main = max(groups, key=lambda n: len(groups[n].get("all") or []))
print(f"主组：{main}")

delay = get(f"/group/{urllib.parse.quote(main)}/delay?url="
            f"{urllib.parse.quote('https://www.gstatic.com/generate_204', safe='')}&timeout=5000")
ok = [(ms, n) for n, ms in delay.items()
      if isinstance(ms, int) and ms > 0
      and not any(k in n for k in ('到期', '网址', '重置', '流量', 'ISP', '官方TG'))]
if not ok:
    print("没有节点测得通 —— 多半是这台机器的出网被拦，换机器或换线路")
    sys.exit(1)
ok.sort()
pick = ok[0][1]
print(f"选中：{pick}（{ok[0][0]}ms）")
put(f"/proxies/{urllib.parse.quote(main)}", {"name": pick})
PY
else
  echo "没有 python3，跳过自动挑选。可以手动改 config.yaml 里主组默认节点，或用控制器页面选。"
fi

echo "== 验收：走代理开 x.com 和 google =="
for u in https://www.google.com https://x.com; do
  printf "%s -> " "$u"
  curl -sS -x "http://127.0.0.1:$PORT" -o /dev/null --max-time 20 -w "%{http_code} %{time_total}s\n" "$u" || echo "失败"
done

echo
echo "装好了。日常用法："
echo "  curl -x http://127.0.0.1:$PORT https://x.com     # 命令行临时走代理"
echo "  开机自启可加一条 crontab：@reboot $DIR/mihomo -d $DIR -f $DIR/config.yaml"
