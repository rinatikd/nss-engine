import json
import tempfile
import unittest
from pathlib import Path
from nss_engine.runtime_v035 import analyze_events, analyze_file

class RuntimeTests(unittest.TestCase):
    def test_empty(self): self.assertTrue(analyze_events([])["healthy"])
    def test_success(self): self.assertTrue(analyze_events([{"event":"command_start","command":"X","run_id":"1"},{"event":"command_end","command":"X","run_id":"1"}])["healthy"])
    def test_incomplete(self): self.assertEqual(analyze_events([{"event":"command_start","command":"X","run_id":"1"}])["issues"][0]["code"],"INCOMPLETE_COMMAND")
    def test_unmatched(self): self.assertEqual(analyze_events([{"event":"command_end","command":"X","run_id":"1"}])["issues"][0]["code"],"UNMATCHED_END")
    def test_exception(self): self.assertFalse(analyze_events([{"event":"exception","command":"X","exception_type":"E"}])["healthy"])
    def test_invalid(self): self.assertFalse(analyze_events([{"event":"bad"}])["healthy"])
    def test_duplicate(self): self.assertIn("DUPLICATE_START",[x["code"] for x in analyze_events([{"event":"command_start","command":"X","run_id":"1"}]*2)["issues"]])
    def test_mismatch(self): self.assertEqual(analyze_events([{"event":"command_start","command":"X","run_id":"1"},{"event":"command_end","command":"Y","run_id":"1"}])["issues"][0]["code"],"COMMAND_MISMATCH")
    def test_wrong_root(self):
        with self.assertRaises(ValueError): analyze_events({})
    def test_file(self):
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/"events.jsonl"; output=Path(d)/"report.json"
            source.write_text(json.dumps({"event":"info","command":"X"})+"\n",encoding="utf-8")
            self.assertEqual(analyze_file(source,output)["event_count"],1)
            self.assertTrue(output.exists())
