"""Standalone synthetic topology tests; no AutoCAD, private drawings, or mutations."""
import copy
import json
import unittest
from tkk_editor_core import analyze

def fixture(wells, routes):
    return dict(job_id='synthetic', fingerprint='synthetic', protected={},
                wells=[dict(id=k, xyz=list(p)) for k, p in wells],
                routes=[dict(id=k, points=[list(p) for p in ps]) for k, ps in routes])

def warnings(result):
    return [w['code'] for w in result['warnings']]

class SyntheticTopologyRegression(unittest.TestCase):
    def test_dangling_route_does_not_invent_a_well(self):
        data=fixture([('A',[0,0,0])],[('r',[[0,0,0],[20,0,0]])])
        original=copy.deepcopy(data)
        result=analyze(data)
        self.assertIn('UNRESOLVED_CONNECTION',warnings(result))
        self.assertEqual(result['spans'],[])
        self.assertEqual(set(result['numbering']),{'A'})
        self.assertEqual(data,original)

    def test_xy_crossing_does_not_create_a_node(self):
        data=fixture(
            [('A',[-40,0,0]),('B',[40,0,0]),('C',[0,-30,0]),('D',[0,30,0])],
            [('h',[[-40,0,0],[40,0,0]]),('v',[[0,-30,0],[0,30,0]])])
        result=analyze(data)
        self.assertEqual(sorted(round(s['length_m'],3) for s in result['spans']),[60,80])
        self.assertEqual(len(result['spans']),2)

    def test_near_duplicate_wells_same_station_are_rejected(self):
        data=fixture(
            [('A',[0,0,0]),('B',[20,0,0]),('C',[20,.4,0]),('D',[40,0,0])],
            [('r',[[0,0,0],[40,0,0]])])
        with self.assertRaisesRegex(ValueError,'Ambiguous connection'):
            analyze(data)

    def test_self_returning_route_is_warning_not_span(self):
        data=fixture([('A',[0,0,0])],
                     [('loop',[[0,0,0],[20,0,0],[20,20,0],[0,0,0]])])
        result=analyze(data)
        self.assertIn('SELF_RETURNING_SPAN',warnings(result))
        self.assertEqual(result['spans'],[])

    def test_z_separated_xy_crossing_does_not_create_a_node(self):
        data=fixture(
            [('A',[-20,0,-1]),('B',[20,0,-1]),('C',[0,-20,-3]),('D',[0,20,-3])],
            [('h',[[-20,0,-1],[20,0,-1]]),('v',[[0,-20,-3],[0,20,-3]])])
        result=analyze(data)
        self.assertEqual(sorted(round(s['length_m'],3) for s in result['spans']),[40,40])

    def test_json_roundtrip_is_repeatable_and_read_only(self):
        data=fixture(
            [('A',[0,0,0]),('B',[30,0,0]),('C',[60,0,0])],
            [('r',[[0,0,0],[60,0,0]])])
        original=copy.deepcopy(data)
        first=analyze(data)
        second=analyze(json.loads(json.dumps(data)))
        self.assertEqual(first,second)
        self.assertEqual(data,original)
        self.assertEqual(sorted(round(s['length_m'],3) for s in second['spans']),[30,30])

if __name__=='__main__':
    unittest.main()
