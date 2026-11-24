#!/usr/bin/env python3
# WAKE_PROBE 2026-11-24
# rofm 把 qq-bridge 的投递头（「（可观测运行信息：…）」「（注意：…）」）当成了对方说的话，
# 整段前缀写进长期记忆；召回命中后又被当上下文注入，形成自激、白烧 token。纯唤醒/续跑
# probes（主动搭话，没有 [HH:MM] 真人行）更是整条模板进记忆。
# 修 dsh-rofm/lib/surface.js：投递头补进 INJECTED/HINT 标记；纯 probe 整条只留一个占位。
# 用法：python3 dsh-rofm-wake-probe.py <dsh-rofm 目录>
import sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')
p = root / 'lib' / 'surface.js'
text = p.read_text(encoding='utf-8')
MARK = 'WAKE_PROBE 2026-11-24'
if MARK in text:
    print(f'skip {p.name}: already patched')
    raise SystemExit(0)

# 1) INJECTED_HEADER_RE 补投递头
a_old = "      '关于它',\n      'QQ群',\n"
a_new = (
    "      '关于它',\n"
    "      // WAKE_PROBE 2026-11-24：qq-bridge 的「可观测运行信息 / 关于他 / 注意」是投递头，\n"
    "      // 不是对方说的话。原来没列进来，导致整段头被当记忆归档、召回后又自激、还白烧 token。\n"
    "      '可观测运行信息',\n"
    "      '本批投递时间',\n"
    "      '注意[:：]',\n"
    "      'QQ群',\n"
)
if a_old not in text:
    raise SystemExit('surface.js: 找不到 INJECTED_HEADER_RE 锚点')
text = text.replace(a_old, a_new, 1)

# 2) 纯 probe 守卫
b_old = "export const stripInjectedHeaders = (input) => {\n  let text = String(input ?? '').trim()\n"
b_new = (
    "export const stripInjectedHeaders = (input) => {\n"
    "  let text = String(input ?? '').trim()\n"
    "  // WAKE_PROBE 2026-11-24：唤醒/续跑 probes（主动搭话、运行信息）整条都是注入内容，\n"
    "  // 没有 `[HH:MM] （QQ…）` 这样的真人消息行。别当记忆归档（否则召回热词自激、白烧 token），\n"
    "  // 只留一个标记。带真人行的投递（前缀 + `[HH:MM]`）不受影响，照常只剥前缀。\n"
    "  if (/（可观测运行信息：/.test(text) && !/\\[\\d{1,2}:\\d{2}\\]\\s*（/.test(text)) {\n"
    "    return '[唤醒/运行提示，已省略]'\n"
    "  }\n"
)
if b_old not in text:
    raise SystemExit('surface.js: 找不到 stripInjectedHeaders 锚点')
text = text.replace(b_old, b_new, 1)

# 3) HINT_MARKER_RE 补投递头
c_old = "      '说话的样子',\n      '你现在的状态',\n      '旧事素材',\n"
c_new = (
    "      '说话的样子',\n"
    "      '你现在的状态',\n"
    "      '可观测运行信息',\n"
    "      '本批投递时间',\n"
    "      '注意[:：]',\n"
    "      '旧事素材',\n"
)
if c_old not in text:
    raise SystemExit('surface.js: 找不到 HINT_MARKER_RE 锚点')
text = text.replace(c_old, c_new, 1)

p.write_text(text, encoding='utf-8')
print(f'patched {p.name}')