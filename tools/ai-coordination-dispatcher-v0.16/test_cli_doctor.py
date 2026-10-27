import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock

from cli_doctor import collect, inspect_policy, inspect_probe_logs


def completed(stdout="", stderr="", code=0):
    return subprocess.CompletedProcess([], code, stdout, stderr)


class DoctorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def report(self, runner, env=None):
        return collect(runner=runner, which=lambda _: "/test/codex", env=env or {},
                       default_home=self.root, probe_directory=self.root)

    def test_only_non_model_commands_are_executed(self):
        runner = Mock(side_effect=[completed("codex-cli 0.163.0\n"), completed(stderr="Logged in using ChatGPT")])
        report = self.report(runner)
        self.assertEqual([c.args[0] for c in runner.call_args_list],
                         [["/test/codex", "--version"], ["/test/codex", "login", "status"]])
        self.assertEqual(report["auth"]["kind"], "chatgpt")
        self.assertFalse(report["model_invoked"])
        self.assertFalse(report["model_access_verified"])

    def test_captured_secrets_never_appear_in_report(self):
        secret = "synthetic-placeholder-never-real"
        runner = Mock(side_effect=[completed("codex-cli 0.163.0\n", secret),
                                   completed("Logged in using an API key " + secret)])
        report = self.report(runner)
        self.assertEqual(report["auth"]["kind"], "api_key")
        self.assertNotIn(secret, json.dumps(report))
        self.assertIn("subscription_auth_not_confirmed_paid_api_forbidden", report["blockers"])

    def test_failed_login_is_not_treated_as_authenticated(self):
        runner = Mock(side_effect=[completed("codex-cli 0.163.0"), completed(stderr="ChatGPT authentication failed", code=1)])
        report = self.report(runner)
        self.assertEqual(report["auth"]["kind"], "none")
        self.assertFalse(report["auth"]["local_login_present"])

    def test_missing_cli_executes_nothing(self):
        runner = Mock()
        report = collect(runner=runner, which=lambda _: None, env={}, default_home=self.root)
        runner.assert_not_called()
        self.assertIn("cli_not_found", report["blockers"])

    def test_timeout_does_not_disclose_partial_output(self):
        runner = Mock(side_effect=[subprocess.TimeoutExpired("codex", 10, output="sensitive"),
                                   completed("Logged in using ChatGPT")])
        report = self.report(runner)
        self.assertNotIn("sensitive", json.dumps(report))
        self.assertIn("cli_version_unverified", report["blockers"])

    def test_codex_disabled_gate_is_preserved(self):
        env = {"CODEX_DISABLED": "1", "CODEX_HOME": str(self.root / "profile")}
        original = env.copy()
        runner = Mock(side_effect=[completed("codex-cli 0.163.0"), completed("Logged in using ChatGPT")])
        report = self.report(runner, env)
        self.assertEqual(env, original)
        self.assertIn("codex_disabled_gate_present", report["blockers"])
        self.assertFalse(report["configuration"]["home_modified"])

    def test_config_presence_does_not_require_reading_its_content(self):
        config = self.root / ".codex" / "config.toml"
        config.parent.mkdir(); config.write_text("secret = 'do-not-read-or-print'")
        runner = Mock(side_effect=[completed("codex-cli 0.163.0"), completed("Logged in using ChatGPT")])
        report = self.report(runner)
        self.assertTrue(report["configuration"]["user_config_present"])
        self.assertNotIn("do-not-read-or-print", json.dumps(report))

    def test_proxy_failure_is_not_misreported_as_auth_failure(self):
        (self.root / "codex-probe.stderr").write_text("HTTP CONNECT failed with status 403 https://private.invalid/?token=secret")
        runner = Mock(side_effect=[completed("codex-cli 0.163.0"), completed("Logged in using ChatGPT")])
        report = self.report(runner)
        self.assertTrue(report["last_probe"]["proxy_connect_403"])
        self.assertFalse(report["last_probe"]["remote_unauthorized"])
        self.assertNotIn("private.invalid", json.dumps(report))
        self.assertFalse(report["retry_without_meaningful_change"])

    def test_model_message_is_detected_without_copying_answer(self):
        (self.root / "codex-probe.jsonl").write_text(json.dumps({"item": {"type": "agent_message", "text": "private answer"}}))
        report = inspect_probe_logs(self.root)
        self.assertTrue(report["model_response_observed"])
        self.assertNotIn("private answer", json.dumps(report))

    def test_missing_policy_never_establishes_enforcement(self):
        report = inspect_policy(self.root / "missing.json")
        self.assertFalse(report["available"])
        self.assertFalse(report["runtime_enforcement_verified"])

    def test_policy_snapshot_is_explicitly_not_current_readiness(self):
        path = self.root / "policy.json"
        path.write_text(json.dumps({"version": 1, "http_network_policy": {
            "type": "restricted", "egress_rules": [{"host": "chatgpt.com"}]}}))
        report = inspect_policy(path)
        self.assertTrue(report["chatgpt_domain_listed"])
        self.assertTrue(report["snapshot_only"])
        self.assertFalse(report["runtime_enforcement_verified"])


if __name__ == "__main__":
    unittest.main()
