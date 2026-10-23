import unittest
from nss_engine.native_v033 import normalize

BASE={'schema_version':'0.33','drawing_units':'raw_drawing_units','segments':[
 {'handle':'1:0','layer':'NSS','a':{'x':0,'y':0},'b':{'x':5,'y':0}},
 {'handle':'2:0','layer':'WATER','a':{'x':1,'y':1},'b':{'x':2,'y':1}}]}
MAP={'NSS':'network','WATER':'water'}
class NativeTests(unittest.TestCase):
 def test_partition(self):
  r=normalize(BASE,MAP)
  self.assertEqual(len(r['features']),2)
  self.assertEqual(len(r['obstacle_candidates']),1)
 def test_unknown(self):
  r=normalize({**BASE,'segments':[{'handle':'3','layer':'?','a':{'x':0,'y':0},'b':{'x':1,'y':0}}]},MAP)
  self.assertEqual(len(r['obstacle_candidates']),0)
  self.assertTrue(any('not classified' in w for w in r['warnings']))
 def test_version(self):
  with self.assertRaises(ValueError):normalize({**BASE,'schema_version':'0.32'},MAP)
 def test_units(self):
  with self.assertRaises(ValueError):normalize({**BASE,'drawing_units':'metres'},MAP)
 def test_invalid(self):
  r=normalize({**BASE,'segments':[{'handle':'bad','layer':'NSS','a':{'x':float('nan'),'y':0},'b':{'x':1,'y':0}}]},MAP)
  self.assertEqual(len(r['features']),0)
  self.assertTrue(any('invalid geometry' in w for w in r['warnings']))
 def test_empty(self):
  r=normalize({**BASE,'segments':[]},MAP)
  self.assertEqual(r['features'],[])
 def test_mapping_case(self):
  r=normalize(BASE,{'nss':'network','water':'water'})
  self.assertEqual(len(r['obstacle_candidates']),1)
