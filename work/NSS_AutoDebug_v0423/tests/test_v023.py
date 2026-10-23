import unittest
from nss_engine.analyzer import Segment,Well
from nss_engine.analyzer_v023 import analyze
class V023(unittest.TestCase):
 def test_connected_chain(self):
  r=analyze([Segment('a',(0,0),(1,0)),Segment('b',(1,0),(2,0))]);self.assertEqual(r['summary']['components'],1)
 def test_t_junction(self):
  r=analyze([Segment('a',(0,0),(4,0)),Segment('b',(2,0),(2,2))]);self.assertEqual(r['summary']['components'],1)
 def test_disconnected(self):
  r=analyze([Segment('a',(0,0),(1,0)),Segment('b',(5,0),(6,0))]);self.assertEqual(r['summary']['components'],2)
  self.assertEqual(sum(x['code']=='DISCONNECTED_COMPONENT' for x in r['findings']),1)
 def test_duplicate(self):
  r=analyze([Segment('a',(0,0),(1,0)),Segment('b',(1,0),(0,0))]);self.assertEqual(sum(x['code']=='DUPLICATE_SEGMENT' for x in r['findings']),1)
 def test_crossing(self):
  r=analyze([Segment('a',(0,0),(2,0))],utilities=[Segment('u',(1,-1),(1,1))]);self.assertEqual(sum(x['code']=='UTILITY_CROSSING' for x in r['findings']),1)
 def test_well(self):
  r=analyze([Segment('a',(0,0),(2,0))],[Well('w',(1,1))]);self.assertIn('UNCONNECTED_WELL',[x['code'] for x in r['findings']])
 def test_empty(self):self.assertEqual(analyze([])['summary']['components'],0)
 def test_invalid_handle(self):
  with self.assertRaises(ValueError):analyze([Segment('x',(0,0),(1,0)),Segment('x',(2,0),(3,0))])
 def test_invalid_coordinate(self):
  with self.assertRaises(ValueError):analyze([Segment('x',(float('inf'),0),(1,0))])
 def test_zero_length(self):
  r=analyze([Segment('x',(0,0),(0,0))]);self.assertIn('ZERO_LENGTH',[x['code'] for x in r['findings']])
