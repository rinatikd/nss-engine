import json
import tempfile
import unittest
from pathlib import Path
from nss_engine.diagnostics_v034 import validate_snapshot, run

class DiagnosticsV034Tests(unittest.TestCase):
    def base(self):
        return {"schema_version":"0.33", "drawing_units":"raw_drawing_units", "metadata":{"units":"unverified","coordinate_system":"unverified"}, "segments":[{"handle":"1:0","a":{"x":0,"y":0},"b":{"x":1,"y":1}}]}
    def test_valid(self): self.assertTrue(validate_snapshot(self.base())["valid"])
    def test_unit_warning(self): self.assertIn("UNVERIFIED_UNITS", [x["code"] for x in validate_snapshot(self.base())["issues"]])
    def test_crs_warning(self): self.assertIn("UNVERIFIED_CRS", [x["code"] for x in validate_snapshot(self.base())["issues"]])
    def test_version(self):
        d=self.base(); d["schema_version"]="bogus"; self.assertFalse(validate_snapshot(d)["valid"])
    def test_invalid_root(self): self.assertFalse(validate_snapshot([])["valid"])
    def test_bad_segments(self):
        d=self.base(); d["segments"]="wrong"; self.assertFalse(validate_snapshot(d)["valid"])
    def test_duplicate(self):
        d=self.base(); d["segments"].append(d["segments"][0]); self.assertIn("DUPLICATE_HANDLE",[i["code"] for i in validate_snapshot(d)["issues"]])
    def test_zero_length(self):
        d=self.base(); d["segments"][0]["b"]={"x":0,"y":0}; self.assertIn("ZERO_LENGTH",[i["code"] for i in validate_snapshot(d)["issues"]])
    def test_nan(self):
        d=self.base(); d["segments"][0]["a"]["x"]=float("nan"); self.assertFalse(validate_snapshot(d)["valid"])
    def test_missing_handle(self):
        d=self.base(); del d["segments"][0]["handle"]; self.assertIn("MISSING_HANDLE",[i["code"] for i in validate_snapshot(d)["issues"]])
    def test_roundtrip(self):
        with tempfile.TemporaryDirectory() as t:
            a=Path(t)/"in.json"; b=Path(t)/"out.json"
            a.write_text(json.dumps(self.base()),encoding="utf-8")
            self.assertTrue(run(a,b)["valid"])
            self.assertTrue(json.loads(b.read_text(encoding="utf-8"))["valid"])
    def test_bad_json_constant(self):
        with tempfile.TemporaryDirectory() as t:
            a=Path(t)/"in.json"; a.write_text('{"x":NaN}',encoding="utf-8")
            with self.assertRaises(ValueError): run(a,Path(t)/"out.json")
