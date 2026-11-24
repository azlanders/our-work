#!/usr/bin/env python3
"""只截 QQ 登录窗，不点任何东西。"""
import os, re, subprocess, sys

CLIENT = os.environ.get('QQ扫码客户端', '{{QQ_HOME}}/app/qq')
OUT = os.environ.get('QQWIN_OUT', '/tmp/_qqwin.png')
ACCOUNT = os.environ.get('QQ扫码用户', '')

def sh(*a): return subprocess.run(a, capture_output=True, text=True)

pid = None
for p in sh('pgrep', '-f', CLIENT + ' --no-sandbox').stdout.split():
    try:
        cmd = open('/proc/%s/cmdline' % p, 'rb').read().decode('utf8', 'replace').replace('\x00', ' ')
        env = open('/proc/%s/environ' % p, 'rb').read().decode('utf8', 'replace')
    except OSError:
        continue
    if ACCOUNT and '-q ' + ACCOUNT not in cmd:
        continue
    d = dict(kv.split('=', 1) for kv in env.split('\x00') if '=' in kv)
    if not d.get('DISPLAY'):
        continue
    pid = p
    os.environ['DISPLAY'] = d['DISPLAY']
    os.environ['XAUTHORITY'] = d.get('XAUTHORITY', '')
    break
if not pid:
    print('QQ 没在跑', file=sys.stderr); sys.exit(2)

cands = []
for cand in sh('xdotool', 'search', '--name', '^QQ$').stdout.split():
    g = sh('xdotool', 'getwindowgeometry', cand).stdout
    m = re.search(r'Geometry: (\d+)x(\d+)', g)
    if m:
        cw, ch = int(m.group(1)), int(m.group(2))
        if cw > 50 and ch > 50:
            cands.append((cw * ch, int(cand)))
cands.sort(reverse=True)
if not cands:
    print('没找到 QQ 窗口', file=sys.stderr); sys.exit(3)
sh('import', '-window', str(cands[0][1]), OUT)
print('ok', OUT)
