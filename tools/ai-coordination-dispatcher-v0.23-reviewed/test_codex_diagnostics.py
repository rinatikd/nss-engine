import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import codex_diagnostics as diagnostics


class Result:
    def __init__(self, stdout="", returncode=0):
        self.stdout = stdout
        self.returncode = returncode


class CodexDiagnosticsTests(unittest.TestCase):
    def test_missing_cli_is_blocked_and_sanitized(self):
        report = diagnostics.inspect_codex(path_lookup=lambda _: None)
        self.assertFalse(report["available"])
        self.assertFalse(report["codex_execution_ready"])
        self.assertNotIn("path", report)
        self.assertIsNone(report["sha256"])

    def test_rejects_script_shim_without_invoking_it(self):
        with tempfile.TemporaryDirectory() as folder:
            shim = Path(folder) / "codex.cmd"
            shim.write_text("echo unsafe", encoding="utf-8")
            calls = []
            report = diagnostics.inspect_codex(runner=lambda *a, **k: calls.append(a), path_lookup=lambda _: str(shim))
        self.assertEqual(report["signature_status"], "REJECTED_PATH")
        self.assertEqual(calls, [])

    def test_hash_version_and_valid_signer_are_reported_without_execution(self):
        with tempfile.TemporaryDirectory() as folder:
            exe = Path(folder) / "codex.exe"
            exe.write_bytes(b"synthetic executable")
            real_is_file = Path.is_file
            powershell = Path(diagnostics.os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"

            def check_file(path):
                return True if path == powershell else real_is_file(path)

            invoked = []

            def runner(args, **kwargs):
                invoked.append((args, kwargs))
                if args[0] == str(powershell):
                    return Result(json.dumps({
                        "Status": "Valid",
                        "Subject": 'CN="OpenAI OpCo, LLC", O="OpenAI OpCo, LLC", C=US',
                    }))
                return Result("codex-cli 0.164.0\n")

            with patch.object(diagnostics.platform, "system", return_value="Windows"), \
                    patch.object(Path, "is_file", autospec=True, side_effect=check_file):
                report = diagnostics.inspect_codex(runner=runner, path_lookup=lambda _: str(exe))

        self.assertTrue(report["available"])
        self.assertEqual(report["version"], "0.164.0")
        self.assertEqual(report["sha256"], hashlib.sha256(b"synthetic executable").hexdigest())
        self.assertEqual(report["signature_status"], "Valid")
        self.assertTrue(report["publisher_verified"])
        self.assertFalse(report["codex_execution_ready"])
        self.assertEqual([call[0][1] for call in invoked], ["-NoProfile", "--version"])
        self.assertEqual(invoked[1][0], [str(exe), "--version"])
        self.assertNotIn("A2A_CODEX_DIAGNOSTIC_PATH", invoked[1][1]["env"])

    def test_invalid_signature_never_marks_publisher_trusted(self):
        with tempfile.TemporaryDirectory() as folder:
            exe = Path(folder) / "codex.exe"
            exe.write_bytes(b"synthetic executable")
            real_is_file = Path.is_file
            powershell = Path(diagnostics.os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            check_file = lambda path: True if path == powershell else real_is_file(path)
            with patch.object(diagnostics.platform, "system", return_value="Windows"), \
                    patch.object(Path, "is_file", autospec=True, side_effect=check_file):
                calls = []

                def runner(args, **kwargs):
                    calls.append(args)
                    return Result(json.dumps({"Status": "NotSigned", "Subject": 'CN="OpenAI OpCo, LLC"'}))

                report = diagnostics.inspect_codex(runner=runner, path_lookup=lambda _: str(exe))
        self.assertEqual(report["signature_status"], "NotSigned")
        self.assertFalse(report["publisher_verified"])
        self.assertFalse(report["codex_execution_ready"])
        self.assertEqual(len(calls), 1)
        self.assertIn("powershell.exe", calls[0][0].lower())

    def test_valid_signature_for_other_organization_does_not_launch_cli(self):
        with tempfile.TemporaryDirectory() as folder:
            exe = Path(folder) / "codex.exe"
            exe.write_bytes(b"synthetic executable")
            real_is_file = Path.is_file
            powershell = Path(diagnostics.os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
            check_file = lambda path: True if path == powershell else real_is_file(path)
            calls = []

            def runner(args, **kwargs):
                calls.append(args)
                return Result(json.dumps({
                    "Status": "Valid",
                    "Subject": 'CN="OpenAI OpCo, LLC", O="Different Organization", C=US',
                }))

            with patch.object(diagnostics.platform, "system", return_value="Windows"), \
                    patch.object(Path, "is_file", autospec=True, side_effect=check_file):
                report = diagnostics.inspect_codex(runner=runner, path_lookup=lambda _: str(exe))
        self.assertEqual(report["signature_status"], "Valid")
        self.assertFalse(report["publisher_verified"])
        self.assertFalse(report["available"])
        self.assertEqual(len(calls), 1)
        self.assertIn("powershell.exe", calls[0][0].lower())

    def test_version_failure_does_not_leak_error_output(self):
        with tempfile.TemporaryDirectory() as folder:
            exe = Path(folder) / "codex.exe"
            exe.write_bytes(b"synthetic executable")
            with patch.object(diagnostics, "_authenticode", return_value={
                "status": "Valid", "publisher": "OpenAI OpCo, LLC", "publisher_verified": True,
            }):
                report = diagnostics.inspect_codex(
                    runner=lambda *a, **k: Result("secret-looking output", 1), path_lookup=lambda _: str(exe)
                )
        self.assertFalse(report["available"])
        self.assertIsNone(report["version"])
        self.assertNotIn("secret-looking", str(report))


if __name__ == "__main__":
    unittest.main()
