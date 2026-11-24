#!/usr/bin/env python3
"""SOUL 从 runtime-context 挪进 system 段（2026-11-24）

问题：qq-soul 用 systemPrompt.context() 注册，宿主每轮把整份快照（SOUL 1759 字
+ 状态 ~1.8k + 召回块）作为一条新消息追加进历史。SOUL 内容不变却每轮重发一份，
40 份快照就是 ~70k 字重复。

修法：有 systemPrompt.section() 就用 section（宿主只保留最新一份 system 节点），
没有就回退 context。interpolate:false 防止 SOUL 里的 {{...}} 被当变量解析。

用法：
    python3 patch_soul_section.py <profile>/node_modules/dsh-onebot-channel/lib/index.js [...]
    改完 node --check，重启 bot。
"""
import datetime
import pathlib
import shutil
import sys

OLD = "          const off2 = agent.ctx.systemPrompt.context({ name: 'qq-soul', order: 1e8, text: 挂灵魂 })"

NEW = """          // SOUL 从 runtime-context 挪进 system 段（2026-11-24）：context 每轮一份快照，
          // SOUL 1759 字固定不变，却跟着状态一起进历史，40 份快照就是 70k 字重复。
          // 放进 system 后宿主会去重（只保留最新一份），且 persona 前缀稳定。
          const __sp = agent.ctx.systemPrompt
          const off2 = typeof __sp.section === 'function'
            ? __sp.section({ name: 'qq-soul', order: 10200, interpolate: false, text: 挂灵魂 })
            : __sp.context({ name: 'qq-soul', order: 1e8, text: 挂灵魂 })"""

STAMP = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")

for dest in sys.argv[1:]:
    f = pathlib.Path(dest)
    text = f.read_text(encoding="utf-8")
    if OLD not in text:
        print("anchor missing:", f)
        continue
    tag = "hajimi" if "hajimi" in dest else "fish"
    shutil.copy2(f, f"/root/bak2/index.js.bak-soulsection-{tag}-{STAMP}")
    f.write_text(text.replace(OLD, NEW, 1), encoding="utf-8")
    print("patched", f)
