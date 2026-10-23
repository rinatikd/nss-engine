import unittest
from nss_engine.routing_v027 import Rect,route,report

class RoutingTests(unittest.TestCase):
    def test_straight(self):
        r=route((0,0),(4,0));self.assertEqual(r.status,'OK');self.assertEqual(r.length,4)
    def test_detour(self):
        r=route((0,0),(4,0),[Rect(2,-1,2,1)],margin=2)
        self.assertEqual(r.status,'OK');self.assertGreater(r.length,4)
    def test_clearance(self):
        r=route((0,0),(4,0),[Rect(2,1,2,1)],clearance=1,margin=2)
        self.assertEqual(r.status,'OK');self.assertGreater(r.length,4)
    def test_blocked_start(self):self.assertEqual(route((0,0),(4,0),[Rect(0,0,1,1)]).status,'BLOCKED')
    def test_blocked_end(self):self.assertEqual(route((0,0),(4,0),[Rect(4,0,5,1)]).status,'BLOCKED')
    def test_same_point(self):self.assertEqual(route((1,1),(1,1)).length,0)
    def test_grid_mismatch(self):self.assertEqual(route((0,0),(0.5,1)).status,'UNSUPPORTED')
    def test_grid_limit(self):self.assertEqual(route((0,0),(100,100),max_cells=100).status,'LIMIT')
    def test_invalid_step(self):
        with self.assertRaises(ValueError):route((0,0),(1,0),step=0)
    def test_invalid_rect(self):
        with self.assertRaises(ValueError):Rect(2,0,1,1)
    def test_deterministic(self):
        a=route((0,0),(4,0),[Rect(2,-1,2,1)],margin=2)
        self.assertEqual(a.points,route((0,0),(4,0),[Rect(2,-1,2,1)],margin=2).points)
    def test_json_shape(self):self.assertIn('points',report(route((0,0),(2,0))))
    def test_thin_wall(self):
        r=route((0,0),(2,0),[Rect(.4,-2,.6,2)],margin=1)
        self.assertEqual(r.status,'OK');self.assertGreater(r.length,2)
if __name__=='__main__':unittest.main()
