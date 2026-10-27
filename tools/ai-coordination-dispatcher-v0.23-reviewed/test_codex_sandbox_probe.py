from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from codex_sandbox_probe import run_readonly_sandbox_probe


class Result:
    def __init__(self, stdout="", returncode=0, stderr=""):
        self.stdout = stdout
        self.returncode = returncode
        self.stderr = stderr


class CodexSandboxProbeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.binary = self.root / "codex.exe"
        self.binary.write_bytes(b"synthetic signed cli")
        self.preflight = lambda **_: {"available": True, "publisher_verified": True}

    def tearDown(self):
        self.temp.cleanup()

    def test_runs_only_fixed_echo_and_write_denial_probe(self):
        calls = []

        def runner(args, **kwargs):
            calls.append((args, kwargs))
            if args[-1] == "echo CODEX_READONLY_SANDBOX_OK":
                return Result("CODEX_READONLY_SANDBOX_OK")
            return Result("CODEX_WRITE_PROBE_STARTED", 1, "Access is denied.")

        with patch("codex_sandbox_probe.platform.system", return_value="Windows"):
            result = run_readonly_sandbox_probe(
                runner=runner, path_lookup=lambda _: str(self.binary), preflight=self.preflight,
                temp_base=self.root,
            )
        self.assertEqual(result["state"], "PASS_FIXED_WRITE_DENIAL_PROBE")
        self.assertEqual(result["implementation"], "unelevated")
        self.assertTrue(result["write_probe_denied"])
        self.assertFalse(result["read_denial_enforced"])
        self.assertFalse(result["network_isolation_verified"])
        self.assertFalse(result["codex_execution_ready"])
        self.assertEqual(len(calls), 2)
        self.assertTrue(all(call[0][1:4] == ["-c", "windows.sandbox=unelevated", "sandbox"] for call in calls))
        self.assertTrue(all(call[0][5:8] == ["--permission-profile", ":read-only", "--"] for call in calls))
        self.assertTrue(all("shell" not in call[1] or call[1]["shell"] is False for call in calls))
        self.assertEqual(list(self.root.glob("codex-readonly-probe-*")), [])

    def test_unexpected_writable_sandbox_is_reported_and_cleaned(self):
        calls = []

        def runner(args, **kwargs):
            calls.append(args)
            if len(calls) == 1:
                return Result("CODEX_READONLY_SANDBOX_OK")
            command = args[-1]
            marker = command.split('"')[1]
            Path(marker).write_text("unexpected", encoding="utf-8")
            return Result("", 0)

        with patch("codex_sandbox_probe.platform.system", return_value="Windows"):
            result = run_readonly_sandbox_probe(
                runner=runner, path_lookup=lambda _: str(self.binary), preflight=self.preflight,
                temp_base=self.root,
            )
        self.assertEqual(result["state"], "BLOCKED")
        self.assertFalse(result["write_probe_denied"])
        self.assertEqual(list(self.root.glob("codex-readonly-probe-*")), [])

    def test_second_process_startup_failure_is_not_write_denial(self):
        self.assert_write_probe_blocked(Result("CLI failed before command startup", 2))

    def test_phase_marker_without_access_denied_diagnostic_is_not_pass(self):
        self.assert_write_probe_blocked(Result("CODEX_WRITE_PROBE_STARTED", 2, "The system cannot find the file specified."))

    def test_access_denied_without_write_phase_marker_is_not_pass(self):
        self.assert_write_probe_blocked(Result("", 1, "Access is denied."))

    def test_unrecognized_localized_error_is_blocked(self):
        self.assert_write_probe_blocked(Result("CODEX_WRITE_PROBE_STARTED", 1, "Unknown localized denial"))

    def test_access_denied_with_zero_exit_is_not_pass(self):
        self.assert_write_probe_blocked(Result("CODEX_WRITE_PROBE_STARTED", 0, "Access is denied."))

    def assert_write_probe_blocked(self, write_result):
        calls = []

        def runner(args, **kwargs):
            calls.append(args)
            return Result("CODEX_READONLY_SANDBOX_OK") if len(calls) == 1 else write_result

        with patch("codex_sandbox_probe.platform.system", return_value="Windows"):
            result = run_readonly_sandbox_probe(
                runner=runner, path_lookup=lambda _: str(self.binary), preflight=self.preflight,
                temp_base=self.root,
            )
        self.assertEqual(result["state"], "BLOCKED")
        self.assertFalse(result["write_probe_denied"])
        self.assertFalse(result["codex_execution_ready"])

    def test_unverified_binary_blocks_before_any_sandbox_process(self):
        calls = []
        with patch("codex_sandbox_probe.platform.system", return_value="Windows"):
            result = run_readonly_sandbox_probe(
                runner=lambda *a, **k: calls.append(a), path_lookup=lambda _: str(self.binary),
                preflight=lambda **_: {"available": True, "publisher_verified": False},
                temp_base=self.root,
            )
        self.assertEqual(result["state"], "BLOCKED")
        self.assertEqual(calls, [])

    def test_non_windows_host_is_blocked(self):
        with patch("codex_sandbox_probe.platform.system", return_value="Linux"):
            result = run_readonly_sandbox_probe(path_lookup=lambda _: None)
        self.assertEqual(result["state"], "BLOCKED")
        self.assertFalse(result["model_started"])


if __name__ == "__main__":
    unittest.main()
