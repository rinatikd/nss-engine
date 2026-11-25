import tempfile
import unittest
from pathlib import Path

import ezdxf

from tkk_editor_core import analyze


ROUTE_LAYER = "TKK_ROUTE_FIXTURE"
WELL_LAYER = "TKK_WELL_FIXTURE"


def snapshot_from_fixture_dxf(doc):
    """Minimal synthetic mapping; this does not call the AutoCAD .NET adapter."""
    routes = []
    wells = []
    for entity in doc.modelspace():
        if entity.dxf.layer == ROUTE_LAYER and entity.dxftype() == "LINE":
            routes.append({"id": entity.dxf.handle,
                           "points": [list(entity.dxf.start), list(entity.dxf.end)]})
        elif entity.dxf.layer == WELL_LAYER and entity.dxftype() == "CIRCLE":
            wells.append({"id": entity.dxf.handle, "xyz": list(entity.dxf.center)})
    return {"protected": {wells[0]["id"]: 1}, "wells": wells, "routes": routes}


class DxfRoundTripTests(unittest.TestCase):
    def test_synthetic_topology_is_repeatable_after_dxf_save_read(self):
        doc = ezdxf.new("R2010")
        doc.header["$INSUNITS"] = 6  # meter declaration in this synthetic fixture only
        doc.layers.new(ROUTE_LAYER)
        doc.layers.new(WELL_LAYER)
        model = doc.modelspace()
        model.add_line((-10, 0, 0), (10, 0, 0), dxfattribs={"layer": ROUTE_LAYER})
        model.add_line((0, -10, 40), (0, 10, 40), dxfattribs={"layer": ROUTE_LAYER})
        for point in [(-10, 0, 0), (10, 0, 0), (0, -10, 40), (0, 10, 40)]:
            model.add_circle(point, .1, dxfattribs={"layer": WELL_LAYER})

        before_snapshot = snapshot_from_fixture_dxf(doc)
        before = analyze(before_snapshot)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "synthetic_tkk.dxf"
            doc.saveas(path)
            reloaded = ezdxf.readfile(path)

        after_snapshot = snapshot_from_fixture_dxf(reloaded)
        after = analyze(after_snapshot)
        self.assertEqual(before_snapshot, after_snapshot)
        self.assertEqual(before["spans"], after["spans"])
        self.assertEqual(before["warnings"], after["warnings"])
        self.assertEqual(len(after["spans"]), 2)
        self.assertEqual(sorted(round(span["length_m"], 6) for span in after["spans"]), [20] * 2)
        self.assertEqual(after["diagnostics"]["connectivity_inferred"], False)


if __name__ == "__main__":
    unittest.main()
