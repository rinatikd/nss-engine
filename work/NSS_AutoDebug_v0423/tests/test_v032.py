import unittest
from nss_engine.intelligence_v032 import analyze_snapshot, classify_layer

class TestV032(unittest.TestCase):
    def setUp(self):
        self.mapping={'UTIL_WATER':'water','NSS_MAIN':'network'}
        self.snapshot={'drawing_units':'raw_drawing_units','segments':[{'handle':'A','layer':'NSS_MAIN','a':{'x':0,'y':0},'b':{'x':10,'y':0}}], 'utilities':[{'handle':'B','layer':'UTIL_WATER','a':{'x':4,'y':-2},'b':{'x':4,'y':2}}]}
    def test_classify_exact(self): self.assertEqual(classify_layer('util_water',self.mapping),'water')
    def test_classify_unknown(self): self.assertEqual(classify_layer('UTIL_GAS',self.mapping),'unknown')
    def test_invalid_category(self):
        with self.assertRaises(ValueError): classify_layer('X',{'X':'nonsense'})
    def test_features(self): self.assertEqual(len(analyze_snapshot(self.snapshot,self.mapping)['features']),2)
    def test_obstacles(self): self.assertEqual(len(analyze_snapshot(self.snapshot,self.mapping)['obstacle_candidates']),1)
    def test_bbox(self): self.assertEqual(analyze_snapshot(self.snapshot,self.mapping,1)['obstacle_candidates'][0]['bbox'],[3,-3,5,3])
    def test_unknown_no_obstacle(self): self.assertEqual(len(analyze_snapshot(self.snapshot,{})['obstacle_candidates']),0)
    def test_negative_clearance(self):
        with self.assertRaises(ValueError): analyze_snapshot(self.snapshot,self.mapping,-1)
    def test_nan_clearance(self):
        with self.assertRaises(ValueError): analyze_snapshot(self.snapshot,self.mapping,float('nan'))
    def test_bad_point(self):
        self.snapshot['utilities'][0]['a']['x']=float('nan')
        self.assertTrue(any('invalid geometry' in w for w in analyze_snapshot(self.snapshot,self.mapping)['warnings']))
    def test_zero_length(self):
        self.snapshot['segments'][0]['b']={'x':0,'y':0}
        self.assertTrue(any('zero length' in w for w in analyze_snapshot(self.snapshot,self.mapping)['warnings']))
    def test_invalid_array(self):
        self.snapshot['segments']={}
        with self.assertRaises(ValueError): analyze_snapshot(self.snapshot,self.mapping)
    def test_no_mutation(self):
        import copy
        original=copy.deepcopy(self.snapshot)
        analyze_snapshot(self.snapshot,self.mapping)
        self.assertEqual(original,self.snapshot)
