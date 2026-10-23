import unittest,json,copy
from pathlib import Path
from tkk_editor_core import analyze
class RealDrawingTests(unittest.TestCase):
 def test_real_snapshot_protected_numbers_and_spans(self):
  root=Path(__file__).resolve().parents[1] if (Path(__file__).resolve().parents[1]/'evidence').exists() else Path(__file__).resolve().parents[2]/'output/DWG_NSS_20261020_Review'
  p=root/'evidence/editor_fixture.json' if (root/'evidence').exists() else root/'editor_fixture.json'
  data=json.loads(p.read_text('utf8'));before=copy.deepcopy(data);r=analyze(data)
  self.assertEqual(data,before);self.assertEqual(len(r['leaders']),112);self.assertEqual(len(r['spans']),109)
  self.assertTrue(all(s['start']!=s['end'] for s in r['spans']))
  self.assertEqual({k:r['numbering'][k] for k in data['protected']},data['protected'])
  self.assertEqual([data['protected'][k] for k in ['260DE2','260F43','260DFB','260E18']],[21,22,23,24])
  self.assertTrue(all(s['length_m']<=120 for s in r['spans']))
  for field in ('text_route_collisions','text_well_collisions','text_caption_collisions','text_text_collisions'):self.assertEqual(r['layout_checks'][field],0)
if __name__=='__main__':unittest.main()
