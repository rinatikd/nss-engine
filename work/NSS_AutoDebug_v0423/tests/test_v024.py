import unittest
from nss_engine.analyzer import Segment,Well
from nss_engine.analyzer_v024 import analyze
class V024(unittest.TestCase):
 def test_interior_crossing_is_not_junction(self):
  r=analyze([Segment('a',(-2,0),(2,0)),Segment('b',(0,-2),(0,2))]);self.assertEqual(r['summary']['components'],2);self.assertIn('AMBIGUOUS_NETWORK_CROSSING',[f['code'] for f in r['findings']])
 def test_well_connects_crossing(self):
  r=analyze([Segment('a',(-2,0),(2,0)),Segment('b',(0,-2),(0,2))],[Well('w',(0,0))]);self.assertEqual(r['summary']['components'],1)
 def test_well_disabled_policy(self):
  r=analyze([Segment('a',(-2,0),(2,0)),Segment('b',(0,-2),(0,2))],[Well('w',(0,0))],junction_policy='endpoints_only');self.assertEqual(r['summary']['components'],2)
 def test_t_junction(self):
  r=analyze([Segment('a',(0,0),(4,0)),Segment('b',(2,0),(2,2))]);self.assertEqual(r['summary']['components'],1)
 def test_well_mapping(self):
  r=analyze([Segment('a',(0,0),(2,0))],[Well('w',(1,0))]);self.assertEqual(r['well_connections']['w'],['a'])
 def test_bad_policy(self):
  with self.assertRaises(ValueError):analyze([],junction_policy='all_crossings')
 def test_no_segments(self):self.assertEqual(analyze([])['summary']['components'],0)
 def test_negative_coordinates(self):self.assertEqual(analyze([Segment('a',(-5,-5),(-2,-2))])['summary']['components'],1)
