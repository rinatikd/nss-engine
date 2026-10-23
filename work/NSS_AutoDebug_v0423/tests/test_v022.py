import unittest
from nss_engine.analyzer import Segment,Well
from nss_engine.analyzer_v022 import analyze
from nss_engine.spatial import SegmentGrid
class Tests(unittest.TestCase):
 def test_index_across_cells(self):
  s=Segment('a',(-12,-2),(22,2)); idx=SegmentGrid([s],5)
  self.assertEqual(list(idx.candidates((0,-3),(0,3))),[s])
 def test_no_false_bbox_crossing(self):
  r=analyze([Segment('a',(0,0),(2,2))],utilities=[Segment('b',(0,2),(0,3))])
  self.assertFalse(any(f['code']=='UTILITY_CROSSING' for f in r['findings']))
 def test_crossing(self):
  r=analyze([Segment('a',(0,0),(10,0))],utilities=[Segment('b',(5,-2),(5,2))],cell_size=1)
  self.assertEqual([f['code'] for f in r['findings']].count('UTILITY_CROSSING'),1)
 def test_duplicate_reverse(self):
  r=analyze([Segment('a',(0,0),(10,0)),Segment('b',(10,0),(0,0))],cell_size=2)
  self.assertEqual([f['code'] for f in r['findings']].count('DUPLICATE_SEGMENT'),1)
 def test_well_near_boundary(self):
  r=analyze([Segment('a',(0,0),(10,0))],[Well('w',(5,.04))],tolerance=.05,cell_size=1)
  self.assertNotIn('UNCONNECTED_WELL',[f['code'] for f in r['findings']])
 def test_well_far(self):
  r=analyze([Segment('a',(0,0),(10,0))],[Well('w',(5,1))],cell_size=1)
  self.assertIn('UNCONNECTED_WELL',[f['code'] for f in r['findings']])
 def test_empty(self): self.assertEqual(analyze([])['summary']['findings'],0)
 def test_invalid_cell(self):
  with self.assertRaises(ValueError): SegmentGrid([],0)
 def test_invalid_coordinates(self):
  with self.assertRaises(ValueError): analyze([Segment('x',(float('nan'),0),(1,0))])
 def test_legacy_open_ends(self):
  r=analyze([Segment('a',(0,0),(1,0))]); self.assertEqual(sum(f['code']=='OPEN_END' for f in r['findings']),2)
if __name__=='__main__': unittest.main()
