import unittest
from queue_status import summarize, status

class QueueStatusTests(unittest.TestCase):
    def comment(self, cid, text, login="rinatikd", uid=337319789):
        return {"id": cid, "body": text, "user": {"id": uid, "login": login}}

    def test_correlated_reply_closes_request(self):
        comments = [
            self.comment(1, "[CODEX-CHAT REQUEST task_0001]\nsynthetic text"),
            self.comment(2, "[CODEX-CHAT RESPONSE task_0001]\n\nok"),
            self.comment(3, "[CODEX-CHAT REQUEST task_0002]\nsecond"),
        ]
        self.assertEqual(["task_0002"], summarize(comments)["pending_ids"])
        self.assertFalse(summarize(comments)["execution_enabled"])

    def test_identity_enforced_and_replay_not_counted(self):
        comments = [
            self.comment(1, "[CODEX-CHAT REQUEST task_0001]\nfirst"),
            self.comment(2, "[CODEX-CHAT REQUEST task_0001]\nduplicate"),
            self.comment(3, "[CODEX-CHAT RESPONSE task_0001]\nfake", uid=1),
        ]
        summary = summarize(comments)
        self.assertEqual(1, summary["pending_count"])
        self.assertEqual(1, summary["total_requests"])

    def test_identity_mismatch_blocks_before_comment_poll(self):
        calls = []
        class Result:
            returncode = 0
            stdout = '{"login":"wrong","id":1}'
        def runner(args, **kwargs):
            calls.append(args)
            return Result()
        with self.assertRaisesRegex(RuntimeError, "identity mismatch"):
            status(runner=runner, locator=lambda _: "gh")
        self.assertEqual(1, len(calls))

    def test_malformed_authorized_comment_rejected(self):
        with self.assertRaises(ValueError):
            summarize([{"id": 1, "body": None,
                        "user": {"id": 337319789, "login": "rinatikd"}}])

if __name__ == "__main__":
    unittest.main()
