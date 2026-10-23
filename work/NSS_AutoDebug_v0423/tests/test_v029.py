import unittest
from dataclasses import replace
from nss_engine.cost_v029 import ConstructionInputs, estimate, route_length, compare_estimates

C = ConstructionInputs(0.6, 1.0, 2, 1, 1000, 300, 500, 20000,
                       1, 10000, 0.1, 200, 0.1)
P = [(0,0),(3,0),(3,4)]

class TestV029(unittest.TestCase):
    def test_length(self): self.assertEqual(route_length(P),7)
    def test_excavation(self): self.assertAlmostEqual(estimate(P,C)['quantities']['excavation_m3'],4.2)
    def test_pipes(self): self.assertEqual(estimate(P,C)['quantities']['pipe_length_m'],14)
    def test_wells(self): self.assertEqual(estimate(P,C)['costs']['wells'],20000)
    def test_crossings(self): self.assertEqual(estimate(P,C)['costs']['special_crossings'],10000)
    def test_spoil(self): self.assertAlmostEqual(estimate(P,C)['quantities']['spoil_m3'],0.42)
    def test_total(self):
        e=estimate(P,C)
        self.assertAlmostEqual(e['total'],e['subtotal']*1.1)
    def test_per_m(self):
        e=estimate(P,C)
        self.assertAlmostEqual(e['cost_per_route_m'],e['total']/7)
    def test_zero_length(self):
        with self.assertRaises(ValueError): route_length([(0,0),(0,0)])
    def test_nan(self):
        with self.assertRaises(ValueError): route_length([(0,0),(float('nan'),1)])
    def test_bad_rate(self):
        with self.assertRaises(ValueError): estimate(P,replace(C,pipe_rate_per_m=-1))
    def test_bad_count(self):
        with self.assertRaises(ValueError): estimate(P,replace(C,well_count=1.5))
    def test_fraction(self):
        with self.assertRaises(ValueError): estimate(P,replace(C,spoil_fraction=1.2))
    def test_comparison(self):
        result=compare_estimates({'short':[(0,0),(2,0)],'long':P},{'short':C,'long':C})
        self.assertEqual(result['ranking_lowest_cost_first'][0],'short')
    def test_mixed_currency(self):
        with self.assertRaises(ValueError):
            compare_estimates({'a':P,'b':P},{'a':C,'b':replace(C,currency='USD')})
    def test_missing_config(self):
        with self.assertRaises(ValueError): compare_estimates({'a':P},{})
    def test_empty_routes(self):
        with self.assertRaises(ValueError): compare_estimates({}, {})
