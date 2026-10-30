import copy,unittest
from tkk_editor_core import analyze

def fixture():return dict(job_id='test',fingerprint='test',protected={'A':1},wells=[dict(id=k,xyz=[x,0,0]) for k,x in [('A',0),('B',60),('C',120)]],routes=[dict(id='r',points=[[0,0,0],[120,0,0]])])
def lengths(result):return sorted(round(s['length_m'],5) for s in result['spans'])
class EditorTests(unittest.TestCase):
    def test_baseline_read_only_and_layout(self):
        data=fixture();before=copy.deepcopy(data);r=analyze(data)
        self.assertEqual(lengths(r),[60,60]);self.assertEqual(data,before)
        self.assertEqual(r['numbering']['A'],1);self.assertEqual(len(r['leaders']),3)
        for field in ('text_route_collisions','text_well_collisions','text_caption_collisions','text_text_collisions'):self.assertEqual(r['layout_checks'][field],0)
    def test_legacy_long_axis_metadata_cannot_request_source_rotation(self):
        data=fixture()
        for well,axis in zip(data['wells'],(0.0,1.5707963267948966,-0.4)):
            well['long_axis']=axis
        before=copy.deepcopy(data)
        result=analyze(data)
        self.assertFalse(result['source_geometry_changed'])
        self.assertEqual(result['well_rotations'],[])
        self.assertEqual(data,before)
    def test_add_well_splits_span_and_reindexes(self):
        data=fixture();data['wells'].append(dict(id='D',xyz=[30,0,0]));r=analyze(data)
        self.assertEqual(lengths(r),[30,30,60]);self.assertEqual(r['numbering']['D'],25);self.assertEqual(len(set(r['numbering'].values())),4)
    def test_remove_well_merges_span_without_recreating_it(self):
        data=fixture();data['wells']=[w for w in data['wells'] if w['id']!='B'];r=analyze(data)
        self.assertEqual(lengths(r),[120]);self.assertEqual(set(r['numbering']),{'A','C'})
    def test_move_well_recomputes_lengths(self):
        data=fixture();data['wells'][1]['xyz']=[40,0,0];self.assertEqual(lengths(analyze(data)),[40,80])
    def test_move_off_route_produces_warning_without_fake_branch(self):
        data=fixture();data['wells'][1]['xyz']=[40,20,0];r=analyze(data)
        self.assertIn('WELL_OFF_ROUTE',[x['code'] for x in r['warnings']]);self.assertEqual(lengths(r),[120])
    def test_route_and_well_stretch_warns_over_120(self):
        data=fixture();data['routes'][0]['points'][-1]=[200,0,0];data['wells'][-1]['xyz']=[200,0,0];r=analyze(data)
        self.assertIn('SPAN_OVER_120M',[x['code'] for x in r['warnings']]);self.assertEqual(len(r['leaders']),3)
    def test_xy_crossing_not_connected_without_well(self):
        data=dict(protected={'A':1},wells=[dict(id=k,xyz=p) for k,p in [('A',[-60,0,0]),('B',[60,0,0]),('C',[0,-60,0]),('D',[0,60,0])]],routes=[dict(id='h',points=[[-60,0,0],[60,0,0]]),dict(id='v',points=[[0,-60,0],[0,60,0]])])
        r=analyze(data);self.assertEqual(lengths(r),[120,120]);self.assertEqual(len(r['leaders']),4)
    def test_deleted_protected_number_is_not_reused(self):
        data=fixture();data['protected']['B']=2;data['wells']=[w for w in data['wells'] if w['id']!='B'];r=analyze(data)
        self.assertNotIn(2,r['numbering'].values());self.assertIn('PROTECTED_WELL_DELETED',[x['code'] for x in r['warnings']])
    def test_entry_is_boundary_not_well(self):
        data=fixture();data['wells']=data['wells'][:2];data['routes'][0]['building_entry']=True;r=analyze(data)
        self.assertEqual(len(r['leaders']),2);self.assertEqual(lengths(r),[60,60])
    def test_stable_span_keys_and_repeatability(self):
        a=analyze(fixture());b=analyze(fixture());self.assertEqual(a,b)
        self.assertTrue(all(len(c['key'])<255 for c in a['captions']))
    def test_duplicate_id_refused(self):
        data=fixture();data['wells'].append(data['wells'][0])
        with self.assertRaises(ValueError):analyze(data)
if __name__=='__main__':unittest.main()
