import importlib.util
import unittest
from pathlib import Path
from datetime import datetime, timedelta

module_path = Path(__file__).resolve().parents[1] / '对比-token.py'
spec = importlib.util.spec_from_file_location('token_audit', module_path)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

class StatsTest(unittest.TestCase):
    def test_missing_not_zero(self):
        s = m.summarize([{'入': 100}, {'入': 100, '缓读': None}])
        self.assertEqual((s['unknown'], s['explicit_zero'], s['hit']), (2, 0, None))
    def test_matched_denominator(self):
        s = m.summarize([{'入': 100, '缓读': 80, '缓读已知': True}, {'入': 900}])
        self.assertEqual(s['hit'], 0.8)
        self.assertEqual(s['input_known'], 100)
    def test_explicit_zero(self):
        self.assertEqual(m.summarize([{'入': 100, '缓读': 0, '缓读已知': True}])['explicit_zero'], 1)
    def test_invalid_range(self):
        self.assertEqual(m.summarize([{'入': 100, '缓读': 120, '缓读已知': True}])['invalid'], 1)
    def test_bad_types(self):
        for v in [True, -1, '100', float('nan'), float('inf')]:
            self.assertIsNone(m.number({'入': v}, '入'))
    def test_empty(self):
        self.assertIsNone(m.summarize([])['hit'])
    def test_weighted_rate(self):
        self.assertEqual(m.summarize([{'入': 100, '缓读': 0, '缓读已知': True}, {'入': 300, '缓读': 300, '缓读已知': True}])['hit'], 0.75)
    def test_cluster_boundary(self):
        t = datetime(2026, 11, 9)
        rows = [{'_time': t + timedelta(seconds=s)} for s in [0, 90, 181]]
        self.assertEqual([len(c) for c in m.clusters(rows)], [2, 1])

    def test_explicit_unknown_excluded(self):
        s = m.summarize([{'入': 100, '缓读': 0, '缓读已知': False}])
        self.assertEqual((s['known'], s['unknown'], s['explicit_zero']), (0, 1, 0))
    def test_cache_provenance(self):
        s = m.summarize([{'入': 100, '缓读': 0}, {'入': 100, '缓读': 80, '缓读已知': True}])
        self.assertEqual((s['known'], s['unknown'], s['explicit_zero']), (1, 1, 0))
        self.assertEqual((s['cache_verified'], s['legacy_unverified']), (1, 1))

    def test_explicit_unknown_and_missing_provenance(self):
        rows = [
            {'入': 100, '缓读': 0, '缓读已知': False},
            {'入': 100, '缓读': 0},
            {'入': 100, '缓读': 0, '缓读已知': True},
        ]
        s = m.summarize(rows)
        self.assertEqual((s['known'], s['unknown'], s['explicit_zero']), (1, 2, 1))

    def test_provenance_missing_cache_value(self):
        s = m.summarize([{'入': 100, '缓读已知': True}])
        self.assertEqual((s['known'], s['unknown']), (0, 1))
    def test_missing_observation_unknown(self):
        s = m.observations([{}])
        self.assertEqual(s['unobserved'], 1)
        self.assertIsNone(s['工具数']['median'])
    def test_observation_median(self):
        s = m.observations([{'观测': {'工具数': n}} for n in [48, 50]])
        self.assertEqual(s['工具数']['median'], 49)
    def test_hash_distinct(self):
        s = m.observations([{'观测': {'系统哈希': h, '工具哈希':'fixed'}} for h in ['a','a','b']])
        self.assertEqual((s['distinct_system_hashes'], s['distinct_tool_hashes']), (2, 1))
    def test_invalid_observation(self):
        s = m.observations([{'观测': {'工具数': True}}, {'观测': {'工具数': 48}}])
        self.assertEqual((s['工具数']['samples'], s['工具数']['median']), (1, 48))

    def test_evaluation_marker(self):
        self.assertTrue(m.is_evaluation({'摘要': '[工具说明离线对照测试] 发图'}))
    def test_evaluation_not_substring(self):
        self.assertFalse(m.is_evaluation({'摘要': '聊天提到[工具说明离线对照测试] '}))
    def test_evaluation_extension_prefix(self):
        self.assertTrue(m.is_evaluation({'摘要': '[工具说明离线对照测试] [48工具菜单] qq_send'}))
    def test_evaluation_extension_inside_marker(self):
        self.assertTrue(m.is_evaluation({'摘要': '[工具说明离线对照测试 48工具候选覆盖 qq_item 看清点] 主人说'}))
    def test_evaluation_missing(self):
        self.assertFalse(m.is_evaluation({'摘要': None}))

if __name__ == '__main__':
    unittest.main()
