import json, pathlib, sys

p = pathlib.Path(sys.argv[1])
d = json.loads(p.read_text(encoding='utf-8'))
d.setdefault('compress', {})['preStepEnabled'] = False
p.write_text(json.dumps(d, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print('preStepEnabled=false')
