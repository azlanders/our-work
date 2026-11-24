import io, os, re, sys
DSH_ROOT = os.environ.get("DSH_ROOT")
if not DSH_ROOT:
    sys.exit("DSH_ROOT is not set")

MARK = "TOOLDESC2 2026-11-24"
BLOCKS = {
"keywords": """          keywords: {
            type: 'array',
            items: { type: 'string' },
            description: '3~16 个关键词（待评分新记忆必填，复核可省略）。信息密度低给约 3 个，高可给到 16；需覆盖原文所有人物、地点、事件与主题，以及你自己说过的称呼约定、承诺、规则、决定。高 α 的偏好/约定类记忆要含一个类别词（喜好/偏好/习惯/约定/承诺/决定/规则/要求/禁忌），否则抽象问法检索不到。原文只有代词时，把消解出的人名写进去。多话题（v1.5.6）：每个话题至少 1 个能独立检索它的关键词，不得只写最主要的话题或用泛词凑数。设置 persons/locations/events 后复查标签都在 keywords 里。',
          },""",
"locations": """          locations: {
            type: 'array',
            items: { type: 'string' },
            description: '原文明确出现的地点（最多 8 个），含「北京」「公司」这类具体地名和「家」「小明的家」这类独立地点；省略=不修改，[]=清空；原文没点名时不要推断。',
          },""",
"persons": """          persons: {
            type: 'array',
            items: { type: 'string' },
            description: '原文明确出现的人物（最多 8 个），只写人名或称呼，不推断关系；省略=不修改，[]=清空。原文只有代词时，结合本条原文、同批记忆与相邻上下文判断：能确定就写明确称呼，不能确定就省略；同一人的多个称呼都写上。',
          },""",
"events": """          events: {
            type: 'array',
            items: { type: 'string' },
            description: '所属事件集合（最多 4 个，同一事件复用已有标签）：旅行/工作项目/方案评审/持续排查的故障等；寒暄、一次性闲聊、纯过程日志不算事件。省略=不修改，[]=清空；与 event 同时提交时 events 优先。',
          },""",
"event": """          event: {
            type: 'string',
            description: '旧版单事件字段，等价于只提交一个 events；一段事件用简短名词短语，复用已有标签；省略=不修改。',
          },""",
}

def replace_field(src, name, block):
    key = "\n          %s: {" % name
    i = src.index(key)
    j = src.index("\n          },", i) + len("\n          },")
    return src[:i] + "\n          " + block.lstrip() + src[j:]

for p in [os.path.join(DSH_ROOT, "profiles/web/node_modules/dsh-rofm/lib/memory-tool.js"),
          os.path.join(DSH_ROOT, "profiles/web/vendor/dsh-rofm/lib/memory-tool.js")]:
    s = io.open(p, encoding="utf-8").read()
    if MARK in s:
        print("skip", p); continue
    for name, block in BLOCKS.items():
        s = replace_field(s, name, block)
    s = s.replace("'要提交的记忆更新，可一次多条（默认一次最多 100 条，可用 scoring.maxItemsPerJudge 配置；超限会被拒绝并提示分批提交）'",
                  "'要提交的记忆更新，可一次多条（默认最多 100 条，超限会被拒绝）'")
    # 标记放在文件头的注释之后，便于幂等
    s = s.replace("const TOOL_DESCRIPTION_SHORT", "// " + MARK + "\nconst TOOL_DESCRIPTION_SHORT", 1)
    io.open(p, "w", encoding="utf-8").write(s)
    print("patched", p)
