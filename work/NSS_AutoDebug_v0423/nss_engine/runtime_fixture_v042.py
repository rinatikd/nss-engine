"""Synthetic five-object DXF factory; never reads or writes a user drawing."""
import ezdxf


def create_document():
    doc = ezdxf.new('R2018')
    doc.units = 6
    model = doc.modelspace()
    model.add_line((0, 0, 2), (0, 0, 7))
    model.add_lwpolyline([(0, 0, 1), (2, 0, 0)], format='xyb', close=True)
    model.add_lwpolyline([(0, 0, -1), (2, 0, 0)], format='xyb',
                         dxfattribs={'extrusion': (0, 1, 0), 'elevation': 4})
    doc.blocks.new('NSS_KKS_TEST')
    block = model.add_blockref('NSS_KKS_TEST', (10, 20, 3))
    block.add_attrib('CODE', 'ККС-1')
    model.add_circle((50, 50), 2)
    return doc
