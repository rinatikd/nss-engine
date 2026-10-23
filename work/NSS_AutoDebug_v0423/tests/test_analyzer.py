import unittest
from nss_engine import Segment, Well, analyze
class AnalyzerTests(unittest.TestCase):
    def test_connected_endpoints(self):
        r=analyze([Segment('A',(0,0),(1,0)),Segment('B',(1,0),(2,0))])
        self.assertEqual(sum(x['code']=='OPEN_END' for x in r['findings']),2)
    def test_tolerance_grid_boundary(self):
        r=analyze([Segment('A',(-1,0),(.049,0)),Segment('B',(.051,0),(1,0))],tolerance=.05)
        self.assertEqual(sum(x['code']=='OPEN_END' for x in r['findings']),2)
    def test_duplicates(self):
        r=analyze([Segment('A',(0,0),(2,0)),Segment('B',(2,0),(0,0))])
        self.assertIn('DUPLICATE_SEGMENT',[x['code'] for x in r['findings']])
    def test_crossing(self):
        r=analyze([Segment('N',(0,0),(2,0))],utilities=[Segment('U',(1,-1),(1,1))])
        x=next(x for x in r['findings'] if x['code']=='UTILITY_CROSSING')
        self.assertEqual(x['point'],[1.0,0.0])
    def test_well(self):
        r=analyze([Segment('A',(0,0),(1,0))],[Well('W',(4,4))])
        self.assertIn('UNCONNECTED_WELL',[x['code'] for x in r['findings']])
    def test_zero_length(self):
        r=analyze([Segment('A',(0,0),(0,0))])
        self.assertIn('ZERO_LENGTH',[x['code'] for x in r['findings']])
    def test_invalid_tolerance(self):
        with self.assertRaises(ValueError): analyze([],tolerance=0)
if __name__=='__main__': unittest.main()
