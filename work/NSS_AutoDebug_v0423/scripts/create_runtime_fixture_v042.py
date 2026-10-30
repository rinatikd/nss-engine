"""Create a NEW tiny DXF and preview fixture; never opens an existing drawing."""
import argparse
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from nss_engine.preview_v031 import preview_from_report
from nss_engine.runtime_fixture_v042 import create_document

p = argparse.ArgumentParser()
p.add_argument('--out', required=True, type=Path)
a = p.parse_args()
if a.out.exists():
    p.error('output must be new')
a.out.mkdir(parents=True)
doc = create_document()
doc.saveas(a.out/'runtime_fixture_v042.dxf')
preview = preview_from_report({'schema_version': '0.30', 'routes': {'fixture': {'status': 'OK', 'points': [[0, 0], [10, 0]]}}}, source_drawing='runtime_fixture_v042.dwg')
(a.out/'preview_v031.json').write_text(json.dumps(preview, ensure_ascii=False, indent=2), encoding='utf8')
(a.out/'expected.json').write_text(json.dumps(dict(modelspace_objects=5, lines=1, polylines=2, blocks=1, other=1, v042_exported=4, v042_skipped=1, insunits_code=6, line_length=5, native_runtime='NOT_TESTED'), indent=2), encoding='utf8')
print(a.out.resolve())
