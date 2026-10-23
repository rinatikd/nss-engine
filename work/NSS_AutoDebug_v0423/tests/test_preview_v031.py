import unittest
from nss_engine.preview_v031 import preview_from_report

class PreviewTests(unittest.TestCase):
    def setUp(self):
        self.report={'schema_version':'0.30','routes':{'shortest':{'status':'OK','points':[[0,0],[1,0]]}}}
    def test_success(self):
        p=preview_from_report(self.report)
        self.assertEqual(p['schema_version'],'0.31')
        self.assertEqual(len(p['routes']),1)
        self.assertTrue(p['requires_engineer_approval'])
    def test_version(self):
        self.report['schema_version']='0.29'
        with self.assertRaises(ValueError): preview_from_report(self.report)
    def test_nonfinite(self):
        self.report['routes']['shortest']['points'][1][0]=float('nan')
        with self.assertRaises(ValueError): preview_from_report(self.report)
    def test_empty(self):
        self.report['routes']={}
        with self.assertRaises(ValueError): preview_from_report(self.report)
    def test_bad_shape(self):
        self.report['routes']['shortest']['points']=[[0,0],[1,0,3]]
        with self.assertRaises(ValueError): preview_from_report(self.report)
    def test_rejected_routes(self):
        self.report['routes']['other']={'status':'NO_PATH'}
        self.assertEqual(len(preview_from_report(self.report)['routes']),1)
    def test_too_many(self):
        self.report['routes']['shortest']['points']=[[i,0] for i in range(20001)]
        with self.assertRaises(ValueError): preview_from_report(self.report)
    def test_degenerate(self):
        self.report['routes']['shortest']['points']=[[0,0],[0,0]]
        with self.assertRaises(ValueError): preview_from_report(self.report)
    def test_bad_drawing(self):
        with self.assertRaises(ValueError): preview_from_report(self.report,source_drawing='a'*261)
