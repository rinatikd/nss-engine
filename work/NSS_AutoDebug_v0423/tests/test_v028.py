import unittest
from nss_engine.optimization_v028 import Weights,optimize,compare
from nss_engine.routing_v027 import Rect

class MultiCriteriaTests(unittest.TestCase):
    def test_straight(self):
        r=optimize((0,0),(4,0),margin=1)
        self.assertEqual((r.status,r.length,r.bends),('OK',4,0))
    def test_zero(self):
        self.assertEqual(optimize((0,0),(0,0),margin=0).points,((0,0),))
    def test_obstacle(self):
        r=optimize((0,0),(6,0),[Rect(2,-1,4,1)],margin=2)
        self.assertEqual(r.status,'OK');self.assertGreater(r.length,6)
    def test_blocked(self):
        self.assertEqual(optimize((0,0),(2,0),[Rect(-1,-1,1,1)]).status,'BLOCKED')
    def test_unaligned(self):
        self.assertEqual(optimize((0,0),(1.5,0)).status,'UNSUPPORTED')
    def test_limit(self):
        self.assertEqual(optimize((0,0),(100,0),max_cells=10).status,'LIMIT')
    def test_weights_validation(self):
        with self.assertRaises(ValueError):Weights(0,1,1)
        with self.assertRaises(ValueError):Weights(1,-1,1)
    def test_soft_zone_penalty(self):
        zone=Rect(2,-.2,4,.2)
        shortest=optimize((0,0),(6,0),soft_zones=[zone],weights=Weights(1,0,0),margin=2)
        avoid=optimize((0,0),(6,0),soft_zones=[zone],weights=Weights(1,0,20),margin=2)
        self.assertLess(avoid.soft_zone_length,shortest.soft_zone_length)
    def test_turn_penalty(self):
        r=optimize((0,0),(4,3),weights=Weights(1,100,0),margin=1)
        self.assertEqual(r.bends,1)
    def test_compare(self):
        result=compare((0,0),(3,0),margin=1)
        self.assertEqual(set(result),{'shortest','few_bends','avoid_soft_zones','balanced'})
        self.assertTrue(all(v['status']=='OK' for v in result.values()))
    def test_invalid_zones(self):
        with self.assertRaises(ValueError):optimize((0,0),(1,0),soft_zones=[object()])
    def test_no_route(self):
        r=optimize((0,0),(2,0),[Rect(.5,-3,1.5,3)],margin=0)
        self.assertEqual(r.status,'NO_ROUTE')
    def test_deterministic(self):
        a=compare((0,0),(5,2),margin=1)
        self.assertEqual(a,compare((0,0),(5,2),margin=1))

if __name__=='__main__':unittest.main()
