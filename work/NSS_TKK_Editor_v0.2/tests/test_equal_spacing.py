import unittest
from equal_spacing import divisions
class SpacingTests(unittest.TestCase):
    def test_equal_target(self):
        for length,n in [(120,2),(180,3),(250,4),(300,5),(102,2)]:self.assertEqual(divisions(length),n)
    def test_short_fixed_spans_are_not_moved(self):
        self.assertEqual(divisions(35),1);self.assertEqual(divisions(84),1)
    def test_maximum_and_feasible_target(self):
        for length in range(1,5001):
            n=divisions(length);self.assertLessEqual(length/n,120+1e-8)
            feasible=any(50<=length/i<=70 for i in range(1,max(2,length//50+2)))
            if feasible:self.assertTrue(50-1e-8<=length/n<=70+1e-8)
if __name__=='__main__':unittest.main()
