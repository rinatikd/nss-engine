import json,tempfile,unittest
from pathlib import Path
from nss_engine.workflow_v030 import run,write_report,_xy

class WorkflowTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name)
        self.snapshot=self.root/'snapshot.json'
        self.snapshot.write_text(json.dumps({'schema_version':'0.22','segments':[], 'wells':[], 'utilities':[], 'warnings':[]}),encoding='utf-8')
        self.plan=self.root/'plan.json'
        self.config={'trench_width_m':.6,'trench_depth_m':1,'pipe_count':2,'well_count':1,'excavation_rate_per_m3':1000,'backfill_rate_per_m3':300,'pipe_rate_per_m':500,'well_rate_each':20000}
        self.data={'schema_version':'0.30','start':[0,0],'goal':[5,0],'step':1,'margin':3,'construction':{'shortest':self.config}}
    def save(self):self.plan.write_text(json.dumps(self.data),encoding='utf-8')
    def test_integrated(self):
        self.save();r=run(self.snapshot,self.plan)
        self.assertEqual(r['cost_ranking'],['shortest']);self.assertEqual(r['routes']['shortest']['status'],'OK')
        self.assertEqual(r['status'],'conceptual_review_only')
    def test_unpriced(self):
        self.data.pop('construction');self.save();r=run(self.snapshot,self.plan)
        self.assertEqual(r['cost_ranking'],[]);self.assertIn('shortest',r['unpriced_routes'])
    def test_no_source_mutation(self):
        self.save();before=self.snapshot.read_bytes();run(self.snapshot,self.plan);self.assertEqual(before,self.snapshot.read_bytes())
    def test_report(self):
        self.save();r=run(self.snapshot,self.plan);out=self.root/'out'/'report.json';write_report(r,out)
        self.assertEqual(json.loads(out.read_text(encoding='utf-8'))['schema_version'],'0.30')
    def test_reject_bad_plan_schema(self):
        self.data['schema_version']='0.29';self.save()
        with self.assertRaises(ValueError):run(self.snapshot,self.plan)
    def test_reject_nan_coordinate(self):
        with self.assertRaises(ValueError):_xy([float('nan'),0])
    def test_reject_bool_coordinate(self):
        with self.assertRaises(ValueError):_xy([True,0])
    def test_reject_invalid_snapshot(self):
        self.save();self.snapshot.write_text('{"schema_version":"bad"}',encoding='utf-8')
        with self.assertRaises(ValueError):run(self.snapshot,self.plan)
if __name__=='__main__':unittest.main()
