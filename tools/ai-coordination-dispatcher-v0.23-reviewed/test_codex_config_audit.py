import json
from pathlib import Path
import tempfile
import unittest

from codex_config_audit import audit_codex_config


class CodexConfigAuditTests(unittest.TestCase):
    def test_counts_sources_without_returning_config_or_secret_values(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            user = root / "user"
            codex_home = user / "isolated-codex-home"
            project = root / "project"
            (codex_home).mkdir(parents=True)
            (project / ".codex").mkdir(parents=True)
            (codex_home / "config.toml").write_text(
                '[mcp_servers.bridge]\ncommand="private-command"\n'
                '[mcp_servers.bridge.env]\nTOKEN="secret-token-never-return"\n'
                '[features]\nexperimental=true\n', encoding="utf-8")
            (codex_home / "review.config.toml").write_text(
                '[mcp_servers.reviewer]\ncommand="private-review-command"\n', encoding="utf-8")
            (project / ".codex" / "config.toml").write_text(
                '[mcp_servers.project_tool]\ncommand="private-project-command"\n', encoding="utf-8")
            report = audit_codex_config(
                cwd=project,
                home=user,
                env={"CODEX_HOME": str(codex_home), "OPENAI_API_KEY": "secret-api-key-never-return"},
            )

        rendered = json.dumps(report)
        self.assertEqual(report["state"], "PARTIAL_INVENTORY")
        self.assertEqual(report["config_sources"]["user_base_configs_scanned"], 1)
        self.assertEqual(report["config_sources"]["user_profile_configs_scanned"], 1)
        self.assertEqual(report["config_sources"]["project_configs_scanned"], 1)
        self.assertEqual(report["mcp_server_table_count"], 3)
        self.assertTrue(report["known_environment_variable_presence"]["OPENAI_API_KEY"])
        self.assertFalse(report["credential_values_parsed"])
        self.assertFalse(report["effective_tool_inventory_proven"])
        self.assertNotIn("secret-token-never-return", rendered)
        self.assertNotIn("secret-api-key-never-return", rendered)
        self.assertNotIn("private-command", rendered)
        self.assertNotIn("bridge", rendered)

    def test_oversize_config_is_skipped_and_malformed_text_is_not_parsed(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            codex_home = root / ".codex"
            codex_home.mkdir()
            (codex_home / "config.toml").write_text("[broken", encoding="utf-8")
            (codex_home / "large.config.toml").write_bytes(b"x" * (1024 * 1024 + 1))
            report = audit_codex_config(cwd=root, home=root, env={})
        self.assertEqual(report["config_sources"]["user_base_configs_scanned"], 1)
        self.assertEqual(report["config_sources"]["unreadable_or_oversize_configs"], 1)
        self.assertEqual(report["mcp_server_table_count"], 0)
        self.assertFalse(report["codex_execution_ready"])

    def test_absent_config_still_reports_unverified_sources(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            report = audit_codex_config(cwd=root, home=root, env={})
        self.assertEqual(report["mcp_server_table_count"], 0)
        self.assertFalse(report["managed_policy_enumerated"])
        self.assertFalse(report["built_in_tools_enumerated"])
        self.assertGreater(len(report["unverified_sources"]), 0)


if __name__ == "__main__":
    unittest.main()
