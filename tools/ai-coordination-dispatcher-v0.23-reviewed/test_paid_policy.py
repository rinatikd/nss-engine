import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import paid_policy
from ai_reviewer import assess
from dispatcher import invoke, run
from orchestrator import ClaudeAgent
from pilot import pilot


class PaidPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = str(Path(self.temp.name) / "state.sqlite")

    def test_environment_and_cli_opt_ins_cannot_enable_paid_api(self):
        self.assertFalse(paid_policy.PAID_API_ALLOWED)
        env = {
            "ANTHROPIC_API_KEY": "synthetic-key-not-real",
            "AI_LEDGER_HMAC_KEY": "x" * 40,
            "A2A_LIVE_APPROVED": "YES",
            "AI_REVIEW_LIVE_APPROVED": "YES",
            "AI_MAX_CALLS_PER_DAY": "100",
            "AI_MAX_PLANNED_TOKENS_PER_DAY": "1000000",
            "AI_REVIEW_MAX_CALLS_PER_DAY": "100",
            "AI_REVIEW_MAX_PLANNED_TOKENS_PER_DAY": "1000000",
        }
        with patch.dict(os.environ, env), patch("dispatcher.https_post") as post:
            with self.assertRaises(PermissionError):
                invoke("claude", "synthetic request", live=True)
            result = run(self.db, b"x" * 40, "legacy-live", "synthetic request", live=True)
            self.assertEqual(result["state"], "BLOCKED")
            self.assertFalse(result["sent"])
            self.assertEqual(pilot(self.db, "pilot-live", "synthetic request", live=True)["status"], "BLOCKED")
            self.assertEqual(assess(self.db, "review-live", "answer", "rubric", live=True)["state"], "BLOCKED")
            post.assert_not_called()

    def test_runtime_constant_cannot_enable_paid_api(self):
        with patch.object(paid_policy, "PAID_API_ALLOWED", True):
            with self.assertRaises(PermissionError):
                paid_policy.require_paid_api_allowed()

    def test_new_orchestrator_adapter_is_also_blocked(self):
        with patch.dict(os.environ, {"ANTHROPIC_API_KEY": "synthetic-key-not-real"}), \
                patch("orchestrator.https_post") as post:
            with self.assertRaises(PermissionError):
                ClaudeAgent("executor", "model").invoke({"prompt": "synthetic request"})
            post.assert_not_called()


if __name__ == "__main__":
    unittest.main()
