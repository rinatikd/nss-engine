"""Create a NEW tiny DXF and preview fixture; never opens an existing drawing."""
import argparse
import json
from pathlib import Path
import sys
import ezdxf
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nss_engine.preview_v031 import preview_from_report

p = argparse.ArgumentParser()
p.add_argument('--out', required=True, type=Path)
a = p.parse_args()
if a.out.exists():
    p.error('output must be new')
a.out.mkdir(parents=True)
doc = ezdxf.new('R2018'); doc.units = 6
model = doc.modelspace()
model.add_line((0, 0, 2), (0, 0, 7))
model.add_lwpolyline([(0, 0, 1), (2, 0, 0)], format='xyb', close=True)
model.add_lwpolyline([(0, 0, -1), (2, 0, 0)], format='xyb', dxfattribs={'extrusion': (0, 1, 0), 'elevation': 4})
doc.blocks.new('NSS_KKS_TEST')
b = model.add_blockref('NSS_KKS_TEST', (10, 20, 3)); b.add_attrib('CODE', 'ККС-1')
model.add_circle((50, 50), 2)
doc.saveas(a.out/'runtime_fixture_v042.dxf')
preview = preview_from_report({'schema_version': '0.30', 'routes': {'fixture': {'status': 'OK', 'points': [[0, 0], [10, 0]]}}}, source_drawing='runtime_fixture_v042.dwg')
(a.out/'preview_v031.json').write_text(json.dumps(preview, ensure_ascii=False, indent=2), encoding='utf8')
(a.out/'expected.json').write_text(json.dumps(dict(modelspace_objects=5, lines=1, polylines=2, blocks=1, other=1, v042_exported=4, v042_skipped=1, insunits_code=6, line_length=5, native_runtime='NOT_TESTED'), indent=2), encoding='utf8')
print(a.out.resolve())
