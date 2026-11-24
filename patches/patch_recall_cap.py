import json, pathlib, sys

p = pathlib.Path(sys.argv[1])
d = json.loads(p.read_text(encoding='utf-8'))
r = d.setdefault('recall', {})
r['maxRecalledChars'] = 12000
r['maxRecalledBlocks'] = 8
f = r.setdefault('fairness', {})
f.setdefault('roundBudget', {})['maxChars'] = 8000
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('recall cap patched')
