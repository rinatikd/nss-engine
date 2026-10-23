import unittest,math
from span_labels import caption_pair
class LabelTests(unittest.TestCase):
    def test_pair_order_and_value(self):
        top,bottom=caption_pair([(0,0),(57,0)],0,57,57)
        self.assertEqual(top['text'],'0/2');self.assertEqual(bottom['text'],'L=57м');self.assertGreater(top['xyz'][1],bottom['xyz'][1])
    def test_readable_reverse_and_vertical(self):
        for points in [[(57,0),(0,0)],[(0,0),(0,57)],[(0,57),(0,0)]]:
            for label in caption_pair(points,0,57,57):self.assertLessEqual(abs(label['rotation']),math.pi/2)
    def test_length_is_chainage_not_chord(self):
        pair=caption_pair([(0,0),(30,0),(30,40)],0,70,70)
        self.assertEqual(pair[1]['text'],'L=70м')
if __name__=='__main__':unittest.main()
