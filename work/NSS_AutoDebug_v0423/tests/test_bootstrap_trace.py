"""Static generation tests for NSS AutoDebug LISP bootstrap tracing. No AutoCAD required."""
import importlib.util
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("nss_autodebug_trace", ROOT / "scripts" / "autodebug_v0421.py")
debug = importlib.util.module_from_spec(spec)
spec.loader.exec_module(debug)


class BootstrapTraceTests(unittest.TestCase):
    def test_generated_trace_distinguishes_attempt_from_completion(self):
        with tempfile.TemporaryDirectory() as folder:
            run = Path(folder)
            (run / "reports").mkdir()
            state = {
                "run_id": "a" * 32,
                "entry_name": "NSS_AUTOTEST_FILE_V0423_PREBUILT",
                "dll": str(run / "plugin.dll"),
            }
            invoker = debug.make_invoker(run, state)
            text = invoker.read_text(encoding="utf-8-sig")
            stages = [
                "INVOKER_STARTED",
                "NETLOAD_ATTEMPTED",
                "NETLOAD_RETURNED",
                "NETLOAD_EXCEPTION",
                "ENTRY_REGISTERED",
                "NATIVE_CALL_ATTEMPTED",
                "NATIVE_CALL_RETURNED",
                "BOOTSTRAP_FAILED",
            ]
            for marker in stages:
                with self.subTest(marker=marker):
                    self.assertIn('"' + marker + '"', text)
            self.assertLess(text.index('"NETLOAD_ATTEMPTED"'), text.index('"NETLOAD_RETURNED"'))
            self.assertLess(text.index('"ENTRY_REGISTERED"'), text.index('"NATIVE_CALL_ATTEMPTED"'))
            self.assertLess(text.index('"NATIVE_CALL_ATTEMPTED"'), text.index('"NATIVE_CALL_RETURNED"'))
            self.assertIn("bootstrap_trace.log", text)
            self.assertIn("authorization.json", text)
            self.assertNotIn('"NATIVE_CHECKS_PASSED"', text)

    def test_trace_file_is_not_created_during_generation(self):
        with tempfile.TemporaryDirectory() as folder:
            run = Path(folder)
            (run / "reports").mkdir()
            state = {"run_id": "b" * 32, "dll": str(run / "plugin.dll")}
            debug.make_invoker(run, state)
            self.assertFalse((run / "reports" / "bootstrap_trace.log").exists())
            self.assertFalse((run / "reports" / "native_results.json").exists())

    def test_invalid_native_entry_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            run = Path(folder)
            (run / "reports").mkdir()
            with self.assertRaises(ValueError):
                debug.make_invoker(run, {
                    "run_id": "c" * 32,
                    "entry_name": "NSS_AUTOTEST_FILE_BAD\nINJECTED",
                    "dll": str(run / "plugin.dll"),
                })


if __name__ == "__main__":
    unittest.main()
