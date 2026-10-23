import json
import tempfile
import unittest
from pathlib import Path
from nss_engine.preflight_v039 import check_preview, check_file

BASE = {"schema_version":"0.31", "kind":"route_preview", "units":"unverified_raw_drawing_units", "requires_engineer_approval":True, "source_drawing":"test.dwg", "routes":[{"id":"route_A", "points":[[0,0],[10,0]]}]}

def sample(): return json.loads(json.dumps(BASE))

class PreflightTests(unittest.TestCase):
    def test_valid(self): self.assertTrue(check_preview(sample(), "test.dwg")["ok"])
    def test_wrong_drawing(self): self.assertIn("drawing_mismatch",check_preview(sample(), "other.dwg")["errors"])
    def test_missing_approval(self):
        d=sample();d["requires_engineer_approval"]=False;self.assertFalse(check_preview(d)["ok"])
    def test_duplicate_id(self):
        d=sample();d["routes"].append(d["routes"][0]);self.assertIn("route_1:duplicate_id",check_preview(d)["errors"])
    def test_nan(self):
        d=sample();d["routes"][0]["points"][1][0]=float("nan");self.assertFalse(check_preview(d)["ok"])
    def test_degenerate(self):
        d=sample();d["routes"][0]["points"]=[[1,1],[1,1]];self.assertFalse(check_preview(d)["ok"])
    def test_bad_count(self):
        d=sample();d["routes"]=[];self.assertFalse(check_preview(d)["ok"])
    def test_bad_id(self):
        d=sample();d["routes"][0]["id"]="../unsafe";self.assertFalse(check_preview(d)["ok"])
    def test_repeated_point_warning(self):
        d=sample();d["routes"][0]["points"]=[[0,0],[0,0],[10,0]];self.assertTrue(check_preview(d)["ok"]);self.assertTrue(any("repeated" in x for x in check_preview(d)["warnings"]))
    def test_missing_file(self): self.assertFalse(check_file("/missing/nss.json")["ok"])
    def test_invalid_json(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/"bad.json";p.write_text("{bad",encoding="utf8");self.assertFalse(check_file(p)["ok"])
    def test_large_file(self):
        with tempfile.TemporaryDirectory() as t:
            p=Path(t)/"large.json";p.write_bytes(b" " * 8_000_001);self.assertIn("file_too_large",check_file(p)["errors"])
