import unittest,networkx as nx,ezdxf,tempfile
from pathlib import Path
from number_wells import assign_numbers
from fes_format import add_label,STYLE,HEIGHT,MASK_SCALE

class NumberingTests(unittest.TestCase):
    def test_protected_and_branched(self):
        wells={str(i):[i,0] for i in range(30)};g=nx.Graph();g.add_nodes_from(wells)
        for i in range(23):g.add_edge(str(i),str(i+1),weight=10)
        g.add_edge('20','24',weight=50);g.add_edge('24','25',weight=60)
        g.add_edge('22','26',weight=30);g.add_edge('26','27',weight=40)
        numbers=assign_numbers(wells,g,[str(i) for i in range(24)])
        self.assertEqual([numbers[str(i)] for i in range(24)],list(range(1,25)))
        self.assertEqual(set(numbers.values()),set(range(1,31)))
        self.assertEqual(numbers['24'],25);self.assertEqual(numbers['25'],26)
    def test_invalid_protected_sequence_rejected(self):
        with self.assertRaises(ValueError):assign_numbers({'a':[0,0]},nx.Graph(),['a']*24)

class FormattingTests(unittest.TestCase):
    def test_mtext_has_no_background_mask(self):
        d=ezdxf.new('R2018');d.styles.new(STYLE,dxfattribs=dict(font='isocpeui.ttf',height=5))
        add_label(d.modelspace(),'КК-24',(10,20,0),'0',rotation=45,centered=True)
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/'format.dxf';d.saveas(p);loaded=ezdxf.readfile(p);e=loaded.modelspace().query('MTEXT').first
            self.assertEqual(e.plain_text(),'КК-24');self.assertEqual(e.dxf.style,STYLE)
            self.assertEqual(e.dxf.char_height,HEIGHT);self.assertNotIn('bg_fill',e.dxf.all_existing_dxf_attribs())
            self.assertEqual(e.dxf.rotation,45);self.assertEqual(loaded.styles.get(STYLE).dxf.height,5)
    def test_text_is_not_baked_with_inline_font_override(self):
        d=ezdxf.new('R2018');d.styles.new(STYLE,dxfattribs=dict(font='isocpeui.ttf'))
        e=add_label(d.modelspace(),'L=57м',(0,0,0),'0')
        self.assertEqual(e.text,'L=57м');self.assertEqual(e.dxf.char_height,1.25)
if __name__=='__main__':unittest.main()
