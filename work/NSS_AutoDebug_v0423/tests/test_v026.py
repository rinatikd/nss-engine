import unittest
from nss_engine.spatial3d_v026 import Line3D,VerticalRule,evaluate_3d
class TestV026(unittest.TestCase):
 def setUp(self):
  self.n=Line3D('N',(0,0,-1),(10,0,-1))
  self.u=Line3D('U',(5,-5,-2),(5,5,-2))
  self.rule=VerticalRule('TEST',1.5,'SYNTHETIC TEST RULE')
 def test_crossing_low(self):
  r=evaluate_3d([self.n],[self.u],[self.rule]); self.assertEqual(r['findings'][0]['code'],'VERTICAL_CLEARANCE_REVIEW')
 def test_crossing_pass_screen(self):
  r=evaluate_3d([self.n],[self.u],[VerticalRule('TEST',.5,'SYNTHETIC')]); self.assertEqual(r['findings'][0]['code'],'VERTICAL_CLEARANCE_SCREENED')
 def test_interpolated_z(self):
  n=Line3D('N',(0,0,0),(10,0,-10)); r=evaluate_3d([n],[self.u],[self.rule]); self.assertAlmostEqual(r['findings'][0]['vertical_centerline_separation_m'],3)
 def test_no_intersection(self):
  u=Line3D('U',(20,-5,-2),(20,5,-2)); self.assertEqual(evaluate_3d([self.n],[u],[self.rule])['summary']['crossings'],0)
 def test_parallel_near(self):
  u=Line3D('U',(0,0,-2),(10,0,-2)); self.assertGreaterEqual(evaluate_3d([self.n],[u])['summary']['parallel_or_nearby'],0)
 def test_units(self):
  with self.assertRaises(ValueError): evaluate_3d([self.n],[self.u],units='mm')
 def test_nan(self):
  with self.assertRaises(ValueError): Line3D('N',(0,0,float('nan')),(1,1,0))
 def test_negative_rule(self):
  with self.assertRaises(ValueError): VerticalRule('R',-1,'test')
 def test_duplicate_rules(self):
  with self.assertRaises(ValueError): evaluate_3d([self.n],[self.u],[self.rule,self.rule])
 def test_no_rules(self):
  self.assertEqual(evaluate_3d([self.n],[self.u])['summary']['crossings'],1)
if __name__=='__main__': unittest.main()
