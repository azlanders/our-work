#!/usr/bin/env python3
"""抓 QQ 登录二维码（SnowLuma/Xvfb 上的 QQ 客户端窗口）。

用法：
  qq扫码.py            # 抓当前二维码；过期就点『刷新』重新取
  qq扫码.py --refresh  # 不管当前码新不新，强制点一次刷新
  QQ扫码用户={{SELF_UIN}} # 指定账号（默认抓 {{QQ_HOME}}/app/qq 起的那个）
输出：QQQR_OUT（默认 /tmp/qqqr.png）；失败退出码非 0。
"""
import os, re, subprocess, sys, time
from PIL import Image
import numpy as np

OUT = os.environ.get('QQQR_OUT', '/tmp/qqqr.png')
REFRESH = '--refresh' in sys.argv
ACCOUNT = os.environ.get('QQ扫码用户', '')
CLIENT = os.environ.get('QQ扫码客户端', '{{QQ_HOME}}/app/qq')
SHOT = '/tmp/_qqwin.png'

def sh(*args):
    return subprocess.run(args, capture_output=True, text=True)

def qq_pid():
    # 同一账号可能留过孤儿进程（服务重启后旧 Xvfb 还在）：只认 napcat 服务管的那棵树
    main = sh('systemctl', 'show', os.environ.get('QQ扫码服务', 'napcat-{{BOT_NAME}}'), '-p', 'MainPID', '--value').stdout.strip()
    kids = set(sh('pgrep', '-P', main).stdout.split()) if main.isdigit() else set()
    found = []
    for pat in (CLIENT + ' --no-sandbox', '^/opt/QQ/qq --no-sandbox'):
        for p in sh('pgrep', '-f', pat).stdout.split():
            try:
                ppid = open('/proc/%s/stat' % p).read().split()[3]
                env = open('/proc/%s/environ' % p, 'rb').read().decode('utf8', 'replace')
            except OSError:
                continue
            d = dict(kv.split('=', 1) for kv in env.split('\x00') if '=' in kv)
            if not d.get('DISPLAY'):
                continue
            if ACCOUNT:
                cmd = open('/proc/%s/cmdline' % p, 'rb').read().decode('utf8', 'replace').replace('\x00', ' ')
                if '-q ' + ACCOUNT not in cmd:
                    continue
            found.append((0 if ppid in kids else 1, p, d['DISPLAY'], d.get('XAUTHORITY', '')))
    if not found:
        return None, None, None
    found.sort(key=lambda x: x[0])
    _, p, disp, xa = found[0]
    return p, disp, xa

def windows():
    out = []
    for w in sh('xdotool', 'search', '--name', '^QQ$').stdout.split():
        g = sh('xdotool', 'getwindowgeometry', w).stdout
        m = re.search(r'Geometry: (\d+)x(\d+)', g)
        if m:
            out.append((int(m.group(1)) * int(m.group(2)), int(w), int(m.group(1)), int(m.group(2))))
    out.sort(reverse=True)
    return out

def click(w, x, y):
    sh('xdotool', 'windowfocus', str(w))
    sh('xdotool', 'mousemove', '--window', str(w), str(int(x)), str(int(y)))
    time.sleep(0.25)
    sh('xdotool', 'click', '1')

def grab(w):
    sh('import', '-window', str(w), SHOT)
    return np.array(Image.open(SHOT).convert('RGB')).astype(int)

def blue_button(a):
    """最下方的蓝色实心按钮（弹窗的『确定』）。"""
    h, w, _ = a.shape
    m = (a[:, :, 2] > 195) & (a[:, :, 0] < 90) & (a[:, :, 1] > 110)
    rows = m.sum(axis=1)
    bands, st = [], None
    for y in range(h):
        on = rows[y] > 25
        if on and st is None:
            st = y
        elif not on and st is not None:
            bands.append((st, y - 1)); st = None
    if st is not None:
        bands.append((st, h - 1))
    bands = [b for b in bands if b[1] - b[0] >= 8 and b[0] > h * 0.4]
    if not bands:
        return None
    y0, y1 = bands[-1]
    xs = np.nonzero(m[y0:y1 + 1].any(axis=0))[0]
    return (xs.min() + xs.max()) // 2, (y0 + y1) // 2

def find_qr(a):
    h, w, _ = a.shape
    top, bot = int(h * 0.12), int(h * 0.72)
    dark = (a[:, :, 0] < 110) & (a[:, :, 1] < 110) & (a[:, :, 2] < 110)
    m2 = dark[top:bot]
    cols = m2.sum(axis=0); rows = m2.sum(axis=1)
    cx = np.nonzero(cols > max(8, m2.shape[0] * 0.12))[0]
    cy = np.nonzero(rows > max(8, m2.shape[1] * 0.12))[0]
    if len(cx) < 30 or len(cy) < 30:
        return None
    x0, x1 = int(cx.min()), int(cx.max())
    y0, y1 = int(cy.min()) + top, int(cy.max()) + top
    if max(x1 - x0, y1 - y0) < 100:
        return None
    side = max(x1 - x0, y1 - y0) + 24
    cx0 = (x0 + x1) // 2 - side // 2; cy0 = (y0 + y1) // 2 - side // 2
    box = (max(0, cx0), max(0, cy0), min(w, cx0 + side), min(h, cy0 + side))
    crop = a[box[1]:box[3], box[0]:box[2]]
    d = ((crop[:, :, 0] < 110) & (crop[:, :, 1] < 110) & (crop[:, :, 2] < 110)).mean()
    if not 0.08 < d < 0.75:
        return None
    return box

pid, display, xauth = qq_pid()
if not pid:
    print('QQ 客户端没在跑', file=sys.stderr); sys.exit(2)
os.environ['DISPLAY'] = display
os.environ['XAUTHORITY'] = xauth

wins = windows()
if not wins:
    print('没找到 QQ 登录窗', file=sys.stderr); sys.exit(3)
_, wid, ww, wh = wins[0]

a = grab(wid)
btn = blue_button(a)
if btn and not find_qr(a):          # 登录失败/安全提醒弹窗
    click(wid, *btn); time.sleep(1.2); a = grab(wid)

def try_refresh(a):
    for fy in (0.463, 0.49, 0.43):   # 『刷新』按钮大概在这个高度，换几个点兜住
        click(wid, ww / 2, wh * fy)
        time.sleep(2.4)
        a = grab(wid)
        box = find_qr(a)
        if box:
            return box
    return None

box = None if REFRESH else find_qr(a)
if not box:
    box = try_refresh(a)
if not box:
    click(wid, ww * 0.20, wh - 38)   # 左下链接：账密登录 ↔ 扫码登录
    time.sleep(2.0)
    box = try_refresh(grab(wid))
if not box:
    print('没抓到二维码', file=sys.stderr); sys.exit(4)

Image.open(SHOT).convert('RGB').crop(box).resize((620, 620), Image.LANCZOS).save(OUT)
print('ok %s' % OUT)