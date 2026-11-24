#!/usr/bin/env python3
# 2026-11-24：压缩卡收口。
# 1) 卡片里「较早的用户消息」只留最近三条要点，整块上限 1500 字；
# 2) 已落盘的旧卡片就地剥掉整段运行/状态快照；
# 3) 每回合开始先洗一遍旧卡，免得等回合成功结束才生效。
# 用法: dsh-live-compact-cardslim2.py <DSH_ROOT>/profiles/web/node_modules
# 可重复执行，已经改过的会跳过。
from pathlib import Path
import sys

BASE = Path(sys.argv[1] if len(sys.argv) > 1 else '/data/bot-dsh/profiles/web/node_modules')
HERE = Path(__file__).resolve().parent
PLAN = BASE / 'dsh-live-compact' / 'plan.js'
IDX = BASE / 'dsh-live-compact' / 'index.js'
CONSTS = 'const USER_BLOCK_CAP = 1500;\nconst USER_BLOCK_KEEP = 3;\n'


def read(p):
    return p.read_text(encoding='utf-8')


def write(p, text):
    p.write_text(text, encoding='utf-8')


def cut_function(src, marker):
    start = src.index(marker)
    end = src.index('\n}\n', start) + 3
    return src[:start], src[end:]


s = read(PLAN)
s = s.replace(CONSTS, '')
head, tail = cut_function(s, 'function earlierUsers(')
block = (HERE / 'cardslim-earlier.js').read_text(encoding='utf-8').rstrip('\n')
if not block.startswith(CONSTS):
    block = CONSTS + block
s = head + block + '\n' + tail
if 'export function scrubCardText' in s:
    start = s.index('const SEQ_LINE')
    end = s.index('\n}\n', s.index('export function scrubCardText')) + 3
    s = s[:start] + s[end:]
scrub = (HERE / 'cardslim-scrub.js').read_text(encoding='utf-8').rstrip('\n')
anchor = s.index('function earlierUsers(')
anchor = s.index('\n}\n', anchor) + 3
s = s[:anchor] + scrub + '\n' + s[anchor:]
write(PLAN, s)
print('plan ok')

i = read(IDX)
if 'scrubCardText,' not in i:
    old = 'resolveEngine, selectCutIndexes'
    new = 'resolveEngine, scrubCardText, selectCutIndexes'
    if old not in i:
        print('import anchor missing')
        sys.exit(1)
    i = i.replace(old, new, 1)
if 'scrubCards(session) {' not in i:
    method = (HERE / 'cardslim-method.js').read_text(encoding='utf-8').rstrip('\n')
    start = i.index('  async finishTurn(agent) {')
    end = i.index('\n    try {\n', start) + len('\n    try {\n')
    i = i[:start] + method + '\n    try {\n' + i[end:]
if 'at turn start' not in i:
    anchor = '      ctx.on("session/event", (session, event) => {'
    start = i.index(anchor)
    end = i.index('\n      });\n', start) + len('\n      });\n')
    hook = (HERE / 'cardslim-hook.js').read_text(encoding='utf-8').rstrip('\n') + '\n'
    i = i[:start] + hook + i[end:]
if 'SUMMARIZE_CAP' not in i:
    head = '    const shadowedSeqs = nodes.slice(startIdx, endIdx + 1);\n'
    start = i.index(head) + len(head)
    end = i.index('\n    }\n', start) + len('\n    }\n')
    block = (HERE / 'cardslim-summary.js').read_text(encoding='utf-8')
    i = i[:start] + block + i[end:]
write(IDX, i)
print('index ok')
