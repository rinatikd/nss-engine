import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import diagnose
import relay


def comment(body="[CODEX-CHAT REQUEST req_0001]\nReview this.", cid=1, *, created="2026-10-26T10:00:00Z", updated=None):
    return {"id": cid, "user": {"id": relay.SENDER_ID, "login": relay.SENDER_LOGIN}, "body": body,
            "created_at": created, "updated_at": updated or created}


class RelayV03Tests(unittest.TestCase):
    def test_launch_gate_is_closed_even_if_called_directly(self):
        with self.assertRaisesRegex(relay.RelayError, "BLOCKED"):
            relay.launch_codex("synthetic")

    def test_cli_modes_exit_blocked_before_network_or_state(self):
        self.assertEqual(3, relay.main(["--local-codex"]))
        self.assertEqual(3, relay.main(["--smoke-test"]))

    def test_only_fixed_sender_and_immutable_comment_are_accepted(self):
        self.assertIsNotNone(relay.parse_request(comment()))
        self.assertIsNone(relay.parse_request(comment(updated="2026-10-26T10:01:00Z")))
        altered = comment(); altered["user"]["id"] = 8
        self.assertIsNone(relay.parse_request(altered))

    def test_allowlist_profile_has_exact_keys_and_values(self):
        profile = Path(__file__).parent / "staging-profile" / "config.toml"
        self.assertEqual([], diagnose.profile_findings(profile))

    def test_allowlist_rejects_extra_mcp_and_plugin_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "config.toml"
            path.write_text('approval_policy="on-request"\nsandbox_mode="read-only"\n[features]\nshell_tool=false\napps=false\n[mcp_servers.x]\ncommand="x"\n', encoding="utf-8")
            self.assertTrue(diagnose.profile_findings(path))

    def test_diagnostic_report_is_anonymized_and_marks_unknown_sources(self):
        report = diagnose.sanitized_report(Path("C:/user/private/codex.exe"), "codex-cli 0.164.0", "a" * 64, "SECRET_TOOL", "secret-endpoint")
        rendered = json.dumps(report)
        self.assertNotIn("SECRET_TOOL", rendered)
        self.assertNotIn("secret-endpoint", rendered)
        self.assertNotIn("private", rendered)
        self.assertEqual("UNVERIFIED", report["windows_sandbox"])
        self.assertFalse(report["model_invoked"])

    def test_cli_version_and_executable_diagnostics_are_read_only_calls(self):
        calls = []
        class Result:
            stdout = "codex-cli 0.164.0"
        def fake(args, **kwargs):
            calls.append(args[1:])
            return Result()
        with patch.object(diagnose.shutil, "which", return_value=str(Path(__file__).resolve())):
            with patch.object(diagnose.subprocess, "run", side_effect=fake):
                self.assertEqual(0, diagnose.run([]))
        self.assertEqual([["--version"], ["features", "list"], ["mcp", "list"]], calls)
        self.assertFalse(any("exec" in call for call in calls))

    def test_invalid_profile_blocks_before_cli_probe(self):
        with tempfile.TemporaryDirectory() as folder:
            profile = Path(folder) / "invalid.toml"
            profile.write_text('[mcp_servers.extra]\\ncommand="x"\\n', encoding="utf-8")
            with patch.object(diagnose.shutil, "which") as which:
                self.assertEqual(2, diagnose.run(["--profile", str(profile)]))
                which.assert_not_called()

    def test_report_write_failure_returns_nonzero(self):
        with tempfile.TemporaryDirectory() as folder:
            report = Path(folder) / "missing-folder" / "report.json"
            class Result:
                stdout = "codex-cli 0.164.0"
            with patch.object(diagnose.shutil, "which", return_value=str(Path(__file__).resolve())):
                with patch.object(diagnose.subprocess, "run", return_value=Result()):
                    self.assertEqual(3, diagnose.run(["--report", str(report)]))

    def test_github_pagination_collects_all_pages(self):
        rows = [[{"id": i} for i in range(1, 101)], [{"id": 101}]]
        gh = relay.GitHub(lambda page, size, timeout: (200, rows[page - 1], page == 1))
        self.assertEqual(list(range(1, 102)), [x["id"] for x in gh.comments()])

    def test_github_rejects_partial_page_with_next_link(self):
        gh = relay.GitHub(lambda page, size, timeout: (200, [{"id": 1}], True))
        with self.assertRaisesRegex(relay.RelayError, "gap"):
            gh.comments()

    def test_github_rejects_duplicate_ids_and_http_errors(self):
        gh = relay.GitHub(lambda page, size, timeout: (200, [{"id": 1}, {"id": 1}], False))
        with self.assertRaisesRegex(relay.RelayError, "duplicate"):
            gh.comments()
        gh = relay.GitHub(lambda page, size, timeout: (503, [], False))
        with self.assertRaisesRegex(relay.RelayError, "invalid or partial"):
            gh.comments()

    def test_github_timeout_or_unexpected_error_is_not_retried(self):
        calls = []
        def fail(page, size, timeout):
            calls.append(page)
            raise TimeoutError("private data")
        with self.assertRaisesRegex(relay.RelayError, "no automatic retry"):
            relay.GitHub(fail).comments()
        self.assertEqual([1], calls)

    def test_full_page_without_link_requires_empty_terminal_page(self):
        calls = []
        def pages(page, size, timeout):
            calls.append(page)
            return (200, [{"id": i + (page - 1) * 100} for i in range(100)], False) if page == 1 else (200, [], False)
        self.assertEqual(100, len(relay.GitHub(pages).comments()))
        self.assertEqual([1, 2], calls)

    def test_race_mutation_blocks_action(self):
        original = relay.parse_request(comment())
        changed = comment("[CODEX-CHAT REQUEST req_0001]\nchanged")
        calls = []
        with self.assertRaisesRegex(relay.RelayError, "changed or disappeared"):
            relay.revalidate_before_action(original, lambda: changed, lambda: calls.append("action"))
        self.assertEqual([], calls)

    def test_race_revalidation_calls_action_only_after_exact_match(self):
        original = relay.parse_request(comment())
        self.assertEqual("ok", relay.revalidate_before_action(original, lambda: comment(), lambda: "ok"))

    def test_unknown_is_terminal_after_restart_and_duplicate_is_refused(self):
        with tempfile.TemporaryDirectory() as folder:
            db = Path(folder) / "relay.sqlite3"
            request = relay.parse_request(comment())
            state = relay.State(db)
            self.assertTrue(state.claim(request)); state.state(request.request_id, "RUNNING"); state.close()
            state = relay.State(db)
            self.assertEqual("UNKNOWN", state.db.execute("select state from requests").fetchone()[0])
            self.assertFalse(state.claim(request))
            with self.assertRaises(relay.RelayError): state.state(request.request_id, "RUNNING")
            state.close()

    def test_windows_toml_literal_backslashes_and_unicode_report(self):
        import tomllib
        source = "path = 'C:\\Users\\Имя пользователя\\Codex\\config.toml'\n"
        self.assertEqual("C:\\Users\\Имя пользователя\\Codex\\config.toml", tomllib.loads(source)["path"])
        report = (Path(__file__).parent / "TEST_REPORT.md").read_text(encoding="utf-8")
        self.assertIn("Имя пользователя", report)
        self.assertNotIn("\ufffd", report)
        self.assertNotIn("вЂ", report)
        self.assertNotIn("Ð", report)


if __name__ == "__main__":
    unittest.main()
