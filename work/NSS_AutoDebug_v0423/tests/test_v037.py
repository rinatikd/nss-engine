import json
import tempfile
import unittest
from pathlib import Path
from nss_engine.validation_v037 import validate, main

BASE = Path(__file__).resolve().parents[1] / "examples"

class EndToEndV037(unittest.TestCase):
    def test_real_example_pipeline(self):
        report, preview, manifest = validate(BASE/"snapshot_v022.json",BASE/"plan_v030.json",source_drawing="test.dwg")
        self.assertEqual(manifest["status"],"PREVIEW_READY_NOT_APPROVED")
        self.assertGreater(manifest["route_count"],0)
        self.assertEqual(len(preview["routes"]),manifest["route_count"])
        self.assertEqual(preview["source_drawing"],"test.dwg")
        self.assertEqual(report["schema_version"],"0.30")
    def test_deterministic_hashes(self):
        a=validate(BASE/"snapshot_v022.json",BASE/"plan_v030.json")[2]
        b=validate(BASE/"snapshot_v022.json",BASE/"plan_v030.json")[2]
        self.assertEqual(a,b)
    def test_missing_snapshot(self):
        with self.assertRaises(ValueError): validate("/not/found.json",BASE/"plan_v030.json")
    def test_invalid_plan(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"bad.json";p.write_text('{"schema_version":"bad"}')
            with self.assertRaises(ValueError): validate(BASE/"snapshot_v022.json",p)
    def test_nonfinite_json_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"bad.json";p.write_text('{"x": NaN}')
            with self.assertRaises(ValueError): validate(p,BASE/"plan_v030.json")
    def test_cli_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            main(["--snapshot",str(BASE/"snapshot_v022.json"),"--plan",str(BASE/"plan_v030.json"),"--output-dir",tmp])
            for name in ("report_v037.json","preview_v037.json","validation_v037.json"):
                self.assertTrue((Path(tmp)/name).exists())
                json.loads((Path(tmp)/name).read_text())
    def test_input_size_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"large.json"
            with p.open("wb") as f: f.truncate(12_000_001)
            with self.assertRaises(ValueError): validate(p,BASE/"plan_v030.json")
