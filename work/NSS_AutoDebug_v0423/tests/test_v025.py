import unittest
from nss_engine.analyzer import Segment
from nss_engine.rules_v025 import ClearanceRule,segment_distance,evaluate
from nss_engine.analyzer_v025 import analyze

class RulesTests(unittest.TestCase):
    def setUp(self):
        self.s=Segment('N',(0,0),(10,0),'NSS')
        self.rule=ClearanceRule('GAS',2,'USER PROVIDED - VERIFY','R1')
    def test_crossing(self):
        self.assertEqual(segment_distance(self.s,Segment('G',(5,-1),(5,1),'GAS')),0)
    def test_parallel(self):
        self.assertAlmostEqual(segment_distance(self.s,Segment('G',(0,1),(10,1),'GAS')),1)
    def test_disjoint(self):
        self.assertAlmostEqual(segment_distance(self.s,Segment('G',(12,0),(15,0),'GAS')),2)
    def test_rule_finding(self):
        r=evaluate([self.s],[Segment('G',(0,1),(10,1),'GAS')],[self.rule]);self.assertEqual(len(r['findings']),1)
    def test_rule_no_finding_at_limit(self):
        r=evaluate([self.s],[Segment('G',(0,2),(10,2),'GAS')],[self.rule]);self.assertEqual(len(r['findings']),0)
    def test_unknown_layer(self):
        r=evaluate([self.s],[Segment('W',(0,1),(10,1),'WATER')],[self.rule]);self.assertEqual(r['unmatched_utility_layers'],['WATER'])
    def test_missing_rules(self):
        self.assertEqual(evaluate([self.s],[],[])['rules_loaded'],0)
    def test_invalid_threshold(self):
        with self.assertRaises(ValueError):ClearanceRule('GAS',-1,'ref','id')
    def test_duplicate_id(self):
        with self.assertRaises(ValueError):evaluate([],[],[self.rule,self.rule])
    def test_combined_report(self):
        r=analyze([self.s],utilities=[Segment('G',(0,1),(10,1),'GAS')],rules=[self.rule]);self.assertEqual(r['schema_version'],'0.25');self.assertFalse(r['engineering_rules']['normative_compliance_verified'])
if __name__=='__main__': unittest.main()
