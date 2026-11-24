import json, os, pathlib, sys
DSH_ROOT = os.environ.get("DSH_ROOT")
if not DSH_ROOT:
    sys.exit("DSH_ROOT is not set")
# SCORING_RATE 2026-11-24：QQ(channel) 场景原来每 2 回合就触发一次启发式评分兜底 ——
# 31 次请求里 21 次是评分轮，等于把对话成本翻倍。改成 4 回合一次，评分请求减半。
# 未评分记忆只是晚几个小时进召回，不影响正确性。
for root in [pathlib.Path(DSH_ROOT, "profiles/web/vendor/dsh-rofm"), pathlib.Path(DSH_ROOT, "profiles/web/node_modules/dsh-rofm")]:
    p = pathlib.Path(root, "config.local.json")
    d = {}
    if p.exists():
        try: d = json.loads(p.read_text(encoding="utf-8"))
        except Exception: d = {}
    d.setdefault("scoring", {})["autoHeuristicAfterRounds"] = {"plain": 4, "channel": 4}
    p.write_text(json.dumps(d, ensure_ascii=False) + "\n", encoding="utf-8")
    print("wrote", p)
