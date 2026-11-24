import argparse
import json
import math
from collections import defaultdict
from datetime import datetime
from statistics import median


def number(row, field):
    value = row.get(field)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return value if math.isfinite(value) and value >= 0 else None


def summarize(rows):
    known = []
    unknown = invalid = 0
    for row in rows:
        total = number(row, '入')
        # Only the new parser's explicit provenance marker proves the cached field was returned.
        cached = number(row, '缓读') if row.get('缓读已知') is True else None
        if total is None or cached is None:
            unknown += 1
        elif cached > total:
            invalid += 1
        else:
            known.append((total, cached))
    denominator = sum(v[0] for v in known)
    return {
        'calls': len(rows), 'known': len(known), 'unknown': unknown,
        'cache_verified': sum(r.get('缓读已知') is True for r in rows),
        'legacy_unverified': sum('缓读已知' not in r for r in rows),
        'invalid': invalid, 'explicit_zero': sum(c == 0 for _, c in known),
        'input_known': denominator, 'cache_known': sum(c for _, c in known),
        'hit': sum(c for _, c in known) / denominator if denominator else None,
    }


def clusters(rows, gap=90):
    result = []
    for row in sorted(rows, key=lambda r: r['_time']):
        if not result or (row['_time'] - result[-1][-1]['_time']).total_seconds() > gap:
            result.append([])
        result[-1].append(row)
    return result


def load(path):
    rows, bad = [], 0
    with open(path, encoding='utf-8') as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                row = json.loads(line)
                row['_time'] = datetime.strptime(row['at'], '%Y-%m-%d %H:%M:%S')
                rows.append(row)
            except (ValueError, TypeError, KeyError):
                bad += 1
    return rows, bad


def is_evaluation(row):
    summary = row.get('摘要')
    return isinstance(summary, str) and summary.startswith('[工具说明离线对照测试')


def observations(rows):
    values = [r['观测'] for r in rows if isinstance(r.get('观测'), dict)]
    out = {'observed': len(values), 'unobserved': len(rows) - len(values)}
    for field in ['工具数', '工具描述字符', '工具声明字符', '系统字符', '消息数', '图片数', '工具结果字符']:
        valid = [number(v, field) for v in values]
        valid = [v for v in valid if v is not None]
        out[field] = {'samples': len(valid), 'median': median(valid) if valid else None,
                      'max': max(valid) if valid else None}
    out['distinct_system_hashes'] = len({v['系统哈希'] for v in values if isinstance(v.get('系统哈希'), str)})
    out['distinct_tool_hashes'] = len({v['工具哈希'] for v in values if isinstance(v.get('工具哈希'), str)})
    return out


def describe(label, rows):
    stat = summarize(rows)
    print(label, json.dumps(stat, ensure_ascii=False))
    print('  请求观测（字符量不等于token）', json.dumps(observations(rows), ensure_ascii=False))
    grouped = clusters(rows)
    if grouped:
        first = summarize([c[0] for c in grouped])
        print('  90秒时间簇（不是模型真实回合）：', len(grouped),
              '每簇调用中位数', median([len(c) for c in grouped]))
        print('  簇首缓存：已知', first['known'], '未知', first['unknown'],
              '无效', first['invalid'], '明确为零', first['explicit_zero'])


def main():
    parser = argparse.ArgumentParser(description='只在缓存字段已知且有效的相同样本上计算命中率')
    parser.add_argument('--input', default='{{DSH_ROOT}}/fish-usage-log.jsonl')
    parser.add_argument('--cut', default='2026-11-09 09:30:00')
    args = parser.parse_args()
    cut = datetime.strptime(args.cut, '%Y-%m-%d %H:%M:%S')
    rows, bad = load(args.input)
    evaluation = [r for r in rows if is_evaluation(r)]
    rows = [r for r in rows if not is_evaluation(r)]
    print('排除明确标记的工具说明离线评测调用', len(evaluation))
    print('读取调用', len(rows), '坏行', bad, '分界', args.cut)
    print('缓存口径：入包含缓读；旧记录未有缓读已知标记，其数字0可能来自旧解析器默认值。')
    print('cache_verified仅计明确标记；legacy_unverified不能验证字段存在性；不推断费用或因果。')
    print('同一 key ID 及模型内的时间簇仍可能混入多个会话；未经请求关联不能当真实回合。')
    for before, label in ((True, '分界前'), (False, '分界后')):
        selected = [r for r in rows if (r['_time'] < cut) == before]
        describe(label + '全部调用', selected)
        groups = defaultdict(list)
        for row in selected:
            groups[(row.get('钥') or '候选ID未知', row.get('实际模型') or row.get('模型') or '模型未知')].append(row)
        for key, values in sorted(groups.items()):
            describe('  候选ID/模型 ' + '/'.join(key), values)


if __name__ == '__main__':
    main()
