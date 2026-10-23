import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from nss_engine.observability_v036 import make_bundle

class TestObservabilityV036(unittest.TestCase):
    def test_bundle(self):
        with tempfile.TemporaryDirectory() as d:
            log = Path(d) / "log.jsonl"
            log.write_text('\n'.join(json.dumps(x) for x in [
                {"event":"command_start","command":"A","run_id":"1"},
                {"event":"command_end","command":"A","run_id":"1"}]), encoding="utf-8")
            out = Path(d) / "bundle.zip"
            result = make_bundle(log, out)
            self.assertTrue(result["healthy"])
            with zipfile.ZipFile(out) as z:
                self.assertEqual(set(z.namelist()), {"report.json", "runtime.jsonl", "README.txt"})
                self.assertTrue(json.loads(z.read("report.json"))["healthy"])

    def test_missing_log(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                make_bundle(Path(d)/"missing", Path(d)/"out.zip")

    def test_invalid_json(self):
        with tempfile.TemporaryDirectory() as d:
            log=Path(d)/"log"; log.write_text("not json", encoding="utf-8")
            with self.assertRaises(ValueError):
                make_bundle(log, Path(d)/"out.zip")

    def test_same_path(self):
        with tempfile.TemporaryDirectory() as d:
            log=Path(d)/"log"; log.write_text("", encoding="utf-8")
            with self.assertRaises(ValueError):
                make_bundle(log, log)

if __name__ == "__main__": unittest.main()
